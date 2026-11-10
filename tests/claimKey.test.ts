import { describe, expect, it } from "vitest";
import { claimKey, normalizeKeyPart } from "../src/memory/claimKey";

describe("claimKey", () => {
  it("ignores case and surrounding whitespace", () => {
    expect(claimKey("Neon ", "price")).toBe(claimKey("neon", "price"));
  });

  it("treats punctuation like a space", () => {
    expect(claimKey("Neon", "Pro plan price")).toBe(claimKey("neon", "pro-plan price"));
  });

  it("collapses whitespace and keeps the two parts apart", () => {
    expect(normalizeKeyPart("  Zoho   CRM ")).toBe("zoho crm");
    expect(claimKey("Zoho CRM", "Professional price (annual)")).toBe("zoho crm::professional price annual");
  });

  it("different entities never share a key", () => {
    expect(claimKey("Neon", "price")).not.toBe(claimKey("Supabase", "price"));
  });
});
