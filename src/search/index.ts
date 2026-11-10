import { createHash } from "node:crypto";
import { z } from "zod";
import type { Db } from "../db/index";
import { addMs } from "../lib/clock";
import type { Env } from "../lib/env";
import { errorFields, log } from "../lib/log";
import { createExa } from "./exa";
import { createTavily } from "./tavily";
import {
  rawResultSchema,
  type ProviderName,
  type ProviderQuery,
  type RawResult,
  type SearchProvider,
  type SearchResult,
} from "./types";

export const MAX_RESULTS_PER_CALL = 8;
const TTL_SHORT_MS = 60 * 60 * 1000;
const TTL_LONG_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 6000;

export interface SearchInput {
  queries: string[];
  since?: string;
  domains?: string[];
  fresh?: boolean;
}

/**
 * Citation numbers for ONE turn, shared by every web_search call in it (SPEC §5). Numbers belong to
 * the turn, never to a provider response or a cache row, so cached results are renumbered. A URL seen
 * earlier in the turn keeps its number, so the same page never appears under two citations.
 */
export interface TurnCounter {
  numberFor(url: string): { n: number; isNew: boolean };
}

export function createTurnCounter(): TurnCounter {
  const seen = new Map<string, number>();
  return {
    numberFor(url) {
      const key = normalizeUrl(url);
      const existing = seen.get(key);
      if (existing !== undefined) return { n: existing, isNew: false };
      const n = seen.size + 1;
      seen.set(key, n);
      return { n, isNew: true };
    },
  };
}

export interface SearchOutcome {
  results: Array<SearchResult & { isNew: boolean }>;
  /** Provider that answered each query (or "cache:<provider>"), for the trace. */
  sources: Array<{ query: string; provider: ProviderName; cached: boolean }>;
  /** Queries no provider could answer. */
  failed: string[];
  /** True only when every query failed: the model should say it could not search. */
  allFailed: boolean;
}

export interface Search {
  run(input: SearchInput, turn: TurnCounter, signal?: AbortSignal): Promise<SearchOutcome>;
}

// ---- pure helpers (exported for tests) -----------------------------------------------------

const TRACKING_PARAM = /^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$|ref$)/i;

/** Same page, different spelling → same string. Falls back to the trimmed input if it isn't a URL. */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hash = "";
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
    const kept = [...u.searchParams.entries()]
      .filter(([k]) => !TRACKING_PARAM.test(k))
      .sort(([a], [b]) => a.localeCompare(b));
    u.search = "";
    for (const [k, v] of kept) u.searchParams.append(k, v);
    const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : u.pathname;
    return `${u.protocol}//${u.host}${path}${u.search}`;
  } catch {
    return raw.trim();
  }
}

export function normalizeQuery(q: string): string {
  return q.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Provider + normalised query + filters (SPEC §5). `fresh` is not part of the key: it never reads the cache. */
export function cacheKey(provider: ProviderName, query: string, filters: { since?: string; domains?: string[] }): string {
  const domains = [...(filters.domains ?? [])].map((d) => d.toLowerCase().trim()).sort();
  const material = JSON.stringify([provider, normalizeQuery(query), filters.since ?? null, domains]);
  return createHash("sha256").update(material).digest("hex");
}

const NEWS_LIKE =
  /\b(latest|news|today|tonight|yesterday|this (week|month)|recent(ly)?|breaking|announce\w*|release[sd]?|current(ly)?|just)\b/i;

export function isNewsLike(query: string): boolean {
  return NEWS_LIKE.test(query);
}

/** 1 h for anything time-sensitive, 24 h otherwise (SPEC §5). */
export function ttlMs(q: { query: string; since?: string }): number {
  return q.since || isNewsLike(q.query) ? TTL_SHORT_MS : TTL_LONG_MS;
}

/**
 * Merges per-query result lists into at most `cap` unique results. Round-robin, so one chatty query
 * can't crowd the others out of the cap; first occurrence of a URL wins.
 */
export function mergeResults(lists: RawResult[][], cap = MAX_RESULTS_PER_CALL): RawResult[] {
  const out: RawResult[] = [];
  const seen = new Set<string>();
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest && out.length < cap; i++) {
    for (const list of lists) {
      const r = list[i];
      if (!r) continue;
      const key = normalizeUrl(r.url);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
      if (out.length >= cap) break;
    }
  }
  return out;
}

// ---- search --------------------------------------------------------------------------------

const cachedResults = z.array(rawResultSchema);

export interface SearchDeps {
  db: Db;
  /** In fallback order: Exa first, then Tavily. */
  providers: SearchProvider[];
  now: () => Date;
  /** Per provider attempt. */
  timeoutMs?: number;
}

export function createSearch(deps: SearchDeps): Search {
  const { db, providers, now } = deps;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const readCache = (key: string): RawResult[] | undefined => {
    const row = db
      .prepare("SELECT response_json FROM search_cache WHERE cache_key = ? AND expires_at > ?")
      .get(key, now().toISOString()) as { response_json: string } | undefined;
    if (!row) return undefined;
    try {
      const parsed = cachedResults.safeParse(JSON.parse(row.response_json));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined; // a corrupt row is just a miss
    }
  };

  const writeCache = (key: string, provider: ProviderName, results: RawResult[], ttl: number): void => {
    const at = now();
    db.prepare(
      `INSERT INTO search_cache (cache_key, provider, response_json, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(cache_key) DO UPDATE SET response_json = excluded.response_json,
         created_at = excluded.created_at, expires_at = excluded.expires_at`,
    ).run(key, provider, JSON.stringify(results), at.toISOString(), addMs(at, ttl).toISOString());
  };

  // One query: for each provider in order, try its cache, then the network. A provider that errors
  // or times out hands over to the next one.
  async function runQuery(
    q: ProviderQuery,
    outer?: AbortSignal,
  ): Promise<{ results: RawResult[]; provider: ProviderName; cached: boolean } | undefined> {
    const ttl = ttlMs(q);
    for (const provider of providers) {
      const key = cacheKey(provider.name, q.query, q);
      if (!q.fresh) {
        const hit = readCache(key);
        if (hit) return { results: hit, provider: provider.name, cached: true };
      }
      try {
        const signal = outer
          ? AbortSignal.any([outer, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs);
        const results = await provider.search(q, signal);
        // `fresh` results are still worth storing for non-fresh callers, but never read back for fresh ones.
        if (results.length > 0) writeCache(key, provider.name, results, ttl);
        return { results, provider: provider.name, cached: false };
      } catch (err) {
        if (outer?.aborted) throw err;
        log.warn("search provider failed", { provider: provider.name, ...errorFields(err) });
      }
    }
    return undefined;
  }

  return {
    async run(input, turn, signal) {
      const queries = [...new Set(input.queries.map((q) => q.trim()).filter(Boolean))];
      const settled = await Promise.all(
        queries.map((query) =>
          runQuery(
            {
              query,
              since: input.since,
              domains: input.domains,
              fresh: input.fresh,
              // `since` shortens the cache TTL (ttlMs) but must not force Tavily's news topic:
              // "CRM pricing changes since Monday" is not necessarily a news-site query.
              newsLike: isNewsLike(query),
            },
            signal,
          ),
        ),
      );

      const answered = settled.flatMap((s) => (s ? [s] : []));
      const failed = queries.filter((_, i) => !settled[i]);
      // Numbered only after merging, in a deterministic order, from THIS turn's counter.
      const results = mergeResults(answered.map((a) => a.results)).map((r) => ({
        ...r,
        ...turn.numberFor(r.url),
      }));
      return {
        results,
        sources: queries.flatMap((query, i) => {
          const s = settled[i];
          return s ? [{ query, provider: s.provider, cached: s.cached }] : [];
        }),
        failed,
        allFailed: queries.length > 0 && answered.length === 0,
      };
    },
  };
}

/** Exa first, Tavily as fallback; whichever keys are configured. */
export function createSearchFromEnv(e: Pick<Env, "EXA_API_KEY" | "TAVILY_API_KEY">, db: Db, now: () => Date): Search {
  const providers: SearchProvider[] = [];
  if (e.EXA_API_KEY) providers.push(createExa(e.EXA_API_KEY));
  if (e.TAVILY_API_KEY) providers.push(createTavily(e.TAVILY_API_KEY));
  return createSearch({ db, providers, now });
}
