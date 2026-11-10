import { createHash } from "node:crypto";
import type { LanguageModelMiddleware } from "ai";
import type { Db } from "../db/index";
import { log } from "./log";

// Dev-only response cache (SPEC §9), so re-running the same prompt costs no quota. It sits BELOW the
// retry middleware: an error never reaches this layer's store, and a retried call is a fresh miss.
//
// Guardrails (D46): only stored for a stream that finished cleanly (a `finish` part, no `error` part);
// a cancelled or failed stream stores nothing. Model and provider ids are part of the key, so switching
// models never serves another model's answer. model.ts refuses to install it under NODE_ENV=production.

type Part = { type: string; [k: string]: unknown };

/** Everything that changes what the model would say. Not the abort signal or headers (keys!). */
export function cacheKey(model: { provider: string; modelId: string }, params: Record<string, unknown>, kind: "stream" | "generate"): string {
  const { abortSignal: _a, headers: _h, ...rest } = params;
  return createHash("sha256")
    .update(JSON.stringify([kind, model.provider, model.modelId, rest]))
    .digest("hex");
}

// JSON turns Dates into strings; the SDK expects a Date back on response metadata.
function revive(part: Part): Part {
  return part.type === "response-metadata" && typeof part.timestamp === "string"
    ? { ...part, timestamp: new Date(part.timestamp) }
    : part;
}

export function llmCacheMiddleware(db: Db, now: () => Date): LanguageModelMiddleware {
  const read = (key: string): string | undefined =>
    (db.prepare("SELECT response_json FROM llm_cache WHERE key = ?").get(key) as { response_json: string } | undefined)
      ?.response_json;
  const write = (key: string, value: unknown): void => {
    try {
      db.prepare(
        `INSERT INTO llm_cache (key, response_json, created_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET response_json = excluded.response_json, created_at = excluded.created_at`,
      ).run(key, JSON.stringify(value), now().toISOString());
    } catch (err) {
      log.warn("llm cache write failed", { error: err instanceof Error ? err.name : typeof err });
    }
  };

  return {
    wrapGenerate: async ({ doGenerate, params, model }) => {
      const key = cacheKey(model, params as unknown as Record<string, unknown>, "generate");
      const hit = read(key);
      if (hit) return JSON.parse(hit) as Awaited<ReturnType<typeof doGenerate>>;
      const result = await doGenerate();
      if (result.finishReason.unified !== "error") {
        const { content, finishReason, usage, warnings, providerMetadata } = result;
        write(key, { content, finishReason, usage, warnings, providerMetadata });
      }
      return result;
    },

    wrapStream: async ({ doStream, params, model }) => {
      const key = cacheKey(model, params as unknown as Record<string, unknown>, "stream");
      const hit = read(key);
      if (hit) {
        const parts = (JSON.parse(hit) as Part[]).map(revive);
        return { stream: new ReadableStream({ start: (c) => (parts.forEach((p) => c.enqueue(p as never)), c.close()) }) } as Awaited<
          ReturnType<typeof doStream>
        >;
      }
      const result = await doStream();
      const seen: Part[] = [];
      let clean = true;
      const tap = new TransformStream<Part, Part>({
        transform(part, controller) {
          seen.push(part);
          if (part.type === "error") clean = false;
          if (part.type === "finish" && (part.finishReason as { unified?: string } | undefined)?.unified === "error") clean = false;
          controller.enqueue(part);
        },
        // flush runs only when the source ended normally: cancelled or aborted streams never get here.
        flush() {
          if (clean && seen.some((p) => p.type === "finish")) write(key, seen);
        },
      });
      return { ...result, stream: (result.stream as ReadableStream<Part>).pipeThrough(tap) as typeof result.stream };
    },
  };
}
