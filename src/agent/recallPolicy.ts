import type { TimeRef } from "./time";

/**
 * Which memory may enter this prompt (SPEC §4.0). Pure: no database, no clock, no model.
 * Storing memory is easy; this decision is what keeps recalled details from being over-applied.
 */
export type RecallRule = "R0" | "R1" | "R2" | "R3";

export interface RecallIntent {
  verify: boolean;
}

export interface RecallPlan {
  /** Rules that fired, in order; always starts with R0 (this thread's tail). Written to the trace. */
  rules: RecallRule[];
  /** R1: date refs to look up across all threads. Empty unless R1 fired. */
  dated: TimeRef[];
  /** FTS terms: R2 searches them across threads; R1 uses them to pick a weekday candidate and filter a day's turns. */
  topicTerms: string[];
  /** R3: verify-mode instructions go into the context. */
  verify: boolean;
  /** False is rule R4: no cross-thread memory enters the prompt at all. */
  crossThread: boolean;
}

// Back-reference verbs only (D22). A bare "our …" or "earlier" is too common in ordinary questions
// ("structure our REST API", "earlier versions of Node") and would pull in unrelated past chats.
const BACK_REFERENCE: RegExp[] = [
  /\byou\s+(?:told|said|recommended|suggested|mentioned)\b/i,
  /\b(?:i|we)\s+(?:asked|discussed|shortlisted|talked about)\b/i,
  /\b(?:did|have)\s+(?:i|we)\s+(?:ask|discuss|shortlist|talk about)\b/i,
  /\bremember\b/i,
  /\blast time\b/i,
];

const MAX_TERMS = 8;

// Words that say nothing about the topic: function words, conversation verbs (they describe the
// chat, not its subject), time words (dates are resolved separately) and verify cues.
const STOP_WORDS = new Set(
  `a an the and or but if of to in on at by for from with about into over than then that this these those there here
  is are was were be been being am do does did done doing has have had having can could would should will shall may might must
  i me my mine we us our ours you your yours he she it its they them their what which who whom whose when where why how
  any anything some something every all each both either more most much many few other another such only own same
  so too very just also not no yes ok okay please thanks thank hey hi hello get got give gave make made let lets
  ask asked asking asks tell told telling said say says saying discuss discussed discussing discussion talk talked talking
  chat chatted conversation remember recall recommended recommend suggested suggest mentioned mention answer answers
  answered question questions reply replied summarise summarize summary shortlisted
  today yesterday tomorrow now then week weeks month months year years day days ago since last earlier later recently
  lately before after while time times date dates morning afternoon evening night
  monday tuesday wednesday thursday friday saturday sunday
  january february march april june july august september october november december
  jan feb mar apr jun jul aug sep sept oct nov dec
  still correct correctly true accurate valid current currently changed change changes update updates updated
  shipped ship big new news latest right wrong check recheck verify`.split(/\s+/),
);

// Light stemming so "pricing" finds "price" and "hosting" finds "host". FTS5 matches the stem as a prefix.
function stem(word: string): string {
  for (const suffix of ["ing", "ed", "es", "s"]) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 4) return word.slice(0, -suffix.length);
  }
  return word;
}

/** Topic words of the message, with the date phrases removed. Lowercase ASCII-ish stems, safe to quote for FTS. */
export function topicTerms(message: string, times: readonly TimeRef[] = []): string[] {
  let text = message.toLowerCase();
  for (const t of times) text = text.split(t.text.toLowerCase()).join(" ");
  const out: string[] = [];
  for (const raw of text.split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 3 || /^\d+$/.test(raw) || STOP_WORDS.has(raw)) continue;
    const s = stem(raw);
    if (!out.includes(s)) out.push(s);
    if (out.length >= MAX_TERMS) break;
  }
  return out;
}

export function hasBackReference(message: string): boolean {
  return BACK_REFERENCE.some((re) => re.test(message));
}

export function recallPolicy(input: { message: string; intent: RecallIntent; times: readonly TimeRef[] }): RecallPlan {
  const { message, intent, times } = input;
  const rules: RecallRule[] = ["R0"];
  const terms = topicTerms(message, times);

  const dated = times.length > 0;
  if (dated) rules.push("R1");
  // R2 needs something to search for: "what did I ask you?" alone has no topic.
  const backRef = hasBackReference(message) && terms.length > 0;
  if (backRef) rules.push("R2");
  if (intent.verify) rules.push("R3");

  return {
    rules,
    dated: dated ? [...times] : [],
    topicTerms: terms,
    verify: intent.verify,
    crossThread: dated || backRef,
  };
}
