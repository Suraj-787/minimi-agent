import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db/index";
import { listMessages } from "../src/db/repo";
import { createApp } from "../src/server/app";
import { failingModel, textModel, objectModel, emptyExtraction } from "./helpers/mockModel";
import { noSearch } from "./helpers/search";

const NOW = new Date("2026-11-12T05:30:00Z");
const ID = "22222222-2222-4222-8222-222222222222";
let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
});
const app = (model = textModel(["hello"])) => createApp({ db, models: { main: model, small: objectModel(emptyExtraction) }, now: () => NOW, search: noSearch, maxSteps: 4, retry: { sleep: async () => undefined, rand: () => 1 } });
const post = (a: ReturnType<typeof app>, body: unknown) =>
  a.request("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const ok = { threadId: ID, message: { text: "hi" }, timezone: "Asia/Kolkata" };

describe("POST /api/chat validation", () => {
  it.each([
    ["non-uuid threadId", { ...ok, threadId: "seed-postgres" }],
    ["missing threadId", { message: ok.message, timezone: ok.timezone }],
    ["bad timezone", { ...ok, timezone: "Mars/Olympus" }],
    ["missing timezone", { threadId: ID, message: ok.message }],
    ["empty message", { ...ok, message: { text: "   " } }],
    ["oversized message", { ...ok, message: { text: "x".repeat(8001) } }],
  ])("400 on %s, and nothing is written", async (_n, body) => {
    const res = await post(app(), body);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Invalid request/);
    expect(db.prepare("SELECT count(*) AS n FROM messages").get()).toEqual({ n: 0 });
  });

  it("400 on a body that is not JSON", async () => {
    const res = await app().request("/api/chat", { method: "POST", body: "nope" });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/chat", () => {
  it("streams the reply as an SSE UI message stream", async () => {
    const a = app();
    const res = await post(a, ok);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(await res.text()).toContain("hello");
  });

  it("sending twice from the same (blank-state) thread id reuses that thread and never creates another", async () => {
    const a = app();
    await (await post(a, ok)).text();
    await (await post(a, { ...ok, message: { text: "second question" } })).text();
    await new Promise((r) => setTimeout(r, 20));
    expect(db.prepare("SELECT count(*) AS n FROM threads").get()).toEqual({ n: 1 });
    expect(listMessages(db, ID).map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    // The thread's history is what a remounted Chat loads: both turns are there.
    const res = await a.request(`/api/threads/${ID}/messages`);
    expect(((await res.json()) as { messages: unknown[] }).messages).toHaveLength(4);
  });

  it("a provider failure is a 200 stream carrying a readable error, not a crash", async () => {
    const res = await post(app(failingModel(429)), ok);
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/rate-limiting/);
    await new Promise((r) => setTimeout(r, 20));
    expect(listMessages(db, ID).map((m) => m.role)).toEqual(["user", "assistant"]);
  });
});

describe("threads API", () => {
  it("create, list, read messages, delete", async () => {
    const a = app();
    const created = await a.request("/api/threads", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: ID, title: "T" }),
    });
    expect(created.status).toBe(201);
    expect((await a.request("/api/threads")).status).toBe(200);
    expect(((await (await a.request("/api/threads")).json()) as { threads: unknown[] }).threads).toHaveLength(1);

    await (await post(a, ok)).text();
    await new Promise((r) => setTimeout(r, 20));
    const msgs = (await (await a.request(`/api/threads/${ID}/messages`)).json()) as {
      messages: { role: string; parts: { type: string; text?: string }[] }[];
    };
    expect(msgs.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(msgs.messages[1]?.parts.find((p) => p.type === "text")?.text).toBe("hello");

    expect((await a.request(`/api/threads/${ID}`, { method: "DELETE" })).status).toBe(204);
    expect((await a.request(`/api/threads/${ID}/messages`)).status).toBe(404);
    expect((await a.request(`/api/threads/${ID}`, { method: "DELETE" })).status).toBe(404);
  });

  it("rejects a non-uuid id and a duplicate id", async () => {
    const a = app();
    const make = (body: unknown) =>
      a.request("/api/threads", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await make({ id: "nope" })).status).toBe(400);
    expect((await make({ id: ID })).status).toBe(201);
    expect((await make({ id: ID })).status).toBe(409);
  });
});
