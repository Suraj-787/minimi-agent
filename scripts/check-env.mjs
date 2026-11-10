// Runs before `npm run dev`. Fails fast with a human-readable message instead of a stack trace.
// Plain JS on purpose: it must work before TypeScript tooling is involved.
import { existsSync, readFileSync } from "node:fs";

const problems = [];
const warnings = [];

// AI SDK v7 declares engines node >= 22, so that is our floor (see DECISIONS D8).
const [major] = process.versions.node.split(".").map(Number);
if (major < 22) {
  problems.push(`Node ${process.versions.node} found; Node >= 22 is required (run: nvm use).`);
}

const env = { ...process.env };
if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trimStart().startsWith("#") && env[m[1]] === undefined) {
      env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
} else {
  problems.push("No .env file. Run: cp .env.example .env  and add your keys.");
}

const provider = (env.LLM_PROVIDER || "google").toLowerCase();
const keyFor = {
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};
if (!keyFor[provider]) {
  problems.push(`LLM_PROVIDER="${provider}" is not one of: ${Object.keys(keyFor).join(", ")}.`);
} else if (!env[keyFor[provider]]) {
  problems.push(`${keyFor[provider]} is empty (needed for LLM_PROVIDER=${provider}).`);
}

if (!env.EXA_API_KEY && !env.TAVILY_API_KEY) {
  problems.push("Set EXA_API_KEY and/or TAVILY_API_KEY. Web search needs at least one.");
} else if (!env.EXA_API_KEY || !env.TAVILY_API_KEY) {
  warnings.push("Only one search provider configured; no fallback if it fails.");
}

for (const w of warnings) console.warn(`⚠  ${w}`);
if (problems.length) {
  console.error("\nCan't start yet:\n" + problems.map((p) => `  ✗ ${p}`).join("\n") + "\n");
  process.exit(1);
}
console.log("✓ environment looks good");
