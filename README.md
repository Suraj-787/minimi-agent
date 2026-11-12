# minimi chat agent

A chat agent with web search that **remembers what it told you and when**, and can check whether
that's still true. Ask "Last Tuesday I asked you about Postgres hosting, has any pricing changed?" and it
finds that conversation, re-checks each claim it made against fresh sources, and tells you what changed, with citations.

See [DESIGN.md](./DESIGN.md) for how and why, [docs/SPEC.md](./docs/SPEC.md) for behaviour and
[docs/DECISIONS.md](./docs/DECISIONS.md) for the decision log.

## Quick start
```bash
nvm install && nvm use    # Node >= 22.12 (.nvmrc)
npm install
cp .env.example .env      # set GOOGLE_GENERATIVE_AI_API_KEY and EXA_API_KEY (or TAVILY_API_KEY)
npm run dev               # web on http://localhost:5173, API on :8787
```
`npm run dev` first checks your Node version and `.env` and tells you what is missing. Keys:
Gemini (free at https://aistudio.google.com/apikey), Exa (https://dashboard.exa.ai) and/or Tavily (https://app.tavily.com).
Use both search keys if you can: Exa is tried first and Tavily takes over when it fails.

## Environment variables
Everything lives in `.env` (see [.env.example](./.env.example)). Blank means "use the default".

| Variable | Default | What it does |
|---|---|---|
| `LLM_PROVIDER` | `google` | `google`, `openai` or `anthropic`. |
| `GOOGLE_GENERATIVE_AI_API_KEY` | – | Required when `LLM_PROVIDER=google`. |
| `OPENAI_API_KEY` | – | Required when `LLM_PROVIDER=openai`. |
| `ANTHROPIC_API_KEY` | – | Required when `LLM_PROVIDER=anthropic`. |
| `MAIN_MODEL` | `gemini-flash-lite-latest` | Model for chat and tool use. Must be set for non-Google providers. |
| `SMALL_MODEL` | `gemini-flash-lite-latest` | Model for claim extraction (the background memory write) and the eval judge. Must be set for non-Google providers. |
| `MAIN_THINKING` | `low` | Thinking effort of the steps that call tools (Google only): `default`, `minimal`, `low`, `medium`, `high` or a token budget. |
| `MAIN_THINKING_ANSWER` | `low` | Same, for the step that writes the answer. `default` is the provider's own choice, which was slow. |
| `EXA_API_KEY` | – | Primary search provider. At least one of Exa or Tavily is required. |
| `TAVILY_API_KEY` | – | Fallback search provider. |
| `PORT` | `8787` | API port. The Vite dev proxy follows it. |
| `DB_PATH` | `./data/agent.db` | SQLite file (created on first start). |
| `MAX_STEPS` | `4` | Most model steps per turn (1 to 10). |
| `NOW` | – | Freeze the clock, ISO with an offset: `2026-11-12T11:00:00+05:30`. For demos and evals only. |
| `DEV_LLM_CACHE` | `0` | `1` caches model answers on disk to save quota while developing. Ignored under `NODE_ENV=production` and never used by evals. |

## Quota: read this before you demo
`.env.example` defaults both models to **Gemini Flash-Lite**, because **Flash needs a billed key**. Free-tier limits as of 2026-11-11:

| Model | Requests/min | Requests/day |
|---|---|---|
| Flash-Lite (default) | 15 | 500 |
| Flash (`MAIN_MODEL=gemini-flash-latest`) | 5 | 20 |

- A **verify turn** ("is that still correct?") uses about **3-4 model requests** (one or two search steps, the answer, and the
  background memory write) and roughly **6-12 search requests** (one per re-checked item on the vendor's own site and one
  unrestricted, plus the news pass when you ask what shipped). A plain question uses about 2 model requests (the answer and the memory write).
- On Flash's 20/day that is about 5 verify turns. Use Flash-Lite unless you have billing.
- **Search cache.** Results are cached in SQLite for 1 hour (queries with `since` or news words such as "latest") or 24 hours (the rest).
  Verify-mode searches use `fresh: true`, which skips that cache and keeps its result for only 2 minutes, so a retry right after a
  failed turn does not repeat every live crawl. The cache therefore saves quota on ordinary questions and repeated demos,
  not on a verify turn you run for the first time. With `NOW` pinned the clock never advances, so cached entries never expire:
  run `npm run seed -- --reset` to clear them.
- A 429 shows as "Rate-limited, retrying…" and is retried; a daily limit ends in a readable error.

## Try the memory features (the demo)
`npm run seed` loads four past conversations dated 2, 3 and 9 days before *now*. Pin *now* so the dates line up with the
three target questions (3 Nov is a Tuesday, 9 Nov a Monday). Use the same `NOW` for the seed and the server:
```bash
export NOW=2026-11-12T11:00:00+05:30
npm run seed -- --reset   # stop the dev server first; --reset removes the old DB (and the search cache with it)
npm run dev
```
Then ask, in a new chat:
- "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"
- "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?"
- "What did I ask you on 3 November? Is your answer still correct today?"

Each answer ends with the sources it cites; the other pages that were searched are folded under "Other sources searched (n)".
**why?** under an answer opens the trace: which memory rules fired, which queries ran and what came back, and timings per step.
Without `NOW`, the seed is dated relative to the real date and the weekday wording ("last Tuesday") will not match.

## Scripts
| Script | What it does |
|---|---|
| `npm run dev` | server + web with hot reload |
| `npm run chat` | terminal chat using the same agent core |
| `npm run seed` | load the fake history in `eval/seed.json` (`--reset` starts from an empty DB) |
| `npm run typecheck` | `tsc` in strict mode |
| `npm test` | unit tests (no network, no LLM) |
| `npm run build` | typecheck and bundle the web app |
| `npm run smoke:clone` | fresh-clone check: clone to a temp dir, dummy `.env`, `npm install`, start server and web, probe them. No LLM or search calls. `-- --worktree` tests uncommitted changes. |
| `npm run eval` | full eval, see below. **Uses real LLM and search quota.** |

## Evals
```bash
npm run eval                           # all 20 cases, real model, then eval/results.md
npm run eval -- --resume               # skip cases already stored for these models; run again tomorrow after a daily-quota stop
npm run eval -- --only A2,A3 --repeat 3 --pause-ms 4000 --no-write
```
Each case runs on a fresh temp DB (`eval/.tmp/`) seeded from `eval/seed.json`, with its own frozen clock from
`eval/cases.json`; the runner ignores a `NOW` in your shell and never touches your own DB. Each finished case is saved at once
(a quota stop keeps what is done), and `results.md` is written only when every case is stored. `--cache` replays model answers
for development, prints a banner, and refuses to write `results.md`. Cases marked `mock` in the table use canned search
results (for poisoned pages, same-day evidence, wrong-vendor sources); `live` cases call Exa or Tavily.

### What `eval/results.md` means
- It is the output of one **uncached** run against the real model: model ids, thinking settings, repeats per case, and a summary
  (cases and runs passing, median time to first token and total, searches per turn).
- **Pass/fail comes only from deterministic checks** in `eval/checks.ts`: for example the right dates were recalled, every claim
  was re-searched, a status contradicting its evidence is flagged, no invented history, no injected instruction obeyed.
- **Soft warnings** (such as `shippedWording`, `vendorPageFirst`) do not fail a case; they mark answers worth reading.
- The **judge score** (1-5, from the small model against each case's rubric) is informational. 2 or less is flagged for review.
- One repetition per case is a smoke result, not a statistic: 20/20 here means every check passed once, not that the agent never slips.
  Use `--repeat` to see variance.
- Latency is from the free tier with Flash-Lite and depends on provider load. A verify turn is much slower than a plain one.
- Full answers are in `eval/transcripts/<case>.md`.

## Known limitations
- **Verify turns are slow.** Two forced search steps plus the answer: the first token took 14-29 s on the verify cases in
  `results.md`, against 1-8 s for most other turns. The status line shows progress while it works.
- **The model picks each row's status; code only checks it.** Mismatches are flagged in the trace but the answer is not rewritten.
  DESIGN.md describes the fix (code-assigned verdicts).
- **Memory is small on purpose:** at most 5 recalled turns, 12 claims and 4,000 characters per prompt. A long thread with more
  claims is re-checked in part.
- **Claims come from the final answer and its cited URLs**, extracted by a small model. A claim it misses is never re-checked.
- **Verify mode is triggered by regex cues** ("still correct", "changed", "since", "re-check"). A paraphrase can miss it; an odd
  phrase can trigger it.
- **A claim knows when we said it, not when the value took effect.** A page dated after our answer can show a change that was
  already in place. The status wording says "Differs now (timing unknown)" rather than guess.
- **Single user, local SQLite, no auth.** Do not expose the server to a network. Dates use the browser's timezone and English phrasing.
- **Free-tier quotas** (above) decide how many verify turns you can run in a day.
- The eval set is 20 cases written by the author, with one run each.

## Troubleshooting
- **"Rate-limited, retrying…"**: the Gemini free tier has low per-day limits. Wait, use another key, or switch provider in `.env`.
- **Slow first token on verify questions**: expected (see above); `MAIN_THINKING` and `MAIN_THINKING_ANSWER` tune it. The "why?" drawer shows model vs search time per step.
- **Can't start**: `npm run dev` checks Node (>= 22.12) and `.env` first and tells you what is missing. `nvm install && nvm use` picks up `.nvmrc`.
- **Port in use**: set `PORT` in `.env`; the web app's proxy follows it. Vite itself uses 5173.
- **`npm audit`**: clean as of 2026-11-12 (vite 8, vitest 5).
