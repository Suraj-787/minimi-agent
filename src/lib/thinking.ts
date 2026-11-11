// Thinking effort for the main model (D65). Gemini "thinks" before answering, and on a verify turn that
// ran 38-78 s before the first token. Searching needs little reasoning, so tool-calling steps default to
// low; the step that writes the answer keeps the provider default unless MAIN_THINKING_ANSWER says otherwise.
// Only the Google provider has this knob here: other providers ignore it.

export const THINKING_LEVELS = ["minimal", "low", "medium", "high"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** "default" = send nothing and let the provider decide. A number is a token budget (Gemini 2.5). */
export type ThinkingSetting = "default" | ThinkingLevel | number;

/** Parses env text: default | minimal | low | medium | high | a non-negative integer. undefined if invalid. */
export function parseThinking(raw: string): ThinkingSetting | undefined {
  const v = raw.trim().toLowerCase();
  if (v === "default") return "default";
  if ((THINKING_LEVELS as readonly string[]).includes(v)) return v as ThinkingLevel;
  return /^\d{1,6}$/.test(v) ? Number(v) : undefined;
}
