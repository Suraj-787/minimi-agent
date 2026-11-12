import { APICallError, RetryError } from "ai";

// Retry policy for the main model (SPEC §9). Pure and clock-free: sleeping and randomness are injected,
// so tests run instantly and the core never touches the real clock.

export const MAX_RETRIES = 3;
/** A provider may ask for a long wait; beyond this the user would rather see the error. */
export const MAX_DELAY_MS = 20_000;
const BASE_DELAY_MS = 1000;

/**
 * The model produced no content within the first-chunk limit (D76): a stall, not an error. The attempt is aborted and
 * retried once (`retryable`); a second stall is final and reaches the user as an error.
 */
export class SlowResponseError extends Error {
  constructor(
    readonly limitMs: number,
    readonly retryable: boolean,
  ) {
    super(`no content from the model within ${limitMs} ms`);
    this.name = "SlowResponseError";
  }
}

export type Verdict =
  | { kind: "retry"; delayMs?: number; reason: "rate-limit" | "server" | "slow" }
  | { kind: "quota" }
  | { kind: "fatal" };

/** Unwraps the SDK's RetryError and `cause` chains down to the provider's HTTP error, if any. */
export function apiErrorOf(err: unknown, depth = 0): APICallError | undefined {
  if (depth > 4) return undefined;
  if (APICallError.isInstance(err)) return err;
  if (RetryError.isInstance(err)) return apiErrorOf(err.lastError, depth + 1);
  if (err instanceof Error && err.cause) return apiErrorOf(err.cause, depth + 1);
  return undefined;
}

// Gemini names the exhausted quota in the 429 body ("GenerateRequestsPerDayPerProjectPerModel-FreeTier").
const DAILY_QUOTA = /per[\s_-]?day|daily/i;

/** A 429 that waiting a few seconds cannot fix. Only the body is inspected, never shown. */
export function isDailyQuota(err: unknown): boolean {
  const e = apiErrorOf(err);
  return e?.statusCode === 429 && typeof e.responseBody === "string" && DAILY_QUOTA.test(e.responseBody);
}

/** Retry-After (seconds), retry-after-ms, or Gemini's `"retryDelay": "34s"`. HTTP-date form is ignored. */
export function retryDelayHintMs(err: unknown): number | undefined {
  const e = apiErrorOf(err);
  if (!e) return undefined;
  const headers = Object.fromEntries(Object.entries(e.responseHeaders ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const ms = Number(headers["retry-after-ms"]);
  if (Number.isFinite(ms) && ms >= 0 && headers["retry-after-ms"] !== undefined) return ms;
  const secs = Number(headers["retry-after"]);
  if (Number.isFinite(secs) && secs >= 0 && headers["retry-after"] !== undefined) return secs * 1000;
  const m = typeof e.responseBody === "string" ? /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(e.responseBody) : null;
  return m?.[1] ? Number(m[1]) * 1000 : undefined;
}

export function classify(err: unknown): Verdict {
  if (err instanceof SlowResponseError) return err.retryable ? { kind: "retry", reason: "slow" } : { kind: "fatal" };
  const e = apiErrorOf(err);
  if (!e) return { kind: "fatal" };
  const status = e.statusCode;
  if (isDailyQuota(err)) return { kind: "quota" };
  const hint = retryDelayHintMs(err);
  const delay = hint === undefined ? {} : { delayMs: hint };
  if (status === 429 || status === 408) return { kind: "retry", reason: "rate-limit", ...delay };
  if (status !== undefined && status >= 500) return { kind: "retry", reason: "server", ...delay };
  // Network failure before any response (reset, DNS): the SDK marks those retryable.
  if (status === undefined && e.isRetryable) return { kind: "retry", reason: "server", ...delay };
  return { kind: "fatal" };
}

/** Provider hint (capped) when present, else exponential with jitter: 0.5–1× of 1 s, 2 s, 4 s… */
export function backoffMs(attempt: number, hintMs: number | undefined, rand: () => number): number {
  if (hintMs !== undefined) return Math.min(hintMs, MAX_DELAY_MS);
  const exp = BASE_DELAY_MS * 2 ** (attempt - 1);
  return Math.min(MAX_DELAY_MS, Math.round(exp * (0.5 + rand() / 2)));
}

export interface RetryOptions {
  max?: number;
  /** Called before each wait; `attempt` is 1 for the first retry. */
  onRetry?: (info: { attempt: number; delayMs: number; reason: "rate-limit" | "server" | "slow" }) => void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  rand?: () => number;
  signal?: AbortSignal;
}

export const realSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });

/** Runs `fn`, retrying only errors `classify` calls retryable. Daily-quota and other errors are thrown at once. */
export async function withRetry<T>(fn: () => Promise<T>, o: RetryOptions = {}): Promise<T> {
  const max = o.max ?? MAX_RETRIES;
  const sleep = o.sleep ?? realSleep;
  const rand = o.rand ?? Math.random;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const verdict = classify(err);
      if (verdict.kind !== "retry" || attempt > max || o.signal?.aborted) throw err;
      const delayMs = backoffMs(attempt, verdict.delayMs, rand);
      o.onRetry?.({ attempt, delayMs, reason: verdict.reason });
      await sleep(delayMs, o.signal);
    }
  }
}
