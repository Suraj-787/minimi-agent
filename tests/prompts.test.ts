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
      '- Already outdated when asked: dated evidence labelled "on or before the ... claim date" shows a different value',
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
