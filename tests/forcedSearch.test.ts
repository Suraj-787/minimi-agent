import { describe, expect, it } from "vitest";
import { runAgent, type AgentDeps } from "../src/agent/index";
import { createStepPolicy, NO_ANSWER_TEXT } from "../src/agent/stepPolicy";
import { getTrace } from "../src/db/memoryRepo";
import { listMessages } from "../src/db/repo";
import { emptyExtraction, objectModel, scriptedModel } from "./helpers/mockModel";
import { fixedSearch } from "./helpers/search";
import { IST, SEED_NOW, seededDb } from "./helpers/seed";

// A forced search step the model ignores must never fail the turn (D63): mocked models, no network.

type Step = Parameters<typeof scriptedModel>[0][number];
const FORCED = { type: "tool", toolName: "web_search" };
const TID = "66666666-6666-4666-8666-666666666666";
const VERIFY = "Last Tuesday I asked you about Postgres hosting. Has Supabase's price changed since then?";
const NEWS = "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?";
const TABLE = "| Item | Said (date) | Then → Now | Status | Evidence date | Source |\n|---|---|---|---|---|---|\n";
const PAGE = { title: "Supabase Pricing", url: "https://supabase.com/pricing", publishedDate: "2026-11-11", snippet: "Pro plan: $29/month." };

async function turn(script: Step[], message: string, maxSteps = 4) {
  const db = seededDb();
  const main = scriptedModel(script);
  const small = objectModel(emptyExtraction);
  const search = fixedSearch([PAGE]);
  const deps: AgentDeps = {
    db,
    models: { main, small },
    now: () => SEED_NOW,
    search,
    maxSteps,
    retry: { sleep: async () => undefined, rand: () => 0 },
  };
  const run = await runAgent(deps, { threadId: TID, message, tz: IST });
  const reader = run.stream.getReader();
  while (!(await reader.read()).done);
  await run.done;
  const last = listMessages(db, TID).at(-1);
  const trace = getTrace(db, run.assistantMessageId);
  const errors = JSON.parse(trace?.errors_json ?? "[]") as Array<Record<string, unknown>>;
  const steps = JSON.parse(trace?.steps_json ?? "[]") as Array<Record<string, unknown>>;
  return { main, search, last, errors, steps, small, db };
}

const lastUserText = (call: { prompt: unknown } | undefined) => JSON.stringify((call?.prompt as unknown[] | undefined)?.at(-1));

describe("forced search steps never fail the turn", () => {
  it("a forced step answered in text is retried once on auto, with a note to mark unsearched items Couldn't verify", async () => {
    const answer = `${TABLE}| Supabase Pro | 2026-11-03 | $25 → ? | Couldn't verify | – | – |\n\nCouldn't verify Supabase: the search could not be completed, as of 12 Nov 2026.`;
    const { main, search, last, errors } = await turn([{ text: "Supabase is probably still $25." }, { text: answer }], VERIFY);

    expect(last?.status).toBe("complete");
    expect(last?.text).toBe(answer); // the discarded forced attempt is never shown
    expect(search.calls).toHaveLength(0);
    expect(main.doStreamCalls).toHaveLength(2);
    expect(main.doStreamCalls[0]?.toolChoice).toEqual(FORCED);
    expect(main.doStreamCalls[1]?.toolChoice).toEqual({ type: "auto" });
    const note = lastUserText(main.doStreamCalls[1]);
    expect(note).toContain("NOT searched");
    expect(note).toContain("Supabase");
    expect(note).toContain("Couldn't verify");
    expect(errors.find((e) => "forcedSearchViolation" in e)).toMatchObject({
      forcedSearchViolation: [{ step: 0, mode: "force", action: "retried-auto" }],
    });
  });

  it("when the auto retry searches, the turn goes on, and no later step is forced again", async () => {
    const { main, search, last, errors } = await turn(
      [
        { text: "Let me think." }, // forced step 0 ignored
        { toolCall: { name: "web_search", input: { queries: ["HubSpot pricing", "Pipedrive pricing"] } } }, // the auto retry
        { text: `${TABLE}| HubSpot | 9 Nov | $90 → $90 | Unchanged | 2026-11-11 | [1] |` },
      ],
      NEWS,
    );
    expect(last?.status).toBe("complete");
    expect(search.calls.length).toBeGreaterThanOrEqual(1);
    // The news pass is still owed, but forcing was abandoned: step 1 is auto, not forced.
    expect(main.doStreamCalls).toHaveLength(3);
    expect(main.doStreamCalls[2]?.toolChoice).not.toEqual(FORCED);
    expect(errors.some((e) => "forcedSearchViolation" in e)).toBe(true);
  });

  it("a tool call on the last, no-tools step is dropped; the one closing retry then gives the answer", async () => {
    const { main, last, errors } = await turn(
      [
        { toolCall: { name: "web_search", input: { queries: ["again"] } } },
        { toolCall: { name: "web_search", input: { queries: ["again"] } } },
        { toolCall: { name: "web_search", input: { queries: ["still again"] } } }, // ignores toolChoice none
        { text: "Here is what I found." }, // the closing retry
      ],
      "loop forever",
      3,
    );
    expect(main.doStreamCalls).toHaveLength(4);
    expect(main.doStreamCalls[2]?.toolChoice).toEqual({ type: "none" });
    expect(main.doStreamCalls[3]?.toolChoice).toEqual({ type: "none" });
    expect(lastUserText(main.doStreamCalls[3])).toContain("Searching is closed. Answer now from the results above; mark any item without evidence Couldn't verify.");
    expect(last).toMatchObject({ status: "complete", text: "Here is what I found." });
    expect(errors.find((e) => "forcedSearchViolation" in e)).toMatchObject({
      forcedSearchViolation: [
        { step: 2, mode: "none", action: "dropped-tool-call" },
        { step: 2, mode: "none", action: "retried-closed" },
      ],
    });
  });

  it("D69: verify mode, every item searched in step 0 -> step 1 is a no-tools step, and the answer is the model's", async () => {
    const answer = `${TABLE}| Supabase Pro | 2026-11-03 | $25 → $29 | Differs now (timing unknown) | 2026-11-11 | [1] |`;
    const { main, search, last, steps } = await turn(
      [{ toolCall: { name: "web_search", input: { queries: ["Supabase pricing"] } } }, { text: answer }],
      VERIFY,
    );
    expect(search.calls).toHaveLength(1);
    expect(main.doStreamCalls).toHaveLength(2);
    expect(main.doStreamCalls[1]?.toolChoice).toEqual({ type: "none" });
    expect(main.doStreamCalls[1]?.tools ?? []).toEqual([]); // activeTools [] : no tool definitions are sent
    expect(last).toMatchObject({ status: "complete", text: answer });
    // e) per-step record: finish reason, tool-call names, text length
    expect(steps[0]).toMatchObject({ step: 0, mode: "force", finishReason: "tool-calls", toolCalls: ["web_search"], textChars: 0 });
    expect(steps[1]).toMatchObject({ step: 1, mode: "none", finishReason: "stop", toolCalls: [], textChars: answer.length });
    expect(steps[1]).not.toHaveProperty("droppedToolCalls");
  });

  it("D69: verify mode, a model that keeps returning tool calls still ends with a model-written answer", async () => {
    const answer = `${TABLE}| Supabase Pro | 2026-11-03 | $25 → ? | Couldn't verify | – | – |\n\nCouldn't verify Supabase.`;
    const { main, search, last, steps, errors } = await turn(
      [
        { toolCall: { name: "web_search", input: { queries: ["Supabase pricing"] } } }, // step 0, forced
        { toolCall: { name: "web_search", input: { queries: ["more Supabase pricing"] } } }, // step 1: closed, but the model calls anyway
        { text: answer }, // the closing retry
      ],
      VERIFY,
    );
    expect(search.calls).toHaveLength(1); // the dropped call never ran
    expect(last).toMatchObject({ status: "complete", text: answer });
    expect(steps[1]).toMatchObject({ mode: "none", droppedToolCalls: ["web_search"], textChars: answer.length });
    expect(errors.some((e) => "forcedSearchViolation" in e)).toBe(true);
  });

  it("D69: still no text after the closing retry -> an error row, no memory extraction, no summary or claims written", async () => {
    const { last, small, db, steps } = await turn(
      [{ toolCall: { name: "web_search", input: { queries: ["Supabase pricing"] } } }], // every call is a tool call, forever
      VERIFY,
    );
    expect(last?.status).toBe("error");
    expect(last?.text).toBe(`⚠️ ${NO_ANSWER_TEXT}`);
    expect(small.doGenerateCalls).toHaveLength(0); // writeMemory never ran
    expect(db.prepare("SELECT COUNT(*) AS n FROM memory_writes WHERE op != 'add'").get()).toEqual({ n: 0 });
    expect(steps[1]).toMatchObject({ mode: "none", textChars: 0 });
  });

  it("a forced step that does search is passed through untouched (one model call, no note)", async () => {
    const { main, last, errors } = await turn(
      [
        { toolCall: { name: "web_search", input: { queries: ["Supabase pricing"] } } },
        { text: `${TABLE}| Supabase Pro | 2026-11-03 | $25 → $29 | Differs now (timing unknown) | 2026-11-11 | [1] |` },
      ],
      VERIFY,
    );
    expect(last?.status).toBe("complete");
    expect(main.doStreamCalls[0]?.toolChoice).toEqual(FORCED);
    expect(lastUserText(main.doStreamCalls[1])).not.toContain("NOT searched");
    expect(errors.some((e) => "forcedSearchViolation" in e)).toBe(false);
  });
});

describe("createStepPolicy", () => {
  const modes = (maxSteps: number, steps: number, want = true) => {
    const p = createStepPolicy({ maxSteps });
    return Array.from({ length: steps }, (_, i) => p.plan(i, { wantForce: want }));
  };
  it("forces at most 3 steps, and never the last one", () => {
    expect(modes(10, 6)).toEqual(["force", "force", "force", "auto", "auto", "auto"]);
    expect(modes(4, 4)).toEqual(["force", "force", "force", "none"]);
    expect(modes(3, 3)).toEqual(["force", "force", "none"]);
    expect(modes(2, 2)).toEqual(["force", "none"]);
    expect(modes(1, 1)).toEqual(["none"]);
  });
  it("does not force when nothing is owed", () => {
    expect(modes(4, 4, false)).toEqual(["auto", "auto", "auto", "none"]);
  });
  it("stops forcing once a forced step was ignored", () => {
    const p = createStepPolicy({ maxSteps: 6 });
    expect(p.plan(0, { wantForce: true })).toBe("force");
    p.record({ step: 0, mode: "force", action: "retried-auto" });
    expect(p.plan(1, { wantForce: true })).toBe("auto");
    expect(p.state()).toMatchObject({ forcedSteps: 1, abandoned: true });
  });
});
