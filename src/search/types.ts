import { z } from "zod";
import { isoDayFromMs } from "../lib/clock";

/** What the model asked for, narrowed to one query. Filters apply to every query in the call. */
export interface ProviderQuery {
  query: string;
  /** YYYY-MM-DD, published-after filter. */
  since?: string;
  domains?: string[];
  /** Bypass caches and ask the provider for live page contents (pricing pages!). */
  fresh?: boolean;
  /** News-like queries get provider news ranking where one exists, and a short cache TTL. */
  newsLike?: boolean;
}

/** A result as a provider returns it, before the per-turn number is assigned. Safe to cache. */
export const rawResultSchema = z.object({
  title: z.string(),
  url: z.string(),
  /** YYYY-MM-DD when the provider knows it. */
  publishedDate: z.string().optional(),
  snippet: z.string(),
});
export type RawResult = z.infer<typeof rawResultSchema>;

/** A result the model and the UI see. `n` is assigned in code, per turn (D19). */
export interface SearchResult extends RawResult {
  n: number;
}

export type ProviderName = "exa" | "tavily";

export interface SearchProvider {
  name: ProviderName;
  /** Rejects on HTTP errors, malformed responses and when `signal` aborts. */
  search(q: ProviderQuery, signal: AbortSignal): Promise<RawResult[]>;
}

/**
 * Deliberately carries only the provider name and HTTP status. Provider error bodies can echo the
 * request, and the request carries an API key, so they never reach logs or the model.
 */
export class SearchProviderError extends Error {
  constructor(
    readonly provider: ProviderName,
    readonly status?: number,
    reason = "request failed",
  ) {
    super(`${provider}: ${reason}${status ? ` (HTTP ${status})` : ""}`);
    this.name = "SearchProviderError";
  }
}

export const SNIPPET_MAX_CHARS = 1500;

export function clip(text: string, max = SNIPPET_MAX_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** Accepts ISO strings and RFC 2822 ("Tue, 11 Mar 2025 17:00:00 GMT"); returns YYYY-MM-DD or undefined. */
export function toDay(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(raw);
  if (iso) return iso[1];
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? undefined : isoDayFromMs(ms);
}
