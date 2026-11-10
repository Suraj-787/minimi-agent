import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import type { Env } from "../lib/env";

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
>;

/** Provider and ids come from env only; env.ts already guarantees the matching key is present. */
export function getModels(e: ModelEnv): Models {
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
