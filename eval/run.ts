import { config } from "dotenv";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { getModels } from "../src/agent/model";
import { openDb } from "../src/db/index";
import { EnvError, loadEnv } from "../src/lib/env";
import { createSearchFromEnv } from "../src/search/index";
import { loadCases } from "./cases";
import { runAll, coverageNote } from "./orchestrate";
import { writeResults } from "./output";
import { CACHE_BANNER, evalEnvSource, resolveRunMode, USAGE } from "./policy";
import { passCount, type RunMeta } from "./render";

// `npm run eval`: real model, real search quota. Never run by tests or CI (CLAUDE.md).
const EVAL_DIR = dirname(fileURLToPath(import.meta.url));
const TMP_DIR = join(EVAL_DIR, ".tmp");

async function main(): Promise<number> {
  config({ quiet: true });
  const mode = resolveRunMode(process.argv.slice(2));
  if (mode.error) {
    console.error(`${mode.error}\n\n${USAGE}`);
    return 2;
  }
  const e = loadEnv(evalEnvSource(process.env, mode.cache));
  const all = loadCases();
  const unknown = (mode.only ?? []).filter((id) => !all.some((c) => c.id === id || c.id.startsWith(`${id}-`)));
  if (unknown.length > 0) {
    console.error(`unknown case id(s): ${unknown.join(", ")}\nknown: ${all.map((c) => c.id).join(", ")}`);
    return 2;
  }
  // "A2" selects "A2-recall-and-verify" too, so the short ids from the spec work.
  const cases = mode.only ? all.filter((c) => mode.only?.some((id) => c.id === id || c.id.startsWith(`${id}-`))) : all;

  mkdirSync(TMP_DIR, { recursive: true });
  // The cache lives in its own file: per-case DBs are wiped every run, so they could not hold a cache.
  const cacheDb = mode.cache ? openDb(join(TMP_DIR, "llm-cache.db")) : undefined;
  const realNow = () => new Date();
  const models = getModels(e, cacheDb ? { cache: { db: cacheDb, now: realNow } } : undefined);
  const deps = {
    models,
    liveSearch: (db: Parameters<typeof createSearchFromEnv>[1]) => createSearchFromEnv(e, db, realNow),
    dbPath: (id: string) => join(TMP_DIR, `${id}.db`),
    maxSteps: e.MAX_STEPS,
  };
  const meta: RunMeta = {
    provider: e.LLM_PROVIDER,
    mainModel: e.MAIN_MODEL,
    smallModel: e.SMALL_MODEL,
    thinking: `tool ${e.MAIN_THINKING} / answer ${e.MAIN_THINKING_ANSWER}`,
    ranAt: realNow().toISOString().slice(0, 16).replace("T", " ") + " UTC",
    repeat: mode.repeat,
    pauseMs: mode.pauseMs,
  };

  if (mode.cache) console.log(`\n!!! ${CACHE_BANNER} !!!\n`);
  console.log(`${cases.length} case(s) × ${mode.repeat} run(s), ${mode.pauseMs} ms pause. Per-case DBs: eval/.tmp/<id>.db`);

  const ids = { provider: meta.provider, mainModel: meta.mainModel, smallModel: meta.smallModel, thinking: meta.thinking };
  let outcome;
  try {
    outcome = await runAll({ deps, cases, mode, ids, meta, evalDir: EVAL_DIR, sleep: (ms) => sleep(ms).then(() => undefined), now: realNow, log: console.log });
  } finally {
    cacheDb?.close();
  }

  const { reports } = outcome;
  if (outcome.quota) {
    console.error(`\nStopped: ${outcome.quota.message}. ${coverageNote(outcome)}`);
    console.error(
      mode.persist
        ? "Finished cases were saved (eval/.tmp/results, eval/transcripts). eval/results.md was not written: it needs every case.\nThe daily quota resets tomorrow; then run: npm run eval -- --resume"
        : "This run does not store results, so nothing was saved. The daily free quota resets tomorrow, or use another key or provider.",
    );
    return 1;
  }

  const done = reports.filter((r) => r.runs.length > 0);
  const totalRuns = done.reduce((n, r) => n + r.runs.length, 0);
  const passed = done.reduce((n, r) => n + passCount(r.runs), 0);
  console.log(`\n${passed}/${totalRuns} runs passed on the deterministic checks.`);
  for (const r of done) console.log(`  ${r.case.id}: ${passCount(r.runs)}/${r.runs.length}${outcome.resumed.has(r.case.id) ? " (stored)" : ""}`);
  if (mode.cache) console.log(`\n!!! ${CACHE_BANNER} !!!`);
  const resultsPath = writeResults(EVAL_DIR, mode, reports, meta);
  if (resultsPath) console.log(`\nwrote ${resultsPath}`);
  else if (mode.writeResults) console.log(`\neval/results.md not written. ${coverageNote(outcome)}`);
  if (mode.skipNote) console.log(`\n${mode.skipNote}`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    if (err instanceof EnvError) console.error(err.message);
    else console.error(err instanceof Error ? `${err.name}: ${err.message}` : err);
    process.exit(1);
  });
