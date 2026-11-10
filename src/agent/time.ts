import * as chrono from "chrono-node";
import { addDays, lastDayOfMonth, localDate, offsetMinutes, weekdayOf, ymd } from "../lib/tz";

/**
 * A date phrase from the user's message, resolved in code (CLAUDE.md rule 3). All dates are local
 * calendar days (YYYY-MM-DD) in the user's timezone; `start`/`end` are inclusive.
 */
export interface TimeRef {
  /** The phrase as typed, e.g. "last Tuesday", "since Monday". */
  text: string;
  start: string;
  end: string;
  /** Weekday ambiguity (SPEC §4.2): [most recent past occurrence, the one a week before]. */
  candidates?: [string, string];
  /** "since X": `start` is the published-after filter for search. */
  since?: boolean;
}

const MAX_REFS = 4;

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

// Phrases that sound like dates but name none. They resolve to nothing, so recall relies on topic
// terms (R2) instead of guessing a day. chrono would otherwise turn "a few days ago" into a date.
const VAGUE =
  /\b(?:the other day|(?:a few|a couple(?: of)?|some|several) (?:days|weeks) ago|recently|lately|a while (?:ago|back))\b/gi;

// The present is already in the time anchor; "now" adds no lookup.
const NOW_WORDS = /\b(?:right now|just now|now)\b/gi;

// "Is it still correct today?" uses "today" as the comparison point, not as a day to look up.
const VERIFY_CUE = /\b(?:still|now|currently|as of)\b/i;

const WEEK_PHRASES = /\b(earlier this week|this week|last week)\b/gi;

const WEEKDAY_PHRASE =
  /\b(?:(next|last|on|since|this past|past|this)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?\b/gi;

// A bare month name ("March madness", "may I") is too often not a date; require a lead-in word.
const MONTH_LEAD_IN = /\b(?:in|during|since|from|throughout|last|this|back in|early|late|mid)\s*$/i;

const SINCE_BEFORE = /\bsince\s*$/i;

interface Found extends TimeRef {
  index: number;
}

/** Blank out a span but keep string length, so later indices still point into the original message. */
function mask(s: string, index: number, length: number): string {
  return s.slice(0, index) + " ".repeat(length) + s.slice(index + length);
}

function mondayOf(day: string): string {
  return addDays(day, -((weekdayOf(day) + 6) % 7));
}

/** Most recent strictly-past occurrence: "on Thursday" said on a Thursday means a week ago (D21). */
function lastWeekday(today: string, target: number): string {
  const back = (weekdayOf(today) - target + 7) % 7 || 7;
  return addDays(today, -back);
}

function weekRange(phrase: string, today: string): { start: string; end: string } {
  const monday = mondayOf(today);
  if (phrase === "last week") return { start: addDays(monday, -7), end: addDays(monday, -1) };
  if (phrase === "earlier this week") {
    const yesterday = addDays(today, -1);
    return { start: monday, end: yesterday < monday ? monday : yesterday };
  }
  return { start: monday, end: today };
}

/** Components → local date. A date with no year is the most recent past occurrence (SPEC §4.2). */
function componentDay(c: chrono.ParsedComponents, today: string, yearCertain: boolean): string | undefined {
  const y = c.get("year");
  const m = c.get("month");
  const d = c.get("day");
  if (y === null || m === null || d === null) return undefined;
  let day = ymd(y, m, d);
  if (!yearCertain && day > today) day = ymd(y - 1, m, d);
  return day;
}

function fromChrono(r: chrono.ParsedResult, message: string, today: string): Found | undefined {
  const s = r.start;
  const dayCertain = s.isCertain("day") || s.isCertain("weekday");
  const monthOnly = s.isCertain("month") && !dayCertain;
  if (!dayCertain && !monthOnly) return undefined; // e.g. a bare time "at 5pm"
  if (monthOnly && !MONTH_LEAD_IN.test(message.slice(0, r.index))) return undefined;

  const yearCertain = s.isCertain("year");
  let start = componentDay(s, today, yearCertain);
  if (!start) return undefined;
  let end = r.end ? componentDay(r.end, today, yearCertain) : start;

  if (monthOnly) {
    const [y, m] = start.split("-").map(Number);
    start = ymd(y ?? 0, m ?? 1, 1);
    end = lastDayOfMonth(y ?? 0, m ?? 1);
  }
  // Memory only covers the past: a future date (tomorrow, next month) is not a lookup.
  if (start > today) return undefined;
  if (!end || end < start) end = start;
  if (end > today) end = today;

  const since = SINCE_BEFORE.test(message.slice(0, r.index));
  return {
    text: since ? `since ${r.text}` : r.text,
    start,
    end: since ? start : end,
    ...(since ? { since: true } : {}),
    index: r.index,
  };
}

/**
 * Resolves the date phrases in `message` against `now` in `tz` (SPEC §4.2).
 *
 * Week phrases, weekdays and "since" are handled here, not by chrono, because their meaning is a
 * product decision: "this week" starts on Monday, a weekday has two candidates, "since X" is a filter.
 * chrono handles the rest (absolute dates, "yesterday", "3 days ago"), with the IANA zone turned into
 * the minute offset it expects.
 */
export function resolveTimeRefs(message: string, now: Date, tz: string): TimeRef[] {
  const today = localDate(now, tz);
  const found: Found[] = [];
  let rest = message;

  const each = (re: RegExp, fn: (m: RegExpExecArray) => Found | undefined): void => {
    for (const m of [...rest.matchAll(re)]) {
      const hit = fn(m as RegExpExecArray);
      if (hit) found.push(hit);
      rest = mask(rest, m.index ?? 0, m[0].length);
    }
  };

  each(VAGUE, () => undefined);
  each(NOW_WORDS, () => undefined);
  if (VERIFY_CUE.test(message)) each(/\btoday\b/gi, () => undefined);

  each(WEEK_PHRASES, (m) => {
    const index = m.index ?? 0;
    const since = SINCE_BEFORE.test(message.slice(0, index));
    const range = weekRange((m[1] ?? "").toLowerCase(), today);
    return {
      text: since ? `since ${m[0]}` : m[0],
      ...range,
      ...(since ? { end: range.start, since: true } : {}),
      index,
    };
  });

  each(WEEKDAY_PHRASE, (m) => {
    const lead = (m[1] ?? "").toLowerCase();
    if (lead === "next") return undefined; // future: nothing to recall
    const index = m.index ?? 0;
    const day = lastWeekday(today, WEEKDAYS.indexOf((m[2] ?? "").toLowerCase()));
    if (lead === "since" || SINCE_BEFORE.test(message.slice(0, index))) {
      // "since Monday" means the most recent one; nobody says it about a week earlier.
      return { text: m[0], start: day, end: day, since: true, index };
    }
    return { text: m[0], start: day, end: day, candidates: [day, addDays(day, -7)], index };
  });

  for (const r of chrono.parse(rest, { instant: now, timezone: offsetMinutes(now, tz) })) {
    const hit = fromChrono(r, message, today);
    if (hit) found.push(hit);
  }

  const seen = new Set<string>();
  return found
    .sort((a, b) => a.index - b.index)
    .filter((f) => {
      const key = `${f.start}|${f.end}|${f.since ? 1 : 0}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_REFS)
    .map(({ index: _index, ...ref }) => ref);
}
