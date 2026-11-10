import type { Search, SearchInput } from "../../src/search/index";

/** A Search that must never be reached: proves "hi" and chit-chat don't search. */
export const noSearch: Search = {
  run: async () => {
    throw new Error("search should not be called");
  },
};

export interface FixedResult {
  title: string;
  url: string;
  snippet: string;
  publishedDate?: string;
  /** Which query "found" it; defaults to the first query of the call. */
  query?: string;
}

/** Like the eval's `mockSearch`: every call returns these pages, numbered from the turn's counter. */
export function fixedSearch(pages: FixedResult[]): Search & { calls: SearchInput[] } {
  const calls: SearchInput[] = [];
  return {
    calls,
    run: async (input, turn) => {
      calls.push(input);
      return {
        results: pages.map((p) => ({ ...p, query: p.query ?? input.queries[0] ?? "", ...turn.numberFor(p.url) })),
        sources: input.queries.map((query) => ({ query, provider: "exa" as const, cached: false })),
        failed: [],
        allFailed: false,
      };
    },
  };
}
