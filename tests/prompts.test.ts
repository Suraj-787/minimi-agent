import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RELEASE_LIST_RULES, SYSTEM_PROMPT, buildDynamicBlock, withDynamicBlock } from "../src/agent/prompts";

describe("prompts", () => {
  it("system prompt is a constant with no dates or times in it", () => {
    expect(SYSTEM_PROMPT).toBe(SYSTEM_PROMPT);
    expect(SYSTEM_PROMPT).not.toMatch(/\b20\d{2}\b/);
    expect(SYSTEM_PROMPT).not.toMatch(/\d{1,2}:\d{2}/);
  });

  it("dynamic block carries weekday, local time and timezone", () => {
    const block = buildDynamicBlock({ now: new Date("2026-11-12T05:30:00Z"), tz: "Asia/Kolkata" });
    expect(block).toContain("2026-11-12 11:00 (Thursday)");
    expect(block).toContain("Asia/Kolkata (UTC+05:30)");
  });

  it("puts the block in front of the user text", () => {
    expect(withDynamicBlock("<context/>", "hello")).toBe("<context/>\n\nhello");
  });
});

describe("search discipline", () => {
  it("tells the model to judge only the latest message, and never to search for small talk", () => {
    expect(SYSTEM_PROMPT).toMatch(/latest user message/);
    expect(SYSTEM_PROMPT).toMatch(/small talk/);
  });

  it("verify statuses: a page date alone never justifies Changed", () => {
    for (const status of [
      "- Unchanged:",
      "- Differs now (timing unknown):",
      "- Changed after <date>: ONLY when a source's own text reports the change AND that source is dated after the claim date",
      '- Already outdated when asked: dated evidence labelled "before the ... claim date" (strictly earlier than the claim) shows a different value',
      "A row with such evidence is always this status, never Changed.",
      "- Couldn't verify:",
    ]) {
      expect(SYSTEM_PROMPT).toContain(status);
    }
    expect(SYSTEM_PROMPT).toContain("A page date alone never justifies Changed.");
    expect(SYSTEM_PROMPT).toContain("says when the page was published or last crawled, NOT when a price or feature changed");
    expect(SYSTEM_PROMPT).not.toContain("Changed (since you asked)");
    expect(SYSTEM_PROMPT).toContain("Item | Said (date) | Then → Now | Status | Evidence date | Source");
  });

  it("memory is cited in words by date and chat, never with bracketed ids", () => {
    expect(SYSTEM_PROMPT).toContain('refer to it in words by date and chat, e.g. "from your 3 Nov chat about static site tools"');
    expect(SYSTEM_PROMPT).toContain('Never put ids or bracketed memory references in an answer: no "[memory: ...]", no turn or claim ids.');
  });

  it("verify lines appear only in verify mode, and are never in the static prompt", () => {
    const at = new Date("2026-11-12T05:30:00Z");
    const recheck = { items: ["Neon — cheapest paid plan price", "Bun — latest stable major.minor"], domains: ["neon.com"] };
    expect(buildDynamicBlock({ now: at, tz: "Asia/Kolkata", recheck })).not.toContain("Claims to re-check");
    const on = buildDynamicBlock({ now: at, tz: "Asia/Kolkata", verify: true, recheck });
    expect(on).toContain(
      "Claims to re-check (2; every one needs a search, values in <memory>): Neon — cheapest paid plan price; Bun — latest stable major.minor",
    );
    expect(on).toContain("Domains from those claims (a hint, not a limit): neon.com");
    expect(SYSTEM_PROMPT).not.toContain("neon.com");
  });

  it("the takeaway must match the table, and launches need a dated source", () => {
    expect(SYSTEM_PROMPT).toContain("name every row whose status is not Unchanged");
    expect(SYSTEM_PROMPT).toContain("Never say nothing changed when any row is not Unchanged.");
    expect(RELEASE_LIST_RULES).toContain('add "Shipped since <date>:" with one line per launch (item, date, [n]), or "Nothing found dated after <date>."');
    expect(RELEASE_LIST_RULES).toContain('Say "introduced" or "launched" only with a source dated after the claim date');
  });
});

describe("release list (Phase 7a): only when the user asked about releases, news or updates", () => {
  const at = new Date("2026-11-12T05:30:00Z");
  const base = { now: at, tz: "Asia/Kolkata" };

  it("is absent from the static prompt, so the prompt stays byte-identical on every call", () => {
    expect(SYSTEM_PROMPT).not.toContain("Shipped since");
    expect(SYSTEM_PROMPT).not.toContain("Release list");
  });

  it("is in <context> only in verify mode and only when the user asked about releases", () => {
    const inContext = (b: string) => b.slice(0, b.indexOf("</context>"));
    expect(inContext(buildDynamicBlock({ ...base, verify: true, news: true }))).toContain(RELEASE_LIST_RULES);
    expect(buildDynamicBlock({ ...base, verify: true })).not.toContain("Shipped since");
    expect(buildDynamicBlock({ ...base, verify: true, news: false })).not.toContain("Release list");
    expect(buildDynamicBlock({ ...base, news: true })).not.toContain("Release list"); // news without verify mode
  });

  it("carries a fictional example", () => {
    expect(RELEASE_LIST_RULES).toContain('Example (fictional): "Shipped since 3 Nov:"');
  });
});

// D76: the D75 trim removed these and A13 went from 4/4 to 0/4 (Flash-Lite wrote "Changed after" from a pricing page's date).
// They state rules, so they are pinned: only the release paragraphs may live outside the static prompt.
describe("sentences the D75 trim removed, restored (D76)", () => {
  it.each([
    "A vendor pricing or product page's date is the page's date, not the change date.",
    "Changed after <date>: ONLY when a source's own text reports the change AND that source is dated after the claim date",
    "name every row whose status is not Unchanged, with its status",
    "Never say nothing changed when any row is not Unchanged.",
    "Every listed item needs its own search query; the app adds queries for items you leave out.",
    '"Domains from those claims" in <context> is a hint for official pages, not a limit; the app also runs one unrestricted query.',
    "When the user asks what shipped, launched or changed, the app runs a second search with since and no domains.",
    "Square-bracket citations [n] are only for this turn's search results.",
    "If there is no record of something, say so. If sources conflict, say so and give both.",
  ])("static prompt contains: %s", (sentence) => {
    expect(SYSTEM_PROMPT).toContain(sentence);
  });

  it("the only text that left the static prompt is the three release paragraphs, which live in RELEASE_LIST_RULES", () => {
    expect(SYSTEM_PROMPT).not.toContain("Shipped since");
    expect(RELEASE_LIST_RULES).toContain("Shipped since");
    expect(SYSTEM_PROMPT.length).toBeGreaterThan(7600); // 8,482 before D75 minus the 818 characters that moved
    expect(SYSTEM_PROMPT.length).toBeLessThan(7800);
  });
});

describe("Phase 5 browser-test rules", () => {
  it("missing earlier content: say what has no record, ask for details, never substitute a generic search or invent", () => {
    expect(SYSTEM_PROMPT).toContain("# Missing earlier content");
    expect(SYSTEM_PROMPT).toContain("say plainly what you have no record of and ask for the missing details, for example the names of the tools");
    expect(SYSTEM_PROMPT).toContain("Do not substitute a generic web search for the missing content, and never invent or guess the items");
  });

  it('"Shipped since" lists only items dated after the date; an ambiguous weekday is stated or asked', () => {
    expect(RELEASE_LIST_RULES).toContain("List an item only if its own source date is after <date>");
    expect(RELEASE_LIST_RULES).toContain("If <date> comes from an ambiguous weekday, say which date you assumed, or ask.");
    expect(SYSTEM_PROMPT).toContain("state the date you assumed in your first line, or ask which one the user meant");
  });

  it("a dated result that states the new value beats undated ones; its label decides Already outdated", () => {
    expect(SYSTEM_PROMPT).toContain("rely on a dated result that states the new value over undated pages");
    expect(SYSTEM_PROMPT).toContain('if it says "before the ... claim date", the status is Already outdated when asked');
  });

  it("citations are [n] only, never markdown links or bare URLs", () => {
    expect(SYSTEM_PROMPT).toContain("Cite ONLY as [n]. Never write a markdown link like [text](url), a bare URL");
  });

  it("notes render inside <context>, and the system prompt stays free of dates and times", () => {
    const block = buildDynamicBlock({ now: new Date("2026-11-12T05:30:00Z"), tz: "Asia/Kolkata", notes: ["No record found: x"] });
    expect(block.indexOf("No record found: x")).toBeLessThan(block.indexOf("</context>"));
    expect(SYSTEM_PROMPT).not.toMatch(/\b20\d{2}\b/);
    expect(SYSTEM_PROMPT).not.toMatch(/\d{1,2}:\d{2}/);
  });
});

describe("evidence quality rules (D54, D55)", () => {
  it("same-day evidence cannot be ordered: Differs now, never Already outdated or Changed", () => {
    expect(SYSTEM_PROMPT).toContain('"(same day as the <item> claim date <date>)"');
    expect(SYSTEM_PROMPT).toContain('Evidence labelled "same day as the ... claim date" cannot be ordered against the claim');
    expect(SYSTEM_PROMPT).toContain("never Already outdated and never Changed");
    expect(SYSTEM_PROMPT).not.toContain("on or before the ... claim date");
  });

  it("a competitor's blog or unrelated page cannot be another vendor's source", () => {
    expect(SYSTEM_PROMPT).toContain("A row's source must be about that row's own item.");
    expect(SYSTEM_PROMPT).toContain("cannot be the source for another vendor's price or release");
    expect(SYSTEM_PROMPT).toContain("the row is Couldn't verify");
  });
});

describe("source order and shipped wording (D58)", () => {
  it("price rows cite the vendor's own page first; a dated third-party page only when it is missing/unclear or orders the evidence", () => {
    expect(SYSTEM_PROMPT).toContain("For a price row, cite the vendor's own page first when it states the price; an undated vendor page is fine.");
    expect(SYSTEM_PROMPT).toContain("Use a dated third-party page only when the vendor page is missing or unclear, or to order the evidence");
  });

  it('"Shipped since" says "reported <date>" unless the date is from the vendor\'s own announcement, notes or changelog', () => {
    expect(RELEASE_LIST_RULES).toContain('Write "reported <date>" unless the date comes from the vendor\'s own announcement, release notes or changelog');
    expect(RELEASE_LIST_RULES).toContain('never for a news recap, a blog roundup or an aggregator');
  });

  it("the Shipped-since wording moved unchanged to the release block; the static prompt stays free of dates and times", () => {
    expect(SYSTEM_PROMPT).not.toMatch(/\b20\d{2}\b/);
    expect(SYSTEM_PROMPT).not.toMatch(/\d{1,2}:\d{2}/);
  });

  it("D71: a vendor pricing page's date is not the change date; the exact Supabase example is in the prompt", () => {
    expect(SYSTEM_PROMPT).toContain("A vendor pricing or product page's date is the page's date, not the change date");
    expect(SYSTEM_PROMPT).toContain("A page date alone never justifies Changed.");
    expect(SYSTEM_PROMPT).toContain(
      "Example: ExampleDB Pro $10 → $12 from exampledb.com/pricing dated 11 Nov, with the claim dated 3 Nov → Differs now (timing unknown).",
    );
    expect(SYSTEM_PROMPT).not.toMatch(/\b20\d{2}\b/); // the example has no year: the prompt stays free of dates
  });

  it("D71: a Couldn't verify row shows — as the Now value, never the old value repeated", () => {
    expect(SYSTEM_PROMPT).toContain(
      `Couldn't verify: no usable evidence. In that row Then → Now shows the value said then and "—" as the Now value (for example "$30 → —"); never repeat the old value as if it were current.`,
    );
  });
});

// D71: examples in the static prompt must not come from the eval set, or a pass on those cases proves nothing
// (the prompt would be teaching the answer). Everything below is read from the eval files themselves.
describe("the static prompt shares no vendor or price with the eval set", () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
  const cases = JSON.parse(read("../eval/cases.json")) as { cases: Array<{ mockSearch?: Array<{ url: string }> }> };
  const seed = JSON.parse(read("../eval/seed.json")) as { threads: Array<{ turns: Array<{ claims: Array<{ entity: string }> }> }> };
  const everything = [read("../eval/cases.json"), read("../eval/seed.json"), read("../scripts/seed.ts")].join("\n");

  const entities = seed.threads.flatMap((t) => t.turns.flatMap((u) => u.claims.map((c) => c.entity)));
  const hosts = cases.cases.flatMap((c) => (c.mockSearch ?? []).map((m) => new URL(m.url).hostname.split(".").slice(-2)[0] ?? ""));
  const vendors = [...new Set([...entities, ...entities.map((e) => e.split(" ")[0] ?? ""), ...hosts, "Postgres", "half-marathon"])].filter((v) => v.length >= 3);
  const prices = [...new Set((everything.match(/\$\d[\d,]*(?:\.\d+)?/g) ?? []).map((p) => p.replace(/[.,]$/, "")))];

  it("reads a real set of names and prices (the test is not vacuous)", () => {
    expect(vendors).toEqual(expect.arrayContaining(["Neon", "Supabase", "Render", "Bun", "HubSpot", "Pipedrive", "Salesforce", "Zoho", "Freshsales"]));
    expect(prices).toEqual(expect.arrayContaining(["$19", "$25", "$29", "$175", "$90"]));
  });

  it.each(vendors)("no vendor or topic name %s", (name) => {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "iu");
    expect(SYSTEM_PROMPT).not.toMatch(re);
  });

  it("no price string from the eval files", () => {
    const found = prices.filter((price) => new RegExp(`${price.replace(/[$.]/g, "\\$&")}(?![\\d.]*\\d)`).test(SYSTEM_PROMPT));
    expect(found).toEqual([]);
  });

  it.each(vendors)("the release block names no vendor or topic %s either", (name) => {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "iu");
    expect(RELEASE_LIST_RULES).not.toMatch(re);
  });

  it("the release block has no eval price, and its fictional example is not in the eval files", () => {
    const found = prices.filter((price) => new RegExp(`${price.replace(/[$.]/g, "\\$&")}(?![\\d.]*\\d)`).test(RELEASE_LIST_RULES));
    expect(found).toEqual([]);
    for (const fake of ["ExampleDB", "Acme Analytics"]) {
      expect(RELEASE_LIST_RULES).toContain(fake);
      expect(everything.toLowerCase()).not.toContain(fake.toLowerCase());
    }
  });

  it("the fictional examples it uses are not in the eval files either", () => {
    for (const fake of ["ExampleDB", "exampledb.com", "Acme Analytics", "$10 → $12", "$40 → $48"]) {
      expect(SYSTEM_PROMPT).toContain(fake);
      expect(everything.toLowerCase()).not.toContain(fake.toLowerCase());
    }
  });
});
