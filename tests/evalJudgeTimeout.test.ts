import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { loadCases, type EvalCase } from "../eval/cases";
import { JUDGE_TIMEOUT_MS, judgeCase, JudgeTimeout, type JudgeInput } from "../eval/judge";
import { judgeCell, renderTranscript } from "../eval/render";
import { runCase, type CaseDeps } from "../eval/runCase";
import { loadStored, saveCase } from "../eval/store";
import { objectModel, textModel } from "./helpers/mockModel";
import { noSearch } from "./helpers/search";

// D78: one judge call is capped (60 s in production, a few ms here). A stalled judge is recorded as
// `judge error: timeout` with its elapsed time, never blocks the run and never changes pass/fail.

const LIMIT = 40;
const A6: EvalCase = (() => {
  const c = loadCases().find((x) => x.id.startsWith("A6-"));
  if (!c) throw new Error("no case A6");
  return c;
})();

const input: JudgeInput = { messages: ["hi"], answer: "hello", rubric: "greets", sources: [], now: "2026-11-12T05:30:00Z", mockedSearch: false };

/** The small model serves the background extraction first, then the judge; the judge call is `judge`. */
function small(judge: (signal: AbortSignal | undefined) => Promise<unknown>) {
  let calls = 0;
  const aborted: boolean[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: async (o) => {
      if (calls++ === 0) return objectModel({ summary: "", claims: [] }).doGenerate(o);
      o.abortSignal?.addEventListener("abort", () => aborted.push(true), { once: true });
      return (await judge(o.abortSignal)) as never;
    },
  });
  return { model, aborted };
}

const deps = (s: MockLanguageModelV4, judgeTimeoutMs = LIMIT): CaseDeps => ({
  models: { main: textModel(["Doing well, thanks!"]), small: s },
  liveSearch: () => noSearch,
  dbPath: () => ":memory:",
  maxSteps: 4,
  retry: { sleep: async () => undefined, rand: () => 0 },
  judgeTimeoutMs,
});

const never = () => new Promise<never>(() => undefined); // ignores the abort signal, like a stalled stream

describe("judge timeout (D78)", () => {
  it("the production cap is 60 s", () => expect(JUDGE_TIMEOUT_MS).toBe(60_000));

  it("judgeCase rejects with JudgeTimeout when the model never answers, even if it ignores the abort signal", async () => {
    const hung = new MockLanguageModelV4({ doGenerate: never });
    const t0 = performance.now();
    await expect(judgeCase(hung, input, { timeoutMs: LIMIT })).rejects.toBeInstanceOf(JudgeTimeout);
    expect(performance.now() - t0).toBeLessThan(LIMIT * 10);
  });

  it("the abort reaches a model that honours it, so the request is cancelled", async () => {
    const aborted: boolean[] = [];
    const model = new MockLanguageModelV4({
      doGenerate: (o) =>
        new Promise((_, reject) =>
          o.abortSignal?.addEventListener("abort", () => (aborted.push(true), reject(new Error("aborted"))), { once: true }),
        ),
    });
    await expect(judgeCase(model, input, { timeoutMs: LIMIT })).rejects.toBeInstanceOf(JudgeTimeout);
    expect(aborted).toEqual([true]);
  });

  it("a stalled judge: the run completes, judge is `timeout`, pass/fail is unchanged, elapsed time is recorded", async () => {
    const { model } = small(never);
    const r = await runCase(deps(model), A6, 1);
    expect(r.judge).toEqual({ error: "timeout" });
    expect(r.passed).toBe(true);
    expect(r.hard.every((h) => h.pass)).toBe(true);
    expect(r.judgeMs).toBeGreaterThanOrEqual(LIMIT - 5);
    expect(r.judgeMs).toBeLessThan(LIMIT * 20);
    expect(r.infra).toBeUndefined(); // a slow judge is not an infra rerun
  });

  it("a prompt judge still scores, and its elapsed time is recorded too", async () => {
    const { model } = small(async () => ({
      content: [{ type: "text", text: JSON.stringify({ score: 4, reason: "fine" }) }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: { inputTokens: { total: 1, noCache: 1 }, outputTokens: { total: 1, text: 1 } },
      warnings: [],
    }));
    const r = await runCase(deps(model, 5_000), A6, 1);
    expect(r.judge).toMatchObject({ score: 4 });
    expect(typeof r.judgeMs).toBe("number");
  });

  it("results.md shows the timeout as err, the transcript shows `error (timeout)` with its time", async () => {
    const { model } = small(never);
    const r = await runCase(deps(model), A6, 1);
    expect(judgeCell([r])).toBe("err");
    const text = renderTranscript(A6, [{ ...r, judgeMs: 60_000 }], { provider: "google", mainModel: "m", smallModel: "s", thinking: "t", ranAt: "2026-11-12", repeat: 1, pauseMs: 0 });
    expect(text).toContain("Judge: error (timeout) [60.0 s]");
  });

  it("judgeMs survives the store round trip", async () => {
    const { model } = small(never);
    const r = await runCase(deps(model), A6, 1);
    const dir = mkdtempSync(join(tmpdir(), "judge-store-"));
    try {
      const ids = { provider: "google", mainModel: "m", smallModel: "s", thinking: "t" };
      saveCase(dir, A6, ids, "2026-11-12T00:00:00Z", 1, [r]);
      const back = loadStored(dir, A6, ids, 1);
      expect(back?.runs[0]?.judge).toEqual({ error: "timeout" });
      expect(back?.runs[0]?.judgeMs).toBe(r.judgeMs);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
