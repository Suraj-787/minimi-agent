import { parseArgs } from "node:util";

// What a run may do with the real model, the cache and the output files. Pure, so the rules that keep
// a cached or partial run from ever producing "results" are unit-tested (D60).

export const CACHE_BANNER = "CACHED RUN: model answers replayed from llm_cache, not a valid result";

export interface RunMode {
  cache: boolean;
  /** Case ids to run; undefined = all. */
  only?: string[];
  repeat: number;
  pauseMs: number;
  /** eval/results.md: only from a full, uncached run. */
  writeResults: boolean;
  /** eval/transcripts/<id>.md: from any uncached run. */
  writeTranscripts: boolean;
  /** Printed at the end when something was deliberately not written. */
  skipNote?: string;
  error?: string;
}

const DEFAULT_PAUSE_MS = 4000;
const MAX_REPEAT = 10;

export const USAGE = `usage: npm run eval -- [--only A1,A3] [--repeat N] [--pause-ms MS] [--no-write] [--cache [--write-results]]
  --only         run these case ids (comma separated); never writes results.md
  --repeat       run every case N times (default 1) and report pass counts like 2/3
  --pause-ms     wait between model runs, for the free tier (default ${DEFAULT_PAUSE_MS})
  --no-write     write no results.md and no transcripts
  --cache        dev only: replay model answers from eval/.tmp/llm-cache.db; writes nothing`;

function fail(message: string): RunMode {
  return { cache: false, repeat: 1, pauseMs: DEFAULT_PAUSE_MS, writeResults: false, writeTranscripts: false, error: message };
}

export function resolveRunMode(argv: string[]): RunMode {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        cache: { type: "boolean", default: false },
        "write-results": { type: "boolean", default: false },
        "no-write": { type: "boolean", default: false },
        only: { type: "string" },
        repeat: { type: "string" },
        "pause-ms": { type: "string" },
      },
      strict: true,
    }));
  } catch (err) {
    return fail(err instanceof Error ? err.message : "bad arguments");
  }

  const repeat = values.repeat === undefined ? 1 : Number(values.repeat);
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > MAX_REPEAT) return fail(`--repeat must be an integer 1-${MAX_REPEAT}`);
  const pauseMs = values["pause-ms"] === undefined ? DEFAULT_PAUSE_MS : Number(values["pause-ms"]);
  if (!Number.isFinite(pauseMs) || pauseMs < 0) return fail("--pause-ms must be a number >= 0");
  const only = values.only
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (values.only !== undefined && (!only || only.length === 0)) return fail("--only needs at least one case id");

  const cache = values.cache;
  if (cache && values["write-results"]) {
    return fail("refusing: --cache replays stored model answers, so it can never write eval/results.md. Drop --write-results or --cache.");
  }
  if (values["write-results"] && only) return fail("refusing: --write-results needs a full run; --only runs a subset.");
  if (values["write-results"] && values["no-write"]) return fail("--write-results and --no-write contradict each other");

  const base = { cache, repeat, pauseMs, ...(only ? { only } : {}) };
  if (cache) {
    return { ...base, writeResults: false, writeTranscripts: false, skipNote: "cached run: eval/results.md and transcripts were not written (they would have been under eval/)" };
  }
  if (values["no-write"]) return { ...base, writeResults: false, writeTranscripts: false, skipNote: "--no-write: nothing written" };
  if (only) {
    return { ...base, writeResults: false, writeTranscripts: true, skipNote: "subset run (--only): eval/results.md not written, transcripts were" };
  }
  return { ...base, writeResults: true, writeTranscripts: true };
}

/**
 * The env the runner validates. DEV_LLM_CACHE from the shell or .env is overwritten: only the flag
 * decides, so a stray DEV_LLM_CACHE=1 can never make a "real" run a cached one (D46).
 */
export function evalEnvSource(source: Record<string, string | undefined>, cache: boolean): Record<string, string | undefined> {
  return { ...source, DEV_LLM_CACHE: cache ? "1" : "0", NOW: undefined };
}
