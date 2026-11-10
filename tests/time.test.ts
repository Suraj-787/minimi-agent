import { describe, expect, it } from "vitest";
import { resolveTimeRefs, type TimeRef } from "../src/agent/time";

// Thursday 12 Nov 2026, 11:00 IST: 3 Nov = Tue, 9 Nov = Mon, 10 Nov = Tue.
const NOW = new Date("2026-11-12T05:30:00Z");
const IST = "Asia/Kolkata";
const resolve = (msg: string, now = NOW, tz = IST): TimeRef[] => resolveTimeRefs(msg, now, tz);

describe("resolveTimeRefs", () => {
  it.each<[string, Partial<TimeRef>[]]>([
    ["What did I ask you on 3 November?", [{ start: "2026-11-03", end: "2026-11-03" }]],
    ["Nov 3", [{ start: "2026-11-03", end: "2026-11-03" }]],
    ["2026-11-03", [{ start: "2026-11-03", end: "2026-11-03" }]],
    ["yesterday", [{ text: "yesterday", start: "2026-11-11", end: "2026-11-11" }]],
    ["3 days ago", [{ start: "2026-11-09", end: "2026-11-09" }]],
    ["What did we discuss today?", [{ start: "2026-11-12", end: "2026-11-12" }]],
    ["on Monday", [{ text: "on Monday", start: "2026-11-09", end: "2026-11-09", candidates: ["2026-11-09", "2026-11-02"] }]],
    ["Last Tuesday I asked you about Postgres", [{ text: "Last Tuesday", start: "2026-11-10", candidates: ["2026-11-10", "2026-11-03"] }]],
    ["since Monday", [{ text: "since Monday", start: "2026-11-09", end: "2026-11-09", since: true }]],
    ["Anything new since 3 Nov?", [{ text: "since 3 Nov", start: "2026-11-03", end: "2026-11-03", since: true }]],
    ["this week", [{ text: "this week", start: "2026-11-09", end: "2026-11-12" }]],
    ["earlier this week", [{ start: "2026-11-09", end: "2026-11-11" }]],
    ["last week", [{ start: "2026-11-02", end: "2026-11-08" }]],
    ["what did I ask in October", [{ start: "2026-10-01", end: "2026-10-31" }]],
    ["Nov 3-5", [{ start: "2026-11-03", end: "2026-11-05" }]],
  ])("%s", (msg, expected) => {
    expect(resolve(msg)).toMatchObject(expected);
    expect(resolve(msg)).toHaveLength(expected.length);
  });

  it("a date with no year is the most recent past occurrence", () => {
    expect(resolve("what about December 20")).toMatchObject([{ start: "2025-12-20" }]);
    expect(resolve("1 October")).toMatchObject([{ start: "2026-10-01" }]);
  });

  it("an explicit future year is not a lookup", () => {
    expect(resolve("on 20 December 2026")).toEqual([]);
  });

  it("a bare weekday equal to today's is the one a week ago, never today (D21)", () => {
    // NOW is a Thursday.
    expect(resolve("on Thursday")).toMatchObject([
      { start: "2026-11-05", candidates: ["2026-11-05", "2026-10-29"] },
    ]);
  });

  it("weekdays: next <weekday> is the future and resolves to nothing", () => {
    expect(resolve("next Monday")).toEqual([]);
  });

  it.each(["the other day", "a few days ago", "a couple of weeks ago", "recently", "lately", "a while back"])(
    "vague phrase %j resolves to no date",
    (phrase) => {
      expect(resolve(`I asked you about Neon ${phrase}`)).toEqual([]);
    },
  );

  it("now / right now is never a lookup", () => {
    expect(resolve("What's the cheapest Pipedrive plan right now?")).toEqual([]);
    expect(resolve("is it true now")).toEqual([]);
  });

  it("today is dropped only next to a verify cue", () => {
    expect(resolve("What did I ask you on 3 November? Is your answer still correct today?")).toMatchObject([
      { start: "2026-11-03" },
    ]);
    expect(resolve("What did I ask you on 3 November? Is your answer still correct today?")).toHaveLength(1);
    expect(resolve("Compare what I asked on 3 November with what I asked today")).toHaveLength(2);
  });

  it("a month name without a lead-in word is not a date", () => {
    expect(resolve("may I ask about March madness")).toEqual([]);
  });

  it("numbers that aren't dates are ignored", () => {
    expect(
      resolve("On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing since?"),
    ).toMatchObject([{ text: "On Monday", start: "2026-11-09" }]);
  });

  describe("timezone", () => {
    it("23:30 IST is still the same local day", () => {
      const lateNight = new Date("2026-11-03T18:00:00Z"); // 23:30 IST, Tue 3 Nov
      expect(resolve("today", lateNight)).toMatchObject([{ start: "2026-11-03" }]);
      expect(resolve("yesterday", lateNight)).toMatchObject([{ start: "2026-11-02" }]);
    });

    it("the same instant is a different day in New York", () => {
      const ny = new Date("2026-11-04T03:00:00Z"); // 22:00 Tue 3 Nov in New York
      expect(resolve("yesterday", ny, "America/New_York")).toMatchObject([{ start: "2026-11-02" }]);
      expect(resolve("last Tuesday", ny, "America/New_York")).toMatchObject([{ start: "2026-10-27" }]);
    });

    it("does not depend on the machine's timezone", () => {
      const before = process.env.TZ;
      process.env.TZ = "America/Los_Angeles";
      try {
        expect(resolve("yesterday")).toMatchObject([{ start: "2026-11-11" }]);
      } finally {
        process.env.TZ = before;
      }
    });
  });
});
