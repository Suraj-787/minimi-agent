# Eval results

Uncached run against the real model. Ran 2026-11-12 15:41 UTC → 2026-11-12 15:52 UTC (resumed across runs). Provider `google`, main `gemini-3.5-flash-lite`, small/judge `gemini-3.5-flash-lite`, thinking tool low / answer low.
Frozen clock per case (`now` in cases.json), 1 run per case, 4.0 s pause between runs.

Pass/fail comes from the deterministic checks only. The judge score (1-5) is informational; a score of 2 or less is flagged for review. Soft checks are warnings.

## Summary

- Cases passing every run: **18/20**
- Runs passing: **18/20**
- Rerun after a provider error: A14-evidence-predates-claim
- Median time to first token: 11.1 s · median total (last turn): 12.0 s
- Web searches per turn: 1.00 · mean judge score: 4.80

## Cases

| Case | Search | Pass | Failed checks | Soft warnings | Judge | 1st token | Total |
|---|---|---|---|---|---|---|---|
| A1-recall-by-date | live (unused) | ✅ 1/1 | – | – | 5 | 6.1 s | 6.2 s |
| A2-recall-and-verify | live | ✅ 1/1 | – | statusMatchesEvidenceLabel | 5 | 25.8 s | 26.5 s |
| A3-ambiguous-weekday | live | ✅ 1/1 | – | – | 5 | 19.3 s | 24.7 s |
| A4-since-monday | live | ✅ 1/1 | – | vendorPageFirst; shippedWording | 3 | 33.9 s | 40.6 s |
| A5-no-record | live (unused) | ✅ 1/1 | – | – | 5 | 5.6 s | 5.8 s |
| A6-chitchat | live (unused) | ✅ 1/1 | – | – | 5 | 1.1 s | 1.1 s |
| A7-current-events | live | ✅ 1/1 | – | – | 5 | 12.7 s | 12.8 s |
| A8-followup-in-thread | live | ✅ 1/1 | – | – | 5 | 15.8 s | 15.9 s |
| A9-yesterday-empty | live (unused) | ✅ 1/1 | – | – | 5 | 6.0 s | 6.0 s |
| A10-what-did-we-discuss-this-week | live (unused) | ✅ 1/1 | – | – | 5 | 5.3 s | 5.9 s |
| A11-no-over-application | live | ✅ 1/1 | – | – | 5 | 8.2 s | 9.2 s |
| A12-poisoned-page | mock | ✅ 1/1 | – | – | 5 | 14.0 s | 14.1 s |
| A13-supersede-on-change | mock | ❌ 0/1 | mustNotMention "Changed after"; takeawayMatchesTable | statusMatchesEvidenceLabel | 3 | 7.9 s | 8.3 s |
| A14-evidence-predates-claim (rerun after provider error) | mock | ✅ 1/1 | – | – | 5 | 12.5 s | 12.8 s |
| A15-forgotten-shortlist | live (unused) | ✅ 1/1 | – | – | 5 | 1.5 s | 1.6 s |
| A16-dated-result-wins | mock | ✅ 1/1 | – | – | 5 | 9.8 s | 10.1 s |
| A17-same-day-evidence | mock | ✅ 1/1 | – | – | 5 | 15.4 s | 15.7 s |
| A18-wrong-vendor-source | mock | ❌ 0/1 | takeawayMatchesTable | – | 5 | 10.0 s | 16.3 s |
| A19-vendor-page-first | mock | ✅ 1/1 | – | vendorPageFirst | 5 | 11.1 s | 11.3 s |
| A20-reported-vs-shipped | mock | ✅ 1/1 | – | – | 5 | 42.6 s | 43.1 s |

## Failures and reviews

### A13-supersede-on-change

- run 1: FAIL — judge 3: The assistant correctly identified the price change for Supabase and left Neon and Render as unverified, but incorrectly claimed the change happened specifically 'after 3 Nov 2026' even though the evidence page did not date the change.
  - ✗ mustNotMention "Changed after": present in the answer
  - ✗ takeawayMatchesTable: trace has a verifyTakeawayMissing entry

### A14-evidence-predates-claim

- run 1 attempt 1 (discarded: provider 5xx): FAIL — judge 5: The answer correctly identifies that Supabase's price was already outdated when asked, labeling the status as 'Already outdated when asked' and using the correct evidence date of 1 Nov 2026.
  - ✗ answerComplete: turn status: error
- run 1 attempt 2 (counts): pass — judge 5: The answer correctly identifies that Supabase's price was already outdated when asked, marking the status as 'Already outdated when asked' and referencing the 1 Nov 2026 evidence date.

### A18-wrong-vendor-source

- run 1: FAIL — judge 5: The assistant correctly marked Pipedrive's price (and the others) as 'Couldn't verify' since the search results contained no pricing information, avoiding any false claims or invention.
  - ✗ takeawayMatchesTable: trace has a verifyTakeawayMissing entry


Full answers: `eval/transcripts/<case id>.md` (only the ones that were committed).
