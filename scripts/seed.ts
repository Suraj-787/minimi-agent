import { config } from "dotenv";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { openDb, type Db } from "../src/db/index";
import { insertClaim, insertMemoryWrite, insertTurnSummary } from "../src/db/memoryRepo";
import { createThread, insertMessage, listThreads } from "../src/db/repo";
import { addMs, now as clockNow } from "../src/lib/clock";
import { addDays, isValidTimezone, localDate, zonedToUtc } from "../src/lib/tz";

// Loads eval/seed.json as if those chats happened `daysAgo` days before now(). Used by `npm run seed`
// and (Phase 6) by the eval runner on a fresh temp DB, so both see identical history.

const seedSchema = z.object({
  timezone: z.string().refine(isValidTimezone, "must be an IANA timezone"),
  threads: z.array(
    z.object({
      id: z.string().min(1),
      title: z.string().min(1).max(120),
      turns: z.array(
        z.object({
          daysAgo: z.number().int().min(0).max(3650),
          time: z.string().regex(/^\d{2}:\d{2}$/),
          user: z.string().min(1),
          assistant: z.string().min(1),
          sources: z.array(z.url()),
          claims: z.array(
            z.object({
              entity: z.string().min(1).max(80),
              attribute: z.string().min(1).max(80),
              value: z.string().min(1).max(200),
              sourceUrl: z.url().optional(),
            }),
          ),
          summary: z.string().min(1).max(400),
        }),
      ),
    }),
  ),
});
export type SeedFile = z.infer<typeof seedSchema>;

export function parseSeed(raw: unknown): SeedFile {
  return seedSchema.parse(raw);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-11-03" → "3 Nov 2026", the form the seeded answers use for "As of {{date}}". */
export function humanDate(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1]} ${y}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export interface SeedResult {
  threads: { label: string; id: string }[];
  skipped: string[];
}

/** Writes every seed thread in one transaction. Threads whose title already exists are skipped. */
export function loadSeed(db: Db, seed: SeedFile, now: Date): SeedResult {
  const tz = seed.timezone;
  const today = localDate(now, tz);
  const existing = new Set(listThreads(db).map((t) => t.title));
  const result: SeedResult = { threads: [], skipped: [] };

  db.transaction(() => {
    for (const thread of seed.threads) {
      if (existing.has(thread.title)) {
        result.skipped.push(thread.id);
        continue;
      }
      // The seed id is a label only; /api/chat needs a UUID so seeded chats can be continued (D16).
      const threadId = randomUUID();
      const first = thread.turns[0];
      const createdAt = first ? zonedToUtc(addDays(today, -first.daysAgo), first.time, tz) : now;
      createThread(db, { id: threadId, title: thread.title, createdAt });

      for (const turn of thread.turns) {
        const day = addDays(today, -turn.daysAgo);
        const askedAt = zonedToUtc(day, turn.time, tz);
        // 20 s later, never across midnight for any time in the file.
        const answeredAt = addMs(askedAt, 20_000);
        insertMessage(db, { threadId, role: "user", text: turn.user, tz, createdAt: askedAt });

        const text = turn.assistant.replaceAll("{{date}}", humanDate(day));
        const parts = [
          ...turn.sources.map((url, i) => ({
            type: "source-url",
            sourceId: `src-${i + 1}`,
            url,
            title: hostOf(url),
            providerMetadata: { search: { n: i + 1 } },
          })),
          { type: "text", text },
        ];
        const answer = insertMessage(db, {
          threadId,
          role: "assistant",
          text,
          partsJson: JSON.stringify(parts),
          tz,
          createdAt: answeredAt,
        });

        insertTurnSummary(db, { turnId: answer.id, threadId, localDate: day, summary: turn.summary, createdAt: answeredAt });
        for (const c of turn.claims) {
          const claim = insertClaim(db, {
            ...c,
            sourceUrl: c.sourceUrl ?? null,
            turnId: answer.id,
            threadId,
            observedAt: answeredAt,
            validAsOf: day,
          });
          insertMemoryWrite(db, {
            turnId: answer.id,
            op: "add",
            claimId: claim.id,
            detail: { source: "seed", label: thread.id },
            createdAt: answeredAt,
          });
        }
      }
      result.threads.push({ label: thread.id, id: threadId });
    }
  })();
  return result;
}

/** Removes the SQLite file and its WAL side files, so the next openDb() starts empty. Returns whether any existed. */
export function removeDbFiles(path: string): boolean {
  let removed = false;
  for (const p of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(p)) {
      rmSync(p);
      removed = true;
    }
  }
  return removed;
}

const cliEnv = z.object({
  DB_PATH: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().default("./data/agent.db")),
});

function main(): void {
  config({ quiet: true });
  // Only DB_PATH matters here; seeding must work before any API key is set.
  const { DB_PATH } = cliEnv.parse(process.env);
  const reset = process.argv.includes("--reset");
  if (reset) {
    if (DB_PATH === ":memory:") throw new Error("--reset needs a file DB_PATH");
    const removed = removeDbFiles(DB_PATH);
    console.log(
      removed
        ? `reset: removed ${DB_PATH} (stop the dev server first if it is running)`
        : `reset: ${DB_PATH} did not exist, starting fresh`,
    );
  }
  const db = openDb(DB_PATH);
  const seed = parseSeed(JSON.parse(readFileSync(new URL("../eval/seed.json", import.meta.url), "utf8")));
  const at = clockNow();
  const result = loadSeed(db, seed, at);
  db.close();

  console.log(`now = ${at.toISOString()} (${localDate(at, seed.timezone)} in ${seed.timezone})`);
  for (const t of result.threads) console.log(`seeded ${t.label} → ${t.id}`);
  for (const s of result.skipped) console.log(`skipped ${s} (a thread with that title exists; use --reset)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
