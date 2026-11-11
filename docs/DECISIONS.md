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

**D16 — Only `POST /api/chat` and `POST /api/threads` require a UUID.** Rather than loosen the validation for
`seed-postgres`-style ids, the Phase 3 seed script generates a UUID per seeded thread and keeps the seed.json id as a
label only, so seeded chats can be continued in the app.

**D17 — The tool is built per turn, and `runAgent` wraps the model stream in `createUIMessageStream`.** A tool's
`execute` does not receive the stream writer in AI SDK v7, but the SPEC wants transient `data-status` parts and
`source-url` parts while the tool runs. So the tool gets an `emit` callback that closes over the writer, and the inner
`toUIMessageStream` is merged into the outer stream. The inner stream's outcome is forwarded with `writer.setOutcome`,
because otherwise a provider failure is saved as `complete`. Writer-written `source-url` parts are part of the
response message, so they are persisted in `parts_json`; the transient status is not. The last allowed step runs with
`toolChoice: "none"`, so hitting `MAX_STEPS` still ends in an answer. *Rejected:* yielding status from an async-generator
`execute` (it shows up as tool-part states, not transient data parts).

**D18 — Search timeout, fallback and Exa freshness.** The 6 s timeout is per provider attempt, so Exa timing out still
leaves Tavily a full attempt. Each query falls back independently, and one failed query never sinks the others; only when
every query fails does the tool tell the model that search is unavailable (it then adds a caveat). Cache lookups happen per
provider, in order, and `fresh` never reads the cache. `since` shortens the cache TTL but does not switch Tavily to
`topic: news`. Exa's `maxAgeHours: 0` goes inside `contents`, as the docs describe; one live probe showed the API
accepts it there and also at the top level, so that probe cannot prove which position it honours. Exa may omit
`publishedDate`, so the date stays optional end to end. Provider errors keep only name + HTTP status, never the body.

**D19 — Citation numbers belong to the turn, not to a provider response or a cache row.** `createTurnCounter()` assigns
`n` after merging, so cached results are renumbered from the current turn's counter, and a URL already cited earlier in
the turn keeps its number (so the same page is never two sources). Merging is round-robin across queries before the cap of 8,
so one query cannot use up the whole cap. Cache rows hold no numbers.

**D20 — Web text cannot break out of `<search_results>`.** Titles and snippets are entity-escaped (`& < >`, whitespace
flattened); URLs are percent-encoded for `< >`. A title of `</search_results>` stays inert (tested). Source dates travel in
`providerMetadata.search.{n, publishedDate}` on the `source-url` part, which is persisted, so `[n]` links and dates
survive a refresh. In the UI a `[n]` with no matching source stays plain text, and code spans are left alone. Date
arithmetic (`addMs`, `isoDayFromMs`) lives in `lib/clock.ts` so `src/search` never calls `new Date(`.

**D21 — Time phrases: own code for weeks, weekdays and "since"; chrono for the rest.** chrono gets the product
meaning wrong ("this week" starts on Sunday, "since" is dropped, a weekday has one answer, a year-less date can land in
the future), so `time.ts` handles week phrases (Mon→today, Mon→yesterday, prev Mon→Sun), weekdays and "since" with
regexes, masks them, and passes the remaining text to chrono with the IANA zone converted to a minute offset at that
instant. A year-less date in the future rolls back one year. Future dates, bare times and a bare month without a lead-in
("March madness") resolve to nothing. A weekday equal to today's means 7 days ago (14 days ago is the second candidate),
never today: people say "today" or "this morning" for today, and the candidate pair absorbs a one-week slip. Vague
phrases ("the other day", "a few days ago", "recently") resolve to no date on purpose and leave recall to topic words.
"today" is dropped only next to a verify cue (still / now / currently / as of), where it is the comparison point.
*Rejected:* chrono for everything (wrong week and weekday semantics); asking the model to resolve dates (rule 3).

**D22 — R2 fires on back-reference verbs plus at least one topic word.** Cues: you told / said / recommended / suggested /
mentioned, I asked, we discussed / shortlisted / talked about, did I ask…, remember, last time. SPEC's bare "our …" and
"earlier" were dropped: "structure our REST API errors" would have pulled the seeded Bun "new API" chat into an unrelated
answer, which is exactly the over-application R4 exists to stop. With no topic words, R2 has nothing to search, so it
does not fire. R4 is recorded as `crossThread: false`, not as a rule id, so unrelated questions trace as `["R0"]`.

**D23 — Topic matching is FTS5 prefix search over light stems, scored by distinct terms matched.** Terms drop function
words, conversation verbs (asked, told, said, discussed…), time words and verify cues. A suffix strip ("pricing" →
`"pric"*`) finds "price" without a stemmer dependency. Each term is one quoted prefix query, so user text is never read as
FTS syntax. With ≥ 2 terms a turn needs ≥ 2 distinct matches to count as on-topic, so one shared generic word ("price")
does not drag the Postgres chat into a CRM question. The same test picks between weekday candidates (no topic words → any
turn on that day wins) and filters a resolved day down to its on-topic turns, falling back to the whole day when none match.
*Rejected:* embeddings (Phase 0 dependency list, and exact dates do the heavy lifting); OR-ranking with no threshold (noisy).

**D24 — A turn is a user message plus the next assistant row; recall reads it from `messages`, not a turns table.**
`turnId` is the assistant id, which is also the key for `turn_summaries` and `claims.turn_id`. Error replies are not
recallable. Turns whose user message is inside the R0 window actually sent to the model are skipped (by `seq`), but older
turns of the same thread can still be recalled by date. Until Phase 4 writes summaries for live turns, a 300-char excerpt of
the answer stands in for the summary.

**D25 — Memory caps are enforced by rendering, with truncation before dropping.** Each turn is cut to 1,500 chars (user
≤ 200, summary ≤ 400, claim values ≤ 200, overflow claims become "(+N more claims not shown)"), then whole turns are
dropped from the lowest priority end until the block is ≤ 4,000 chars and ≤ 5 turns; claims are capped at 12 across the
block. Dropped turns are reported as `omitted_turns` on the `<memory>` tag and in the trace, and a static prompt line
makes the model say "showing X of Y". Superseded claims are rendered with their superseded date and count toward the
caps; forgotten claims never render. All recalled text is entity-escaped, so `</memory>` in an old message stays inert.

**D26 — Recall failure degrades to R0, and the trace is written after the reply.** If the context build throws, the turn
runs with the time anchor and thread history, and the trace records the error. The trace row (intent, refs, chosen dates,
ambiguity, since date, rules, memory ids, omitted turns, chars, context ms) is written after the assistant row, and a
failed trace write is only logged (rule 5). Until Phase 4, `runAgent` passes `{ verify: false }` (`TODO(phase4)`).

**D27 — The seed is a fixture loader, not a memory write.** `scripts/seed.ts` exports `loadSeed(db, seed, now)` for the
eval runner; turns are dated `daysAgo` before `now()` in the seed's timezone, `{{date}}` becomes "3 Nov 2026", sources become
numbered `source-url` parts, and claims are dated to the turn and logged in `memory_writes` as `add` with
`{source:"seed"}`. It does not go through `scan.ts`, because it is trusted fixture data. `--reset` deletes the DB file and its
WAL side files, so no code path ever runs `DELETE FROM claims`. Without `--reset`, threads whose title exists are skipped.
`claimKey()` lives in `src/memory/claimKey.ts` now so seeded and live claims share one merge key.

**D28 — The extractor sees the labels of the claims recalled this turn, and returns `source: n` and `asOf`.** An LLM
rewords "cheapest paid plan price" freely; without the recalled `entity | attribute | value` lines (offered as "reuse
exactly; copy the value if unchanged") the key misses and SUPERSEDE never fires. These lines are our own ledger data,
already scanned, so raw page content still never reaches the write path. The model cites a source by its `[n]` rather
than copying a URL (no typos, nothing to exfiltrate). `asOf` is stored as `valid_as_of` when it is a real date not in the
future, else the user's local today. The model-facing schema is loose (plain strings, nullable, no length or regex limits,
because Gemini supports only part of JSON Schema); code validates each claim on its own, so one bad claim never sinks the rest.

**D29 — Every claim needs a source returned this turn.** A recall-only answer ("On 3 Nov I said Neon was $19") restates
memory; storing it would TOUCH the claim and fake a `last_verified_at`. So an unsourced claim, or one whose `[n]` was not
returned this turn, is rejected and logged with its reason. Only `complete` replies are remembered (not `partial` or `error`).
*Rejected:* letting unsourced claims ADD new keys (they would be unchecked model knowledge presented as a dated record).

**D30 — Reconcile refuses older evidence, and compares values loosely but safely.** If a different value arrives with
`valid_as_of` earlier than the held claim's, it is logged `rejected: "older evidence"` and the held claim stays current:
newer evidence wins, not the newer turn. Values compare after NFKC, lowercase, whitespace removal and trailing-punctuation
strip; currency symbols and decimals are kept, so "$19 / month" = "$19/month" but "€19" ≠ "$19" and "1.3" ≠ "13".
Duplicate keys in one extraction: the last wins. One transaction per turn (summary + rejections + reconcile).

**D31 — Verify mode with claims on record forces a search on step 0.** `prepareStep` returns
`toolChoice: { type: "tool", toolName: "web_search" }` for the first step when `intent.verify` and at least one claim is
listed to re-check, then `{}` (auto), and `none` on the last step. The prompt alone was not enough: a model can "verify"
from memory. Verify with nothing on record is not forced (a regex false positive must not cost a search). The trace's
intent records `cues` and `forcedSearch`.

**D32 — The R0 window skips turn text, not claims.** Turns inside the window are recalled as claims-only entries
"(earlier in this chat, shown above)". R1 keeps them so a day isn't misreported as empty. In verify mode R3 adds the
window's turns that have claims, newest first, so a same-thread "Is that still correct?" has claims to re-check (and
triggers D31). The trace splits `memoryIds.turns` (recalled with text) from `inThreadTurns`. Claims render one line per
key across the block: the current value, plus `previously: <old> (said …, until …)` for up to 3 earlier values.

**D33 — A `domains` list is a hint: the search layer pairs it with one unrestricted query.** Verify mode offers the hosts of
the recalled claims' sources as "a hint, not a limit". `planJobs()` runs every query restricted and the first query once
more on any site (labelled "(any site)" in the trace), because price changes and launches are often reported off the
vendor's site first. Done in code, so it never depends on the model making a second call.

**D34 — Evidence dates decide Changed vs "already outdated".** Results show `published YYYY-MM-DD` or `undated`. The static
verify rules compare that date with the claim's "said" date: after → Changed (since you asked); on or before → the earlier
figure was already outdated (not a change since); undated → changed, timing unknown. The table has an Evidence date column.
Recalled memory is cited by date and chat ("from your 3 Nov chat"), never as a claim label; `[n]` is only for search results.
Covered by prompt tests and eval case A14 (evidence dated 1 Nov against a 3 Nov claim).

**D35 — Scanner: invisible characters first, then NFKC, then patterns.** Zero-width and bidi characters are rejected before
normalising (NFKC does not remove them). Then full-width look-alikes fold to ASCII ("ｉｇｎｏｒｅ"). Then the pattern list
runs. Exfiltration needs a verb plus a sensitive object ("forward all conversations"), and secret-requests need a verb
("print the API keys"), so ordinary claims like "Sends invoices to customers" or "Supports API keys" pass. Links are allowed only
if they are one of this turn's sources (URL-normalised). A false positive costs one claim; a false negative persists in memory.
The background extraction uses the SDK's `maxRetries: 2` under one 30 s `AbortSignal`, which caps all attempts together;
`runAgent().done` now resolves after the memory write, so the CLI and evals can await it while the server never does.

## Phase 4 manual-test fixes

**D36 — A page date is not a change date; statuses say only what the evidence supports.** (Replaces D34's status rules.)
Manual testing marked Neon "Changed" from a pricing page dated 4 Nov, but its pricing dates from Aug 2025; the date was
when the page was published or crawled. Code now labels each result `published DATE (before since)` / `(after since)` /
`undated` whenever the call has `since`, so the model never compares dates itself. The status vocabulary is: Unchanged |
Differs now (timing unknown) | Changed after DATE (only with a dated announcement, changelog, release note or news item
published after the claim) | Already outdated when asked (dated evidence on or before the claim's day) | Couldn't verify.
*Rejected:* inferring change dates from page dates (the bug); dropping dates entirely (Already outdated needs them).

**D37 — Verify coverage and the news pass are enforced in code (`agent/recheck.ts`).** A4 listed five tools, the cap was 4
queries, and Freshsales went unchecked; "shipped something big?" ran no news search. The cap is now 6. A per-turn tracker
sees every `web_search` call. It tops up `<entity> <attribute>` queries for items no query mentions (a whole-word
match on the entity's first word, so "HubSpot pricing" covers "HubSpot Sales Hub"), and `prepareStep` keeps forcing the
tool while an item is unsearched. When the message has a news cue, one more forced call is rewritten into the news pass:
`since` (the resolved since date, else the earliest day a listed claim was said), no `domains`, one query per item. App-authored
notes after the results say what is still owed. The trace's intent stores the tracker's final state. Within `MAX_STEPS = 4`
that is price pass, news pass, then the answer. *Rejected:* prompt-only rules (they failed in A4); generating every query in
code (the model writes better queries; code only fills gaps).

**D38 — No ids in `<memory>`.** A recalled-thread answer printed "[memory: 2026-11-03 t_929e45f4]". Turn tags and `(cN)` claim
labels are gone from the block; turns show their local time, claims are `- entity | attribute | value | …` lines, and the
verify re-check list names items as "entity — attribute". Ids live only in code and the trace. The static prompt forbids
bracketed memory references and ids in answers.

**D39 — Ledger values are atomic.** A3 stored Render as "Basic-256mb, ~$6.30/month (or entry managed instance)" and superseded
"$6/month" while the answer's table said Unchanged. Validation now rejects a value with `~`, `≈`, approx…, roughly, around,
about, "or" or parentheses (`"hedged value"`, logged). The extractor copies the recalled value verbatim for rows the answer
marks Unchanged. Rows marked Couldn't verify are **not extracted at all**, rather than copied: a copy would TOUCH the claim and
record a verification that never happened (the D29 reasoning). Qualifiers belong in the attribute.

**D40 — `fresh` queries get 15 s per provider attempt.** Exa live-crawls pages for `fresh`, which routinely exceeded 6 s in A3
and A4 and fell back to Tavily. Non-fresh queries keep 6 s. *Rejected for now:* running Exa and Tavily in parallel for fresh
queries (doubles search quota per verify turn; revisit if 15 s still times out).

## Phase 4 re-check fixes

**D41 — In verify mode, evidence is dated against its own claim, not only against `since`.** A2 had no "since" in the
message, so results went unlabelled and the model called Bun "Changed after 2026-11-03" on evidence from 2026-08-20.
Each search result now keeps the query that first found it; the recheck tracker maps that query (else the result's
title) to the item it was searched for, and the tool labels the date `(on or before the <item> claim date D)` or
`(after …)`. The claim's own day counts as "on or before": a page dated the day we answered could not have told us
anything new. The claim date is the local day the shown value was said. With no matching item the `since` label applies.

**D42 — Parentheses are not a hedge.** "Launch plan, Pay-as-you-go ($0.106/CU-hr)" was rejected and Neon stayed at $19.
The hedge test is now only `~`, `≈`, approx…, roughly, around, about and a standalone "or"; a hedge word inside
parentheses is still caught by the word itself.

**D43 — The verify table decides what the ledger does.** A2 superseded Render with a reworded value while the table said
Unchanged. `memory/verifyTable.ts` parses the table and maps each recalled claim to the row naming its entity (best
attribute-word overlap among several rows). Unchanged → TOUCH by id (when the row cites a source returned this turn), no new
value. Couldn't verify → no write. Differs now / Changed after / Already outdated → the extractor's value goes through
reconcile. An extractor claim is held if it has the key of an Unchanged / Couldn't-verify claim, or names an entity whose rows
are all Unchanged / Couldn't verify (that catches a reworded attribute). Held claims are logged as rejected with the reason.
No table, an unknown status, or no row naming a claim → the D28–D30 path as before. *Rejected:* trusting the extractor
alone (it rewords, and the user saw the table, not the extraction).

**D44 — The takeaway must match the table, and code checks it.** A4's closing line said nothing changed under a
"Differs now" row. The static prompt now requires the takeaway to name every row that isn't Unchanged, adds a
"Shipped since <date>" list (item, date, [n], or "Nothing found dated after <date>") when the user asks what shipped, and
allows "introduced/launched" only with a source dated after the claim date. `takeawayGaps()` finds non-Unchanged rows not
named after the table; they go into the trace as `errors: [{ verifyTakeawayMissing }]` for the debug drawer and evals. The
answer is never rewritten after streaming.

## Phase 5 — reliability, observability, memory UI

**D45 — Retry is language-model middleware on the main model only, with a visible status.** `agent/retryMiddleware.ts` wraps
`doStream`/`doGenerate`, so a 503 on the answer step repeats that one call and never re-runs `web_search` (tested). Up to 3
retries on 429/408/5xx; the wait is the provider's hint (`retry-after-ms`, `Retry-After`, Gemini `retryDelay`) capped at 20 s,
else 1 s·2ⁿ with jitter. A 429 whose body names a per-day quota fails fast with a "daily free quota is used up" message.
The stream is read until its first content part: a thrown error or an error part before content is retried; an error part
after text has started is not (the user may have seen output). The SDK's `maxRetries` stays 0 on the main call so nothing is
retried twice; the background extractor keeps `maxRetries: 2` and gets no retry middleware. The same work found that a
mid-stream error part left the turn saved as `complete` (and then remembered); it is now saved as `error`.
*Rejected:* retrying around `runAgent` (re-runs searches, replays text); SDK retries (no status hook).

**D46 — Dev LLM cache, with guardrails.** `lib/llmCache.ts`, below the retry layer. The key hashes provider, model id and the
whole call (not the abort signal or headers). Only a stream that finished with a `finish` part and no `error` part is stored;
thrown errors and cancelled streams store nothing. Ignored under `NODE_ENV=production` (warning), a loud warning when on, and
only `getModels(env, { cache })` installs it: the server and the CLI pass it, the eval runner never does, so evals always hit
the real model. *Evals:* see D53.

**D47 — `fresh` searches are reused for 2 minutes.** Re-sending after a failed turn re-did every live crawl. Fresh queries read
and write a separate `fresh:`-prefixed cache row with a 2-minute TTL; they still never read the 1 h / 24 h entries.
Search outcomes now record which providers failed before the one that answered (the trace shows the fallback).

**D48 — Forget acts on the whole key chain.** Forgetting a claim marks every row with its key `forgotten` (status only, no
deletes), so a superseded predecessor cannot reappear as "previously:" or as a value. Each row is logged as `memory_writes`
op `forget`. "Forget chat" does the same for every key that chat touched, deletes that chat's turn summaries, and sets
`threads.memory_forgotten_seq` (schema v2) so its turns up to that point stop being recalled into other chats; the chat's
messages stay. *Rejected:* deleting claims (rule 10); forgetting only the clicked row (the predecessor resurfaces).

**D49 — The debug endpoint is a whitelist.** `GET /api/debug/:turnId` builds its JSON field by field from the trace row,
plus recalled memory described in words and this turn's `memory_writes` read live. It never reads env. Writes are labelled
`blocked` (the injection scanner stopped it) or `skipped` (a policy check: table says Unchanged, older evidence, unsourced,
hedged). The UI renders everything as text; `/verify` forbids `dangerouslySetInnerHTML`.

## Phase 5 browser-test fixes

**D50 — Missing earlier content: say so and ask, in the prompt and in code; citations are [n] only.** With the shortlist chat
forgotten, "On Monday we shortlisted 5 CRM tools…" got a generic CRM search. The static prompt now has a "Missing earlier
content" section (say what there is no record of, ask for the details, no substitute search, never invent). Because a prompt
rule alone failed before (D37), `buildContext` also adds an app-authored "No record found: …" line to `<context>` when the
message has a back-reference cue, nothing was recalled, and this chat has no earlier turns (an in-chat "you said" is answered
from the R0 history, so no line there). Answers cite with [n] only: the prompt forbids markdown links and bare URLs, and
`answerChecks.rawLinks` records any in the trace (`errors: [{ rawLinks }]`). The answer is never rewritten (D44). The web UI's
own [n] → link rendering is unaffected. *Rejected:* forcing `toolChoice: none` when memory is empty (a message can mix a
memory reference with a genuine search need).

**D51 — "Shipped since <date>" is checked, and an ambiguous date is surfaced.** The prompt says a listed item needs its own
source date after <date>, and an ambiguous weekday must be stated or asked. `answerChecks.shippedProblems` reads the list under
the header and records items dated on or before the date, undated items, and a header date that is not the expected since
(`errors: [{ shippedNotAfterSince }]`). A bare "since" after an ambiguous weekday ("On Monday … shipped since?" with no record
of either Monday) gets a `<context>` line saying there is no since date and to state the assumption or ask. "since <weekday>"
is unchanged: it always means the most recent one (`time.ts`). Eval keys `noRawLinks` and `shippedAfterSince` read these
trace entries.

**D52 — Dated evidence that states the new value wins; the drawer shows what the model saw.** When results for an item
disagree on date, the prompt says to rely on a dated result that states the new value over undated or old-value pages; its
code-written label (on or before / after the claim date) then decides Already outdated vs Changed. This stays a prompt rule
backed by eval A16; no result re-ranking in code yet. The trace now stores the re-checked items (`intent.recheck.claims`),
each recalled claim's status AT RECALL (`memory_ids.claimsAtRecall`, because claims change after the turn), and
`first_status_ms` (schema v3), the time to the first "Searching…" or retry notice. Every `memory_writes` row shows key and
value (from its detail, else its claim row; a supersede also shows the previous value).

**D53 — Evals run on the real model; the cache is an explicit `--cache` flag.** A cached eval measures replayed text, so its
latency, retries and pass rate say nothing about the model. The runner therefore ignores `DEV_LLM_CACHE` in the env and passes
`getModels` a cache target only when `--cache` is given (with the flag, it enables the cache itself). `--cache` prints a banner at
start and in the summary, and the runner refuses to write `eval/results.md` from such a run, so a committed result is always
from the real model. *Rejected:* honouring the env var (a stray `DEV_LLM_CACHE=1` in `.env` would silently cache a "real" run).

## Phase 5 second browser test

**D54 — Same-day evidence cannot be ordered against a claim.** A4 showed "Already outdated when asked" for a page dated the
same day the claim was said. D41 counted the claim's own day as "on or before"; that is withdrawn. A date has day precision, so
a same-day page may be earlier or later than the answer. The tool now labels `(before the <item> claim date D)` only for a
strictly earlier date, `(same day as the <item> claim date D)` for an equal one, and `(after …)` for a later one. A different
value with only same-day evidence is "Differs now (timing unknown)": not Already outdated, not Changed. Eval A17.

**D55 — A row's source must be about that row's item.** The same A4 row cited a HubSpot blog about generative-AI CRMs for a
Pipedrive price. `answerChecks.sourceMismatches` takes the vendor as the item's first word and checks that each cited result's
URL, title or snippet mentions it; mismatches go to the trace (`errors: [{ verifySourceMismatch }]`), like
`verifyTakeawayMissing`. The prompt adds the rule that a competitor's blog, a roundup of other vendors or an unrelated page cannot
back another vendor's price, and that such a row is Couldn't verify. A blog that does name the vendor passes the code check; the
prompt and the judge rubric cover that case (eval A18). *Not done:* blocking the ledger touch for a mismatched row (a follow-up;
today the trace only records it).

**D56 — Chat stays mounted behind the Memory tab.** Switching to Memory unmounted Chat; coming back remounted it with the
messages loaded before the last turn, so a new chat showed blank until a refresh. `ViewSwitch` now keeps Chat in the page (hidden),
so useChat's state survives, and mounts Memory only while it is open, so it refetches every time. `buildChatBody` is the one place
that builds the POST body and always uses the id useChat was created with, so a send from a blank chat never mints a thread (test,
plus a server test that two sends to one id make one thread with four messages). *Rejected:* reloading on remount alone (loses an
in-flight stream); a DOM test harness (no new dependencies, rule 7), so the layout and the request body are tested as pure pieces.

**D57 — A source that is not about the item keeps its row out of the ledger.** D55 only recorded the mismatch. Now
`writeTurnMemory` gets this turn's results and skips, with a `memory_writes` row `rejected` and reason "source doesn't mention the
item" (the drawer shows it as "skipped"): (a) an extractor claim whose own cited source does not name its entity, so no add or
supersede; (b) a verify-table row none of whose cited sources names the item, so no touch, and any extractor claim for that key is
held as well. A row citing several sources passes if any one names the vendor. Matching is whole-word and case-insensitive ("Bun"
never matches "bundle"); the vendor is the item's first word, also joined with the second so "Node.js" finds nodejs.org. Short
(4 letters or fewer) and common-word vendors (Bun, Neon, Render, Linear, Notion…) must appear in the URL or title, because a body
mention of "render" or "bun" proves nothing. With no results passed (direct callers, old tests) the check is off. The check also
applies to ordinary non-verify turns: a claim must be backed by a page about it. *Cost:* a roundup page that names Neon only in
its body no longer backs a Neon claim; the claim is skipped and logged, not lost silently. *Rejected:* blocking on the table row
alone (the extractor could still write the claim from the bad source).

**D58 — Vendor page first for prices; "reported" vs "shipped"; both as soft checks.** Two style rules in the static prompt. (1) For a
price row, cite the vendor's own page first when it states the price (an undated vendor page is fine); a dated third-party page only
when the vendor page is missing or unclear, or to order the evidence, and then after it. (2) In "Shipped since <date>" write
"reported <date>" unless the date comes from the vendor's own announcement, release notes or changelog; never "shipped <date>" for a
news recap, roundup or aggregator. They are judgement calls, so the code checks are SOFT: `vendorPageFirstProblems` (applies only
when this turn's results include a vendor-host page whose snippet looks like a price) and `shippedWordingProblems` (a "shipped" line
with no cited source on the vendor's host) write `softVendorPageNotFirst` / `softShippedWording` into the trace errors; eval cases carry
them under `softChecks`, which the runner reports as warnings and never fails a case on. "Vendor's own" means the item's vendor
name as a whole word in the host (blog.hubspot.com counts; a recap that names HubSpot only in its path does not). *Rejected:* making
them hard failures (a vendor can state a price on a page whose snippet carries no number, so the check can be wrong).

**D59 — Soft check: the status must agree with the evidence label.** The status is supposed to follow from the date label the tool
wrote on the cited result (D54), but the model picks it, and A2/A4 showed slips in both directions. `statusContradictions` reads each
table row and the label the model actually saw for each cited result (computed in `runAgent` with the same `claimSide` the tool
uses, only for results found for a recalled claim, only when dated). It flags "Changed after" / "Differs now" with a result labelled
`before` the claim date, and "Already outdated when asked" with one labelled `after` or `same day`. A label computed for another
vendor's claim is ignored, and "Differs now" on same-day evidence is correct, so it is not flagged. Recorded as
`errors: [{ verifyStatusContradiction }]`; the answer is never rewritten; eval key `statusMatchesEvidenceLabel` is soft (A2, A17).
Every cited labelled result is checked, so a row citing a vendor page plus an earlier third-party page can be flagged; that is
noise accepted for a soft check. The longer-term fix (code computes the status) is listed in DESIGN.md under "With another week".

## Phase 6 — Evals

**D60 — Pass/fail is deterministic; the judge is informational.** A case run passes when every hard check passes, including an
always-on `answerComplete` (an error or cut-off answer can never pass a case that only forbids things). The small-model judge scores
the rubric 1-5 with a reason and is shown per run; a score of 2 or less is flagged "review" but never changes the verdict, because a
judge from the same model family is too noisy to gate on. Soft checks (D58/D59) stay warnings. `cases.json` is validated by a strict
zod schema, so a mistyped check key fails at load instead of being skipped. `resolvedDates` is an exact set; `recallRules` exact,
`recallRulesInclude` a subset; `claimState` reads the claim chain whose current row holds the expected value. *Rejected:* gating on
the judge (flaky), substring-only date checks (would accept an extra, wrong day).

**D61 — A run is isolated, repeatable and stops cleanly.** Each case run gets a fresh SQLite file `eval/.tmp/<id>.db` (gitignored,
overwritten each run, kept for debugging), the seed, the case's frozen `now`/`tz` (the env `NOW` is ignored), and waits for
`run.done` (reply, trace and background memory write) before anything is read. Cases run one after another with `--pause-ms`
(default 4000) between model runs for the free tier. `--repeat N` runs every case N times and reports pass counts like 2/3; the
judge runs per repetition. A daily-quota error (chat model or judge) throws `QuotaExhausted`: the runner prints where it stopped,
exits 1 and writes nothing, since a half run would look like failures. Other provider errors fail only that run.

**D62 — What a run may write.** Decided by pure `resolveRunMode` (eval/policy.ts) and enforced in one place (`writeOutputs`).
Full uncached run: `eval/results.md` and `eval/transcripts/<id>.md`. `--only`: transcripts only (a subset must not replace the full
table). `--no-write`: nothing. `--cache`: nothing, and `--cache --write-results` is refused before any model call (exit 2). The
runner overwrites `DEV_LLM_CACHE` and `NOW` from the env (`evalEnvSource`): only the flag turns the cache on, and it prints the
banner at start and in the summary. The cache lives in its own file `eval/.tmp/llm-cache.db` because per-case DBs are wiped.
results.md marks each case `mock` (a fixture replaced the providers), `live`, or `live (unused)` (real search, never called).
Transcripts hold the full answers, queries, sources, check results and judge reasoning, so a reader can check the answers.

**D63 — A forced search step can never fail the turn.** The first eval run ended A13 as an error (`AI_ToolChoiceViolationError`) after
its searches had run: the SDK throws when a step with an enforced `toolChoice` gets a response that ignores it, and gives no way to
retry the step. The same error is possible on the last step (`toolChoice: none`) when a provider still returns a tool call. So the SDK
now always runs on `auto` and `agent/stepPolicy.ts` applies the choice itself. `createStepPolicy` (called from `prepareStep`) decides
each step: the last step is `none`, never forced; forced steps are capped at 3 (price pass, news pass, one top-up) and fewer when
`maxSteps` is small. `toolChoiceEnforcement` is a model middleware above the retry layer: for a forced step it calls the provider with
the tool required, and if no tool call comes back it discards that response and retries the step once on `auto`, appending an app
note that names what was not searched and tells the model to give those items "Couldn't verify". Forcing is then abandoned for the
rest of the turn (it would only fail again). For the last step it drops any tool call the provider sends and, if no text is left,
writes a fixed sentence instead of an empty answer. Every case is recorded in the trace as `errors: [{ forcedSearchViolation: [{ step,
mode, action, owed }] }]`, and `intent.recheck.forcedSteps` counts the forced steps. *Cost:* a forced step is buffered until the
model starts a tool call (no text is shown on those steps anyway); only the violation path costs a second model call. *Rejected:*
catching the error and re-running the turn (repeats every search), and `activeTools: []` for the last step (a history with tool calls
but no tool definitions is rejected by some providers).

**D64 — `noRawLinks` is a soft check.** Raw URLs in an answer break the "[n] only" style rule but not correctness, and a hard failure
for it hid real results. The trace still records `rawLinks`; eval cases list `noRawLinks` under `softChecks`, where it shows as a
warning and never fails a case.
