# DECISIONS — running log (condensed into DESIGN.md at the end)

Format: **ID — Decision.** Why. *Rejected:* alternatives.

## Stack
**D1 — TypeScript on Node ≥ 20, ESM.** Challenge rule; strict types make the code easier to review.

**D2 — Vercel AI SDK v7, no agent framework.** Streaming, tools, structured output and provider
switching, with very little abstraction, so every line can be explained.
*Rejected:* LangChain/LangGraph and Mastra. They add layers around a single loop with one tool.

**D3 — Hono server + Vite/React web, with a framework-free `src/agent` core.** The folder layout
shows the architecture. The same core runs the server, the CLI and the evals.
*Rejected:* Next.js. One process, but it mixes agent code into route handlers.

**D4 — Gemini Flash (main) + Flash-Lite (background), provider set by env.** Free to run,
fast, good at tool calling. Separate quotas per model. OpenAI/Anthropic work by changing env.
*Rejected:* paying for a frontier model. The design, not the model, is the differentiator.

**D5 — Exa primary, Tavily fallback, both behind `SearchProvider`.** Exa is low-latency, has
published-date filters, and live-crawls contents (`maxAgeHours: 0`) for pricing pages.
*Rejected:* Perplexity Sonar (outsources the answer itself); raw SERP APIs (need a scraper);
the provider's built-in search tool (no control over freshness, caching or citations).

**D6 — SQLite via better-sqlite3 + FTS5.** No setup, one file, works after `npm install`.
*Rejected:* Postgres/Docker (setup friction); `node:sqlite` (stable only from Node 24);
a vector DB (date lookup is exact; embeddings can come later).

**D7 — chrono-node + user timezone from the browser.** Date maths is code's job; models are
unreliable at "last Tuesday".

## Agent design
**T1 — Deterministic context builder instead of a memory tool.** Keeps to the one-tool rule,
saves a model round-trip, and is unit-testable.

**T2 — Single loop, one batched tool (`queries[]`), MAX_STEPS = 4.** Parallel queries in one step;
fewer model calls (matters on the free tier).
*Rejected:* planner/researcher/critic multi-agent setups (slower, more quota, harder to debug).

**T3 — Search pipeline inside the tool:** fallback, dedupe, cap, numbering, TTL cache.

**T4 — Answer ledger:** claims + a turn summary extracted after the reply in ONE small-model call;
the basis for "is it still correct?". Summaries, not raw transcripts, are what get recalled.

**T5 — Verify mode:** a regex intent flag plus prompt section → Changed/Unchanged/Couldn't-verify table.
*Rejected:* an LLM router (costs a call before the first token).

**T6 — Honesty rules in the prompt + empty-history markers from code.**

**T7 — Speed:** stream immediately, transient status parts, stable prompt prefix for caching,
post-stream background work.

**T8 — Traces + debug drawer.** Every answer can be explained.

**T9 — Evals with seeded history, fixed NOW, deterministic checks + LLM judge, dev LLM cache.**

## Memory architecture (from research: Manthan Gupta's memory posts on Hermes / Grok / ChatGPT / Claude, Zep Graphiti, Mem0, minimi)
**M1 — Retrieval policy is a separate, explicit module (`recallPolicy.ts`, rules R0–R4).** Storing is
easy; choosing what enters the prompt decides quality. Cross-thread memory only when the user's words ask for it
(a date or a back-reference). This prevents over-application of memorised details.
*Rejected:* always-inject (ChatGPT-style) and "inject top-k similar every turn".

**M2 — Dated claims with supersession (bi-temporal-lite, after Zep's valid_at/invalid_at).** `observed_at`,
`valid_as_of`, `last_verified_at`, `superseded_by/at`. History is kept, so "it was $19 on 3 Nov, $X now" works.
*Rejected:* overwrite-in-place (loses history); append-only notes (contradictions pile up, as in Grok's bots);
a graph DB (too heavy for `npm install && npm run dev`).

**M3 — Deterministic reconciliation by claim key (ADD / TOUCH / SUPERSEDE).** Mem0's add/update/delete
idea without the extra LLM call per write. Cheap, predictable, unit-testable.
*Rejected:* LLM-decided updates (2 calls per write, probabilistic, unaffordable on the free tier).

**M4 — Static system prompt; dynamic memory goes in front of the user message (Hermes pattern).** Stable
prefix → provider prompt caching → lower latency and cost. Character caps keep the memory block bounded.

**M5 — Memory is an attack surface.** Write only from the final answer + cited URLs, schema-validate, scan for
injection/exfiltration patterns, log every write, wrap recalled memory and search results as data.

**M6 — Visible, editable memory (Memory panel + forget).** Memory users can't see is hidden profiling.
minimi users asked for granular deletion on Product Hunt; we ship it.

**M7 — No implicit user profile.** The target prompts need episodic memory + the ledger, not a profile.
Every memory feature has a cost (privacy, drift, debugging), so we ship only what the product needs.

**M8 — Memory work stays off the critical path.** Before the first token: SQLite + code only. Extraction,
summaries and reconciliation run after the stream.

## Added during build
<!-- append new entries here -->
