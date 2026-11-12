import { describe, expect, it } from "vitest";
import { MAX_QUERIES, createRecheckTracker } from "../src/agent/recheck";

const CRM = [
  { entity: "HubSpot Sales Hub", attribute: "Professional price per seat per month (annual)", said: "2026-11-09", hosts: ["hubspot.com"] },
  { entity: "HubSpot Sales Hub", attribute: "Starter price", said: "2026-11-09", hosts: ["hubspot.com"] },
  { entity: "Pipedrive", attribute: "Advanced price", said: "2026-11-09", hosts: ["pipedrive.com"] },
  { entity: "Salesforce Sales Cloud", attribute: "Enterprise price", said: "2026-11-09", hosts: ["salesforce.com"] },
  { entity: "Zoho CRM", attribute: "Professional price", said: "2026-11-09", hosts: ["zoho.com"] },
  { entity: "Freshsales", attribute: "Growth price", said: "2026-11-09" }, // no stored source: unrestricted only
];

describe("createRecheckTracker: the price pass is built by code (D73)", () => {
  it("one item per entity; each gets its own host AND an unrestricted twin; no since; the model's domains/since are ignored", () => {
    const t = createRecheckTracker({ items: CRM });
    expect(t.state().items).toBe(5);
    const out = t.apply({
      queries: ["HubSpot pricing 2026", "Pipedrive pricing", "Salesforce pricing", "Zoho CRM pricing"],
      fresh: false,
      since: "2026-11-09",
      domains: ["neon.tech"],
    });
    expect(out.since).toBeUndefined();
    expect(out.domains).toBeUndefined();
    expect(out.fresh).toBe(true); // live pages for prices, whatever the model asked
    expect(out.jobs?.map((j) => [j.item, j.query, j.domains, j.since])).toEqual([
      ["HubSpot Sales Hub", "HubSpot pricing 2026", ["hubspot.com"], undefined],
      ["HubSpot Sales Hub", "HubSpot pricing 2026", undefined, undefined],
      ["Pipedrive", "Pipedrive pricing", ["pipedrive.com"], undefined],
      ["Pipedrive", "Pipedrive pricing", undefined, undefined],
      ["Salesforce Sales Cloud", "Salesforce pricing", ["salesforce.com"], undefined],
      ["Salesforce Sales Cloud", "Salesforce pricing", undefined, undefined],
      ["Zoho CRM", "Zoho CRM pricing", ["zoho.com"], undefined],
      ["Zoho CRM", "Zoho CRM pricing", undefined, undefined],
      // the model left Freshsales out: code adds it; with no stored host it runs unrestricted only
      ["Freshsales", "Freshsales Growth price", undefined, undefined],
    ]);
    expect(out.queries).toEqual(["HubSpot pricing 2026", "Pipedrive pricing", "Salesforce pricing", "Zoho CRM pricing", "Freshsales Growth price"]);
    expect(t.state().uncovered).toEqual([]);
    expect(t.needsSearch()).toBe(false);
    expect(t.note()).toBe(
      "App note: every item has been searched. Don't search again for an item whose results didn't mention it; mark it Couldn't verify. Write the answer now.",
    );
  });

  it("several claims about one vendor share its hosts", () => {
    const t = createRecheckTracker({
      items: [
        { entity: "Neon", attribute: "price", said: "2026-11-03", hosts: ["neon.com"] },
        { entity: "Neon", attribute: "plan", said: "2026-11-03", hosts: ["neon.tech"] },
      ],
    });
    expect(t.apply({ queries: ["x"] }).jobs?.[0]?.domains).toEqual(["neon.com", "neon.tech"]);
  });

  it("past the 6-item cap, the rest stay uncovered: the note names them and another search is owed", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ entity: `Vendor${i}`, attribute: "price", said: "2026-11-09" }));
    const t = createRecheckTracker({ items: many });
    const out = t.apply({ queries: ["Vendor0 price"] });
    expect(out.queries).toHaveLength(MAX_QUERIES);
    expect(t.state().uncovered).toEqual(["Vendor6", "Vendor7", "Vendor8"]);
    expect(t.needsSearch()).toBe(true);
    expect(t.note()).toBe(
      "App note: not searched yet: Vendor6, Vendor7, Vendor8. Search them in your next web_search call before answering. Don't search again for an item whose results didn't mention it; mark it Couldn't verify.",
    );
    t.apply({ queries: ["Vendor6 price"] });
    expect(t.needsSearch()).toBe(false);
  });

  it("matches the entity as a whole word, not a substring", () => {
    const t = createRecheckTracker({ items: [{ entity: "Bun", attribute: "latest stable", said: "2026-11-09" }] });
    expect(t.apply({ queries: ["bundle size tips"] }).queries).toEqual(["Bun latest stable"]);
  });
});

describe("the news pass is the only pass with since", () => {
  it("runs after coverage: since on every job, no domains, one query per item", () => {
    const t = createRecheckTracker({ items: CRM, newsSince: "2026-11-09" });
    t.apply({ queries: ["HubSpot", "Pipedrive", "Salesforce", "Zoho", "Freshsales"], fresh: true });
    expect(t.needsSearch()).toBe(true);
    expect(t.note()).toContain("next, search for launches, releases and pricing announcements since 2026-11-09");
    const news = t.apply({ queries: ["HubSpot launches November 2026"], fresh: true, domains: ["hubspot.com"] });
    expect(news.jobs?.every((j) => j.since === "2026-11-09" && j.domains === undefined)).toBe(true);
    expect(news.queries).toEqual([
      "HubSpot Sales Hub news announcement",
      "Pipedrive news announcement",
      "Salesforce Sales Cloud news announcement",
      "Zoho CRM news announcement",
      "Freshsales news announcement",
    ]);
    expect(t.needsSearch()).toBe(false);
    expect(t.note()).toContain("filtered to pages published on or after 2026-11-09");
    expect(t.state()).toMatchObject({ newsSince: "2026-11-09", newsDone: true });
  });

  it("without a news cue no news pass is owed", () => {
    const t = createRecheckTracker({ items: CRM });
    t.apply({ queries: ["HubSpot", "Pipedrive", "Salesforce", "Zoho", "Freshsales"] });
    expect(t.needsSearch()).toBe(false);
    expect(t.state().newsDone).toBe(true);
  });

  it("the news note asks for a Shipped since list", () => {
    const t = createRecheckTracker({ items: [{ entity: "Bun", attribute: "x", said: "2026-11-03" }], newsSince: "2026-11-03" });
    t.apply({ queries: ["Bun"] });
    t.apply({ queries: ["Bun release"] });
    expect(t.note()).toContain('After the table, add "Shipped since 2026-11-03:" listing each launch with its date and [n], or "Nothing found dated after 2026-11-03."');
  });
});

describe("targeted retry (D74)", () => {
  const PG = [
    { entity: "Supabase", attribute: "cheapest paid plan price", said: "2026-11-03", hosts: ["supabase.com"] },
    { entity: "Render", attribute: "cheapest paid Postgres plan", said: "2026-11-03", hosts: ["render.com"] },
    { entity: "Neon", attribute: "cheapest paid plan price", said: "2026-11-03", hosts: ["neon.com"] },
  ];
  it("retries, once, only the items no returned URL or title names: their own host, no since", () => {
    const t = createRecheckTracker({ items: PG, newsSince: "2026-11-03" });
    t.apply({ queries: ["supabase pricing"] });
    const results = [
      { url: "https://supabase.com/pricing", title: "Supabase Pricing" },
      { url: "https://render.com/blog", title: "Blog | Render" }, // names Render in the URL: covered, even if useless
      { url: "https://costbrake.com/guides/x", title: "Cheap Postgres hosts" }, // names nobody
    ];
    const retry = t.retryFor(results);
    expect(retry?.jobs).toEqual([
      { query: "Neon cheapest paid plan price", domains: ["neon.com"], item: "Neon", label: "Neon cheapest paid plan price (retry: neon.com)" },
    ]);
    expect(retry?.since).toBeUndefined();
    expect(t.retryFor(results)).toBeUndefined(); // once per item per turn
    expect(t.state().retried).toEqual(["Neon"]);
  });

  it("a page body mentioning the vendor does not count; only the URL or title does", () => {
    const t = createRecheckTracker({ items: [PG[2]!] });
    t.apply({ queries: ["neon"] });
    expect(t.retryFor([{ url: "https://example.test/hosts", title: "Postgres hosts compared" }])?.jobs?.[0]?.item).toBe("Neon");
  });

  it("aliases count: freshworks.com names Freshsales", () => {
    const t = createRecheckTracker({ items: [{ entity: "Freshsales", attribute: "Pro price", said: "2026-11-09", hosts: ["freshworks.com"] }] });
    t.apply({ queries: ["freshsales"] });
    expect(t.retryFor([{ url: "https://www.freshworks.com/crm/pricing/", title: "Pricing" }])).toBeUndefined();
  });

  it("an item without a stored host retries unrestricted", () => {
    const t = createRecheckTracker({ items: [{ entity: "Bun", attribute: "latest stable", said: "2026-11-03" }] });
    t.apply({ queries: ["bun"] });
    expect(t.retryFor([])?.jobs).toEqual([{ query: "Bun latest stable", item: "Bun", label: "Bun latest stable (retry)" }]);
  });

  it("the news pass is never retried", () => {
    const t = createRecheckTracker({ items: PG, newsSince: "2026-11-03" });
    t.apply({ queries: ["x"] });
    t.retryFor([]);
    t.apply({ queries: ["news"] });
    expect(t.retryFor([])).toBeUndefined();
  });
});

describe("itemForResult: date labels come from the vendor the page names (D74)", () => {
  const t = createRecheckTracker({
    items: [
      { entity: "Supabase", attribute: "price", said: "2026-11-03" },
      { entity: "Neon", attribute: "price", said: "2026-11-12" },
      { entity: "Render", attribute: "price", said: "2026-11-03" },
    ],
  });
  it("a Supabase page found by the Neon job is about Supabase, never dated against the Neon claim", () => {
    const r = { url: "https://supabase.com/blog/set-up-supabase-for-every-expo-environment", title: "Set up Supabase for every Expo environment", query: "neon postgres pricing", item: "Neon" };
    expect(t.itemForResult(r)?.entity).toBe("Supabase");
  });
  it("a page naming nobody falls back to its job's item, then to an item its query mentions", () => {
    expect(t.itemForResult({ url: "https://costbrake.com/x", title: "Cheap hosts", query: "q", item: "Render" })?.entity).toBe("Render");
    expect(t.itemForResult({ url: "https://costbrake.com/x", title: "Cheap hosts", query: "neon pricing" })?.entity).toBe("Neon");
    expect(t.itemForResult({ url: "https://costbrake.com/x", title: "Cheap hosts", query: "postgres" })).toBeUndefined();
  });
  it("a page naming several vendors keeps its own job's item when that is one of them", () => {
    const r = { url: "https://costbrake.com/guides/neon-vs-supabase-pricing", title: "Neon vs Supabase", query: "q", item: "Neon" };
    expect(t.itemForResult(r)?.entity).toBe("Neon");
    expect(t.itemForResult({ ...r, item: "Render" })?.entity).toBe("Supabase"); // first named item when its job's item is not named
  });
});
