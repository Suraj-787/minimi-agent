import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgent } from "../src/agent/index";
import { getModels } from "../src/agent/model";
import { isThinkingRejection, resetThinkingRejections } from "../src/agent/stepPolicy";
import { mergeProviderOptions, stepKind, thinkingOptions } from "../src/agent/thinking";
import { getTrace } from "../src/db/memoryRepo";
import { loadEnv } from "../src/lib/env";
import { parseThinking } from "../src/lib/thinking";
import type { Search } from "../src/search/index";
import { emptyExtraction, objectModel, scriptedModel } from "./helpers/mockModel";
import { fixedSearch } from "./helpers/search";
import { IST, SEED_NOW, seededDb } from "./helpers/seed";

const BASE = { GOOGLE_GENERATIVE_AI_API_KEY: "k", EXA_API_KEY: "e" };

describe("parseThinking / env", () => {
  it("accepts default, the four levels and an integer budget; rejects the rest", () => {
    expect(parseThinking("LOW")).toBe("low");
    expect(parseThinking("default")).toBe("default");
    expect(parseThinking("0")).toBe(0);
    expect(parseThinking("8192")).toBe(8192);
    for (const bad of ["", "max", "-1", "1.5", "lots"]) expect(parseThinking(bad), bad).toBeUndefined();
  });
  it("MAIN_THINKING and MAIN_THINKING_ANSWER both default to low (the answer step took ~48 s to its first token at the provider default)", () => {
    const e = loadEnv(BASE);
    expect(e.MAIN_THINKING).toBe("low");
    expect(e.MAIN_THINKING_ANSWER).toBe("low");
    expect(loadEnv({ ...BASE, MAIN_THINKING: "minimal", MAIN_THINKING_ANSWER: "2048" })).toMatchObject({ MAIN_THINKING: "minimal", MAIN_THINKING_ANSWER: 2048 });
    expect(() => loadEnv({ ...BASE, MAIN_THINKING: "max" })).toThrow(/MAIN_THINKING/);
  });
});

describe("thinkingOptions", () => {
  it("Gemini 3 and later: a thinkingLevel", () => {
    expect(thinkingOptions("google", "gemini-flash-latest", "low")).toEqual({ google: { thinkingConfig: { thinkingLevel: "low" } } });
  });
  it("Gemini 2.5: a token budget (levels are not supported there); Pro keeps its 128 floor", () => {
    expect(thinkingOptions("google", "gemini-2.5-flash", "low")).toEqual({ google: { thinkingConfig: { thinkingBudget: 1024 } } });
    expect(thinkingOptions("google", "gemini-2.5-flash", "minimal")).toEqual({ google: { thinkingConfig: { thinkingBudget: 0 } } });
    expect(thinkingOptions("google", "gemini-2.5-pro", "minimal")).toEqual({ google: { thinkingConfig: { thinkingBudget: 128 } } });
  });
  it("a number is a budget; default and other providers send nothing", () => {
    expect(thinkingOptions("google", "gemini-flash-latest", 512)).toEqual({ google: { thinkingConfig: { thinkingBudget: 512 } } });
    expect(thinkingOptions("google", "x", "default")).toBeUndefined();
    expect(thinkingOptions("openai", "gpt", "low")).toBeUndefined();
    expect(thinkingOptions("anthropic", "claude", "high")).toBeUndefined();
  });
  it("getModels builds the per-kind options from env", () => {
    const e = loadEnv({ ...BASE, MAIN_THINKING: "low", MAIN_THINKING_ANSWER: "medium" });
    expect(getModels(e).mainThinking).toEqual({
      tool: { google: { thinkingConfig: { thinkingLevel: "low" } } },
      answer: { google: { thinkingConfig: { thinkingLevel: "medium" } } },
    });
    expect(getModels(loadEnv({ ...BASE, MAIN_THINKING: "default", MAIN_THINKING_ANSWER: "default" })).mainThinking).toBeUndefined();
  });
  it("stepKind: the first step and forced steps are tool steps, later ones answer", () => {
    expect(stepKind(0, "auto")).toBe("tool");
    expect(stepKind(1, "force")).toBe("tool");
    expect(stepKind(1, "auto")).toBe("answer");
    expect(stepKind(3, "none")).toBe("answer");
  });
  it("mergeProviderOptions keeps what the caller set", () => {
    expect(mergeProviderOptions({ google: { a: 1 }, other: { b: 2 } }, { google: { thinkingConfig: { thinkingLevel: "low" } } })).toEqual({
      google: { a: 1, thinkingConfig: { thinkingLevel: "low" } },
      other: { b: 2 },
    });
  });
});

const TID = "77777777-7777-4777-8777-777777777777";
const VERIFY = "Last Tuesday I asked you about Postgres hosting. Has Supabase's price changed since then?";
const PAGE = { title: "Supabase Pricing", url: "https://supabase.com/pricing", publishedDate: "2026-11-11", snippet: "Pro plan: $29/month." };
const TABLE = "| Item | Said (date) | Then → Now | Status | Evidence date | Source |\n|---|---|---|---|---|---|\n| Supabase Pro | 2026-11-03 | $25 → $29 | Differs now (timing unknown) | 2026-11-11 | [1] |";

describe("per-step thinking and timing in a real turn", () => {
  it("applies the tool setting to the forced first step and the answer setting to the answer step, and records step timings", async () => {
    const db = seededDb();
    const main = scriptedModel([{ toolCall: { name: "web_search", input: { queries: ["Supabase pricing"] } } }, { text: TABLE }]);
    const inner = fixedSearch([PAGE]);
    const slow: Search = {
      run: async (i, t, s) => {
        await new Promise((r) => setTimeout(r, 30));
        return inner.run(i, t, s);
      },
    };
    const tool = { google: { thinkingConfig: { thinkingLevel: "low" as const } } };
    const answer = { google: { thinkingConfig: { thinkingLevel: "high" as const } } };
    const run = await runAgent(
      { db, models: { main, small: objectModel(emptyExtraction), mainThinking: { tool, answer } }, now: () => SEED_NOW, search: slow, maxSteps: 4 },
      { threadId: TID, message: VERIFY, tz: IST },
    );
    const reader = run.stream.getReader();
    while (!(await reader.read()).done);
    await run.done;

    expect(main.doStreamCalls[0]?.providerOptions).toEqual(tool);
    expect(main.doStreamCalls[1]?.providerOptions).toEqual(answer);

    const steps = JSON.parse(getTrace(db, run.assistantMessageId)?.steps_json ?? "[]") as Array<Record<string, unknown>>;
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({ step: 0, mode: "force", thinking: "tool" });
    expect(steps[0]?.queries as number).toBeGreaterThanOrEqual(1); // the tracker may top up the model's queries
    expect(steps[0]?.searchMs as number).toBeGreaterThanOrEqual(25); // the 30 ms search is counted in step 0, not the model
    // every item was searched in step 0, so code closed step 1: a no-tools answer step (D69)
    expect(steps[1]).toMatchObject({ step: 1, mode: "none", thinking: "answer", searchMs: 0, queries: 0 });
    expect(steps[1]?.firstPartMs).not.toBeNull();
  });

  it("with no thinking configured nothing is added to the call", async () => {
    const db = seededDb();
    const main = scriptedModel([{ text: "Hi!" }]);
    const run = await runAgent(
      { db, models: { main, small: objectModel(emptyExtraction) }, now: () => SEED_NOW, search: fixedSearch([]), maxSteps: 4 },
      { threadId: TID, message: "hey", tz: IST },
    );
    const reader = run.stream.getReader();
    while (!(await reader.read()).done);
    await run.done;
    expect(main.doStreamCalls[0]?.providerOptions).toBeUndefined();
  });
});

describe("a model that rejects the thinking setting never breaks a turn (D67)", () => {
  const tool = { google: { thinkingConfig: { thinkingLevel: "low" as const } } };
  const reject = (statusCode = 400, text = "Unable to submit request because thinking_level is not supported by this model.") =>
    new APICallError({ message: text, url: "https://example.test", requestBodyValues: {}, statusCode, responseBody: JSON.stringify({ error: { message: text } }), isRetryable: false });
  const hasThinking = (o: { providerOptions?: Record<string, Record<string, unknown>> }) => !!o.providerOptions?.google?.thinkingConfig;

  /** Rejects any call that carries a thinking setting, like a model without that option; otherwise runs the script. */
  function pickyModel(err: Error) {
    const inner = scriptedModel([{ text: "Hello there!" }]);
    return new MockLanguageModelV4({
      doStream: async (opts) => {
        if (hasThinking(opts as never)) throw err;
        return inner.doStream(opts);
      },
    });
  }

  async function ask(main: MockLanguageModelV4, message = "hey") {
    const db = seededDb();
    const run = await runAgent(
      { db, models: { main, small: objectModel(emptyExtraction), mainThinking: { tool } }, now: () => SEED_NOW, search: fixedSearch([]), maxSteps: 4, retry: { sleep: async () => undefined, rand: () => 0 } },
      { threadId: TID, message, tz: IST },
    );
    const reader = run.stream.getReader();
    while (!(await reader.read()).done);
    await run.done;
    return { db, run, last: db.prepare("SELECT status, text FROM messages WHERE id = ?").get(run.assistantMessageId) as { status: string; text: string } };
  }

  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    resetThinkingRejections();
    warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
    resetThinkingRejections();
  });
  const warnings = () => warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes("rejected the thinking setting"));

  it("retries the call once without thinking and the turn completes", async () => {
    const main = pickyModel(reject());
    const { last, run, db } = await ask(main);
    expect(last).toEqual({ status: "complete", text: "Hello there!" });
    expect(main.doStreamCalls).toHaveLength(2);
    expect(hasThinking(main.doStreamCalls[0] as never)).toBe(true);
    expect(hasThinking(main.doStreamCalls[1] as never)).toBe(false);
    expect(main.doStreamCalls[1]?.providerOptions).toBeUndefined();
    // the step timing shows the setting that was actually used: none
    const steps = JSON.parse(getTrace(db, run.assistantMessageId)?.steps_json ?? "[]") as Array<Record<string, unknown>>;
    expect(steps[0]).not.toHaveProperty("thinking");
    expect(warnings()).toHaveLength(1);
  });

  it("remembers it for the rest of the process: later turns skip the setting, and there is one warning in total", async () => {
    await ask(pickyModel(reject()));
    const second = pickyModel(reject());
    const { last } = await ask(second, "hello again");
    expect(last.status).toBe("complete");
    expect(second.doStreamCalls).toHaveLength(1); // no failed attempt this time
    expect(hasThinking(second.doStreamCalls[0] as never)).toBe(false);
    expect(warnings()).toHaveLength(1);
  });

  it("a 400 that does not mention thinking, or a different status, is not swallowed", async () => {
    const bad400 = pickyModel(reject(400, "API key not valid."));
    expect((await ask(bad400)).last.status).toBe("error");
    expect(bad400.doStreamCalls).toHaveLength(1);
    const server = pickyModel(reject(500, "thinking backend exploded"));
    expect((await ask(server)).last.status).toBe("error");
    expect(warnings()).toHaveLength(0);
  });

  it("isThinkingRejection only matches an HTTP 400 that names thinking", () => {
    expect(isThinkingRejection(reject())).toBe(true);
    expect(isThinkingRejection(reject(400, "Invalid thinkingConfig"))).toBe(true);
    expect(isThinkingRejection(reject(400, "nope"))).toBe(false);
    expect(isThinkingRejection(reject(429, "thinking quota"))).toBe(false);
    expect(isThinkingRejection(new Error("thinking"))).toBe(false);
  });
});
