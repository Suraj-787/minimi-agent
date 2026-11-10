import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export type Db = Database.Database;

const SCHEMA_VERSION = 1;

/** Idempotent: safe to call on every boot and on an already-migrated file. */
export function migrate(db: Db): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  if (current > SCHEMA_VERSION) {
    throw new Error(`database schema v${current} is newer than this code (v${SCHEMA_VERSION})`);
  }
  // schema.sql is all IF NOT EXISTS, so re-running it is the v0 → v1 step and a no-op after that.
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
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
