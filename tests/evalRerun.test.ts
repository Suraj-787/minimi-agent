import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APICallError } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadCases } from "../eval/cases";
import { runAll } from "../eval/orchestrate";
import { resolveRunMode } from "../eval/policy";
import { RERUN_LABEL, renderResults, renderTranscript, type RunMeta } from "../eval/render";
import { infraReasons, runCase } from "../eval/runCase";
import { loadStored } from "../eval/store";
import { SERVER_ERROR_TEXT } from "../src/agent/errors";
import { errorAfterText, flakyModel, objectModel, textModel } from "./helpers/mockModel";
import { noSearch } from "./helpers/search";

// D70: a case whose turn hit a provider 5xx, or whose memory write failed, is rerun once automatically.

const A6 = loadCases().find((c) => c.id.startsWith("A6-"))!;
const ids = { provider: "google", mainModel: "m", smallModel: "s", thinking: "tool low / answer low" };
const meta: RunMeta = { ...ids, ranAt: "2026-11-12 05:30 UTC", repeat: 1, pauseMs: 0 };
const err = (statusCode: number) =>
  new APICallError({ message: "boom", url: "https://example.test", requestBodyValues: {}, statusCode, isRetryable: false });
const smallOk = () => objectModel((i: number) => (i % 2 === 0 ? { summary: "", claims: [] } : { score: 4, reason: "ok" }));

let dir = "";
afterEach(() => {
  vi.restoreAllMocks();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function setup(main: ReturnType<typeof textModel>, small = smallOk()) {
  dir = mkdtempSync(join(tmpdir(), "eval-rerun-"));
  const mode = resolveRunMode(["--pause-ms", "0"]);
  const logs: string[] = [];
  const o = {
    deps: { models: { main, small }, liveSearch: () => noSearch, dbPath: () => ":memory:", maxSteps: 4, retry: { sleep: async () => undefined, rand: () => 0 } },
    cases: [A6],
    mode,
    ids,
    meta,
    evalDir: dir,
    sleep: async () => undefined,
    now: () => new Date("2026-11-12T10:00:00Z"),
    log: (l: string) => logs.push(l),
  };
  return { o, logs };
}

describe("infraReasons", () => {
  it("a turn that ended on a provider 5xx or rate limit, and any memory write error", () => {
    expect(infraReasons([{ status: "error", answer: `partial text\n\n⚠️ ${SERVER_ERROR_TEXT}` }], [])).toEqual(["provider 5xx"]);
    expect(infraReasons([{ status: "error", answer: "⚠️ The model provider is rate-limiting requests (the free tier has low limits). Wait a minute and try again." }], [])).toEqual(["provider rate limit"]);
    expect(infraReasons([{ status: "complete", answer: "ok" }], [{ op: "error", detail_json: '{"stage":"extract","error":"TimeoutError"}' }])).toEqual(["memory write failed (TimeoutError)"]);
  });
  it("a wrong answer, an unrelated error or a normal write is not infra", () => {
    expect(infraReasons([{ status: "complete", answer: "wrong" }], [{ op: "add", detail_json: null }])).toEqual([]);
    expect(infraReasons([{ status: "error", answer: "⚠️ No API key is configured" }], [])).toEqual([]);
    expect(infraReasons([{ status: "complete", answer: SERVER_ERROR_TEXT }], [])).toEqual([]); // only an error row counts
  });
});

describe("runCase marks infra", () => {
  const deps = (main: ReturnType<typeof textModel>, small = smallOk()) => ({
    models: { main, small },
    liveSearch: () => noSearch,
    dbPath: () => ":memory:",
    maxSteps: 4,
    retry: { sleep: async () => undefined, rand: () => 0 },
  });

  it("a mid-stream 5xx (text, then the provider fails)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await runCase(deps(errorAfterText("Doing well, tha", err(500))), A6, 1);
    expect(r.infra).toEqual(["provider 5xx"]);
    expect(r.passed).toBe(false);
  });

  it("a memory_writes error row", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const smallDown = new (await import("ai/test")).MockLanguageModelV4({
      doGenerate: async () => {
        throw err(400);
      },
    });
    const r = await runCase(deps(textModel(["Doing well, thanks!"]), smallDown as never), A6, 1);
    expect(r.infra?.[0]).toMatch(/memory write failed/);
  });

  it("a clean run has no infra field", async () => {
    const r = await runCase(deps(textModel(["Doing well, thanks!"])), A6, 1);
    expect(r.infra).toBeUndefined();
  });
});

describe("runAll reruns once", () => {
  it("a provider 5xx on the first attempt: rerun, both attempts kept, the rerun counts, results.md and the transcript label it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    // 4 failed calls = the first turn plus the middleware's 3 retries; then the rerun works.
    const flaky = flakyModel(textModel(["Doing well, thanks!"]), [err(503), err(503), err(503), err(503)]);
    const { o, logs } = setup(flaky.model as never);
    const out = await runAll(o);
    const run = out.reports[0]!.runs[0]!;

    expect(logs.some((l) => l.startsWith("INFRA") && l.includes("provider 5xx"))).toBe(true);
    expect(run.passed).toBe(true); // the rerun counts
    expect(run.firstAttempt?.infra).toEqual(["provider 5xx"]);
    expect(run.firstAttempt?.passed).toBe(false);
    expect(run.firstAttempt?.firstAttempt).toBeUndefined();

    const md = renderResults(out.reports, meta);
    expect(md).toContain(`A6-chitchat ${RERUN_LABEL}`);
    expect(md).toContain("attempt 1 (discarded: provider 5xx): FAIL");
    expect(md).toContain("attempt 2 (counts): pass");
    expect(md).toContain("Rerun after a provider error: A6-chitchat");

    const t = renderTranscript(A6, out.reports[0]!.runs, meta);
    expect(t).toContain("attempt 1 (discarded, provider error)");
    expect(t).toContain(`attempt 2 ${RERUN_LABEL}`);
    expect(readFileSync(join(dir, "transcripts", `${A6.id}.md`), "utf8")).toContain(RERUN_LABEL);
  });

  it("both attempts are stored, and survive a --resume load", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const flaky = flakyModel(textModel(["Doing well, thanks!"]), [err(503), err(503), err(503), err(503)]);
    const { o } = setup(flaky.model as never);
    await runAll(o);
    const stored = loadStored(dir, A6, ids, 1);
    expect(stored?.runs[0]?.firstAttempt?.infra).toEqual(["provider 5xx"]);
  });

  it("only one rerun: a second infra failure is kept as it is, not retried again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const main = flakyModel(textModel(["x"]), Array.from({ length: 20 }, () => err(503)));
    const { o } = setup(main.model as never);
    const out = await runAll(o);
    const run = out.reports[0]!.runs[0]!;
    expect(run.infra).toEqual(["provider 5xx"]);
    expect(run.firstAttempt).toBeDefined();
    expect(main.attempts()).toBe(8); // 2 attempts x (1 call + 3 retries): no third attempt
    expect(renderResults(out.reports, meta)).toContain("attempt 2 also had: provider 5xx");
  });

  it("a wrong answer is not rerun", async () => {
    const main = textModel(["Hello."]);
    const { o, logs } = setup(main);
    o.cases = [loadCases().find((c) => c.id.startsWith("A1-"))!]; // needs "Postgres" and "Bun": fails, but it is not infra
    const out = await runAll(o);
    expect(out.reports[0]!.runs[0]!.firstAttempt).toBeUndefined();
    expect(logs.some((l) => l.startsWith("INFRA"))).toBe(false);
    expect(main.doStreamCalls).toHaveLength(1);
    expect(existsSync(join(dir, ".tmp", "results", `${o.cases[0]!.id}.json`))).toBe(true);
  });
});
