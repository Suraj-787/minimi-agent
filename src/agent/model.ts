import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { wrapLanguageModel, type LanguageModel } from "ai";
import type { Db } from "../db/index";
import type { Env } from "../lib/env";
import { llmCacheMiddleware } from "../lib/llmCache";
import { log } from "../lib/log";

export interface Models {
  /** Chat + tool use. */
  main: LanguageModel;
  /** Background work: claim extraction, eval judge. */
  small: LanguageModel;
}

type ModelEnv = Pick<
  Env,
  | "LLM_PROVIDER"
  | "MAIN_MODEL"
  | "SMALL_MODEL"
  | "GOOGLE_GENERATIVE_AI_API_KEY"
  | "OPENAI_API_KEY"
  | "ANTHROPIC_API_KEY"
  | "DEV_LLM_CACHE"
>;

export interface ModelOptions {
  /**
   * Where the dev response cache would live. Only the server and the CLI pass it; the eval runner never
   * does, so evals always measure the real model (D46). The cache also needs DEV_LLM_CACHE=1.
   */
  cache?: { db: Db; now: () => Date };
  /** Injected for tests; defaults to process.env.NODE_ENV. */
  nodeEnv?: string | undefined;
}

/** Dev cache under the RETRY layer (agent/index.ts wraps retry on top): errors never reach it. */
function withDevCache(m: LanguageModel, opts: ModelOptions | undefined, enabled: boolean): LanguageModel {
  if (!enabled || !opts?.cache || typeof m === "string") return m;
  return wrapLanguageModel({ model: m, middleware: llmCacheMiddleware(opts.cache.db, opts.cache.now) });
}

/** Dev cache is on only with DEV_LLM_CACHE=1, a cache target, and never under NODE_ENV=production. */
export function devCacheActive(e: Pick<Env, "DEV_LLM_CACHE">, opts?: ModelOptions): boolean {
  const nodeEnv = opts && "nodeEnv" in opts ? opts.nodeEnv : process.env.NODE_ENV;
  return e.DEV_LLM_CACHE && !!opts?.cache && nodeEnv !== "production";
}

/** Provider and ids come from env only; env.ts already guarantees the matching key is present. */
export function getModels(e: ModelEnv, opts?: ModelOptions): Models {
  const nodeEnv = opts && "nodeEnv" in opts ? opts.nodeEnv : process.env.NODE_ENV;
  const on = devCacheActive(e, opts);
  if (e.DEV_LLM_CACHE && nodeEnv === "production") {
    log.warn("DEV_LLM_CACHE=1 is ignored because NODE_ENV=production");
  } else if (on) {
    // Loud on purpose: a cached answer is stale by definition and must never be mistaken for a live one.
    log.warn("!!! DEV_LLM_CACHE is ON: model responses are replayed from SQLite (llm_cache). Dev only; unset it to talk to the real model.");
  }
  const models = rawModels(e);
  return { main: withDevCache(models.main, opts, on), small: withDevCache(models.small, opts, on) };
}

function rawModels(e: ModelEnv): Models {
  switch (e.LLM_PROVIDER) {
    case "google": {
      const p = createGoogleGenerativeAI({ apiKey: e.GOOGLE_GENERATIVE_AI_API_KEY });
      return { main: p(e.MAIN_MODEL), small: p(e.SMALL_MODEL) };
    }
    case "openai": {
      const p = createOpenAI({ apiKey: e.OPENAI_API_KEY });
      return { main: p(e.MAIN_MODEL), small: p(e.SMALL_MODEL) };
    }
    case "anthropic": {
      const p = createAnthropic({ apiKey: e.ANTHROPIC_API_KEY });
      return { main: p(e.MAIN_MODEL), small: p(e.SMALL_MODEL) };
    }
  }
}
