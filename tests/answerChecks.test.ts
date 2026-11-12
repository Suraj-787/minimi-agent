import { describe, expect, it } from "vitest";
import {
  datesIn,
  hostIsVendor,
  isNegativeLine,
  isVendorPricingPage,
  nowValueOnUnverified,
  rawLinks,
  shippedProblems,
  stripEmphasis,
  shippedWordingProblems,
  sourceMentionsVendor,
  sourceMismatches,
  statusContradictions,
  vendorPageFirstProblems,
  type ResultText,
} from "../src/agent/answerChecks";
import { parseVerifyTable } from "../src/memory/verifyTable";

describe("rawLinks (answers cite [n] only)", () => {
  it("finds markdown links and bare URLs", () => {
    expect(rawLinks("Neon is $19 [1].")).toEqual([]);
    expect(rawLinks("See [Neon pricing](https://neon.com/pricing).")).toHaveLength(1);
    expect(rawLinks("See https://neon.com/pricing for more")).toEqual(["https://neon.com/pricing"]);
    expect(rawLinks("[neon.com](https://neon.com) and https://a.test/x")).toHaveLength(2);
  });
  it("ignores [n], [1, 2] and URLs inside code fences", () => {
    expect(rawLinks("Both [1][2] and [1, 3] agree.")).toEqual([]);
    expect(rawLinks("```\ncurl https://api.test/x\n```")).toEqual([]);
  });
});

describe("datesIn", () => {
  it("reads ISO, '12 Nov 2026', 'Nov 12' and 'November 12th, 2026'", () => {
    expect(datesIn("on 2026-11-12", 2026)).toEqual(["2026-11-12"]);
    expect(datesIn("12 Nov 2026", 2026)).toEqual(["2026-11-12"]);
    expect(datesIn("Nov 12", 2026)).toEqual(["2026-11-12"]);
    expect(datesIn("November 12th, 2026", 2025)).toEqual(["2026-11-12"]);
    expect(datesIn("no date here", 2026)).toEqual([]);
  });
});

describe("shippedProblems", () => {
  const since = "2026-11-09";
  it("accepts items dated after since and the 'Nothing found' form", () => {
    const ok = `| table |\n\nShipped since 2026-11-09:\n- HubSpot: new AI agent, 2026-11-10 [3]\n- Zoho: 12 Nov 2026 [4]`;
    expect(shippedProblems(ok, since)).toEqual([]);
    expect(shippedProblems("Shipped since 2026-11-09: Nothing found dated after 2026-11-09.", since)).toEqual([]);
    expect(shippedProblems("Shipped since 2026-11-09:\nNothing found dated after 2026-11-09.", since)).toEqual([]);
  });
  it("flags an item dated on or before since", () => {
    const bad = `Shipped since 2026-11-09:\n- Pipedrive: launched, 2026-11-09 [2]\n- Zoho: 2026-11-05 [4]\n- HubSpot: 2026-11-10 [3]`;
    expect(shippedProblems(bad, since).map((p) => [p.reason, p.line.slice(0, 9)])).toEqual([
      ["not-after-since", "- Pipedri"],
      ["not-after-since", "- Zoho: 2"],
    ]);
  });
  it("flags undated items and a header date that is not the expected since", () => {
    expect(shippedProblems("Shipped since 2026-11-09:\n- HubSpot launched a thing [3]", since)[0]?.reason).toBe("undated");
    expect(shippedProblems("Shipped since 2026-11-02:\n- HubSpot: 2026-11-10 [3]", since)[0]?.reason).toBe("wrong-since");
  });
  it("stops at a blank line, so prose after the list is not read as items", () => {
    expect(shippedProblems("Shipped since 2026-11-09:\n- A: 2026-11-10 [1]\n\nAs of today nothing else.", since)).toEqual([]);
  });
  it("returns nothing when the answer has no such section", () => {
    expect(shippedProblems("All unchanged.", since)).toEqual([]);
  });
});

describe("sourceMismatches (a cited source must be about the row's item, D55)", () => {
  const results = new Map<number, ResultText>([
    [1, { url: "https://pipedrive.com/pricing", title: "Pipedrive Pricing", snippet: "Professional $49 per seat" }],
    [2, { url: "https://blog.hubspot.com/ai-crms", title: "The rise of generative AI CRMs", snippet: "Generative AI is changing sales software." }],
    [3, { url: "https://example.test/crm-roundup", title: "CRM roundup", snippet: "HubSpot costs $90; Salesforce Sales Cloud costs $175." }],
  ]);
  const table = (rows: string[]) =>
    parseVerifyTable(["| Item | Said (date) | Then → Now | Status | Evidence date | Source |", "|---|---|---|---|---|---|", ...rows, "", "Takeaway."].join("\n"))!;

  it("accepts a source whose URL, title or text names the vendor", () => {
    expect(sourceMismatches(table(["| Pipedrive Professional | 2026-11-09 | $49 → $49 | Unchanged | 2026-11-12 | [1] |"]), results)).toEqual([]);
    // Named only in the snippet (a roundup page) still counts.
    expect(sourceMismatches(table(["| HubSpot Sales Hub | 2026-11-09 | $90 → $90 | Unchanged | 2026-11-11 | [3] |"]), results)).toEqual([]);
  });

  it("flags another vendor's blog that never names the item (the A4 Pipedrive/HubSpot case)", () => {
    const bad = sourceMismatches(table(["| Pipedrive Professional | 2026-11-09 | $49 → $45 | Already outdated | 2026-11-09 | [2] |"]), results);
    expect(bad).toEqual([{ item: "Pipedrive Professional", n: 2, url: "https://blog.hubspot.com/ai-crms", vendor: "pipedrive" }]);
  });

  it("checks every cited number, and skips numbers that are not this turn's results", () => {
    const rows = table(["| Pipedrive Professional | 2026-11-09 | $49 → $49 | Unchanged | 2026-11-12 | [1][2][9] |"]);
    expect(sourceMismatches(rows, results).map((m) => m.n)).toEqual([2]);
  });
});

describe("sourceMentionsVendor: whole word, case-insensitive, strict for common-word vendors (D57)", () => {
  const r = (url: string, title: string, snippet = ""): ResultText => ({ url, title, snippet });

  it("is whole-word: Bun does not match bundle, bunny or bundler", () => {
    expect(sourceMentionsVendor("Bun", r("https://example.test/js", "A JavaScript bundle explained", "bundle your code with a bundler"))).toBe(false);
    expect(sourceMentionsVendor("Bun", r("https://bunny.net/pricing", "Bunny CDN"))).toBe(false);
    expect(sourceMentionsVendor("Bun latest stable", r("https://bun.sh/blog/bun-v1.3", "Bun v1.3"))).toBe(true);
  });

  it("is case-insensitive and ignores punctuation around the name", () => {
    expect(sourceMentionsVendor("HubSpot Sales Hub", r("https://example.test/a", "CRM roundup", "Pricing for HUBSPOT's Sales Hub"))).toBe(true);
    expect(sourceMentionsVendor("hubspot", r("https://HubSpot.com/pricing", "Pricing"))).toBe(true);
  });

  it("short or common-word vendors (Bun, Neon, Render) need the name in the URL or title, not just the body", () => {
    const bodyOnly = r("https://example.test/postgres-hosts", "Best Postgres hosts", "Neon, Supabase and Render compared. Render the page, bun bun.");
    for (const v of ["Neon", "Render", "Bun"]) expect(sourceMentionsVendor(v, bodyOnly)).toBe(false);
    expect(sourceMentionsVendor("Neon", r("https://neon.com/pricing", "Pricing"))).toBe(true); // URL
    expect(sourceMentionsVendor("Render", r("https://example.test/x", "Render Postgres pricing"))).toBe(true); // title
  });

  it("CRM vendors with ordinary English names (Close, Copper, Monday) need the name in the URL or title", () => {
    const body = r("https://example.test/crm-roundup", "CRM roundup", "Close the deal on Monday. Copper wiring is not a CRM. Close, Copper and Monday compared.");
    for (const v of ["Close", "Copper", "Monday"]) expect(sourceMentionsVendor(v, body)).toBe(false);
    expect(sourceMentionsVendor("Close Essentials plan", r("https://close.com/pricing", "Close CRM Pricing"))).toBe(true);
    expect(sourceMentionsVendor("Copper", r("https://copper.com/pricing", "Pricing"))).toBe(true);
    expect(sourceMentionsVendor("Monday", r("https://monday.com/pricing", "monday.com Pricing"))).toBe(true);
    expect(sourceMentionsVendor("Monday", r("https://example.test/a", "Weekly planning tips", "On Monday we shortlisted five tools."))).toBe(false);
  });

  it("a distinctive vendor name in the body text is enough", () => {
    expect(sourceMentionsVendor("Pipedrive", r("https://example.test/crm-roundup", "CRM roundup", "Pipedrive Professional is $49 per seat."))).toBe(true);
    expect(sourceMentionsVendor("Pipedrive", r("https://blog.hubspot.com/ai-crms", "Generative AI CRMs", "HubSpot adds AI agents."))).toBe(false);
  });

  it("Node.js finds nodejs.org (first and second word joined)", () => {
    expect(sourceMentionsVendor("Node.js latest stable", r("https://nodejs.org/en/about/previous-releases", "Releases"))).toBe(true);
    expect(sourceMentionsVendor("Node.js", r("https://example.test/a", "Gardening", "a node in a graph"))).toBe(false);
  });
});

describe("soft check: vendor page first (D58)", () => {
  const results = new Map<number, ResultText>([
    [1, { url: "https://neon.com/pricing", title: "Neon Pricing", snippet: "Launch plan: $19/month" }],
    [2, { url: "https://dbnews.test/prices", title: "Neon price check", snippet: "Neon Launch is still $19 per month." }],
    [3, { url: "https://neon.com/blog/culture", title: "Neon culture", snippet: "How we work." }],
  ]);
  const table = (src: string) =>
    parseVerifyTable(["| Item | Said (date) | Then → Now | Status | Evidence date | Source |", "|---|---|---|---|---|---|", `| Neon Launch | 2026-11-03 | $19 → $19 | Unchanged | 2026-11-10 | ${src} |`, "", "ok"].join("\n"))!;

  it("passes when the vendor page that states the price is cited first, even with a third-party page after it", () => {
    expect(vendorPageFirstProblems(table("[1][2]"), results)).toEqual([]);
  });

  it("flags a third-party page cited before the vendor's price page", () => {
    expect(vendorPageFirstProblems(table("[2][1]"), results)).toEqual([{ item: "Neon Launch", firstCited: 2, vendorPage: 1 }]);
  });

  it("does not apply when no vendor page states a price (missing or unclear): third-party first is fine", () => {
    const noPrice = new Map([[2, results.get(2) as ResultText], [3, results.get(3) as ResultText]]);
    expect(vendorPageFirstProblems(table("[2]"), noPrice)).toEqual([]);
  });

  it("ignores rows with no usable citation", () => {
    expect(vendorPageFirstProblems(table("—"), results)).toEqual([]);
    expect(vendorPageFirstProblems(table("[9]"), results)).toEqual([]);
  });

  it("hostIsVendor looks at the host only, whole word", () => {
    expect(hostIsVendor("HubSpot Sales Hub", "https://blog.hubspot.com/x")).toBe(true);
    expect(hostIsVendor("HubSpot", "https://saasweekly.test/hubspot-recap")).toBe(false); // name in the path, not the host
    expect(hostIsVendor("Bun", "https://bundlephobia.com/")).toBe(false);
  });
});

describe("soft check: 'shipped' vs 'reported' (D58)", () => {
  const results = new Map<number, ResultText>([
    [1, { url: "https://www.hubspot.com/company-news/ai-agents", title: "HubSpot announces AI agents", snippet: "" }],
    [2, { url: "https://saasweekly.test/recap", title: "This week in sales software", snippet: "HubSpot launched AI agents." }],
  ]);

  it("accepts 'shipped' with the vendor's own announcement, and 'reported' with a recap", () => {
    const ok = "Shipped since 2026-11-09:\n- HubSpot shipped AI agents, 2026-11-10 [1]\n- Zoho reported 2026-11-11 [2]";
    expect(shippedWordingProblems(ok, results)).toEqual([]);
    expect(shippedWordingProblems("Shipped since 2026-11-09:\n- HubSpot reported 2026-11-11 [2]", results)).toEqual([]);
  });

  it("flags 'shipped <date>' backed only by a recap or aggregator, or by nothing", () => {
    const bad = "Shipped since 2026-11-09:\n- HubSpot shipped AI agents 2026-11-11 [2]\n- Pipedrive shipped a thing 2026-11-10";
    expect(shippedWordingProblems(bad, results).map((p) => p.line.split(" ").slice(0, 3).join(" "))).toEqual(["- HubSpot shipped", "- Pipedrive shipped"]);
  });

  it("a vendor source on a different vendor does not count", () => {
    expect(shippedWordingProblems("Shipped since 2026-11-09:\n- Zoho shipped x 2026-11-10 [1]", results)).toHaveLength(1);
  });

  it("is silent without a section, with 'Nothing found', and past the end of the list", () => {
    expect(shippedWordingProblems("All unchanged.", results)).toEqual([]);
    expect(shippedWordingProblems("Shipped since 2026-11-09: Nothing found dated after 2026-11-09.", results)).toEqual([]);
    expect(shippedWordingProblems("Shipped since 2026-11-09:\n- HubSpot reported 2026-11-11 [2]\n\nZoho shipped plenty.", results)).toEqual([]);
  });
});

describe("soft check: status vs evidence label (D59)", () => {
  const res = (side: "before" | "same" | "after" | undefined, entity = "Bun"): ResultText => ({
    url: "https://bun.sh/blog/x",
    title: "Bun release",
    snippet: "",
    ...(side ? { label: { entity, side } } : {}),
  });
  const table = (status: string, src = "[1]") =>
    parseVerifyTable(["| Item | Said (date) | Then → Now | Status | Evidence date | Source |", "|---|---|---|---|---|---|", `| Bun latest stable | 2026-11-03 | 1.3 → 1.2.21 | ${status} | 2026-08-20 | ${src} |`, "", "ok"].join("\n"))!;
  const check = (status: string, side: "before" | "same" | "after" | undefined, src?: string) =>
    statusContradictions(table(status, src), new Map([[1, res(side)]]));

  it("Changed after / Differs now with a result labelled BEFORE the claim date is a contradiction", () => {
    expect(check("Changed after 2026-08-20", "before")).toEqual([{ item: "Bun latest stable", status: "changed", n: 1, label: "before" }]);
    expect(check("Differs now (timing unknown)", "before")).toEqual([{ item: "Bun latest stable", status: "differs", n: 1, label: "before" }]);
  });

  it("Already outdated with a result labelled AFTER or SAME DAY is a contradiction", () => {
    expect(check("Already outdated when asked", "after")).toEqual([{ item: "Bun latest stable", status: "outdated", n: 1, label: "after" }]);
    expect(check("Already outdated when asked", "same")).toEqual([{ item: "Bun latest stable", status: "outdated", n: 1, label: "same" }]);
  });

  it("agreeing combinations are fine", () => {
    expect(check("Already outdated when asked", "before")).toEqual([]);
    expect(check("Changed after 2026-11-10", "after")).toEqual([]);
    expect(check("Differs now (timing unknown)", "after")).toEqual([]);
    expect(check("Differs now (timing unknown)", "same")).toEqual([]); // same day: cannot be ordered, Differs is the right status
  });

  it("Unchanged and Couldn't verify are not judged, and an unlabelled result (undated) is not either", () => {
    expect(check("Unchanged", "before")).toEqual([]);
    expect(check("Couldn't verify", "before")).toEqual([]);
    expect(check("Already outdated when asked", undefined)).toEqual([]);
  });

  it("a label computed for another vendor's claim does not count, and each cited result is checked", () => {
    expect(statusContradictions(table("Differs now"), new Map([[1, res("before", "Neon")]]))).toEqual([]);
    const two = new Map([[1, res("after")], [2, res("before")]]);
    expect(statusContradictions(table("Differs now", "[1][2]"), two).map((c) => c.n)).toEqual([2]);
  });
});


describe("D70: A4 checker fixes", () => {
  describe("datesIn: a word before the date cannot swallow the day number", () => {
    it.each([
      ["(reported 10 November 2026) [9]", ["2026-11-10"]],
      ["No shipments found dated after 9 November 2026.", ["2026-11-09"]],
      ["announced on 3rd Nov, 2026", ["2026-11-03"]],
      ["since 12 of March", ["2026-03-12"]],
      ["released November 12, 2026", ["2026-11-12"]],
      ["Sept. 5 2026", ["2026-09-05"]],
      ["Between 1 Nov and 9 Nov", ["2026-11-01", "2026-11-09"]],
      ["updated 2026-11-10 and reported 9 Nov 2026", ["2026-11-10", "2026-11-09"]],
    ])("%s", (line, expected) => {
      expect(datesIn(line, 2026).sort()).toEqual([...expected].sort());
    });
    it("ignores things that are not dates: other words, a bare year, a number after a month-like word", () => {
      expect(datesIn("the may change soon", 2026)).toEqual([]);
      expect(datesIn("version 2026 shipped", 2026)).toEqual([]);
      expect(datesIn("market 45 reported", 2026)).toEqual([]);
      expect(datesIn("10 Foobar 2026", 2026)).toEqual([]);
    });
  });

  describe("shippedProblems: negative lines are not items", () => {
    it.each([
      "Nothing found dated after 2026-11-09.",
      "- Pipedrive: No major feature shipments found dated after 9 November 2026.",
      "* Zoho CRM — none found",
      "1. Freshsales: Nothing announced since Monday.",
    ])("exempts %s", (line) => {
      expect(isNegativeLine(line)).toBe(true);
    });
    it("does not exempt a real item or a line that merely contains 'no'", () => {
      expect(isNegativeLine("- HubSpot: Added Agent Builder (reported 10 November 2026) [9].")).toBe(false);
      expect(isNegativeLine("- Salesforce: Notable price rise, no longer cheap.")).toBe(false);
    });
    it("the A4 answer: dated items are checked, per-vendor 'No … found' lines pass", () => {
      const answer = [
        "Shipped since 2026-11-09:",
        "- HubSpot Sales Hub: Added Agent Builder and credit-based AI pricing (reported 10 November 2026) [9].",
        "- Pipedrive: No major feature shipments found dated after 9 November 2026.",
        "- Zoho CRM: No major feature shipments found dated after 9 November 2026.",
      ].join("\n");
      expect(shippedProblems(answer, "2026-11-09")).toEqual([]);
    });
    it("a dated item on or before the since date is still a problem, and an undated item too", () => {
      const answer = ["Shipped since 2026-11-09:", "- HubSpot: Added Agent Builder (reported 7 November 2026) [9].", "- Zoho CRM: Launched a new plan [4]."].join("\n");
      expect(shippedProblems(answer, "2026-11-09").map((p) => p.reason)).toEqual(["not-after-since", "undated"]);
    });
  });

  describe("source mismatch: product-to-company aliases", () => {
    const freshworks: ResultText = { url: "https://www.freshworks.com/crm/pricing-compare/", title: "Compare plans", snippet: "Growth $9 per user" };
    const rows = (item: string) =>
      parseVerifyTable(["| Item | Said (date) | Then → Now | Status | Evidence date | Source |", "|---|---|---|---|---|---|", `| ${item} | 2026-11-09 | $39 → $39 | Unchanged | undated | [5] |`, "", "Takeaway."].join("\n"))!;
    it("Freshsales is backed by freshworks.com, but not by an unrelated vendor's page", () => {
      expect(sourceMismatches(rows("Freshsales"), new Map([[5, freshworks]]))).toEqual([]);
      expect(sourceMentionsVendor("Freshsales Pro", freshworks)).toBe(true);
      expect(hostIsVendor("Freshsales", freshworks.url)).toBe(true);
      const hubspot: ResultText = { url: "https://blog.hubspot.com/ai", title: "AI CRMs", snippet: "generative AI" };
      expect(sourceMismatches(rows("Freshsales"), new Map([[5, hubspot]]))).toHaveLength(1);
    });
    it("the other demo-seed tools match their own sites and not each other's", () => {
      const own: Array<[string, string]> = [
        ["HubSpot Sales Hub", "https://www.hubspot.com/pricing/sales"],
        ["Pipedrive", "https://www.pipedrive.com/en/pricing"],
        ["Salesforce Sales Cloud", "https://www.salesforce.com/sales/pricing/"],
        ["Zoho CRM", "https://www.zoho.com/crm/pricing/"],
      ];
      for (const [item, url] of own) {
        expect(sourceMentionsVendor(item, { url, title: "Pricing", snippet: "" }), item).toBe(true);
        expect(sourceMentionsVendor(item, { url: "https://example.test/other", title: "Other", snippet: "nothing relevant" }), item).toBe(false);
      }
    });
  });
});

describe("D71: status wording soft checks", () => {
  const head = ["| Item | Said (date) | Then → Now | Status | Evidence date | Source |", "|---|---|---|---|---|---|"];
  const table = (...rows: string[]) => parseVerifyTable([...head, ...rows, "", "Takeaway."].join("\n"))!;
  const page = (url: string, title = "Page"): ResultText => ({ url, title, snippet: "" });

  describe("verifyStatusContradiction: Changed after resting only on a vendor's pricing or product page", () => {
    const row = (src: string) => table(`| Supabase Pro | 2026-11-03 | $25 → $29 | Changed after 2026-11-03 | 2026-11-11 | ${src} |`);
    it("fires for the A13 case: only supabase.com/pricing is cited", () => {
      const out = statusContradictions(row("Supabase Pricing [1]"), new Map([[1, page("https://supabase.com/pricing", "Supabase Pricing")]]));
      expect(out).toEqual([{ item: "Supabase Pro", status: "changed", n: 1, reason: "vendor-pricing-page-only", url: "https://supabase.com/pricing" }]);
    });
    it.each(["https://supabase.com/pricing", "https://www.supabase.com/plans", "https://supabase.com/product/database", "https://supabase.com/pricing/compare"])(
      "a vendor page at %s counts",
      (url) => {
        expect(isVendorPricingPage("Supabase Pro", url)).toBe(true);
      },
    );
    it("does not fire when a dated announcement, a changelog or a third-party page is also cited", () => {
      const results = new Map([
        [1, page("https://supabase.com/pricing")],
        [2, page("https://supabase.com/changelog", "Supabase changelog")],
        [3, page("https://news.example.test/supabase-raises-prices")],
      ]);
      expect(statusContradictions(row("[1][2]"), results)).toEqual([]);
      expect(statusContradictions(row("[1][3]"), results)).toEqual([]);
      expect(statusContradictions(row("[2]"), results)).toEqual([]);
    });
    it("is not a pricing page: another vendor's /pricing, a blog post about pricing, a row that cites nothing returned", () => {
      expect(isVendorPricingPage("Supabase Pro", "https://neon.com/pricing")).toBe(false);
      expect(isVendorPricingPage("Supabase Pro", "https://supabase.com/blog/new-pricing")).toBe(false);
      expect(isVendorPricingPage("Supabase Pro", "https://blog.hubspot.com/sales/hubspot-sales-hub-pricing")).toBe(false);
      expect(statusContradictions(row("[7]"), new Map([[1, page("https://supabase.com/pricing")]]))).toEqual([]);
    });
    it("Differs now on the same page is the right status and is not flagged", () => {
      const t = table("| Supabase Pro | 2026-11-03 | $25 → $29 | Differs now (timing unknown) | 2026-11-11 | [1] |");
      expect(statusContradictions(t, new Map([[1, page("https://supabase.com/pricing")]]))).toEqual([]);
    });
  });

  describe("verifyNowValueOnUnverified", () => {
    it("fires when a Couldn't verify row repeats the old value (or any value) as Now, A13's Neon row", () => {
      const t = table(
        "| Neon | 2026-11-03 | $19/mo → $19/mo | Couldn't verify | — | [not found] |",
        "| Render | 2026-11-03 | $6 → ? | Couldn't verify | — | — |",
        "| Supabase | 2026-11-03 | $25 → $29 | Differs now (timing unknown) | 2026-11-11 | [1] |",
      );
      expect(nowValueOnUnverified(t)).toEqual([
        { item: "Neon", now: "$19/mo" },
        { item: "Render", now: "?" },
      ]);
    });
    it("passes with — (a hyphen or en dash counts), and ignores other statuses", () => {
      expect(nowValueOnUnverified(table("| Neon | 2026-11-03 | $19 → — | Couldn't verify | — | — |"))).toEqual([]);
      expect(nowValueOnUnverified(table("| Neon | 2026-11-03 | $19 → – | Couldn't verify | — | — |"))).toEqual([]);
      expect(nowValueOnUnverified(table("| Neon | 2026-11-03 | $19 → - | Couldn't verify | — | — |"))).toEqual([]);
      expect(nowValueOnUnverified(table("| Neon | 2026-11-03 | $19 → $19 | Unchanged | 2026-11-11 | [1] |"))).toEqual([]);
    });
    it("a table without a Then → Now column has nothing to check", () => {
      const t = parseVerifyTable(["| Item | Status |", "|---|---|", "| Neon | Couldn't verify |", "", "x"].join("\n"))!;
      expect(nowValueOnUnverified(t)).toEqual([]);
    });
  });
});

describe("shippedProblems strips markdown emphasis first (D74)", () => {
  it("a bold header no longer leaves a '**' line (the demo turn)", () => {
    const answer = ["**Shipped since 2026-11-03:**", "- Supabase Expo CLI integration (`eas integrations:supabase:connect`): shipped 2026-11-10 [3]."].join("\n");
    expect(shippedProblems(answer, "2026-11-03")).toEqual([]);
  });
  it("still finds a real problem under a bold header", () => {
    const answer = ["**Shipped since 2026-11-03:**", "- *Supabase* launch (reported 1 Nov 2026) [3]"].join("\n");
    expect(shippedProblems(answer, "2026-11-03")).toEqual([{ line: "- Supabase launch (reported 1 Nov 2026) [3]", reason: "not-after-since" }]);
  });
  it("stripEmphasis removes bold, italics and code ticks but keeps bullets and plain asterisks", () => {
    expect(stripEmphasis("**a** *b* `c` __d__")).toBe("a b c d");
    expect(stripEmphasis("* item one\n* item two")).toBe("* item one\n* item two");
    expect(stripEmphasis("5 * 3 = 15")).toBe("5 * 3 = 15");
  });
});
