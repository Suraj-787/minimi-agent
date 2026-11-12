# A14-evidence-predates-claim

- Category: verify
- Clock: 2026-11-12T11:00:00+05:30 (Asia/Kolkata) · seed: yes
- Search: mock
- Models: google · main `gemini-3.5-flash-lite` · small `gemini-3.5-flash-lite` · thinking tool low / answer low
- Ran: 2026-11-12 09:32 UTC
- Pass: 1/1

**Rubric:** The only evidence ($29) is dated 1 Nov, strictly BEFORE the $25 answer on 3 Nov (the tool labels it 'before the Supabase claim date'). Status must be 'Already outdated when asked' (the figure was wrong when given), not a change since 3 Nov. The table shows the evidence date 2026-11-01.

## Run 1 — PASS

**User:** Last Tuesday I asked you about Postgres hosting. Has Supabase's price changed since then?

Searches: `neon pricing 2026`, `supabase pricing 2026`, `render postgres pricing 2026`

**Assistant** (complete, first token 3.6 s, total 4.1 s):

> | Item | Said (date) | Then → Now | Status | Evidence date | Source |
> | :--- | :--- | :--- | :--- | :--- | :--- |
> | Neon | 2026-11-03 | $19/month → $19/month | Unchanged | — | [2] |
> | Supabase | 2026-11-03 | $25/month → $29/month | Already outdated when asked | 2026-11-01 | [1] |
> | Render | 2026-11-03 | $6/month → $6/month | Unchanged | — | [3] |
> 
> Supabase's Pro plan price was already $29/month before you asked on 3 Nov [1], making that figure already outdated then. Neon and Render remain unchanged as of 12 Nov 2026 [2, 3].

Sources returned:
- [1] Supabase Pricing — https://supabase.com/pricing — 2026-11-01
- [2] Neon Pricing — https://neon.com/pricing — undated
- [3] Render Pricing — https://render.com/pricing — undated

Steps:
- step 1 (force): model 1526 ms, search 0 ms, finish tool-calls, text 0 chars
  - forced: toolChoice tool:web_search, tools [web_search] → finish tool-calls, text 0 chars, tool calls: web_search({"since":"2026-11-03","domains":["neon.com","supabase.com","render.com"],"queries":["neon pricing 2026","supabase pricing 2026","render postgres pricing 2026"],"fresh":true})
- step 2 (none): model 2511 ms, search 0 ms, finish stop, text 529 chars
  - closed: toolChoice none, tools none → finish stop, text 529 chars

Checks:
- ✓ answerComplete
- ✓ searched
- ✓ cited
- ✓ mustMention "$25"
- ✓ mustMention "$29"
- ✓ mustMention "Already outdated"
- ✓ mustNotMention "Changed after"
- ✓ recallRulesInclude
- ✓ verifyTable
- ✓ takeawayMatchesTable
- ✓ (soft) vendorPageFirst
- ✓ (soft) noRawLinks

Judge: 5/5 — The assistant correctly identified that the Supabase price was already outdated when asked (priced at $29 on 1 Nov, prior to the 3 Nov claim of $25), using the exact required status and correct evidence date.
