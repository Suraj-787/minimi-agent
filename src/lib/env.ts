import { z } from "zod";

// .env.example ships keys with empty values; "" must behave like "unset" so defaults apply.
const blankToUndefined = (v: unknown): unknown =>
  typeof v === "string" && v.trim() === "" ? undefined : v;

const optionalString = z.preprocess(blankToUndefined, z.string().trim().optional());

// ISO-8601 with an explicit offset or Z. We insist on the offset because "2026-11-12T11:00"
// is parsed in the *machine's* timezone, which would make evals depend on where they run.
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

export const isoWithOffsetSchema = z
  .string()
  .regex(ISO_WITH_OFFSET, "must be ISO-8601 with an offset, e.g. 2026-11-12T11:00:00+05:30")
  .refine(isRealDate, "is not a real date");

// Date.parse() is lenient about day-of-month ("02-31" rolls over to 03-03), so check it ourselves.
function isRealDate(s: string): boolean {
  if (Number.isNaN(Date.parse(s))) return false;
  const [y, m, d] = s.slice(0, 10).split("-").map(Number);
  return d !== undefined && d <= new Date(Date.UTC(y ?? 0, m ?? 0, 0)).getUTCDate();
}

const providers = ["google", "openai", "anthropic"] as const;
type Provider = (typeof providers)[number];

const providerKeyVar: Record<Provider, string> = {
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

// Gemini ids are only a sane default for Gemini; other providers must name their models.
const GOOGLE_DEFAULTS = { main: "gemini-flash-latest", small: "gemini-flash-lite-latest" };

const rawSchema = z.object({
  LLM_PROVIDER: z.preprocess(
    (v) => (typeof v === "string" ? blankToUndefined(v.toLowerCase()) : v),
    z.enum(providers).default("google"),
  ),
  GOOGLE_GENERATIVE_AI_API_KEY: optionalString,
  OPENAI_API_KEY: optionalString,
  ANTHROPIC_API_KEY: optionalString,
  MAIN_MODEL: optionalString,
  SMALL_MODEL: optionalString,
  EXA_API_KEY: optionalString,
  TAVILY_API_KEY: optionalString,
  PORT: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).max(65535).default(8787)),
  DB_PATH: z.preprocess(blankToUndefined, z.string().default("./data/agent.db")),
  MAX_STEPS: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).max(10).default(4)),
  NOW: z.preprocess(blankToUndefined, isoWithOffsetSchema.optional()),
  DEV_LLM_CACHE: z.preprocess(blankToUndefined, z.enum(["0", "1"]).default("0")),
});

const envSchema = rawSchema
  .superRefine((e, ctx) => {
    const keyVar = providerKeyVar[e.LLM_PROVIDER];
    if (!e[keyVar as keyof typeof e]) {
      ctx.addIssue({
        code: "custom",
        path: [keyVar],
        message: `is required when LLM_PROVIDER=${e.LLM_PROVIDER}`,
      });
    }
    if (e.LLM_PROVIDER !== "google") {
      for (const k of ["MAIN_MODEL", "SMALL_MODEL"] as const) {
        if (!e[k]) {
          ctx.addIssue({
            code: "custom",
            path: [k],
            message: `is required when LLM_PROVIDER=${e.LLM_PROVIDER} (no default model id)`,
          });
        }
      }
    }
    if (!e.EXA_API_KEY && !e.TAVILY_API_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["EXA_API_KEY"],
        message: "set EXA_API_KEY and/or TAVILY_API_KEY; web search needs at least one",
      });
    }
  })
  .transform((e) => ({
    ...e,
    MAIN_MODEL: e.MAIN_MODEL ?? GOOGLE_DEFAULTS.main,
    SMALL_MODEL: e.SMALL_MODEL ?? GOOGLE_DEFAULTS.small,
    DEV_LLM_CACHE: e.DEV_LLM_CACHE === "1",
  }));

export type Env = z.output<typeof envSchema>;

export class EnvError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid environment:\n${problems.map((p) => `  ✗ ${p}`).join("\n")}`);
    this.name = "EnvError";
  }
}

/** Pure: validates the given source. Messages name the variable, never print its value (keys!). */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = envSchema.safeParse(source);
  if (result.success) return result.data;
  throw new EnvError(
    result.error.issues.map((i) => `${i.path.join(".") || "env"}: ${i.message}`),
  );
}

let cached: Env | undefined;

/** Memoised accessor for app code; tests should call loadEnv() with an explicit source. */
export function env(): Env {
  cached ??= loadEnv();
  return cached;
}
