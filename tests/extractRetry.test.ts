import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { ExtractError, extractTurnMemory, type ExtractInput } from "../src/memory/extract";
import { memoryWritesForTurn } from "../src/db/memoryRepo";
import { writeTurnMemory } from "../src/memory/write";
import { IST, SEED_NOW, addTurn, seededDb } from "./helpers/seed";

// D70: up to 3 extraction attempts, each with its own timeout; the failure row says how long it tried and why.

const INPUT: ExtractInput = { userText: "q", answerText: "a [1]", citedSources: [{ n: 1, url: "https://neon.com/pricing" }], knownClaims: [], today: "2026-11-12" };
const GOOD = { summary: "ok", claims: [] };
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
const result = (value: unknown) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }],
  finishReason: { unified: "stop" as const, raw: undefined },
  usage,
  warnings: [],
});
const apiError = (statusCode: number, o: { body?: string; headers?: Record<string, string> } = {}) =>
  new APICallError({
    message: "secret-body-AIzaSyFAKE",
    url: "https://example.test",
    requestBodyValues: {},
    statusCode,
    ...(o.body ? { responseBody: o.body } : {}),
    ...(o.headers ? { responseHeaders: o.headers } : {}),
    isRetryable: statusCode === 429 || statusCode >= 500,
  });

type Step = "hang" | "ok" | "garbage" | Error;
/** One scripted reply per call. "hang" never answers until the call is aborted, like one slow response. */
function scripted(steps: Step[]) {
  let i = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async (opts) => {
      const step = steps[Math.min(i++, steps.length - 1)] as Step;
      if (step === "ok") return result(GOOD);
      if (step === "garbage") return result("not json at all");
      if (step instanceof Error) throw step;
      return new Promise<never>((_, reject) => opts.abortSignal?.addEventListener("abort", () => reject(opts.abortSignal?.reason)));
    },
  });
  return model;
}

const instant = () => {
  const delays: number[] = [];
  return { delays, sleep: async (ms: number) => void delays.push(ms), rand: () => 1 };
};

describe("extractTurnMemory attempts", () => {
  it("a hung first attempt times out on its own, and the second attempt succeeds", async () => {
    const model = scripted(["hang", "ok"]);
    const t = instant();
    const out = await extractTurnMemory(model, INPUT, { attemptTimeoutMs: 40, totalMs: 10_000, sleep: t.sleep, rand: t.rand });
    expect(out).toEqual(GOOD);
    expect(model.doGenerateCalls).toHaveLength(2);
  });

  it("a 503 then a 429 are retried; the third attempt succeeds (the SDK's own silent retries are off)", async () => {
    const model = scripted([apiError(503), apiError(429, { body: '{"error":{"message":"rate limited"}}' }), "ok"]);
    const t = instant();
    expect(await extractTurnMemory(model, INPUT, { sleep: t.sleep, rand: t.rand })).toEqual(GOOD);
    expect(model.doGenerateCalls).toHaveLength(3);
    expect(t.delays).toHaveLength(2);
  });

  it("waits the provider's retry-after hint between attempts", async () => {
    const model = scripted([apiError(429, { headers: { "retry-after": "2" } }), "ok"]);
    const t = instant();
    await extractTurnMemory(model, INPUT, { sleep: t.sleep, rand: t.rand });
    expect(t.delays).toEqual([2000]);
  });

  it("three timeouts give up: ExtractError with 3 attempts, the elapsed time and TimeoutError", async () => {
    const model = scripted(["hang"]);
    const t = instant();
    const err = await extractTurnMemory(model, INPUT, { attemptTimeoutMs: 25, totalMs: 10_000, sleep: t.sleep, rand: t.rand }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExtractError);
    expect(err).toMatchObject({ attempts: 3, causeName: "TimeoutError" });
    expect((err as ExtractError).elapsedMs).toBeGreaterThanOrEqual(60);
    expect(model.doGenerateCalls).toHaveLength(3);
  });

  it("the total cap stops further attempts", async () => {
    const model = scripted(["hang"]);
    const t = instant();
    const err = (await extractTurnMemory(model, INPUT, { attemptTimeoutMs: 1000, totalMs: 50, sleep: t.sleep, rand: t.rand }).catch((e: unknown) => e)) as ExtractError;
    expect(err.attempts).toBe(1);
    expect(err.elapsedMs).toBeLessThan(500);
  });

  it("a daily quota and a schema failure are not retried; the error keeps status and retry-after", async () => {
    const quota = scripted([apiError(429, { body: "GenerateRequestsPerDayPerProject", headers: { "retry-after": "30" } })]);
    const q = (await extractTurnMemory(quota, INPUT, instant()).catch((e: unknown) => e)) as ExtractError;
    expect(quota.doGenerateCalls).toHaveLength(1);
    expect(q).toMatchObject({ attempts: 1, status: 429, retryAfterMs: 30_000 });

    const garbage = scripted(["garbage"]);
    const g = (await extractTurnMemory(garbage, INPUT, instant()).catch((e: unknown) => e)) as ExtractError;
    expect(garbage.doGenerateCalls).toHaveLength(1);
    expect(g.causeName).toBe("AI_NoObjectGeneratedError");
  });
});

describe("the memory_writes error row", () => {
  it("records attempts, elapsed time, status and retry-after, and never the provider's message", async () => {
    const db = seededDb();
    const t = addTurn(db, { user: "q", answer: "a", at: SEED_NOW });
    const model = scripted([apiError(503, { headers: { "retry-after": "1" } })]);
    const sleeps = instant();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await writeTurnMemory(
      { db, model, now: () => SEED_NOW, extract: { sleep: sleeps.sleep, rand: sleeps.rand } },
      { turnId: t.answer.id, threadId: t.threadId, tz: IST, localDate: "2026-11-12", userText: "q", answerText: "a [1]", sources: [{ n: 1, url: "https://neon.com/pricing" }], knownClaims: [] },
    );
    vi.restoreAllMocks();
    expect(r.error).toBe("extract");
    const row = memoryWritesForTurn(db, t.answer.id).find((w) => w.op === "error");
    const detail = JSON.parse(row?.detail_json ?? "{}") as Record<string, unknown>;
    expect(detail).toMatchObject({ stage: "extract", error: "AI_APICallError", attempts: 3, status: 503, retryAfterMs: 1000 });
    expect(typeof detail.elapsedMs).toBe("number");
    expect(row?.detail_json).not.toContain("secret-body");
    expect(model.doGenerateCalls).toHaveLength(3);
  });

  it("a success after a retry writes no error row", async () => {
    const db = seededDb();
    const t = addTurn(db, { user: "q", answer: "a", at: SEED_NOW });
    const sleeps = instant();
    const r = await writeTurnMemory(
      { db, model: scripted([apiError(503), "ok"]), now: () => SEED_NOW, extract: { sleep: sleeps.sleep, rand: sleeps.rand } },
      { turnId: t.answer.id, threadId: t.threadId, tz: IST, localDate: "2026-11-12", userText: "q", answerText: "a [1]", sources: [{ n: 1, url: "https://neon.com/pricing" }], knownClaims: [] },
    );
    expect(r.error).toBeUndefined();
    expect(memoryWritesForTurn(db, t.answer.id).some((w) => w.op === "error")).toBe(false);
  });
});

