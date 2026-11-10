import { config } from "dotenv";
import { serve } from "@hono/node-server";
import { EnvError, env } from "../lib/env";
import { createApp } from "./app";

// quiet: dotenv otherwise prints a promo line on every watch restart.
config({ quiet: true });

try {
  const { PORT } = env();
  serve({ fetch: createApp().fetch, port: PORT }, (info) => {
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
