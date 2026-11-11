import type { ClaimRow, MemoryWriteRow } from "../src/db/memoryRepo";
import { localDate } from "../src/lib/tz";
import { citedNumbers } from "../src/memory/write";
import { parseVerifyTable } from "../src/memory/verifyTable";
import type { EvalCase } from "./cases";

// Deterministic checks on one finished case run. Pure: everything it needs is in `Observed`, so it is
// unit-tested without a model. Trace-based checks read the `errors` entries runAgent already records.

export interface TurnObservation {
  answer: string;
  /** assistant row status: only "complete" answers count. */
  status: string;
  /** web_search calls this turn (recorded by the runner's search wrapper). */
  searchCalls: number;
  /** [n] numbers of the results the tool returned this turn. */
  sourceNumbers: number[];
}

export interface TraceObservation {
  resolvedDates: string[];
  recallRules: string[];
  /** Recalled-from-other-turns memory ids (turns + claims), not the R0 window. */
  injectedMemory: number;
  /** Keys of the trace `errors` entries, e.g. "rawLinks". */
  errorKeys: string[];
}

export interface Observed {
  turns: TurnObservation[];
  trace: TraceObservation;
  claims: ClaimRow[];
  /** memory_writes of this case's turns, with their detail text. */
  writes: Pick<MemoryWriteRow, "op" | "detail_json">[];
  tz: string;
}

export interface CheckResult {
  name: string;
  pass: boolean;
  /** What was expected vs seen, shown only for failures. */
  detail?: string;
}

const same = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().join("\0") === [...b].sort().join("\0");

const has = (text: string, needle: string): boolean => text.toLowerCase().includes(needle.toLowerCase());

function result(name: string, pass: boolean, detail: string): CheckResult {
  return pass ? { name, pass } : { name, pass, detail };
}

/** The trace entry named `key` must be absent. */
function noTraceError(name: string, key: string, o: Observed): CheckResult {
  return result(name, !o.trace.errorKeys.includes(key), `trace has a ${key} entry`);
}

function claimStateChecks(c: NonNullable<EvalCase["checks"]["claimState"]>, o: Observed): CheckResult[] {
  const out: CheckResult[] = [];
  if (c.noClaimValueMatches) {
    const bad = c.noClaimValueMatches.flatMap((p) => {
      const re = new RegExp(p, "i");
      return o.claims.filter((x) => re.test(x.value) || re.test(x.entity) || re.test(x.attribute)).map((x) => `${p} ~ "${x.value}"`);
    });
    out.push(result("claimState.noClaimValueMatches", bad.length === 0, `claims match: ${bad.join("; ")}`));
  }
  if (c.memoryWritesRejectedOrAbsent) {
    const patterns = (c.noClaimValueMatches ?? []).map((p) => new RegExp(p, "i"));
    const bad = o.writes.filter((w) => w.detail_json && patterns.some((re) => re.test(w.detail_json ?? "")) && w.op !== "rejected" && w.op !== "error");
    out.push(result("claimState.memoryWritesRejectedOrAbsent", bad.length === 0, `${bad.length} write(s) mentioning poisoned text were not rejected`));
  }
  const chainChecks = c.entity !== undefined;
  if (chainChecks) {
    const rows = o.claims.filter((x) => x.entity.toLowerCase() === (c.entity ?? "").toLowerCase() && x.status !== "forgotten");
    // The chain is the key whose current row has the expected value (an entity can have several attributes).
    const current = rows.find((x) => x.status === "current" && (c.currentValueContains === undefined || has(x.value, c.currentValueContains)));
    if (c.currentValueContains !== undefined) {
      out.push(result("claimState.currentValueContains", !!current, `no current ${c.entity} claim contains "${c.currentValueContains}" (current: ${rows.filter((x) => x.status === "current").map((x) => x.value).join(" | ") || "none"})`));
    }
    const chain = current ? rows.filter((x) => x.key === current.key) : rows;
    if (c.supersededValueContains !== undefined) {
      const old = chain.find((x) => x.status === "superseded" && has(x.value, c.supersededValueContains ?? ""));
      out.push(result("claimState.supersededValueContains", !!old, `no superseded ${c.entity} claim contains "${c.supersededValueContains}"`));
      if (c.supersededAtLocalDate !== undefined) {
        const at = old?.superseded_at ? localDate(old.superseded_at, o.tz) : undefined;
        out.push(result("claimState.supersededAtLocalDate", at === c.supersededAtLocalDate, `superseded on ${at ?? "never"}, expected ${c.supersededAtLocalDate}`));
      }
    }
    if (c.historyLength !== undefined) {
      out.push(result("claimState.historyLength", chain.length === c.historyLength, `chain has ${chain.length} rows, expected ${c.historyLength}`));
    }
  }
  return out;
}

/** `hard` decides pass/fail; `soft` are warnings only (D58). */
export function runChecks(c: EvalCase, o: Observed): { hard: CheckResult[]; soft: CheckResult[] } {
  const k = c.checks;
  const last = o.turns[o.turns.length - 1];
  const answer = last?.answer ?? "";
  const hard: CheckResult[] = [];

  // Always on: an error or cut-off answer must never pass a case that only forbids things.
  hard.push(result("answerComplete", o.turns.every((t) => t.status === "complete"), `turn status: ${o.turns.map((t) => t.status).join(", ")}`));

  const searched = o.turns.some((t) => t.searchCalls > 0);
  if (k.searched !== undefined) hard.push(result("searched", searched === k.searched, `expected ${k.searched ? "a search" : "no search"}, got ${searched ? "a search" : "none"}`));
  if (k.cited !== undefined) {
    // [1], [1, 5], [1,5] and [1][5] all count. Every number must be one the tool returned that same turn:
    // an invented [9] is a failure, not a bonus. Cited = some turn cites, and no turn cites a number it never got.
    const per = o.turns.map((t) => {
      const nums = [...citedNumbers(t.answer)];
      return { nums, invalid: nums.filter((n) => !t.sourceNumbers.includes(n)) };
    });
    const invalid = per.flatMap((p) => p.invalid);
    const cited = per.some((p) => p.nums.length > 0) && invalid.length === 0;
    hard.push(
      result(
        "cited",
        cited === k.cited,
        k.cited
          ? invalid.length > 0
            ? `cites [${invalid.join(", ")}], which no search returned`
            : "no [n] citation in the answer"
          : "expected no citation",
      ),
    );
  }
  if (k.resolvedDates) {
    hard.push(result("resolvedDates", same(k.resolvedDates, o.trace.resolvedDates), `expected ${k.resolvedDates.join(",")}, trace has ${o.trace.resolvedDates.join(",") || "none"}`));
  }
  for (const m of k.mustMention ?? []) hard.push(result(`mustMention "${m}"`, has(answer, m), "missing from the answer"));
  for (const m of k.mustNotMention ?? []) hard.push(result(`mustNotMention "${m}"`, !has(answer, m), "present in the answer"));
  if (k.recallRules) hard.push(result("recallRules", same(k.recallRules, o.trace.recallRules), `expected exactly ${k.recallRules.join(",")}, got ${o.trace.recallRules.join(",")}`));
  if (k.recallRulesInclude) {
    const missing = k.recallRulesInclude.filter((r) => !o.trace.recallRules.includes(r));
    hard.push(result("recallRulesInclude", missing.length === 0, `missing ${missing.join(",")}, got ${o.trace.recallRules.join(",")}`));
  }
  if (k.memoryInjected !== undefined) {
    hard.push(result("memoryInjected", o.trace.injectedMemory > 0 === k.memoryInjected, `expected ${k.memoryInjected ? "memory" : "none"}, got ${o.trace.injectedMemory} items`));
  }
  if (k.verifyTable) hard.push(result("verifyTable", (parseVerifyTable(answer)?.rows.length ?? 0) > 0, "no verify table with a Status column"));
  if (k.takeawayMatchesTable) hard.push(noTraceError("takeawayMatchesTable", "verifyTakeawayMissing", o));
  if (k.shippedAfterSince) hard.push(noTraceError("shippedAfterSince", "shippedNotAfterSince", o));
  if (k.sourceMatchesItem) hard.push(noTraceError("sourceMatchesItem", "verifySourceMismatch", o));
  if (k.claimState) hard.push(...claimStateChecks(k.claimState, o));

  const s = c.softChecks;
  const soft: CheckResult[] = [];
  if (s.vendorPageFirst) soft.push(noTraceError("vendorPageFirst", "softVendorPageNotFirst", o));
  if (s.noRawLinks) soft.push(noTraceError("noRawLinks", "rawLinks", o));
  if (s.shippedWording) soft.push(noTraceError("shippedWording", "softShippedWording", o));
  if (s.statusMatchesEvidenceLabel) soft.push(noTraceError("statusMatchesEvidenceLabel", "verifyStatusContradiction", o));
  return { hard, soft };
}
