# DESIGN

## How it works
1. **Context, built in code (ms).** `lib/clock.ts` is the only source of "now"; dates like "last Tuesday" are resolved in code.
   A rule-based recall policy picks what memory enters the prompt: R0 this chat, R1 a named date, R2 a back-reference plus
   topic words, R3 this chat's claims in verify mode, R4 nothing from other chats. The system prompt is byte-identical on every
   call; dynamic data goes in a `<context>` block before the user message, capped and wrapped as data.
2. **One model, one tool.** Gemini Flash-Lite streams the answer and may call `web_search` (Exa, Tavily as fallback).
3. **After the reply.** A background call writes a summary and atomic claims into a **dated ledger**, merged by key: ADD,
   TOUCH (re-verified) or SUPERSEDE (old row kept).

**Verify mode** ("still correct?") re-searches every recalled claim and answers with a status table (Unchanged, Differs now,
Changed after, Already outdated when asked, Couldn't verify). That table decides the ledger write.

## Three decisions the evals forced
- **Closing step (D72).** The closing step asked for no tools (`toolChoice: none`, no tool list), but the Google provider ignored that while the history still held tool calls. The model answered with another tool call, and A13 ended without an answer three times. The final step now gets no tool parts at all, only the results as plain text.
- **Code owns retrieval (D73).** In the demo the model passed a `since` that dropped undated pricing pages and typed `neon.tech`,
  so Neon and Render came back Couldn't verify. Code now builds verify searches per item: the claim's own host plus one unrestricted.
- **Statuses bounded by code (D77).** A13 wrote "Changed after" from a pricing page's date in 6 of 6 answers despite the prompt's
  rules (D71, D76). The closing message now lists each item's allowed statuses, computed from its evidence.

## Considered and rejected
LLM-decided memory updates (extra call per write, probabilistic) · a knowledge graph (too heavy for `npm install`) · an always-on
profile (over-application, privacy) · a memory tool (breaks one-tool rule, extra round-trip) · multi-agent (slower, more quota,
harder to debug) · LangChain (layers around one loop) · vector-only memory (dates need exact lookup).

## Results
20 cases, one run each; hard checks decide pass/fail, the judge is informational. Full runs: 14/20 (11 Nov), then 20/20 and 18/20
(12 Nov). After D77 the four status-logic cases (A13, A14, A17, A18) passed 12/12 in a targeted re-run, three runs each; those results are not stored with the committed eval results, which are the final full run. Final run, 13 Nov 2026: **19/20**. The one failure is
A4, whose heading read "Shipped since 2006-11-09". The check caught it; the judge gave 5/5. A4 passed before, so live answers vary
between runs. Median time to first token was 9.0 s. Live-search verify turns (A2–A4) took 14–44 s to finish; the mock-search cases took 5–24 s.

Prices were hand-checked against the vendor pages on 12 Nov 2026: Neon usage-based, Supabase Pro from $25/month, Render Postgres
256 MB $6/month. All matched.

**Quota and reliability.** We run on the Flash-Lite free tier: 15 requests/min, 500/day. Calls retry on 429/5xx, with a 60 s
first-chunk timeout, and evals rerun once after a provider error (A4 and A5 in the final run). The final run made about 50 live
Exa searches with no failures and no Tavily fallback. Over the whole build the Exa dashboard shows 422 requests, 0 rate-limited; the peak reached Exa's 10-per-second limit and none was rejected.

## Known limitations
- A bare "since then" needs a date in the same message; without one, verify re-checks the chat's newest turns.
- Verify re-checks every recalled claim, even off-topic ones.
- In verify mode the model's own extra queries are ignored.
- Search can return pages dated after the clock.
- The extractor can lose a turn's claims on timeout; the failure is logged, but there is no retry queue.
- Status wording depends on the model; the ledger and soft checks are the safety net. A2 called Bun "Changed after" on a
  release note older than the claim, and A2 and A19 copied the prompt's fictional example topic into their answers.

## With another week
Code-assigned verdicts from evidence dates · `effective_from` on claims · a memory-write retry queue · proactive re-checks.
