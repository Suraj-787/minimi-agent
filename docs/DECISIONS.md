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

**D8 — Node floor is 22 (`engines >=22`, `.nvmrc` 22), not 20.** AI SDK v7 (`ai@7`, `@ai-sdk/*` 4.x) declares
`engines.node >=22`; on Node 20, npm silently resolves the v6 line, which CLAUDE.md rules out. `check-env.mjs`,
README and `engines` all say 22. Node 22.8 is enough (no 22.12 needed) because the other tools are pinned
to majors that support it.
*Rejected:* Node 20 + AI SDK v6 (the wrong API for every later phase); Node >=22.12 with the newest
vite 8 / vitest 5 (forces a Node upgrade for no product benefit).

**D9 — Toolchain pins for the Node 22 floor.** `vite@^6` + `@vitejs/plugin-react@^4` (vite 7/8 need Node 20.19/22.12+),
`vitest@^3`, `concurrently@^9`, `typescript@~6.0` (not the 7.x native compiler), `@types/node@^22` so types match
the runtime. `better-sqlite3@^12` (resolves to 12.11.1; 13.x needs Node >=22 but is a new major we haven't vetted).
The first pin, `~12.9.0`, only existed to keep Node 20 prebuilds, which no longer matter. Checked against the
GitHub release assets: 12.11.1 ships prebuilt binaries for Node 22, 24, 25 and 26 on macOS (arm64, x64), Linux
(x64, arm64, arm, musl) and Windows (x64, arm64), and declares `engines` 20 to 26, so a reviewer on Node 22, 24
or 26 never compiles from source. 12.9.0 would have failed that bar: it covers Node 20 to 25 but has no Node 26 binary.
Known cost: vitest 3 has two npm-audit advisories (tinypool, @vitest/mocker). Dev-only; they affect the test
runner, not the app. The fix is vitest 5, which needs Node >=22.12; revisit if the floor moves.

**D10 — The server owns history; the client sends only the newest message.** `useChat`'s
`prepareSendMessagesRequest` posts `{threadId, message, timezone}`. The stored text is therefore exactly what the
user typed, and the dynamic block (time anchor) is added server-side at call time and never persisted.
*Rejected:* trusting the client's message array (it could drift from the DB and would persist injected context).

**D11 — Thread titles are derived in code from the first user message (≤ 60 chars).** No LLM call, so nothing
slow runs before the first token (rule 5). An LLM title can be added to the background pass later.

**D12 — Disconnect safety by teeing the UI stream.** `runAgent` splits the UI stream in two: the client gets one
branch and the server drains the other with `consumeStream`. If the browser disconnects, the model keeps going and the
FULL reply is saved. `abortSignal` is deliberately not forwarded from the request. Persistence is memoised
(`persistOnce`) and also runs after the drain, so a user message can never be left without an assistant row.
Rows carry `status` = `complete | partial | error` (extra column on `messages`); `partial` is used if the model
stream itself aborts. `done` resolves only after persistence, and Phase 4 will chain the memory write onto it.
Cost: a closed tab still spends the tokens for that answer. *Rejected:* aborting on disconnect (loses the answer);
saving only partial text (the user comes back to a half answer).

**D13 — Provider errors become fixed, readable sentences.** `friendlyError()` maps 401/403 (and Gemini's 400
"API key not valid"), 429, 5xx and the rest to a fixed sentence; the provider's own message is never sent to the
client or logged. The error is streamed as an in-stream `error` part (HTTP 200) and saved as an assistant row with
`status='error'`. Error rows are filtered out of the next prompt. `maxRetries: 0` until Phase 5's `lib/retry.ts`.

**D14 — History trimming (rule R0, ≤ 12 messages, ≤ 6,000 chars) guarantees a user-first, alternating history.** If
the cap cuts on an assistant message it is dropped, because Gemini rejects history that starts with a model turn.
The current user message is always kept. *Rejected:* summarising old turns (a model call on the hot path).

**D15 — `messages` has an `INTEGER PRIMARY KEY AUTOINCREMENT seq`; the FTS index keys on it, and `claims` has no
foreign keys.** Rowids of tables with a text PK can change on VACUUM and desync an external-content FTS index; `seq`
also gives stable ordering when `NOW` is frozen and every `created_at` is equal. Claims must survive thread
deletion (rule 10: never hard-deleted by the system), so no cascade reaches them.

**D16 — Only `POST /api/chat` and `POST /api/threads` require a UUID.** Seeded threads (`seed-postgres`) can be read
and deleted, but can't be continued through the chat endpoint. Revisit in Phase 3 if the demo needs to continue a seed thread.
