import { z } from "zod";
import {
  SearchProviderError,
  clip,
  toDay,
  type ProviderQuery,
  type RawResult,
  type SearchProvider,
} from "./types";

const tavilyResponse = z.object({
  results: z.array(
    z.object({
      title: z.string().nullish(),
      url: z.string(),
      content: z.string().nullish(),
      published_date: z.string().nullish(),
    }),
  ),
});

type Fetch = typeof fetch;

export function tavilyRequestBody(q: ProviderQuery): Record<string, unknown> {
  return {
    query: q.query,
    max_results: 8,
    search_depth: "basic",
    topic: q.newsLike ? "news" : "general",
    // Without this, Tavily only returns dates for topic=news.
    include_published_date: true,
    ...(q.since ? { start_date: q.since } : {}),
    ...(q.domains?.length ? { include_domains: q.domains } : {}),
    ...(q.fresh ? { max_age_hours: 0 } : {}),
  };
}

export function createTavily(apiKey: string, fetchImpl: Fetch = fetch): SearchProvider {
  return {
    name: "tavily",
    async search(q, signal): Promise<RawResult[]> {
      const res = await fetchImpl("https://api.tavily.com/search", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(tavilyRequestBody(q)),
        signal,
      });
      if (!res.ok) throw new SearchProviderError("tavily", res.status);
      const parsed = tavilyResponse.safeParse(await res.json().catch(() => undefined));
      if (!parsed.success) throw new SearchProviderError("tavily", undefined, "unexpected response shape");
      return parsed.data.results.map((r) => ({
        title: clip(r.title || r.url, 200),
        url: r.url,
        publishedDate: toDay(r.published_date),
        snippet: clip(r.content ?? ""),
      }));
    },
  };
}
