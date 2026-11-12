import { describe, expect, it } from "vitest";
import { collectiveTakeaway, nowValue, parseStatus, parseVerifyTable, statusByClaim, takeawayGaps } from "../src/memory/verifyTable";

const A2 = `On 3 Nov you asked about Postgres hosting and Bun.

| Item | Said (date) | Then → Now | Status | Evidence date | Source |
|---|---|---|---|---|---|
| Neon cheapest paid plan | 2026-11-03 | Launch $19/month → Pay-as-you-go ($0.106/CU-hr) | Differs now (timing unknown) | 2026-11-04 | [1] |
| **Supabase** Pro | 2026-11-03 | $25 → $25 | **✅ Unchanged** | 2026-11-11 | [2] |
| Render Basic-256mb | 2026-11-03 | $6 → $6 | Unchanged | 2026-11-10 | [3] |
| Bun latest stable | 2026-11-03 | 1.3 → 1.2.21 | Already outdated when asked | 2026-08-20 | [4] |
| Fly.io | 2026-11-03 | $5 → ? | Couldn't verify | — | — |

As of 12 Nov 2026: Neon's pricing differs now and Bun was already outdated when you asked.`;

describe("parseVerifyTable", () => {
  it("reads item, status and [n] sources, and the text after the table", () => {
    const t = parseVerifyTable(A2);
    // Item, status and sources are what the ledger reads; `now` is the Then → Now cell's Now value (D71).
    expect(t?.rows.map(({ item, status, sources }) => ({ item, status, sources }))).toEqual([
      { item: "Neon cheapest paid plan", status: "differs", sources: [1] },
      { item: "Supabase Pro", status: "unchanged", sources: [2] },
      { item: "Render Basic-256mb", status: "unchanged", sources: [3] },
      { item: "Bun latest stable", status: "outdated", sources: [4] },
      { item: "Fly.io", status: "unverified", sources: [] },
    ]);
    expect(t?.rows.every((r) => typeof r.now === "string")).toBe(true);
    expect(t?.after).toContain("As of 12 Nov 2026");
  });

  it("returns undefined when there is no table with a Status column", () => {
    expect(parseVerifyTable("Neon is still $19/month [1].")).toBeUndefined();
    expect(parseVerifyTable("| a | b |\n|---|---|\n| 1 | 2 |")).toBeUndefined();
  });

  it.each([
    ["Unchanged", "unchanged"],
    ["Differs now (timing unknown)", "differs"],
    ["Changed after 2026-11-05", "changed"],
    ["Already outdated when asked", "outdated"],
    ["Couldn't verify", "unverified"],
    ["Couldn’t verify", "unverified"],
    ["⚠️ _could not verify_", "unverified"],
  ])("parseStatus(%s)", (cell, status) => {
    expect(parseStatus(cell)).toBe(status);
  });

  it("an unknown status cell is skipped, not guessed", () => {
    expect(parseStatus("Probably fine")).toBeUndefined();
  });
});

describe("statusByClaim", () => {
  it("maps claims to rows by entity, preferring the row that shares attribute words", () => {
    const t = parseVerifyTable(`| Item | Status | Source |
|---|---|---|
| HubSpot Starter | Unchanged | [1] |
| HubSpot Professional | Differs now (timing unknown) | [2] |
| Pipedrive | Couldn't verify | |`);
    if (!t) throw new Error("table expected");
    const map = statusByClaim(t, [
      { id: "h1", entity: "HubSpot Sales Hub", attribute: "Professional price per seat per month (annual)" },
      { id: "h2", entity: "HubSpot Sales Hub", attribute: "Starter price" },
      { id: "p", entity: "Pipedrive", attribute: "Advanced price" },
      { id: "z", entity: "Zoho CRM", attribute: "price" },
    ]);
    expect(map.get("h1")?.status).toBe("differs");
    expect(map.get("h2")?.status).toBe("unchanged");
    expect(map.get("p")?.status).toBe("unverified");
    expect(map.has("z")).toBe(false);
  });
});

describe("takeawayGaps", () => {
  it("names non-Unchanged rows the closing text never mentions", () => {
    const t = parseVerifyTable(`| Item | Status | Source |
|---|---|---|
| Salesforce Enterprise | Differs now (timing unknown) | [3] |
| HubSpot Professional | Unchanged | [1] |

None of the five tools changed pricing.`);
    if (!t) throw new Error("table expected");
    expect(takeawayGaps(t)).toEqual(["Salesforce Enterprise"]);
  });

  it("a Couldn't-verify row must be named too; named rows are not gaps", () => {
    const t = parseVerifyTable(A2);
    if (!t) throw new Error("table expected");
    expect(takeawayGaps(t)).toEqual(["Fly.io"]); // Couldn't verify counts too: it is not Unchanged
  });
});

describe("Then → Now column (D71)", () => {
  it.each([
    ["$19/mo → $25/mo", "$25/mo"],
    ["$19 → —", "—"],
    ["**$19** -> **$19**", "$19"],
    ["$19 → $19 → $29", "$29"],
    ["—", "—"],
    ["$19", "$19"],
    ["", ""],
  ])("nowValue(%s) = %s", (cell, expected) => {
    expect(nowValue(cell)).toBe(expected);
  });

  it("each row carries its Now value; a table without the column has none", () => {
    const t = parseVerifyTable(
      ["| Item | Said (date) | Then → Now | Status | Evidence date | Source |", "|---|---|---|---|---|---|", "| Neon | 2026-11-03 | $19 → — | Couldn't verify | — | — |", "| Supabase | 2026-11-03 | $25 → $29 | Differs now (timing unknown) | 2026-11-11 | [1] |", "", "x"].join("\n"),
    )!;
    expect(t.rows.map((r) => r.now)).toEqual(["—", "$29"]);
    const bare = parseVerifyTable(["| Item | Status |", "|---|---|", "| Neon | Unchanged |", "", "x"].join("\n"))!;
    expect(bare.rows[0]).not.toHaveProperty("now");
  });
});

describe("takeawayGaps: a collective takeaway (D74, A18)", () => {
  const HEAD = ["| Item | Said (date) | Then → Now | Status | Evidence date | Source |", "|---|---|---|---|---|---|"];
  const t = (rows: string[], after: string) => parseVerifyTable([...HEAD, ...rows, "", after].join("\n"))!;
  const ALL_UNVERIFIED = ["HubSpot", "Pipedrive", "Salesforce", "Zoho", "Freshsales"].map((v) => `| ${v} | 2026-11-09 | $1 → — | Couldn't verify | — | — |`);

  it.each([
    "As of 12 November 2026, all items couldn't verify due to a lack of current pricing evidence.",
    "None of them could be verified as of 12 Nov.",
    "Every price could not be verified today.",
    "As of 12 Nov: all five are unverified.",
  ])("accepts: %s", (after) => {
    expect(collectiveTakeaway(t(ALL_UNVERIFIED, after))).toBe(true);
    expect(takeawayGaps(t(ALL_UNVERIFIED, after))).toEqual([]);
  });

  it("the collective word and the status must be in the same sentence, and the status must be the rows' status", () => {
    expect(takeawayGaps(t(ALL_UNVERIFIED, "All prices checked. Some couldn't be verified."))).toHaveLength(5);
    expect(takeawayGaps(t(ALL_UNVERIFIED, "All items differ now."))).toHaveLength(5);
    expect(takeawayGaps(t(ALL_UNVERIFIED, "Nothing to report."))).toHaveLength(5);
  });

  it("stays strict for mixed statuses: each non-Unchanged row must be named", () => {
    const mixed = t(
      ["| Neon | 2026-11-03 | $19 → — | Couldn't verify | — | — |", "| Supabase | 2026-11-03 | $25 → $29 | Differs now (timing unknown) | 2026-11-11 | [1] |"],
      "All items couldn't verify or differ now.",
    );
    expect(collectiveTakeaway(mixed)).toBe(false);
    expect(takeawayGaps(mixed)).toEqual(["Neon", "Supabase"]);
  });

  it("Unchanged rows don't count against a collective line", () => {
    const tbl = t(["| Neon | 2026-11-03 | $19 → $19 | Unchanged | 2026-11-11 | [1] |", ...ALL_UNVERIFIED.slice(0, 2)], "All the others couldn't be verified.");
    expect(takeawayGaps(tbl)).toEqual([]);
  });
});
