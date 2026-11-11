import { normalizeKeyPart } from "../memory/claimKey";
import type { WebSearchInput } from "./tools/webSearch";

/**
 * Verify-mode coverage, enforced in code (D37). The prompt asks for one query per claim, but a model
 * can skip one (A4: Freshsales) or never run the "anything shipped?" search. The tracker sees every
 * web_search call of the turn, tops up queries for items no query mentions, rewrites the news call, and
 * tells runAgent whether another search step must be forced.
 */
export const MAX_QUERIES = 6;

export interface RecheckItem {
  entity: string;
  attribute: string;
  /** Local date the claim was said: the date evidence is compared with (D41). */
  said: string;
}

export interface RecheckTracker {
  /** The input that actually runs. Records coverage immediately, so a failed search is not retried forever. */
  apply(input: WebSearchInput): WebSearchInput;
  /** App-authored note for the model after a search, or undefined when nothing is left to do. */
  note(): string | undefined;
  /** True while an item is unsearched or the news search is still owed. */
  needsSearch(): boolean;
  /** The item a result was searched for: by the query that found it, else by the result's title. */
  itemFor(query: string, title: string): RecheckItem | undefined;
  state(): { items: number; uncovered: string[]; newsSince?: string; newsDone: boolean };
}

/** "HubSpot Sales Hub" → "hubspot": the first word is what a query will mention. */
function matchToken(entity: string): string {
  return normalizeKeyPart(entity).split(" ")[0] ?? "";
}

function mentions(queries: readonly string[], token: string): boolean {
  return queries.some((q) => normalizeKeyPart(q).split(" ").includes(token));
}

export function createRecheckTracker(input: { items: readonly RecheckItem[]; newsSince?: string }): RecheckTracker {
  // One entry per entity: several claims about HubSpot are covered by any HubSpot query.
  const items: (RecheckItem & { token: string })[] = [];
  for (const it of input.items) {
    const token = matchToken(it.entity);
    if (token && !items.some((x) => x.token === token)) items.push({ ...it, token });
  }
  const covered = new Set<string>();
  const newsSince = input.newsSince;
  let newsDone = newsSince === undefined;
  let lastWasNews = false;

  const uncovered = () => items.filter((i) => !covered.has(i.token));
  const topUp = (queries: string[], make: (i: RecheckItem) => string, pool: readonly (RecheckItem & { token: string })[]) => {
    const out = [...queries];
    for (const i of pool) {
      if (out.length >= MAX_QUERIES) break;
      if (!mentions(out, i.token)) out.push(make(i));
    }
    return out;
  };

  return {
    apply(raw) {
      lastWasNews = false;
      if (uncovered().length > 0) {
        // Coverage first: the model's queries, plus "<entity> <attribute>" for each item it left out.
        const queries = topUp(raw.queries, (i) => `${i.entity} ${i.attribute}`, uncovered());
        for (const i of items) if (mentions(queries, i.token)) covered.add(i.token);
        return { ...raw, queries };
      }
      if (!newsDone && newsSince) {
        // The "shipped / any news" pass: dated, unrestricted, one query per item.
        newsDone = true;
        lastWasNews = true;
        const queries = topUp(raw.queries, (i) => `${i.entity} news announcement`, items);
        return { queries, since: newsSince, ...(raw.fresh ? { fresh: raw.fresh } : {}) };
      }
      return raw;
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
    itemFor(query, title) {
      const hit = items.find((i) => mentions([query], i.token)) ?? items.find((i) => mentions([title], i.token));
      return hit ? { entity: hit.entity, attribute: hit.attribute, said: hit.said } : undefined;
    },
    state: () => ({
      items: items.length,
      uncovered: uncovered().map((i) => i.entity),
      ...(newsSince ? { newsSince } : {}),
      newsDone,
    }),
  };
}
