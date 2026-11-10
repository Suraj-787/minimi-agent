// One JSON object per line. Callers pass small, already-safe fields: never env values or request
// headers, because API keys must not reach logs (CLAUDE.md gotchas).
type Level = "info" | "warn" | "error";

function emit(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields });
  (level === "info" ? console.log : console.error)(line);
}

export const log = {
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
};

/** Reduces an unknown thrown value to fields that are safe to log (no message body, no headers). */
export function errorFields(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const status = (err as { statusCode?: unknown }).statusCode;
    return { error: err.name, ...(typeof status === "number" ? { status } : {}) };
  }
  return { error: typeof err };
}
