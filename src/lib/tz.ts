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

function parts(d: Date, tz: string): Record<string, string> {
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
export function localDate(d: Date, tz: string): string {
  const p = parts(d, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

export function localParts(d: Date, tz: string): LocalParts {
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
