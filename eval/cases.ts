import { readFileSync } from "node:fs";
import { z } from "zod";
import { isValidTimezone } from "../src/lib/tz";
import { isoWithOffsetSchema } from "../src/lib/env";

// Validates eval/cases.json. The checks object is strict: a mistyped key would otherwise be skipped
// silently and the case would "pass" without testing anything.

const bool = z.literal(true);

export const checksSchema = z
  .object({
    searched: z.boolean(),
    cited: z.boolean(),
    resolvedDates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
    mustMention: z.array(z.string().min(1)),
    mustNotMention: z.array(z.string().min(1)),
    recallRules: z.array(z.string()),
    recallRulesInclude: z.array(z.string()),
    memoryInjected: z.boolean(),
    verifyTable: bool,
    takeawayMatchesTable: bool,
    noRawLinks: bool,
    shippedAfterSince: bool,
    sourceMatchesItem: bool,
    claimState: z
      .object({
        entity: z.string(),
        currentValueContains: z.string(),
        supersededValueContains: z.string(),
        supersededAtLocalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        historyLength: z.number().int().min(1),
        noClaimValueMatches: z.array(z.string()),
        memoryWritesRejectedOrAbsent: z.boolean(),
      })
      .partial()
      .strict(),
  })
  .partial()
  .strict();
export type Checks = z.infer<typeof checksSchema>;

export const softChecksSchema = z
  .object({ vendorPageFirst: bool, shippedWording: bool, statusMatchesEvidenceLabel: bool })
  .partial()
  .strict();
export type SoftChecks = z.infer<typeof softChecksSchema>;

const mockPage = z.object({
  title: z.string(),
  url: z.url(),
  snippet: z.string(),
  publishedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
export type MockPage = z.infer<typeof mockPage>;

const caseSchema = z
  .object({
    id: z.string().min(1),
    category: z.string(),
    messages: z.array(z.string().min(1)).min(1),
    checks: checksSchema.default({}),
    softChecks: softChecksSchema.default({}),
    rubric: z.string().min(1),
    mockSearch: z.array(mockPage).optional(),
    forgetThreads: z.array(z.string()).optional(),
    now: isoWithOffsetSchema.optional(),
    timezone: z.string().refine(isValidTimezone).optional(),
    seed: z.boolean().optional(),
  })
  .strict();

const fileSchema = z.object({
  _note: z.string().optional(),
  defaults: z.object({ now: isoWithOffsetSchema, timezone: z.string().refine(isValidTimezone), seed: z.boolean() }),
  cases: z.array(caseSchema).min(1),
});

export interface EvalCase {
  id: string;
  category: string;
  messages: string[];
  checks: Checks;
  softChecks: SoftChecks;
  rubric: string;
  mockSearch?: MockPage[];
  forgetThreads?: string[];
  now: string;
  timezone: string;
  seed: boolean;
}

export function parseCases(raw: unknown): EvalCase[] {
  const file = fileSchema.parse(raw);
  const ids = new Set<string>();
  return file.cases.map((c) => {
    if (ids.has(c.id)) throw new Error(`duplicate case id: ${c.id}`);
    ids.add(c.id);
    const { now, timezone, seed, ...rest } = c;
    return {
      ...rest,
      now: now ?? file.defaults.now,
      timezone: timezone ?? file.defaults.timezone,
      seed: seed ?? file.defaults.seed,
    };
  });
}

export function loadCases(): EvalCase[] {
  return parseCases(JSON.parse(readFileSync(new URL("./cases.json", import.meta.url), "utf8")));
}
