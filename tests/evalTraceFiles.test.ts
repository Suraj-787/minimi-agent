import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APICallError } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadCases } from "../eval/cases";
import { runAll } from "../eval/orchestrate";
import { resolveRunMode } from "../eval/policy";
import { renderSteps } from "../eval/render";
import { loadStored } from "../eval/store";
import { flakyModel, objectModel, scriptedModel, textModel } from "./helpers/mockModel";
import { noSearch } from "./helpers/search";

// D72: one DB per repetition (and per attempt), and the per-step trace kept in the stored result and the transcript.

const cases = loadCases();
const A6 = cases.find((c) => c.id.startsWith("A6-"))!;
const A13 = cases.find((c) => c.id.startsWith("A13-"))!;
const ids = { provider: "google", mainModel: "m", smallModel: "s", thinking: "tool low / answer low" };
const meta = { ...ids, ranAt: "2026-11-12 05:30 UTC", repeat: 1, pauseMs: 0 };
const err = (statusCode: number) => new APICallError({ message: "boom", url: "https://example.test", requestBodyValues: {}, statusCode, isRetryable: false });
const smallOk = () => objectModel((i: number) => (i % 2 === 0 ? { summary: "", claims: [] } : { score: 4, reason: "ok" }));

let dir = "";
afterEach(() => {
  vi.restoreAllMocks();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function setup(main: unknown, args: string[], list = [A6]) {
  dir = mkdtempSync(join(tmpdir(), "eval-files-"));
  const paths: Array<[string, number, number]> = [];
  const mode = resolveRunMode(["--pause-ms", "0", ...args]);
  return {
    paths,
    mode,
    o: {
      deps: {
        models: { main: main as never, small: smallOk() },
        liveSearch: () => noSearch,
        dbPath: (id: string, rep: number, attempt: number) => {
          paths.push([id, rep, attempt]);
          return join(dir, `${id}-r${rep}${attempt > 1 ? `-a${attempt}` : ""}.db`);
        },
        maxSteps: 4,
        retry: { sleep: async () => undefined, rand: () => 0 },
      },
      cases: list,
      mode,
      ids,
      meta: { ...meta, repeat: mode.repeat },
      evalDir: dir,
      sleep: async () => undefined,
      now: () => new Date("2026-11-12T10:00:00Z"),
      log: () => undefined,
    },
  };
}

describe("one DB per repetition", () => {
  it("--repeat 3 leaves <id>-r1.db, -r2.db and -r3.db, none overwritten", async () => {
    const { o } = setup(textModel(["Doing well, thanks!"]), ["--repeat", "3"]);
    await runAll(o);
    expect(readdirSync(dir).filter((f) => f.endsWith(".db")).sort()).toEqual([`${A6.id}-r1.db`, `${A6.id}-r2.db`, `${A6.id}-r3.db`]);
  });

  it("an infra rerun uses its own file, so the first attempt's evidence survives", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const flaky = flakyModel(textModel(["Doing well, thanks!"]), [err(503), err(503), err(503), err(503)]);
    const { o, paths } = setup(flaky.model, []);
    await runAll(o);
    expect(paths).toEqual([[A6.id, 1, 1], [A6.id, 1, 2]]);
    expect(existsSync(join(dir, `${A6.id}-r1.db`))).toBe(true);
    expect(existsSync(join(dir, `${A6.id}-r1-a2.db`))).toBe(true);
  });
});

describe("step traces are kept in the stored result and the transcript", () => {
  const TABLE = "| Item | Said (date) | Then → Now | Status | Evidence date | Source |\n|---|---|---|---|---|---|\n";
  const ANSWER = `${TABLE}| Supabase Pro | 2026-11-03 | $25 → $29 | Differs now (timing unknown) | 2026-11-11 | [1] |\n\nSupabase differs now, as of 12 Nov [1].`;

  it("each turn carries its steps with every request: tool choice, tools, finish reason, tool calls", async () => {
    const main = scriptedModel([
      { toolCall: { name: "web_search", input: { queries: ["Supabase pricing"] } } },
      { toolCall: { name: "web_search", input: { queries: ["more"] } } }, // ignored on the closed step
      { text: ANSWER },
    ]);
    const { o } = setup(main, [], [A13]);
    const out = await runAll(o);
    const live = out.reports[0]!.runs[0]!.turns[0]!;
    const stored = loadStored(dir, A13, ids, 1)!.runs[0]!.turns[0]!;
    for (const turn of [live, stored]) {
      const steps = turn.steps as Array<{ calls: Array<{ kind: string; toolChoice: string; hasTools: boolean; finishReason: string; toolCalls: Array<{ name: string; input: string }> }> }>;
      expect(steps).toHaveLength(2);
      expect(steps[0]!.calls[0]).toMatchObject({ kind: "forced", toolChoice: "tool:web_search", hasTools: true });
      expect(steps[1]!.calls.map((c) => [c.kind, c.toolChoice, c.hasTools, c.finishReason])).toEqual([
        ["closed", "none", false, "tool-calls"],
        ["closed-retry", "none", false, "stop"],
      ]);
      expect(steps[1]!.calls[0]!.toolCalls[0]!.input).toContain("more");
      expect(Array.isArray(turn.traceErrors)).toBe(true);
    }
    const transcript = readFileSync(join(dir, "transcripts", `${A13.id}.md`), "utf8");
    expect(transcript).toContain("Steps:");
    expect(transcript).toContain("closed: toolChoice none, tools none → finish tool-calls");
    expect(transcript).toContain("tool calls: web_search(");
    expect(transcript).toContain("closed-retry: toolChoice none, tools none → finish stop");
  });

  it("renderSteps tolerates an empty or older trace", () => {
    expect(renderSteps(undefined)).toEqual([]);
    expect(renderSteps([])).toEqual([]);
    expect(renderSteps([{ step: 0, mode: "auto", modelMs: 5 }])).toEqual(["Steps:", "- step 1 (auto): model 5 ms, search 0 ms, finish ?, text 0 chars"]);
  });
});
