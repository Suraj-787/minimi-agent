import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate, openDb } from "../src/db/index";
import { createThread, deleteThread, insertMessage } from "../src/db/repo";

const T = new Date("2026-11-03T05:00:00Z");
const tables = (db: ReturnType<typeof openDb>) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);

describe("migrate", () => {
  it("creates every SPEC §10 table", () => {
    const names = tables(openDb(":memory:"));
    for (const t of [
      "threads", "messages", "messages_fts", "turn_summaries", "claims",
      "memory_writes", "search_cache", "traces", "llm_cache",
    ]) expect(names).toContain(t);
  });

  it("is idempotent and keeps data", () => {
    const db = openDb(":memory:");
    createThread(db, { id: "t", createdAt: T });
    migrate(db);
    migrate(db);
    expect(db.prepare("SELECT count(*) AS n FROM threads").get()).toEqual({ n: 1 });
  });

  it("refuses a database from a newer schema", () => {
    const db = new Database(":memory:");
    db.pragma("user_version = 99");
    expect(() => migrate(db)).toThrow(/newer/);
  });
});

describe("FTS5 triggers", () => {
  const match = (db: ReturnType<typeof openDb>, q: string) =>
    db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?").all(q);

  it("indexes inserted messages and drops them when the thread is deleted", () => {
    const db = openDb(":memory:");
    createThread(db, { id: "t", createdAt: T });
    insertMessage(db, { threadId: "t", role: "user", text: "managed postgres hosting", tz: "UTC", createdAt: T });
    expect(match(db, '"postgres"')).toHaveLength(1);
    deleteThread(db, "t");
    expect(match(db, '"postgres"')).toHaveLength(0);
  });

  it("follows text updates", () => {
    const db = openDb(":memory:");
    createThread(db, { id: "t", createdAt: T });
    const m = insertMessage(db, { threadId: "t", role: "user", text: "alpha", tz: "UTC", createdAt: T });
    db.prepare("UPDATE messages SET text = 'beta' WHERE id = ?").run(m.id);
    expect(match(db, '"alpha"')).toHaveLength(0);
    expect(match(db, '"beta"')).toHaveLength(1);
  });
});

describe("migrate from older files", () => {
  it("adds threads.memory_forgotten_seq and traces.first_status_ms to a v1 database", () => {
    const db = openDb(":memory:");
    db.exec("ALTER TABLE threads DROP COLUMN memory_forgotten_seq; ALTER TABLE traces DROP COLUMN first_status_ms;");
    db.pragma("user_version = 1");
    migrate(db);
    const names = (t: string) => (db.pragma(`table_info(${t})`) as { name: string }[]).map((c) => c.name);
    expect(names("threads")).toContain("memory_forgotten_seq");
    expect(names("traces")).toContain("first_status_ms");
    expect(db.pragma("user_version", { simple: true })).toBe(3);
  });
});

