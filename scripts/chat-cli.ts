import { config } from "dotenv";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { runAgent } from "../src/agent/index";
import { getModels } from "../src/agent/model";
import { openDb } from "../src/db/index";
import { now } from "../src/lib/clock";
import { EnvError, env } from "../src/lib/env";
import { isValidTimezone } from "../src/lib/tz";
import { createSearchFromEnv } from "../src/search/index";

config({ quiet: true });

// Same runAgent as the server: the CLI only adapts the stream to a terminal.
async function main(): Promise<void> {
  const e = env();
  const db = openDb(e.DB_PATH);
  const deps = {
    db,
    models: getModels(e),
    now,
    search: createSearchFromEnv(e, db, now),
    maxSteps: e.MAX_STEPS,
  };

  const flag = process.argv.indexOf("--thread");
  const threadId = (flag > -1 ? process.argv[flag + 1] : undefined) ?? randomUUID();
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const tz = process.env.TZ && isValidTimezone(process.env.TZ) ? process.env.TZ : zone;

  console.log(`thread ${threadId} · ${tz} · Ctrl+C to quit`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const text = (await rl.question("\nyou> ")).trim();
      if (!text) continue;
      const run = await runAgent(deps, { threadId, message: text, tz });
      process.stdout.write("\nagent> ");
      for await (const chunk of run.stream) {
        if (chunk.type === "text-delta") process.stdout.write(chunk.delta);
        else if (chunk.type === "data-status") {
          const text = (chunk.data as { text?: unknown }).text;
          if (typeof text === "string") process.stdout.write(`\n[${text}]\n`);
        } else if (chunk.type === "error") process.stdout.write(`\n⚠️  ${chunk.errorText}`);
      }
      process.stdout.write("\n");
      await run.done;
    }
  } finally {
    rl.close();
  }
}

main().catch((err: unknown) => {
  if (err instanceof EnvError) console.error(err.message);
  else if ((err as { code?: string }).code !== "ABORT_ERR") console.error(err);
  process.exit(1);
});
