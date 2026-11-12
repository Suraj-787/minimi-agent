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
/** Results reserved for each re-checked item before the cap applies (D74). */
export const RESERVE_PER_ITEM = 2;
/**
 * The cap when items reserve results: 2 per item, at least the usual 8, never more than 12 (6 items x 2). Twelve
 * snippets of up to ~1,500 characters is about 4-5k tokens per call, the ceiling for a verify-mode search (D74).
 */
export const MAX_RESULTS_RESERVED = 12;
const TTL_SHORT_MS = 60 * 60 * 1000;
const TTL_LONG_MS = 24 * 60 * 60 * 1000;
/** A `fresh` query is re-read from the network, except within this window: re-sending after a failed turn must not redo every live crawl (D47). */
const TTL_FRESH_MS = 2 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 6000;
/** `fresh` makes Exa live-crawl pages, which routinely takes longer than 6 s (D40). */
const DEFAULT_FRESH_TIMEOUT_MS = 15_000;

export interface SearchInput {
  queries: string[];
  since?: string;
  domains?: string[];
  fresh?: boolean;
  /**
   * Code-built jobs (verify mode, D73). When present they replace the plan made from queries/domains/since: each
   * job carries its own filters and the re-checked item it is for, and every item reserves results before the cap.
   */
  jobs?: SearchJob[];
  /** Lower cap for this call (the targeted retry: 2 per missing item), never above the usual cap. */
  maxResults?: number;
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

/** Why a result the provider returned did or did not reach the model (D74). */
export type ResultFate = "kept" | "duplicate" | "cap";

/** One job as the trace keeps it: what was asked, with which filters, and the fate of every result it got. */
export interface JobReport {
  query: string;
  /** The re-checked item the job was for, when code built it. */
  item?: string;
  domains?: string[];
  since?: string;
  provider?: ProviderName;
  cached?: boolean;
  failedProviders?: ProviderName[];
  /** No provider could answer. */
  failed?: boolean;
  /** Answered, but with nothing: "filter" when the job had a domain or date filter, "none" when it had none. */
  empty?: "filter" | "none";
  results: Array<{ url: string; title: string; publishedDate?: string; fate: ResultFate; n?: number; duplicateOf?: number }>;
}

export interface SearchOutcome {
  /**
   * `query`: the query that first found the result, so verify mode can date it against that item's claim (D41).
   * `item`: the re-checked item of the job that found it, when code built the job (D74).
   */
  results: Array<SearchResult & { isNew: boolean; query: string; item?: string }>;
  /** Provider that answered each query (or "cache:<provider>"), for the trace. */
  sources: Array<{ query: string; provider: ProviderName; cached: boolean; failedProviders?: ProviderName[] }>;
  /** Queries no provider could answer. */
  failed: string[];
  /** True only when every query failed: the model should say it could not search. */
  allFailed: boolean;
  /** Per job: filters, provider, and what happened to each result (kept, duplicate, over the cap). */
  jobs?: JobReport[];
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
export function mergeResults<T extends RawResult>(lists: T[][], cap = MAX_RESULTS_PER_CALL): T[] {
  return mergeWithFates(lists.map((results) => ({ results })), { cap }).kept.map((k) => k.result);
}

/**
 * Merges per-job lists into at most `cap` unique results and says what happened to each input result. With groups
 * (the re-checked item of each list), every group first gets up to `reserve` results, round-robin over its own lists,
 * so one item with many hits cannot crowd another out of the cap (D74); the rest of the cap is then filled
 * round-robin over all lists. First occurrence of a URL wins either way.
 */
export function mergeWithFates<T extends RawResult>(
  lists: Array<{ group?: string; results: T[] }>,
  opts: { cap: number; reserve?: number },
): { kept: Array<{ result: T; list: number }>; fates: Array<Array<{ fate: ResultFate; keptIndex?: number; duplicateOf?: number }>> } {
  const kept: Array<{ result: T; list: number }> = [];
  const seen = new Map<string, number>();
  const fates = lists.map((l) => l.results.map(() => ({ fate: "cap" as ResultFate }) as { fate: ResultFate; keptIndex?: number; duplicateOf?: number }));
  const taken = lists.map(() => 0); // how far each list has been read
  const take = (li: number): boolean => {
    const list = lists[li]!.results;
    while (taken[li]! < list.length) {
      const i = taken[li]!;
      taken[li] = i + 1;
      const r = list[i]!;
      const key = normalizeUrl(r.url);
      const prior = seen.get(key);
      if (prior !== undefined) {
        fates[li]![i] = { fate: "duplicate", duplicateOf: prior };
        continue;
      }
      seen.set(key, kept.length);
      fates[li]![i] = { fate: "kept", keptIndex: kept.length };
      kept.push({ result: r, list: li });
      return true;
    }
    return false;
  };

  const reserve = opts.reserve ?? 0;
  if (reserve > 0) {
    const groups = [...new Set(lists.flatMap((l) => (l.group ? [l.group] : [])))];
    for (const g of groups) {
      const mine = lists.flatMap((l, i) => (l.group === g ? [i] : []));
      let got = 0;
      let progress = true;
      while (got < reserve && kept.length < opts.cap && progress) {
        progress = false;
        for (const li of mine) {
          if (got >= reserve || kept.length >= opts.cap) break;
          if (take(li)) {
            got++;
            progress = true;
          }
        }
      }
    }
  }
  let progress = true;
  while (kept.length < opts.cap && progress) {
    progress = false;
    for (let li = 0; li < lists.length && kept.length < opts.cap; li++) if (take(li)) progress = true;
  }
  // Anything still unread is past the cap; duplicates among it are still duplicates.
  for (let li = 0; li < lists.length; li++) {
    const list = lists[li]!.results;
    for (let i = taken[li]!; i < list.length; i++) {
      const prior = seen.get(normalizeUrl(list[i]!.url));
      if (prior !== undefined) fates[li]![i] = { fate: "duplicate", duplicateOf: prior };
    }
  }
  return { kept, fates };
}

export interface SearchJob {
  query: string;
  domains?: string[];
  /** Published-after filter for this job only (the news pass); price-pass jobs have none (D73). */
  since?: string;
  /** The re-checked item this job is for: it reserves results before the cap, and dates results it finds. */
  item?: string;
  /** How the job appears in the trace and in "no results for" notes. */
  label: string;
}

/** Suffix on the label of the extra query that runs without the domain filter. */
export const UNRESTRICTED_LABEL = " (any site)";

/**
 * One job per unique query. With `domains`, the first query also runs once with no domain filter
 * (D33): a domain list (often taken from a recalled claim's source) is a hint, and a pricing change
 * or a launch is often reported first somewhere else.
 */
export function planJobs(input: SearchInput): SearchJob[] {
  if (input.jobs && input.jobs.length > 0) {
    // Code-built (verify mode): taken as they are, one per distinct label.
    const seen = new Set<string>();
    return input.jobs.filter((j) => (seen.has(j.label) ? false : (seen.add(j.label), true)));
  }
  const queries = [...new Set(input.queries.map((q) => q.trim()).filter(Boolean))];
  const domains = input.domains && input.domains.length > 0 ? input.domains : undefined;
  const jobs: SearchJob[] = queries.map((query) => ({ query, ...(domains ? { domains } : {}), label: query }));
  const first = queries[0];
  if (domains && first) jobs.push({ query: first, label: `${first}${UNRESTRICTED_LABEL}` });
  return jobs;
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
  /** Per provider attempt when the query is `fresh` (live crawl). */
  freshTimeoutMs?: number;
}

export function createSearch(deps: SearchDeps): Search {
  const { db, providers, now } = deps;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const freshTimeoutMs = deps.freshTimeoutMs ?? DEFAULT_FRESH_TIMEOUT_MS;

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
  ): Promise<{ results: RawResult[]; provider: ProviderName; cached: boolean; failedProviders: ProviderName[] } | undefined> {
    const ttl = ttlMs(q);
    const failedProviders: ProviderName[] = [];
    for (const provider of providers) {
      const key = cacheKey(provider.name, q.query, q);
      // Fresh queries use their own short-lived key, so they never read the 1 h / 24 h entries.
      const freshKey = `fresh:${key}`;
      const hit = readCache(q.fresh ? freshKey : key);
      if (hit) return { results: hit, provider: provider.name, cached: true, failedProviders };
      try {
        const limit = q.fresh ? freshTimeoutMs : timeoutMs;
        const signal = outer ? AbortSignal.any([outer, AbortSignal.timeout(limit)]) : AbortSignal.timeout(limit);
        const results = await provider.search(q, signal);
        // `fresh` results are still worth storing for non-fresh callers, but never read back for fresh ones.
        if (results.length > 0) {
          writeCache(key, provider.name, results, ttl);
          if (q.fresh) writeCache(freshKey, provider.name, results, TTL_FRESH_MS);
        }
        return { results, provider: provider.name, cached: false, failedProviders };
      } catch (err) {
        if (outer?.aborted) throw err;
        failedProviders.push(provider.name);
        log.warn("search provider failed", { provider: provider.name, ...errorFields(err) });
      }
    }
    return undefined;
  }

  return {
    async run(input, turn, signal) {
      const jobs = planJobs(input);
      const settled = await Promise.all(
        jobs.map((job) => {
          const since = input.jobs ? job.since : input.since;
          return runQuery(
            {
              query: job.query,
              since,
              domains: job.domains,
              fresh: input.fresh,
              // `since` shortens the cache TTL (ttlMs) but must not force Tavily's news topic:
              // "CRM pricing changes since Monday" is not necessarily a news-site query.
              newsLike: isNewsLike(job.query),
            },
            signal,
          );
        }),
      );

      const lists = jobs.map((job, i) => ({
        ...(job.item ? { group: job.item } : {}),
        results: (settled[i]?.results ?? []).map((r) => ({ ...r, query: job.query, ...(job.item ? { item: job.item } : {}) })),
      }));
      const grouped = lists.some((l) => l.group);
      const groups = new Set(lists.flatMap((l) => (l.group ? [l.group] : []))).size;
      const usual = grouped ? Math.min(MAX_RESULTS_RESERVED, Math.max(MAX_RESULTS_PER_CALL, RESERVE_PER_ITEM * groups)) : MAX_RESULTS_PER_CALL;
      const cap = input.maxResults !== undefined ? Math.max(0, Math.min(usual, input.maxResults)) : usual;
      const merged = mergeWithFates(lists, { cap, ...(grouped ? { reserve: RESERVE_PER_ITEM } : {}) });
      // Numbered only after merging, in a deterministic order, from THIS turn's counter.
      const results = merged.kept.map(({ result }) => ({ ...result, ...turn.numberFor(result.url) }));
      const failed = jobs.filter((_, i) => !settled[i]).map((j) => j.label);
      const reports: JobReport[] = jobs.map((job, i) => {
        const s = settled[i];
        const since = input.jobs ? job.since : input.since;
        const filtered = (job.domains?.length ?? 0) > 0 || !!since;
        return {
          query: job.label,
          ...(job.item ? { item: job.item } : {}),
          ...(job.domains?.length ? { domains: job.domains } : {}),
          ...(since ? { since } : {}),
          ...(s ? { provider: s.provider, cached: s.cached, ...(s.failedProviders.length ? { failedProviders: s.failedProviders } : {}) } : { failed: true }),
          ...(s && s.results.length === 0 ? { empty: filtered ? ("filter" as const) : ("none" as const) } : {}),
          results: (lists[i]?.results ?? []).map((r, ri) => {
            const f = merged.fates[i]![ri]!;
            const n = f.keptIndex !== undefined ? results[f.keptIndex]?.n : undefined;
            const dup = f.duplicateOf !== undefined ? results[f.duplicateOf]?.n : undefined;
            return {
              url: r.url,
              title: r.title,
              ...(r.publishedDate ? { publishedDate: r.publishedDate } : {}),
              fate: f.fate,
              ...(n !== undefined ? { n } : {}),
              ...(dup !== undefined ? { duplicateOf: dup } : {}),
            };
          }),
        };
      });
      return {
        results,
        sources: jobs.flatMap((job, i) => {
          const s = settled[i];
          return s
            ? [{ query: job.label, provider: s.provider, cached: s.cached, ...(s.failedProviders.length ? { failedProviders: s.failedProviders } : {}) }]
            : [];
        }),
        failed,
        allFailed: jobs.length > 0 && settled.every((s) => !s),
        jobs: reports,
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
