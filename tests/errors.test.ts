import { APICallError, RetryError } from "ai";
import { describe, expect, it } from "vitest";
import { friendlyError } from "../src/agent/errors";

const api = (statusCode: number, message = "boom") =>
  new APICallError({ message, url: "https://x.test", requestBodyValues: {}, statusCode });

describe("friendlyError", () => {
  it("treats Gemini's 400 'API key not valid' as a key problem", () => {
    expect(friendlyError(api(400, "API key not valid. Please pass a valid API key."))).toMatch(/API key/);
  });
  it("keeps other 400s generic", () => {
    expect(friendlyError(api(400, "bad schema"))).toMatch(/Something went wrong/);
  });
  it("unwraps RetryError to the last provider error", () => {
    const err = new RetryError({ message: "retries", reason: "maxRetriesExceeded", errors: [api(429)] });
    expect(friendlyError(err)).toMatch(/rate-limiting/);
  });
  it("never echoes the provider message", () => {
    expect(friendlyError(api(500, "token=SECRET"))).not.toContain("SECRET");
  });
  it("handles non-Error values", () => {
    expect(friendlyError("x")).toMatch(/Something went wrong/);
  });
});
