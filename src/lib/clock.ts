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
