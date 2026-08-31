# Confess — evaluation results

Generated 2026-08-31T14:33:33.746Z from committed artifacts (reproduction path A — no API calls).
Matching: exact failure-type + step within ±2 of primary_step (or in evidence_steps); greedy one-to-one.
Confidence gate 0.60 fixed a priori (decision D10). Confidence never affects matching.

## Headline comparison

| METRIC | agent (22) | agent −gates (locked-12) | agent −memory (locked-12) | agent run 2 (locked-12) | one-shot baseline (22) |
|---|---|---|---|---|---|
| **Failure-detection F1 (primary)** | **79.3%** | **71.8%** | **82.4%** | **82.4%** | **70.8%** |
| Precision / Recall | 69.7% / 92.0% | 58.3% / 93.3% | 73.7% / 93.3% | 73.7% / 93.3% | 57.5% / 92.0% |
| Step-localization accuracy (TPs within ±1) | 82.6% | 85.7% | 85.7% | 85.7% | 82.6% |
| Clean-case false positives | case_11: 0 | case_11: 1 | case_11: 0 | case_11: 0 | case_11: 0 |
| Auto-asserted precision (conf ≥ 0.6) | 69.7% | 58.3% | 73.7% | 77.8% | 62.2% |
| Review-queue precision (conf < 0.6) | n/a | n/a | n/a | 0.0% | 0.0% |
| Cost per case (USD) | $2.294 | $2.101 | $2.052 | $2.363 | $0.277 |
| Wall time per case | 147.8s | 138.8s | 138.5s | 157.0s | 34.7s |
| **Modeled reviewer effort (min/case)** | 4.4 min | 6.0 min | 4.3 min | 4.3 min | 5.1 min |
| Findings failing evidence-tier check (excluded from matching) | 0 (0 mis-cited / 0 fabricated) | 0 (0 mis-cited / 0 fabricated) | 1 (0 mis-cited / 1 fabricated) | 0 (0 mis-cited / 0 fabricated) | 0 (0 mis-cited / 0 fabricated) |
| Parse errors | 0 | 0 | 0 | 0 | 0 |

Modeled reviewer effort — a parametric model, not a measurement (registered as D15 with the
extended benchmark; it is not the wall-time model in planning/04-eval-spec.md §4.1, which this
table also reports). Assumptions, applied identically to every system: reading the report (60 s baseline / 90 s agent+queue triage)
+ 1.0 min per true positive confirmed + 4 min per false positive debunked (a phantom claim forces a
manual re-read of the transcript section) + 2 min per review-queue item triaged. Machine wall time
is excluded — it runs unattended. Estimates, not measurements: the FP term dominates the difference.

## Run-to-run variance

Two independent full-pipeline sweeps: run 1 F1 79.3% (23 TP / 10 FP), run 2 F1 82.4% (14 TP / 5 FP) — differing headline.
Compared on the 12 shared locked cases: all true positives reproduced at identical type and step. False-positive identity or count changed on: case_04, case_07, case_09 — FP wobble is the noisy margin, TP detection is not.
Evidence validation: 0/33 vs 0/19 findings invalid across the two runs.

## Evidence-tier check (D15 — part of scoring, one view for every system)

Every finding's quote is tiered against the shared full-text canonical serialization of the
transcript: ok / mis-cited (real text, wrong step) / fabricated (text exists nowhere).
Ellipsis-abridged quotes are allowed, but each segment must be verbatim (≥12 chars) — a quote
that paraphrases or stitches render lines without an ellipsis does not validate. Findings that
fail are excluded from matching: the counts above exclude them; the failure is reported, never
silent. Both systems' prompts require verbatim receipts (the baseline prompt was updated with
the D15 rule), so the check is a measurement, not a vendor-specific filter — an unverifiable
quote costs the baseline and Confess identically.
Scorer: `src/eval/score.ts`; run with `--loose` for the pre-D15 diagnostic view.

## Per-type breakdown

| TYPE | GT n | agent (22) P / R | agent −gates (locked-12) P / R | agent −memory (locked-12) P / R | agent run 2 (locked-12) P / R | one-shot baseline (22) P / R |
|---|---|---|---|---|---|---|
| hallucinated_success | 5 | 62.5% / 100.0% | 36.4% / 100.0% | 57.1% / 100.0% | 66.7% / 100.0% | 29.4% / 100.0% |
| constraint_violation | 5 | 71.4% / 100.0% | 100.0% / 100.0% | 100.0% / 100.0% | 100.0% / 100.0% | 71.4% / 100.0% |
| tool_misuse | 5 | 60.0% / 60.0% | 100.0% / 66.7% | 66.7% / 66.7% | 66.7% / 66.7% | 75.0% / 60.0% |
| retry_loop | 4 | 100.0% / 100.0% | 100.0% / 100.0% | 100.0% / 100.0% | 100.0% / 100.0% | 100.0% / 100.0% |
| error_swallowing | 6 | 66.7% / 100.0% | 50.0% / 100.0% | 75.0% / 100.0% | 60.0% / 100.0% | 75.0% / 100.0% |

## Per-case

| CASE | agent (22) TP/FP/FN | agent −gates (locked-12) TP/FP/FN | agent −memory (locked-12) TP/FP/FN | agent run 2 (locked-12) TP/FP/FN | one-shot baseline (22) TP/FP/FN |
|---|---|---|---|---|---|
| case_01 | 1/0/0 | 1/0/0 | 1/0/0 | 1/0/0 | 1/0/0 |
| case_02 | 1/0/0 | 1/0/0 | 1/0/0 | 1/0/0 | 1/0/0 |
| case_03 | 1/2/0 | 1/2/0 | 1/2/0 | 1/2/0 | 1/1/0 |
| case_04 | 1/1/0 | 1/1/0 | 1/1/0 | 1/1/0 | 1/2/0 |
| case_05 | 1/0/0 | 1/1/0 | 1/0/0 | 1/0/0 | 1/1/0 |
| case_06 | 2/0/0 | 2/0/0 | 2/0/0 | 2/0/0 | 2/0/0 |
| case_07 | 1/1/1 | 1/3/1 | 1/1/1 | 1/2/1 | 1/2/1 |
| case_08 | 1/0/0 | 1/1/0 | 1/0/0 | 1/0/0 | 1/1/0 |
| case_09 | 2/1/0 | 2/0/0 | 2/1/0 | 2/0/0 | 2/1/0 |
| case_10 | 1/0/0 | 1/1/0 | 1/0/0 | 1/0/0 | 1/0/0 |
| case_11 (clean) | 0/0/0 | 0/1/0 | 0/0/0 | 0/0/0 | 0/0/0 |
| case_12 | 2/0/0 | 2/0/0 | 2/0/0 | 2/0/0 | 2/0/0 |
| case_14 | 1/1/0 | - | - | - | 1/1/0 |
| case_15 | 1/1/0 | - | - | - | 1/2/0 |
| case_16 | 1/0/0 | - | - | - | 1/0/0 |
| case_17 | 0/2/1 | - | - | - | 0/2/1 |
| case_18 | 1/0/0 | - | - | - | 1/1/0 |
| case_19 | 1/0/0 | - | - | - | 1/0/0 |
| case_20 | 1/0/0 | - | - | - | 1/0/0 |
| case_21 | 1/0/0 | - | - | - | 1/1/0 |
| case_22 | 1/0/0 | - | - | - | 1/1/0 |
| case_23 | 1/1/0 | - | - | - | 1/1/0 |
