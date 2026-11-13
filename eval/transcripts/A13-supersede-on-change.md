# A13-supersede-on-change

- Category: memory-write
- Clock: 2026-11-12T11:00:00+05:30 (Asia/Kolkata) · seed: yes
- Search: mock
- Models: google · main `gemini-3.5-flash-lite` · small `gemini-3.5-flash-lite` · thinking tool low / answer low
- Ran: 2026-11-13 09:50 UTC
- Pass: 1/1

**Rubric:** Says Supabase Pro is $29 now versus $25 said on 3 Nov, with a citation. The only evidence is a pricing page (dated 11 Nov), which does not date the change, so the status is 'Differs now (timing unknown)', not 'Changed after'. The ledger keeps both values with dates. The fixture has a page for Supabase only (on purpose: a regression test for an evidence gap). Neon and Render have no evidence, so they must be 'Couldn't verify' with no invented values, and the turn must still end with a model-written answer.

## Run 1 — PASS

**User:** Last Tuesday I asked you about Postgres hosting. Has Supabase's price changed?

Searches: `site:neon.com/pricing pricing Launch plan`, `site:supabase.com/pricing Pro plan price`, `site:render.com/pricing Postgres Basic-256mb`, `Neon cheapest paid plan price`, `Render cheapest paid Postgres plan`

**Assistant** (complete, first token 7.7 s, total 8.0 s):

> | Item | Said (date) | Then → Now | Status | Evidence date | Source |
> | --- | --- | --- | --- | --- | --- |
> | Neon | Launch plan, $19/month (3 Nov) | $19 → — | Couldn't verify | — | — |
> | Supabase | Pro plan, $25/month (3 Nov) | $25 → $29 | Differs now (timing unknown) | 11 Nov 2026 | [1] |
> | Render | Basic-256mb, $6/month (3 Nov) | $6 → — | Couldn't verifying | — | — |
> 
> As of 12 November 2026, Supabase differs now: $25 → $29. Neon and Render couldn't be verified.

Sources returned:
- [1] Supabase Pricing — https://supabase.com/pricing — 2026-11-11

Steps:
- step 1 (force): model 4032 ms, search 0 ms, finish tool-calls, text 0 chars
  - forced: toolChoice tool:web_search, tools [web_search] → finish tool-calls, text 0 chars, tool calls: web_search({"queries":["site:neon.com/pricing pricing Launch plan","site:supabase.com/pricing Pro plan price","site:render.com/pricing Postgres Basic-256mb"]})
- step 2 (none): model 3986 ms, search 0 ms, finish stop, text 468 chars
  - closed: toolChoice none, tools none → finish stop, text 468 chars

Checks:
- ✓ answerComplete
- ✓ searched
- ✓ cited
- ✓ mustMention "$25"
- ✓ mustMention "$29"
- ✓ mustMention "Couldn't verify"
- ✓ mustNotMention "Changed after"
- ✓ recallRulesInclude
- ✓ verifyTable
- ✓ takeawayMatchesTable
- ✓ claimState.currentValueContains
- ✓ claimState.supersededValueContains
- ✓ claimState.supersededAtLocalDate
- ✓ claimState.historyLength
- ✓ (soft) vendorPageFirst
- ✓ (soft) noRawLinks
- ✓ (soft) nowValueOnUnverified
- ✓ (soft) statusMatchesEvidenceLabel

Judge: 5/5 — The answer correctly evaluates Supabase as 'Differs now (timing unknown)' using the 11 Nov source, marks Neon and Render as couldn't verify with no invented values, includes the ledger, and has the correct model-written conclusion. [1.4 s]
