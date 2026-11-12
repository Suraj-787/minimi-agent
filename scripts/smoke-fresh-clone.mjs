// Fresh-clone smoke test: what a stranger does, in a throwaway folder, with dummy keys.
//   node scripts/smoke-fresh-clone.mjs               clone HEAD of this repo (only what is committed)
//   node scripts/smoke-fresh-clone.mjs --worktree    copy the working tree instead (tracked + untracked, minus ignored),
//                                                    to check changes before committing
//   --keep                                           keep the temp folder
// It never calls an LLM or a search provider: the dummy keys are never used, because only /api/health,
// /api/threads and a malformed /api/chat body (rejected by zod before any model call) are requested.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DUMMY = { GOOGLE_GENERATIVE_AI_API_KEY: "dummy-google-key", EXA_API_KEY: "dummy-exa-key" };

/** .env.example with only the two required keys filled in; every other line is left as shipped. */
export function fillDummyEnv(example, keys = DUMMY) {
  return example
    .split(/\r?\n/)
    .map((line) => {
      const m = line.match(/^([A-Z0-9_]+)=$/);
      return m && keys[m[1]] ? `${m[1]}=${keys[m[1]]}` : line;
    })
    .join("\n");
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function freePort() {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
}

const results = [];
async function step(name, fn) {
  const t = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - t, detail });
    console.log(`  ✓ ${name} (${((Date.now() - t) / 1000).toFixed(1)}s)${detail ? ` ${detail}` : ""}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name, ok: false, ms: Date.now() - t, detail: msg });
    console.log(`  ✗ ${name}: ${msg}`);
    throw err;
  }
}

function run(cmd, args, cwd, env = {}) {
  execFileSync(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
}

async function waitFor(url, check, ms = 40_000) {
  const end = Date.now() + ms;
  let last = "no response";
  while (Date.now() < end) {
    try {
      const res = await fetch(url);
      const body = await res.text();
      if (check(res, body)) return body;
      last = `HTTP ${res.status}: ${body.slice(0, 120)}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`${url} did not answer correctly within ${ms / 1000}s (${last})`);
}

function start(cwd, args, env, log) {
  // Own process group, so the whole tree (npm → tsx / vite) can be stopped.
  const child = spawn("npm", args, { cwd, env: { ...process.env, ...env }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  for (const s of [child.stdout, child.stderr]) s.on("data", (d) => log.push(String(d)));
  return child;
}

function stop(child) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    /* already gone */
  }
}

async function main() {
  const worktree = process.argv.includes("--worktree");
  const keep = process.argv.includes("--keep");
  const dir = mkdtempSync(join(tmpdir(), "minimi-smoke-"));
  const repo = join(dir, "clone");
  const children = [];
  const logs = [];
  let failed = false;
  console.log(`Fresh-clone smoke test in ${dir} (${worktree ? "working tree" : "git clone of HEAD"})`);

  try {
    await step(worktree ? "copy working tree" : "git clone", () => {
      if (!worktree) return run("git", ["clone", "--quiet", root, repo], root);
      const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root })
        .toString()
        .split("\0")
        .filter((f) => f && existsSync(join(root, f)));
      for (const f of files) {
        mkdirSync(dirname(join(repo, f)), { recursive: true });
        cpSync(join(root, f), join(repo, f));
      }
      return `${files.length} files`;
    });
    await step("no .env, no data/ in the clone", () => {
      for (const p of [".env", "data", "node_modules"]) if (existsSync(join(repo, p))) throw new Error(`${p} is in the clone`);
    });
    await step(".env from .env.example with dummy keys", () => {
      writeFileSync(join(repo, ".env"), fillDummyEnv(readFileSync(join(repo, ".env.example"), "utf8")));
    });
    await step("npm install", () => run("npm", ["install", "--no-audit", "--no-fund"], repo));
    await step("environment check (predev)", () => run("node", ["scripts/check-env.mjs"], repo));
    await step("build (typecheck + web bundle)", () => run("npm", ["run", "build"], repo));

    const apiPort = await freePort();
    const webPort = await freePort();
    const api = `http://127.0.0.1:${apiPort}`;
    const web = `http://127.0.0.1:${webPort}`;
    // PORT in the process env beats .env (dotenv does not override), and vite.config.ts reads the same PORT for its proxy.
    const env = { PORT: String(apiPort) };
    children.push(start(repo, ["run", "dev:server"], env, logs));
    children.push(start(repo, ["run", "dev:web", "--", "--port", String(webPort), "--strictPort", "--host", "127.0.0.1"], env, logs));

    await step("server: GET /api/health", async () => {
      await waitFor(`${api}/api/health`, (r, b) => r.ok && JSON.parse(b).ok === true);
    });
    await step("server: GET /api/threads creates the database", async () => {
      const body = await waitFor(`${api}/api/threads`, (r) => r.ok);
      if (!Array.isArray(JSON.parse(body).threads)) throw new Error("no threads array");
      if (!existsSync(join(repo, "data", "agent.db"))) throw new Error("data/agent.db was not created");
    });
    await step("server: bad /api/chat body is a 400 (no model call)", async () => {
      const res = await fetch(`${api}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      if (res.status !== 400) throw new Error(`expected 400, got ${res.status}`);
    });
    await step("web: GET / serves the app", async () => {
      await waitFor(`${web}/`, (r, b) => r.ok && b.includes('id="root"'));
    });
    await step("web: /api is proxied to the server", async () => {
      await waitFor(`${web}/api/health`, (r, b) => r.ok && JSON.parse(b).ok === true);
    });
  } catch {
    failed = true;
    if (logs.length) console.log(`\nLast output from the dev processes:\n${logs.join("").split("\n").slice(-25).join("\n")}`);
  } finally {
    for (const c of children) stop(c);
    await new Promise((r) => setTimeout(r, 500));
    if (keep) console.log(`\nKept ${dir}`);
    else rmSync(dir, { recursive: true, force: true });
  }

  const ok = results.filter((r) => r.ok).length;
  console.log(`\n${failed ? "FAIL" : "PASS"}: ${ok}/${results.length} steps ok, ${(results.reduce((t, r) => t + r.ms, 0) / 1000).toFixed(0)}s. No LLM or search calls were made.`);
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
