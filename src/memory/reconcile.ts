import type { Db } from "../db/index";
import {
  currentClaimsByKey,
  getClaim,
  insertClaim,
  insertMemoryWrite,
  markSuperseded,
  touchClaim,
} from "../db/memoryRepo";
import { claimKey } from "./claimKey";

/** A claim that already passed validation and the scanner, with a source from this turn. */
export interface ValidClaim {
  entity: string;
  attribute: string;
  value: string;
  sourceUrl: string;
  /** YYYY-MM-DD the evidence says the value holds (falls back to the turn's local date upstream). */
  validAsOf: string;
}

export interface ReconcileTurn {
  turnId: string;
  threadId: string;
  /** When the agent said it: becomes observed_at, and superseded_at / last_verified_at where they apply. */
  observedAt: Date;
}

export type ReconcileOp =
  | { op: "add"; key: string; claimId: string }
  | { op: "touch"; key: string; claimId: string }
  | { op: "supersede"; key: string; claimId: string; previousIds: string[] }
  | { op: "rejected"; key: string; claimId: string; reason: "older evidence" };

/**
 * Values compare equal when they differ only in case, spacing or trailing punctuation:
 * "$19 / month" = "$19/month". Currency symbols and decimals are kept, so "€19" ≠ "$19" and "1.3" ≠ "13".
 */
export function normalizeValue(v: string): string {
  return v
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[.,;:!]+$/, "");
}

/**
 * Deterministic merge by claim key (SPEC §7.3), no model call. One transaction per turn; every
 * operation lands in memory_writes. Duplicate keys within a batch: the last one wins.
 */
export function reconcileClaims(db: Db, turn: ReconcileTurn, claims: readonly ValidClaim[]): ReconcileOp[] {
  const byKey = new Map<string, ValidClaim>();
  for (const c of claims) byKey.set(claimKey(c.entity, c.attribute), c);

  return db.transaction((): ReconcileOp[] => {
    const ops: ReconcileOp[] = [];
    for (const [key, c] of byKey) {
      const op = reconcileOne(db, turn, key, c);
      insertMemoryWrite(db, {
        turnId: turn.turnId,
        op: op.op,
        claimId: op.claimId,
        detail: {
          key,
          value: c.value,
          ...(op.op === "supersede" ? { previousIds: op.previousIds } : {}),
          ...(op.op === "rejected" ? { reason: op.reason, validAsOf: c.validAsOf } : {}),
        },
        createdAt: turn.observedAt,
      });
      ops.push(op);
    }
    return ops;
  })();
}

function reconcileOne(db: Db, turn: ReconcileTurn, key: string, c: ValidClaim): ReconcileOp {
  const currents = currentClaimsByKey(db, key);
  const latest = currents[0];
  const insert = () =>
    insertClaim(db, {
      entity: c.entity,
      attribute: c.attribute,
      value: c.value,
      sourceUrl: c.sourceUrl,
      turnId: turn.turnId,
      threadId: turn.threadId,
      observedAt: turn.observedAt,
      validAsOf: c.validAsOf,
    });

  if (!latest) return { op: "add", key, claimId: insert().id };

  if (normalizeValue(latest.value) === normalizeValue(c.value)) {
    touchClaim(db, latest.id, turn.observedAt);
    return { op: "touch", key, claimId: latest.id };
  }

  // A page dated before what we already hold must not replace it: newer evidence wins, not the newer turn.
  if (latest.valid_as_of && c.validAsOf < latest.valid_as_of) {
    return { op: "rejected", key, claimId: latest.id, reason: "older evidence" };
  }

  const next = insert();
  for (const old of currents) markSuperseded(db, old.id, next.id, turn.observedAt);
  return { op: "supersede", key, claimId: next.id, previousIds: currents.map((o) => o.id) };
}

/**
 * TOUCH by id, for claims the verify table marked Unchanged (D43): the answer re-checked the value and
 * found it the same, so only last_verified_at moves, whatever wording the extractor produced. Superseded
 * or forgotten claims are left alone.
 */
export function touchVerified(db: Db, turn: ReconcileTurn, ids: readonly string[]): ReconcileOp[] {
  return db.transaction((): ReconcileOp[] => {
    const ops: ReconcileOp[] = [];
    for (const id of new Set(ids)) {
      const c = getClaim(db, id);
      if (!c || c.status !== "current") continue;
      touchClaim(db, id, turn.observedAt);
      insertMemoryWrite(db, {
        turnId: turn.turnId,
        op: "touch",
        claimId: id,
        detail: { key: c.key, value: c.value, reason: "verify table: Unchanged" },
        createdAt: turn.observedAt,
      });
      ops.push({ op: "touch", key: c.key, claimId: id });
    }
    return ops;
  })();
}
