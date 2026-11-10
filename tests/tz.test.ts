import { describe, expect, it } from "vitest";
import { isValidTimezone, localDate, localParts } from "../src/lib/tz";

describe("localDate", () => {
  it("23:30 IST is still the same local day (18:00Z)", () => {
    expect(localDate(new Date("2026-11-03T18:00:00Z"), "Asia/Kolkata")).toBe("2026-11-03");
  });
  it("18:31Z crosses midnight in IST", () => {
    expect(localDate(new Date("2026-11-03T18:31:00Z"), "Asia/Kolkata")).toBe("2026-11-04");
  });
  it("late evening UTC is still the previous day in New York", () => {
    expect(localDate(new Date("2026-11-04T03:00:00Z"), "America/New_York")).toBe("2026-11-03");
  });
});

describe("localParts", () => {
  it("renders weekday, time and offset", () => {
    expect(localParts(new Date("2026-11-12T05:30:00Z"), "Asia/Kolkata")).toEqual({
      date: "2026-11-12",
      time: "11:00",
      weekday: "Thursday",
      offset: "+05:30",
    });
  });
  it("renders UTC as +00:00", () => {
    expect(localParts(new Date("2026-11-12T00:00:00Z"), "UTC").offset).toBe("+00:00");
  });
});

describe("isValidTimezone", () => {
  it.each(["Asia/Kolkata", "America/New_York", "UTC"])("accepts %s", (tz) => {
    expect(isValidTimezone(tz)).toBe(true);
  });
  it.each(["", "Mars/Olympus", "not a zone", "x".repeat(100)])("rejects %j", (tz) => {
    expect(isValidTimezone(tz)).toBe(false);
  });
});
