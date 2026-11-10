import { generateText, streamText, wrapLanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it } from "vitest";
import { devCacheActive, getModels } from "../src/agent/model";
import { openDb, type Db } from "../src/db/index";
import { llmCacheMiddleware } from "../src/lib/llmCache";
import { retryMiddleware } from "../src/agent/retryMiddleware";
import { errorAfterText, flakyModel, httpError, objectModel, textModel } from "./helpers/mockModel";

const NOW = new Date("2026-11-12T05:30:00Z");
let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
});
const cached = (m: MockLanguageModelV4) => wrapLanguageModel({ model: m, middleware: llmCacheMiddleware(db, () => NOW) });
const run = async (m: Parameters<typeof streamText>[0]["model"], prompt = "hi") => {
  const r = streamText({ model: m, prompt, maxRetries: 0, onError: () => undefined });
  return Promise.resolve(r.text).catch(() => "(failed)");
};
const rows = () => (db.prepare("SELECT COUNT(*) AS n FROM llm_cache").get() as { n: number }).n;

describe("dev LLM cache middleware", () => {
  it("replays an identical stream without calling the model again", async () => {
    const inner = textModel(["Hello", " world"]);
    const m = cached(inner);
    expect(await run(m)).toBe("Hello world");
    expect(await run(m)).toBe("Hello world");
    expect(inner.doStreamCalls).toHaveLength(1);
  });

  it("a different prompt is a miss", async () => {
    const inner = textModel(["x"]);
    const m = cached(inner);
    await run(m, "one");
    await run(m, "two");
    expect(inner.doStreamCalls).toHaveLength(2);
  });

  it("the model id is part of the key", async () => {
    const a = textModel(["from A"]);
    const b = new MockLanguageModelV4({ modelId: "other-model", doStream: a.doStream as never });
    await run(cached(a));
    await run(cached(b));
    expect(a.doStreamCalls).toHaveLength(2); // b delegates to a's doStream: both models really ran
    expect(rows()).toBe(2); // a separate row for the other model id
  });

  it("never stores a stream that ended in an error part", async () => {
    await run(cached(errorAfterText("half", { message: "boom" })));
    expect(rows()).toBe(0);
  });

  it("never stores a call that threw", async () => {
    const { model } = flakyModel(textModel(["x"]), [httpError(500)]);
    await run(cached(model));
    expect(rows()).toBe(0);
  });

  it("never stores a stream the reader cancelled midway", async () => {
    const inner = textModel(["a", "b", "c"]);
    const r = streamText({ model: cached(inner), prompt: "hi", maxRetries: 0 });
    const reader = r.textStream.getReader();
    await reader.read();
    await reader.cancel();
    expect(rows()).toBe(0);
  });

  it("stores generate() results too, and a hit skips the model", async () => {
    const inner = objectModel({ ok: true });
    const m = cached(inner);
    await generateText({ model: m, prompt: "hi" });
    await generateText({ model: m, prompt: "hi" });
    expect(inner.doGenerateCalls).toHaveLength(1);
  });

  it("with retry on top, a retried call is cached once it finally succeeds", async () => {
    const { model, attempts } = flakyModel(textModel(["ok"]), [httpError(503)]);
    const stack = wrapLanguageModel({
      model: cached(model),
      middleware: retryMiddleware({ sleep: async () => undefined, rand: () => 1 }),
    });
    expect(await run(stack)).toBe("ok");
    expect(await run(stack)).toBe("ok");
    expect(attempts()).toBe(2); // failed attempt + success; the second run was a cache hit
  });
});

describe("dev cache guardrails (D46)", () => {
  const env = { LLM_PROVIDER: "google", MAIN_MODEL: "m", SMALL_MODEL: "s", GOOGLE_GENERATIVE_AI_API_KEY: "k", OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined } as const;

  it("is active only with the flag, a cache target and a non-production NODE_ENV", () => {
    const cache = { db, now: () => NOW };
    expect(devCacheActive({ DEV_LLM_CACHE: true }, { cache, nodeEnv: "development" })).toBe(true);
    expect(devCacheActive({ DEV_LLM_CACHE: true }, { cache, nodeEnv: "production" })).toBe(false);
    expect(devCacheActive({ DEV_LLM_CACHE: false }, { cache, nodeEnv: "development" })).toBe(false);
    // The eval runner passes no cache target, so it can never get one.
    expect(devCacheActive({ DEV_LLM_CACHE: true }, { nodeEnv: "development" })).toBe(false);
    expect(devCacheActive({ DEV_LLM_CACHE: true })).toBe(false);
  });

  it("getModels returns plain models when the cache is off", () => {
    const m = getModels({ ...env, DEV_LLM_CACHE: false }, { cache: { db, now: () => NOW } });
    expect((m.main as { modelId: string }).modelId).toBe("m");
    expect(m.main).not.toHaveProperty("specificationVersion", "wrapped");
  });
});
