import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { humanDate, loadSeed, removeDbFiles } from "../scripts/seed";
import { openDb } from "../src/db/index";
import { listMessages, listThreads } from "../src/db/repo";
import { SEED_NOW, seedFile, seededDb } from "./helpers/seed";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("loadSeed (NOW = Thu 12 Nov 2026 11:00 IST)", () => {
  it("creates one UUID thread per seed thread, keeping the titles", () => {
    const threads = listThreads(seededDb());
    expect(threads).toHaveLength(4);
    for (const t of threads) expect(t.id).toMatch(UUID);
    expect(threads.map((t) => t.title).sort()).toEqual([
      "CRM shortlist for sales team",
      "Half-marathon pacing",
      "Is Bun production-ready?",
      "Managed Postgres hosting",
    ]);
  });

  it("dates turns daysAgo before now in the seed timezone, with UTC created_at", () => {
    const db = seededDb();
    const rows = db
      .prepare("SELECT role, local_date, created_at, text FROM messages WHERE role = 'user' ORDER BY created_at")
      .all() as { local_date: string; created_at: string; text: string }[];
    expect(rows.map((r) => r.local_date)).toEqual(["2026-11-03", "2026-11-03", "2026-11-09", "2026-11-10"]);
    // 10:14 IST on 3 Nov = 04:44 UTC.
    expect(rows[0]?.created_at).toBe("2026-11-03T04:44:00.000Z");
  });

  it("replaces {{date}} and stores sources as numbered source-url parts", () => {
    const db = seededDb();
    const pg = listThreads(db).find((t) => t.title === "Managed Postgres hosting");
    const answer = listMessages(db, pg?.id ?? "").find((m) => m.role === "assistant");
    expect(answer?.text).toContain("As of 3 Nov 2026.");
    expect(answer?.text).not.toContain("{{date}}");
    const parts = JSON.parse(answer?.parts_json ?? "[]") as { type: string; url?: string; providerMetadata?: { search: { n: number } } }[];
    expect(parts.filter((p) => p.type === "source-url").map((p) => [p.providerMetadata?.search.n, p.url])).toEqual([
      [1, "https://neon.com/pricing"],
      [2, "https://supabase.com/pricing"],
      [3, "https://render.com/pricing"],
    ]);
  });

  it("writes summaries and current claims dated to the turn, each logged in memory_writes", () => {
    const db = seededDb();
    expect(db.prepare("SELECT COUNT(*) AS n FROM turn_summaries").get()).toEqual({ n: 4 });
    const claims = db.prepare("SELECT * FROM claims").all() as { key: string; status: string; observed_at: string; valid_as_of: string; last_verified_at: string; entity: string }[];
    expect(claims).toHaveLength(9);
    for (const c of claims) {
      expect(c.status).toBe("current");
      expect(c.last_verified_at).toBe(c.observed_at);
    }
    const neon = claims.find((c) => c.entity === "Neon");
    expect(neon?.key).toBe("neon::cheapest paid plan price");
    expect(neon?.valid_as_of).toBe("2026-11-03");
    expect(neon?.observed_at.startsWith("2026-11-03")).toBe(true);
    const writes = db.prepare("SELECT op, detail_json FROM memory_writes").all() as { op: string; detail_json: string }[];
    expect(writes).toHaveLength(9);
    expect(writes.every((w) => w.op === "add" && JSON.parse(w.detail_json).source === "seed")).toBe(true);
  });

  it("is idempotent: a second load skips threads that already exist", () => {
    const db = seededDb();
    const again = loadSeed(db, seedFile(), SEED_NOW);
    expect(again.threads).toEqual([]);
    expect(again.skipped).toHaveLength(4);
    expect(listThreads(db)).toHaveLength(4);
  });

  it("humanDate formats the {{date}} token", () => {
    expect(humanDate("2026-11-03")).toBe("3 Nov 2026");
  });
});

describe("--reset", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("removing the DB files and reseeding gives the same state every time", () => {
    dir = mkdtempSync(join(tmpdir(), "minimi-seed-"));
    const path = join(dir, "agent.db");
    for (let i = 0; i < 2; i++) {
      removeDbFiles(path);
      const db = openDb(path);
      loadSeed(db, seedFile(), SEED_NOW);
      expect(listThreads(db)).toHaveLength(4);
      expect(db.prepare("SELECT COUNT(*) AS n FROM claims").get()).toEqual({ n: 9 });
      db.close();
    }
  });
});
