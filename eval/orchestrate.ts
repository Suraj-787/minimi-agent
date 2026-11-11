import type { EvalCase } from "./cases";
import { persistCase } from "./output";
import type { RunMode } from "./policy";
import { judgeCell, type CaseReport, type RunMeta } from "./render";
import { QuotaExhausted, runCase, type CaseDeps } from "./runCase";
import { loadStored, type ModelIds } from "./store";

export interface RunAllOptions {
  deps: CaseDeps;
  cases: EvalCase[];
  mode: RunMode;
  ids: ModelIds;
  meta: RunMeta;
  evalDir: string;
  sleep: (ms: number) => Promise<void>;
  /** Real time (not the frozen case clock): when a case finished. */
  now: () => Date;
  log: (line: string) => void;
}

export interface RunOutcome {
  reports: CaseReport[];
  /** Case ids reused from stored results (--resume). */
  resumed: Set<string>;
  /** Set when the run stopped on a daily quota; finished cases were already saved. */
  quota?: QuotaExhausted;
}

const stamp = (d: Date): string => `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;

/**
 * Runs the cases in order. Each finished case is saved at once (transcript + stored result), so a quota
 * stop keeps everything finished before it (D66). With --resume a case that already has a stored uncached
 * result for the same models, case definition and repeat count is skipped. A case cut short by a quota
 * stop is not saved and counts as missing.
 */
export async function runAll(o: RunAllOptions): Promise<RunOutcome> {
  const { mode } = o;
  const reports: CaseReport[] = o.cases.map((c) => ({ case: c, runs: [] }));
  const resumed = new Set<string>();
  if (mode.resume) {
    for (const r of reports) {
      const stored = loadStored(o.evalDir, r.case, o.ids, mode.repeat);
      if (!stored) continue;
      r.runs = stored.runs;
      r.ranAt = stamp(new Date(stored.ranAt));
      resumed.add(r.case.id);
      o.log(`SKIP ${r.case.id}: stored result from ${r.ranAt} (${stored.runs.filter((x) => x.passed).length}/${stored.runs.length} passed)`);
    }
  }

  let first = true;
  try {
    for (const report of reports) {
      if (report.runs.length > 0) continue;
      const runs: CaseReport["runs"] = [];
      for (let rep = 1; rep <= mode.repeat; rep++) {
        if (!first && mode.pauseMs > 0) await o.sleep(mode.pauseMs);
        first = false;
        const started = performance.now();
        let run = await runCase(o.deps, report.case, rep);
        // An infrastructure failure (provider 5xx, failed memory write) says nothing about the agent: rerun once,
        // keep both attempts for results.md, count the rerun (D70). A second failure is kept as it is.
        if (run.infra && run.infra.length > 0) {
          o.log(`INFRA ${report.case.id} run ${rep}/${mode.repeat}: ${run.infra.join("; ")} — rerunning once`);
          if (mode.pauseMs > 0) await o.sleep(mode.pauseMs);
          const again = await runCase(o.deps, report.case, rep, 2);
          run = { ...again, firstAttempt: run };
        }
        runs.push(run);
        const failed = run.hard.filter((h) => !h.pass).map((h) => h.name);
        o.log(
          `${run.passed ? "PASS" : "FAIL"} ${report.case.id} run ${rep}/${mode.repeat} [${run.searchMode}] judge ${judgeCell([run])} (${((performance.now() - started) / 1000).toFixed(1)} s)${failed.length ? ` ✗ ${failed.join("; ")}` : ""}`,
        );
      }
      const finished = o.now();
      report.runs = runs;
      report.ranAt = stamp(finished);
      persistCase(o.evalDir, mode, report.case, runs, o.ids, { ...o.meta, ranAt: report.ranAt }, finished.toISOString());
    }
  } catch (err) {
    if (err instanceof QuotaExhausted) return { reports, resumed, quota: err };
    throw err;
  }
  return { reports, resumed };
}

/** "9/20 case(s) have results (3 from earlier runs). Missing: A13, ...". */
export function coverageNote(out: RunOutcome): string {
  const missing = out.reports.filter((r) => r.runs.length === 0).map((r) => r.case.id);
  const done = out.reports.length - missing.length;
  return `${done}/${out.reports.length} case(s) have results (${out.resumed.size} from earlier runs).${missing.length ? ` Missing: ${missing.join(", ")}.` : ""}`;
}
