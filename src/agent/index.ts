import { randomUUID } from "node:crypto";
import {
  consumeStream,
  createUIMessageStream,
  isStepCount,
  streamText,
  toUIMessageStream,
  type ModelMessage,
  type UIMessageChunk,
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
import { createTurnCounter, type Search } from "../search/index";
import { buildContext, type BuiltContext } from "./context";
import { friendlyError } from "./errors";
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
  models: Pick<Models, "main">;
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
  /** Resolves after the assistant row (and, from Phase 4, background memory work) is written. Never rejects. */
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
  // TODO(phase4): replace with detectIntent(message) from agent/intent.ts.
  const intent: RecallIntent = { verify: false };
  const ctx = contextOrFallback(deps, { message, tz, at, intent, windowSeqs: new Set(window.map((r) => r.seq)) });
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
  const writeAssistant = (text: string, status: MessageStatus, partsJson: string | null): void => {
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
        tools: { web_search: createWebSearchTool({ search, turn: createTurnCounter(), emit }) },
        stopWhen: isStepCount(maxSteps),
        // On the last allowed step the model may not call the tool, so the turn always ends in text.
        prepareStep: ({ stepNumber }) => (stepNumber >= maxSteps - 1 ? { toolChoice: "none" } : {}),
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
          writeAssistant(text, "partial", JSON.stringify(responseMessage.parts));
        } else {
          writeAssistant(text, "complete", JSON.stringify(responseMessage.parts));
        }
      }),
  });

  // Tracing runs after the reply is saved and never affects it (rule 5).
  const writeTrace = (): void => {
    try {
      insertTrace(db, {
        turnId: assistantId,
        threadId,
        intent,
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
        ...(ctx.error ? { errors: [ctx.error] } : {}),
        createdAt: now(),
      });
    } catch (err) {
      log.error("trace write failed", { threadId, ...errorFields(err) });
    }
  };

  // 4. Two readers. The client gets one branch; we drain the other ourselves. If the browser
  //    disconnects mid-answer, the model keeps streaming into our branch and the full reply is saved.
  const [forClient, forServer] = ui.tee();
  const done = consumeStream({ stream: forServer, onError: () => undefined })
    // If the stream ended without onEnd ever running, still leave an assistant row behind.
    .then(() => persistOnce(() => writeAssistant(`⚠️ ${friendlyError(undefined)}`, "error", null)))
    .then(writeTrace)
    .catch((err: unknown) => {
      log.error("agent run failed", { threadId, ...errorFields(err) });
    });

  return { stream: forClient, done, userMessageId: userRow.id, assistantMessageId: assistantId };
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
        memoryIds: { turns: [], claims: [] },
        omittedTurns: 0,
        memoryChars: 0,
      },
    };
    return { built: fallback, plan, ms: performance.now() - started, error: "context build failed" };
  }
}
