import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadCases } from "../eval/cases";
import { persistCase, writeResults } from "../eval/output";
import { CACHE_BANNER, evalEnvSource, resolveRunMode } from "../eval/policy";
import { judgeCell, renderResults, renderTranscript, type CaseReport, type RunMeta } from "../eval/render";
import type { RunResult } from "../eval/runCase";

describe("resolveRunMode", () => {
  it("defaults: real model, full run writes results and transcripts, pause 4 s, one run", () => {
    expect(resolveRunMode([])).toEqual({ cache: false, repeat: 1, pauseMs: 4000, resume: false, writeResults: true, persist: true });
  });
  it("--cache writes nothing and says so", () => {
    const m = resolveRunMode(["--cache"]);
    expect(m).toMatchObject({ cache: true, writeResults: false, persist: false });
    expect(m.error).toBeUndefined();
    expect(m.skipNote).toMatch(/nothing was stored/);
  });
  it("--cache --write-results is an error (non-zero exit in the runner)", () => {
    expect(resolveRunMode(["--cache", "--write-results"]).error).toMatch(/--cache/);
  });
  it("--only runs a subset: finished cases are stored, results.md is not; --write-results with it is refused", () => {
    expect(resolveRunMode(["--only", "A2,A3"])).toMatchObject({ only: ["A2", "A3"], writeResults: false, persist: true });
    expect(resolveRunMode(["--only", "A2", "--write-results"]).error).toBeDefined();
  });
  it("--no-write writes nothing; --repeat and --pause-ms are validated", () => {
    expect(resolveRunMode(["--no-write"])).toMatchObject({ writeResults: false, persist: false });
    expect(resolveRunMode(["--repeat", "3", "--pause-ms", "0"])).toMatchObject({ repeat: 3, pauseMs: 0 });
    for (const bad of [["--repeat", "0"], ["--repeat", "x"], ["--pause-ms", "-1"], ["--wat"]]) {
      expect(resolveRunMode(bad).error, bad.join(" ")).toBeDefined();
    }
  });
});

describe("--resume", () => {
  it("is allowed with a full or subset run, refused with --cache or --no-write", () => {
    expect(resolveRunMode(["--resume"])).toMatchObject({ resume: true, writeResults: true, persist: true });
    expect(resolveRunMode(["--resume", "--only", "A1"])).toMatchObject({ resume: true, writeResults: false });
    expect(resolveRunMode(["--resume", "--cache"]).error).toMatch(/--cache/);
    expect(resolveRunMode(["--resume", "--no-write"]).error).toBeDefined();
  });
});

describe("evalEnvSource", () => {
  it("ignores DEV_LLM_CACHE and NOW from the environment; only the flag decides", () => {
    const shell = { DEV_LLM_CACHE: "1", NOW: "2026-01-01T00:00:00Z", KEEP: "x" };
    expect(evalEnvSource(shell, false)).toMatchObject({ DEV_LLM_CACHE: "0", NOW: undefined, KEEP: "x" });
    expect(evalEnvSource({}, true).DEV_LLM_CACHE).toBe("1");
  });
});

const meta: RunMeta = { provider: "google", mainModel: "m", smallModel: "s", thinking: "tool low / answer default", ranAt: "2026-11-12 05:30 UTC", repeat: 3, pauseMs: 4000 };
const run = (caseId: string, rep: number, passed: boolean, score: number | undefined, mode: RunResult["searchMode"] = "live"): RunResult => ({
  caseId,
  rep,
  turns: [{ message: "q", answer: "the answer", status: "complete", searchCalls: 1, sourceNumbers: [1], queries: ["q1"], sources: [{ n: 1, url: "https://a.test", title: "A", snippet: "s" }], firstTokenMs: 900, totalMs: 4000 }],
  hard: [{ name: "searched", pass: true }, passed ? { name: "cited", pass: true } : { name: "cited", pass: false, detail: "no [n]" }],
  soft: [],
  passed,
  judge: score === undefined ? { error: "APICallError" } : { score: score as 1, reason: "because" },
  searchMode: mode,
});
const [A, B] = loadCases();
const reports: CaseReport[] = [
  { case: A!, runs: [run(A!.id, 1, true, 5), run(A!.id, 2, true, 4), run(A!.id, 3, false, 2)] },
  { case: B!, runs: [run(B!.id, 1, true, 5, "mock"), run(B!.id, 2, true, 5, "mock"), run(B!.id, 3, true, 5, "mock")] },
];

describe("render", () => {
  it("results.md shows pass counts like 2/3, the failed check with its count, mock vs live, and flags a judge score <= 2", () => {
    const md = renderResults(reports, meta);
    expect(md).toContain("2/3");
    expect(md).toContain("3/3");
    expect(md).toContain("cited (1/3)");
    expect(md).toMatch(new RegExp(`\\| ${B!.id} \\| mock \\|`));
    expect(md).toMatch(new RegExp(`\\| ${A!.id} \\| live \\|`));
    expect(md).toContain("5, 4, 2 ⚠ review");
    expect(md).toContain("Cases passing every run: **1/2**");
    expect(md).toContain("Uncached run against the real model");
  });
  it("judgeCell: no flag at 3+, err for a judge failure", () => {
    expect(judgeCell([run("x", 1, true, 3)])).toBe("3");
    expect(judgeCell([run("x", 1, true, undefined)])).toBe("err");
  });
  it("the transcript holds the full answer, queries and per-run verdicts", () => {
    const t = renderTranscript(A!, reports[0]!.runs, meta);
    expect(t).toContain("> the answer");
    expect(t).toContain("`q1`");
    expect(t).toContain("## Run 3 — FAIL");
    expect(t).toContain("Pass: 2/3");
  });
});

describe("persistCase / writeResults", () => {
  let dir = "";
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));
  const tmp = () => (dir = mkdtempSync(join(tmpdir(), "eval-out-")));
  const ids = { provider: "google", mainModel: "m", smallModel: "s", thinking: "tool low / answer default" };
  const save = (d: string, args: string[]) => persistCase(d, resolveRunMode(args), A!, reports[0]!.runs, ids, meta, "2026-11-12T05:30:00.000Z");

  it("a --cache run stores nothing and writes no results.md", () => {
    const d = tmp();
    expect(save(d, ["--cache"])).toEqual([]);
    expect(writeResults(d, resolveRunMode(["--cache"]), reports, meta)).toBeUndefined();
    expect(readdirSync(d)).toEqual([]);
  });
  it("--no-write writes nothing", () => {
    const d = tmp();
    expect(save(d, ["--no-write"])).toEqual([]);
    expect(readdirSync(d)).toEqual([]);
  });
  it("a finished case gets a transcript and a stored result; a subset run still does not write results.md", () => {
    const d = tmp();
    const written = save(d, ["--only", "A1"]);
    expect(written.map((p) => p.replace(d, ""))).toEqual([`/transcripts/${A!.id}.md`, `/.tmp/results/${A!.id}.json`]);
    expect(writeResults(d, resolveRunMode(["--only", "A1"]), reports, meta)).toBeUndefined();
    expect(existsSync(join(d, "results.md"))).toBe(false);
  });
  it("a full uncached run with every case present writes results.md; a missing case withholds it", () => {
    const d = tmp();
    expect(writeResults(d, resolveRunMode([]), reports, meta)).toBe(join(d, "results.md"));
    expect(readFileSync(join(d, "results.md"), "utf8")).toContain("# Eval results");
    rmSync(join(d, "results.md"));
    expect(writeResults(d, resolveRunMode([]), [reports[0]!, { case: B!, runs: [] }], meta)).toBeUndefined();
    expect(existsSync(join(d, "results.md"))).toBe(false);
  });
});

describe("npm run eval entry point", () => {
  it("--cache --write-results exits non-zero before touching env, model or files", () => {
    const before = existsSync(join(process.cwd(), "eval", "results.md"));
    const r = spawnSync("npx", ["tsx", "eval/run.ts", "--cache", "--write-results"], { cwd: process.cwd(), encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/refusing/);
    expect(existsSync(join(process.cwd(), "eval", "results.md"))).toBe(before);
  }, 30_000);
  it("exports the cache banner text the plan requires", () => {
    expect(CACHE_BANNER).toBe("CACHED RUN: model answers replayed from llm_cache, not a valid result");
  });
});
