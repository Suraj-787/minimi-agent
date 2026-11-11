import { randomUUID } from "node:crypto";
import {
  consumeStream,
  createUIMessageStream,
  isStepCount,
  streamText,
  toUIMessageStream,
  wrapLanguageModel,
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
import { createTurnCounter, type Search, type SearchOutcome } from "../search/index";
import {
  rawLinks,
  shippedProblems,
  shippedWordingProblems,
  sourceMismatches,
  statusContradictions,
  vendorPageFirstProblems,
  type ResultText,
} from "./answerChecks";
import { buildContext, type BuiltContext } from "./context";
import { friendlyError } from "./errors";
import { detectIntent } from "./intent";
import { createRecheckTracker } from "./recheck";
import { createStepPolicy, toolChoiceEnforcement } from "./stepPolicy";
import { HISTORY_MAX_MESSAGES, selectHistory, toHistoryMessages } from "./history";
import type { Models } from "./model";
import { SYSTEM_PROMPT, buildDynamicBlock, withDynamicBlock } from "./prompts";
import { retryMiddleware, type RetryMiddlewareOptions } from "./retryMiddleware";
import { recallPolicy, type RecallIntent, type RecallPlan } from "./recallPolicy";
import { resolveTimeRefs } from "./time";
import { claimSide, createWebSearchTool, type ToolEmit } from "./tools/webSearch";

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
  /** Sleep and randomness for model retries; tests inject instant ones. */
  retry?: Pick<RetryMiddlewareOptions, "sleep" | "rand">;
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
  // Latency is measured from the moment the request reaches the core: context build is part of it.
  const startedAt = performance.now();
  let firstTokenMs: number | undefined;
  // First transient status ("Searching: …", a retry notice): what the user sees before any text.
  let firstStatusMs: number | undefined;
  let totalMs: number | undefined;
  let usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number; steps?: number } = {};
  let retries = 0;
  // A provider error part mid-stream does not make the SDK's outcome "failed", so it is remembered here.
  // Without it a half answer would be saved as complete and then written into memory (D45).
  let streamError: { error: unknown } | undefined;
  const searchLog: Array<SearchOutcome["sources"][number]> = [];
  const searchFailed: string[] = [];
  let searchAllFailed = 0;
  // This turn's results by [n], so the trace can check each cited source is about its row's item (D55).
  const resultsByN = new Map<number, ResultText>();

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
  const recheckIn = forceSearch ? recheckInput(ctx.built, intent.news) : undefined;
  const recheck = recheckIn ? createRecheckTracker(recheckIn) : undefined;
  const messages: ModelMessage[] = history.map((m, i) => ({
    role: m.role,
    content: i === history.length - 1 ? withDynamicBlock(ctx.built.block, m.text) : m.text,
  }));

  const assistantId = randomUUID();
  // Which steps are forced to search / forbidden to (D63). The SDK itself always runs on `auto`.
  const stepPolicy = createStepPolicy({ maxSteps });

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
        status: (text) => {
          firstStatusMs ??= performance.now() - startedAt;
          writer.write({ type: "data-status", data: { text }, transient: true });
        },
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
      // Retry wraps only the model: a 503 on the answer step repeats that one call, never the searches (D45).
      const retrying = (m: Exclude<typeof models.main, string>) =>
        wrapLanguageModel({
        model: m,
        middleware: retryMiddleware({
          ...deps.retry,
          onRetry: ({ attempt, delayMs, reason }) => {
            retries++;
            firstStatusMs ??= performance.now() - startedAt;
            log.warn("model retry", { threadId, attempt, delayMs, reason });
            writer.write({
              type: "data-status",
              data: {
                text:
                  reason === "rate-limit"
                    ? "Rate-limited by the model provider, retrying…"
                    : "The model provider had an error, retrying…",
              },
              transient: true,
            });
          },
        }),
      });
      // A plain gateway id string cannot be wrapped; env-built models are always objects.
      const model =
        typeof models.main === "string"
          ? models.main
          : wrapLanguageModel({
              model: retrying(models.main),
              middleware: toolChoiceEnforcement({
                policy: stepPolicy,
                toolName: "web_search",
                owed: () => (recheck ? owedWords(recheck.state()) : undefined),
              }),
            });
      const result = streamText({
        model,
        instructions: SYSTEM_PROMPT,
        messages,
        tools: {
          web_search: createWebSearchTool({
            search,
            turn: createTurnCounter(),
            emit,
            onOutcome: (o) => {
              searchLog.push(...o.sources);
              searchFailed.push(...o.failed);
              for (const r of o.results) {
                if (resultsByN.has(r.n)) continue; // keep the label the model saw first
                // The date label the model was shown for this result, against the claim it was searched for.
                const item = recheck?.itemFor(r.query, r.title);
                const label =
                  item && r.publishedDate ? { entity: item.entity, side: claimSide(r.publishedDate, item.said) } : undefined;
                resultsByN.set(r.n, { url: r.url, title: r.title, snippet: r.snippet, ...(label ? { label } : {}) });
              }
              if (o.allFailed) searchAllFailed++;
            },
            ...(recheck ? { recheck } : {}),
          }),
        },
        stopWhen: isStepCount(maxSteps),
        // The policy decides per step (D63): the last step answers in text; in verify mode the first step must
        // search, and so must later ones while an item is unsearched or the news pass is owed, up to a cap and
        // only until a forced step is ignored. The choice itself is applied in toolChoiceEnforcement, not by the SDK.
        prepareStep: ({ stepNumber }) => {
          stepPolicy.plan(stepNumber, !!recheck && (stepNumber === 0 || recheck.needsSearch()));
          return {};
        },
        // The SDK's own retries are silent, so they are off here; retryMiddleware retries with a visible status.
        maxRetries: 0,
        onChunk: ({ chunk }) => {
          if (chunk.type === "text-delta" && firstTokenMs === undefined) firstTokenMs = performance.now() - startedAt;
        },
        onEnd: ({ totalUsage, steps }) => {
          usage = {
            ...(totalUsage.inputTokens !== undefined ? { inputTokens: totalUsage.inputTokens } : {}),
            ...(totalUsage.outputTokens !== undefined ? { outputTokens: totalUsage.outputTokens } : {}),
            ...(totalUsage.totalTokens !== undefined ? { totalTokens: totalUsage.totalTokens } : {}),
            steps: steps.length,
          };
        },
        onError: ({ error }) => {
          streamError ??= { error };
          log.error("model stream error", { threadId, ...errorFields(error) });
        },
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
    onEnd: ({ responseMessage, outcome, isAborted, isCancelled }) => {
      totalMs = performance.now() - startedAt;
      return persistOnce(() => {
        const text = responseMessage.parts
          .flatMap((p) => (p.type === "text" ? [p.text] : []))
          .join("");
        if (outcome.status === "failed" || streamError) {
          const note = `⚠️ ${friendlyError(outcome.status === "failed" ? outcome.error : streamError?.error)}`;
          writeAssistant(text ? `${text}\n\n${note}` : note, "error", null);
        } else if (isAborted || isCancelled || outcome.status === "aborted") {
          writeAssistant(text, "partial", JSON.stringify(responseMessage.parts), responseMessage.parts);
        } else {
          writeAssistant(text, "complete", JSON.stringify(responseMessage.parts), responseMessage.parts);
        }
      });
    },
  });

  // Tracing runs after the reply is saved and never affects it (rule 5).
  const writeTrace = (): void => {
    const errors: unknown[] = ctx.error ? [ctx.error] : [];
    // A takeaway that skips a non-Unchanged row contradicts its own table (D44); recorded, never "fixed" after the fact.
    const table = intent.verify && finished?.status === "complete" ? parseVerifyTable(finished.text) : undefined;
    const gaps = table ? takeawayGaps(table) : [];
    if (gaps.length > 0) errors.push({ verifyTakeawayMissing: gaps });
    // A cited source must name the row's vendor (D55): a competitor's blog cannot back another vendor's price.
    const mismatches = table ? sourceMismatches(table, resultsByN) : [];
    if (mismatches.length > 0) errors.push({ verifySourceMismatch: mismatches });
    // The status must agree with the evidence label the model saw (D59). Soft: recorded, never rewritten.
    const contradictions = table ? statusContradictions(table, resultsByN) : [];
    if (contradictions.length > 0) errors.push({ verifyStatusContradiction: contradictions });
    // Soft checks (D58): style judgements the eval reports as warnings, never as failures.
    const vendorFirst = table ? vendorPageFirstProblems(table, resultsByN) : [];
    if (vendorFirst.length > 0) errors.push({ softVendorPageNotFirst: vendorFirst });
    const wording = finished?.status === "complete" ? shippedWordingProblems(finished.text, resultsByN) : [];
    if (wording.length > 0) errors.push({ softShippedWording: wording });
    // Answers cite [n] only (D50); a raw link means the model ignored the rule. Recorded, never rewritten.
    if (finished?.status === "complete") {
      const links = rawLinks(finished.text);
      if (links.length > 0) errors.push({ rawLinks: links.slice(0, 5) });
      // "Shipped since <date>:" lists only items dated after <date> (D51).
      const expected = recheckIn?.newsSince ?? ctx.built.trace.sinceDate;
      const shipped = shippedProblems(finished.text, expected);
      if (shipped.length > 0) errors.push({ shippedNotAfterSince: shipped });
    }
    // A forced step the model ignored, or a tool call on the last step, never fails the turn (D63); it is recorded here.
    const steps = stepPolicy.state();
    if (steps.violations.length > 0) errors.push({ forcedSearchViolation: steps.violations });
    if (searchFailed.length > 0) errors.push({ searchFailed });
    if (searchAllFailed > 0) errors.push({ searchUnavailable: searchAllFailed });
    // The provider that answered the most queries; "(none)" turns have no search at all.
    const counts = new Map<string, number>();
    for (const q of searchLog) counts.set(q.provider, (counts.get(q.provider) ?? 0) + 1);
    const provider = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    log.info("turn", {
      turnId: assistantId,
      status: finished?.status ?? "unknown",
      verify: intent.verify,
      rules: ctx.built.trace.rules,
      contextMs: Math.round(ctx.ms),
      firstStatusMs: firstStatusMs === undefined ? null : Math.round(firstStatusMs),
      firstTokenMs: firstTokenMs === undefined ? null : Math.round(firstTokenMs),
      totalMs: totalMs === undefined ? null : Math.round(totalMs),
      searches: searchLog.length,
      retries,
      ...(usage.totalTokens !== undefined ? { tokens: usage.totalTokens } : {}),
    });
    try {
      insertTrace(db, {
        turnId: assistantId,
        threadId,
        intent: {
          ...intent,
          forcedSearch: forceSearch,
          ...(recheck
            ? {
                recheck: {
                  ...recheck.state(),
                  // Every claim put up for re-checking, in words, for the drawer.
                  forcedSteps: stepPolicy.state().forcedSteps,
                  claims: ctx.built.recheck.claims.map((c) => ({ entity: c.entity, attribute: c.attribute, said: c.said })),
                },
              }
            : {}),
        },
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
        queries: searchLog,
        provider,
        firstStatusMs: firstStatusMs ?? null,
        firstTokenMs: firstTokenMs ?? null,
        totalMs: totalMs ?? null,
        usage: { ...usage, retries },
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
        results: resultsByN,
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

/** What the tracker still owes, for the note shown to the model when forcing is abandoned. */
function owedWords(state: { uncovered: string[]; newsSince?: string; newsDone: boolean }): string | undefined {
  const parts = [
    state.uncovered.length > 0 ? `these items: ${state.uncovered.join(", ")}` : "",
    state.newsSince && !state.newsDone ? `the dated news search since ${state.newsSince}` : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" and ") : undefined;
}

/**
 * What the tracker must cover. The news pass (only when the user asks what shipped / launched) is dated
 * from the resolved since date, else from the earliest day a listed claim was said.
 */
function recheckInput(
  built: BuiltContext,
  news: boolean,
): Parameters<typeof createRecheckTracker>[0] & { newsSince?: string } {
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
        memoryIds: { turns: [], inThreadTurns: [], claims: [], claimsAtRecall: [] },
        omittedTurns: 0,
        memoryChars: 0,
      },
      recheck: { claims: [], domains: [] },
    };
    return { built: fallback, plan, ms: performance.now() - started, error: "context build failed" };
  }
}
