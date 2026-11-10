import type { LanguageModelMiddleware } from "ai";
import { classify, withRetry, type RetryOptions } from "../lib/retry";

// Retry lives in the model layer (not around runAgent) so it re-runs ONE model call: a 503 on the answer
// step after three searches repeats that step only, never the web_search calls before it (D45).

// Parts a provider sends before any content. An error after real content is NOT retried: the user may
// already have seen text, and replaying it would duplicate or contradict it.
const PREAMBLE = new Set(["stream-start", "response-metadata", "raw"]);

type StreamResult = Awaited<ReturnType<NonNullable<LanguageModelMiddleware["wrapStream"]>>>;
type Part = StreamResult["stream"] extends ReadableStream<infer P> ? P : never;

/** The buffered preamble first, then the rest of the live reader. */
function replay(head: Part[], reader: ReadableStreamDefaultReader<Part>): ReadableStream<Part> {
  let i = 0;
  return new ReadableStream<Part>({
    async pull(controller) {
      if (i < head.length) return controller.enqueue(head[i++] as Part);
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
}

export interface RetryMiddlewareOptions extends Pick<RetryOptions, "sleep" | "rand" | "max"> {
  onRetry?: RetryOptions["onRetry"];
}

export function retryMiddleware(o: RetryMiddlewareOptions = {}): LanguageModelMiddleware {
  return {
    wrapGenerate: ({ doGenerate, params }) =>
      withRetry(async () => doGenerate(), { ...o, ...(params.abortSignal ? { signal: params.abortSignal } : {}) }),
    wrapStream: ({ doStream, params }) =>
      withRetry(
        async () => {
          // A thrown HTTP error (the usual 429/503) retries here. An error chunk that arrives before any
          // content does too: read until the first real part and look at it.
          const result = await doStream();
          const reader = result.stream.getReader();
          const head: Part[] = [];
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            head.push(value);
            if (PREAMBLE.has(value.type)) continue;
            if (value.type === "error" && classify(value.error).kind === "retry") {
              void reader.cancel().catch(() => undefined);
              throw value.error;
            }
            break;
          }
          return { ...result, stream: replay(head, reader) };
        },
        { ...o, ...(params.abortSignal ? { signal: params.abortSignal } : {}) },
      ),
  };
}
