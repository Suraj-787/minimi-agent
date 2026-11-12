import { wrapLanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it } from "vitest";
import { friendlyError } from "../src/agent/errors";
import { runAgent, type AgentDeps } from "../src/agent/index";
import { retryMiddleware } from "../src/agent/retryMiddleware";
import { getTrace } from "../src/db/memoryRepo";
import { openDb, type Db } from "../src/db/index";
import { listMessages } from "../src/db/repo";
import { classify, SlowResponseError } from "../src/lib/retry";
import { emptyExtraction, gatedModel, objectModel, textModel } from "./helpers/mockModel";
import { noSearch } from "./helpers/search";

// D76: no content chunk within the limit → abort the attempt and retry once, reason "slow". The limit is a few
// milliseconds here; production uses 60 s.

const LIMIT = 40;
const params = { prompt: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }] };

type Attempt = "hang-before-response" | "preamble-only" | "text";
interface Seen {
  calls: number;
  aborted: boolean[];
}

/** One scripted behaviour per call; stalls honour the abort signal like a real fetch does. */
function scripted(script: Attempt[]): { model: MockLanguageModelV4; seen: Seen } {
  const seen: Seen = { calls: 0, aborted: [] };
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      const i = seen.calls++;
      const how = script[Math.min(i, script.length - 1)];
      const onAbort = () => seen.aborted.push(true);
      options.abortSignal?.addEventListener("abort", onAbort, { once: true });
      if (how === "hang-before-response") {
        // The HTTP response itself never comes (until aborted).
        await new Promise<never>((_, reject) => options.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      }
      if (how === "preamble-only") {
        // Headers and stream-start arrive, content never does.
        return { stream: new ReadableStream({ start: (c) => c.enqueue({ type: "stream-start", warnings: [] }) }) as never };
      }
      return textModel(["Fine."]).doStream(options);
    },
  });
  return { model, seen };
}

async function read(stream: ReadableStream<{ type: string; delta?: string }>): Promise<string> {
  let text = "";
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text;
    if (value.type === "text-delta") text += value.delta;
  }
}

function wrapped(model: MockLanguageModelV4, retries: Array<{ attempt: number; reason: string }>, limit = LIMIT) {
  return wrapLanguageModel({
    model,
    middleware: retryMiddleware({
      sleep: async () => undefined,
      rand: () => 0,
      firstChunkTimeoutMs: limit,
      onRetry: ({ attempt, reason }) => void retries.push({ attempt, reason }),
    }),
  });
}

describe("first-chunk timeout in the retry middleware", () => {
  it.each(["hang-before-response", "preamble-only"] as const)("a first attempt that stalls (%s) is aborted and retried once, reason slow", async (how) => {
    const { model, seen } = scripted([how, "text"]);
    const retries: Array<{ attempt: number; reason: string }> = [];
    const result = await wrapped(model, retries).doStream(params);
    expect(await read(result.stream as never)).toBe("Fine.");
    expect(seen.calls).toBe(2);
    expect(seen.aborted).toEqual([true]); // the stalled request was really cancelled
    expect(retries).toEqual([{ attempt: 1, reason: "slow" }]);
  });

  it("a second stall is final: no third attempt, and the error is a SlowResponseError", async () => {
    const { model, seen } = scripted(["preamble-only"]);
    const retries: Array<{ attempt: number; reason: string }> = [];
    const err = await wrapped(model, retries).doStream(params).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(SlowResponseError);
    expect(seen.calls).toBe(2);
    expect(retries).toEqual([{ attempt: 1, reason: "slow" }]);
    expect(friendlyError(err)).toMatch(/too long to start answering/);
  });

  it("a stream that has produced content is never timed out or retried, however slow the rest is", async () => {
    const { model: inner, release } = gatedModel("Hello", " world");
    const seen = { calls: 0 };
    const counted = new MockLanguageModelV4({ doStream: async (o) => (seen.calls++, inner.doStream(o)) });
    const retries: Array<{ attempt: number; reason: string }> = [];
    const result = await wrapped(counted, retries).doStream(params);
    await new Promise((r) => setTimeout(r, LIMIT * 3)); // well past the limit, mid-stream
    release();
    expect(await read(result.stream as never)).toBe("Hello world");
    expect(seen.calls).toBe(1);
    expect(retries).toEqual([]);
  });

  it("a prompt reply is untouched, and 0 turns the limit off", async () => {
    const retries: Array<{ attempt: number; reason: string }> = [];
    expect(await read((await wrapped(textModel(["ok"]), retries).doStream(params)).stream as never)).toBe("ok");
    // With the limit off a stalled attempt is simply awaited: still pending well past LIMIT, and never retried.
    const { model, seen } = scripted(["preamble-only", "text"]);
    const pending = wrapped(model, retries, 0).doStream(params).then(() => "done");
    expect(await Promise.race([pending, new Promise((r) => setTimeout(() => r("still waiting"), LIMIT * 4))])).toBe("still waiting");
    expect(seen.calls).toBe(1);
    expect(retries).toEqual([]);
  });

  it("classify: the first stall retries as slow, the second does not", () => {
    expect(classify(new SlowResponseError(60_000, true))).toEqual({ kind: "retry", reason: "slow" });
    expect(classify(new SlowResponseError(60_000, false))).toEqual({ kind: "fatal" });
  });
});

describe("a stalled model inside a turn (agent level)", () => {
  let db: Db;
  beforeEach(() => void (db = openDb(":memory:")));
  const TID = "33333333-3333-4333-8333-333333333333";
  const deps = (main: MockLanguageModelV4): AgentDeps => ({
    db,
    models: { main, small: objectModel(emptyExtraction) },
    now: () => new Date("2026-11-12T05:30:00Z"),
    search: noSearch,
    maxSteps: 4,
    retry: { sleep: async () => undefined, rand: () => 0, firstChunkTimeoutMs: LIMIT },
  });
  async function drain(run: Awaited<ReturnType<typeof runAgent>>) {
    const out: Array<{ type: string; data?: { text?: string } }> = [];
    for await (const c of run.stream) out.push(c as never);
    await run.done;
    return out;
  }

  it("shows a slow-retry status, counts one retry in the trace, and the turn completes", async () => {
    const { model } = scripted(["preamble-only", "text"]);
    const chunks = await drain(await runAgent(deps(model), { threadId: TID, message: "hi", tz: "Asia/Kolkata" }));
    expect(chunks.filter((c) => c.type === "data-status").map((c) => c.data?.text)).toContain("The model is slow to respond, retrying…");
    const last = listMessages(db, TID).at(-1)!;
    expect(last).toMatchObject({ text: "Fine.", status: "complete" });
    expect(JSON.parse(getTrace(db, last.id)?.usage_json ?? "{}").retries).toBe(1);
  });

  it("two stalls end in an error row whose trace names SlowResponseError (the eval reruns that as infra)", async () => {
    const { model } = scripted(["preamble-only"]);
    await drain(await runAgent(deps(model), { threadId: TID, message: "hi", tz: "Asia/Kolkata" }));
    const last = listMessages(db, TID).at(-1)!;
    expect(last.status).toBe("error");
    expect(last.text).toContain("too long to start answering");
    const trace = getTrace(db, last.id);
    expect(JSON.parse(trace?.errors_json ?? "[]")).toContainEqual({ modelError: { name: "SlowResponseError" } });
  });
});
