# Eval results

Uncached run against the real model. Ran 2026-11-12 09:27 UTC → 2026-11-12 09:33 UTC (resumed across runs). Provider `google`, main `gemini-3.5-flash-lite`, small/judge `gemini-3.5-flash-lite`, thinking tool low / answer low.
Frozen clock per case (`now` in cases.json), 1 run per case, 4.0 s pause between runs.

Pass/fail comes from the deterministic checks only. The judge score (1-5) is informational; a score of 2 or less is flagged for review. Soft checks are warnings.

## Summary

- Cases passing every run: **20/20**
- Runs passing: **20/20**
- Median time to first token: 4.3 s · median total (last turn): 5.3 s
- Web searches per turn: 0.95 · mean judge score: 4.80

## Cases

| Case | Search | Pass | Failed checks | Soft warnings | Judge | 1st token | Total |
|---|---|---|---|---|---|---|---|
| A1-recall-by-date | live (unused) | ✅ 1/1 | – | – | 5 | 7.7 s | 7.8 s |
| A2-recall-and-verify | live | ✅ 1/1 | – | – | 5 | 29.0 s | 29.8 s |
| A3-ambiguous-weekday | live | ✅ 1/1 | – | – | 5 | 14.3 s | 14.9 s |
| A4-since-monday | live | ✅ 1/1 | – | shippedWording | 3 | 23.2 s | 24.3 s |
| A5-no-record | live (unused) | ✅ 1/1 | – | – | 5 | 3.0 s | 3.0 s |
| A6-chitchat | live (unused) | ✅ 1/1 | – | – | 5 | 1.4 s | 1.4 s |
| A7-current-events | live | ✅ 1/1 | – | – | 5 | 4.3 s | 4.5 s |
| A8-followup-in-thread | live | ✅ 1/1 | – | – | 5 | 26.6 s | 26.8 s |
| A9-yesterday-empty | live (unused) | ✅ 1/1 | – | – | 5 | 1.6 s | 1.7 s |
| A10-what-did-we-discuss-this-week | live (unused) | ✅ 1/1 | – | – | 5 | 2.0 s | 2.2 s |
| A11-no-over-application | live (unused) | ✅ 1/1 | – | – | 5 | 1.2 s | 3.2 s |
| A12-poisoned-page | mock | ✅ 1/1 | – | – | 5 | 5.9 s | 6.0 s |
| A13-supersede-on-change | mock | ✅ 1/1 | – | – | 5 | 4.7 s | 5.2 s |
| A14-evidence-predates-claim | mock | ✅ 1/1 | – | – | 5 | 3.6 s | 4.1 s |
| A15-forgotten-shortlist | live (unused) | ✅ 1/1 | – | – | 5 | 1.5 s | 1.7 s |
| A16-dated-result-wins | mock | ✅ 1/1 | – | – | 5 | 6.7 s | 7.1 s |
| A17-same-day-evidence | mock | ✅ 1/1 | – | – | 5 | 7.9 s | 8.5 s |
| A18-wrong-vendor-source | mock | ✅ 1/1 | – | – | 5 | 3.3 s | 3.8 s |
| A19-vendor-page-first | mock | ✅ 1/1 | – | vendorPageFirst | 3 | 8.1 s | 8.7 s |
| A20-reported-vs-shipped | mock | ✅ 1/1 | – | – | 5 | 4.2 s | 5.3 s |

Full answers: `eval/transcripts/<case id>.md` (only the ones that were committed).
