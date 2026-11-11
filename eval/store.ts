import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { EvalCase } from "./cases";
import type { RunResult } from "./runCase";

// A finished case is saved the moment it ends (D66), so a run that stops on a daily quota keeps what it
// finished and `--resume` can carry on. Only uncached runs are ever stored: a replayed answer is not a result.
// The files live under eval/.tmp (gitignored); eval/results.md and eval/transcripts are the committed output.

const check = z.object({ name: z.string(), pass: z.boolean(), detail: z.string().optional() });

const turn = z.object({
  message: z.string(),
  answer: z.string(),
  status: z.string(),
  searchCalls: z.number(),
  sourceNumbers: z.array(z.number()),
  queries: z.array(z.string()),
  sources: z.array(
    z.object({ n: z.number(), url: z.string(), title: z.string(), publishedDate: z.string().optional(), snippet: z.string() }),
  ),
  firstTokenMs: z.number().nullable(),
  totalMs: z.number().nullable(),
});

const runSchema = z.object({
  caseId: z.string(),
  rep: z.number(),
  turns: z.array(turn),
  hard: z.array(check),
  soft: z.array(check),
  passed: z.boolean(),
  judge: z.union([z.object({ score: z.number(), reason: z.string() }), z.object({ error: z.string() })]),
  searchMode: z.enum(["mock", "live", "live (unused)"]),
});

const storedSchema = z.object({
  version: z.literal(1),
  caseId: z.string(),
  /** Hash of the case definition: editing a check or the rubric invalidates the stored result. */
  caseHash: z.string(),
  provider: z.string(),
  mainModel: z.string(),
  smallModel: z.string(),
  /** MAIN_THINKING / MAIN_THINKING_ANSWER: they change latency and answers, so they are part of the match. */
  thinking: z.string(),
  /** Real time the case finished, ISO UTC. */
  ranAt: z.string(),
  repeat: z.number(),
  runs: z.array(runSchema),
});
export type StoredCase = Omit<z.infer<typeof storedSchema>, "runs"> & { runs: RunResult[] };

export interface ModelIds {
  provider: string;
  mainModel: string;
  smallModel: string;
  /** "tool low / answer default" */
  thinking: string;
}

export const storeDir = (evalDir: string): string => join(evalDir, ".tmp", "results");

export function caseHash(c: EvalCase): string {
  return createHash("sha256").update(JSON.stringify(c)).digest("hex").slice(0, 16);
}

export function saveCase(evalDir: string, c: EvalCase, ids: ModelIds, ranAt: string, repeat: number, runs: RunResult[]): string {
  const dir = storeDir(evalDir);
  mkdirSync(dir, { recursive: true });
  const stored: StoredCase = { version: 1, caseId: c.id, caseHash: caseHash(c), ...ids, ranAt, repeat, runs };
  const path = join(dir, `${c.id}.json`);
  writeFileSync(path, `${JSON.stringify(stored, null, 2)}\n`);
  return path;
}

/**
 * The stored result for `c`, only if it is still valid for this run: same provider and main/small model ids,
 * same case definition, same number of repetitions. Anything else (or a corrupt file) is a miss.
 */
export function loadStored(evalDir: string, c: EvalCase, ids: ModelIds, repeat: number): StoredCase | undefined {
  const path = join(storeDir(evalDir), `${c.id}.json`);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = storedSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (!parsed.success) return undefined;
    const s = parsed.data;
    const ok =
      s.caseId === c.id &&
      s.caseHash === caseHash(c) &&
      s.provider === ids.provider &&
      s.mainModel === ids.mainModel &&
      s.smallModel === ids.smallModel &&
      s.thinking === ids.thinking &&
      s.repeat === repeat &&
      s.runs.length === repeat;
    return ok ? (s as StoredCase) : undefined;
  } catch {
    return undefined;
  }
}
