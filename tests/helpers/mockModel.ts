import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";

const usage = {
  inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

const finish = {
  type: "finish" as const,
  finishReason: { unified: "stop" as const, raw: undefined },
  logprobs: undefined,
  usage,
};

type Chunk = Record<string, unknown>;

function textChunks(parts: string[]): Chunk[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t1" },
    ...parts.map((delta) => ({ type: "text-delta", id: "t1", delta })),
    { type: "text-end", id: "t1" },
    finish,
  ];
}

function streamOf(chunks: Chunk[]): ReadableStream<Chunk> {
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(ch);
      c.close();
    },
  });
}

/** Replies with `parts` joined; records every call so tests can inspect the prompt. */
export function textModel(parts: string[]): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    // biome-ignore lint: test double, chunk shapes are checked by the SDK at runtime
    doStream: async () => ({ stream: streamOf(textChunks(parts)) as never }),
  });
}

/** Rejects the call, like a provider returning an HTTP error. */
export function failingModel(statusCode: number): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async () => {
      throw new APICallError({
        message: "secret-key-AIzaSyFAKE leaked in provider message",
        url: "https://example.test",
        requestBodyValues: {},
        statusCode,
      });
    },
  });
}

/** Emits `before`, then waits for release(), then emits `after`. Lets a test act mid-stream. */
export function gatedModel(before: string, after: string) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream<Chunk>({
        async start(c) {
          for (const ch of textChunks([before]).slice(0, 3)) c.enqueue(ch);
          await gate;
          c.enqueue({ type: "text-delta", id: "t1", delta: after });
          c.enqueue({ type: "text-end", id: "t1" });
          c.enqueue(finish);
          c.close();
        },
      }) as never,
    }),
  });
  return { model, release };
}

/**
 * One scripted model step per doStream call. `toolCall` makes the step end by calling a tool;
 * after the script runs out the last step repeats (handy for "model never stops searching").
 */
export function scriptedModel(steps: Array<{ text?: string; toolCall?: { name: string; input: unknown } }>) {
  let i = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const step = steps[Math.min(i, steps.length - 1)] ?? {};
      const id = `call-${i++}`;
      const chunks: Chunk[] = [{ type: "stream-start", warnings: [] }];
      if (step.text) {
        chunks.push({ type: "text-start", id: "t1" }, { type: "text-delta", id: "t1", delta: step.text }, { type: "text-end", id: "t1" });
      }
      if (step.toolCall) {
        chunks.push({ type: "tool-call", toolCallId: id, toolName: step.toolCall.name, input: JSON.stringify(step.toolCall.input) });
      }
      chunks.push({
        ...finish,
        finishReason: { unified: step.toolCall ? ("tool-calls" as const) : ("stop" as const), raw: undefined },
      });
      return { stream: streamOf(chunks) as never };
    },
  });
}
