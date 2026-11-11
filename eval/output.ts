import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EvalCase } from "./cases";
import type { RunMode } from "./policy";
import { renderResults, renderTranscript, type CaseReport, type RunMeta } from "./render";
import { saveCase, type ModelIds } from "./store";
import type { RunResult } from "./runCase";

/**
 * The only places the eval writes files under eval/. What a run may write is decided by `mode` (policy.ts),
 * so a cached, subset or --no-write run writes nothing it is not allowed to.
 */

/** Saves one finished case right away: its transcript and its stored result. Returns the paths written. */
export function persistCase(dir: string, mode: RunMode, c: EvalCase, runs: RunResult[], ids: ModelIds, meta: RunMeta, ranAtIso: string): string[] {
  if (!mode.persist || runs.length === 0) return [];
  const tdir = join(dir, "transcripts");
  mkdirSync(tdir, { recursive: true });
  const transcript = join(tdir, `${c.id}.md`);
  writeFileSync(transcript, renderTranscript(c, runs, meta));
  return [transcript, saveCase(dir, c, ids, ranAtIso, mode.repeat, runs)];
}

/** eval/results.md: only from a full uncached run in which every case has a result. */
export function writeResults(dir: string, mode: RunMode, reports: CaseReport[], meta: RunMeta): string | undefined {
  if (!mode.writeResults || reports.some((r) => r.runs.length === 0)) return undefined;
  const path = join(dir, "results.md");
  writeFileSync(path, renderResults(reports, meta));
  return path;
}
