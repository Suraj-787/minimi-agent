import type { Hono } from "hono";
import type { Db } from "../db/index";
import {
  claimHistory,
  forgetClaimChain,
  forgetThreadMemory,
  getClaim,
  getTrace,
  memoryWritesForTurn,
  panelClaims,
  type MemoryWriteRow,
  type TraceRow,
} from "../db/memoryRepo";
import { getThread } from "../db/repo";
import { SCAN_REASONS } from "../memory/scan";

// Memory panel and "why?" drawer endpoints (SPEC §11). Both are read-mostly views over our own tables.
// Neither touches env or config, and the debug payload is built field by field from the trace row, so
// no key can leak into it (D49).

function parse(json: string | null): unknown {
  if (json === null) return undefined;
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

const MAX_LISTED = 25;
const clip = (s: string, n = 160): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/** What a recalled turn or claim looks like in the drawer: words, never raw ids. */
function describeMemory(db: Db, ids: { turns?: string[]; inThreadTurns?: string[]; claims?: string[] }) {
  const turnStmt = db.prepare(
    `SELECT u.local_date AS date, COALESCE(s.summary, u.text) AS text, a.thread_id AS threadId
     FROM messages a
     JOIN messages u ON u.seq = (SELECT MAX(x.seq) FROM messages x WHERE x.thread_id = a.thread_id AND x.role = 'user' AND x.seq < a.seq)
     LEFT JOIN turn_summaries s ON s.turn_id = a.id
     WHERE a.id = ?`,
  );
  const describeTurn = (id: string) => {
    const row = turnStmt.get(id) as { date: string; text: string } | undefined;
    return row ? { date: row.date, text: clip(row.text) } : { date: null, text: "(turn no longer exists)" };
  };
  const claims = (ids.claims ?? []).slice(0, MAX_LISTED).map((id) => {
    const c = getClaim(db, id);
    return c
      ? { entity: c.entity, attribute: c.attribute, value: c.value, status: c.status, said: c.observed_at.slice(0, 10) }
      : { entity: "(claim no longer exists)", attribute: "", value: "", status: "forgotten" as const, said: "" };
  });
  return {
    turns: (ids.turns ?? []).slice(0, MAX_LISTED).map(describeTurn),
    inThreadTurns: (ids.inThreadTurns ?? []).slice(0, MAX_LISTED).map(describeTurn),
    claims,
    claimsTotal: ids.claims?.length ?? 0,
  };
}

/**
 * blocked = the injection scanner stopped it. skipped = a policy check declined it (table says Unchanged,
 * older evidence, unsourced, hedged value…). The distinction matters: a "blocked" is worth a look.
 */
export function labelWrite(row: MemoryWriteRow, db?: Db) {
  const detail = (parse(row.detail_json) ?? {}) as Record<string, unknown>;
  // Key and value for every row (item 3): from the logged detail, else from the claim the row points at.
  const claim = db && row.claim_id ? getClaim(db, row.claim_id) : undefined;
  const key = typeof detail.key === "string" ? detail.key : claim?.key;
  const value = typeof detail.value === "string" ? detail.value : claim?.value;
  const previous =
    db && Array.isArray(detail.previousIds)
      ? detail.previousIds.flatMap((id) => {
          const old = typeof id === "string" ? getClaim(db, id) : undefined;
          return old ? [old.value] : [];
        })
      : [];
  const reason = typeof detail.reason === "string" ? detail.reason : undefined;
  const label =
    row.op === "rejected"
      ? reason && SCAN_REASONS.has(reason)
        ? "blocked"
        : "skipped"
      : row.op === "error"
        ? "failed"
        : row.op === "add"
          ? "added"
          : row.op === "touch"
            ? "re-verified"
            : row.op === "supersede"
              ? "superseded"
              : "forgotten";
  return {
    op: row.op,
    label,
    ...(key ? { key } : {}),
    ...(value ? { value } : {}),
    ...(previous.length > 0 ? { previous } : {}),
    ...(reason ? { reason } : {}),
    ...(typeof detail.field === "string" ? { field: detail.field } : {}),
    ...(typeof detail.text === "string" ? { text: detail.text } : {}),
    ...(typeof detail.stage === "string" ? { stage: detail.stage } : {}),
  };
}

export function buildDebug(db: Db, trace: TraceRow) {
  const memoryIds = (parse(trace.memory_ids_json) ?? {}) as {
    turns?: string[];
    inThreadTurns?: string[];
    claims?: string[];
    claimsAtRecall?: { entity: string; attribute: string; value: string; status: string; said: string }[];
    omittedTurns?: number;
  };
  const described = describeMemory(db, memoryIds);
  return {
    turnId: trace.turn_id,
    createdAt: trace.created_at,
    intent: parse(trace.intent_json) ?? null,
    resolvedDates: parse(trace.resolved_dates_json) ?? null,
    recallRules: parse(trace.recall_rules_json) ?? [],
    memory: {
      ...described,
      // Status as it was WHEN recalled (a claim may have been superseded or forgotten since). Older traces
      // without the snapshot fall back to the live rows.
      ...(memoryIds.claimsAtRecall ? { claims: memoryIds.claimsAtRecall.slice(0, MAX_LISTED) } : {}),
      omittedTurns: memoryIds.omittedTurns ?? 0,
      chars: trace.memory_chars ?? 0,
    },
    queries: parse(trace.queries_json) ?? [],
    provider: trace.provider,
    timings: { contextMs: trace.context_ms, firstStatusMs: trace.first_status_ms, firstTokenMs: trace.first_token_ms, totalMs: trace.total_ms },
    usage: parse(trace.usage_json) ?? null,
    errors: parse(trace.errors_json) ?? [],
    // Written after the reply, so read live rather than stored in the trace row.
    memoryWrites: memoryWritesForTurn(db, trace.turn_id).map((w) => labelWrite(w, db)),
  };
}

export function mountMemoryRoutes(app: Hono, db: Db, now: () => Date): void {
  app.get("/api/debug/:turnId", (c) => {
    const trace = getTrace(db, c.req.param("turnId"));
    return trace ? c.json(buildDebug(db, trace)) : c.json({ error: "No trace for this turn" }, 404);
  });

  app.get("/api/memory", (c) => {
    const status = c.req.query("status") === "all" ? "all" : "current";
    const claims = panelClaims(db, status);
    const history = claimHistory(db, claims.map((cl) => cl.key));
    const days = new Map<string, unknown[]>();
    for (const cl of claims) {
      const chain = (history.get(cl.key) ?? [])
        .filter((h) => h.id !== cl.id && h.status === "superseded")
        .map((h) => ({ value: h.value, said: h.observed_at.slice(0, 10), until: h.superseded_at?.slice(0, 10) ?? null }));
      const entry = {
        id: cl.id,
        entity: cl.entity,
        attribute: cl.attribute,
        value: cl.value,
        sourceUrl: cl.source_url,
        status: cl.status,
        said: cl.observed_at.slice(0, 10),
        validAsOf: cl.valid_as_of,
        lastVerified: cl.last_verified_at.slice(0, 10),
        threadId: cl.thread_id,
        threadTitle: cl.thread_title,
        // Only a current claim carries its chain; a superseded row is itself a link in it.
        previously: cl.status === "current" ? chain : [],
      };
      days.set(cl.day, [...(days.get(cl.day) ?? []), entry]);
    }
    return c.json({ days: [...days.entries()].map(([date, items]) => ({ date, claims: items })) });
  });

  app.delete("/api/memory/claims/:id", (c) => {
    const forgotten = forgetClaimChain(db, c.req.param("id"), now());
    return forgotten.length > 0 ? c.json({ forgotten: forgotten.length }) : c.json({ error: "Claim not found" }, 404);
  });

  app.delete("/api/memory/threads/:id", (c) => {
    const id = c.req.param("id");
    if (!getThread(db, id)) return c.json({ error: "Thread not found" }, 404);
    return c.json(forgetThreadMemory(db, id, now()));
  });
}
