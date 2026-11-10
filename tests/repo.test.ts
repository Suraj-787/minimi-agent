import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db/index";
import {
  createThread, deleteThread, getThread, hasAssistantReplyAfter, insertMessage,
  listMessages, listThreads, recentMessages, setThreadTitle,
} from "../src/db/repo";

let db: Db;
const T = new Date("2026-11-03T05:00:00Z");
beforeEach(() => {
  db = openDb(":memory:");
  createThread(db, { id: "t1", createdAt: T });
});
const add = (text: string, role: "user" | "assistant" = "user", at = T, tz = "Asia/Kolkata") =>
  insertMessage(db, { threadId: "t1", role, text, tz, createdAt: at });

describe("messages", () => {
  it("stores UTC created_at and local_date in the user's timezone", () => {
    const m = add("hi", "user", new Date("2026-11-03T18:00:00Z")); // 23:30 IST
    expect(m.created_at).toBe("2026-11-03T18:00:00.000Z");
    expect(m.local_date).toBe("2026-11-03");
    expect(add("later", "user", new Date("2026-11-03T18:31:00Z")).local_date).toBe("2026-11-04");
  });

  it("keeps insertion order even when created_at is identical (frozen NOW)", () => {
    for (const t of ["a", "b", "c"]) add(t);
    expect(listMessages(db, "t1").map((m) => m.text)).toEqual(["a", "b", "c"]);
    expect(recentMessages(db, "t1", 2).map((m) => m.text)).toEqual(["b", "c"]);
  });

  it("defaults status to complete and rejects an unknown role", () => {
    expect(add("x").status).toBe("complete");
    expect(() => db.prepare("UPDATE messages SET role = 'system'").run()).toThrow();
  });

  it("hasAssistantReplyAfter sees only later assistant rows", () => {
    const u = add("q");
    expect(hasAssistantReplyAfter(db, u.id)).toBe(false);
    add("a", "assistant");
    expect(hasAssistantReplyAfter(db, u.id)).toBe(true);
  });
});

describe("threads", () => {
  it("lists newest activity first and bumps updated_at on a new message", () => {
    createThread(db, { id: "t2", createdAt: new Date("2026-11-04T00:00:00Z") });
    expect(listThreads(db).map((t) => t.id)).toEqual(["t2", "t1"]);
    add("hello", "user", new Date("2026-11-05T00:00:00Z"));
    expect(listThreads(db).map((t) => t.id)).toEqual(["t1", "t2"]);
  });

  it("sets a title", () => {
    setThreadTitle(db, "t1", "Postgres");
    expect(getThread(db, "t1")?.title).toBe("Postgres");
  });

  it("delete cascades to messages but keeps claims (ledger is never hard-deleted)", () => {
    add("q");
    db.prepare(
      `INSERT INTO claims (id,key,entity,attribute,value,turn_id,thread_id,observed_at,last_verified_at)
       VALUES ('c1','k','e','a','v','turn','t1','x','x')`,
    ).run();
    expect(deleteThread(db, "t1")).toBe(true);
    expect(listMessages(db, "t1")).toHaveLength(0);
    expect(db.prepare("SELECT count(*) AS n FROM claims").get()).toEqual({ n: 1 });
    expect(deleteThread(db, "t1")).toBe(false);
  });
});
