import { z } from "zod";
import {
  SearchProviderError,
  clip,
  toDay,
  type ProviderQuery,
  type RawResult,
  type SearchProvider,
} from "./types";

const exaResponse = z.object({
  results: z.array(
    z.object({
      title: z.string().nullish(),
      url: z.string(),
      publishedDate: z.string().nullish(),
      highlights: z.array(z.string()).nullish(),
      text: z.string().nullish(),
    }),
  ),
});

type Fetch = typeof fetch;

export function exaRequestBody(q: ProviderQuery): Record<string, unknown> {
  return {
    query: q.query,
    type: "auto",
    numResults: 8,
    // Exa wants an ISO date-time; the filter is "published on or after".
    ...(q.since ? { startPublishedDate: `${q.since}T00:00:00.000Z` } : {}),
    ...(q.domains?.length ? { includeDomains: q.domains } : {}),
    contents: {
      highlights: { maxCharacters: 1500 },
      // maxAgeHours: 0 = fetch the page live instead of serving Exa's cache. Settled with one live
      // call: the API accepts it inside `contents` (D18).
      ...(q.fresh ? { maxAgeHours: 0 } : {}),
    },
  };
}

export function createExa(apiKey: string, fetchImpl: Fetch = fetch): SearchProvider {
  return {
    name: "exa",
    async search(q, signal): Promise<RawResult[]> {
      const res = await fetchImpl("https://api.exa.ai/search", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify(exaRequestBody(q)),
        signal,
      });
      if (!res.ok) throw new SearchProviderError("exa", res.status);
      const parsed = exaResponse.safeParse(await res.json().catch(() => undefined));
      if (!parsed.success) throw new SearchProviderError("exa", undefined, "unexpected response shape");
      return parsed.data.results.map((r) => ({
        title: clip(r.title || r.url, 200),
        url: r.url,
        publishedDate: toDay(r.publishedDate),
        snippet: clip(r.highlights?.join(" … ") || r.text || ""),
      }));
    },
  };
}
