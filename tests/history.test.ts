import { describe, expect, it } from "vitest";
import { trimHistory } from "../src/agent/history";

type R = { role: "user" | "assistant"; text: string; status: "complete" | "partial" | "error" };
const u = (text: string): R => ({ role: "user", text, status: "complete" });
const a = (text: string, status: R["status"] = "complete"): R => ({ role: "assistant", text, status });

describe("trimHistory", () => {
  it("keeps everything under the caps", () => {
    expect(trimHistory([u("q1"), a("a1"), u("q2")]).map((m) => m.text)).toEqual(["q1", "a1", "q2"]);
  });

  it("never starts with an assistant message after the char cap cuts mid-pair", () => {
    // Budget fits [a1, u2] but not u1, so the cut lands on a1, which must be dropped.
    const out = trimHistory([u("x".repeat(50)), a("a1"), u("u2")], 12, 10);
    expect(out[0]?.role).toBe("user");
    expect(out.map((m) => m.text)).toEqual(["u2"]);
  });

  it("never starts with an assistant message after the message cap cuts mid-pair", () => {
    const out = trimHistory([u("q1"), a("a1"), u("q2"), a("a2"), u("q3")], 4);
    expect(out[0]?.role).toBe("user");
    expect(out.map((m) => m.text)).toEqual(["q2", "a2", "q3"]);
  });

  it("always keeps the current user message, even when it alone exceeds the cap", () => {
    const big = "y".repeat(500);
    expect(trimHistory([u("old"), a("old a"), u(big)], 12, 100).map((m) => m.text)).toEqual([big]);
  });

  it("drops failed assistant rows and merges the user turns around them", () => {
    const out = trimHistory([u("q1"), a("⚠️ rate limited", "error"), u("q2")]);
    expect(out).toEqual([{ role: "user", text: "q1\n\nq2" }]);
  });

  it("keeps partial assistant rows", () => {
    expect(trimHistory([u("q1"), a("half", "partial"), u("q2")]).map((m) => m.role)).toEqual([
      "user", "assistant", "user",
    ]);
  });

  it("returns [] for no rows", () => {
    expect(trimHistory([])).toEqual([]);
  });
});
