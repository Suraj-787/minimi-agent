/** True for IANA names the runtime knows ("Asia/Kolkata"); false for junk and abbreviations like "IST". */
export function isValidTimezone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    // Intl accepts "UTC" and offsets-as-names on some runtimes; we only want a resolvable zone.
    return true;
  } catch {
    return false;
  }
}

export interface LocalParts {
  date: string; // YYYY-MM-DD
  time: string; // HH:mm
  weekday: string; // "Thursday"
  offset: string; // "+05:30"
}

function parts(at: Date | string, tz: string): Record<string, string> {
  const d = typeof at === "string" ? new Date(at) : at;
  const out: Record<string, string> = {};
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "long",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  });
  for (const p of fmt.formatToParts(d)) out[p.type] = p.value;
  return out;
}

/** Calendar date of an instant as seen in `tz`. Used for every message's `local_date`. */
export function localDate(d: Date | string, tz: string): string {
  const p = parts(d, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

export function localParts(d: Date | string, tz: string): LocalParts {
  const p = parts(d, tz);
  // longOffset renders "GMT+05:30", or plain "GMT" for UTC.
  const offset = (p.timeZoneName ?? "GMT").replace("GMT", "") || "+00:00";
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${p.hour}:${p.minute}`,
    weekday: p.weekday ?? "",
    offset,
  };
}

/** UTC offset of `tz` at instant `d`, in minutes (+330 for IST). chrono-node wants this, not an IANA name. */
export function offsetMinutes(d: Date, tz: string): number {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(localParts(d, tz).offset);
  if (!m) return 0;
  const mins = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === "-" ? -mins : mins;
}

// ── calendar arithmetic on local dates (YYYY-MM-DD) ──────────────────────
// Local dates carry no time or zone, so plain UTC-day arithmetic is exact (no DST to trip over).

const DAY_MS = 86_400_000;
const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function ymdToMs(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

function msToYmd(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(ymd: string, n: number): string {
  return msToYmd(ymdToMs(ymd) + n * DAY_MS);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekdayOf(ymd: string): number {
  return new Date(ymdToMs(ymd)).getUTCDay();
}

/** "2026-11-03 (Tue)": the form every date takes in the prompt. */
export function formatDay(ymd: string): string {
  return `${ymd} (${WEEKDAYS_SHORT[weekdayOf(ymd)] ?? ""})`;
}

export function ymd(year: number, month: number, day: number): string {
  return msToYmd(Date.UTC(year, month - 1, day));
}

export function lastDayOfMonth(year: number, month: number): string {
  return msToYmd(Date.UTC(year, month, 0));
}

/** The instant at local wall-clock `ymd hh:mm` in `tz`. Re-checks the offset once to land correctly around DST. */
export function zonedToUtc(day: string, hhmm: string, tz: string): Date {
  const [h, mi] = hhmm.split(":").map(Number);
  const guess = ymdToMs(day) + ((h ?? 0) * 60 + (mi ?? 0)) * 60_000;
  const first = guess - offsetMinutes(new Date(guess), tz) * 60_000;
  return new Date(guess - offsetMinutes(new Date(first), tz) * 60_000);
}
