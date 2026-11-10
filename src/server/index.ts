import { config } from "dotenv";
import { serve } from "@hono/node-server";
import { getModels } from "../agent/model";
import { openDb } from "../db/index";
import { EnvError, env } from "../lib/env";
import { now } from "../lib/clock";
import { errorFields, log } from "../lib/log";
import { createSearchFromEnv } from "../search/index";
import { createApp } from "./app";

// quiet: dotenv otherwise prints a promo line on every watch restart.
config({ quiet: true });

// A stray rejection (e.g. a background write) must never take the server down.
process.on("unhandledRejection", (err) => log.error("unhandled rejection", errorFields(err)));

try {
  const e = env();
  const db = openDb(e.DB_PATH);
  const app = createApp({
    db,
    models: getModels(e),
    now,
    search: createSearchFromEnv(e, db, now),
    maxSteps: e.MAX_STEPS,
  });
  serve({ fetch: app.fetch, port: e.PORT }, (info) => {
    console.log(`server listening on http://localhost:${info.port}`);
  });
} catch (err) {
  // Env problems are user errors: show the list, not a stack trace.
  if (err instanceof EnvError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}
