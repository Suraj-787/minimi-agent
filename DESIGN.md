# DESIGN

> Draft, to be finished in Phase 7 with real numbers. Keep it to one page.

## How it works
Every message goes through three stages:

1. **Recall policy + context builder (code, ~ms).** Anchors the current time in the user's timezone and turns
   phrases like "last Tuesday" or "since Monday" into exact dates with chrono-node. A small rule-based
   **recall policy** decides whether past conversations may enter the prompt at all (only when the user
   names a date or refers back), then pulls their summaries and **claims** from SQLite, capped and wrapped as data.
2. **Agent loop (one model, one tool).** Gemini Flash streams the answer and may call
   `web_search({queries[], since?, domains?, fresh?})`. Queries run in parallel through Exa (Tavily as
   fallback). Results are de-duplicated, numbered for citation and cached in SQLite. Status updates
   stream live.
3. **After the reply (background).** One small-model call writes a turn summary and checkable claims
   (`entity · attribute · value · source · date`) into a **dated answer ledger**. Claims merge by key:
   same value → mark it re-verified; new value → the old claim is *superseded*, not overwritten, so history survives.

"Is your answer still correct?" then becomes a defined process: load the old claims → re-check each
one with date-filtered, fresh searches → report Changed / Unchanged / Couldn't verify, with citations.

## Why this way
- The test prompts are about **memory and time**, not just search. Dates are resolved in code
  because models get them wrong; memory is looked up by exact date because similarity search can't answer "what did I ask on the 3rd?".
- **One tool** for the model, with memory supplied by code: keeps to the challenge rule, saves a
  model round-trip, and can be unit-tested.
- **Speed:** stream from the first token, batch the queries, keep a stable prompt prefix, and do all
  extra work after the reply.
- **Honesty:** if there's no record, it says so. Conflicting sources are shown. Facts that go stale carry an "as of" date.
- **Memory is designed as a policy, not a dump.** No always-on profile. Cross-thread recall only when asked for,
  a fixed system prompt (cache-friendly), bounded memory blocks, writes scanned for prompt injection, every
  write logged, and a Memory panel where users can see and forget what's stored.
- **Readable structure:** `src/agent` is framework-free and shared by the server, CLI and evals.

## Considered and rejected
Mem0-style LLM-decided memory updates (an extra model call per write) · a temporal knowledge graph
(Zep/Graphiti; we kept its date model in SQLite) · always-injected user profile (over-application, privacy) ·
a memory search tool (breaks the one-tool rule; code-side recall is faster and testable) ·
Multi-agent orchestration (slower, more quota) · LangChain (unneeded layers) · Next.js (blurs the
layers) · vector-only memory (no exact dates) · Perplexity Sonar (outsources the answer itself) ·
an LLM intent router (adds latency; a regex is enough) · Postgres (setup friction).

## Results
_TODO: eval pass rate, median time to first token, typical searches per turn — from `eval/results.md`._

## With another week
- **Proactive re-checks:** periodically re-verify stored claims and nudge the user when one changes
  (minimi's product, in small form).
- Source-quality ranking (official vendor pages > news > blogs) and confidence per claim.
- Embedding recall for vague references ("that database thing").
- Conversation summaries for long threads; per-claim expiry by type (prices fast, specs slow).
- Larger eval set built from real conversations; regression checks in CI.
