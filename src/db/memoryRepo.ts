import { randomUUID } from "node:crypto";
import type { Db } from "./index";
import { claimKey } from "../memory/claimKey";

// Read and write functions for the memory tables (turn summaries, claims, memory_writes, traces).
// Kept apart from repo.ts (threads + messages) because this is the ledger side of the schema.

// ── turns ────────────────────────────────────────────────────────────────

/** A turn = a user message plus the assistant row that answered it. `turnId` is the assistant id. */
export interface TurnRow {
  userSeq: number;
  threadId: string;
  userText: string;
  createdAt: string; // UTC ISO of the user message
  localDate: string; // the user's local day when they asked
  tz: string;
  turnId: string;
  answerText: string;
  summary: string | null;
}

// The answer is the first assistant row after the user message. Error rows hold our apology, not an
// answer, so those turns are not recallable. An in-flight turn (no assistant yet) never matches.
const TURN_SELECT = `
  SELECT u.seq AS userSeq, u.thread_id AS threadId, u.text AS userText, u.created_at AS createdAt,
         u.local_date AS localDate, u.tz AS tz, a.id AS turnId, a.text AS answerText, s.summary AS summary
  FROM messages u
  JOIN messages a ON a.seq = (
    SELECT MIN(x.seq) FROM messages x WHERE x.thread_id = u.thread_id AND x.role = 'assistant' AND x.seq > u.seq
  )
  LEFT JOIN turn_summaries s ON s.turn_id = a.id
  WHERE u.role = 'user' AND a.status != 'error'`;

/** Turns asked on local days `from`..`to` (inclusive), in any thread, oldest first. */
export function turnsInRange(db: Db, from: string, to: string): TurnRow[] {
  return db
    .prepare(`${TURN_SELECT} AND u.local_date BETWEEN ? AND ? ORDER BY u.local_date, u.created_at, u.seq`)
    .all(from, to) as TurnRow[];
}

export function turnsByUserSeqs(db: Db, seqs: readonly number[]): TurnRow[] {
  if (seqs.length === 0) return [];
  const marks = seqs.map(() => "?").join(",");
  return db
    .prepare(`${TURN_SELECT} AND u.seq IN (${marks}) ORDER BY u.local_date, u.created_at, u.seq`)
    .all(...seqs) as TurnRow[];
}

/** FTS5 query text: one quoted token used as a prefix. Quoting stops user text from being read as FTS syntax. */
export function ftsPrefix(term: string): string {
  return `"${term.replace(/"/g, '""')}"*`;
}

const MAX_HITS_PER_TERM = 200;

/**
 * For each turn whose user message or answer mentions a term, how many DISTINCT terms it matched.
 * Keyed by the turn's user-message seq. One small query per term (≤ 8), all on the FTS index.
 */
export function topicTurnScores(db: Db, terms: readonly string[]): Map<number, number> {
  const stmt = db.prepare(`
    SELECT DISTINCT CASE WHEN m.role = 'user' THEN m.seq ELSE (
      SELECT MAX(p.seq) FROM messages p WHERE p.thread_id = m.thread_id AND p.role = 'user' AND p.seq < m.seq
    ) END AS userSeq
    FROM messages_fts f JOIN messages m ON m.seq = f.rowid
    WHERE messages_fts MATCH ? LIMIT ${MAX_HITS_PER_TERM}`);
  const scores = new Map<number, number>();
  for (const term of terms) {
    for (const row of stmt.all(ftsPrefix(term)) as { userSeq: number | null }[]) {
      if (row.userSeq !== null) scores.set(row.userSeq, (scores.get(row.userSeq) ?? 0) + 1);
    }
  }
  return scores;
}

// ── turn summaries ───────────────────────────────────────────────────────

export function insertTurnSummary(
  db: Db,
  s: { turnId: string; threadId: string; localDate: string; summary: string; createdAt: Date },
): void {
  db.prepare(
    `INSERT INTO turn_summaries (turn_id, thread_id, local_date, summary, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(s.turnId, s.threadId, s.localDate, s.summary, s.createdAt.toISOString());
}

// ── claims ───────────────────────────────────────────────────────────────

export type ClaimStatus = "current" | "superseded" | "forgotten";

export interface ClaimRow {
  id: string;
  key: string;
  entity: string;
  attribute: string;
  value: string;
  source_url: string | null;
  turn_id: string;
  thread_id: string;
  observed_at: string;
  valid_as_of: string | null;
  last_verified_at: string;
  superseded_by: string | null;
  superseded_at: string | null;
  status: ClaimStatus;
}

export interface NewClaim {
  entity: string;
  attribute: string;
  value: string;
  sourceUrl?: string | null;
  turnId: string;
  threadId: string;
  observedAt: Date;
  validAsOf?: string | null;
}

/** Inserts a current claim. Claims are only ever added or superseded, never edited in place (rule 10). */
export function insertClaim(db: Db, c: NewClaim): ClaimRow {
  const id = randomUUID();
  const observed = c.observedAt.toISOString();
  db.prepare(
    `INSERT INTO claims (id, key, entity, attribute, value, source_url, turn_id, thread_id,
                         observed_at, valid_as_of, last_verified_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'current')`,
  ).run(
    id,
    claimKey(c.entity, c.attribute),
    c.entity,
    c.attribute,
    c.value,
    c.sourceUrl ?? null,
    c.turnId,
    c.threadId,
    observed,
    c.validAsOf ?? null,
    observed,
  );
  return db.prepare("SELECT * FROM claims WHERE id = ?").get(id) as ClaimRow;
}

/**
 * Claims said in these turns, current AND superseded (so "it was $25 then" stays visible), never
 * forgotten ones: forgetting is the user's explicit choice.
 */
export function claimsForTurns(db: Db, turnIds: readonly string[]): ClaimRow[] {
  if (turnIds.length === 0) return [];
  const marks = turnIds.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT * FROM claims WHERE turn_id IN (${marks}) AND status != 'forgotten'
       ORDER BY turn_id, CASE status WHEN 'current' THEN 0 ELSE 1 END, observed_at, rowid`,
    )
    .all(...turnIds) as ClaimRow[];
}

// ── memory_writes ────────────────────────────────────────────────────────

export type MemoryOp = "add" | "touch" | "supersede" | "forget" | "rejected" | "error";

export function insertMemoryWrite(
  db: Db,
  w: { turnId: string | null; op: MemoryOp; claimId?: string | null; detail?: unknown; createdAt: Date },
): void {
  db.prepare(
    `INSERT INTO memory_writes (id, turn_id, op, claim_id, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    w.turnId,
    w.op,
    w.claimId ?? null,
    w.detail === undefined ? null : JSON.stringify(w.detail),
    w.createdAt.toISOString(),
  );
}

// ── traces ───────────────────────────────────────────────────────────────

export interface NewTrace {
  turnId: string;
  threadId: string;
  intent: unknown;
  resolvedDates: unknown;
  recallRules: unknown;
  memoryIds: unknown;
  memoryChars: number;
  contextMs: number;
  errors?: unknown;
  createdAt: Date;
}

/** Later phases add queries, provider, latencies and usage to the same row (upsert on turn_id). */
export function insertTrace(db: Db, t: NewTrace): void {
  db.prepare(
    `INSERT INTO traces (turn_id, thread_id, intent_json, resolved_dates_json, recall_rules_json, memory_ids_json,
                         memory_chars, context_ms, errors_json, created_at)
     VALUES (@turn_id, @thread_id, @intent_json, @resolved_dates_json, @recall_rules_json, @memory_ids_json,
             @memory_chars, @context_ms, @errors_json, @created_at)
     ON CONFLICT(turn_id) DO UPDATE SET
       intent_json = excluded.intent_json, resolved_dates_json = excluded.resolved_dates_json,
       recall_rules_json = excluded.recall_rules_json, memory_ids_json = excluded.memory_ids_json,
       memory_chars = excluded.memory_chars, context_ms = excluded.context_ms, errors_json = excluded.errors_json`,
  ).run({
    turn_id: t.turnId,
    thread_id: t.threadId,
    intent_json: JSON.stringify(t.intent),
    resolved_dates_json: JSON.stringify(t.resolvedDates),
    recall_rules_json: JSON.stringify(t.recallRules),
    memory_ids_json: JSON.stringify(t.memoryIds),
    memory_chars: t.memoryChars,
    context_ms: Math.round(t.contextMs),
    errors_json: t.errors === undefined ? null : JSON.stringify(t.errors),
    created_at: t.createdAt.toISOString(),
  });
}

export interface TraceRow {
  turn_id: string;
  thread_id: string;
  intent_json: string | null;
  resolved_dates_json: string | null;
  recall_rules_json: string | null;
  memory_ids_json: string | null;
  memory_chars: number | null;
  context_ms: number | null;
}

export function getTrace(db: Db, turnId: string): TraceRow | undefined {
  return db.prepare("SELECT * FROM traces WHERE turn_id = ?").get(turnId) as TraceRow | undefined;
}
