import { afterEach, describe, expect, it, vi } from "vitest";
import { now, resolveNow } from "../src/lib/clock";

const REAL = Date.UTC(2026, 0, 2, 3, 4, 5);

describe("resolveNow", () => {
  it("uses the real clock when NOW is unset or blank", () => {
    expect(resolveNow(undefined, () => REAL).getTime()).toBe(REAL);
    expect(resolveNow("  ", () => REAL).getTime()).toBe(REAL);
  });

  it("freezes to NOW, honouring the offset", () => {
    const d = resolveNow("2026-11-12T11:00:00+05:30", () => REAL);
    expect(d.toISOString()).toBe("2026-11-12T05:30:00.000Z");
  });

  it("accepts Z and ignores real time when frozen", () => {
    expect(resolveNow("2026-11-12T00:00:00Z", () => REAL).toISOString()).toBe(
      "2026-11-12T00:00:00.000Z",
    );
  });

  it.each(["yesterday", "2026-11-12", "2026-11-12T11:00:00", "2026-02-31T00:00:00Z"])(
    "rejects malformed NOW %s",
    (bad) => {
      expect(() => resolveNow(bad, () => REAL)).toThrow(/NOW=/);
    },
  );
});

describe("now()", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("reads the NOW env override", () => {
    vi.stubEnv("NOW", "2026-11-12T11:00:00+05:30");
    expect(now().toISOString()).toBe("2026-11-12T05:30:00.000Z");
  });

  it("returns a new Date each call so callers cannot mutate the clock", () => {
    vi.stubEnv("NOW", "2026-11-12T11:00:00+05:30");
    const a = now();
    a.setFullYear(1999);
    expect(now().getUTCFullYear()).toBe(2026);
  });
});
