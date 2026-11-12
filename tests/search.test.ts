import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db/index";
import {
  cacheKey,
  createSearch,
  createTurnCounter,
  isNewsLike,
  mergeResults,
  normalizeUrl,
  ttlMs,
} from "../src/search/index";
import {
  SearchProviderError,
  type ProviderName,
  type ProviderQuery,
  type RawResult,
  type SearchProvider,
} from "../src/search/types";

const r = (url: string, title = url): RawResult => ({ title, url, snippet: `about ${title}` });

function provider(name: ProviderName, impl: (q: ProviderQuery, s: AbortSignal) => Promise<RawResult[]>) {
  const calls: ProviderQuery[] = [];
  const p: SearchProvider & { calls: ProviderQuery[] } = {
    name,
    calls,
    search: (q, s) => {
      calls.push(q);
      return impl(q, s);
    },
  };
  return p;
}
const returns = (results: RawResult[]) => async () => results;
const fails = (status = 500) => async (): Promise<RawResult[]> => {
  throw new SearchProviderError("exa", status);
};

let db: Db;
let clock: Date;
beforeEach(() => {
  db = openDb(":memory:");
  clock = new Date("2026-11-12T05:30:00Z");
});
const make = (providers: SearchProvider[], timeoutMs = 50) =>
  createSearch({ db, providers, now: () => clock, timeoutMs });

describe("helpers", () => {
  it("normalizeUrl ignores case, www, hash, trailing slash, tracking params and param order", () => {
    const a = normalizeUrl("https://WWW.Example.com/a/b/?utm_source=x&b=2&a=1#top");
    expect(a).toBe(normalizeUrl("https://example.com/a/b?a=1&b=2"));
    expect(normalizeUrl("https://example.com/a")).not.toBe(normalizeUrl("https://example.com/b"));
    expect(normalizeUrl("not a url ")).toBe("not a url");
  });

  it("cacheKey is stable under case, spacing and domain order, and differs by provider and filters", () => {
    const k = cacheKey("exa", "Neon  Pricing", { domains: ["B.com", "a.com"] });
    expect(cacheKey("exa", " neon pricing ", { domains: ["a.com", "b.com"] })).toBe(k);
    expect(cacheKey("tavily", "neon pricing", { domains: ["a.com", "b.com"] })).not.toBe(k);
    expect(cacheKey("exa", "neon pricing", { domains: ["a.com", "b.com"], since: "2026-11-09" })).not.toBe(k);
  });

  it("ttl is 1h for since / news-like queries and 24h otherwise", () => {
    expect(isNewsLike("latest node release")).toBe(true);
    expect(ttlMs({ query: "what is a b-tree" })).toBe(24 * 3600_000);
    expect(ttlMs({ query: "latest node release" })).toBe(3600_000);
    expect(ttlMs({ query: "hubspot pricing", since: "2026-11-09" })).toBe(3600_000);
  });

  it("mergeResults dedupes across queries, interleaves, and caps at 8", () => {
    const a = [r("https://x.com/1"), r("https://x.com/2"), r("https://x.com/3"), r("https://x.com/4"), r("https://x.com/5")];
    const b = [r("https://www.x.com/1/"), r("https://y.com/1"), r("https://y.com/2"), r("https://y.com/3"), r("https://y.com/4")];
    const out = mergeResults([a, b]);
    expect(out).toHaveLength(8);
    expect(new Set(out.map((o) => normalizeUrl(o.url))).size).toBe(8);
    // round-robin: the first query does not use up the whole cap
    expect(out.some((o) => o.url.includes("y.com"))).toBe(true);
  });
});

describe("numbering", () => {
  it("continues across calls in one turn, and a repeated URL keeps its number", async () => {
    const exa = provider("exa", async (q) =>
      q.query === "one" ? [r("https://a.com/1"), r("https://a.com/2")] : [r("https://a.com/2"), r("https://a.com/3")],
    );
    const search = make([exa]);
    const turn = createTurnCounter();
    const first = await search.run({ queries: ["one"] }, turn);
    const second = await search.run({ queries: ["two"] }, turn);
    expect(first.results.map((x) => x.n)).toEqual([1, 2]);
    expect(second.results.map((x) => [x.url, x.n, x.isNew])).toEqual([
      ["https://a.com/2", 2, false],
      ["https://a.com/3", 3, true],
    ]);
  });

  it("renumbers cached results from the CURRENT turn's counter", async () => {
    const exa = provider("exa", returns([r("https://a.com/1"), r("https://a.com/2")]));
    const search = make([exa]);
    // Turn 1 stores the results as 1 and 2.
    const t1 = await search.run({ queries: ["node release"] }, createTurnCounter());
    expect(t1.results.map((x) => x.n)).toEqual([1, 2]);
    // Turn 2 already cited another page as [1], then hits the cache for the same query.
    const t2 = createTurnCounter();
    t2.numberFor("https://other.com/page");
    const cached = await search.run({ queries: ["Node  release"] }, t2);
    expect(exa.calls).toHaveLength(1); // second call came from SQLite
    expect(cached.sources[0]?.cached).toBe(true);
    expect(cached.results.map((x) => [x.url, x.n])).toEqual([
      ["https://a.com/1", 2],
      ["https://a.com/2", 3],
    ]);
    // and the cache row itself holds no numbers
    const row = db.prepare("SELECT response_json FROM search_cache").get() as { response_json: string };
    expect(row.response_json).not.toContain('"n"');
  });
});

describe("cache", () => {
  it("expires after the TTL", async () => {
    const exa = provider("exa", returns([r("https://a.com/1")]));
    const search = make([exa]);
    await search.run({ queries: ["what is a b-tree"] }, createTurnCounter());
    clock = new Date(clock.getTime() + 23 * 3600_000);
    await search.run({ queries: ["what is a b-tree"] }, createTurnCounter());
    expect(exa.calls).toHaveLength(1);
    clock = new Date(clock.getTime() + 2 * 3600_000);
    await search.run({ queries: ["what is a b-tree"] }, createTurnCounter());
    expect(exa.calls).toHaveLength(2);
  });

  it("fresh bypasses the cache and passes fresh to the provider", async () => {
    const exa = provider("exa", returns([r("https://a.com/1")]));
    const search = make([exa]);
    await search.run({ queries: ["neon pricing"] }, createTurnCounter());
    await search.run({ queries: ["neon pricing"], fresh: true }, createTurnCounter());
    expect(exa.calls.map((c) => c.fresh)).toEqual([undefined, true]);
  });

  it("fresh results are reused for ~2 minutes (a re-send after a failed turn), then re-fetched (D47)", async () => {
    const exa = provider("exa", returns([r("https://a.com/1")]));
    const search = make([exa]);
    await search.run({ queries: ["neon pricing"], fresh: true }, createTurnCounter());
    clock = new Date(clock.getTime() + 90_000);
    const again = await search.run({ queries: ["neon pricing"], fresh: true }, createTurnCounter());
    expect(exa.calls).toHaveLength(1);
    expect(again.sources[0]?.cached).toBe(true);
    clock = new Date(clock.getTime() + 60_000); // 2.5 min after the first call
    await search.run({ queries: ["neon pricing"], fresh: true }, createTurnCounter());
    expect(exa.calls).toHaveLength(2);
  });

  it("a fresh query never reads the long-lived entry a non-fresh query wrote", async () => {
    const exa = provider("exa", returns([r("https://a.com/1")]));
    const search = make([exa]);
    await search.run({ queries: ["neon pricing"] }, createTurnCounter());
    await search.run({ queries: ["neon pricing"], fresh: true }, createTurnCounter());
    expect(exa.calls).toHaveLength(2);
  });

  it("records which providers failed first, so the trace shows the fallback", async () => {
    const exa = provider("exa", fails());
    const tavily = provider("tavily", returns([r("https://a.com/1")]));
    const out = await make([exa, tavily]).run({ queries: ["q"] }, createTurnCounter());
    expect(out.sources).toEqual([{ query: "q", provider: "tavily", cached: false, failedProviders: ["exa"] }]);
  });

  it("does not cache empty results", async () => {
    const exa = provider("exa", returns([]));
    const search = make([exa]);
    await search.run({ queries: ["zzzz"] }, createTurnCounter());
    await search.run({ queries: ["zzzz"] }, createTurnCounter());
    expect(exa.calls).toHaveLength(2);
  });
});

describe("fallback", () => {
  it("falls back to Tavily when Exa errors", async () => {
    const exa = provider("exa", fails(500));
    const tavily = provider("tavily", returns([r("https://t.com/1")]));
    const out = await make([exa, tavily]).run({ queries: ["q"] }, createTurnCounter());
    expect(out.results.map((x) => x.url)).toEqual(["https://t.com/1"]);
    expect(out.sources).toEqual([{ query: "q", provider: "tavily", cached: false, failedProviders: ["exa"] }]);
    expect(out.allFailed).toBe(false);
  });

  it("falls back when Exa times out", async () => {
    const exa = provider(
      "exa",
      (_q, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
    );
    const tavily = provider("tavily", returns([r("https://t.com/1")]));
    const out = await make([exa, tavily], 20).run({ queries: ["q"] }, createTurnCounter());
    expect(out.sources[0]?.provider).toBe("tavily");
  });

  it("reports failure instead of throwing when every provider fails", async () => {
    const out = await make([provider("exa", fails()), provider("tavily", fails(429))]).run(
      { queries: ["a", "b"] },
      createTurnCounter(),
    );
    expect(out).toMatchObject({ results: [], failed: ["a", "b"], allFailed: true });
  });

  it("one failed query does not sink the others", async () => {
    const exa = provider("exa", async (q) => {
      if (q.query === "bad") throw new SearchProviderError("exa", 500);
      return [r("https://a.com/1")];
    });
    const out = await make([exa]).run({ queries: ["good", "bad"] }, createTurnCounter());
    expect(out.failed).toEqual(["bad"]);
    expect(out.allFailed).toBe(false);
    expect(out.results).toHaveLength(1);
  });

  it("runs queries in parallel", async () => {
    let inFlight = 0;
    let peak = 0;
    const exa = provider("exa", async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((res) => setTimeout(res, 10));
      inFlight--;
      return [];
    });
    await make([exa]).run({ queries: ["a", "b", "c"] }, createTurnCounter());
    expect(peak).toBe(3);
  });
});

describe("domain hint pairing (D33)", () => {
  it("with domains, every query is restricted and the first also runs once on any site", async () => {
    const exa = provider("exa", async (q) => [r(q.domains ? `https://neon.com/${q.query}` : `https://news.test/${q.query}`)]);
    const out = await make([exa]).run(
      { queries: ["neon pricing", "supabase pricing"], domains: ["neon.com", "supabase.com"], fresh: true },
      createTurnCounter(),
    );
    expect(exa.calls.map((c) => [c.query, c.domains ?? null])).toEqual([
      ["neon pricing", ["neon.com", "supabase.com"]],
      ["supabase pricing", ["neon.com", "supabase.com"]],
      ["neon pricing", null],
    ]);
    expect(exa.calls.every((c) => c.fresh)).toBe(true);
    expect(out.results.map((x) => x.url)).toContain("https://news.test/neon pricing");
    expect(out.sources.map((s) => s.query)).toEqual(["neon pricing", "supabase pricing", "neon pricing (any site)"]);
  });

  it("without domains, nothing extra runs", async () => {
    const exa = provider("exa", returns([r("https://a.com")]));
    await make([exa]).run({ queries: ["a", "b"] }, createTurnCounter());
    expect(exa.calls).toHaveLength(2);
  });

  it("the unrestricted query failing alone does not mark the call as failed", async () => {
    const exa = provider("exa", async (q) => {
      if (!q.domains) throw new SearchProviderError("exa", 500);
      return [r("https://neon.com/pricing")];
    });
    const out = await make([exa]).run({ queries: ["neon pricing"], domains: ["neon.com"] }, createTurnCounter());
    expect(out.allFailed).toBe(false);
    expect(out.failed).toEqual(["neon pricing (any site)"]);
  });
});

describe("fresh timeout (D40)", () => {
  it("a fresh query gets the longer timeout, so a slow live crawl is not abandoned for the fallback", async () => {
    const exa = provider("exa", async (_q, s) => {
      await new Promise((r, j) => {
        const t = setTimeout(r, 120);
        s.addEventListener("abort", () => (clearTimeout(t), j(s.reason)));
      });
      return [r("https://neon.com/pricing")];
    });
    const tavily = provider("tavily", returns([r("https://tavily.test/x")]));
    const search = createSearch({ db, providers: [exa, tavily], now: () => clock, timeoutMs: 50, freshTimeoutMs: 400 });
    const fresh = await search.run({ queries: ["neon pricing"], fresh: true }, createTurnCounter());
    expect(fresh.sources).toEqual([{ query: "neon pricing", provider: "exa", cached: false }]);
    expect(tavily.calls).toHaveLength(0);
    // The same slow provider still times out at the short limit when the query is not fresh.
    const stale = await search.run({ queries: ["neon pricing plans"] }, createTurnCounter());
    expect(stale.sources[0]?.provider).toBe("tavily");
  });
});

describe("result provenance (D41)", () => {
  it("each result keeps the query that first found it", async () => {
    const exa = provider("exa", async (q) => [r(`https://x.test/${q.query.split(" ")[0]}`), r("https://shared.test/")]);
    const out = await make([exa]).run({ queries: ["bun version", "neon pricing"] }, createTurnCounter());
    expect(out.results.map((x) => [x.url, x.query])).toEqual([
      ["https://x.test/bun", "bun version"],
      ["https://x.test/neon", "neon pricing"],
      ["https://shared.test/", "bun version"],
    ]);
  });
});

describe("mergeWithFates: per-item reservation before the cap (D74)", () => {
  const r = (url: string) => ({ url, title: url, snippet: "" });
  it("five items, cap 8: without reservation the last items get nothing; with it every item keeps 2 and the cap grows to 10", async () => {
    const { mergeWithFates, RESERVE_PER_ITEM, MAX_RESULTS_RESERVED } = await import("../src/search/index");
    // item A has two long lists; B..E one list of 2 each
    const lists = [
      { group: "A", results: Array.from({ length: 6 }, (_, i) => r(`https://a.test/own-${i}`)) },
      { group: "A", results: Array.from({ length: 6 }, (_, i) => r(`https://a.test/any-${i}`)) },
      ...["B", "C", "D", "E"].map((g) => ({ group: g, results: [r(`https://${g}.test/1`), r(`https://${g}.test/2`)] })),
    ];
    const plain = mergeWithFates(lists, { cap: 8 });
    const plainCount = (g: string) => plain.kept.filter((k) => lists[k.list]!.group === g).length;
    expect(plainCount("A")).toBeGreaterThan(2);
    const cap = Math.min(MAX_RESULTS_RESERVED, Math.max(8, RESERVE_PER_ITEM * 5));
    expect(cap).toBe(10);
    const fair = mergeWithFates(lists, { cap, reserve: RESERVE_PER_ITEM });
    for (const g of ["A", "B", "C", "D", "E"]) expect(fair.kept.filter((k) => lists[k.list]!.group === g).length, g).toBe(2);
    // A's unread pages are marked as over the cap, not lost silently
    expect(fair.fates[0]!.filter((f) => f.fate === "cap").length).toBe(5);
  });

  it("duplicates are reported with the index of the kept copy", async () => {
    const { mergeWithFates } = await import("../src/search/index");
    const out = mergeWithFates([{ results: [r("https://x.test/a")] }, { results: [r("https://www.x.test/a/"), r("https://x.test/b")] }], { cap: 8 });
    expect(out.kept.map((k) => k.result.url)).toEqual(["https://x.test/a", "https://x.test/b"]);
    expect(out.fates[1]![0]).toEqual({ fate: "duplicate", duplicateOf: 0 });
  });

  it("never more than 12 in a verify call", async () => {
    const { MAX_RESULTS_RESERVED } = await import("../src/search/index");
    expect(MAX_RESULTS_RESERVED).toBe(12);
  });
});
