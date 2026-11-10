import { normalizeKeyPart } from "./claimKey";

/**
 * Reads the verify-mode table out of the final answer (D43). The table is what the user saw, so it decides
 * what the ledger does: an Unchanged row may only TOUCH, a Couldn't-verify row writes nothing, and only the
 * other statuses let the extractor's new value through. Pure: no database, no model.
 */
export type VerifyStatus = "unchanged" | "differs" | "changed" | "outdated" | "unverified";

export interface VerifyRow {
  item: string;
  status: VerifyStatus;
  /** [n] numbers in the Source cell. */
  sources: number[];
}

export interface VerifyTable {
  rows: VerifyRow[];
  /** The answer text after the table: the takeaway and any "Shipped since" list. */
  after: string;
}

function cells(line: string): string[] {
  const t = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return t.split("|").map((c) => c.trim());
}

const SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/** Markdown emphasis, code ticks and symbols around a status ("**✅ Unchanged**") are ignored. */
export function parseStatus(cell: string): VerifyStatus | undefined {
  const s = cell
    .toLowerCase()
    .replace(/[*_`]/g, "")
    .replace(/[^\p{L}\p{N}' ’-]+/gu, " ")
    .trim();
  if (/^unchanged\b/.test(s)) return "unchanged";
  if (/\bcould ?n['’]?t verify\b|\bcould not verify\b|\bunverified\b|\bnot verified\b/.test(s)) return "unverified";
  if (/^differs\b/.test(s)) return "differs";
  if (/\balready outdated\b|^outdated\b/.test(s)) return "outdated";
  if (/^changed\b/.test(s)) return "changed";
  return undefined;
}

/** The first table whose header has an Item and a Status column; undefined when there is none. */
export function parseVerifyTable(answer: string): VerifyTable | undefined {
  const lines = answer.split("\n");
  for (let i = 0; i + 1 < lines.length; i++) {
    const header = lines[i] ?? "";
    if (!header.includes("|") || !SEPARATOR.test(lines[i + 1] ?? "")) continue;
    const head = cells(header).map((c) => c.toLowerCase().replace(/[*_`]/g, ""));
    const status = head.findIndex((c) => c.startsWith("status"));
    if (status === -1) continue;
    const itemIdx = head.findIndex((c) => c.startsWith("item"));
    const item = itemIdx === -1 ? 0 : itemIdx;
    const source = head.findIndex((c) => c.startsWith("source"));

    const rows: VerifyRow[] = [];
    let j = i + 2;
    for (; j < lines.length && (lines[j] ?? "").includes("|"); j++) {
      const row = cells(lines[j] ?? "");
      const parsed = parseStatus(row[status] ?? "");
      if (!parsed) continue;
      const src = source === -1 ? (lines[j] ?? "") : (row[source] ?? "");
      rows.push({
        item: (row[item] ?? "").replace(/[*_`]/g, "").trim(),
        status: parsed,
        sources: [...src.matchAll(/\[(\d{1,3})\]/g)].map((m) => Number(m[1])),
      });
    }
    if (rows.length === 0) continue;
    return { rows, after: lines.slice(j).join("\n") };
  }
  return undefined;
}

const words = (s: string): string[] => normalizeKeyPart(s).split(" ").filter(Boolean);
const tokenOf = (entity: string): string => words(entity)[0] ?? "";

/**
 * Which row speaks for each claim: rows naming the claim's entity (first word, whole-word match), and
 * among several (HubSpot Starter vs Professional) the one sharing most attribute words. Claims no row
 * names get no status, so they keep the ordinary write path.
 */
export function statusByClaim(
  table: VerifyTable,
  claims: ReadonlyArray<{ id: string; entity: string; attribute: string }>,
): Map<string, VerifyRow> {
  const out = new Map<string, VerifyRow>();
  for (const c of claims) {
    const token = tokenOf(c.entity);
    if (!token) continue;
    const attr = words(c.attribute).filter((w) => w.length >= 3);
    let best: { row: VerifyRow; score: number } | undefined;
    for (const row of table.rows) {
      const itemWords = words(row.item);
      if (!itemWords.includes(token)) continue;
      const score = attr.filter((w) => itemWords.includes(w)).length;
      if (!best || score > best.score) best = { row, score };
    }
    if (best) out.set(c.id, best.row);
  }
  return out;
}

/**
 * Rows that are not Unchanged but go unmentioned after the table (A4: Salesforce "Differs now" while the
 * closing line said nothing changed). Written to the trace; the eval can assert it is empty.
 */
export function takeawayGaps(table: VerifyTable): string[] {
  const after = words(table.after);
  return table.rows
    .filter((r) => r.status !== "unchanged")
    .filter((r) => {
      const token = words(r.item)[0];
      return token !== undefined && !after.includes(token);
    })
    .map((r) => r.item);
}
