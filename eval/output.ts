import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunMode } from "./policy";
import { renderResults, renderTranscript, type CaseReport, type RunMeta } from "./render";

/**
 * The only place the eval writes files under eval/. What a run may write is decided by `mode` (policy.ts):
 * a cached, subset or --no-write run writes nothing it is not allowed to. Returns the paths written.
 */
export function writeOutputs(dir: string, mode: RunMode, reports: CaseReport[], meta: RunMeta): string[] {
  const written: string[] = [];
  if (mode.writeTranscripts) {
    const tdir = join(dir, "transcripts");
    mkdirSync(tdir, { recursive: true });
    for (const r of reports) {
      if (r.runs.length === 0) continue;
      const path = join(tdir, `${r.case.id}.md`);
      writeFileSync(path, renderTranscript(r.case, r.runs, meta));
      written.push(path);
    }
  }
  if (mode.writeResults) {
    const path = join(dir, "results.md");
    writeFileSync(path, renderResults(reports, meta));
    written.push(path);
  }
  return written;
}
