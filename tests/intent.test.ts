import { describe, expect, it } from "vitest";
import { detectIntent } from "../src/agent/intent";

describe("detectIntent", () => {
  it.each([
    ["A2", "What did I ask you on 3 November? Is your answer still correct today?"],
    ["A3", "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"],
    ["A4", "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?"],
    ["A13", "Last Tuesday I asked you about Postgres hosting. Has Supabase's price changed?"],
    ["same-thread follow-up", "Is that still correct?"],
    ["still true", "Is the Neon price you gave me still true?"],
    ["any updates", "Any updates on the Bun release?"],
    ["since a weekday", "What happened to HubSpot pricing since Monday?"],
    ["since a date", "Anything new since 3 November?"],
    ["since month-day", "Anything new since Nov 3?"],
    ["since ISO", "News since 2026-11-03?"],
    ["re-check", "Can you re-check those prices?"],
    ["double-check", "Please double-check that."],
    ["out of date", "Is my info out of date?"],
  ])("%s → verify", (_label, message) => {
    expect(detectIntent(message).verify).toBe(true);
  });

  it.each([
    ["A1", "What did I ask you on 3 November?"],
    ["A6", "hey, how's it going?"],
    ["A7", "What's the latest stable version of Node.js?"],
    ["A8", "What's the cheapest Pipedrive plan right now?"],
    ["A11", "What's a good way to structure a REST API error response?"],
    ["bare since", "Since I'm new to Postgres, which host is simplest?"],
    ["change verb", "How do I change my Postgres password?"],
    ["still as adverb", "I still don't get how branching works"],
  ])("%s → no verify", (_label, message) => {
    expect(detectIntent(message)).toMatchObject({ verify: false, cues: [] });
  });

  it("documented false positive: a history question with 'changed' adds verify instructions", () => {
    // Accepted by SPEC §8: the cost is a few prompt lines, and a forced search only when claims were recalled.
    expect(detectIntent("How has JavaScript changed over the years?").verify).toBe(true);
  });

  it("records which cues matched", () => {
    expect(detectIntent("Has any pricing changed since then?").cues).toEqual(["changed", "since"]);
  });

  it.each([
    ["A4 shipped", "Has any of them changed pricing or shipped something big since?", true],
    ["any news", "Any news on Bun since then?", true],
    ["launched", "Did Neon launch anything since Monday?", true],
    ["releases", "Any new releases since 3 November?", true],
    ["price only", "Has Supabase's price changed?", false],
    ["still correct", "Is your answer still correct today?", false],
  ])("news flag: %s", (_l, message, news) => {
    expect(detectIntent(message).news).toBe(news);
  });
});
