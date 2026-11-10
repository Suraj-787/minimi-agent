# minimi chat agent

A chat agent with web search that **remembers what it told you and when**, and can check whether
that's still true. Ask "Last Tuesday I asked you about Postgres hosting, has any pricing changed?" and it
finds that conversation, re-checks each claim it made against fresh sources, and tells you what changed, with citations.

See [DESIGN.md](./DESIGN.md) for how and why.

## Run it (3 steps)
```bash
npm install
cp .env.example .env      # add GOOGLE_GENERATIVE_AI_API_KEY and EXA_API_KEY (or TAVILY_API_KEY)
npm run dev               # web on http://localhost:5173, API on :8787
```
Requires Node ≥ 22 (`nvm use` reads `.nvmrc`). Keys: Gemini (free at https://aistudio.google.com/apikey), Exa
(https://dashboard.exa.ai) and/or Tavily (https://app.tavily.com). To use OpenAI or Anthropic
instead, set `LLM_PROVIDER` and the matching key and model ids in `.env`.

## Try the memory features
```bash
npm run seed              # loads 4 past conversations dated 2, 3 and 9 days before today
```
Then ask:
- "What did I ask you 9 days ago? Is your answer still correct today?"
- "On Monday we shortlisted CRM tools. Has any of them changed pricing since?"
- "Summarise what we talked about this week."

## Scripts
| Script | What it does |
|---|---|
| `npm run dev` | server + web with hot reload |
| `npm run chat` | terminal chat using the same agent core |
| `npm test` | unit tests (no network) |
| `npm run eval` | full eval with fixed date + seeded history → `eval/results.md` (uses API quota) |

## Troubleshooting
- **"Rate-limited, retrying…"**: the Gemini free tier has low per-day limits. Wait, use another key, or switch provider in `.env`.
- **Can't start**: `npm run dev` checks your Node version (≥ 22) and `.env` first and tells you what's missing.
