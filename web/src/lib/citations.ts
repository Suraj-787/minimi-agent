import type { UIMessage } from "ai";

export interface Source {
  n: number;
  url: string;
  title: string;
  domain: string;
  /** YYYY-MM-DD from providerMetadata.search.publishedDate; survives a refresh because it is persisted. */
  publishedDate?: string;
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Reads the source-url parts the server wrote (n + date live in providerMetadata.search). */
export function sourcesOf(m: UIMessage): Source[] {
  const out: Source[] = [];
  for (const p of m.parts) {
    if (p.type !== "source-url") continue;
    const meta = (p.providerMetadata as { search?: { n?: unknown; publishedDate?: unknown } } | undefined)?.search;
    if (typeof meta?.n !== "number") continue;
    out.push({
      n: meta.n,
      url: p.url,
      title: p.title || domainOf(p.url),
      domain: domainOf(p.url),
      publishedDate: typeof meta.publishedDate === "string" ? meta.publishedDate : undefined,
    });
  }
  return out.sort((a, b) => a.n - b.n);
}

// Only http(s) may become a link; the URL comes from the web.
function safeHref(url: string): string | undefined {
  return /^https?:\/\//i.test(url) ? url.replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/\s/g, "%20") : undefined;
}

/**
 * Turns [n] into a markdown link when source n exists. A marker with no matching source stays plain
 * text (the model may cite a number it never got), and code is left alone so `a[1]` is untouched.
 */
export function linkCitations(text: string, sources: Source[]): string {
  const byN = new Map(sources.map((s) => [s.n, s]));
  if (byN.size === 0) return text;
  return text
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((segment, i) => {
      if (i % 2 === 1) return segment; // code
      // Not preceded by a word char or "]" (array indexing, existing links) nor followed by "(" / "[".
      return segment.replace(/(?<![\w\]])\[(\d{1,3})\](?![(\[:])/g, (whole, digits: string) => {
        const href = byN.has(Number(digits)) ? safeHref(byN.get(Number(digits))!.url) : undefined;
        return href ? `[\\[${digits}\\]](${href})` : whole;
      });
    })
    .join("");
}
