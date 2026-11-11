import { describe, expect, it } from "vitest";
import { runAgent } from "../src/agent/index";
import { getTrace } from "../src/db/memoryRepo";
import { listMessages } from "../src/db/repo";
import { buildDebug } from "../src/server/memoryRoutes";
import { loadCases } from "../eval/cases";
import { runChecks } from "../eval/checks";
import { emptyExtraction, objectModel, scriptedModel } from "./helpers/mockModel";
import { fixedSearch } from "./helpers/search";
import { IST, SEED_NOW, seededDb } from "./helpers/seed";

// D71 end to end: the A13 live answer ("Changed after" on a vendor pricing page, "$19 → $19" next to Couldn't verify)
// is recorded in the trace and the debug payload, and the answer is stored exactly as the model wrote it.

const TID = "88888888-8888-4888-8888-888888888888";
const VERIFY = "Last Tuesday I asked you about Postgres hosting. Has Supabase's price changed?";
const PAGE = { title: "Supabase Pricing", url: "https://supabase.com/pricing", publishedDate: "2026-11-11", snippet: "Pro plan: $29/month per organization." };
const HEAD = "| Item | Said (date) | Then → Now | Status | Evidence date | Source |\n|---|---|---|---|---|---|\n";

async function ask(answer: string) {
  const db = seededDb();
  const main = scriptedModel([{ toolCall: { name: "web_search", input: { queries: ["Supabase pricing"] } } }, { text: answer }]);
  const run = await runAgent(
    { db, models: { main, small: objectModel(emptyExtraction) }, now: () => SEED_NOW, search: fixedSearch([PAGE]), maxSteps: 4 },
    { threadId: TID, message: VERIFY, tz: IST },
  );
  const reader = run.stream.getReader();
  while (!(await reader.read()).done);
  await run.done;
  const trace = getTrace(db, run.assistantMessageId)!;
  return { db, trace, text: listMessages(db, TID).at(-1)?.text, errors: JSON.parse(trace.errors_json ?? "[]") as Array<Record<string, unknown>> };
}

const BAD =
  `${HEAD}| Neon | 2026-11-03 | $19/mo → $19/mo | Couldn't verify | — | [not found] |\n` +
  `| Supabase | 2026-11-03 | $25/mo → $29/mo | Changed after 2026-11-03 | 2026-11-11 | Supabase Pricing [1] |\n` +
  `| Render | 2026-11-03 | $6/mo → $6/mo | Couldn't verify | — | [not found] |\n\n` +
  `As of 12 November 2026, Supabase changed after 2026-11-03 ($25/mo → $29/mo [1]). Neon and Render couldn't be verified.`;

const GOOD =
  `${HEAD}| Neon | 2026-11-03 | $19/mo → — | Couldn't verify | — | — |\n` +
  `| Supabase | 2026-11-03 | $25/mo → $29/mo | Differs now (timing unknown) | 2026-11-11 | Supabase Pricing [1] |\n` +
  `| Render | 2026-11-03 | $6/mo → — | Couldn't verify | — | — |\n\n` +
  `As of 12 November 2026, Supabase differs now ($25/mo → $29/mo [1]). Neon and Render couldn't be verified.`;

describe("D71 soft checks in the trace", () => {
  it("records both problems, never rewrites the answer, and the drawer payload carries them", async () => {
    const { text, errors, db, trace } = await ask(BAD);
    expect(text).toBe(BAD);
    expect(errors.find((e) => "verifyStatusContradiction" in e)).toMatchObject({
      verifyStatusContradiction: [{ item: "Supabase", status: "changed", reason: "vendor-pricing-page-only", url: "https://supabase.com/pricing" }],
    });
    expect(errors.find((e) => "verifyNowValueOnUnverified" in e)).toMatchObject({
      verifyNowValueOnUnverified: [{ item: "Neon", now: "$19/mo" }, { item: "Render", now: "$6/mo" }],
    });
    expect(JSON.stringify(buildDebug(db, trace).errors)).toContain("verifyNowValueOnUnverified");
  });

  it("the corrected wording records neither", async () => {
    const { errors } = await ask(GOOD);
    expect(errors.some((e) => "verifyStatusContradiction" in e)).toBe(false);
    expect(errors.some((e) => "verifyNowValueOnUnverified" in e)).toBe(false);
  });
});

describe("eval A13: both are soft, 'Changed after' stays the hard check", () => {
  const a13 = loadCases().find((c) => c.id.startsWith("A13-"))!;
  it("the case lists both soft checks and keeps mustNotMention 'Changed after'", () => {
    expect(a13.softChecks).toMatchObject({ statusMatchesEvidenceLabel: true, nowValueOnUnverified: true });
    expect(a13.checks.mustNotMention).toContain("Changed after");
  });
  it("a bad answer fails the hard check and shows both soft warnings, a good one has none", () => {
    const obs = (answer: string, errorKeys: string[]) => ({
      turns: [{ answer, status: "complete", searchCalls: 1, sourceNumbers: [1] }],
      tz: IST,
      trace: { resolvedDates: ["2026-11-03"], recallRules: ["R0", "R1", "R3"], injectedMemory: 3, errorKeys },
      claims: [],
      writes: [],
    });
    const bad = runChecks(a13, obs(BAD, ["verifyStatusContradiction", "verifyNowValueOnUnverified"]));
    expect(bad.hard.find((h) => h.name === 'mustNotMention "Changed after"')?.pass).toBe(false);
    expect(bad.soft.filter((s) => !s.pass).map((s) => s.name).sort()).toEqual(["nowValueOnUnverified", "statusMatchesEvidenceLabel"]);
    const good = runChecks(a13, obs(GOOD, []));
    expect(good.hard.find((h) => h.name === 'mustNotMention "Changed after"')?.pass).toBe(true);
    expect(good.soft.every((s) => s.pass)).toBe(true);
  });
});
