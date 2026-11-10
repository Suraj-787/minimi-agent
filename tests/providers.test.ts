import { describe, expect, it } from "vitest";
import { createExa, exaRequestBody } from "../src/search/exa";
import { createTavily, tavilyRequestBody } from "../src/search/tavily";
import { SearchProviderError, toDay } from "../src/search/types";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const sig = new AbortController().signal;

describe("exa", () => {
  it("maps since / domains / fresh onto the request", () => {
    const body = exaRequestBody({ query: "q", since: "2026-11-09", domains: ["neon.com"], fresh: true });
    expect(body).toMatchObject({
      query: "q",
      startPublishedDate: "2026-11-09T00:00:00.000Z",
      includeDomains: ["neon.com"],
      contents: { maxAgeHours: 0 },
    });
    const plain = exaRequestBody({ query: "q" });
    expect(plain).not.toHaveProperty("startPublishedDate");
    expect(plain).not.toHaveProperty("includeDomains");
    expect(plain.contents).not.toHaveProperty("maxAgeHours");
  });

  it("sends the key in x-api-key and normalises the response", async () => {
    let seen: RequestInit | undefined;
    const exa = createExa("k-secret", (async (_u: unknown, init?: RequestInit) => {
      seen = init;
      return json({
        results: [
          { title: "A", url: "https://a.com", publishedDate: "2026-11-09T00:00:00.000Z", highlights: ["one", "two"] },
          { title: null, url: "https://b.com", text: "body text" },
        ],
      });
    }) as typeof fetch);
    const out = await exa.search({ query: "q" }, sig);
    expect((seen?.headers as Record<string, string>)["x-api-key"]).toBe("k-secret");
    expect(out).toEqual([
      { title: "A", url: "https://a.com", publishedDate: "2026-11-09", snippet: "one … two" },
      { title: "https://b.com", url: "https://b.com", publishedDate: undefined, snippet: "body text" },
    ]);
  });

  it("rejects malformed responses and HTTP errors without leaking the key", async () => {
    const bad = createExa("k-secret", (async () => json({ nope: true })) as typeof fetch);
    await expect(bad.search({ query: "q" }, sig)).rejects.toBeInstanceOf(SearchProviderError);
    const down = createExa("k-secret", (async () => json({ error: "k-secret echoed" }, 401)) as typeof fetch);
    const err = (await down.search({ query: "q" }, sig).catch((e: unknown) => e)) as Error;
    expect(err.message).toContain("401");
    expect(err.message).not.toContain("k-secret");
  });
});

describe("tavily", () => {
  it("maps filters onto the request; news topic only for news-like queries", () => {
    expect(tavilyRequestBody({ query: "q", since: "2026-11-09", domains: ["a.com"], fresh: true })).toMatchObject({
      start_date: "2026-11-09",
      include_domains: ["a.com"],
      max_age_hours: 0,
      topic: "general",
      include_published_date: true,
    });
    expect(tavilyRequestBody({ query: "q", newsLike: true })).toMatchObject({ topic: "news" });
  });

  it("uses a Bearer token and parses RFC 2822 dates", async () => {
    let seen: RequestInit | undefined;
    const t = createTavily("tv-secret", (async (_u: unknown, init?: RequestInit) => {
      seen = init;
      return json({ results: [{ title: "T", url: "https://t.com", content: "snip", published_date: "Tue, 11 Mar 2025 17:00:00 GMT" }] });
    }) as typeof fetch);
    const out = await t.search({ query: "q" }, sig);
    expect((seen?.headers as Record<string, string>).authorization).toBe("Bearer tv-secret");
    expect(out[0]).toMatchObject({ publishedDate: "2025-03-11", snippet: "snip" });
  });

  it("rejects a malformed response", async () => {
    const t = createTavily("x", (async () => json({ results: [{ title: "no url" }] })) as typeof fetch);
    await expect(t.search({ query: "q" }, sig)).rejects.toBeInstanceOf(SearchProviderError);
  });
});

describe("toDay", () => {
  it.each([
    ["2026-11-09T00:00:00.000Z", "2026-11-09"],
    ["2026-11-09", "2026-11-09"],
    ["Tue, 11 Mar 2025 17:00:00 GMT", "2025-03-11"],
    ["garbage", undefined],
    [null, undefined],
  ])("%s → %s", (raw, want) => expect(toDay(raw)).toBe(want));
});
