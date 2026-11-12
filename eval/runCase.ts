import { randomUUID } from "node:crypto";
import { loadSeed, parseSeed, removeDbFiles } from "../scripts/seed";
import { readFileSync } from "node:fs";
import { runAgent, type AgentDeps } from "../src/agent/index";
import { DAILY_QUOTA_TEXT, RATE_LIMIT_TEXT, SERVER_ERROR_TEXT } from "../src/agent/errors";
import type { Models } from "../src/agent/model";
import { openDb, type Db } from "../src/db/index";
import { forgetThreadMemory, getTrace, type ClaimRow, type MemoryWriteRow } from "../src/db/memoryRepo";
import { isDailyQuota } from "../src/lib/retry";
import type { Search, SearchInput } from "../src/search/index";
import type { SearchResult } from "../src/search/types";
import type { EvalCase, MockPage } from "./cases";
import { runChecks, type CheckResult, type Observed, type TurnObservation } from "./checks";
import { judgeCase, JudgeTimeout, type Judgement, type JudgeMemory } from "./judge";
import { describeMemory } from "../src/server/memoryRoutes";

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
  /**
   * Where the case's SQLite file goes; ":memory:" in tests. One file per repetition (`<id>-r<n>.db`) and per
   * attempt, so --repeat and an infra rerun never overwrite the evidence of an earlier run (D72).
   */
  dbPath: (caseId: string, rep: number, attempt: number) => string;
  maxSteps: number;
  /** Sleep/jitter for model retries; tests pass instant ones. */
  retry?: AgentDeps["retry"];
  /** Cap on one judge call (default 60 s, D78); tests pass a few milliseconds. */
  judgeTimeoutMs?: number;
}

export interface TurnLog extends TurnObservation {
  message: string;
  queries: string[];
  sources: { n: number; url: string; title: string; publishedDate?: string; snippet: string }[];
  firstTokenMs: number | null;
  totalMs: number | null;
  /** The turn's per-step trace (model/search ms, finish reasons, every request with tool choice and tool calls), D72. */
  steps?: unknown[];
  /** The trace's `errors` entries (forcedSearchViolation, verify checks, modelError...). */
  traceErrors?: unknown[];
  /** Model calls the retry layer repeated during this turn (the trace's usage.retries). */
  retries?: number;
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
  /** Wall time of the judge call, whatever its outcome (D78): tells a slow judge from a slow agent turn. */
  judgeMs?: number;
  /** "mock": a fixture replaced the providers. "live": real search; "live (unused)": real search, never called. */
  searchMode: "mock" | "live" | "live (unused)";
  /**
   * Infrastructure problems in this attempt (a provider 5xx / rate limit that ended a turn, a failed memory write):
   * what makes the orchestrator rerun the case once (D70). Absent when there were none.
   */
  infra?: string[];
  /** The discarded first attempt, when this result is the rerun after an infra problem. */
  firstAttempt?: RunResult;
  /** Model ids the providers reported (an alias like "-latest" resolves to a dated id), when they did. */
  resolved?: { main?: string; small?: string };
}

/** What infraReasons reads from a turn; the first two are all a test needs. */
export interface InfraTurn {
  status: string;
  answer: string;
  /** usage.retries from the trace: model calls the retry layer repeated. */
  retries?: number;
  /** The trace's `errors` entries; `{ modelError: { name, status? } }` is the error that ended the turn (D76). */
  traceErrors?: readonly unknown[];
}

function modelErrorOf(errors: readonly unknown[] | undefined): { name?: unknown; status?: unknown } | undefined {
  for (const e of errors ?? []) {
    const m = e && typeof e === "object" ? (e as { modelError?: unknown }).modelError : undefined;
    if (m && typeof m === "object") return m as { name?: unknown; status?: unknown };
  }
  return undefined;
}

/**
 * Why an attempt counts as an infrastructure failure rather than a wrong answer: a turn that ended in an error row after
 * a provider 5xx or rate limit (also mid-stream), after the retry layer gave up (retries > 0, whatever the final message
 * said: A18 run 2 showed "Something went wrong" after 3 retries), or with a provider API error / any 5xx recorded in its
 * trace; or a memory write that errored (timeout, 429...). A turn with no retries and no provider error (a missing API
 * key, a bug) is not infra. Pure, for tests.
 */
export function infraReasons(
  turns: ReadonlyArray<InfraTurn>,
  writes: ReadonlyArray<{ op: string; detail_json: string | null }>,
): string[] {
  const out: string[] = [];
  for (const t of turns) {
    if (t.status !== "error") continue;
    const failure = modelErrorOf(t.traceErrors);
    const status = typeof failure?.status === "number" ? failure.status : undefined;
    if (t.answer.includes(SERVER_ERROR_TEXT) || (status !== undefined && status >= 500)) out.push("provider 5xx");
    else if (t.answer.includes(RATE_LIMIT_TEXT) || status === 429) out.push("provider rate limit");
    // A rejected key (401/403) fails the same way on a rerun, so it stays a plain failure.
    else if (failure?.name === "SlowResponseError") out.push("model stalled (no first chunk)");
    else if (failure?.name === "AI_APICallError" && status !== 401 && status !== 403) out.push(`provider API error${status !== undefined ? ` (HTTP ${status})` : ""}`);
    else if ((t.retries ?? 0) > 0) out.push(`provider error after ${t.retries} ${t.retries === 1 ? "retry" : "retries"}`);
  }
  for (const w of writes) {
    if (w.op !== "error") continue;
    let name = "error";
    try {
      name = String((JSON.parse(w.detail_json ?? "{}") as { error?: unknown }).error ?? "error");
    } catch {
      // keep the generic name
    }
    out.push(`memory write failed (${name})`);
  }
  return [...new Set(out)];
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
export async function runCase(deps: CaseDeps, c: EvalCase, rep: number, attempt = 1): Promise<RunResult> {
  const path = deps.dbPath(c.id, rep, attempt);
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
        steps: parseJson<unknown[]>(trace?.steps_json, []),
        traceErrors: parseJson<unknown[]>(trace?.errors_json, []),
        retries: parseJson<{ retries?: number }>(trace?.usage_json, {}).retries ?? 0,
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

    // What the agent was shown from earlier chats, so recalled history is not scored as invention.
    const memoryIds = parseJson<{ turns?: string[]; inThreadTurns?: string[]; claims?: string[]; claimsAtRecall?: JudgeMemory["claims"] }>(trace?.memory_ids_json, {});
    const described = describeMemory(db, memoryIds, 600);
    const shown: JudgeMemory = {
      turns: [...described.turns, ...described.inThreadTurns].map((t) => ({ date: t.date, text: t.text })),
      claims: memoryIds.claimsAtRecall ?? described.claims,
    };
    const resolvedMain = turnIds
      .map((id) => parseJson<{ resolvedModel?: string }>(getTrace(db, id)?.usage_json, {}).resolvedModel)
      .filter((m): m is string => !!m)
      .at(-1);

    const lastTurn = turns[turns.length - 1];
    let judge: JudgeOutcome;
    const judgeStarted = performance.now();
    try {
      judge = await judgeCase(deps.models.small, {
        messages: c.messages,
        answer: lastTurn?.answer ?? "",
        rubric: c.rubric,
        sources: lastTurn?.sources ?? [],
        memory: shown,
        now: c.now,
        mockedSearch: !!c.mockSearch,
      }, deps.judgeTimeoutMs === undefined ? {} : { timeoutMs: deps.judgeTimeoutMs });
    } catch (err) {
      if (isDailyQuota(err)) throw new QuotaExhausted(`${c.id} judge (run ${rep})`);
      // Only the error class: provider messages can carry request details (no secrets in output).
      // A timeout is a plain "timeout": informational like any judge error, never a failed check.
      judge = { error: err instanceof JudgeTimeout ? "timeout" : err instanceof Error ? err.name : "unknown error" };
    }
    const judgeMs = Math.round(performance.now() - judgeStarted);

    const searched = turns.some((t) => t.searchCalls > 0);
    const infra = infraReasons(turns, observed.writes);
    return {
      caseId: c.id,
      rep,
      turns,
      hard,
      soft,
      passed: hard.every((h) => h.pass),
      judge,
      judgeMs,
      searchMode: c.mockSearch ? "mock" : searched ? "live" : "live (unused)",
      ...(infra.length > 0 ? { infra } : {}),
      ...(resolvedMain || ("modelId" in judge && judge.modelId)
        ? { resolved: { ...(resolvedMain ? { main: resolvedMain } : {}), ...("modelId" in judge && judge.modelId ? { small: judge.modelId } : {}) } }
        : {}),
    };
  } finally {
    db.close();
  }
}
