// The deterministic merge key for the answer ledger (SPEC §7.2). Phase 4's reconcile.ts uses it to
// decide ADD / TOUCH / SUPERSEDE; the seed uses it now so seeded claims merge with live ones later.

/** Lowercase, punctuation → space, collapse whitespace. "Pro-plan  price " → "pro plan price". */
export function normalizeKeyPart(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function claimKey(entity: string, attribute: string): string {
  return `${normalizeKeyPart(entity)}::${normalizeKeyPart(attribute)}`;
}
