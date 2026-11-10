import type { UIMessage } from "ai";

/**
 * Body of POST /api/chat. The server owns history, so only the newest user message travels, together with
 * the thread id useChat was created with: sending never mints a new thread (D56).
 */
export function buildChatBody(threadId: string, messages: readonly Pick<UIMessage, "parts">[], timezone: string) {
  const last = messages[messages.length - 1];
  const text = last?.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("") ?? "";
  return { threadId, message: { text }, timezone };
}
