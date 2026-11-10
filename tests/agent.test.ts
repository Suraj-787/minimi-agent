import { beforeEach, describe, expect, it } from "vitest";
import { runAgent, type AgentDeps } from "../src/agent/index";
import { SYSTEM_PROMPT } from "../src/agent/prompts";
import { openDb, type Db } from "../src/db/index";
import { hasAssistantReplyAfter, listMessages } from "../src/db/repo";
import { failingModel, gatedModel, textModel } from "./helpers/mockModel";

const NOW = new Date("2026-11-12T05:30:00Z");
const TID = "11111111-1111-4111-8111-111111111111";
let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
});
const deps = (main: AgentDeps["models"]["main"]): AgentDeps => ({ db, models: { main }, now: () => NOW });
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
