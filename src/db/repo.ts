import { randomUUID } from "node:crypto";
import type { Db } from "./index";
import { localDate } from "../lib/tz";

export type Role = "user" | "assistant";
export type MessageStatus = "complete" | "partial" | "error";

export interface ThreadRow {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  seq: number;
  id: string;
  thread_id: string;
  role: Role;
  text: string;
  parts_json: string | null;
  status: MessageStatus;
  created_at: string;
  local_date: string;
  tz: string;
}

// ── threads ──────────────────────────────────────────────────────────────

export function createThread(
  db: Db,
  input: { id?: string; title?: string; createdAt: Date },
): ThreadRow {
  const iso = input.createdAt.toISOString();
  const row: ThreadRow = {
    id: input.id ?? randomUUID(),
    title: input.title ?? "",
    created_at: iso,
    updated_at: iso,
  };
  db.prepare(
    "INSERT INTO threads (id, title, created_at, updated_at) VALUES (@id, @title, @created_at, @updated_at)",
  ).run(row);
  return row;
}

export function getThread(db: Db, id: string): ThreadRow | undefined {
  return db.prepare("SELECT * FROM threads WHERE id = ?").get(id) as ThreadRow | undefined;
}

/** Newest activity first, which is what a sidebar wants. */
export function listThreads(db: Db): ThreadRow[] {
  return db.prepare("SELECT * FROM threads ORDER BY updated_at DESC, rowid DESC").all() as ThreadRow[];
}

export function setThreadTitle(db: Db, id: string, title: string): void {
  db.prepare("UPDATE threads SET title = ? WHERE id = ?").run(title, id);
}

/** Cascades to messages (and their FTS rows and turn summaries). Claims are kept by design. */
export function deleteThread(db: Db, id: string): boolean {
  return db.prepare("DELETE FROM threads WHERE id = ?").run(id).changes > 0;
}

// ── messages ─────────────────────────────────────────────────────────────

export interface NewMessage {
  id?: string;
  threadId: string;
  role: Role;
  text: string;
  partsJson?: string | null;
  status?: MessageStatus;
  tz: string;
  createdAt: Date;
}

/** Stores UTC `created_at` plus the calendar day in the user's timezone (`local_date`). */
export function insertMessage(db: Db, m: NewMessage): MessageRow {
  const id = m.id ?? randomUUID();
  const createdAt = m.createdAt.toISOString();
  const insert = db.transaction(() => {
    db.prepare(
      `INSERT INTO messages (id, thread_id, role, text, parts_json, status, created_at, local_date, tz)
       VALUES (@id, @thread_id, @role, @text, @parts_json, @status, @created_at, @local_date, @tz)`,
    ).run({
      id,
      thread_id: m.threadId,
      role: m.role,
      text: m.text,
      parts_json: m.partsJson ?? null,
      status: m.status ?? "complete",
      created_at: createdAt,
      local_date: localDate(m.createdAt, m.tz),
      tz: m.tz,
    });
    db.prepare("UPDATE threads SET updated_at = ? WHERE id = ?").run(createdAt, m.threadId);
  });
  insert();
  return db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as MessageRow;
}

/** `seq` is the tiebreaker: with a frozen clock (NOW) every message shares one created_at. */
export function listMessages(db: Db, threadId: string): MessageRow[] {
  return db
    .prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY seq")
    .all(threadId) as MessageRow[];
}

/** The last `n` messages, returned oldest → newest. */
export function recentMessages(db: Db, threadId: string, n: number): MessageRow[] {
  const rows = db
    .prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY seq DESC LIMIT ?")
    .all(threadId, n) as MessageRow[];
  return rows.reverse();
}

export function hasAssistantReplyAfter(db: Db, userMessageId: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM messages a JOIN messages u ON u.id = ?
       WHERE a.thread_id = u.thread_id AND a.role = 'assistant' AND a.seq > u.seq LIMIT 1`,
    )
    .get(userMessageId);
  return row !== undefined;
}
