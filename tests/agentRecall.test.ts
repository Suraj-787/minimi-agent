import { describe, expect, it } from "vitest";
import { runAgent, type AgentDeps } from "../src/agent/index";
import { SYSTEM_PROMPT } from "../src/agent/prompts";
import type { Db } from "../src/db/index";
import { getTrace } from "../src/db/memoryRepo";
import { listMessages } from "../src/db/repo";
import { textModel, objectModel, emptyExtraction } from "./helpers/mockModel";
import { noSearch } from "./helpers/search";
import { IST, SEED_NOW, seededDb } from "./helpers/seed";

const TID = "33333333-3333-4333-8333-333333333333";
const deps = (db: Db, main: AgentDeps["models"]["main"]): AgentDeps => ({
  db,
  models: { main, small: objectModel(emptyExtraction) },
  now: () => SEED_NOW,
  search: noSearch,
  maxSteps: 4,
});

type PromptMsg = { role: string; content: unknown };
const promptOf = (model: ReturnType<typeof textModel>, i: number) => model.doStreamCalls[i]?.prompt as PromptMsg[];
// The static system prompt mentions <memory> itself, so only the conversation part is checked for injected memory.
const conversation = (msgs: PromptMsg[]) => JSON.stringify(msgs.filter((m) => m.role !== "system"));

describe("runAgent with recall", () => {
  it("system prompt is byte-identical whether or not memory is recalled", async () => {
    const db = seededDb();
    const model = textModel(["ok"]);
    await (await runAgent(deps(db, model), { threadId: TID, message: "hey", tz: IST })).done;
    await (await runAgent(deps(db, model), { threadId: TID, message: "What did I ask you on 3 November?", tz: IST })).done;
    const [first, second] = [promptOf(model, 0), promptOf(model, 1)];
    expect(first.find((m) => m.role === "system")?.content).toBe(SYSTEM_PROMPT);
    expect(second.find((m) => m.role === "system")?.content).toBe(SYSTEM_PROMPT);
    expect(conversation(first)).not.toContain("<memory");
    expect(conversation(second)).toContain("<memory");
    expect(conversation(second)).toContain("Which managed Postgres host");
  });

  it("memory goes in front of the latest user message only and is never persisted", async () => {
    const db = seededDb();
    const model = textModel(["ok"]);
    const message = "What did I ask you on 3 November?";
    await (await runAgent(deps(db, model), { threadId: TID, message, tz: IST })).done;
    const users = promptOf(model, 0).filter((m) => m.role === "user");
    expect(JSON.stringify(users.at(-1))).toContain("<memory");
    const stored = listMessages(db, TID);
    expect(stored[0]?.text).toBe(message);
    expect(stored.every((m) => !m.text.includes("<memory") && !m.text.includes("<context"))).toBe(true);
  });

  it("writes a trace with resolved dates, rules fired, memory ids and chars", async () => {
    const db = seededDb();
    const run = await runAgent(deps(db, textModel(["ok"])), { threadId: TID, message: "What did I ask you on 3 November?", tz: IST });
    await run.done;
    const trace = getTrace(db, run.assistantMessageId);
    expect(JSON.parse(trace?.recall_rules_json ?? "null")).toEqual(["R0", "R1"]);
    expect(JSON.parse(trace?.resolved_dates_json ?? "{}").resolved).toEqual(["2026-11-03"]);
    expect(JSON.parse(trace?.memory_ids_json ?? "{}").turns).toHaveLength(2);
    expect(trace?.memory_chars).toBeGreaterThan(0);
    expect(JSON.parse(trace?.intent_json ?? "{}")).toEqual({ verify: false, cues: [], news: false, forcedSearch: false });
  });

  it("an unrelated question records R0 only and injects nothing", async () => {
    const db = seededDb();
    const model = textModel(["ok"]);
    const run = await runAgent(deps(db, model), { threadId: TID, message: "How do I structure a REST API error?", tz: IST });
    await run.done;
    expect(conversation(promptOf(model, 0))).not.toContain("<memory");
    const trace = getTrace(db, run.assistantMessageId);
    expect(JSON.parse(trace?.recall_rules_json ?? "null")).toEqual(["R0"]);
    expect(trace?.memory_chars).toBe(0);
  });
});
