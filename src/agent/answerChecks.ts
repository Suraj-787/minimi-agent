// Deterministic checks on a finished answer. They only RECORD problems in the trace (like takeawayGaps, D44):
// an answer is never rewritten after it has streamed, but evals and the "why?" drawer can see the failure.

import type { VerifyTable } from "../memory/verifyTable";

const pad = (n: number): string => String(n).padStart(2, "0");

// Month names are listed explicitly (D70). A generic "any word" pattern let a word before the date ("reported
// 10 November", "after 9 November") match as "<word> <day>", swallow the day number and hide the real date.
const MONTH_NAMES: Array<[number, string[]]> = [
  [1, ["january", "jan"]],
  [2, ["february", "feb"]],
  [3, ["march", "mar"]],
  [4, ["april", "apr"]],
  [5, ["may"]],
  [6, ["june", "jun"]],
  [7, ["july", "jul"]],
  [8, ["august", "aug"]],
  [9, ["september", "sept", "sep"]],
  [10, ["october", "oct"]],
  [11, ["november", "nov"]],
  [12, ["december", "dec"]],
];
const MONTH_NUMBER = new Map(MONTH_NAMES.flatMap(([n, names]) => names.map((name) => [name, n] as const)));
// Longest names first, so "sept" is not read as "sep" + "t".
const MONTH_RE = [...MONTH_NUMBER.keys()].sort((a, b) => b.length - a.length).join("|");
const DAY = String.raw`(\d{1,2})(?!\d)(?:st|nd|rd|th)?`;
const YEAR = String.raw`(?:,?\s+(\d{4})(?!\d))?`;
const DAY_FIRST = String.raw`\b${DAY}\s+(?:of\s+)?(${MONTH_RE})\b\.?${YEAR}`;
const MONTH_FIRST = String.raw`\b(${MONTH_RE})\b\.?\s+${DAY}${YEAR}`;

/** Every calendar date written in `line`, as YYYY-MM-DD. `fallbackYear` fills "Nov 12" with no year. */
export function datesIn(line: string, fallbackYear: number): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) out.push(m[0]);
  for (const m of line.matchAll(new RegExp(`${DAY_FIRST}|${MONTH_FIRST}`, "gi"))) {
    const month = MONTH_NUMBER.get((m[2] ?? m[4] ?? "").toLowerCase());
    const day = Number(m[1] ?? m[5]);
    if (!month || !(day >= 1 && day <= 31)) continue;
    out.push(`${m[3] ?? m[6] ?? fallbackYear}-${pad(month)}-${pad(day)}`);
  }
  return out;
}

/** Markdown links `[text](url)` and bare URLs: answers cite with [n] only (D50). */
export function rawLinks(answer: string): string[] {
  const out: string[] = [];
  const text = answer.replace(/```[\s\S]*?```/g, " "); // a URL inside a code sample is not a citation
  for (const m of text.matchAll(/\[[^\]\n]*\]\(\s*[^)\s]+[^)\n]*\)/g)) out.push(m[0].slice(0, 120));
  const stripped = text.replace(/\[[^\]\n]*\]\(\s*[^)\s]+[^)\n]*\)/g, " ");
  for (const m of stripped.matchAll(/\bhttps?:\/\/[^\s)>\]]+/gi)) out.push(m[0].slice(0, 120));
  return out;
}

/**
 * "Nothing found dated after …", and per-vendor forms like "- Pipedrive: No major feature shipments found dated after
 * 9 November" (D70): a statement that nothing shipped is not an item, so it needs no date after the since date.
 */
export function isNegativeLine(line: string): boolean {
  const text = line
    .trim()
    .replace(/^(?:[-*•]|\d+[.)])\s*/, "") // bullet
    .replace(/^[^:—–]{1,60}?(?::|\s[—–-]\s)\s*/, ""); // "Pipedrive:" or "Zoho CRM — " label
  return /\bnothing found\b/i.test(line) || /^(?:no|none|nothing)\b[^.]*\b(?:found|shipped|launched|released|announced|reported|seen)\b/i.test(text);
}

export interface ShippedProblem {
  line: string;
  reason: "not-after-since" | "undated" | "wrong-since";
}

/**
 * "Shipped since <date>:" may list only items whose own date is after <date> (item 2). Reads the lines
 * under that header up to the first blank line or heading. `expectedSince`, when known, must be the header's date.
 */
/** Bold, italics and code ticks removed: "**Shipped since 3 Nov:**" must read as the header, not leave a "**" line (D74). */
export function stripEmphasis(text: string): string {
  return text
    .replace(/\*\*|__|`/g, "")
    .replace(/(^|[\s(])\*(?=\S)([^*\n]*?\S)\*(?=[\s).,:;!?]|$)/gm, "$1$2");
}

export function shippedProblems(answer: string, expectedSince?: string): ShippedProblem[] {
  const lines = stripEmphasis(answer).split("\n");
  const h = lines.findIndex((l) => /shipped since\b/i.test(l));
  if (h < 0) return [];
  const head = lines[h] as string;
  const year = Number((expectedSince ?? "2000").slice(0, 4));
  const since = datesIn(head.slice(0, head.indexOf(":") >= 0 ? head.indexOf(":") : undefined), year)[0];
  if (!since) return [];
  const problems: ShippedProblem[] = [];
  if (expectedSince && since !== expectedSince) problems.push({ line: head.trim().slice(0, 120), reason: "wrong-since" });

  const body = [head.includes(":") ? head.slice(head.indexOf(":") + 1) : "", ...lines.slice(h + 1)];
  for (const [i, raw] of body.entries()) {
    const line = raw.trim();
    if (!line) {
      if (i === 0) continue; // nothing after the colon on the header line
      break;
    }
    if (/^#{1,6}\s/.test(line) || /^\|/.test(line)) break;
    if (isNegativeLine(line)) continue;
    const dates = datesIn(line, Number(since.slice(0, 4)));
    if (dates.length === 0) problems.push({ line: line.slice(0, 120), reason: "undated" });
    else if (dates.every((d) => d <= since)) problems.push({ line: line.slice(0, 120), reason: "not-after-since" });
  }
  return problems;
}

/** How a dated result sat against a claim's day, as the tool labelled it for the model (verify mode only). */
export interface EvidenceLabel {
  /** The claim's entity the label was computed against. */
  entity: string;
  side: "before" | "same" | "after";
}

export interface ResultText {
  url: string;
  title: string;
  snippet: string;
  /** Set only for a dated result found for a recalled claim; what the model saw as "(before the X claim date …)". */
  label?: EvidenceLabel;
}

export interface SourceMismatch {
  item: string;
  n: number;
  url: string;
  /** The vendor word looked for. */
  vendor: string;
}

const norm = (s: string): string => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ");

/**
 * Vendor names that are also ordinary words, or too short to be distinctive. A body mention of "render" or "bun"
 * proves nothing (a page can say "render the page" or "bundle"), so for these the name must be in the URL or title.
 */
const COMMON_WORD_VENDORS = new Set(["render", "neon", "bun", "linear", "notion", "fly", "deno", "zoom", "stripe", "figma", "close", "copper", "monday"]);
const SHORT_VENDOR = 4;

/**
 * Product name -> the company name its own pages use (D70). "Freshsales" is sold by Freshworks, so its pricing page is
 * freshworks.com and never says "freshsales" in the URL or title. Keyed by the item's first word, lowercase.
 * Covers the CRM tools and hosts in the demo seed; other products fall back to the plain name.
 */
export const VENDOR_ALIASES: Record<string, string[]> = {
  freshsales: ["freshworks"],
  hubspot: ["hubspot"],
  pipedrive: ["pipedrive"],
  salesforce: ["salesforce"],
  zoho: ["zoho"],
  neon: ["neon"],
  supabase: ["supabase"],
  render: ["render"],
  bun: ["bun"],
  node: ["nodejs"],
};

/** The words that count as naming the item's vendor: its first word, first+second joined, and its aliases. */
function vendorForms(words: string[]): string[] {
  const first = words[0];
  if (!first) return [];
  return [first, ...(words[1] ? [`${first}${words[1]}`] : []), ...(VENDOR_ALIASES[first] ?? [])];
}

/**
 * Does this result talk about the item's vendor? Whole word, case-insensitive ("Bun" never matches "bundle").
 * The vendor is the item's first word, also tried joined with the second so "Node.js" finds nodejs.org.
 * Short or common-word vendors must appear in the URL or title; others may appear anywhere in the text (D57).
 */
export function sourceMentionsVendor(item: string, r: ResultText): boolean {
  const words = norm(item).trim().split(" ").filter(Boolean);
  const first = words[0];
  if (!first) return true; // nothing to check against
  const forms = vendorForms(words);
  const strict = first.length <= SHORT_VENDOR || COMMON_WORD_VENDORS.has(first);
  const text = ` ${norm(strict ? `${r.url} ${r.title}` : `${r.url} ${r.title} ${r.snippet}`)} `;
  return forms.some((f) => text.includes(` ${f} `));
}

/**
 * A verify row's cited source must be about that row's item (D55): see sourceMentionsVendor. A competitor's blog
 * that never names the vendor cannot back that vendor's price. Citations of numbers that are not this turn's
 * results are skipped (another check owns them). Written to the trace; write.ts also keeps such rows out of the ledger.
 */
export function sourceMismatches(table: VerifyTable, results: ReadonlyMap<number, ResultText>): SourceMismatch[] {
  const out: SourceMismatch[] = [];
  for (const row of table.rows) {
    const vendor = norm(row.item).trim().split(" ")[0];
    if (!vendor) continue;
    for (const n of row.sources) {
      const r = results.get(n);
      if (r && !sourceMentionsVendor(row.item, r)) out.push({ item: row.item, n, url: r.url, vendor });
    }
  }
  return out;
}

// ── soft checks (D58): wording and source order. Recorded as `soft…` trace entries; the eval reports them as
// warnings and never fails a case on them, because they are judgement calls about style, not correctness.

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

/** Is `url` on the vendor's own site? Whole-word match of the item's vendor on the host ("blog.hubspot.com"). */
export function hostIsVendor(item: string, url: string): boolean {
  const words = norm(item).trim().split(" ").filter(Boolean);
  const first = words[0];
  if (!first) return false;
  const forms = vendorForms(words);
  const host = ` ${norm(hostOf(url))} `;
  return forms.some((f) => host.includes(` ${f} `));
}

// A currency amount or a per-period rate: what "the page states the price" looks like in a snippet.
const PRICE_LIKE = /[$€£₹]\s?\d|\d\s?(?:\/|per\s)\s?(?:mo|month|seat|user|yr|year|hr|hour)/i;

export interface VendorFirstProblem {
  item: string;
  firstCited: number;
  vendorPage: number;
}

/**
 * Price rows should cite the vendor's own page first when it states the price (soft check). Applies only when
 * this turn's results include such a page for the row's vendor; the row's first [n] must then be on the vendor's host.
 */
export function vendorPageFirstProblems(table: VerifyTable, results: ReadonlyMap<number, ResultText>): VendorFirstProblem[] {
  const out: VendorFirstProblem[] = [];
  for (const row of table.rows) {
    const firstCited = row.sources[0];
    if (firstCited === undefined || !results.has(firstCited)) continue;
    const vendorPage = [...results.entries()].find(([, r]) => hostIsVendor(row.item, r.url) && PRICE_LIKE.test(r.snippet))?.[0];
    if (vendorPage === undefined) continue;
    if (!hostIsVendor(row.item, (results.get(firstCited) as ResultText).url)) out.push({ item: row.item, firstCited, vendorPage });
  }
  return out;
}

export interface ShippedWordingProblem {
  line: string;
  reason: "shipped-without-vendor-source";
}

const BULLET = /^[\s\-*•\d.)]+/;

/**
 * In "Shipped since <date>" a line may say "shipped" only when one of its cited sources is the vendor's own site
 * (announcement, release notes, changelog); a recap or aggregator is "reported <date>" (soft check).
 */
export function shippedWordingProblems(answer: string, results: ReadonlyMap<number, ResultText>): ShippedWordingProblem[] {
  const lines = answer.split("\n");
  const h = lines.findIndex((l) => /shipped since\b/i.test(l));
  if (h < 0) return [];
  const head = lines[h] as string;
  const colon = head.indexOf(":");
  const body = [colon >= 0 ? head.slice(colon + 1) : "", ...lines.slice(h + 1)];
  const out: ShippedWordingProblem[] = [];
  for (const [i, raw] of body.entries()) {
    const line = raw.trim();
    if (!line) {
      if (i === 0) continue;
      break;
    }
    if (/^#{1,6}\s/.test(line) || /^\|/.test(line)) break;
    if (/nothing found/i.test(line) || !/\bshipped\b/i.test(line)) continue;
    const item = line.replace(BULLET, "").replace(/[*_`]/g, "");
    const cited = [...line.matchAll(/\[(\d{1,3})\]/g)].map((m) => Number(m[1]));
    const own = cited.some((n) => {
      const r = results.get(n);
      return r !== undefined && hostIsVendor(item, r.url);
    });
    if (!own) out.push({ line: line.slice(0, 120), reason: "shipped-without-vendor-source" });
  }
  return out;
}

// ── soft check: a Couldn't verify row must not repeat the old value as the Now value (D71) ──

export interface NowValueProblem {
  item: string;
  now: string;
}

const NO_VALUE = new Set(["—", "–", "-"]);

/**
 * "Couldn't verify" means there is no current value, so the Then → Now cell must end in "—". "$19/mo → $19/mo" next to
 * Couldn't verify reads as a verified unchanged price (A13). Hyphen and en dash count as a dash. Recorded in the trace
 * (`verifyNowValueOnUnverified`); the answer is never rewritten.
 */
export function nowValueOnUnverified(table: VerifyTable): NowValueProblem[] {
  return table.rows
    .filter((r) => r.status === "unverified" && r.now !== undefined && !NO_VALUE.has(r.now))
    .map((r) => ({ item: r.item, now: (r.now as string).slice(0, 40) }));
}

// ── soft check: status vs the evidence label (D59) ──

export interface StatusContradiction {
  item: string;
  /** The status as written in the table (normalised). */
  status: "differs" | "changed" | "outdated";
  n: number;
  /** What the tool labelled that cited result (label contradictions only). */
  label?: EvidenceLabel["side"];
  /** Set for "Changed after" resting only on the vendor's own pricing or product page (D71). */
  reason?: "vendor-pricing-page-only";
  url?: string;
}

/** A vendor's own pricing / plans / product page: its date is the page's date, never the date a change was announced. */
const PRICING_PATH = /\/(?:pricing|prices?|plans?|products?)(?:[/?#.-]|$)/i;

export function isVendorPricingPage(item: string, url: string): boolean {
  if (!hostIsVendor(item, url)) return false;
  try {
    return PRICING_PATH.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/**
 * The status is a function of the evidence dates (the prompt says so), so a row can be checked against the
 * label the model was shown: "Changed after" / "Differs now" with a cited result labelled BEFORE the claim date
 * should have been Already outdated; "Already outdated" needs a result labelled before, not after or same day.
 * Only labels computed for the row's own vendor count. Recorded in the trace (`verifyStatusContradiction`); the
 * answer is never rewritten, and the eval reports it as a warning, not a failure.
 */
export function statusContradictions(table: VerifyTable, results: ReadonlyMap<number, ResultText>): StatusContradiction[] {
  const out: StatusContradiction[] = [];
  for (const row of table.rows) {
    if (row.status !== "differs" && row.status !== "changed" && row.status !== "outdated") continue;
    // "Changed after" needs a source whose own text reports the change; a vendor pricing page only shows the value now (D71).
    if (row.status === "changed") {
      const cited = row.sources.flatMap((n) => {
        const r = results.get(n);
        return r ? [{ n, r }] : [];
      });
      if (cited.length > 0 && cited.every(({ r }) => isVendorPricingPage(row.item, r.url))) {
        out.push({ item: row.item, status: "changed", n: cited[0]!.n, reason: "vendor-pricing-page-only", url: cited[0]!.r.url });
      }
    }
    const vendor = norm(row.item).trim().split(" ")[0];
    for (const n of row.sources) {
      const label = results.get(n)?.label;
      if (!label || !vendor || norm(label.entity).trim().split(" ")[0] !== vendor) continue;
      const bad = row.status === "outdated" ? label.side !== "before" : label.side === "before";
      if (bad) out.push({ item: row.item, status: row.status, n, label: label.side });
    }
  }
  return out;
}
