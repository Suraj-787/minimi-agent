import { beforeEach, describe, expect, it } from "vitest";
import { runAgent, type AgentDeps } from "../src/agent/index";
import { openDb, type Db } from "../src/db/index";
import { listMessages } from "../src/db/repo";
import { getTrace } from "../src/db/memoryRepo";
import { emptyExtraction, errorAfterText, errorChunkFirst, flakyModel, httpError, objectModel, scriptedModel, textModel } from "./helpers/mockModel";
import { fixedSearch, noSearch } from "./helpers/search";

const NOW = new Date("2026-11-12T05:30:00Z");
const TID = "22222222-2222-4222-8222-222222222222";
let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
});

const waits: number[] = [];
const deps = (main: AgentDeps["models"]["main"], search: AgentDeps["search"] = noSearch): AgentDeps => ({
  db,
  models: { main, small: objectModel(emptyExtraction) },
  now: () => NOW,
  search,
  maxSteps: 4,
  retry: { sleep: async (ms) => void waits.push(ms), rand: () => 1 },
});
const input = (message: string) => ({ threadId: TID, message, tz: "Asia/Kolkata" });

async function drain(run: Awaited<ReturnType<typeof runAgent>>): Promise<Array<{ type: string; [k: string]: unknown }>> {
  const out: Array<{ type: string; [k: string]: unknown }> = [];
  for await (const c of run.stream) out.push(c as never);
  await run.done;
  return out;
}
const statuses = (chunks: Array<{ type: string; data?: unknown }>) =>
  chunks.filter((c) => c.type === "data-status").map((c) => (c.data as { text: string }).text);

describe("model retries inside a turn (D45)", () => {
  beforeEach(() => void (waits.length = 0));

  it("a 429 from doStream is retried, shows a status, and the turn completes", async () => {
    const { model, attempts } = flakyModel(textModel(["Fine."]), [httpError(429)]);
    const chunks = await drain(await runAgent(deps(model), input("hi")));
    expect(attempts()).toBe(2);
    expect(statuses(chunks)).toEqual(["Rate-limited by the model provider, retrying…"]);
    expect(listMessages(db, TID).at(-1)).toMatchObject({ text: "Fine.", status: "complete" });
  });

  it("a 503 on the ANSWER step after a search retries only the model call, not web_search", async () => {
    const search = fixedSearch([{ title: "Node", url: "https://nodejs.org/", snippet: "v26" }]);
    const script = scriptedModel([
      { toolCall: { name: "web_search", input: { queries: ["node latest"] } } },
      { text: "Node 26 [1]." },
    ]);
    // call 0 = search step (ok), call 1 = answer step fails once, call 2 = answer step again
    const { model, attempts } = flakyModel(script, [undefined, httpError(503)]);
    const run = await runAgent(deps(model, search), input("latest node?"));
    const chunks = await drain(run);
    expect(search.calls).toHaveLength(1);
    expect(attempts()).toBe(3);
    expect(statuses(chunks)).toContain("The model provider had an error, retrying…");
    expect(listMessages(db, TID).at(-1)).toMatchObject({ text: "Node 26 [1].", status: "complete" });
    expect(JSON.parse(getTrace(db, run.assistantMessageId)?.usage_json ?? "{}").retries).toBe(1);
  });

  it("an error part before any content is retried", async () => {
    const chunks = await drain(await runAgent(deps(errorChunkFirst(httpError(503), ["Recovered."])), input("hi")));
    expect(listMessages(db, TID).at(-1)).toMatchObject({ text: "Recovered.", status: "complete" });
    expect(statuses(chunks)).toHaveLength(1);
  });

  it("an error part AFTER text has started is not retried: the turn is saved as an error, text kept", async () => {
    const model = errorAfterText("Half an ans", httpError(503));
    await drain(await runAgent(deps(model), input("hi")));
    expect(waits).toEqual([]);
    expect(listMessages(db, TID).at(-1)).toMatchObject({ status: "error" });
    expect(listMessages(db, TID).at(-1)?.text).toContain("Half an ans");
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it("a daily-quota 429 fails fast with the friendly message and no retry", async () => {
    const body = '{"error":{"details":[{"violations":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}]}}';
    const { model, attempts } = flakyModel(textModel(["x"]), [httpError(429, { body })]);
    await drain(await runAgent(deps(model), input("hi")));
    expect(attempts()).toBe(1);
    expect(waits).toEqual([]);
    expect(listMessages(db, TID).at(-1)?.text).toMatch(/daily free quota is used up/);
  });

  it("waits the Retry-After the provider gave", async () => {
    const { model } = flakyModel(textModel(["ok"]), [httpError(429, { headers: { "retry-after": "4" } })]);
    await drain(await runAgent(deps(model), input("hi")));
    expect(waits).toEqual([4000]);
  });
});

describe("turn timings in the trace", () => {
  it("stores context, first-token and total latency, plus usage and queries", async () => {
    const search = fixedSearch([{ title: "Node", url: "https://nodejs.org/", snippet: "v26" }]);
    const script = scriptedModel([
      { toolCall: { name: "web_search", input: { queries: ["node latest"] } } },
      { text: "Node 26 [1]." },
    ]);
    const run = await runAgent(deps(script, search), input("latest node?"));
    await drain(run);
    const t = getTrace(db, run.assistantMessageId);
    expect(t?.context_ms).toBeGreaterThanOrEqual(0);
    expect(t?.first_token_ms).toBeGreaterThanOrEqual(0);
    expect(t?.total_ms).toBeGreaterThanOrEqual(t?.first_token_ms ?? 0);
    expect(JSON.parse(t?.queries_json ?? "[]")).toEqual([{ query: "node latest", provider: "exa", cached: false }]);
    expect(t?.provider).toBe("exa");
    expect(JSON.parse(t?.usage_json ?? "{}").steps).toBe(2);
  });
});

describe("both search providers down", () => {
  it("tells the model search is unavailable (it caveats) and the trace records it", async () => {
    const search: AgentDeps["search"] = {
      run: async (i) => ({ results: [], sources: [], failed: i.queries, allFailed: true }),
    };
    const script = scriptedModel([
      { toolCall: { name: "web_search", input: { queries: ["node latest"] } } },
      { text: "I couldn't search right now; from memory, Node 24." },
    ]);
    const run = await runAgent(deps(script, search), input("latest node?"));
    await drain(run);
    const second = JSON.stringify(script.doStreamCalls[1]?.prompt);
    expect(second).toContain("Search is unavailable right now");
    expect(JSON.parse(getTrace(db, run.assistantMessageId)?.errors_json ?? "[]")).toContainEqual({ searchUnavailable: 1 });
    expect(listMessages(db, TID).at(-1)?.status).toBe("complete");
  });
});

describe("answer checks recorded in the trace (D50, D51)", () => {
  const errorsOf = (id: string): Array<Record<string, unknown>> =>
    JSON.parse(getTrace(db, id)?.errors_json ?? "[]") as Array<Record<string, unknown>>;
  const page = [{ title: "Node", url: "https://nodejs.org/", snippet: "v26" }];
  const answer = (text: string) =>
    scriptedModel([{ toolCall: { name: "web_search", input: { queries: ["node latest"] } } }, { text }]);

  it("a raw markdown link or bare URL is recorded as rawLinks; [n] is not", async () => {
    const bad = await runAgent(deps(answer("Node 26 ([nodejs.org](https://nodejs.org/)) [1]."), fixedSearch(page)), input("latest node?"));
    await drain(bad);
    expect(errorsOf(bad.assistantMessageId)).toContainEqual({ rawLinks: ["[nodejs.org](https://nodejs.org/)"] });
    const good = await runAgent(deps(answer("Node 26 [1]."), fixedSearch(page)), input("latest node again?"));
    await drain(good);
    expect(errorsOf(good.assistantMessageId).some((e) => "rawLinks" in e)).toBe(false);
  });

  it("records the first status time and when the user sees 'Searching' before any text", async () => {
    const run = await runAgent(deps(answer("Node 26 [1]."), fixedSearch(page)), input("latest node?"));
    await drain(run);
    const t = getTrace(db, run.assistantMessageId);
    expect(t?.first_status_ms).toBeGreaterThanOrEqual(0);
    expect(t?.first_status_ms).toBeLessThanOrEqual(t?.first_token_ms ?? 0);
  });

  it("a turn with no search has no first status", async () => {
    const run = await runAgent(deps(textModel(["hi!"])), input("hey"));
    await drain(run);
    expect(getTrace(db, run.assistantMessageId)?.first_status_ms).toBeNull();
  });
});
