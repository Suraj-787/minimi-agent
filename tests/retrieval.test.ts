import { describe, expect, it } from "vitest";
import { runAgent } from "../src/agent/index";
import type { Db } from "../src/db/index";
import { getTrace, type ClaimRow } from "../src/db/memoryRepo";
import { reconcileClaims, isPriceValue } from "../src/memory/reconcile";
import { createSearch } from "../src/search/index";
import type { ProviderQuery, RawResult, SearchProvider } from "../src/search/types";
import { emptyExtraction, objectModel, scriptedModel } from "./helpers/mockModel";
import { IST, SEED_NOW, seededDb } from "./helpers/seed";

// D73/D74 through the real search client: a fake provider records every request exactly as Exa would get it.

const page = (url: string, title: string, publishedDate?: string, snippet = "…"): RawResult => ({ url, title, snippet, ...(publishedDate ? { publishedDate } : {}) });

function fakeExa(answer: (q: ProviderQuery) => RawResult[]): SearchProvider & { requests: ProviderQuery[] } {
  const requests: ProviderQuery[] = [];
  return {
    name: "exa",
    requests,
    search: async (q) => {
      requests.push(q);
      return answer(q);
    },
  };
}

const TABLE = "| Item | Said (date) | Then → Now | Status | Evidence date | Source |\n|---|---|---|---|---|---|\n";
const TID = "abababab-abab-4bab-8bab-abababababab";

async function verifyTurn(db: Db, provider: SearchProvider, message: string, modelInput: Record<string, unknown>) {
  const main = scriptedModel([{ toolCall: { name: "web_search", input: modelInput } }, { text: `${TABLE}| x | y | z | Unchanged | – | – |\n\nAll unchanged.` }]);
  const run = await runAgent(
    { db, models: { main, small: objectModel(emptyExtraction) }, now: () => SEED_NOW, search: createSearch({ db, providers: [provider], now: () => SEED_NOW }), maxSteps: 4 },
    { threadId: TID, message, tz: IST },
  );
  const reader = run.stream.getReader();
  while (!(await reader.read()).done);
  await run.done;
  const trace = getTrace(db, run.assistantMessageId)!;
  // The closed step's prompt as plain text (the text parts joined), so line-based checks see real newlines.
  const closedPrompt = ((main.doStreamCalls[1]?.prompt ?? []) as Array<{ content: unknown }>)
    .flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<{ type: string; text?: string }>) : []))
    .map((c) => (c.type === "text" ? (c.text ?? "") : ""))
    .join("\n");
  return { main, queries: JSON.parse(trace.queries_json ?? "[]") as Array<Record<string, any>>, closedPrompt };
}

describe("Postgres re-check (the demo turn): the request the search client actually got", () => {
  // What the provider holds. With a domain filter, only that host's pages. Neon's own pages appear only for the
  // targeted retry's query, so the price pass finds nothing that names Neon and the retry must run.
  const exa = () =>
    fakeExa((q) => {
      const d = q.domains ?? [];
      if (d.includes("supabase.com")) return [page("https://supabase.com/pricing", "Supabase Pricing"), page("https://supabase.com/blog/pricing-update", "Supabase blog", "2026-11-05")];
      if (d.includes("render.com")) return [page("https://render.com/pricing", "Render Pricing"), page("https://render.com/docs/postgresql", "Render Postgres docs")];
      if (d.includes("neon.com")) return q.query === "Neon cheapest paid plan price" ? [page("https://neon.com/pricing", "Neon Pricing")] : [];
      if (/neon/i.test(q.query)) {
        // the unrestricted Neon twin: a Supabase page (it must be dated against Supabase) and a page naming nobody
        return [page("https://supabase.com/blog/set-up-supabase-for-every-expo-environment", "Set up Supabase for every Expo environment", "2026-11-10"), page("https://example.test/hosts", "Cheap Postgres hosts", "2026-11-06")];
      }
      if (/supabase/i.test(q.query)) return [page("https://supabase.com/pricing", "Supabase Pricing"), page("https://costbrake.com/guides/supabase-pricing", "Supabase pricing guide", "2026-11-09")];
      return [];
    });

  const run = async () => {
    const db = seededDb();
    const provider = exa();
    // The model asks for since, a stale Neon domain and one union domain list: all of it is ignored (D73).
    const out = await verifyTurn(db, provider, "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?", {
      queries: ["supabase pricing pro", "render postgres pricing", "neon postgres pricing"],
      since: "2026-11-03",
      domains: ["supabase.com", "render.com", "neon.tech"],
    });
    return { ...out, requests: provider.requests };
  };

  it("price pass: no since, fresh on, per-item hosts (neon.com, never neon.tech), each paired with an unrestricted twin", async () => {
    const { requests } = await run();
    const price = requests.filter((r) => r.query !== "Neon cheapest paid plan price");
    expect(price.every((r) => r.since === undefined)).toBe(true);
    expect(price.every((r) => r.fresh === true)).toBe(true);
    expect(requests.some((r) => r.domains?.includes("neon.tech"))).toBe(false);
    // items come in the order of the recalled claims; compare as a set
    const shape = price.map((r) => JSON.stringify([r.query, r.domains ?? null])).sort();
    expect(shape).toEqual(
      [
        ["neon postgres pricing", ["neon.com"]],
        ["neon postgres pricing", null],
        ["render postgres pricing", ["render.com"]],
        ["render postgres pricing", null],
        ["supabase pricing pro", ["supabase.com"]],
        ["supabase pricing pro", null],
      ].map((x) => JSON.stringify(x)),
    );
  });

  it("targeted retry: only Neon (no returned page named it), on neon.com, no since, and its page reaches the model as undated", async () => {
    const { requests, closedPrompt, queries } = await run();
    const retries = requests.filter((r) => r.query === "Neon cheapest paid plan price");
    expect(retries).toEqual([expect.objectContaining({ domains: ["neon.com"], fresh: true })]);
    expect(retries[0]?.since).toBeUndefined();
    expect(closedPrompt).toMatch(/Neon Pricing — https:\/\/neon\.com\/pricing — undated/);
    expect(queries.find((q) => q.query === "Neon cheapest paid plan price (retry: neon.com)")).toMatchObject({ item: "Neon", domains: ["neon.com"] });
  });

  it("labels per item: the Supabase page the Neon job found is dated against the Supabase claim, never Neon's", async () => {
    const { closedPrompt } = await run();
    expect(closedPrompt).toContain("Set up Supabase for every Expo environment — https://supabase.com/blog/set-up-supabase-for-every-expo-environment — published 2026-11-10 (after the Supabase claim date 2026-11-03)");
    expect(closedPrompt).not.toMatch(/Expo environment[^\n]*Neon claim date/);
    // a page that names no vendor falls back to its job's item
    expect(closedPrompt).toContain("Cheap Postgres hosts — https://example.test/hosts — published 2026-11-06 (after the Neon claim date 2026-11-03)");
  });

  it("the trace keeps every query with its filters, each result's fate and label, and empty filtered queries", async () => {
    const { queries } = await run();
    const neonHost = queries.find((q) => q.query === "neon postgres pricing (neon.com)")!;
    expect(neonHost).toMatchObject({ item: "Neon", domains: ["neon.com"], empty: "filter", provider: "exa", results: [] });
    const supaHost = queries.find((q) => q.query === "supabase pricing pro (supabase.com)")!;
    expect(supaHost.results[0]).toMatchObject({ url: "https://supabase.com/pricing", fate: "kept", label: "undated" });
    const pricingN = supaHost.results[0].n as number;
    const supaAny = queries.find((q) => q.query === "supabase pricing pro (any site)")!;
    expect(supaAny.since).toBeUndefined();
    expect(supaAny.results[0]).toMatchObject({ url: "https://supabase.com/pricing", fate: "duplicate", duplicateOf: pricingN });
    expect(supaAny.results[1]).toMatchObject({ fate: "kept", label: "published 2026-11-09 (after the Supabase claim date 2026-11-03)" });
  });
});

describe("per-item reservation (D74): five CRM items, one provider flooding results", () => {
  it("every item keeps at least 2 results; the call shows at most 12", async () => {
    const db = seededDb();
    // HubSpot's two jobs return 10 pages each; every other job returns 2 pages that name its vendor.
    const provider = fakeExa((q) => {
      const vendor = q.query.split(" ")[0]!.toLowerCase();
      const host = q.domains?.[0] ?? "example.test";
      const n = vendor === "hubspot" ? 10 : 2;
      return Array.from({ length: n }, (_, i) => page(`https://${host}/${vendor}-${q.domains ? "own" : "any"}-${i}`, `${vendor} pricing ${i}`));
    });
    const { queries } = await verifyTurn(db, provider, "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing since?", {
      queries: ["HubSpot pricing", "Pipedrive pricing", "Salesforce pricing", "Zoho pricing", "Freshsales pricing"],
    });
    const price = queries.filter((q) => !String(q.query).includes("retry"));
    const keptBy = new Map<string, number>();
    for (const q of price) for (const r of q.results) if (r.fate === "kept") keptBy.set(q.item, (keptBy.get(q.item) ?? 0) + 1);
    for (const item of ["HubSpot Sales Hub", "Pipedrive", "Salesforce Sales Cloud", "Zoho CRM", "Freshsales"]) {
      expect(keptBy.get(item) ?? 0, item).toBeGreaterThanOrEqual(2);
    }
    const kept = [...keptBy.values()].reduce((a, b) => a + b, 0);
    expect(kept).toBeLessThanOrEqual(12);
    expect(kept).toBe(10); // 2 per item x 5, cap 10
    // HubSpot's extra pages were cut by the cap, and the trace says so
    expect(price.flatMap((q) => q.results).some((r: { fate: string }) => r.fate === "cap")).toBe(true);
  });
});

describe("ledger (D74): a price claim is never superseded by a non-price value", () => {
  const turn = { turnId: "t-1", threadId: "th-1", observedAt: SEED_NOW };
  const claims = (db: Db, entity: string) => db.prepare("SELECT * FROM claims WHERE entity = ? ORDER BY observed_at, rowid").all(entity) as ClaimRow[];

  it("the Neon $19 claim survives 'Pay for what you use'; the statement gets its own key", () => {
    const db = seededDb();
    const ops = reconcileClaims(db, turn, [
      { entity: "Neon", attribute: "cheapest paid plan price", value: "Pay for what you use", sourceUrl: "https://neon.com/pricing", validAsOf: "2026-11-12" },
    ]);
    expect(ops).toEqual([expect.objectContaining({ op: "add", key: "neon::cheapest paid plan price description" })]);
    expect(claims(db, "Neon").map((c) => [c.attribute, c.value, c.status])).toEqual([
      ["cheapest paid plan price", "Launch plan, $19/month", "current"],
      ["cheapest paid plan price (description)", "Pay for what you use", "current"],
    ]);
    const w = db.prepare("SELECT detail_json FROM memory_writes WHERE turn_id = 't-1'").get() as { detail_json: string };
    expect(JSON.parse(w.detail_json)).toMatchObject({ reason: "not a price: kept apart from the price claim", priceKey: "neon::cheapest paid plan price" });
  });

  it("a new price still supersedes a price", () => {
    const db = seededDb();
    reconcileClaims(db, turn, [{ entity: "Supabase", attribute: "cheapest paid plan price", value: "Pro plan, $29/month", sourceUrl: "https://supabase.com/pricing", validAsOf: "2026-11-12" }]);
    expect(claims(db, "Supabase").map((c) => [c.value, c.status])).toEqual([
      ["Pro plan, $25/month", "superseded"],
      ["Pro plan, $29/month", "current"],
    ]);
  });

  it("isPriceValue", () => {
    for (const v of ["Launch plan, $19/month", "€8 per seat", "19 USD", "Free", "$0.106/CU-hr"]) expect(isPriceValue(v), v).toBe(true);
    for (const v of ["Pay for what you use", "Usage-based", "1.3", "Launch plan"]) expect(isPriceValue(v), v).toBe(false);
  });
});
