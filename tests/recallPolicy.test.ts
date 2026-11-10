import { describe, expect, it } from "vitest";
import { hasBackReference, recallPolicy, topicTerms } from "../src/agent/recallPolicy";
import { resolveTimeRefs } from "../src/agent/time";

const NOW = new Date("2026-11-12T05:30:00Z");
const plan = (message: string, verify = false) =>
  recallPolicy({ message, intent: { verify }, times: resolveTimeRefs(message, NOW, "Asia/Kolkata") });

describe("recallPolicy", () => {
  it("unrelated question → R0 only, no cross-thread memory (R4)", () => {
    const p = plan("What's a good way to structure a REST API error response?");
    expect(p.rules).toEqual(["R0"]);
    expect(p.crossThread).toBe(false);
    expect(p.dated).toEqual([]);
  });

  it("chit-chat → R0 only", () => {
    expect(plan("hey, how's it going?").rules).toEqual(["R0"]);
  });

  it('"On Monday we shortlisted…" → R1 (and R2, it is a back-reference with a topic)', () => {
    const p = plan("On Monday we shortlisted 5 CRM tools for a 20-person sales team.");
    expect(p.rules).toEqual(["R0", "R1", "R2"]);
    expect(p.dated[0]).toMatchObject({ start: "2026-11-09" });
    expect(p.crossThread).toBe(true);
  });

  it('"you told me about Neon" → R2 with the topic term', () => {
    const p = plan("you told me about Neon, what was the price?");
    expect(p.rules).toEqual(["R0", "R2"]);
    expect(p.topicTerms).toContain("neon");
  });

  it('"still correct?" → R3 (intent flag)', () => {
    const p = plan("Is that still correct?", true);
    expect(p.rules).toEqual(["R0", "R3"]);
    expect(p.verify).toBe(true);
    // A verify request alone recalls nothing from other threads.
    expect(p.crossThread).toBe(false);
  });

  it("dated + verify → R1 and R3", () => {
    expect(plan("What did I ask you on 3 November? Is your answer still correct today?", true).rules).toEqual([
      "R0",
      "R1",
      "R3",
    ]);
  });

  it("a back-reference with no topic does not fire R2 (nothing to search for)", () => {
    expect(plan("what did I ask you?").rules).toEqual(["R0"]);
  });
});

describe("back-reference cues (D22)", () => {
  it.each([
    "you told me about Neon",
    "you said Supabase cost 25 dollars",
    "you recommended Pipedrive",
    "I asked you about Postgres hosting",
    "we discussed CRM tools",
    "we shortlisted five CRMs",
    "did I ask about Bun?",
    "remember the CRM list?",
    "last time you compared hosts",
  ])("matches %j", (msg) => {
    expect(hasBackReference(msg)).toBe(true);
  });

  it.each([
    "How should I structure our REST API errors?",
    "What changed in earlier versions of Node?",
    "What's the latest stable Node.js version?",
    "Can you compare Neon and Supabase?",
  ])("does not match %j", (msg) => {
    expect(hasBackReference(msg)).toBe(false);
  });
});

describe("topicTerms", () => {
  it("drops conversation verbs, time words and function words; stems for prefix match", () => {
    const msg = "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?";
    const times = resolveTimeRefs(msg, NOW, "Asia/Kolkata");
    // Stems are FTS prefixes: "postgr"* finds "Postgres", "pric"* finds "price".
    expect(topicTerms(msg, times)).toEqual(["postgr", "host", "pric"]);
  });

  it("returns nothing for a pure recall question", () => {
    expect(topicTerms("What did I ask you on 3 November? Is your answer still correct today?")).toEqual([]);
    expect(topicTerms("Summarise what we talked about this week.")).toEqual([]);
  });

  it("caps the number of terms and drops bare numbers", () => {
    const terms = topicTerms("alpha bravo charlie delta echo foxtrot golf hotel india juliet 2026 42");
    expect(terms).toHaveLength(8);
    expect(terms).not.toContain("2026");
  });
});
