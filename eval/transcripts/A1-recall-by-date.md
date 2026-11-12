# A1-recall-by-date

- Category: memory
- Clock: 2026-11-12T11:00:00+05:30 (Asia/Kolkata) · seed: yes
- Search: live (unused)
- Models: google · main `gemini-3.5-flash-lite` · small `gemini-3.5-flash-lite` · thinking tool low / answer low
- Ran: 2026-11-12 15:41 UTC
- Pass: 1/1

**Rubric:** Lists both questions from 3 Nov accurately and concisely, without inventing anything else.

## Run 1 — PASS

**User:** What did I ask you on 3 November?

**Assistant** (complete, first token 6.1 s, total 6.2 s):

> From your 3 November chats, you asked two things:
> 
> 1. Which managed Postgres host is best for a small side project, and compared the prices for their cheapest paid plans.
> 2. Whether Bun is production-ready or if you should stick with Node for a new API.

Steps:
- step 1 (auto): model 6179 ms, search 0 ms, finish stop, text 253 chars
  - auto: toolChoice auto, tools [web_search] → finish stop, text 253 chars

Checks:
- ✓ answerComplete
- ✓ searched
- ✓ resolvedDates
- ✓ mustMention "Postgres"
- ✓ mustMention "Bun"
- ✓ mustNotMention "CRM"
- ✓ mustNotMention "half marathon"
- ✓ recallRulesInclude

Judge: 5/5 — The assistant accurately listed both questions asked by the user on November 3 based on the recalled memory without inventing any details.
