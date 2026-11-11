import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APICallError } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { loadCases, type EvalCase } from "../eval/cases";
import { coverageNote, runAll } from "../eval/orchestrate";
import { writeResults } from "../eval/output";
import { resolveRunMode } from "../eval/policy";
import type { RunMeta } from "../eval/render";
import { caseHash, loadStored, storeDir } from "../eval/store";
import { flakyModel, objectModel, textModel } from "./helpers/mockModel";
import { noSearch } from "./helpers/search";

// Persist-on-finish and --resume with mocked models: no network, no quota.

const cases = loadCases();
const byId = (p: string): EvalCase => cases.find((c) => c.id.startsWith(`${p}-`)) as EvalCase;
const [A6, A11] = [byId("A6"), byId("A11")];

const ids = { provider: "google", mainModel: "main-1", smallModel: "small-1", thinking: "tool low / answer default" };
const meta: RunMeta = { ...ids, ranAt: "2026-11-12 05:30 UTC", repeat: 1, pauseMs: 0 };
const dailyQuota = new APICallError({
  message: "quota",
  url: "https://example.test",
  requestBodyValues: {},
  statusCode: 429,
  responseBody: "GenerateRequestsPerDayPerProject",
  isRetryable: false,
});
const small = () => objectModel((i: number) => (i % 2 === 0 ? { summary: "", claims: [] } : { score: 4, reason: "ok" }));

let dir = "";
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

function opts(main: ReturnType<typeof textModel>, args: string[] = [], list = [A6, A11]) {
  dir ||= mkdtempSync(join(tmpdir(), "eval-resume-"));
  const mode = resolveRunMode(["--pause-ms", "0", ...args]);
  const logs: string[] = [];
  return {
    logs,
    mode,
    o: {
      deps: {
        models: { main, small: small() },
        liveSearch: () => noSearch,
        dbPath: () => ":memory:",
        maxSteps: 4,
        retry: { sleep: async () => undefined, rand: () => 0 },
      },
      cases: list,
      mode,
      ids,
      meta,
      evalDir: dir,
      sleep: async () => undefined,
      now: () => new Date("2026-11-12T10:00:00Z"),
      log: (l: string) => logs.push(l),
    },
  };
}

describe("a quota stop keeps what finished", () => {
  it("saves the finished case at once, reports the rest as missing, and writes no results.md", async () => {
    const { flaky, quotaModel } = (() => {
      const f = flakyModel(textModel(["Doing well, thanks!"]), [undefined, dailyQuota]);
      return { flaky: f, quotaModel: f.model };
    })();
    const { o, mode } = opts(quotaModel as never);
    const out = await runAll(o);

    expect(out.quota).toBeDefined();
    expect(out.reports[0]?.runs).toHaveLength(1);
    expect(out.reports[1]?.runs).toHaveLength(0); // cut short: not saved, counts as missing
    expect(existsSync(join(storeDir(dir), `${A6.id}.json`))).toBe(true);
    expect(existsSync(join(dir, "transcripts", `${A6.id}.md`))).toBe(true);
    expect(existsSync(join(storeDir(dir), `${A11.id}.json`))).toBe(false);
    expect(writeResults(dir, mode, out.reports, meta)).toBeUndefined();
    expect(existsSync(join(dir, "results.md"))).toBe(false);
    expect(coverageNote(out)).toContain(`Missing: ${A11.id}`);
    // the transcript carries the model ids and date
    const t = readFileSync(join(dir, "transcripts", `${A6.id}.md`), "utf8");
    expect(t).toContain("main `main-1`");
    expect(t).toContain("2026-11-12 10:00 UTC");
    expect(flaky.attempts()).toBeGreaterThanOrEqual(2);
  });
});

describe("--resume", () => {
  it("skips a stored case, runs the rest, and then writes results.md once every case has a result", async () => {
    const first = opts(flakyModel(textModel(["Doing well!"]), [undefined, dailyQuota]).model as never);
    await runAll(first.o);

    const main = textModel(["I have no record of that."]);
    const second = opts(main, ["--resume"]);
    const out = await runAll(second.o);

    expect(out.quota).toBeUndefined();
    expect([...out.resumed]).toEqual([A6.id]);
    expect(second.logs.some((l) => l.startsWith(`SKIP ${A6.id}`))).toBe(true);
    expect(main.doStreamCalls).toHaveLength(1); // only A11 ran; A6 was not sent to the model again
    expect(out.reports.every((r) => r.runs.length > 0)).toBe(true);
    expect(out.reports[0]?.ranAt).toBe("2026-11-12 10:00 UTC");

    const path = writeResults(dir, second.mode, out.reports, meta);
    expect(path).toBe(join(dir, "results.md"));
    expect(readFileSync(path as string, "utf8")).toContain(A6.id);
  });

  it("without --resume everything runs again", async () => {
    const a = opts(textModel(["Doing well!"]));
    await runAll(a.o);
    const main = textModel(["Doing well!"]);
    const b = opts(main);
    const out = await runAll(b.o);
    expect(out.resumed.size).toBe(0);
    expect(main.doStreamCalls).toHaveLength(2);
  });

  it("a --cache run never stores anything, so there is nothing to resume from", async () => {
    const a = opts(textModel(["Doing well!"]), ["--cache"]);
    await runAll(a.o);
    expect(existsSync(storeDir(dir))).toBe(false);
    expect(existsSync(join(dir, "transcripts"))).toBe(false);
  });
});

describe("loadStored: a stored result is reused only when it is still valid", () => {
  it("a different main or small model id, case definition, or repeat count is a miss", async () => {
    await runAll(opts(textModel(["Doing well!"]), [], [A6]).o);
    expect(loadStored(dir, A6, ids, 1)).toBeDefined();
    expect(loadStored(dir, A6, { ...ids, mainModel: "main-2" }, 1)).toBeUndefined();
    expect(loadStored(dir, A6, { ...ids, smallModel: "small-2" }, 1)).toBeUndefined();
    expect(loadStored(dir, A6, { ...ids, provider: "openai" }, 1)).toBeUndefined();
    expect(loadStored(dir, A6, { ...ids, thinking: "tool high / answer default" }, 1)).toBeUndefined();
    expect(loadStored(dir, A6, ids, 3)).toBeUndefined();
    const edited = { ...A6, rubric: `${A6.rubric} (edited)` };
    expect(caseHash(edited)).not.toBe(caseHash(A6));
    expect(loadStored(dir, edited, ids, 1)).toBeUndefined();
  });
  it("a corrupt file is a miss, not a crash", async () => {
    await runAll(opts(textModel(["Doing well!"]), [], [A6]).o);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(storeDir(dir), `${A6.id}.json`), "{not json");
    expect(loadStored(dir, A6, ids, 1)).toBeUndefined();
  });
});
