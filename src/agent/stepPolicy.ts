import type { LanguageModelMiddleware } from "ai";
import { log } from "../lib/log";
import { apiErrorOf } from "../lib/retry";
import { mergeProviderOptions, stepKind, type MainThinking, type StepKind } from "./thinking";

// Tool-choice policy for one turn (D63). The SDK can enforce `toolChoice` itself, but a response that
// ignores it (a forced step answered in text, or a tool call on the last "answer only" step) is thrown as
// AI_ToolChoiceViolationError and kills the whole turn after the searches already ran. So the SDK is always
// left on `auto`, and this layer applies the choice to the provider call and handles a miss itself:
// forcing is a way to get coverage, never a reason to fail the user's turn.

/** Forced search steps per turn: the price pass, the news pass and one top-up. The last step is never one. */
export const MAX_FORCED_STEPS = 3;

export type StepMode = "auto" | "force" | "none";

export interface StepViolation {
  /** 0-based model step. */
  step: number;
  mode: "force" | "none";
  /** force: the forced step got no tool call and was retried once on `auto`. none: a tool call was dropped. */
  action: "retried-auto" | "dropped-tool-call";
  /** What was still owed when forcing was abandoned (force only). */
  owed?: string;
}

export interface StepPolicy {
  /** prepareStep: the mode for this step. `wantForce`: the re-check tracker still needs a search. */
  plan(step: number, wantForce: boolean): StepMode;
  current(): { mode: StepMode; step: number };
  /** True once a forced step was ignored: no further step is forced (it would only fail again). */
  abandoned(): boolean;
  record(v: StepViolation): void;
  state(): { forcedSteps: number; abandoned: boolean; violations: StepViolation[] };
}

export function createStepPolicy(opts: { maxSteps: number; maxForced?: number }): StepPolicy {
  const cap = Math.min(opts.maxForced ?? MAX_FORCED_STEPS, Math.max(0, opts.maxSteps - 1));
  let forced = 0;
  let abandoned = false;
  let cur: { mode: StepMode; step: number } = { mode: "auto", step: 0 };
  const violations: StepViolation[] = [];
  return {
    plan(step, wantForce) {
      let mode: StepMode = "auto";
      // The last allowed step must answer in text, so it can never be forced (nor offered the tool).
      if (step >= opts.maxSteps - 1) mode = "none";
      else if (wantForce && !abandoned && forced < cap) {
        forced++;
        mode = "force";
      }
      cur = { mode, step };
      return mode;
    },
    current: () => cur,
    abandoned: () => abandoned,
    record(v) {
      violations.push(v);
      if (v.mode === "force") abandoned = true;
    },
    state: () => ({ forcedSteps: forced, abandoned, violations: [...violations] }),
  };
}

type StreamResult = Awaited<ReturnType<NonNullable<LanguageModelMiddleware["wrapStream"]>>>;
type Part = StreamResult["stream"] extends ReadableStream<infer P> ? P : never;
type Prompt = Parameters<NonNullable<LanguageModelMiddleware["wrapStream"]>>[0]["params"]["prompt"];

function replay(head: Part[], reader: ReadableStreamDefaultReader<Part>): ReadableStream<Part> {
  let i = 0;
  return new ReadableStream<Part>({
    async pull(controller) {
      if (i < head.length) return controller.enqueue(head[i++] as Part);
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
}

const TOOL_PART = /^tool-(call|input-start|input-delta|input-end)$/;

/** Reads until the model starts a tool call. An error part counts as "decided": it is not ours to judge. */
async function startsToolCall(stream: ReadableStream<Part>): Promise<{ called: boolean; stream: ReadableStream<Part> }> {
  const reader = stream.getReader();
  const head: Part[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { called: false, stream: replay(head, reader) };
    head.push(value);
    if (value.type === "tool-call" || value.type === "tool-input-start" || value.type === "error") {
      return { called: true, stream: replay(head, reader) };
    }
  }
}

/** The last step may not call tools: drop any tool call the provider sends anyway, and never end with no text. */
function withoutToolCalls(stream: ReadableStream<Part>, onDropped: () => void, fallbackText: string): ReadableStream<Part> {
  let dropped = false;
  let sawText = false;
  return stream.pipeThrough(
    new TransformStream<Part, Part>({
      transform(part, controller) {
        if (TOOL_PART.test(part.type)) {
          if (!dropped) onDropped();
          dropped = true;
          return;
        }
        if (part.type === "text-delta") sawText = true;
        if (part.type === "finish") {
          if (dropped && !sawText) {
            controller.enqueue({ type: "text-start", id: "fallback" } as Part);
            controller.enqueue({ type: "text-delta", id: "fallback", delta: fallbackText } as Part);
            controller.enqueue({ type: "text-end", id: "fallback" } as Part);
          }
          const f = part as Part & { finishReason?: { unified?: string } };
          if (dropped && f.finishReason?.unified === "tool-calls") {
            controller.enqueue({ ...part, finishReason: { ...f.finishReason, unified: "stop" } } as Part);
            return;
          }
        }
        controller.enqueue(part);
      },
    }),
  );
}

export const NO_ANSWER_TEXT =
  "I couldn't finish checking this: the search step ran out before I could write an answer. Please ask again.";

// Models that answered HTTP 400 to a thinking setting, for the rest of the process (D67). A model that does
// not accept the knob must never break a turn: the call is repeated without it, and later calls skip it.
const thinkingRejected = new Set<string>();

/** Test hook: forget which models rejected a thinking setting. */
export function resetThinkingRejections(): void {
  thinkingRejected.clear();
}

/** HTTP 400 whose message or body names thinking ("thinking_level is not supported", "thinkingConfig"...). */
export function isThinkingRejection(err: unknown): boolean {
  const e = apiErrorOf(err);
  if (e?.statusCode !== 400) return false;
  return /thinking/i.test(`${e.message} ${typeof e.responseBody === "string" ? e.responseBody : ""}`);
}

export interface CallInfo {
  step: number;
  mode: StepMode;
  /** Which thinking setting this step used (D65), or undefined when none was configured. */
  thinking?: StepKind;
  /** The whole step as the model layer saw it: every attempt, retries and a forced-step fallback included. */
  modelMs: number;
  /** Until the first content part (text or tool call) arrived; null when none did. */
  firstPartMs: number | null;
}

export interface EnforcementOptions {
  policy: StepPolicy;
  toolName: string;
  /** What is still unsearched, in words ("not searched: Neon, Render"), or undefined. */
  owed: () => string | undefined;
  /** Thinking effort per kind of step; merged into the provider options of each call. */
  thinking?: MainThinking;
  /** Called once per step when its stream has ended. Feeds the trace's per-step timing. */
  onCall?: (info: CallInfo) => void;
}

function noteMessage(text: string): Prompt[number] {
  return { role: "user", content: [{ type: "text", text }] };
}

const PREAMBLE_PARTS = new Set(["stream-start", "response-metadata", "raw"]);

/** Passes the stream through and reports its timing once it has fully ended. */
function timed(stream: ReadableStream<Part>, t0: number, done: (modelMs: number, firstPartMs: number | null) => void): ReadableStream<Part> {
  let first: number | null = null;
  return stream.pipeThrough(
    new TransformStream<Part, Part>({
      transform(part, controller) {
        if (first === null && !PREAMBLE_PARTS.has(part.type)) first = performance.now() - t0;
        controller.enqueue(part);
      },
      flush() {
        done(performance.now() - t0, first);
      },
    }),
  );
}

/**
 * Sits ABOVE the retry middleware, so the forced call and its fallback both get 429/5xx retries.
 * Mode "force": call with the tool required; if no tool call comes back, retry once on `auto` with an
 * app note naming what was not searched, so the answer marks it Couldn't verify (SPEC §4.3).
 * It also applies the per-step thinking setting and times each step.
 */
export function toolChoiceEnforcement(o: EnforcementOptions): LanguageModelMiddleware {
  return {
    wrapStream: async ({ params: original, model }) => {
      const t0 = performance.now();
      const { mode, step } = o.policy.current();
      const kind = stepKind(step, mode);
      const modelKey = `${model.provider}:${model.modelId}`;
      const extra = thinkingRejected.has(modelKey) ? undefined : o.thinking?.[kind];
      const params = extra ? { ...original, providerOptions: mergeProviderOptions(original.providerOptions, extra) } : original;
      const report = (stream: ReadableStream<Part>, applied: boolean) =>
        timed(stream, t0, (modelMs, firstPartMs) =>
          o.onCall?.({ step, mode, ...(applied ? { thinking: kind } : {}), modelMs, firstPartMs }),
        );
      let result: StreamResult;
      let applied = !!extra;
      try {
        result = await call(o, model, params, mode, step);
      } catch (err) {
        if (!extra || !isThinkingRejection(err)) throw err;
        // Once per model: remember it, say so once, and repeat this call with no thinking setting at all.
        thinkingRejected.add(modelKey);
        log.warn("model rejected the thinking setting; continuing without it for this process", { model: modelKey, hint: "set MAIN_THINKING=default" });
        applied = false;
        result = await call(o, model, original, mode, step);
      }
      return { ...result, stream: report(result.stream, applied) };
    },
  };
}

async function call(
  o: EnforcementOptions,
  model: { doStream: (p: never) => PromiseLike<StreamResult> },
  params: Parameters<NonNullable<LanguageModelMiddleware["wrapStream"]>>[0]["params"],
  mode: StepMode,
  step: number,
): Promise<StreamResult> {
  const doStream = (p: typeof params) => model.doStream(p as never);
  if (mode === "auto") return doStream(params);

  if (mode === "none") {
    const res = await doStream({ ...params, toolChoice: { type: "none" } });
    return {
      ...res,
      stream: withoutToolCalls(res.stream, () => o.policy.record({ step, mode: "none", action: "dropped-tool-call" }), NO_ANSWER_TEXT),
    };
  }

  const first = await doStream({ ...params, toolChoice: { type: "tool", toolName: o.toolName } });
  const probed = await startsToolCall(first.stream);
  if (probed.called) return { ...first, stream: probed.stream };

  void probed.stream.cancel().catch(() => undefined);
  const owed = o.owed();
  o.policy.record({ step, mode: "force", action: "retried-auto", ...(owed ? { owed } : {}) });
  const note = noteMessage(
    `App note: the forced search step could not run, so ${owed ?? "the remaining items"} were NOT searched. ` +
      `Do not state or guess their current values: give each the status Couldn't verify, and say once that the search could not be completed. ` +
      `Answer from the results you already have.`,
  );
  return doStream({ ...params, toolChoice: { type: "auto" }, prompt: [...params.prompt, note] });
}
