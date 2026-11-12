import type { LanguageModelMiddleware } from "ai";
import { classify, SlowResponseError, withRetry, type RetryOptions } from "../lib/retry";

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

/** No content from the model by now → abort and retry once (D76). A thinking step at the provider default took ~48 s, so not lower. */
export const FIRST_CHUNK_TIMEOUT_MS = 60_000;

export interface RetryMiddlewareOptions extends Pick<RetryOptions, "sleep" | "rand" | "max"> {
  onRetry?: RetryOptions["onRetry"];
  /** Tests pass a few milliseconds; 0 turns the limit off. */
  firstChunkTimeoutMs?: number;
}

export function retryMiddleware(o: RetryMiddlewareOptions = {}): LanguageModelMiddleware {
  const limitMs = o.firstChunkTimeoutMs ?? FIRST_CHUNK_TIMEOUT_MS;
  return {
    wrapGenerate: ({ doGenerate, params }) =>
      withRetry(async () => doGenerate(), { ...o, ...(params.abortSignal ? { signal: params.abortSignal } : {}) }),
    wrapStream: ({ model, params }) => {
      // A stall is retried once per call, then it is final: a model that is down should not cost 4 minutes.
      let stalls = 0;
      return withRetry(
        async () => {
          // Own abort signal per attempt, so a stalled request is really cancelled, not just ignored.
          const ctl = new AbortController();
          const signal = params.abortSignal ? AbortSignal.any([params.abortSignal, ctl.signal]) : ctl.signal;
          // A thrown HTTP error (the usual 429/503) retries here. An error chunk that arrives before any
          // content does too: read until the first real part and look at it.
          const attempt = (async () => {
            const result = await model.doStream({ ...params, abortSignal: signal });
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
          })();
          if (limitMs <= 0) return attempt;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const stalled = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              stalls++;
              // Reject first: the abort makes the abandoned attempt fail too, and the stall must be what the race reports.
              reject(new SlowResponseError(limitMs, stalls === 1));
              ctl.abort();
            }, limitMs);
          });
          try {
            return await Promise.race([attempt, stalled]);
          } catch (err) {
            // The abandoned attempt may still settle: swallow its rejection, close a stream it opens late.
            if (err instanceof SlowResponseError) void attempt.then((r) => r.stream.cancel(), () => undefined).catch(() => undefined);
            throw err;
          } finally {
            clearTimeout(timer);
          }
        },
        { ...o, ...(params.abortSignal ? { signal: params.abortSignal } : {}) },
      );
    },
  };
}
