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
  WHERE u.role = 'user' AND a.status != 'error'
    AND u.seq > COALESCE((SELECT t.memory_forgotten_seq FROM threads t WHERE t.id = u.thread_id), 0)`;

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
  return getClaim(db, id) as ClaimRow;
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

/** Current claims for one merge key, newest first. Normally zero or one. */
export function currentClaimsByKey(db: Db, key: string): ClaimRow[] {
  return db
    .prepare(`SELECT * FROM claims WHERE key = ? AND status = 'current' ORDER BY observed_at DESC, rowid DESC`)
    .all(key) as ClaimRow[];
}

/** TOUCH: the same value was seen again in a sourced answer. Only the verification date moves. */
export function touchClaim(db: Db, id: string, verifiedAt: Date): void {
  db.prepare(`UPDATE claims SET last_verified_at = ? WHERE id = ?`).run(verifiedAt.toISOString(), id);
}

/** SUPERSEDE: the old row keeps its value and gains a pointer to its replacement (rule 10: never overwritten). */
export function markSuperseded(db: Db, id: string, by: string, at: Date): void {
  db.prepare(`UPDATE claims SET status = 'superseded', superseded_by = ?, superseded_at = ? WHERE id = ?`).run(
    by,
    at.toISOString(),
    id,
  );
}

/** Every non-forgotten claim for these keys, oldest first: the value history behind "previously: …". */
export function claimHistory(db: Db, keys: readonly string[]): Map<string, ClaimRow[]> {
  const out = new Map<string, ClaimRow[]>();
  if (keys.length === 0) return out;
  const unique = [...new Set(keys)];
  const marks = unique.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT * FROM claims WHERE key IN (${marks}) AND status != 'forgotten' ORDER BY observed_at, rowid`)
    .all(...unique) as ClaimRow[];
  for (const r of rows) out.set(r.key, [...(out.get(r.key) ?? []), r]);
  return out;
}

export function getClaim(db: Db, id: string): ClaimRow | undefined {
  return db.prepare("SELECT * FROM claims WHERE id = ?").get(id) as ClaimRow | undefined;
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

export interface MemoryWriteRow {
  id: string;
  turn_id: string | null;
  op: MemoryOp;
  claim_id: string | null;
  detail_json: string | null;
  created_at: string;
}

export function memoryWritesForTurn(db: Db, turnId: string): MemoryWriteRow[] {
  return db
    .prepare("SELECT * FROM memory_writes WHERE turn_id = ? ORDER BY created_at, rowid")
    .all(turnId) as MemoryWriteRow[];
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
  /** One entry per search query: provider that answered, cache hit, providers that failed first. */
  queries?: unknown;
  /** Provider that answered most queries (a quick "which search ran" for the drawer header). */
  provider?: string | null;
  firstStatusMs?: number | null;
  firstTokenMs?: number | null;
  totalMs?: number | null;
  usage?: unknown;
  errors?: unknown;
  createdAt: Date;
}

/** Later phases add queries, provider, latencies and usage to the same row (upsert on turn_id). */
export function insertTrace(db: Db, t: NewTrace): void {
  db.prepare(
    `INSERT INTO traces (turn_id, thread_id, intent_json, resolved_dates_json, recall_rules_json, memory_ids_json,
                         memory_chars, context_ms, queries_json, provider, first_status_ms, first_token_ms, total_ms, usage_json,
                         errors_json, created_at)
     VALUES (@turn_id, @thread_id, @intent_json, @resolved_dates_json, @recall_rules_json, @memory_ids_json,
             @memory_chars, @context_ms, @queries_json, @provider, @first_status_ms, @first_token_ms, @total_ms, @usage_json,
             @errors_json, @created_at)
     ON CONFLICT(turn_id) DO UPDATE SET
       intent_json = excluded.intent_json, resolved_dates_json = excluded.resolved_dates_json,
       recall_rules_json = excluded.recall_rules_json, memory_ids_json = excluded.memory_ids_json,
       memory_chars = excluded.memory_chars, context_ms = excluded.context_ms, queries_json = excluded.queries_json,
       provider = excluded.provider, first_status_ms = excluded.first_status_ms, first_token_ms = excluded.first_token_ms, total_ms = excluded.total_ms,
       usage_json = excluded.usage_json, errors_json = excluded.errors_json`,
  ).run({
    turn_id: t.turnId,
    thread_id: t.threadId,
    intent_json: JSON.stringify(t.intent),
    resolved_dates_json: JSON.stringify(t.resolvedDates),
    recall_rules_json: JSON.stringify(t.recallRules),
    memory_ids_json: JSON.stringify(t.memoryIds),
    memory_chars: t.memoryChars,
    context_ms: Math.round(t.contextMs),
    queries_json: t.queries === undefined ? null : JSON.stringify(t.queries),
    provider: t.provider ?? null,
    first_status_ms: t.firstStatusMs == null ? null : Math.round(t.firstStatusMs),
    first_token_ms: t.firstTokenMs == null ? null : Math.round(t.firstTokenMs),
    total_ms: t.totalMs == null ? null : Math.round(t.totalMs),
    usage_json: t.usage === undefined ? null : JSON.stringify(t.usage),
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
  queries_json: string | null;
  provider: string | null;
  first_status_ms: number | null;
  first_token_ms: number | null;
  total_ms: number | null;
  usage_json: string | null;
  errors_json: string | null;
  created_at: string;
}

export function getTrace(db: Db, turnId: string): TraceRow | undefined {
  return db.prepare("SELECT * FROM traces WHERE turn_id = ?").get(turnId) as TraceRow | undefined;
}

// ── memory panel: listing and forgetting ─────────────────────────────────

export interface PanelClaim extends ClaimRow {
  /** The local day the claim was said (its turn's local_date); falls back to the UTC day of observed_at. */
  day: string;
  thread_title: string | null;
}

/**
 * Non-forgotten claims for the panel, with the day and chat they came from. `current` hides superseded
 * rows; the chain is rebuilt by the caller from `claimHistory`.
 */
export function panelClaims(db: Db, status: "current" | "all"): PanelClaim[] {
  return db
    .prepare(
      `SELECT c.*, COALESCE(m.local_date, substr(c.observed_at, 1, 10)) AS day, t.title AS thread_title
       FROM claims c
       LEFT JOIN messages m ON m.id = c.turn_id
       LEFT JOIN threads t ON t.id = c.thread_id
       WHERE c.status != 'forgotten' ${status === "current" ? "AND c.status = 'current'" : ""}
       ORDER BY day DESC, c.observed_at DESC, c.rowid DESC`,
    )
    .all() as PanelClaim[];
}

/**
 * Forgets a claim AND every other row with its key, so a superseded predecessor can never come back as
 * "previously: …" or as a stale value (D48). Rows keep their data: only `status` changes, and each one is
 * logged as op='forget'. Returns the ids forgotten (empty if the claim is unknown or already forgotten).
 */
export function forgetClaimChain(db: Db, claimId: string, at: Date): string[] {
  const claim = getClaim(db, claimId);
  if (!claim) return [];
  return forgetKeys(db, [claim.key], at, { via: "claim", claimId });
}

/** Forgets one chat's memory: its claims (with their key chains), its summaries, and hides its turns from recall. */
export function forgetThreadMemory(db: Db, threadId: string, at: Date): { claims: number; summaries: number } {
  const run = db.transaction(() => {
    const keys = (db.prepare("SELECT DISTINCT key FROM claims WHERE thread_id = ?").all(threadId) as { key: string }[]).map(
      (r) => r.key,
    );
    const claims = forgetKeys(db, keys, at, { via: "thread", threadId }).length;
    const summaries = db.prepare("DELETE FROM turn_summaries WHERE thread_id = ?").run(threadId).changes;
    // Turns up to now stay in the chat but are no longer recalled into other chats.
    const last = db.prepare("SELECT MAX(seq) AS s FROM messages WHERE thread_id = ?").get(threadId) as { s: number | null };
    if (last.s !== null) db.prepare("UPDATE threads SET memory_forgotten_seq = ? WHERE id = ?").run(last.s, threadId);
    insertMemoryWrite(db, { turnId: null, op: "forget", detail: { scope: "thread", threadId, claims, summaries }, createdAt: at });
    return { claims, summaries };
  });
  return run();
}

function forgetKeys(db: Db, keys: readonly string[], at: Date, detail: Record<string, unknown>): string[] {
  if (keys.length === 0) return [];
  const marks = keys.map(() => "?").join(",");
  const forgotten: string[] = [];
  const run = db.transaction(() => {
    const rows = db
      .prepare(`SELECT id, key, turn_id, status FROM claims WHERE key IN (${marks}) AND status != 'forgotten'`)
      .all(...keys) as { id: string; key: string; turn_id: string; status: ClaimStatus }[];
    for (const r of rows) {
      db.prepare("UPDATE claims SET status = 'forgotten' WHERE id = ?").run(r.id);
      insertMemoryWrite(db, {
        turnId: r.turn_id,
        op: "forget",
        claimId: r.id,
        detail: { ...detail, key: r.key, was: r.status },
        createdAt: at,
      });
      forgotten.push(r.id);
    }
  });
  run();
  return forgotten;
}
