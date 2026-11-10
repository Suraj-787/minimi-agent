import { Hono } from "hono";

// Built separately from the listener so tests can call app.request() without opening a port.
export function createApp(): Hono {
  const app = new Hono();
  app.get("/api/health", (c) => c.json({ ok: true }));
  return app;
}
