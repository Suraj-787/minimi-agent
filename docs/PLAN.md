# PLAN — phase-gated build

Rules: one phase per working session. Plan mode first. A phase is done only when every
"Done when" item passes and `/verify` is green. Tick the boxes as you go, then commit `phase N: …`.

---

## Phase 0 — Scaffold
- [x] Install runtime deps (latest compatible versions, pinned by the lockfile):
  `ai @ai-sdk/google @ai-sdk/openai @ai-sdk/anthropic @ai-sdk/react hono @hono/node-server
   better-sqlite3 chrono-node zod dotenv react react-dom react-markdown remark-gfm`
  (check that the `@ai-sdk/*` majors match `ai@7`, per the v7 docs)
- [x] Install dev deps: `typescript tsx vite @vitejs/plugin-react tailwindcss @tailwindcss/vite
   vitest concurrently @types/node @types/react @types/react-dom @types/better-sqlite3`
- [x] `vite.config.ts` (root `web/`, proxy `/api` → `http://localhost:8787`)
- [x] `src/lib/env.ts` (zod-validated env, clear error messages), `src/lib/clock.ts` (`now()` with `NOW` override)
- [x] Hono server with `GET /api/health`. Web page says "hello".
- [x] `predev` runs `scripts/check-env.mjs` (already present)

**Done when:** a fresh clone runs `npm install && npm run dev`; the browser shows the page;
`/api/health` returns `{ok:true}`; `npm run typecheck` and `npm test` pass (one clock test).

## Phase 1 — Agent loop, persistence, chat UI (no search yet)
- [x] `db/`: schema.sql with all tables from SPEC §10 and FTS5 triggers; idempotent migration on boot
- [x] `agent/model.ts`: provider and model from env (`LLM_PROVIDER`, `MAIN_MODEL`, `SMALL_MODEL`)
- [x] `agent/prompts.ts`: static system prompt (SPEC §6) + dynamic section builder
- [x] `agent/index.ts`: `runAgent(deps, input)` streams the model reply; persists both messages
- [x] `/api/chat`, `/api/threads*`; web: thread sidebar, `useChat`, markdown, Enter to send
- [x] `scripts/chat-cli.ts` uses the same `runAgent`

**Done when:** you can chat in the browser and in the CLI; refreshing keeps the history; messages have
`local_date` in the browser's timezone; tests cover the repository functions (with an in-memory DB).

## Phase 2 — Search layer + the one tool
- [x] `search/types.ts` (SearchProvider interface), `exa.ts`, `tavily.ts` (fetch + zod)
- [x] `search/index.ts`: parallel queries, timeout, fallback, dedupe, cap, per-turn numbering, SQLite cache
- [x] `agent/tools/webSearch.ts`: zod input (SPEC §5), transient `data-status` parts, source-url parts
- [x] Multi-step loop with `stopWhen` ≤ `MAX_STEPS`
- [x] Web: status line, inline [n] → sources list with domain + date

**Done when:** "What's the latest stable Node.js version?" searches, cites [n] with working links,
and shows status while searching; "hi" doesn't search; unit tests for dedupe, numbering, cache key,
fallback (with mocked providers).

## Phase 3 — Time, recall policy, context builder, seed
- [x] `agent/time.ts`: `resolveTimeRefs` (SPEC §4.2) including weekday candidates and IANA → offset
- [x] `agent/recallPolicy.ts`: pure function → `RecallPlan` with rules R0–R4 (SPEC §4.0)
- [x] `agent/context.ts`: executes the plan (local_date lookup, FTS topic match, candidate choice),
  renders the bounded `<memory>` block (SPEC §4.3), enforces char caps
- [x] `agent/prompts.ts`: static system prompt; dynamic block prepended to the latest user message only at call time (never persisted)
- [x] `scripts/seed.ts`: loads `eval/seed.json` (`daysAgo` relative to `now()`, replaces `{{date}}`, writes turn summaries + claims with `observed_at` = turn date); `--reset` flag clears the DB first.
  Generates a UUID for each seeded thread (the seed.json `id` is a label only, e.g. in the title or logs), so `/api/chat` accepts them and seeded chats can be continued in the app
- [x] Trace: resolved dates, recall rules fired, memory ids injected, memory chars

**Done when:** table-driven tests pass for: "3 November", "Nov 3", "yesterday", "on Monday",
"last Tuesday" (two candidates), "since Monday", "this week", a date with no year, timezone edge (23:30 IST is the same local day);
recall-policy tests: unrelated question → R0 only; "on Monday…" → R1; "you told me about Neon" → R2;
"still correct?" → R3; memory block never exceeds caps; system prompt string is byte-identical across turns (test);
with `NOW=2026-11-12T11:00:00+05:30` + seed, `npm run chat` → "What did I ask you on 3 November?"
lists both seeded questions without a search call.

## Phase 4 — Memory write path + verify mode
- [x] `agent/intent.ts` + tests (SPEC §8)
- [x] Replace the hardcoded `intent = { verify: false }` in `agent/index.ts` (`TODO(phase4)`) with `detectIntent(message)`, so R3 fires in the app
- [x] `memory/extract.ts`: one small-model structured call → summary + claims (SPEC §7.1), input = user msg + final answer + cited URLs only (+ recalled claim labels, D28)
- [x] `memory/scan.ts`: injection / exfiltration scanner (SPEC §15) + tests with nasty strings
- [x] `memory/reconcile.ts`: claim key normalisation + ADD / TOUCH / SUPERSEDE (SPEC §7.3), all ops logged to `memory_writes`
- [x] Verify-mode prompt section; table format; `fresh` + `domains` used for pricing pages
- [x] Recalled claims render current value + `previously:` chain
- [x] Manual-test fixes (D36–D40): evidence-date labels + status vocabulary, atomic claim values, verify coverage + forced
  news pass (6-query cap), 15 s timeout for `fresh`, no ids in `<memory>`; DESIGN.md "another week" notes
- [x] Re-check fixes (D41–D44): evidence dated against each item's claim, verify table drives the ledger, parentheses
  allowed in values, takeaway/"Shipped since" rules with a trace check

**Done when:** reconcile unit tests cover add / touch / supersede / key normalisation ("Neon " vs "neon",
"Pro plan price" vs "pro-plan price"); scanner rejects all fixtures in `tests/fixtures/injection.txt` and
accepts every line in `tests/fixtures/clean-claims.txt`; A2, A3, A4 from SPEC §14 behave as specified when run by hand;
after a verify turn with a changed value, the DB shows the old claim `superseded` and linked to the new one.

## Phase 5 — Reliability, speed, observability, memory UI
- [x] `lib/retry.ts` (429/5xx backoff + jitter) around model calls; user-visible retry status
- [x] Dev LLM cache middleware (`DEV_LLM_CACHE=1`)
- [x] Provider-failure path: both search providers down → caveated answer
- [x] `/api/debug/:turnId` + "why?" drawer (intent, dates, recall rules, memory injected, queries, latencies)
- [x] `/api/memory*` endpoints + **Memory panel** (claims by day, old→new chain, forget claim / forget chat)
- [x] Measure: context build ms, first status, time to first token, total; log one line per turn
- [x] Browser-test fixes (D50–D52): no-record rule, shipped-since check, drawer detail, [n]-only citations; eval cases A15, A16
- [x] Second browser test (D54–D56): same-day evidence label, source-matches-item check, Chat stays mounted behind the Memory tab; eval cases A17, A18
- [x] Prompt tweak (D58): vendor page first for prices, "reported" vs "shipped"; soft eval checks (`softChecks`), eval cases A19, A20; ledger skips rows whose source is not about the item (D57); soft `verifyStatusContradiction` check (D59)

**Done when:** a simulated 429 (mock) retries and then succeeds; killing the Exa key falls back to Tavily;
forgetting a claim removes it from the next turn's recall (test); the debug drawer shows a full trace; first-token latency is logged.

## Phase 6 — Evals
- [x] `eval/run.ts`: for each case → fresh temp DB → seed → optional `mockSearch` fixture replaces providers
  → run agent with case `now`/`tz` → wait for background memory writes to finish → collect output, trace, DB state
- [x] Deterministic checks from `checks` (searched?, cited?, mustMention, mustNotMention, resolved dates,
  verify table, recallRules, memoryInjected, claimState)
- [x] `eval/judge.ts`: small model scores the rubric 1–5 with a reason (structured output)
- [ ] Write `eval/results.md` (table: case, pass/fail per check, judge score, latency), uncached runs only (see below); transcripts, `--repeat`, quota stop (D60-D62)

- [x] Real model by default: the runner never installs the dev LLM cache on its own and ignores `DEV_LLM_CACHE` in the env.
  `npm run eval -- --cache` is the only way to turn it on (development iteration only); it prints a visible banner at start
  and in the summary ("CACHED RUN: model answers replayed from llm_cache, not a valid result").
- [x] `eval/results.md` is written only from an uncached run; with `--cache` the runner refuses to write it (prints where it
  would have written, exits non-zero if `--write-results` is also given) and writes nothing.

- [x] Eval-run fixes (D63, D64): a forced search step never fails the turn (retry once on auto, cap, last step never forced, `forcedSearchViolation` in the trace); `noRawLinks` is a soft check

**Done when:** `npm run eval` (uncached, real model) finishes on the free tier and results.md is committed; `--cache` shows the
banner and never touches results.md (test).

## Phase 7 — Polish + docs (+ stretch)
- [ ] DESIGN.md final (one page): fill in real numbers from traces/evals
- [ ] README: setup in 3 steps, keys, scripts, troubleshooting (429s, Node version)
- [ ] Fresh-clone test in a new folder: `npm install && npm run dev` with only `.env` added
- [ ] Remove dead code; check `npm run typecheck`, `npm test`
- [ ] Clean npm audit: raise the Node floor to 22.12 (engines, .nvmrc, check-env, README), update vitest and vite
  (and plugin-react) to the current majors, confirm `npm audit` is clean, and re-run typecheck, tests and the dev server.
- [ ] *Stretch:* quiet stale-claim hint (SPEC §16)

**Done when:** a stranger can run it in under 5 minutes, and every decision in DECISIONS.md is reflected in the code.
