import type { RecallIntent } from "./recallPolicy";

/**
 * Cheap intent flags (SPEC §8). Regex only: no model quota and predictable. A false positive only
 * adds verify instructions (and, when claims were recalled, one forced search), so the cues lean wide.
 */
export interface Intent extends RecallIntent {
  /** Names of the cues that matched, for the trace. */
  cues: string[];
  /**
   * The user asks what shipped / launched / changed, not only whether a value still holds. On its own it
   * does nothing; in verify mode with claims to re-check it forces a dated news search (D37).
   */
  news: boolean;
}

const NEWS_CUE = /\b(?:ship|ships|shipped|launch\w*|release[sd]?|news|updates?|announce\w*)\b/i;

const WEEKDAY = "(?:mon|tues|wednes|thurs|fri|satur|sun)day";
const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";

const VERIFY_CUES: ReadonlyArray<readonly [string, RegExp]> = [
  [
    "still",
    /\bstill\s+(?:correct|true|accurate|valid|right|the case|current|up[- ]to[- ]date|hold|holds|apply|applies|good|stand|stands)\b/i,
  ],
  ["is-it-still", /\b(?:is|are|was|were)\s+(?:that|this|it|they|those|these|that answer|your answer)\s+still\b/i],
  ["changed", /\b(?:changed|any changes)\b/i],
  ["any-update", /\bany\s+(?:updates?|news)\b/i],
  [
    "since",
    new RegExp(
      `\\bsince\\s+(?:then|that|yesterday|last\\s+(?:week|month|time|${WEEKDAY})|${WEEKDAY}|${MONTH}\\s+\\d{1,2}\\b|\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}|\\d{4}-\\d{2}-\\d{2}|(?:we|i)\\s+(?:talked|spoke|discussed|asked)|you\\s+(?:told|said|answered))`,
      "i",
    ),
  ],
  ["shipped", /\bshipped\b/i],
  ["recheck", /\b(?:re-?check|double[- ]check|re-?verify|verify|fact[- ]check)\b/i],
  ["freshness", /\b(?:up[- ]to[- ]date|out[- ]of[- ]date|outdated)\b/i],
];

export function detectIntent(message: string): Intent {
  const cues = VERIFY_CUES.filter(([, re]) => re.test(message)).map(([name]) => name);
  return { verify: cues.length > 0, cues, news: NEWS_CUE.test(message) };
}
