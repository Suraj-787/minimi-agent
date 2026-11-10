import { normalizeUrl } from "../search/index";

/**
 * Write-side guard for the ledger (SPEC §15.3). Anything stored here is replayed into future prompts,
 * so a string that reads like an instruction, carries hidden characters or points somewhere we did
 * not cite is rejected. A false positive only costs one claim; a false negative persists across sessions.
 */
export type ScanResult = { ok: true } | { ok: false; reason: string };

const PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["override", /\b(?:ignore|disregard|forget|override|bypass)\b[^\n]{0,40}\b(?:instructions?|rules|prompts?|above|guidelines|directives)\b/i],
  ["system-text", /\bsystem\s*(?:prompt|note|message|instructions?|override)\b/i],
  ["imperative", /\byou\s+(?:must|should always|are now|will now|have to)\b/i],
  ["role-tag", /<\s*\/?\s*(?:system|assistant|user|instructions?|memory|context|history|search_results|tool)\b[^>]*>/i],
  ["persist", /\bremember\s+(?:this\s+|that\s+)?(?:permanently|forever|always)\b/i],
  ["exfiltration", /\b(?:leak|exfiltrat)\w*|\b(?:send|forward|upload|transmit|copy)\w*\b[^\n]{0,60}\b(?:every|all|each|the|your|this)\s+(?:conversations?|chats?|chat history|answers?|replies|keys?|secrets?|credentials|prompts?)\b/i],
  ["secret-request", /\b(?:print|reveal|show|dump|output|disclose|display)\w*\b[^\n]{0,30}\b(?:api[-_ ]?keys?|secrets?|tokens?|passwords?|credentials|system prompt)\b/i],
  ["email", /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/],
  ["script-scheme", /\b(?:javascript|vbscript|data|file):/i],
];

// Zero-width, bidi controls and soft hyphen: they hide or reorder text a human reviewer would read.
const INVISIBLE = /[­​-‏‪-‮⁠-⁤⁦-⁩﻿]/;
const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+|\bwww\.[^\s<>"')\]]+/gi;
const TOKEN_RE = /[A-Za-z0-9+/=]{24,}/g;

/** Long runs of base64 alphabet: padded, or a mixed-case + digit blob no product name looks like. */
function hasBase64Blob(text: string): boolean {
  for (const token of text.match(TOKEN_RE) ?? []) {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(token)) continue;
    if (token.endsWith("=") || (/\d/.test(token) && /[a-z]/.test(token) && /[A-Z]/.test(token))) return true;
  }
  return false;
}

export function scanText(raw: string, allowedUrls: Iterable<string> = []): ScanResult {
  if (INVISIBLE.test(raw)) return { ok: false, reason: "invisible-or-bidi-chars" };
  // Full-width and other compatibility forms ("ｉｇｎｏｒｅ") fold to ASCII before matching.
  const text = raw.normalize("NFKC");
  for (const [reason, re] of PATTERNS) if (re.test(text)) return { ok: false, reason };
  if (hasBase64Blob(text)) return { ok: false, reason: "encoded-blob" };

  const allowed = new Set([...allowedUrls].map(normalizeUrl));
  for (const url of text.match(URL_RE) ?? []) {
    const full = url.toLowerCase().startsWith("www.") ? `https://${url}` : url;
    if (!allowed.has(normalizeUrl(full.replace(/[.,;:]+$/, "")))) return { ok: false, reason: "link-not-in-sources" };
  }
  return { ok: true };
}
