import { describe, expect, it } from "vitest";
import { loadCases } from "../eval/cases";
import { seedFile } from "./helpers/seed";

describe("eval/cases.json", () => {
  const cases = loadCases();
  it("parses with unique ids", () => {
    expect(cases.length).toBeGreaterThanOrEqual(20);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });
  it("every forgetThreads label is a seed thread", () => {
    const labels = new Set(seedFile().threads.map((t) => t.id));
    for (const c of cases) for (const l of c.forgetThreads ?? []) expect(labels.has(l), `${c.id}: ${l}`).toBe(true);
  });
  it("every case has at least one hard check, so none can pass vacuously", () => {
    for (const c of cases) expect(Object.keys(c.checks).length, c.id).toBeGreaterThan(0);
  });
  it("A2, A3, A4 (the committed transcripts) use live search", () => {
    for (const id of ["A2-", "A3-", "A4-"]) expect(cases.find((c) => c.id.startsWith(id))?.mockSearch).toBeUndefined();
  });
});
