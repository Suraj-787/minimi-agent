import type { MessageRow } from "../db/repo";

export interface HistoryMessage {
  role: "user" | "assistant";
  text: string;
}

export const HISTORY_MAX_MESSAGES = 12;
export const HISTORY_MAX_CHARS = 6000;

/**
 * Rule R0: the tail of the current thread, bounded in messages and characters.
 *
 * Invariants the model API relies on:
 *  - the last message is the current user message and is always kept, even when it alone exceeds the cap;
 *  - the first message is a user message (Gemini rejects history that opens with a model turn);
 *  - roles alternate: failed assistant rows are dropped and the user turns around them are merged.
 *
 * Pure so the trimming rules can be tested without a database.
 */
export function trimHistory(
  rows: readonly Pick<MessageRow, "role" | "text" | "status">[],
  maxMessages = HISTORY_MAX_MESSAGES,
  maxChars = HISTORY_MAX_CHARS,
): HistoryMessage[] {
  // An error row holds our own apology text, not something the model said; keep it out of the prompt.
  const usable = rows.filter((r) => !(r.role === "assistant" && r.status === "error"));

  const kept: HistoryMessage[] = [];
  let chars = 0;
  for (let i = usable.length - 1; i >= 0 && kept.length < maxMessages; i--) {
    const r = usable[i];
    if (!r) break;
    const isLast = i === usable.length - 1;
    if (!isLast && chars + r.text.length > maxChars) break;
    chars += r.text.length;
    kept.unshift({ role: r.role, text: r.text });
  }

  // The cut can land on an assistant message. Drop it rather than start the history with a model turn.
  while (kept[0]?.role === "assistant") kept.shift();

  return mergeConsecutive(kept);
}

// Dropping an error row can leave two user messages in a row; one combined turn is the safest shape.
function mergeConsecutive(messages: HistoryMessage[]): HistoryMessage[] {
  const out: HistoryMessage[] = [];
  for (const m of messages) {
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) prev.text = `${prev.text}\n\n${m.text}`;
    else out.push({ ...m });
  }
  return out;
}
