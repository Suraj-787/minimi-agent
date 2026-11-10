import { beforeEach, describe, expect, it } from "vitest";
import { runAgent, type AgentDeps } from "../src/agent/index";
import { SYSTEM_PROMPT } from "../src/agent/prompts";
import { openDb, type Db } from "../src/db/index";
import { hasAssistantReplyAfter, listMessages } from "../src/db/repo";
import type { Search, SearchOutcome } from "../src/search/index";
import { failingModel, gatedModel, scriptedModel, textModel, objectModel, emptyExtraction } from "./helpers/mockModel";
import { noSearch } from "./helpers/search";

const NOW = new Date("2026-11-12T05:30:00Z");
const TID = "11111111-1111-4111-8111-111111111111";
let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
});
const deps = (main: AgentDeps["models"]["main"]): AgentDeps => ({ db, models: { main, small: objectModel(emptyExtraction) }, now: () => NOW, search: noSearch, maxSteps: 4 });
const input = (message: string) => ({ threadId: TID, message, tz: "Asia/Kolkata" });

async function readAll(stream: ReadableStream<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const c of stream) out.push(c);
  return out;
}

describe("runAgent", () => {
  it("persists the raw user message and the assistant reply; done waits for both", async () => {
    const run = await runAgent(deps(textModel(["Hello", " there"])), input("hi"));
    await readAll(run.stream);
    await run.done;
    const rows = listMessages(db, TID);
    expect(rows.map((r) => [r.role, r.text, r.status])).toEqual([
      ["user", "hi", "complete"],
      ["assistant", "Hello there", "complete"],
    ]);
    expect(rows[1]?.id).toBe(run.assistantMessageId);
    expect(rows[0]?.local_date).toBe("2026-11-12");
  });

  it("done resolves only after persistence, even if nobody reads the stream", async () => {
    const run = await runAgent(deps(textModel(["quiet"])), input("hi"));
    await run.done;
    expect(listMessages(db, TID).at(-1)?.text).toBe("quiet");
  });

  it("shows the model the time anchor but never stores it", async () => {
    const model = textModel(["ok"]);
    const run = await runAgent(deps(model), input("what day is it"));
    await run.done;
    const prompt = JSON.stringify(model.doStreamCalls[0]?.prompt);
    expect(prompt).toContain("2026-11-12 11:00 (Thursday)");
    expect(listMessages(db, TID)[0]?.text).toBe("what day is it");
  });

  it("sends a byte-identical system prompt on every turn", async () => {
    const model = textModel(["ok"]);
    await (await runAgent(deps(model), input("one"))).done;
    await (await runAgent({ ...deps(model), now: () => new Date("2027-01-01T00:00:00Z") }, input("two"))).done;
    const systems = model.doStreamCalls.map(
      (c) => (c.prompt as { role: string; content: unknown }[]).find((m) => m.role === "system")?.content,
    );
    expect(systems).toEqual([SYSTEM_PROMPT, SYSTEM_PROMPT]);
  });

  it("titles a new thread from the first message", async () => {
    await (await runAgent(deps(textModel(["ok"])), input("Which managed Postgres host is cheapest?"))).done;
    const t = db.prepare("SELECT title FROM threads WHERE id = ?").get(TID) as { title: string };
    expect(t.title).toBe("Which managed Postgres host is cheapest?");
  });

  it("history sent to the model starts with a user message even when the cap cuts mid-pair", async () => {
    const model = textModel(["ok"]);
    for (let i = 0; i < 8; i++) await (await runAgent(deps(model), input(`question ${i} ${"z".repeat(900)}`))).done;
    const last = model.doStreamCalls.at(-1)?.prompt as { role: string }[];
    expect(last.filter((m) => m.role !== "system")[0]?.role).toBe("user");
  });
});

describe("disconnect safety", () => {
  it("saves the full reply when the client cancels mid-stream", async () => {
    const { model, release } = gatedModel("Partial ", "and the rest");
    const run = await runAgent(deps(model), input("hi"));
    const reader = run.stream.getReader();
    await reader.read(); // the client sees the first chunk...
    // ...then disconnects. Not awaited: a tee branch's cancel() settles only when BOTH branches are
    // cancelled, and the server-side branch is deliberately still being drained.
    void reader.cancel();
    release(); // the model keeps going
    await run.done;
    const reply = listMessages(db, TID).at(-1);
    expect(reply?.role).toBe("assistant");
    expect(reply?.text).toBe("Partial and the rest");
    expect(reply?.status).toBe("complete");
    expect(hasAssistantReplyAfter(db, run.userMessageId)).toBe(true);
  });
});

describe("provider failures", () => {
  it.each([
    [401, /API key/],
    [400, /Something went wrong/],
    [429, /rate-limit/],
    [500, /server error/],
  ])("status %i: streams a readable error and still writes an assistant row", async (status, re) => {
    const run = await runAgent(deps(failingModel(status)), input("hi"));
    const chunks = (await readAll(run.stream)) as { type: string; errorText?: string }[];
    await run.done;
    const err = chunks.find((c) => c.type === "error");
    expect(err?.errorText).toMatch(re);
    expect(err?.errorText).not.toContain("AIza"); // provider message must not leak to the client
    const reply = listMessages(db, TID).at(-1);
    expect(reply?.role).toBe("assistant");
    expect(reply?.status).toBe("error");
    expect(reply?.text).toMatch(re);
    expect(hasAssistantReplyAfter(db, run.userMessageId)).toBe(true);
  });

  it("an error row is not replayed to the model on the next turn", async () => {
    await (await runAgent(deps(failingModel(429)), input("first"))).done;
    const model = textModel(["ok"]);
    await (await runAgent(deps(model), input("second"))).done;
    const prompt = JSON.stringify(model.doStreamCalls[0]?.prompt);
    expect(prompt).not.toContain("rate-limit");
    expect(prompt).toContain("first");
  });
});

describe("runAgent with web_search", () => {
  const found = (n: number): SearchOutcome => ({
    results: [{ n, isNew: true, query: "q", title: `Node ${n}`, url: `https://nodejs.org/${n}`, publishedDate: "2026-11-05", snippet: "LTS" }],
    sources: [{ query: "q", provider: "exa", cached: false }],
    failed: [],
    allFailed: false,
  });
  const searchOf = (calls: unknown[]): Search => ({
    run: async (input, turn) => {
      calls.push(input);
      const { n } = turn.numberFor(`https://nodejs.org/${calls.length}`);
      return found(n);
    },
  });

  it("searches, streams status + sources, and persists sources with their dates", async () => {
    const calls: unknown[] = [];
    const model = scriptedModel([
      { toolCall: { name: "web_search", input: { queries: ["latest node version"], fresh: true } } },
      { text: "Node 24 [1]." },
    ]);
    const run = await runAgent({ ...deps(model), search: searchOf(calls) }, input("What's the latest Node?"));
    const chunks = (await readAll(run.stream)) as Array<Record<string, unknown>>;
    await run.done;

    expect(calls).toEqual([{ queries: ["latest node version"], fresh: true }]);
    const status = chunks.find((c) => c.type === "data-status");
    expect(status).toMatchObject({ data: { text: "Searching: latest node version" }, transient: true });
    expect(chunks.find((c) => c.type === "source-url")).toMatchObject({ sourceId: "src-1", url: "https://nodejs.org/1" });

    const row = listMessages(db, TID).at(-1)!;
    expect(row.text).toBe("Node 24 [1].");
    const parts = JSON.parse(row.parts_json!) as Array<Record<string, unknown>>;
    const source = parts.find((p) => p.type === "source-url");
    expect(source).toMatchObject({ providerMetadata: { search: { n: 1, publishedDate: "2026-11-05" } } });
    expect(parts.some((p) => p.type === "data-status")).toBe(false); // transient: never persisted
  });

  it("does not search for chit-chat", async () => {
    const run = await runAgent(deps(textModel(["I'm good!"])), input("hey, how's it going?"));
    await readAll(run.stream);
    await run.done; // noSearch throws if it is ever called
    expect(listMessages(db, TID).at(-1)?.text).toBe("I'm good!");
  });

  it("stops at maxSteps and forces the last step to answer in text", async () => {
    const calls: unknown[] = [];
    const model = scriptedModel([{ toolCall: { name: "web_search", input: { queries: ["again"] } } }]);
    const run = await runAgent({ ...deps(model), search: searchOf(calls), maxSteps: 3 }, input("loop forever"));
    await readAll(run.stream);
    await run.done;
    expect(model.doStreamCalls).toHaveLength(3);
    expect(calls).toHaveLength(2); // steps 1 and 2 search; step 3 is not allowed to
    expect(model.doStreamCalls[2]?.toolChoice).toEqual({ type: "none" });
    expect(model.doStreamCalls[0]?.toolChoice).not.toEqual({ type: "none" });
  });

  it("a search outage becomes tool output the model can caveat, not a failed turn", async () => {
    const down: Search = { run: async () => ({ results: [], sources: [], failed: ["q"], allFailed: true }) };
    const model = scriptedModel([
      { toolCall: { name: "web_search", input: { queries: ["q"] } } },
      { text: "I couldn't search right now, but from memory…" },
    ]);
    const run = await runAgent({ ...deps(model), search: down }, input("latest node?"));
    await readAll(run.stream);
    await run.done;
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain("Search is unavailable");
    expect(listMessages(db, TID).at(-1)?.status).toBe("complete");
  });
});
