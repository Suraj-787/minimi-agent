import { isoWithOffsetSchema } from "./env";

// The ONLY place allowed to read the real clock (CLAUDE.md rule 2). Everything else calls now(),
// so evals and seeds can freeze time with NOW and get reproducible "yesterday"/"last Tuesday".

/** Pure core, so tests don't have to touch process.env or the real clock. */
export function resolveNow(raw: string | undefined, realMs: () => number): Date {
  const value = raw?.trim();
  if (!value) return new Date(realMs());
  const parsed = isoWithOffsetSchema.safeParse(value);
  if (!parsed.success) {
    // Fail loudly: silently falling back to real time would make an eval look valid but be wrong.
    throw new Error(`NOW="${value}" ${parsed.error.issues[0]?.message ?? "is invalid"}`);
  }
  return new Date(parsed.data);
}

/** Current instant. Frozen to NOW when that env var is set. Returns a fresh Date each call. */
export function now(): Date {
  return resolveNow(process.env.NOW, Date.now);
}

/** Date arithmetic lives here with the rest of the date construction, so src/agent and src/search never need `new Date(`. */
export function addMs(d: Date, ms: number): Date {
  return new Date(d.getTime() + ms);
}

/** YYYY-MM-DD (UTC) of an epoch-ms value parsed from a provider string; not a clock read. */
export function isoDayFromMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
