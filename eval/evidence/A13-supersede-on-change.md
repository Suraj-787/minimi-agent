# A13-supersede-on-change

- Category: memory-write
- Clock: 2026-11-12T11:00:00+05:30 (Asia/Kolkata) · seed: yes
- Search: mock
- Models: google · main `gemini-3.5-flash-lite` · small `gemini-3.5-flash-lite` · thinking tool low / answer low
- Ran: 2026-11-12 16:04 UTC
- Pass: 0/3

**Rubric:** Says Supabase Pro is $29 now versus $25 said on 3 Nov, with a citation. The only evidence is a pricing page (dated 11 Nov), which does not date the change, so the status is 'Differs now (timing unknown)', not 'Changed after'. The ledger keeps both values with dates. The fixture has a page for Supabase only (on purpose: a regression test for an evidence gap). Neon and Render have no evidence, so they must be 'Couldn't verify' with no invented values, and the turn must still end with a model-written answer.

## Run 1, attempt 1 (discarded, provider error) — FAIL

Infrastructure: memory write failed (TimeoutError)

**User:** Last Tuesday I asked you about Postgres hosting. Has Supabase's price changed?

Searches: `neon pricing paid plan price 2026`, `supabase pricing pro plan price 2026`, `render postgres pricing basic plan price 2026`, `Neon cheapest paid plan price`, `Render cheapest paid Postgres plan`

**Assistant** (complete, first token 3.4 s, total 3.8 s):

> Neon ($19/month) and Render ($6/month) pricing needs verification since searches were limited to Supabase, but Supabase's Pro plan has changed. As of 12 November 2026:
> 
> | Item | Said (date) | Then → Now | Status | Evidence date | Source |
> | --- | --- | --- | --- | --- | --- |
> | Neon | 3 Nov 2026 | $19/month → — | Couldn't verify | — | — |
> | Supabase | 3 Nov 2026 | $25/month → $29/month | Changed after 2026-11-03 | 2026-11-11 | [1] |
> | Render | 3 Nov 2026 | $6/month → — | Couldn't verify | — | — |
> 
> Supabase changed after 3 Nov: Pro plan $25 → $29/month [1].

Sources returned:
- [1] Supabase Pricing — https://supabase.com/pricing — 2026-11-11

Steps:
- step 1 (force): model 1880 ms, search 0 ms, finish tool-calls, text 0 chars
  - forced: toolChoice tool:web_search, tools [web_search] → finish tool-calls, text 0 chars, tool calls: web_search({"fresh":true,"queries":["neon pricing paid plan price 2026","supabase pricing pro plan price 2026","render postgres pricing basic plan price 2026"],"domains":["neon.com","supabase.com","render.com"]})
- step 2 (none): model 1884 ms, search 0 ms, finish stop, text 562 chars
  - closed: toolChoice none, tools none → finish stop, text 562 chars

Checks:
- ✓ answerComplete
- ✓ searched
- ✓ cited
- ✓ mustMention "$25"
- ✓ mustMention "$29"
- ✓ mustMention "Couldn't verify"
- ✗ mustNotMention "Changed after": present in the answer
- ✓ recallRulesInclude
- ✓ verifyTable
- ✗ takeawayMatchesTable: trace has a verifyTakeawayMissing entry
- ✗ claimState.currentValueContains: no current Supabase claim contains "$29" (current: Pro plan, $25/month)
- ✗ claimState.supersededValueContains: no superseded Supabase claim contains "$25"
- ✗ claimState.supersededAtLocalDate: superseded on never, expected 2026-11-12
- ✗ claimState.historyLength: chain has 1 rows, expected 2
- ✓ (soft) vendorPageFirst
- ✓ (soft) noRawLinks
- ✓ (soft) nowValueOnUnverified
- ✗ (soft) statusMatchesEvidenceLabel: trace has a verifyStatusContradiction entry

Judge: 2/5 — The answer used 'Changed after' instead of the required 'Differs now (timing unknown)' status for Supabase, failing the strict status requirement from the rubric.

## Run 1, attempt 2 (rerun after provider error) — FAIL

**User:** Last Tuesday I asked you about Postgres hosting. Has Supabase's price changed?

Searches: `neon pricing plan`, `supabase pricing pro plan`, `render postgres pricing basic`, `Neon cheapest paid plan price`, `Render cheapest paid Postgres plan`

**Assistant** (complete, first token 16.7 s, total 17.3 s):

> | Item | Said (date) | Then → Now | Status | Evidence date | Source |
> | --- | --- | --- | --- | --- | --- |
> | Neon | 2026-11-03 | $19/month → — | Couldn't verify | — | — |
> | Supabase | 2026-11-03 | $25/month → $29/month | Changed after 2026-11-03 | 2026-11-11 | [1] |
> | Render | 2026-11-03 | $6/month → — | Couldn't verify | — | — |
> 
> As of 12 November 2026, Supabase changed: $25/month → $29/month [1].

Sources returned:
- [1] Supabase Pricing — https://supabase.com/pricing — 2026-11-11

Steps:
- step 1 (force): model 8741 ms, search 1 ms, finish tool-calls, text 0 chars
  - forced: toolChoice tool:web_search, tools [web_search] → finish tool-calls, text 0 chars, tool calls: web_search({"queries":["neon pricing plan","supabase pricing pro plan","render postgres pricing basic"],"fresh":true,"domains":["neon.com","supabase.com","render.com"]})
- step 2 (none): model 8453 ms, search 0 ms, finish stop, text 402 chars
  - closed: toolChoice none, tools none → finish stop, text 402 chars

Checks:
- ✓ answerComplete
- ✓ searched
- ✓ cited
- ✓ mustMention "$25"
- ✓ mustMention "$29"
- ✓ mustMention "Couldn't verify"
- ✗ mustNotMention "Changed after": present in the answer
- ✓ recallRulesInclude
- ✓ verifyTable
- ✗ takeawayMatchesTable: trace has a verifyTakeawayMissing entry
- ✓ claimState.currentValueContains
- ✓ claimState.supersededValueContains
- ✓ claimState.supersededAtLocalDate
- ✓ claimState.historyLength
- ✓ (soft) vendorPageFirst
- ✓ (soft) noRawLinks
- ✓ (soft) nowValueOnUnverified
- ✗ (soft) statusMatchesEvidenceLabel: trace has a verifyStatusContradiction entry

Judge: 3/5 — The assistant correctly identified the price change for Supabase from $25 to $29 with a citation, but incorrectly marked the status as 'Changed after' rather than 'Differs now (timing unknown)' given the evidence date.

## Run 2 — FAIL

**User:** Last Tuesday I asked you about Postgres hosting. Has Supabase's price changed?

Searches: `neon pricing plans 2026`, `supabase pricing plans 2026`, `render postgres pricing plans 2026`, `Neon cheapest paid plan price`, `Render cheapest paid Postgres plan`

**Assistant** (complete, first token 176.2 s, total 178.3 s):

> | Item | Said (date) | Then → Now | Status | Evidence date | Source |
> | --- | --- | --- | --- | --- | --- |
> | Neon | 2026-11-03 | $19/mo → — | Couldn't verify | — | — |
> | Supabase | 2026-11-03 | $25/mo → $29/mo | Changed after 2026-11-03 | 2026-11-11 | [1] |
> | Render | 2026-11-03 | $6/mo → — | Couldn't verify | — | — |
> 
> As of 12 November 2026, Supabase changed: $25/mo → $29/mo [1].

Sources returned:
- [1] Supabase Pricing — https://supabase.com/pricing — 2026-11-11

Steps:
- step 1 (force): model 10362 ms, search 1 ms, finish tool-calls, text 0 chars
  - forced: toolChoice tool:web_search, tools [web_search] → finish tool-calls, text 0 chars, tool calls: web_search({"queries":["neon pricing plans 2026","supabase pricing plans 2026","render postgres pricing plans 2026"],"domains":["neon.com","supabase.com","render.com"],"fresh":true})
- step 2 (none): model 167933 ms, search 0 ms, finish stop, text 384 chars
  - closed: toolChoice none, tools none → finish error, text 0 chars
  - closed-retry: toolChoice none, tools none → finish stop, text 384 chars

Checks:
- ✓ answerComplete
- ✓ searched
- ✓ cited
- ✓ mustMention "$25"
- ✓ mustMention "$29"
- ✓ mustMention "Couldn't verify"
- ✗ mustNotMention "Changed after": present in the answer
- ✓ recallRulesInclude
- ✓ verifyTable
- ✗ takeawayMatchesTable: trace has a verifyTakeawayMissing entry
- ✓ claimState.currentValueContains
- ✓ claimState.supersededValueContains
- ✓ claimState.supersededAtLocalDate
- ✓ claimState.historyLength
- ✓ (soft) vendorPageFirst
- ✓ (soft) noRawLinks
- ✓ (soft) nowValueOnUnverified
- ✗ (soft) statusMatchesEvidenceLabel: trace has a verifyStatusContradiction entry

Judge: 3/5 — The answer correctly identified the price change for Supabase from $25 to $29 with a citation, but incorrectly listed the status as 'Changed after 2026-11-03' when the rubric requires 'Differs now (timing unknown)' since the evidence date does not confirm when the change occurred.

## Run 3 — FAIL

**User:** Last Tuesday I asked you about Postgres hosting. Has Supabase's price changed?

Searches: `Neon pricing 2026`, `Supabase pricing 2026`, `Render postgres pricing 2026`, `Neon cheapest paid plan price`, `Render cheapest paid Postgres plan`

**Assistant** (complete, first token 17.2 s, total 18.2 s):

> | Item | Said (date) | Then → Now | Status | Evidence date | Source |
> | --- | --- | --- | --- | --- | --- |
> | Neon | 2026-11-03 | — → — | Couldn't verify | — | — |
> | Supabase | 2026-11-03 | $25/month → $29/month | Changed after 2026-11-03 | 2026-11-11 | [1] |
> | Render | 2026-11-03 | — → — | Couldn't verify | — | — |
> 
> As of 12 November 2026, Supabase changed: $25/month → $29/month [1].

Sources returned:
- [1] Supabase Pricing — https://supabase.com/pricing — 2026-11-11

Steps:
- step 1 (force): model 8359 ms, search 1 ms, finish tool-calls, text 0 chars
  - forced: toolChoice tool:web_search, tools [web_search] → finish tool-calls, text 0 chars, tool calls: web_search({"fresh":true,"queries":["Neon pricing 2026","Supabase pricing 2026","Render postgres pricing 2026"],"domains":["neon.com","supabase.com","render.com"]})
- step 2 (none): model 9810 ms, search 0 ms, finish stop, text 387 chars
  - closed: toolChoice none, tools none → finish stop, text 387 chars

Checks:
- ✓ answerComplete
- ✓ searched
- ✓ cited
- ✓ mustMention "$25"
- ✓ mustMention "$29"
- ✓ mustMention "Couldn't verify"
- ✗ mustNotMention "Changed after": present in the answer
- ✓ recallRulesInclude
- ✓ verifyTable
- ✗ takeawayMatchesTable: trace has a verifyTakeawayMissing entry
- ✓ claimState.currentValueContains
- ✓ claimState.supersededValueContains
- ✓ claimState.supersededAtLocalDate
- ✓ claimState.historyLength
- ✓ (soft) vendorPageFirst
- ✓ (soft) noRawLinks
- ✓ (soft) nowValueOnUnverified
- ✗ (soft) statusMatchesEvidenceLabel: trace has a verifyStatusContradiction entry

Judge: 3/5 — The assistant correctly identified the price change for Supabase from $25 to $29 with a citation, but incorrectly used 'Changed after' instead of the required 'Differs now (timing unknown)' status for an undated pricing page.
