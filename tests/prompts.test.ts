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
});
