import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT, buildDynamicBlock, withDynamicBlock } from "../src/agent/prompts";

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
      "- Changed after <date>: ONLY when a dated announcement, changelog entry, release note or news item published after the claim was said reports the change",
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
    expect(SYSTEM_PROMPT).toContain('refer to it in words by date and chat, e.g. "from your 3 Nov chat about Postgres hosting"');
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
    expect(SYSTEM_PROMPT).toContain('add "Shipped since <date>:" with one line per launch (item, date, [n]), or "Nothing found dated after <date>."');
    expect(SYSTEM_PROMPT).toContain('Say "introduced" or "launched" only with a source dated after the claim date');
  });
});

describe("Phase 5 browser-test rules", () => {
  it("missing earlier content: say what has no record, ask for details, never substitute a generic search or invent", () => {
    expect(SYSTEM_PROMPT).toContain("# Missing earlier content");
    expect(SYSTEM_PROMPT).toContain("say plainly what you have no record of and ask for the missing details, for example the names of the tools");
    expect(SYSTEM_PROMPT).toContain("Do not substitute a generic web search for the missing content, and never invent or guess the items");
  });

  it('"Shipped since" lists only items dated after the date; an ambiguous weekday is stated or asked', () => {
    expect(SYSTEM_PROMPT).toContain("list an item only if its own source date is after <date>");
    expect(SYSTEM_PROMPT).toContain("If <date> comes from an ambiguous weekday, say which date you assumed, or ask.");
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
    expect(SYSTEM_PROMPT).toContain('write "reported <date>" unless the date comes from the vendor\'s own announcement, release notes or changelog');
    expect(SYSTEM_PROMPT).toContain('Never write "shipped <date>" for a news recap, a blog roundup or an aggregator');
  });

  it("the earlier Shipped-since wording is unchanged and the prompt stays free of dates and times", () => {
    expect(SYSTEM_PROMPT).toContain('add "Shipped since <date>:" with one line per launch (item, date, [n]), or "Nothing found dated after <date>."');
    expect(SYSTEM_PROMPT).not.toMatch(/\b20\d{2}\b/);
    expect(SYSTEM_PROMPT).not.toMatch(/\d{1,2}:\d{2}/);
  });
});

