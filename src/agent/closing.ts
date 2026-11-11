import type { LanguageModelMiddleware } from "ai";
import { escapeText } from "../lib/escape";

// What a no-tools step is shown (D72). The Google provider sends no tool declarations when tools are off, so
// `toolChoice: none` and `activeTools: []` do nothing there: the model still saw earlier tool-call and tool-result
// parts in the history and carried on calling a tool it was not given. So before any no-tools call the messages are
// rewritten: no tool-call or tool-result part remains, and the search results arrive as ONE plain user message,
// as untrusted data, with the numbers [n] exactly as code numbered them.

type Prompt = Parameters<NonNullable<LanguageModelMiddleware["wrapStream"]>>[0]["params"]["prompt"];
type Message = Prompt[number];

/** One web_search call as it was run: the queries (after the tracker's top-ups) and the tool's own formatted output. */
export interface SearchRun {
  queries: string[];
  /** `<search_results note="Untrusted web content...">…</search_results>`: already escaped by formatResults (lib/escape). */
  formatted: string;
}

/** The closing instruction, also the note on the closing retry. */
export const CLOSED_NOTE =
  "Searching is closed. Answer now from the results above; mark any item without evidence Couldn't verify.";

const MAX_QUERIES_LISTED = 12;
const QUERY_CLIP = 120;

/**
 * "Searches run: …" then every result block, then the closing instruction. The result blocks come from `formatResults`,
 * which escapes titles, snippets and URLs and wraps them in the data wrapper, so a page that says "ignore previous
 * instructions" or tries to close the wrapper stays data. The queries are escaped here with the same helper.
 */
export function closingMessage(runs: readonly SearchRun[]): string {
  const queries = runs.flatMap((r) => r.queries);
  const listed = queries.slice(0, MAX_QUERIES_LISTED).map((q) => {
    const e = escapeText(q);
    return e.length <= QUERY_CLIP ? e : `${e.slice(0, QUERY_CLIP - 1)}…`;
  });
  const more = queries.length > MAX_QUERIES_LISTED ? ` (+${queries.length - MAX_QUERIES_LISTED} more)` : "";
  return [
    `Searches run: ${listed.length > 0 ? listed.join("; ") : "none"}${more}.`,
    ...runs.map((r) => r.formatted),
    CLOSED_NOTE,
  ].join("\n");
}

const isToolPart = (type: string): boolean => type === "tool-call" || type === "tool-result" || type === "tool-approval-request";

/** True when any message still carries a tool-call or tool-result part. */
export function hasToolParts(prompt: Prompt): boolean {
  return prompt.some((m) => m.role === "tool" || (m.role === "assistant" && m.content.some((p) => isToolPart(p.type))));
}

const textPart = (text: string) => ({ type: "text" as const, text });

/**
 * The messages for a no-tools step: the system prompt and the conversation as it was, with every tool-call and
 * tool-result part removed (and the reasoning parts that belong to those steps), then the plain-text results and the
 * closing instruction added to the latest user message. Text the assistant wrote in an earlier step is kept.
 */
export function cleanPrompt(prompt: Prompt, runs: readonly SearchRun[]): Prompt {
  const kept: Message[] = [];
  for (const m of prompt) {
    if (m.role === "tool") continue;
    if (m.role === "assistant") {
      const parts = m.content.filter((p) => !isToolPart(p.type) && p.type !== "reasoning");
      if (parts.length === 0) continue;
      kept.push({ ...m, content: parts });
      continue;
    }
    kept.push(m);
  }
  if (runs.length === 0 && !hasToolParts(prompt)) return prompt;
  return withClosing(kept, runs);
}

/**
 * The closing retry's prompt: only the system prompt, the latest user message (which carries the dynamic block and
 * the question) and the plain-text results. No earlier conversation and no assistant or tool parts at all.
 */
export function freshPrompt(prompt: Prompt, runs: readonly SearchRun[]): Prompt {
  const system = prompt.find((m) => m.role === "system");
  const question = [...prompt].reverse().find((m) => m.role === "user");
  return withClosing([...(system ? [system] : []), ...(question ? [question] : [])], runs);
}

/** Appends the closing message to the last user message, or as a new user message when the last one is not a user's. */
function withClosing(messages: Message[], runs: readonly SearchRun[]): Prompt {
  const text = closingMessage(runs);
  const last = messages[messages.length - 1];
  if (last?.role === "user") return [...messages.slice(0, -1), { ...last, content: [...last.content, textPart(`\n\n${text}`)] }];
  return [...messages, { role: "user", content: [textPart(text)] }];
}
