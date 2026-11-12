import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/lib/env";
// @ts-expect-error plain .mjs with no type declarations
import { fillDummyEnv } from "../scripts/smoke-fresh-clone.mjs";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

describe("fresh-clone smoke script helpers", () => {
  const example = read("../.env.example");
  const filled: string = fillDummyEnv(example);

  it("fills only the two required keys and leaves every other line as shipped", () => {
    const a = example.split("\n");
    const b = filled.split("\n");
    expect(b).toHaveLength(a.length);
    const changed = a.flatMap((line, i) => (line === b[i] ? [] : [b[i]]));
    expect(changed).toEqual(["GOOGLE_GENERATIVE_AI_API_KEY=dummy-google-key", "EXA_API_KEY=dummy-exa-key"]);
  });

  it("the result is a valid environment, so a stranger's server would start", () => {
    const source: Record<string, string> = {};
    for (const line of filled.split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m?.[1]) source[m[1]] = m[2] ?? "";
    }
    expect(loadEnv(source)).toMatchObject({ LLM_PROVIDER: "google", PORT: 8787 });
  });
});

describe(".gitignore (secrets, databases, eval scratch)", () => {
  const ignored = (path: string) => {
    try {
      execFileSync("git", ["check-ignore", "-q", path], { cwd: new URL("..", import.meta.url) });
      return true;
    } catch {
      return false;
    }
  };

  it.each([".env", ".env.local", "data/agent.db", "data/agent.db-wal", "data/anything.db", "eval/.tmp/x.json", "eval/transcripts-flash/A1.md"])(
    "ignores %s",
    (path) => expect(ignored(path)).toBe(true),
  );

  it("does not ignore .env.example", () => expect(ignored(".env.example")).toBe(false));
});

describe("Node floor", () => {
  it("engines, .nvmrc and check-env agree on 22.12", () => {
    expect((JSON.parse(read("../package.json")) as { engines: { node: string } }).engines.node).toBe(">=22.12");
    expect(read("../.nvmrc").trim()).toBe("22.12");
    expect(read("../scripts/check-env.mjs")).toContain("minor < 12");
  });
});
