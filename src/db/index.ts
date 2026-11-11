import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export type Db = Database.Database;

const SCHEMA_VERSION = 4;

/** Idempotent: safe to call on every boot and on an already-migrated file. */
export function migrate(db: Db): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  if (current > SCHEMA_VERSION) {
    throw new Error(`database schema v${current} is newer than this code (v${SCHEMA_VERSION})`);
  }
  // schema.sql is all IF NOT EXISTS, so re-running it is the v0 → v1 step and a no-op after that.
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  // v1 → v2: threads.memory_forgotten_seq. CREATE TABLE IF NOT EXISTS does not add columns to an old file.
  const cols = db.pragma("table_info(threads)") as { name: string }[];
  if (!cols.some((c) => c.name === "memory_forgotten_seq")) {
    db.exec("ALTER TABLE threads ADD COLUMN memory_forgotten_seq INTEGER");
  }
  // v2 → v3: traces.first_status_ms.
  const traceCols = db.pragma("table_info(traces)") as { name: string }[];
  if (!traceCols.some((c) => c.name === "first_status_ms")) {
    db.exec("ALTER TABLE traces ADD COLUMN first_status_ms INTEGER");
  }
  // v3 → v4: traces.steps_json (per-step model/search timing).
  if (!(db.pragma("table_info(traces)") as { name: string }[]).some((c) => c.name === "steps_json")) {
    db.exec("ALTER TABLE traces ADD COLUMN steps_json TEXT");
  }
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

/** `:memory:` is allowed so tests get a fresh database per case. */
export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}
