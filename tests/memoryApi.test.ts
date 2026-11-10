import { describe, expect, it } from "vitest";
import { runAgent } from "../src/agent/index";
import { forgetClaimChain, insertClaim, markSuperseded, type ClaimRow } from "../src/db/memoryRepo";
import { createApp } from "../src/server/app";
import { labelWrite } from "../src/server/memoryRoutes";
import { emptyExtraction, objectModel, textModel } from "./helpers/mockModel";
import { noSearch } from "./helpers/search";
import { IST, SEED_NOW, addTurn, seededDb } from "./helpers/seed";

const mkApp = (db = seededDb(), main = textModel(["ok"])) => {
  const deps = { db, models: { main, small: objectModel(emptyExtraction) }, now: () => SEED_NOW, search: noSearch, maxSteps: 4 };
  return { db, deps, app: createApp(deps) };
};
const claim = (db: ReturnType<typeof seededDb>, entity: string) =>
  db.prepare("SELECT * FROM claims WHERE entity = ? ORDER BY observed_at, rowid").all(entity) as ClaimRow[];
const ask = async (deps: ReturnType<typeof mkApp>["deps"], message: string) => {
  const run = await runAgent(deps, { threadId: crypto.randomUUID(), message, tz: IST });
  await run.done;
  return run;
};
const lastPrompt = (m: ReturnType<typeof textModel>) => JSON.stringify(m.doStreamCalls.at(-1)?.prompt);

describe("GET /api/memory", () => {
  it("groups current claims by the day they were said, newest day first, with the chat title", async () => {
    const { app } = mkApp();
    const body = (await (await app.request("/api/memory")).json()) as { days: { date: string; claims: { entity: string; threadTitle: string }[] }[] };
    const dates = body.days.map((d) => d.date);
    expect(dates).toEqual([...dates].sort().reverse());
    const neon = body.days.flatMap((d) => d.claims).find((c) => c.entity === "Neon");
    expect(neon?.threadTitle).toBe("Managed Postgres hosting");
  });

  it("shows the old → new chain on the current claim; status=all also lists the superseded row", async () => {
    const { db, app } = mkApp();
    const [old] = claim(db, "Neon");
    const fresh = insertClaim(db, { entity: "Neon", attribute: "cheapest paid plan price", value: "Launch plan, $24/month", turnId: old!.turn_id, threadId: old!.thread_id, observedAt: SEED_NOW });
    markSuperseded(db, old!.id, fresh.id, SEED_NOW);
    const current = (await (await app.request("/api/memory")).json()) as { days: { claims: { id: string; previously: { value: string }[] }[] }[] };
    const cur = current.days.flatMap((d) => d.claims).find((c) => c.id === fresh.id);
    expect(cur?.previously.map((p) => p.value)).toEqual(["Launch plan, $19/month"]);
    expect(current.days.flatMap((d) => d.claims).some((c) => c.id === old!.id)).toBe(false);
    const all = (await (await app.request("/api/memory?status=all")).json()) as typeof current;
    expect(all.days.flatMap((d) => d.claims).some((c) => c.id === old!.id)).toBe(true);
  });
});

describe("forgetting a claim", () => {
  it("forgets the whole key chain, so a superseded predecessor never reappears, and logs each row", async () => {
    const { db, app } = mkApp();
    const [old] = claim(db, "Neon");
    const fresh = insertClaim(db, { entity: "Neon", attribute: "cheapest paid plan price", value: "Launch plan, $24/month", turnId: old!.turn_id, threadId: old!.thread_id, observedAt: SEED_NOW });
    markSuperseded(db, old!.id, fresh.id, SEED_NOW);
    const res = await app.request(`/api/memory/claims/${fresh.id}`, { method: "DELETE" });
    expect(await res.json()).toEqual({ forgotten: 2 });
    expect(claim(db, "Neon").map((c) => c.status)).toEqual(["forgotten", "forgotten"]);
    // Nothing is deleted: values stay in the rows.
    expect(claim(db, "Neon").map((c) => c.value)).toContain("Launch plan, $19/month");
    const logged = db.prepare("SELECT op, claim_id FROM memory_writes WHERE op = 'forget'").all() as { claim_id: string }[];
    expect(logged.map((l) => l.claim_id).sort()).toEqual([old!.id, fresh.id].sort());
    expect((await (await app.request(`/api/memory/claims/${fresh.id}`, { method: "DELETE" })).status)).toBe(404);
  });

  it("a forgotten claim is not in the next turn's recall (the Neon price is gone from the prompt)", async () => {
    const { db, deps, app } = mkApp();
    const main = deps.models.main as ReturnType<typeof textModel>;
    // The seeded Postgres turn is 9 days before SEED_NOW = 3 Nov.
    await ask(deps, "What did I ask you on 3 November?");
    expect(lastPrompt(main)).toContain("$19/month");
    const neon = claim(db, "Neon")[0]!;
    await app.request(`/api/memory/claims/${neon.id}`, { method: "DELETE" });
    await ask(deps, "What did I ask you on 3 November?");
    expect(lastPrompt(main)).not.toContain("$19/month");
    expect(lastPrompt(main)).toContain("Supabase"); // other claims of that day are untouched
  });

  it("forgetting is local to the key: a later sourced answer adds a fresh claim", () => {
    const { db } = mkApp();
    const neon = claim(db, "Neon")[0]!;
    forgetClaimChain(db, neon.id, SEED_NOW);
    insertClaim(db, { entity: "Neon", attribute: "cheapest paid plan price", value: "Launch plan, $19/month", turnId: neon.turn_id, threadId: neon.thread_id, observedAt: SEED_NOW });
    expect(claim(db, "Neon").map((c) => c.status)).toEqual(["forgotten", "current"]);
  });
});

describe("forgetting a chat", () => {
  it("forgets that chat's claims and summaries and hides its turns from other chats' recall", async () => {
    const { db, deps, app } = mkApp();
    const main = deps.models.main as ReturnType<typeof textModel>;
    const threadId = (db.prepare("SELECT id FROM threads WHERE title = ?").get("Managed Postgres hosting") as { id: string }).id;
    await ask(deps, "What did I ask you on 3 November?");
    expect(lastPrompt(main)).toContain("Neon");
    const res = await app.request(`/api/memory/threads/${threadId}`, { method: "DELETE" });
    const out = (await res.json()) as { claims: number; summaries: number };
    expect(out.claims).toBeGreaterThan(0);
    expect(out.summaries).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM claims WHERE thread_id = ? AND status != 'forgotten'").get(threadId)).toEqual({ n: 0 });
    // Messages are kept (the chat itself is not deleted) but are no longer recalled elsewhere.
    expect(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?").get(threadId)).not.toEqual({ n: 0 });
    await ask(deps, "What did I ask you on 3 November?");
    expect(lastPrompt(main)).not.toContain("Neon");
    expect((await app.request("/api/memory/threads/00000000-0000-4000-8000-000000000000", { method: "DELETE" })).status).toBe(404);
  });

  it("turns asked after the forget are recalled normally", async () => {
    const { db, deps, app } = mkApp();
    const main = deps.models.main as ReturnType<typeof textModel>;
    const threadId = (db.prepare("SELECT id FROM threads WHERE title = ?").get("Managed Postgres hosting") as { id: string }).id;
    await app.request(`/api/memory/threads/${threadId}`, { method: "DELETE" });
    addTurn(db, { threadId, user: "Which Postgres host has a free tier?", answer: "Neon has a free tier.", at: new Date("2026-11-11T05:30:00Z") });
    await ask(deps, "What did I ask you on 11 November?");
    expect(lastPrompt(main)).toContain("free tier");
  });
});

describe("GET /api/debug/:turnId", () => {
  it("returns the whole trace: rules, dates, recalled memory in words, timings, and this turn's writes", async () => {
    const { deps, app } = mkApp();
    const run = await ask(deps, "What did I ask you on 3 November?");
    const res = await app.request(`/api/debug/${run.assistantMessageId}`);
    expect(res.status).toBe(200);
    const d = (await res.json()) as Record<string, any>;
    expect(d.recallRules).toContain("R1");
    expect(d.resolvedDates.resolved).toContain("2026-11-03");
    expect(d.intent).toMatchObject({ verify: false });
    expect(d.memory.turns[0]).toMatchObject({ date: "2026-11-03" });
    expect(d.memory.claims.some((c: { entity: string }) => c.entity === "Neon")).toBe(true);
    expect(d.timings.contextMs).toBeGreaterThanOrEqual(0);
    expect(d.timings.firstTokenMs).toBeGreaterThanOrEqual(0);
    expect(d.timings.totalMs).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(d.memoryWrites)).toBe(true);
  });

  it("404 for an unknown turn", async () => {
    expect((await mkApp().app.request("/api/debug/nope")).status).toBe(404);
  });

  it("never returns env values or keys", async () => {
    const saved = { ...process.env };
    process.env.EXA_API_KEY = "exa-SECRET-VALUE-123";
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "google-SECRET-VALUE-456";
    process.env.TAVILY_API_KEY = "tvly-SECRET-VALUE-789";
    try {
      const { deps, app } = mkApp();
      const run = await ask(deps, "hi");
      const text = await (await app.request(`/api/debug/${run.assistantMessageId}`)).text();
      expect(text).not.toMatch(/SECRET-VALUE/);
      expect(text).not.toMatch(/api[_-]?key/i);
    } finally {
      process.env = saved;
    }
  });
});

describe("drawer data (Phase 5 browser test)", () => {
  it("lists every re-checked item, and the status each recalled claim had AT RECALL even if it changed later", async () => {
    const { db, deps, app } = mkApp();
    const run = await ask(deps, "On Monday we shortlisted 5 CRM tools. Has any of them changed pricing since?");
    // After the turn, forget a claim: the drawer must still show it as it was at recall.
    const hub = claim(db, "HubSpot Sales Hub")[0]!;
    forgetClaimChain(db, hub.id, SEED_NOW);
    const d = (await (await app.request(`/api/debug/${run.assistantMessageId}`)).json()) as Record<string, any>;
    expect(d.intent.recheck.claims.map((c: { entity: string }) => c.entity)).toContain("HubSpot Sales Hub");
    expect(d.intent.recheck.claims[0]).toHaveProperty("said");
    const atRecall = d.memory.claims.find((c: { entity: string }) => c.entity === "HubSpot Sales Hub");
    expect(atRecall.status).toBe("current");
    expect(atRecall.value).toBe("$90");
  });

  it("every memory_writes row carries its key and value (add, touch, supersede, rejected, forget)", async () => {
    const { db, app } = mkApp();
    const neon = claim(db, "Neon")[0]!;
    const turn = neon.turn_id;
    const fresh = insertClaim(db, { entity: "Neon", attribute: "cheapest paid plan price", value: "Launch plan, $24/month", turnId: turn, threadId: neon.thread_id, observedAt: SEED_NOW });
    markSuperseded(db, neon.id, fresh.id, SEED_NOW);
    const w = (op: string, claimId: string | null, detail: unknown) =>
      db.prepare("INSERT INTO memory_writes (id, turn_id, op, claim_id, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(crypto.randomUUID(), turn, op, claimId, JSON.stringify(detail), SEED_NOW.toISOString());
    w("add", fresh.id, {}); // no key/value in the detail: resolved from the claim row
    w("supersede", fresh.id, { key: fresh.key, value: fresh.value, previousIds: [neon.id] });
    w("rejected", null, { field: "claim", reason: "table says Unchanged", text: "Neon | cheapest paid plan price | Launch plan, $19/month" });
    forgetClaimChain(db, fresh.id, SEED_NOW);
    db.prepare("INSERT INTO traces (turn_id, thread_id, created_at) VALUES (?, ?, ?)").run(turn, neon.thread_id, SEED_NOW.toISOString());
    const d = (await (await app.request(`/api/debug/${turn}`)).json()) as { memoryWrites: Record<string, any>[] };
    // The seed logged its own rows first, so take the last row of each op.
    const by = (op: string) => d.memoryWrites.filter((x) => x.op === op).at(-1)!;
    expect(by("add")).toMatchObject({ key: "neon::cheapest paid plan price", value: "Launch plan, $24/month" });
    expect(by("supersede")).toMatchObject({ value: "Launch plan, $24/month", previous: ["Launch plan, $19/month"] });
    expect(by("rejected")).toMatchObject({ label: "skipped", text: "Neon | cheapest paid plan price | Launch plan, $19/month" });
    expect(by("forget")).toMatchObject({ label: "forgotten" });
    expect(by("forget").key).toBe("neon::cheapest paid plan price");
    expect(by("forget").value).toBeDefined();
  });

  it("timings include the first status time", async () => {
    const { deps, app } = mkApp();
    const run = await ask(deps, "hi");
    const d = (await (await app.request(`/api/debug/${run.assistantMessageId}`)).json()) as { timings: Record<string, unknown> };
    expect(d.timings).toHaveProperty("firstStatusMs");
  });
});

describe("labelWrite: blocked vs skipped", () => {
  const row = (op: string, detail: unknown) => ({ id: "x", turn_id: "t", op: op as never, claim_id: null, detail_json: JSON.stringify(detail), created_at: "" });
  it("scanner hits are blocked; policy rejections are skipped", () => {
    expect(labelWrite(row("rejected", { field: "summary", reason: "override", text: "ignore all previous instructions" })).label).toBe("blocked");
    expect(labelWrite(row("rejected", { field: "claim", reason: "link-not-in-sources", text: "x" })).label).toBe("blocked");
    for (const reason of ["table says Unchanged", "older evidence", "unsourced", "hedged value", "source not from this turn"]) {
      expect(labelWrite(row("rejected", { field: "claim", reason, text: "x" })).label).toBe("skipped");
    }
  });
  it("other ops get plain labels", () => {
    expect(labelWrite(row("add", {})).label).toBe("added");
    expect(labelWrite(row("supersede", {})).label).toBe("superseded");
    expect(labelWrite(row("error", { stage: "extract" })).label).toBe("failed");
  });
});
