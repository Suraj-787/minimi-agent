import { describe, expect, it } from "vitest";
import { MAX_QUERIES, createRecheckTracker } from "../src/agent/recheck";

const CRM = [
  { entity: "HubSpot Sales Hub", attribute: "Professional price per seat per month (annual)", said: "2026-11-09" },
  { entity: "HubSpot Sales Hub", attribute: "Starter price", said: "2026-11-09" },
  { entity: "Pipedrive", attribute: "Advanced price", said: "2026-11-09" },
  { entity: "Salesforce Sales Cloud", attribute: "Enterprise price", said: "2026-11-09" },
  { entity: "Zoho CRM", attribute: "Professional price", said: "2026-11-09" },
  { entity: "Freshsales", attribute: "Growth price", said: "2026-11-09" },
];

describe("createRecheckTracker", () => {
  it("one item per entity, and tops up queries for items the model left out", () => {
    const t = createRecheckTracker({ items: CRM });
    expect(t.state().items).toBe(5);
    const out = t.apply({ queries: ["HubSpot pricing 2026", "Pipedrive pricing", "Salesforce pricing", "Zoho CRM pricing"], fresh: true, domains: ["hubspot.com"] });
    expect(out.queries).toEqual(["HubSpot pricing 2026", "Pipedrive pricing", "Salesforce pricing", "Zoho CRM pricing", "Freshsales Growth price"]);
    expect(out.domains).toEqual(["hubspot.com"]);
    expect(t.state().uncovered).toEqual([]);
    expect(t.needsSearch()).toBe(false);
    // Everything is searched: the note tells the model not to search again (code closes the next step, D69).
    expect(t.note()).toBe(
      "App note: every item has been searched. Don't search again for an item whose results didn't mention it; mark it Couldn't verify. Write the answer now.",
    );
  });

  it("past the 6-query cap, the rest stay uncovered: the note names them and another search is owed", () => {
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

  it("the news pass runs after coverage: since applied, domains dropped, one query per item", () => {
    const t = createRecheckTracker({ items: CRM, newsSince: "2026-11-09" });
    t.apply({ queries: ["HubSpot", "Pipedrive", "Salesforce", "Zoho", "Freshsales"], fresh: true, domains: ["hubspot.com"] });
    expect(t.needsSearch()).toBe(true);
    expect(t.note()).toContain("next, search for launches, releases and pricing announcements since 2026-11-09");
    const news = t.apply({ queries: ["HubSpot launches November 2026"], fresh: true, domains: ["hubspot.com"] });
    expect(news.since).toBe("2026-11-09");
    expect(news.domains).toBeUndefined();
    expect(news.queries).toEqual([
      "HubSpot launches November 2026",
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

  it("matches the entity as a whole word, not a substring", () => {
    const t = createRecheckTracker({ items: [{ entity: "Bun", attribute: "latest stable", said: "2026-11-09" }] });
    expect(t.apply({ queries: ["bundle size tips"] }).queries).toEqual(["bundle size tips", "Bun latest stable"]);
  });

  it("itemFor maps a result to the item it was searched for: by query, else by title", () => {
    const t = createRecheckTracker({
      items: [
        { entity: "Bun", attribute: "latest stable", said: "2026-11-03" },
        { entity: "Neon", attribute: "price", said: "2026-11-03" },
      ],
    });
    expect(t.itemFor("Bun latest version", "Release notes")?.entity).toBe("Bun");
    expect(t.itemFor("serverless postgres pricing", "Neon Pricing")?.entity).toBe("Neon");
    expect(t.itemFor("serverless postgres pricing", "Postgres hosts compared")).toBeUndefined();
  });

  it("the news note asks for a Shipped since list", () => {
    const t = createRecheckTracker({ items: [{ entity: "Bun", attribute: "x", said: "2026-11-03" }], newsSince: "2026-11-03" });
    t.apply({ queries: ["Bun"] });
    t.apply({ queries: ["Bun release"] });
    expect(t.note()).toContain('After the table, add "Shipped since 2026-11-03:" listing each launch with its date and [n], or "Nothing found dated after 2026-11-03."');
  });
});
