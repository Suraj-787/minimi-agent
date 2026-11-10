import { randomUUID } from "node:crypto";
import {
  consumeStream,
  createUIMessageStream,
  isStepCount,
  streamText,
  toUIMessageStream,
  type ModelMessage,
  type UIMessageChunk,
  type UIMessagePart,
  type UIDataTypes,
  type UITools,
} from "ai";
import type { Db } from "../db/index";
import {
  createThread,
  getThread,
  insertMessage,
  recentMessages,
  setThreadTitle,
  type MessageStatus,
} from "../db/repo";
import { errorFields, log } from "../lib/log";
import { insertTrace } from "../db/memoryRepo";
import { parseVerifyTable, takeawayGaps } from "../memory/verifyTable";
import { writeTurnMemory } from "../memory/write";
import { createTurnCounter, type Search } from "../search/index";
import { buildContext, type BuiltContext } from "./context";
import { friendlyError } from "./errors";
import { detectIntent } from "./intent";
import { createRecheckTracker } from "./recheck";
import { HISTORY_MAX_MESSAGES, selectHistory, toHistoryMessages } from "./history";
import type { Models } from "./model";
import { SYSTEM_PROMPT, buildDynamicBlock, withDynamicBlock } from "./prompts";
import { recallPolicy, type RecallIntent, type RecallPlan } from "./recallPolicy";
import { resolveTimeRefs } from "./time";
import { createWebSearchTool, type ToolEmit } from "./tools/webSearch";

// Everything the core needs is passed in (CLAUDE.md rule 4): the server, the CLI and the evals
// each build their own deps and reuse this function unchanged.
export interface AgentDeps {
  db: Db;
  /** main: the chat. small: the background memory write (SPEC §7.1). */
  models: Models;
  search: Search;
  /** Model steps per turn (env MAX_STEPS). The last one is forced to answer in text. */
  maxSteps: number;
  /** lib/clock.now in production; a fixed function in tests. */
  now: () => Date;
}

export interface AgentInput {
  threadId: string;
  message: string;
  /** IANA name, already validated at the edge. */
  tz: string;
}

export interface AgentRun {
  /** UI message stream for the client. Cancelling it does NOT stop generation or persistence. */
  stream: ReadableStream<UIMessageChunk>;
  /** Resolves after the assistant row, the trace and the background memory write are done. Never rejects. */
  done: Promise<void>;
  userMessageId: string;
  assistantMessageId: string;
}

const TITLE_MAX = 60;

// Title is derived in code, not by a model call: nothing slow before the first token (rule 5).
function titleFrom(message: string): string {
  const flat = message.replace(/\s+/g, " ").trim();
  return flat.length <= TITLE_MAX ? flat : `${flat.slice(0, TITLE_MAX - 1).trimEnd()}…`;
}

export async function runAgent(deps: AgentDeps, input: AgentInput): Promise<AgentRun> {
  const { db, models, now, search, maxSteps } = deps;
  const { threadId, message, tz } = input;

  // 1. Persist the user message first, so it survives whatever happens to the model call.
  const thread = getThread(db, threadId);
  if (!thread) createThread(db, { id: threadId, title: titleFrom(message), createdAt: now() });
  else if (!thread.title) setThreadTitle(db, threadId, titleFrom(message));
  const userRow = insertMessage(db, {
    threadId,
    role: "user",
    text: message,
    tz,
    createdAt: now(),
  });

  // 2. R0: bounded tail of this thread. 3. Times → recall plan → context (SQLite + code only, SPEC §3).
  //    The dynamic block goes in front of the latest user message only, and is never stored.
  const window = selectHistory(recentMessages(db, threadId, HISTORY_MAX_MESSAGES + 4));
  const history = toHistoryMessages(window);
  const at = now();
  const intent = detectIntent(message);
  const ctx = contextOrFallback(deps, {
    message,
    tz,
    at,
    intent: { verify: intent.verify },
    windowSeqs: new Set(window.map((r) => r.seq)),
  });
  // Verify mode with claims on record must not depend on the model choosing to search (D31), and every
  // listed item must be searched, plus a dated news pass when the user asks what shipped (D37).
  const forceSearch = intent.verify && ctx.built.recheck.claims.length > 0;
  const recheck = forceSearch ? createRecheckTracker(recheckInput(ctx.built, intent.news)) : undefined;
  const messages: ModelMessage[] = history.map((m, i) => ({
    role: m.role,
    content: i === history.length - 1 ? withDynamicBlock(ctx.built.block, m.text) : m.text,
  }));

  const assistantId = randomUUID();

  // 3. Persist exactly once, from whichever path gets there first (normal end, error, or the
  //    safety net below). Memoised so the user message can never end up without an assistant row.
  let persisted: Promise<void> | undefined;
  const persistOnce = (write: () => void): Promise<void> => {
    persisted ??= Promise.resolve().then(write).catch((err: unknown) => {
      log.error("assistant persist failed", { threadId, ...errorFields(err) });
    });
    return persisted;
  };
  // What the memory write needs once the reply is saved: only complete answers are remembered.
  let finished: { text: string; status: MessageStatus; parts: readonly Part[] } | undefined;
  const writeAssistant = (text: string, status: MessageStatus, partsJson: string | null, parts: readonly Part[] = []): void => {
    finished = { text, status, parts };
    insertMessage(db, {
      id: assistantId,
      threadId,
      role: "assistant",
      text,
      partsJson,
      status,
      tz,
      createdAt: now(),
    });
  };

  const onError = (error: unknown): string => friendlyError(error);

  // The tool needs the stream writer to emit transient status and source parts, and execute()
  // doesn't receive one, so the tool is built per turn inside createUIMessageStream (D17).
  const ui = createUIMessageStream({
    generateId: () => assistantId,
    onError,
    execute: ({ writer }) => {
      const emit: ToolEmit = {
        status: (text) => writer.write({ type: "data-status", data: { text }, transient: true }),
        source: ({ n, url, title, publishedDate }) =>
          writer.write({
            type: "source-url",
            sourceId: `src-${n}`,
            url,
            title,
            // Persisted with the message, so [n] and the date survive a refresh.
            providerMetadata: { search: { n, ...(publishedDate ? { publishedDate } : {}) } },
          }),
      };
      const result = streamText({
        model: models.main,
        instructions: SYSTEM_PROMPT,
        messages,
        tools: {
          web_search: createWebSearchTool({ search, turn: createTurnCounter(), emit, ...(recheck ? { recheck } : {}) }),
        },
        stopWhen: isStepCount(maxSteps),
        // On the last allowed step the model may not call the tool, so the turn always ends in text.
        // In verify mode the first step must search, and so must every later one while an item is still
        // unsearched or the news pass is owed; then back to auto.
        prepareStep: ({ stepNumber }) => {
          if (stepNumber >= maxSteps - 1) return { toolChoice: "none" };
          if (recheck && (stepNumber === 0 || recheck.needsSearch())) {
            return { toolChoice: { type: "tool", toolName: "web_search" } };
          }
          return {};
        },
        // Retries with a user-visible status arrive in Phase 5 (lib/retry.ts); no hidden SDK retries until then.
        maxRetries: 0,
        onError: ({ error }) => log.error("model stream error", { threadId, ...errorFields(error) }),
      });
      writer.merge(
        toUIMessageStream({
          stream: result.stream,
          generateMessageId: () => assistantId,
          onError,
          // The outer stream can't see a model failure on its own (it only merges chunks), so the
          // inner stream's verdict is forwarded; otherwise an error turn would be saved as complete.
          onEnd: ({ outcome }) => writer.setOutcome(outcome),
        }),
      );
    },
    onEnd: ({ responseMessage, outcome, isAborted, isCancelled }) =>
      persistOnce(() => {
        const text = responseMessage.parts
          .flatMap((p) => (p.type === "text" ? [p.text] : []))
          .join("");
        if (outcome.status === "failed") {
          const note = `⚠️ ${friendlyError(outcome.error)}`;
          writeAssistant(text ? `${text}\n\n${note}` : note, "error", null);
        } else if (isAborted || isCancelled || outcome.status === "aborted") {
          writeAssistant(text, "partial", JSON.stringify(responseMessage.parts), responseMessage.parts);
        } else {
          writeAssistant(text, "complete", JSON.stringify(responseMessage.parts), responseMessage.parts);
        }
      }),
  });

  // Tracing runs after the reply is saved and never affects it (rule 5).
  const writeTrace = (): void => {
    const errors: unknown[] = ctx.error ? [ctx.error] : [];
    // A takeaway that skips a non-Unchanged row contradicts its own table (D44); recorded, never "fixed" after the fact.
    const table = intent.verify && finished?.status === "complete" ? parseVerifyTable(finished.text) : undefined;
    const gaps = table ? takeawayGaps(table) : [];
    if (gaps.length > 0) errors.push({ verifyTakeawayMissing: gaps });
    try {
      insertTrace(db, {
        turnId: assistantId,
        threadId,
        intent: { ...intent, forcedSearch: forceSearch, ...(recheck ? { recheck: recheck.state() } : {}) },
        resolvedDates: {
          refs: ctx.built.trace.refs,
          resolved: ctx.built.trace.resolvedDates,
          ambiguous: ctx.built.trace.ambiguous,
          ...(ctx.built.trace.sinceDate ? { sinceDate: ctx.built.trace.sinceDate } : {}),
        },
        recallRules: ctx.built.trace.rules,
        memoryIds: { ...ctx.built.trace.memoryIds, omittedTurns: ctx.built.trace.omittedTurns },
        memoryChars: ctx.built.trace.memoryChars,
        contextMs: ctx.ms,
        ...(errors.length > 0 ? { errors } : {}),
        createdAt: now(),
      });
    } catch (err) {
      log.error("trace write failed", { threadId, ...errorFields(err) });
    }
  };

  // 4. Two readers. The client gets one branch; we drain the other ourselves. If the browser
  //    disconnects mid-answer, the model keeps streaming into our branch and the full reply is saved.
  // Background memory (rule 5): after the reply and trace are saved; writeTurnMemory never throws.
  const writeMemory = async (): Promise<void> => {
    if (finished?.status !== "complete" || !finished.text.trim()) return;
    await writeTurnMemory(
      { db, model: models.small, now },
      {
        turnId: assistantId,
        threadId,
        tz,
        localDate: userRow.local_date,
        userText: message,
        answerText: finished.text,
        sources: sourcesOf(finished.parts),
        knownClaims: ctx.built.recheck.claims,
        verify: intent.verify,
      },
    );
  };

  const [forClient, forServer] = ui.tee();
  const done = consumeStream({ stream: forServer, onError: () => undefined })
    // If the stream ended without onEnd ever running, still leave an assistant row behind.
    .then(() => persistOnce(() => writeAssistant(`⚠️ ${friendlyError(undefined)}`, "error", null)))
    .then(writeTrace)
    .then(writeMemory)
    .catch((err: unknown) => {
      log.error("agent run failed", { threadId, ...errorFields(err) });
    });

  return { stream: forClient, done, userMessageId: userRow.id, assistantMessageId: assistantId };
}

type Part = UIMessagePart<UIDataTypes, UITools>;

/**
 * What the tracker must cover. The news pass (only when the user asks what shipped / launched) is dated
 * from the resolved since date, else from the earliest day a listed claim was said.
 */
function recheckInput(built: BuiltContext, news: boolean): Parameters<typeof createRecheckTracker>[0] {
  const items = built.recheck.claims.map((c) => ({ entity: c.entity, attribute: c.attribute, said: c.said }));
  if (!news) return { items };
  const earliest = built.recheck.claims.map((c) => c.said).sort()[0];
  const newsSince = built.trace.sinceDate ?? earliest;
  return newsSince ? { items, newsSince } : { items };
}

/** This turn's sources with their [n], from the source-url parts the tool emitted (D20). */
export function sourcesOf(parts: readonly Part[]): { n: number; url: string }[] {
  const out: { n: number; url: string }[] = [];
  for (const p of parts) {
    if (p.type !== "source-url") continue;
    const n = p.providerMetadata?.["search"]?.["n"];
    if (typeof n === "number") out.push({ n, url: p.url });
  }
  return out;
}

interface ContextResult {
  built: BuiltContext;
  plan: RecallPlan;
  ms: number;
  error?: string;
}

/**
 * Memory is an enhancement: if recall fails (a corrupt row, an FTS hiccup) the turn still runs with
 * the time anchor and this thread's history, and the failure goes into the trace.
 */
function contextOrFallback(
  deps: AgentDeps,
  input: { message: string; tz: string; at: Date; intent: RecallIntent; windowSeqs: ReadonlySet<number> },
): ContextResult {
  const started = performance.now();
  const times = resolveTimeRefs(input.message, input.at, input.tz);
  const plan = recallPolicy({ message: input.message, intent: input.intent, times });
  try {
    const built = buildContext(deps.db, {
      message: input.message,
      now: input.at,
      tz: input.tz,
      plan,
      windowSeqs: input.windowSeqs,
    });
    return { built, plan, ms: performance.now() - started };
  } catch (err) {
    log.error("context build failed", errorFields(err));
    const fallback: BuiltContext = {
      block: buildDynamicBlock({ now: input.at, tz: input.tz }),
      trace: {
        rules: ["R0"],
        refs: times,
        resolvedDates: [],
        ambiguous: [],
        memoryIds: { turns: [], inThreadTurns: [], claims: [] },
        omittedTurns: 0,
        memoryChars: 0,
      },
      recheck: { claims: [], domains: [] },
    };
    return { built: fallback, plan, ms: performance.now() - started, error: "context build failed" };
  }
}
