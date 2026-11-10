import type { Search } from "../../src/search/index";

/** A Search that must never be reached: proves "hi" and chit-chat don't search. */
export const noSearch: Search = {
  run: async () => {
    throw new Error("search should not be called");
  },
};
