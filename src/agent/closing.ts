import type { LanguageModelMiddleware } from "ai";
import type { VerifyStatus } from "../memory/verifyTable";
import { escapeText } from "../lib/escape";
import { allowedFor, type Allowed, type ResultText } from "./answerChecks";

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

const STATUS_WORDS: Record<VerifyStatus, string> = {
  unchanged: "Unchanged",
  differs: "Differs now (timing unknown)",
  changed: "Changed after <date>",
  outdated: "Already outdated when asked",
  unverified: "Couldn't verify",
};

function why(a: Allowed): string {
  if (a.kind === "none") return "no result names this vendor";
  if (a.kind === "dated") return "a dated source other than the vendor's pricing page is among the results, so follow the date labels";
  return a.earlierPage
    ? "the results are only the vendor's own pricing or product pages: a page's date is not a change date, but one dated before the claim date shows the earlier figure was already wrong"
    : "the results are only the vendor's own pricing or product pages, and a page's date is not a change date";
}

/**
 * One line per recalled item the tracker covers: which statuses its evidence allows (D77). Computed by code from the
 * results attributed to the item (D74), so a status the evidence cannot support is not on offer. App-authored text:
 * it goes OUTSIDE the untrusted <search_results> wrapper, and the entity (stored text) is escaped like any other.
 */
export function allowedStatusLines(items: ReadonlyArray<{ entity: string; said?: string }>, results: ReadonlyMap<number, ResultText>): string[] {
  return items.map((i) => {
    const a = allowedFor(i.entity, i.said, results.values());
    const list = a.statuses.map((s) => STATUS_WORDS[s]).join(", ");
    const only = a.kind === "none" ? " only (Then → Now shows —)" : "";
    return `Allowed statuses for ${escapeText(i.entity)}: ${list}${only}; ${why(a)}.`;
  });
}

/**
 * "Searches run: …" then every result block, then the allowed-status lines (verify mode), then the closing instruction. The result blocks come from `formatResults`,
 * which escapes titles, snippets and URLs and wraps them in the data wrapper, so a page that says "ignore previous
 * instructions" or tries to close the wrapper stays data. The queries are escaped here with the same helper.
 */
export function closingMessage(runs: readonly SearchRun[], allowed: readonly string[] = []): string {
  const queries = runs.flatMap((r) => r.queries);
  const listed = queries.slice(0, MAX_QUERIES_LISTED).map((q) => {
    const e = escapeText(q);
    return e.length <= QUERY_CLIP ? e : `${e.slice(0, QUERY_CLIP - 1)}…`;
  });
  const more = queries.length > MAX_QUERIES_LISTED ? ` (+${queries.length - MAX_QUERIES_LISTED} more)` : "";
  return [
    `Searches run: ${listed.length > 0 ? listed.join("; ") : "none"}${more}.`,
    ...runs.map((r) => r.formatted),
    ...allowed,
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
export function cleanPrompt(prompt: Prompt, runs: readonly SearchRun[], allowed: readonly string[] = []): Prompt {
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
  return withClosing(kept, runs, allowed);
}

/**
 * The closing retry's prompt: only the system prompt, the latest user message (which carries the dynamic block and
 * the question) and the plain-text results. No earlier conversation and no assistant or tool parts at all.
 */
export function freshPrompt(prompt: Prompt, runs: readonly SearchRun[], allowed: readonly string[] = []): Prompt {
  const system = prompt.find((m) => m.role === "system");
  const question = [...prompt].reverse().find((m) => m.role === "user");
  return withClosing([...(system ? [system] : []), ...(question ? [question] : [])], runs, allowed);
}

/** Appends the closing message to the last user message, or as a new user message when the last one is not a user's. */
function withClosing(messages: Message[], runs: readonly SearchRun[], allowed: readonly string[]): Prompt {
  const text = closingMessage(runs, allowed);
  const last = messages[messages.length - 1];
  if (last?.role === "user") return [...messages.slice(0, -1), { ...last, content: [...last.content, textPart(`\n\n${text}`)] }];
  return [...messages, { role: "user", content: [textPart(text)] }];
}
