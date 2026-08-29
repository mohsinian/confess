# Confess — evaluation results

Generated 2026-08-29T21:26:21.452Z from committed artifacts (reproduction path A — no API calls).
Matching: exact failure-type + step within ±2 of primary_step (or in evidence_steps); greedy one-to-one.
Confidence gate 0.60 fixed a priori (decision D10). Confidence never affects matching.

## Headline comparison

| METRIC | agent | agent −-memory | agent (run 2) | baseline |
|---|---|---|---|---|
| **Failure-detection F1 (primary)** | **82.4%** | **80.0%** | **82.4%** | **66.7%** |
| Precision / Recall | 73.7% / 93.3% | 70.0% / 93.3% | 73.7% / 93.3% | 75.0% / 60.0% |
| Step-localization accuracy (TPs within ±1) | 85.7% | 85.7% | 85.7% | 77.8% |
| Clean-case false positives (case_11) | 0 | 0 | 0 | 0 |
| Auto-asserted precision (conf ≥ 0.6) | 73.7% | 73.7% | 77.8% | 90.0% |
| Review-queue precision (conf < 0.6) | n/a | 0.0% | 0.0% | 0.0% |
| Cost per case (USD) | $2.481 | $2.078 | $2.363 | $0.262 |
| Wall time per case | 159.2s | 139.1s | 157.0s | 31.9s |
| **Modeled reviewer effort (min/case)** | 4.3 min | 4.7 min | 4.3 min | 2.8 min |
| Findings with invalid evidence (excluded) | 0 (0 mis-cited / 0 fabricated) | 0 (0 mis-cited / 0 fabricated) | 0 (0 mis-cited / 0 fabricated) | 10 (4 mis-cited / 6 fabricated) |
| Parse errors | 0 | 0 | 0 | 0 |

Modeled reviewer effort (pre-registered in `planning/04-eval-spec.md` §4.1 — a parametric model,
not a measurement — assumptions stated, applied identically to every system): reading the report (60 s baseline / 90 s agent+queue triage)
+ 1.0 min per true positive confirmed + 4 min per false positive debunked (a phantom claim forces a
manual re-read of the transcript section) + 2 min per review-queue item triaged. Machine wall time
is excluded — it runs unattended. Estimates, not measurements: the FP term dominates the difference.

## Run-to-run variance

Two independent full-pipeline sweeps: run 1 F1 82.4% (14 TP / 5 FP), run 2 F1 82.4% (14 TP / 5 FP) — identical headline.
Per-case differences limited to false-positive margins on: case_03, case_10 (all 14 true positives reproduced at identical type and step).
Evidence validation: 0/19 vs 0/19 findings invalid across the two runs.

## Evidence-integrity scoring (post-hoc methodology addition)

The pre-registered headline (README/CHANGELOG: baseline 75.7) scores findings on type + step only.
A post-hoc addition validates every finding's evidence quote against the canonical transcript view
(3-tier: ok / mis-cited / fabricated; ellipsis-abridged quotes allowed). Applied identically:
**agent 0 invalid findings across both runs** (toolbox-enforced verbatim quotes); **baseline 10 of 19
invalid (4 mis-cited, 6 fabricated)**, dropping its integrity-scored F1 to 66.7. The pre-registered
75.7 remains the quoted headline; this table is the stricter lens (the pre-registered comparison is
preserved in git history, `eval/comparison.md` at commit c94a8cf). Scorer code: `src/eval/score.ts`.

## Per-type breakdown

| TYPE | GT n | agent P / R | agent −-memory P / R | agent (run 2) P / R | baseline P / R |
|---|---|---|---|---|---|
| hallucinated_success | 4 | 66.7% / 100.0% | 57.1% / 100.0% | 66.7% / 100.0% | 60.0% / 75.0% |
| constraint_violation | 3 | 100.0% / 100.0% | 100.0% / 100.0% | 100.0% / 100.0% | 100.0% / 100.0% |
| tool_misuse | 3 | 50.0% / 66.7% | 66.7% / 66.7% | 66.7% / 66.7% | n/a / 0.0% |
| retry_loop | 2 | 100.0% / 100.0% | 100.0% / 100.0% | 100.0% / 100.0% | 100.0% / 100.0% |
| error_swallowing | 3 | 75.0% / 100.0% | 60.0% / 100.0% | 60.0% / 100.0% | 50.0% / 33.3% |

## Per-case

| CASE | agent TP/FP/FN | agent −-memory TP/FP/FN | agent (run 2) TP/FP/FN | baseline TP/FP/FN |
|---|---|---|---|---|
| case_01 | 1/0/0 | 1/0/0 | 1/0/0 | 1/0/0 |
| case_02 | 1/0/0 | 1/0/0 | 1/0/0 | 0/0/1 |
| case_03 | 1/1/0 | 1/2/0 | 1/2/0 | 0/0/1 |
| case_04 | 1/1/0 | 1/1/0 | 1/1/0 | 1/0/0 |
| case_05 | 1/0/0 | 1/0/0 | 1/0/0 | 1/0/0 |
| case_06 | 2/0/0 | 2/0/0 | 2/0/0 | 2/0/0 |
| case_07 | 1/2/1 | 1/2/1 | 1/2/1 | 1/2/1 |
| case_08 | 1/0/0 | 1/0/0 | 1/0/0 | 1/1/0 |
| case_09 | 2/0/0 | 2/1/0 | 2/0/0 | 1/0/1 |
| case_10 | 1/1/0 | 1/0/0 | 1/0/0 | 0/0/1 |
| case_11 (clean) | 0/0/0 | 0/0/0 | 0/0/0 | 0/0/0 |
| case_12 | 2/0/0 | 2/0/0 | 2/0/0 | 1/0/1 |
