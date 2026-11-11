import type { LanguageModel } from "ai";
import { z } from "zod";
import type { Db } from "../db/index";
import { insertMemoryWrite, insertTurnSummary } from "../db/memoryRepo";
import { isoDayFromMs } from "../lib/clock";
import { errorFields, log } from "../lib/log";
import { localDate } from "../lib/tz";
import { sourceMentionsVendor, type ResultText } from "../agent/answerChecks";
import { ExtractError, extractTurnMemory, type ExtractOptions, type Extraction } from "./extract";
import { claimKey, normalizeKeyPart } from "./claimKey";
import { reconcileClaims, touchVerified, type ReconcileOp, type ValidClaim } from "./reconcile";
import { scanText } from "./scan";
import { parseVerifyTable, statusByClaim, type VerifyRow } from "./verifyTable";

export const SUMMARY_MAX = 400;
export const CLAIMS_MAX = 12;
const REJECTED_TEXT_MAX = 120;
/** The reason logged when a cited source is about something else (shown as "skipped" in the drawer). */
export const SOURCE_NOT_ABOUT_ITEM = "source doesn't mention the item";

export interface MemoryWriterDeps {
  db: Db;
  /** The small model (SPEC §7.1). */
  model: LanguageModel;
  now: () => Date;
  /** Per extraction attempt (D70); up to 3 attempts. */
  timeoutMs?: number;
  /** Extra extraction options (attempts, total cap, sleep): tests. */
  extract?: ExtractOptions;
}

export interface TurnMemoryInput {
  turnId: string;
  threadId: string;
  tz: string;
  /** The user's local day for this turn (turn_summaries.local_date). */
  localDate: string;
  userText: string;
  /** The final answer text only: never tool output or page content (SPEC §15.1). */
  answerText: string;
  /** Every source returned this turn, with its [n]. A claim's source must be one of these. */
  sources: ReadonlyArray<{ n: number; url: string }>;
  /**
   * This turn's results by [n] (url, title, snippet). With it, a claim or table row whose cited source does not
   * name the item's vendor is kept out of the ledger (D57). Omitted: no such check.
   */
  results?: ReadonlyMap<number, ResultText>;
  /** Claims recalled into this turn's prompt; their labels are offered for reuse (D28). */
  knownClaims: ReadonlyArray<{ id: string; entity: string; attribute: string; value: string }>;
  /** Verify turn: the answer's table decides what the ledger may do with each recalled claim (D43). */
  verify?: boolean;
}

export interface Rejection {
  field: string;
  reason: string;
  text: string;
}

export interface WriteResult {
  summaryStored: boolean;
  ops: ReconcileOp[];
  rejected: Rejection[];
  /** Recalled claims the verify table gave a status to; 0 means the ordinary write path applied. */
  tableStatuses: number;
  error?: string;
}

// Strict, per-claim checks (SPEC §15.2). One bad claim is rejected alone; the rest still go through.
const strictClaim = z.object({
  entity: z.string().trim().min(1).max(80),
  attribute: z.string().trim().min(1).max(80),
  value: z.string().trim().min(1).max(200),
});

/**
 * A ledger value must be one exact value (D39). "~$6.30/month (or entry managed instance)" cannot be
 * compared with "$6/month": it would supersede a value the answer itself called Unchanged. Parentheses on
 * their own are fine ("Pay-as-you-go ($0.106/CU-hr)"); a hedge word inside them is caught like anywhere else (D42).
 */
const HEDGED = /[~≈]|\b(?:approx\w*|roughly|around|about|or)\b/i;

export function isHedged(value: string): boolean {
  return HEDGED.test(value);
}

/** [n] numbers the answer cites, including "[1, 3]" lists. */
export function citedNumbers(answer: string): Set<number> {
  const out = new Set<number>();
  for (const m of answer.matchAll(/\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\]/g)) {
    for (const n of (m[1] ?? "").split(",")) out.add(Number(n.trim()));
  }
  return out;
}

/** A real calendar day not after `today`, else `today` (the user's answer 1: fallback today). */
export function validAsOf(raw: string | null, today: string): string {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return today;
  const [y, m, d] = raw.split("-").map(Number);
  if (isoDayFromMs(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1)) !== raw) return today;
  return raw > today ? today : raw;
}

const clipText = (s: string): string => (s.length <= REJECTED_TEXT_MAX ? s : `${s.slice(0, REJECTED_TEXT_MAX - 1)}…`);

/**
 * The background memory write for one turn (SPEC §7): extract → validate → scan → summary + reconcile.
 * Never throws: failures go to memory_writes as op='error' and never reach the user (SPEC §9).
 */
export async function writeTurnMemory(deps: MemoryWriterDeps, input: TurnMemoryInput): Promise<WriteResult> {
  const { db, now } = deps;
  const result: WriteResult = { summaryStored: false, ops: [], rejected: [], tableStatuses: 0 };
  const logError = (stage: string, err: unknown): void => {
    // An extraction failure says how long it tried and what the provider said (status, retry-after), so a slow reply
    // can be told from a rate limit (D70). Never the message body: it can carry request details.
    const fields =
      err instanceof ExtractError
        ? {
            error: err.causeName,
            attempts: err.attempts,
            elapsedMs: err.elapsedMs,
            ...(err.status !== undefined ? { status: err.status } : {}),
            ...(err.retryAfterMs !== undefined ? { retryAfterMs: err.retryAfterMs } : {}),
          }
        : errorFields(err);
    log.error("memory write failed", { turnId: input.turnId, stage, ...fields });
    result.error = stage;
    try {
      insertMemoryWrite(db, { turnId: input.turnId, op: "error", detail: { stage, ...fields }, createdAt: now() });
    } catch (inner) {
      log.error("memory error log failed", { turnId: input.turnId, ...errorFields(inner) });
    }
  };

  const today = localDate(now(), input.tz);
  const cited = citedNumbers(input.answerText);

  let extraction: Extraction;
  try {
    extraction = await extractTurnMemory(
      deps.model,
      {
        userText: input.userText,
        answerText: input.answerText,
        citedSources: input.sources.filter((s) => cited.has(s.n)),
        knownClaims: input.knownClaims,
        today,
      },
      { ...(deps.timeoutMs === undefined ? {} : { attemptTimeoutMs: deps.timeoutMs }), ...deps.extract },
    );
  } catch (err) {
    logError("extract", err);
    return result;
  }

  try {
    const urls = input.sources.map((s) => s.url);
    const urlByN = new Map(input.sources.map((s) => [s.n, s.url]));
    const reject = (field: string, reason: string, text: string): void => {
      result.rejected.push({ field, reason, text: clipText(text) });
    };

    let summary: string | undefined;
    const rawSummary = extraction.summary.trim();
    if (rawSummary) {
      const scan = scanText(rawSummary, urls);
      if (scan.ok) summary = rawSummary.length <= SUMMARY_MAX ? rawSummary : `${rawSummary.slice(0, SUMMARY_MAX - 1)}…`;
      else reject("summary", scan.reason, rawSummary);
    }

    const valid: ValidClaim[] = [];
    extraction.claims.forEach((raw, i) => {
      const label = `${raw.entity} | ${raw.attribute} | ${raw.value}`;
      if (i >= CLAIMS_MAX) return reject("claim", "over cap", label);
      const parsed = strictClaim.safeParse(raw);
      if (!parsed.success) return reject("claim", "invalid", label);
      if (isHedged(parsed.data.value)) return reject("value", "hedged value", label);
      // Every claim needs evidence from THIS turn: a restatement from memory is not a check (D29).
      if (raw.source === null) return reject("claim", "unsourced", label);
      const sourceUrl = urlByN.get(raw.source);
      if (!sourceUrl) return reject("claim", "source not from this turn", label);
      // The source this claim cites must be about its item: a competitor's blog cannot back another vendor's price.
      const cited = input.results?.get(raw.source);
      if (cited && !sourceMentionsVendor(parsed.data.entity, cited)) return reject("claim", SOURCE_NOT_ABOUT_ITEM, label);
      for (const field of ["entity", "attribute", "value"] as const) {
        const scan = scanText(parsed.data[field], urls);
        if (!scan.ok) return reject(field, scan.reason, parsed.data[field]);
      }
      valid.push({ ...parsed.data, sourceUrl, validAsOf: validAsOf(raw.asOf, today) });
    });

    // The verify table overrides the extractor for the claims it covers (D43). No table, or no row naming a
    // recalled claim, leaves `valid` as it is.
    const table = input.verify ? parseVerifyTable(input.answerText) : undefined;
    const rows = table ? statusByClaim(table, input.knownClaims) : new Map<string, VerifyRow>();
    result.tableStatuses = rows.size;
    const touchIds: string[] = [];
    const held = new Map<string, string>(); // claim key → why the extractor may not write it
    const heldEntity = new Map<string, string[]>(); // entity word → statuses of its recalled claims
    const returned = new Set(input.sources.map((s) => s.n));
    for (const c of input.knownClaims) {
      const row = rows.get(c.id);
      const entity = normalizeKeyPart(c.entity).split(" ")[0] ?? "";
      heldEntity.set(entity, [...(heldEntity.get(entity) ?? []), row?.status ?? "none"]);
      if (!row) continue;
      // The row's own citations must include one that is about the item; otherwise nothing is written for this
      // claim: no touch, no new value (D57). A row citing several sources passes if any one of them does.
      const cites = row.sources.flatMap((n) => {
        const r = input.results?.get(n);
        return r ? [r] : [];
      });
      if (cites.length > 0 && !cites.some((r) => sourceMentionsVendor(c.entity, r))) {
        held.set(claimKey(c.entity, c.attribute), SOURCE_NOT_ABOUT_ITEM);
        heldEntity.set(entity, [...(heldEntity.get(entity) ?? []).slice(0, -1), "unverified"]);
        reject("table", SOURCE_NOT_ABOUT_ITEM, row.item);
        continue;
      }
      if (row.status === "unchanged") {
        held.set(claimKey(c.entity, c.attribute), "table says Unchanged");
        // Unchanged still needs evidence from this turn, like any write (D29).
        if (row.sources.some((n) => returned.has(n))) touchIds.push(c.id);
        else reject("table", "unsourced Unchanged row", row.item);
      } else if (row.status === "unverified") {
        held.set(claimKey(c.entity, c.attribute), "table says Couldn't verify");
      }
    }
    // An extractor claim about an entity whose rows are ALL Unchanged / Couldn't verify is the A2 Render bug
    // (same item, reworded attribute), so it is held too.
    const allHeld = (entity: string): boolean => {
      const statuses = heldEntity.get(entity);
      return !!statuses && statuses.every((st) => st === "unchanged" || st === "unverified");
    };
    const writable = valid.filter((c) => {
      const why =
        held.get(claimKey(c.entity, c.attribute)) ??
        (allHeld(normalizeKeyPart(c.entity).split(" ")[0] ?? "") ? "table says Unchanged or Couldn't verify" : undefined);
      if (why) reject("claim", why, `${c.entity} | ${c.attribute} | ${c.value}`);
      return !why;
    });

    const at = now();
    db.transaction(() => {
      if (summary) {
        insertTurnSummary(db, {
          turnId: input.turnId,
          threadId: input.threadId,
          localDate: input.localDate,
          summary,
          createdAt: at,
        });
      }
      for (const r of result.rejected) {
        insertMemoryWrite(db, { turnId: input.turnId, op: "rejected", detail: r, createdAt: at });
      }
      const turn = { turnId: input.turnId, threadId: input.threadId, observedAt: at };
      result.ops = [...touchVerified(db, turn, touchIds), ...reconcileClaims(db, turn, writable)];
    })();
    result.summaryStored = summary !== undefined;
  } catch (err) {
    result.ops = [];
    result.summaryStored = false;
    logError("store", err);
  }
  return result;
}
