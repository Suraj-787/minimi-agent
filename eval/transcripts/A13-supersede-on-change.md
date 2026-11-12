# A13-supersede-on-change

- Category: memory-write
- Clock: 2026-11-12T11:00:00+05:30 (Asia/Kolkata) · seed: yes
- Search: mock
- Models: google · main `gemini-3.5-flash-lite` · small `gemini-3.5-flash-lite` · thinking tool low / answer low
- Ran: 2026-11-12 09:31 UTC
- Pass: 1/1

**Rubric:** Says Supabase Pro is $29 now versus $25 said on 3 Nov, with a citation. The only evidence is a pricing page (dated 11 Nov), which does not date the change, so the status is 'Differs now (timing unknown)', not 'Changed after'. The ledger keeps both values with dates. The fixture has a page for Supabase only (on purpose: a regression test for an evidence gap). Neon and Render have no evidence, so they must be 'Couldn't verify' with no invented values, and the turn must still end with a model-written answer.

## Run 1 — PASS

**User:** Last Tuesday I asked you about Postgres hosting. Has Supabase's price changed?

Searches: `neon com pricing`, `supabase com pricing`, `render com pricing`, `Neon cheapest paid plan price`, `Render cheapest paid Postgres plan`

**Assistant** (complete, first token 4.7 s, total 5.2 s):

> | Item | Said (date) | Then → Now | Status | Evidence date | Source |
> | :--- | :--- | :--- | :--- | :--- | :--- |
> | Neon | 3 Nov 2026 | $19/month → — | Couldn't verify | — | — |
> | Supabase | 3 Nov 2026 | $25/month → $29/month | Differs now (timing unknown) | 11 Nov 2026 | [1] |
> | Render | 3 Nov 2026 | $6/month → — | Couldn't verify | — | — |
> 
> As of 12 Nov 2026, Supabase differs now: $25/month → $29/month [1]. Neon and Render couldn't be verified.

Sources returned:
- [1] Supabase Pricing — https://supabase.com/pricing — 2026-11-11

Steps:
- step 1 (force): model 1547 ms, search 0 ms, finish tool-calls, text 0 chars
  - forced: toolChoice tool:web_search, tools [web_search] → finish tool-calls, text 0 chars, tool calls: web_search({"queries":["neon com pricing","supabase com pricing","render com pricing"]})
- step 2 (none): model 3678 ms, search 0 ms, finish stop, text 450 chars
  - closed: toolChoice none, tools none → finish stop, text 450 chars

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

Judge: 5/5 — The answer correctly identifies Supabase's price change from $25 to $29 with the correct status and citation, and properly marks Neon and Render as unverified without inventing values.
