# Confess — evaluation results

Generated 2026-08-29T12:38:29.318Z from committed artifacts (reproduction path A — no API calls).
Matching: exact failure-type + step within ±2 of primary_step (or in evidence_steps); greedy one-to-one.
Confidence gate 0.60 fixed a priori (decision D10). Confidence never affects matching.

## Headline comparison

| METRIC | agent | agent −-memory | baseline |
|---|---|---|---|
| **Failure-detection F1 (primary)** | **82.4%** | **80.0%** | **75.7%** |
| Precision / Recall | 73.7% / 93.3% | 70.0% / 93.3% | 63.6% / 93.3% |
| Step-localization accuracy (TPs within ±1) | 85.7% | 85.7% | 85.7% |
| Clean-case false positives (case_11) | 0 | 0 | 0 |
| Auto-asserted precision (conf ≥ 0.6) | 73.7% | 73.7% | 73.7% |
| Review-queue precision (conf < 0.6) | n/a | 0.0% | 0.0% |
| Cost per case (USD) | $2.481 | $2.078 | $0.262 |
| Wall time per case | 159.2s | 139.1s | 31.9s |
| **Human review time per case (est.)** | 4.3 min | 4.7 min | 4.8 min |
| Parse errors | 0 | 0 | 0 |

Human review time model (pre-registered in `planning/04-eval-spec.md` §4.1, assumptions stated,
applied identically to every system): reading the report (60 s baseline / 90 s agent+queue triage)
+ 1.0 min per true positive confirmed + 4 min per false positive debunked (a phantom claim forces a
manual re-read of the transcript section) + 2 min per review-queue item triaged. Machine wall time
is excluded — it runs unattended. Estimates, not measurements: the FP term dominates the difference.

## Per-type breakdown

| TYPE | GT n | agent P / R | agent −-memory P / R | baseline P / R |
|---|---|---|---|---|
| hallucinated_success | 4 | 66.7% / 100.0% | 57.1% / 100.0% | 40.0% / 100.0% |
| constraint_violation | 3 | 100.0% / 100.0% | 100.0% / 100.0% | 100.0% / 100.0% |
| tool_misuse | 3 | 50.0% / 66.7% | 66.7% / 66.7% | 100.0% / 66.7% |
| retry_loop | 2 | 100.0% / 100.0% | 100.0% / 100.0% | 100.0% / 100.0% |
| error_swallowing | 3 | 75.0% / 100.0% | 60.0% / 100.0% | 60.0% / 100.0% |

## Per-case

| CASE | agent TP/FP/FN | agent −-memory TP/FP/FN | baseline TP/FP/FN |
|---|---|---|---|
| case_01 | 1/0/0 | 1/0/0 | 1/0/0 |
| case_02 | 1/0/0 | 1/0/0 | 1/0/0 |
| case_03 | 1/1/0 | 1/2/0 | 1/0/0 |
| case_04 | 1/1/0 | 1/1/0 | 1/2/0 |
| case_05 | 1/0/0 | 1/0/0 | 1/1/0 |
| case_06 | 2/0/0 | 2/0/0 | 2/0/0 |
| case_07 | 1/2/1 | 1/2/1 | 1/3/1 |
| case_08 | 1/0/0 | 1/0/0 | 1/1/0 |
| case_09 | 2/0/0 | 2/1/0 | 2/1/0 |
| case_10 | 1/1/0 | 1/0/0 | 1/0/0 |
| case_11 (clean) | 0/0/0 | 0/0/0 | 0/0/0 |
| case_12 | 2/0/0 | 2/0/0 | 2/0/0 |
