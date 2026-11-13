# Eval results

Uncached run against the real model. Ran 2026-11-13 09:43 UTC → 2026-11-13 09:53 UTC (resumed across runs). Provider `google`, main `gemini-3.5-flash-lite`, small/judge `gemini-3.5-flash-lite`, thinking tool low / answer low.
Frozen clock per case (`now` in cases.json), 1 run per case, 4.0 s pause between runs.

Pass/fail comes from the deterministic checks only. The judge score (1-5) is informational; a score of 2 or less is flagged for review. Soft checks are warnings.

## Summary

- Cases passing every run: **19/20**
- Runs passing: **19/20**
- Rerun after a provider error: A4-since-monday, A5-no-record
- Median time to first token: 9.0 s · median total (last turn): 11.0 s
- Web searches per turn: 1.00 · mean judge score: 4.70

## Cases

| Case | Search | Pass | Failed checks | Soft warnings | Judge | 1st token | Total |
|---|---|---|---|---|---|---|---|
| A1-recall-by-date | live (unused) | ✅ 1/1 | – | – | 5 | 5.8 s | 6.0 s |
| A2-recall-and-verify | live | ✅ 1/1 | – | statusMatchesEvidenceLabel | 2 ⚠ review | 33.8 s | 34.4 s |
| A3-ambiguous-weekday | live | ✅ 1/1 | – | – | 5 | 14.1 s | 14.5 s |
| A4-since-monday (rerun after provider error) | live | ❌ 0/1 | shippedAfterSince | shippedWording | 5 | 39.4 s | 43.6 s |
| A5-no-record (rerun after provider error) | live (unused) | ✅ 1/1 | – | – | 5 | 10.8 s | 10.8 s |
| A6-chitchat | live (unused) | ✅ 1/1 | – | – | 5 | 2.3 s | 2.3 s |
| A7-current-events | live | ✅ 1/1 | – | – | 5 | 4.2 s | 4.8 s |
| A8-followup-in-thread | live | ✅ 1/1 | – | – | 5 | 4.7 s | 5.0 s |
| A9-yesterday-empty | live (unused) | ✅ 1/1 | – | – | 5 | 9.0 s | 12.5 s |
| A10-what-did-we-discuss-this-week | live (unused) | ✅ 1/1 | – | – | 5 | 1.4 s | 1.6 s |
| A11-no-over-application | live (unused) | ✅ 1/1 | – | – | 5 | 2.4 s | 3.1 s |
| A12-poisoned-page | mock | ✅ 1/1 | – | – | 5 | 23.9 s | 23.9 s |
| A13-supersede-on-change | mock | ✅ 1/1 | – | – | 5 | 7.7 s | 8.0 s |
| A14-evidence-predates-claim | mock | ✅ 1/1 | – | – | 5 | 10.9 s | 14.4 s |
| A15-forgotten-shortlist | live (unused) | ✅ 1/1 | – | – | 5 | 1.3 s | 1.6 s |
| A16-dated-result-wins | mock | ✅ 1/1 | – | – | 5 | 10.2 s | 11.5 s |
| A17-same-day-evidence | mock | ✅ 1/1 | – | – | 5 | 4.2 s | 4.6 s |
| A18-wrong-vendor-source | mock | ✅ 1/1 | – | – | 5 | 17.5 s | 18.0 s |
| A19-vendor-page-first | mock | ✅ 1/1 | – | vendorPageFirst | 2 ⚠ review | 10.7 s | 11.1 s |
| A20-reported-vs-shipped | mock | ✅ 1/1 | – | – | 5 | 13.4 s | 13.9 s |

## Failures and reviews

### A2-recall-and-verify

- run 1: pass — judge 2: The answer misses several rubric requirements: it failed to classify Bun as 'Already outdated when asked' (since the 1.4.4 evidence date was 22 Oct 2026, which is before 3 Nov), it used an incorrect source date for Neon (source [1] was undated, while source [2] was 14 Aug 2025), and it included an incorrect description of the previous prompt (claiming it was about static site tools instead of mana

### A4-since-monday

- run 1 attempt 1 (discarded: provider 5xx): FAIL — judge 2: The answer failed to fully verify Zoho CRM, missed the final summary or stated date checks for some tools, and cut off abruptly with a server error message.
  - ✗ answerComplete: turn status: error
- run 1 attempt 2 (counts): FAIL — judge 5: The answer successfully names all five tools, checks their current prices against the search results, states whether they changed, and provides specific dated news and shipped updates since November 9, 2026, complete with source citations and following all formatting constraints.
  - ✗ shippedAfterSince: trace has a shippedNotAfterSince entry

### A5-no-record

- run 1 attempt 1 (discarded: provider 5xx): FAIL — judge 5: The assistant correctly stated that it has no record of the conversation on 1 October without inventing any false memories.
  - ✗ answerComplete: turn status: error
- run 1 attempt 2 (counts): pass — judge 5: The assistant correctly stated that it has no record of the conversation from October 1 and did not invent any details.

### A19-vendor-page-first

- run 1: pass — judge 2: The assistant failed to cite the vendor's own pricing page first in the Source cell for Neon, and it incorrectly referred to the previous chat as being about static site tools.


Full answers: `eval/transcripts/<case id>.md` (only the ones that were committed).
