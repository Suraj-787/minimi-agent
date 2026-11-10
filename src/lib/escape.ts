// Untrusted text (web pages, recalled chat text) must not be able to close our data wrappers
// (<search_results>, <memory>) or open a fake one. Text is entity-escaped; URLs are
// percent-encoded so they stay usable as links.
export function escapeText(s: string): string {
  return s.replace(/\s+/g, " ").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").trim();
}

export function escapeUrl(s: string): string {
  return s.replace(/\s+/g, "%20").replace(/</g, "%3C").replace(/>/g, "%3E");
}

/** Escapes, then cuts to `max` characters with an ellipsis, so a cap is never exceeded. */
export function clip(s: string, max: number): string {
  const e = escapeText(s);
  return e.length <= max ? e : `${e.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
