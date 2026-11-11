import { randomUUID } from "node:crypto";
import { loadSeed, parseSeed, removeDbFiles } from "../scripts/seed";
import { readFileSync } from "node:fs";
import { runAgent, type AgentDeps } from "../src/agent/index";
import { DAILY_QUOTA_TEXT } from "../src/agent/errors";
import type { Models } from "../src/agent/model";
import { openDb, type Db } from "../src/db/index";
import { forgetThreadMemory, getTrace, type ClaimRow, type MemoryWriteRow } from "../src/db/memoryRepo";
import { isDailyQuota } from "../src/lib/retry";
import type { Search, SearchInput } from "../src/search/index";
import type { SearchResult } from "../src/search/types";
import type { EvalCase, MockPage } from "./cases";
import { runChecks, type CheckResult, type Observed, type TurnObservation } from "./checks";
import { judgeCase, type Judgement } from "./judge";

/** The day's model quota is gone: no later case can work either, so the whole run stops (D61). */
export class QuotaExhausted extends Error {
  constructor(readonly where: string) {
    super(`daily model quota exhausted at ${where}`);
    this.name = "QuotaExhausted";
  }
}

export interface CaseDeps {
  models: Models;
  /** Real Exa/Tavily search over the case DB (its search_cache). Only used when the case has no mockSearch. */
  liveSearch: (db: Db) => Search;
  /** Where the case's SQLite file goes; ":memory:" in tests. */
  dbPath: (caseId: string) => string;
  maxSteps: number;
  /** Sleep/jitter for model retries; tests pass instant ones. */
  retry?: AgentDeps["retry"];
}

export interface TurnLog extends TurnObservation {
  message: string;
  queries: string[];
  sources: { n: number; url: string; title: string; publishedDate?: string; snippet: string }[];
  firstTokenMs: number | null;
  totalMs: number | null;
}

export type JudgeOutcome = Judgement | { error: string };

export interface RunResult {
  caseId: string;
  rep: number;
  turns: TurnLog[];
  hard: CheckResult[];
  soft: CheckResult[];
  passed: boolean;
  judge: JudgeOutcome;
  /** "mock": a fixture replaced the providers. "live": real search; "live (unused)": real search, never called. */
  searchMode: "mock" | "live" | "live (unused)";
}

/** Fixed pages for every call, numbered from the turn's counter; the same shape the real search returns. */
export function mockSearch(pages: MockPage[]): Search {
  return {
    run: async (input, turn) => ({
      results: pages.map((p) => ({
        ...p,
        query: input.queries[0] ?? "",
        ...turn.numberFor(p.url),
      })),
      sources: input.queries.map((query) => ({ query, provider: "exa" as const, cached: false })),
      failed: [],
      allFailed: false,
    }),
  };
}

/** Wraps a Search to remember what the tool asked and got, so checks and the judge see the same thing the model did. */
export function recordingSearch(inner: Search): Search & { inputs: SearchInput[]; results: SearchResult[] } {
  const inputs: SearchInput[] = [];
  const results: SearchResult[] = [];
  return {
    inputs,
    results,
    async run(input, turn, signal) {
      inputs.push(input);
      const out = await inner.run(input, turn, signal);
      for (const r of out.results) if (!results.some((x) => x.n === r.n)) results.push(r);
      return out;
    },
  };
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Keys of the trace's `errors` entries ({ rawLinks: [...] } → "rawLinks"); plain strings are ignored. */
export function errorKeysOf(errors: unknown): string[] {
  return Array.isArray(errors)
    ? errors.flatMap((e) => (e && typeof e === "object" ? Object.keys(e as Record<string, unknown>) : []))
    : [];
}

function readSeed() {
  return parseSeed(JSON.parse(readFileSync(new URL("./seed.json", import.meta.url), "utf8")));
}

/**
 * One repetition of one case: fresh DB → seed → forget → turns → wait for background memory writes
 * → collect output, trace and DB state → checks → judge. Throws QuotaExhausted, nothing else.
 */
export async function runCase(deps: CaseDeps, c: EvalCase, rep: number): Promise<RunResult> {
  const path = deps.dbPath(c.id);
  removeDbFiles(path);
  const db = openDb(path);
  const at = new Date(c.now);
  const now = () => new Date(at.getTime());
  try {
    if (c.seed) {
      const seeded = loadSeed(db, readSeed(), at);
      for (const label of c.forgetThreads ?? []) {
        const t = seeded.threads.find((x) => x.label === label);
        if (!t) throw new Error(`${c.id}: forgetThreads names unknown seed thread "${label}"`);
        forgetThreadMemory(db, t.id, at);
      }
    }
    const base = c.mockSearch ? mockSearch(c.mockSearch) : deps.liveSearch(db);

    const threadId = randomUUID();
    const turns: TurnLog[] = [];
    const turnIds: string[] = [];
    for (const message of c.messages) {
      const search = recordingSearch(base);
      const run = await runAgent({ db, models: deps.models, search, maxSteps: deps.maxSteps, now, ...(deps.retry ? { retry: deps.retry } : {}) }, { threadId, message, tz: c.timezone });
      // Drain the client branch; `done` also covers the trace and the background memory write (rule: evals wait for it).
      for await (const chunk of run.stream) void chunk;
      await run.done;
      const row = db.prepare("SELECT status, text FROM messages WHERE id = ?").get(run.assistantMessageId) as { status: string; text: string };
      if (row.status === "error" && row.text.includes(DAILY_QUOTA_TEXT)) throw new QuotaExhausted(`${c.id} (run ${rep})`);
      const trace = getTrace(db, run.assistantMessageId);
      turnIds.push(run.assistantMessageId);
      turns.push({
        message,
        answer: row.text,
        status: row.status,
        searchCalls: search.inputs.length,
        sourceNumbers: search.results.map((r) => r.n),
        queries: search.inputs.flatMap((i) => i.queries),
        sources: search.results.map((r) => ({ n: r.n, url: r.url, title: r.title, snippet: r.snippet, ...(r.publishedDate ? { publishedDate: r.publishedDate } : {}) })),
        firstTokenMs: trace?.first_token_ms ?? null,
        totalMs: trace?.total_ms ?? null,
      });
    }

    const lastId = turnIds[turnIds.length - 1] ?? "";
    const trace = getTrace(db, lastId);
    const memory = parseJson<{ turns?: string[]; claims?: string[] }>(trace?.memory_ids_json, {});
    const resolved = parseJson<{ resolved?: string[] }>(trace?.resolved_dates_json, {});
    const observed: Observed = {
      turns,
      tz: c.timezone,
      trace: {
        resolvedDates: resolved.resolved ?? [],
        recallRules: parseJson<string[]>(trace?.recall_rules_json, []),
        injectedMemory: (memory.turns?.length ?? 0) + (memory.claims?.length ?? 0),
        errorKeys: errorKeysOf(parseJson<unknown>(trace?.errors_json, [])),
      },
      claims: db.prepare("SELECT * FROM claims ORDER BY observed_at, rowid").all() as ClaimRow[],
      writes: db
        .prepare(`SELECT op, detail_json FROM memory_writes WHERE turn_id IN (${turnIds.map(() => "?").join(",") || "NULL"})`)
        .all(...turnIds) as Pick<MemoryWriteRow, "op" | "detail_json">[],
    };
    const { hard, soft } = runChecks(c, observed);

    const lastTurn = turns[turns.length - 1];
    let judge: JudgeOutcome;
    try {
      judge = await judgeCase(deps.models.small, {
        messages: c.messages,
        answer: lastTurn?.answer ?? "",
        rubric: c.rubric,
        sources: lastTurn?.sources ?? [],
        now: c.now,
        mockedSearch: !!c.mockSearch,
      });
    } catch (err) {
      if (isDailyQuota(err)) throw new QuotaExhausted(`${c.id} judge (run ${rep})`);
      // Only the error class: provider messages can carry request details (no secrets in output).
      judge = { error: err instanceof Error ? err.name : "unknown error" };
    }

    const searched = turns.some((t) => t.searchCalls > 0);
    return {
      caseId: c.id,
      rep,
      turns,
      hard,
      soft,
      passed: hard.every((h) => h.pass),
      judge,
      searchMode: c.mockSearch ? "mock" : searched ? "live" : "live (unused)",
    };
  } finally {
    db.close();
  }
}
