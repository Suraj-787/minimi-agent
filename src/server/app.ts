import { Hono } from "hono";
import { createUIMessageStreamResponse } from "ai";
import { z } from "zod";
import { runAgent, type AgentDeps } from "../agent/index";
import {
  createThread,
  deleteThread,
  getThread,
  listMessages,
  listThreads,
  type MessageRow,
} from "../db/repo";
import { errorFields, log } from "../lib/log";
import { isValidTimezone } from "../lib/tz";

const chatBody = z.object({
  threadId: z.uuid(),
  message: z.object({ text: z.string().trim().min(1).max(8000) }),
  timezone: z.string().refine(isValidTimezone, "must be an IANA timezone such as Asia/Kolkata"),
});

const newThreadBody = z.object({
  id: z.uuid().optional(),
  title: z.string().trim().max(120).optional(),
});

function badRequest(error: z.ZodError) {
  const issues = error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`);
  return { error: `Invalid request: ${issues.join("; ")}`, issues };
}

// What useChat renders. Rows saved with parts_json keep their parts; plain rows become one text part.
function toUiMessage(row: MessageRow) {
  let parts: unknown = undefined;
  if (row.parts_json) {
    try {
      parts = JSON.parse(row.parts_json);
    } catch {
      // Fall through to the plain-text form; a corrupt parts blob must not hide the message.
    }
  }
  return {
    id: row.id,
    role: row.role,
    parts: Array.isArray(parts) ? parts : [{ type: "text", text: row.text }],
    metadata: { status: row.status, createdAt: row.created_at, localDate: row.local_date },
  };
}

// Built separately from the listener so tests can call app.request() without opening a port.
export function createApp(deps: AgentDeps): Hono {
  const app = new Hono();
  const { db, now } = deps;

  app.get("/api/health", (c) => c.json({ ok: true }));

  app.post("/api/chat", async (c) => {
    const parsed = chatBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json(badRequest(parsed.error), 400);
    const { threadId, message, timezone } = parsed.data;

    try {
      const run = await runAgent(deps, { threadId, message: message.text, tz: timezone });
      // Provider failures are turned into an in-stream error part by the agent; only
      // setup failures (database, bad deps) can reach the catch below.
      return createUIMessageStreamResponse({ stream: run.stream });
    } catch (err) {
      log.error("chat request failed", { threadId, ...errorFields(err) });
      return c.json({ error: "Could not start the chat. Check the server log." }, 500);
    }
  });

  app.get("/api/threads", (c) => c.json({ threads: listThreads(db) }));

  app.post("/api/threads", async (c) => {
    const parsed = newThreadBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json(badRequest(parsed.error), 400);
    if (parsed.data.id && getThread(db, parsed.data.id)) {
      return c.json({ error: "Thread already exists" }, 409);
    }
    const thread = createThread(db, { ...parsed.data, createdAt: now() });
    return c.json({ thread }, 201);
  });

  app.get("/api/threads/:id/messages", (c) => {
    const id = c.req.param("id");
    if (!getThread(db, id)) return c.json({ error: "Thread not found" }, 404);
    return c.json({ messages: listMessages(db, id).map(toUiMessage) });
  });

  app.delete("/api/threads/:id", (c) => {
    return deleteThread(db, c.req.param("id")) ? c.body(null, 204) : c.json({ error: "Thread not found" }, 404);
  });

  return app;
}
