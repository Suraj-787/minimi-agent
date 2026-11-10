import { describe, expect, it } from "vitest";
import { backoffMs, classify, isDailyQuota, MAX_DELAY_MS, retryDelayHintMs, withRetry } from "../src/lib/retry";
import { friendlyError } from "../src/agent/errors";
import { httpError } from "./helpers/mockModel";

const GEMINI_DAILY = JSON.stringify({
  error: { code: 429, details: [{ violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] }] },
});
const GEMINI_RPM = JSON.stringify({
  error: {
    code: 429,
    details: [
      { violations: [{ quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier" }] },
      { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "34s" },
    ],
  },
});

describe("classify", () => {
  it("retries 429, 408 and 5xx; fails fast on other 4xx and non-HTTP errors", () => {
    expect(classify(httpError(429)).kind).toBe("retry");
    expect(classify(httpError(408)).kind).toBe("retry");
    expect(classify(httpError(503)).kind).toBe("retry");
    expect(classify(httpError(400)).kind).toBe("fatal");
    expect(classify(httpError(401)).kind).toBe("fatal");
    expect(classify(new Error("boom")).kind).toBe("fatal");
  });

  it("treats a per-day 429 as quota (no retry) but a per-minute one as retryable", () => {
    expect(classify(httpError(429, { body: GEMINI_DAILY })).kind).toBe("quota");
    expect(isDailyQuota(httpError(429, { body: GEMINI_DAILY }))).toBe(true);
    expect(classify(httpError(429, { body: GEMINI_RPM })).kind).toBe("retry");
  });
});

describe("delay hints and backoff", () => {
  it("reads Retry-After (seconds), retry-after-ms and Gemini's retryDelay", () => {
    expect(retryDelayHintMs(httpError(429, { headers: { "Retry-After": "7" } }))).toBe(7000);
    expect(retryDelayHintMs(httpError(429, { headers: { "retry-after-ms": "1500" } }))).toBe(1500);
    expect(retryDelayHintMs(httpError(429, { body: '{"retryDelay": "34s"}' }))).toBe(34000);
    expect(retryDelayHintMs(httpError(429))).toBeUndefined();
  });

  it("honours a hint but caps it; without one it is exponential with jitter", () => {
    expect(backoffMs(1, 7000, () => 0)).toBe(7000);
    expect(backoffMs(1, 60_000, () => 0)).toBe(MAX_DELAY_MS);
    expect(backoffMs(1, undefined, () => 0)).toBe(500); // 1000 × 0.5
    expect(backoffMs(1, undefined, () => 1)).toBe(1000);
    expect(backoffMs(3, undefined, () => 1)).toBe(4000);
    expect(backoffMs(9, undefined, () => 1)).toBe(MAX_DELAY_MS);
  });
});

describe("withRetry", () => {
  const instant = { sleep: async () => undefined, rand: () => 1 };

  it("retries a 429 and then succeeds, telling the caller before each wait", async () => {
    let calls = 0;
    const seen: number[] = [];
    const out = await withRetry(
      async () => {
        if (++calls < 3) throw httpError(429);
        return "ok";
      },
      { ...instant, onRetry: (i) => seen.push(i.attempt) },
    );
    expect([out, calls, seen]).toEqual(["ok", 3, [1, 2]]);
  });

  it("waits the provider's hint, not the exponential default", async () => {
    const waits: number[] = [];
    let calls = 0;
    await withRetry(
      async () => {
        if (calls++ === 0) throw httpError(429, { headers: { "retry-after": "3" } });
      },
      { ...instant, sleep: async (ms) => void waits.push(ms) },
    );
    expect(waits).toEqual([3000]);
  });

  it("gives up after max retries and throws the last error", async () => {
    let calls = 0;
    await expect(
      withRetry(async () => (calls++, Promise.reject(httpError(503))), { ...instant, max: 3 }),
    ).rejects.toMatchObject({ statusCode: 503 });
    expect(calls).toBe(4); // first try + 3 retries
  });

  it("does not retry a daily-quota 429 or a 400", async () => {
    for (const err of [httpError(429, { body: GEMINI_DAILY }), httpError(400)]) {
      let calls = 0;
      await expect(withRetry(async () => (calls++, Promise.reject(err)), instant)).rejects.toBe(err);
      expect(calls).toBe(1);
    }
  });
});

describe("friendlyError for quota", () => {
  it("says the daily free quota is used up, without echoing the provider body", () => {
    const text = friendlyError(httpError(429, { body: GEMINI_DAILY }));
    expect(text).toMatch(/daily free quota is used up/);
    expect(text).not.toContain("quotaId");
    expect(friendlyError(httpError(429, { body: GEMINI_RPM }))).toMatch(/rate-limiting/);
  });
});
