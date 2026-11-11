import type { LanguageModelMiddleware } from "ai";
import type { ThinkingLevel, ThinkingSetting } from "../lib/thinking";

// Thinking effort for the main model (D65): see lib/thinking.ts for the setting and why.

type CallParams = Parameters<NonNullable<LanguageModelMiddleware["wrapStream"]>>[0]["params"];
/** The SDK's own providerOptions type, so a merged value is accepted by the model call as is. */
export type ProviderOptions = NonNullable<CallParams["providerOptions"]>;

// Gemini 2.5 takes a token budget, not a level; "minimal" is as small as the model allows.
const BUDGET_FOR_LEVEL: Record<ThinkingLevel, number> = { minimal: 0, low: 1024, medium: 4096, high: 8192 };

/** The providerOptions for one call, or undefined to send nothing. */
export function thinkingOptions(provider: string, modelId: string, setting: ThinkingSetting): ProviderOptions | undefined {
  if (provider !== "google" || setting === "default") return undefined;
  const legacy25 = /gemini-2\.5/.test(modelId);
  if (typeof setting === "number") return { google: { thinkingConfig: { thinkingBudget: setting } } };
  if (legacy25) {
    // 2.5 Pro cannot switch thinking off; its floor is 128 tokens.
    const budget = /pro/.test(modelId) ? Math.max(128, BUDGET_FOR_LEVEL[setting]) : BUDGET_FOR_LEVEL[setting];
    return { google: { thinkingConfig: { thinkingBudget: budget } } };
  }
  return { google: { thinkingConfig: { thinkingLevel: setting } } };
}

export interface MainThinking {
  /** Steps that call tools: the first step and every forced one. */
  tool?: ProviderOptions;
  /** Later steps, which usually write the answer. */
  answer?: ProviderOptions;
}

export type StepKind = "tool" | "answer";

/** The first step and forced steps decide or run searches; any later step is taken to be the answer. */
export function stepKind(step: number, mode: "auto" | "force" | "none"): StepKind {
  return step === 0 || mode === "force" ? "tool" : "answer";
}

/** Adds the options for this step under providerOptions.google without dropping what the caller set. */
export function mergeProviderOptions(
  base: ProviderOptions | undefined,
  extra: ProviderOptions | undefined,
): ProviderOptions | undefined {
  if (!extra) return base;
  const out: ProviderOptions = { ...(base ?? {}) };
  for (const [k, v] of Object.entries(extra)) out[k] = { ...(out[k] ?? {}), ...v };
  return out;
}
