import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { openDb, type Db } from "../../src/db/index";
import { createThread, insertMessage, type MessageRow } from "../../src/db/repo";
import { addMs } from "../../src/lib/clock";
import { loadSeed, parseSeed, type SeedFile } from "../../scripts/seed";

/** Thursday 12 Nov 2026, 11:00 IST, the clock every acceptance case uses. */
export const SEED_NOW = new Date("2026-11-12T05:30:00Z");
export const IST = "Asia/Kolkata";

export function seedFile(): SeedFile {
  return parseSeed(JSON.parse(readFileSync(new URL("../../eval/seed.json", import.meta.url), "utf8")));
}

export function seededDb(now = SEED_NOW): Db {
  const db = openDb(":memory:");
  loadSeed(db, seedFile(), now);
  return db;
}

/** Adds one answered turn at `at` and returns both rows. */
export function addTurn(
  db: Db,
  input: { threadId?: string; user: string; answer: string; at: Date; tz?: string },
): { threadId: string; user: MessageRow; answer: MessageRow } {
  const threadId = input.threadId ?? randomUUID();
  const tz = input.tz ?? IST;
  if (!db.prepare("SELECT 1 FROM threads WHERE id = ?").get(threadId)) createThread(db, { id: threadId, createdAt: input.at });
  const user = insertMessage(db, { threadId, role: "user", text: input.user, tz, createdAt: input.at });
  const answer = insertMessage(db, { threadId, role: "assistant", text: input.answer, tz, createdAt: addMs(input.at, 1000) });
  return { threadId, user, answer };
}
