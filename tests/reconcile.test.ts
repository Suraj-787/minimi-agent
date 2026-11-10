import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db/index";
import { getClaim, insertClaim, memoryWritesForTurn, type ClaimRow } from "../src/db/memoryRepo";
import { normalizeValue, reconcileClaims, type ValidClaim } from "../src/memory/reconcile";

const T0 = new Date("2026-11-03T05:00:00Z");
const T1 = new Date("2026-11-12T05:30:00Z");

let db: Db;
let seeded: ClaimRow;
beforeEach(() => {
  db = openDb(":memory:");
  seeded = insertClaim(db, {
    entity: "Supabase",
    attribute: "cheapest paid plan price",
    value: "Pro plan, $25/month",
    sourceUrl: "https://supabase.com/pricing",
    turnId: "turn-0",
    threadId: "thread-0",
    observedAt: T0,
    validAsOf: "2026-11-03",
  });
});

const turn = { turnId: "turn-1", threadId: "thread-1", observedAt: T1 };
const claim = (over: Partial<ValidClaim> = {}): ValidClaim => ({
  entity: "Supabase",
  attribute: "cheapest paid plan price",
  value: "Pro plan, $25/month",
  sourceUrl: "https://supabase.com/pricing",
  validAsOf: "2026-11-12",
  ...over,
});
const all = () => db.prepare("SELECT * FROM claims ORDER BY observed_at").all() as ClaimRow[];

describe("reconcileClaims", () => {
  it("ADD: a new key inserts a current claim", () => {
    const [op] = reconcileClaims(db, turn, [claim({ entity: "Neon", value: "Launch plan, $19/month" })]);
    expect(op?.op).toBe("add");
    const row = getClaim(db, op?.claimId ?? "");
    expect(row).toMatchObject({ status: "current", key: "neon::cheapest paid plan price", valid_as_of: "2026-11-12" });
    expect(row?.observed_at).toBe(T1.toISOString());
    expect(all()).toHaveLength(2);
  });

  it("TOUCH: same key and same value only moves last_verified_at", () => {
    const [op] = reconcileClaims(db, turn, [claim({ value: "pro plan,  $25 / month." })]);
    expect(op).toEqual({ op: "touch", key: seeded.key, claimId: seeded.id });
    const row = getClaim(db, seeded.id);
    expect(row?.last_verified_at).toBe(T1.toISOString());
    expect(row?.observed_at).toBe(T0.toISOString());
    expect(row?.value).toBe("Pro plan, $25/month");
    expect(all()).toHaveLength(1);
  });

  it("SUPERSEDE: a different value inserts a new row and links the old one, which keeps its value", () => {
    const [op] = reconcileClaims(db, turn, [claim({ value: "Pro plan, $29/month" })]);
    expect(op?.op).toBe("supersede");
    const old = getClaim(db, seeded.id);
    expect(old).toMatchObject({ status: "superseded", superseded_by: op?.claimId, value: "Pro plan, $25/month" });
    expect(old?.superseded_at).toBe(T1.toISOString());
    expect(getClaim(db, op?.claimId ?? "")).toMatchObject({ status: "current", value: "Pro plan, $29/month" });
  });

  it.each([
    ["trailing space and case", "Supabase ", "Cheapest paid plan price"],
    ["hyphen vs space", "supabase", "cheapest-paid plan price"],
    ["extra punctuation", "Supabase.", "cheapest paid plan price:"],
  ])("key normalisation (%s) merges with the existing claim", (_l, entity, attribute) => {
    const [op] = reconcileClaims(db, turn, [claim({ entity, attribute })]);
    expect(op?.op).toBe("touch");
  });

  it('"Neon " vs "neon" and "Pro plan price" vs "pro-plan price" share one key', () => {
    reconcileClaims(db, turn, [claim({ entity: "Neon ", attribute: "Pro plan price", value: "$69" })]);
    const [op] = reconcileClaims(db, { ...turn, turnId: "turn-2" }, [claim({ entity: "neon", attribute: "pro-plan price", value: "$69" })]);
    expect(op?.op).toBe("touch");
  });

  it("rejects evidence dated before the value we already hold, and logs why", () => {
    const [op] = reconcileClaims(db, turn, [claim({ value: "Pro plan, $29/month", validAsOf: "2026-11-01" })]);
    expect(op).toEqual({ op: "rejected", key: seeded.key, claimId: seeded.id, reason: "older evidence" });
    expect(getClaim(db, seeded.id)?.status).toBe("current");
    expect(all()).toHaveLength(1);
    const [w] = memoryWritesForTurn(db, "turn-1");
    expect(w?.op).toBe("rejected");
    expect(JSON.parse(w?.detail_json ?? "{}")).toMatchObject({ reason: "older evidence" });
  });

  it("evidence dated the same day as the held value can still supersede", () => {
    const [op] = reconcileClaims(db, turn, [claim({ value: "Pro plan, $29/month", validAsOf: "2026-11-03" })]);
    expect(op?.op).toBe("supersede");
  });

  it("duplicate keys in one batch: the last one wins", () => {
    const ops = reconcileClaims(db, turn, [claim({ value: "$27" }), claim({ value: "Pro plan, $29/month" })]);
    expect(ops).toHaveLength(1);
    expect(getClaim(db, ops[0]?.claimId ?? "")?.value).toBe("Pro plan, $29/month");
  });

  it("logs every operation in memory_writes", () => {
    reconcileClaims(db, turn, [claim(), claim({ entity: "Neon", value: "$19" }), claim({ entity: "Render", value: "$7" })]);
    expect(memoryWritesForTurn(db, "turn-1").map((w) => w.op).sort()).toEqual(["add", "add", "touch"]);
  });
});

describe("normalizeValue", () => {
  it("ignores case, spacing and trailing punctuation but keeps currency and decimals", () => {
    expect(normalizeValue("$19 / Month.")).toBe(normalizeValue("$19/month"));
    expect(normalizeValue("€19")).not.toBe(normalizeValue("$19"));
    expect(normalizeValue("1.3")).not.toBe(normalizeValue("13"));
  });
});
