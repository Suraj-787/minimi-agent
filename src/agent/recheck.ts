import { normalizeKeyPart } from "../memory/claimKey";
import type { SearchInput, SearchJob } from "../search/index";
import { sourceMentionsVendor } from "./answerChecks";
import type { WebSearchInput } from "./tools/webSearch";

/**
 * Verify-mode retrieval, owned by code (D37, D73). The prompt asks for one query per claim, but a model can skip one
 * (A4: Freshsales), never run the "anything shipped?" search, type a stale domain ("neon.tech") or pass `since` to a
 * price check, which makes the provider drop the undated pricing pages that state prices. So the tracker turns every
 * web_search call into explicit jobs:
 * - price pass: per item, the item's query restricted to that claim's own source host(s), paired with the same query
 *   unrestricted; no `since`; `fresh` on. The model's `domains` and `since` are ignored.
 * - news pass (only when the user asks what shipped): one dated, unrestricted query per item.
 * - targeted retry (once per item): when no returned result's URL or title names an item's vendor.
 * It also says which item a result belongs to, for its date label: the vendor the page names, else the job's item.
 */
export const MAX_QUERIES = 6;

export interface RecheckItem {
  entity: string;
  attribute: string;
  /** Local date the claim was said: the date evidence is compared with (D41). */
  said: string;
  /** Hosts of the claim's own sources ("neon.com"): the per-item domain filter (D73). */
  hosts?: string[];
}

export interface RecheckTracker {
  /**
   * The search that actually runs for a model's web_search call: code-built jobs. Records coverage immediately, so
   * a failed search is not retried forever.
   */
  apply(input: WebSearchInput): SearchInput;
  /**
   * After a call: one targeted retry for the items no returned result names (no `since`, the vendor's own host),
   * or undefined. Each item is retried at most once per turn.
   */
  retryFor(results: ReadonlyArray<{ url: string; title: string }>): SearchInput | undefined;
  /** App-authored note for the model after a search, or undefined when nothing is left to do. */
  note(): string | undefined;
  /** True while an item is unsearched or the news search is still owed. */
  needsSearch(): boolean;
  /**
   * The item a result is about, for its date label (D74): the item whose vendor the URL or title names (the job's
   * own item first when several are named), else the item of the job that found it, else one its query mentions.
   */
  itemForResult(r: { url: string; title: string; query: string; item?: string }): RecheckItem | undefined;
  state(): { items: number; uncovered: string[]; newsSince?: string; newsDone: boolean; retried: string[] };
}

/** "HubSpot Sales Hub" → "hubspot": the first word is what a query will mention. */
function matchToken(entity: string): string {
  return normalizeKeyPart(entity).split(" ")[0] ?? "";
}

function mentions(queries: readonly string[], token: string): boolean {
  return queries.some((q) => normalizeKeyPart(q).split(" ").includes(token));
}

type Item = RecheckItem & { token: string; hosts: string[] };

/** A job's item key: the entity as shown, so the trace and the reservation read in words. */
const itemKey = (i: Item): string => i.entity;

/** Does this page (URL or title, never the body) name the item's vendor? Aliases included (Freshsales → freshworks). */
const names = (i: Item, r: { url: string; title: string }): boolean => sourceMentionsVendor(i.entity, { url: r.url, title: r.title, snippet: "" });

export function createRecheckTracker(input: { items: readonly RecheckItem[]; newsSince?: string }): RecheckTracker {
  // One entry per entity: several claims about HubSpot are covered by any HubSpot query; their hosts are merged.
  const items: Item[] = [];
  for (const it of input.items) {
    const token = matchToken(it.entity);
    if (!token) continue;
    const prior = items.find((x) => x.token === token);
    if (prior) {
      for (const h of it.hosts ?? []) if (!prior.hosts.includes(h)) prior.hosts.push(h);
      continue;
    }
    items.push({ ...it, token, hosts: [...(it.hosts ?? [])] });
  }
  const covered = new Set<string>();
  const retried = new Set<string>();
  const newsSince = input.newsSince;
  let newsDone = newsSince === undefined;
  let lastWasNews = false;
  let pricePass: Item[] = [];

  const uncovered = () => items.filter((i) => !covered.has(i.token));
  const byEntity = (entity: string | undefined) => (entity ? items.find((i) => itemKey(i) === entity) : undefined);

  /** The model's query for this item if it wrote one, else "<entity> <attribute>". */
  const queryFor = (i: Item, modelQueries: readonly string[]): string =>
    modelQueries.find((q) => mentions([q], i.token)) ?? `${i.entity} ${i.attribute}`;

  const finish = (jobs: SearchJob[], extra: Partial<SearchInput> = {}): SearchInput => ({
    queries: [...new Set(jobs.map((j) => j.query))],
    jobs,
    ...extra,
  });

  return {
    apply(raw) {
      lastWasNews = false;
      if (uncovered().length > 0) {
        // Price pass: per item, its own host(s) AND an unrestricted twin; no since; fresh on (D73).
        const batch = uncovered().slice(0, MAX_QUERIES);
        pricePass = batch;
        const jobs: SearchJob[] = [];
        for (const i of batch) {
          const q = queryFor(i, raw.queries);
          if (i.hosts.length > 0) jobs.push({ query: q, domains: i.hosts, item: itemKey(i), label: `${q} (${i.hosts.join(", ")})` });
          jobs.push({ query: q, item: itemKey(i), label: i.hosts.length > 0 ? `${q} (any site)` : q });
          covered.add(i.token);
        }
        return finish(jobs, { fresh: true });
      }
      if (!newsDone && newsSince) {
        // The "shipped / any news" pass: dated, unrestricted, one query per item. The only pass with since.
        newsDone = true;
        lastWasNews = true;
        pricePass = [];
        const jobs = items.slice(0, MAX_QUERIES).map((i) => {
          const q = `${i.entity} news announcement`;
          return { query: q, since: newsSince, item: itemKey(i), label: `${q} (since ${newsSince})` };
        });
        return finish(jobs, raw.fresh ? { fresh: raw.fresh } : {});
      }
      // Nothing owed (code closes the next step); if the model still searches, keep it to plain queries.
      pricePass = [];
      return { queries: raw.queries, ...(raw.fresh ? { fresh: raw.fresh } : {}) };
    },
    retryFor(results) {
      const missing = pricePass.filter((i) => !retried.has(i.token) && !results.some((r) => names(i, r)));
      if (missing.length === 0) return undefined;
      const jobs: SearchJob[] = missing.map((i) => {
        retried.add(i.token);
        const q = `${i.entity} ${i.attribute}`;
        return i.hosts.length > 0
          ? { query: q, domains: i.hosts, item: itemKey(i), label: `${q} (retry: ${i.hosts.join(", ")})` }
          : { query: q, item: itemKey(i), label: `${q} (retry)` };
      });
      return finish(jobs, { fresh: true });
    },
    note() {
      const left = uncovered();
      const stop = "Don't search again for an item whose results didn't mention it; mark it Couldn't verify.";
      if (left.length > 0) {
        return `App note: not searched yet: ${left.map((i) => i.entity).join(", ")}. Search them in your next web_search call before answering. ${stop}`;
      }
      if (!newsDone && newsSince) {
        return `App note: next, search for launches, releases and pricing announcements since ${newsSince}: one query per item, with since and no domains. ${stop}`;
      }
      if (lastWasNews) {
        return `App note: these results were filtered to pages published on or after ${newsSince}. Only a dated announcement, changelog or news item here can show a change after that date. After the table, add "Shipped since ${newsSince}:" listing each launch with its date and [n], or "Nothing found dated after ${newsSince}." ${stop}`;
      }
      // Every item is searched (and the news pass, if owed, is done): searching is over, code closes the next step.
      return `App note: every item has been searched. ${stop} Write the answer now.`;
    },
    needsSearch: () => uncovered().length > 0 || !newsDone,
    itemForResult(r) {
      const own = byEntity(r.item);
      const named = items.filter((i) => names(i, r));
      const hit =
        (own && named.includes(own) ? own : undefined) ??
        named[0] ??
        own ??
        items.find((i) => mentions([r.query], i.token));
      return hit ? { entity: hit.entity, attribute: hit.attribute, said: hit.said, ...(hit.hosts.length ? { hosts: hit.hosts } : {}) } : undefined;
    },
    state: () => ({
      items: items.length,
      uncovered: uncovered().map((i) => i.entity),
      ...(newsSince ? { newsSince } : {}),
      newsDone,
      retried: items.filter((i) => retried.has(i.token)).map((i) => i.entity),
    }),
  };
}
