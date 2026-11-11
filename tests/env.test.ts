import { describe, expect, it } from "vitest";
import { EnvError, loadEnv } from "../src/lib/env";

const valid = { GOOGLE_GENERATIVE_AI_API_KEY: "g-key", EXA_API_KEY: "e-key" };

function problems(source: Record<string, string>): string[] {
  try {
    loadEnv(source);
  } catch (err) {
    if (err instanceof EnvError) return err.problems;
    throw err;
  }
  throw new Error("expected loadEnv to throw");
}

describe("loadEnv", () => {
  it("applies defaults", () => {
    const env = loadEnv(valid);
    expect(env).toMatchObject({
      LLM_PROVIDER: "google",
      PORT: 8787,
      MAX_STEPS: 4,
      DB_PATH: "./data/agent.db",
      MAIN_MODEL: "gemini-flash-lite-latest",
      SMALL_MODEL: "gemini-flash-lite-latest",
      DEV_LLM_CACHE: false,
    });
    expect(env.NOW).toBeUndefined();
  });

  it("treats empty strings as unset (as shipped in .env.example)", () => {
    const env = loadEnv({ ...valid, TAVILY_API_KEY: "", NOW: "", PORT: "", MAX_STEPS: "" });
    expect(env.TAVILY_API_KEY).toBeUndefined();
    expect(env.PORT).toBe(8787);
  });

  it("coerces numbers and the cache flag", () => {
    const env = loadEnv({ ...valid, PORT: "9000", MAX_STEPS: "6", DEV_LLM_CACHE: "1" });
    expect(env).toMatchObject({ PORT: 9000, MAX_STEPS: 6, DEV_LLM_CACHE: true });
  });

  it("requires the key for the chosen provider", () => {
    expect(problems({ EXA_API_KEY: "e" })).toEqual([
      "GOOGLE_GENERATIVE_AI_API_KEY: is required when LLM_PROVIDER=google",
    ]);
  });

  it("requires explicit model ids for non-google providers", () => {
    const p = problems({ LLM_PROVIDER: "openai", OPENAI_API_KEY: "o", EXA_API_KEY: "e" });
    expect(p.map((x) => x.split(":")[0])).toEqual(["MAIN_MODEL", "SMALL_MODEL"]);
    const ok = loadEnv({
      LLM_PROVIDER: "OpenAI",
      OPENAI_API_KEY: "o",
      EXA_API_KEY: "e",
      MAIN_MODEL: "m",
      SMALL_MODEL: "s",
    });
    expect(ok.LLM_PROVIDER).toBe("openai");
  });

  it("requires at least one search key", () => {
    expect(problems({ GOOGLE_GENERATIVE_AI_API_KEY: "g" })[0]).toMatch(/EXA_API_KEY.*TAVILY_API_KEY/);
    expect(loadEnv({ GOOGLE_GENERATIVE_AI_API_KEY: "g", TAVILY_API_KEY: "t" }).TAVILY_API_KEY).toBe("t");
  });

  it("rejects bad values with the variable name", () => {
    expect(problems({ ...valid, PORT: "abc" })[0]).toMatch(/^PORT:/);
    expect(problems({ ...valid, LLM_PROVIDER: "mistral" })[0]).toMatch(/^LLM_PROVIDER:/);
    expect(problems({ ...valid, NOW: "2026-11-12T11:00:00" })[0]).toMatch(/^NOW:.*offset/);
  });

  it("never echoes secret values in error messages", () => {
    const msg = problems({ GOOGLE_GENERATIVE_AI_API_KEY: "super-secret", PORT: "abc" }).join("\n");
    expect(msg).not.toContain("super-secret");
  });
});
