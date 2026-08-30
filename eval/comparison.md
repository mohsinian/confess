# Confess — evaluation results

Generated 2026-08-30T19:47:17.259Z from committed artifacts (reproduction path A — no API calls).
Matching: exact failure-type + step within ±2 of primary_step (or in evidence_steps); greedy one-to-one.
Confidence gate 0.60 fixed a priori (decision D10). Confidence never affects matching.

## Headline comparison

| METRIC | agent | agent −gates | agent −-memory | agent (run 2) | baseline |
|---|---|---|---|---|---|
| **Failure-detection F1 (primary)** | **82.4%** | **71.8%** | **80.0%** | **82.4%** | **75.7%** |
| Precision / Recall | 73.7% / 93.3% | 58.3% / 93.3% | 70.0% / 93.3% | 73.7% / 93.3% | 63.6% / 93.3% |
| Step-localization accuracy (TPs within ±1) | 85.7% | 85.7% | 85.7% | 85.7% | 85.7% |
| Clean-case false positives (case_11) | 0 | 1 | 0 | 0 | 0 |
| Auto-asserted precision (conf ≥ 0.6) | 73.7% | 58.3% | 73.7% | 77.8% | 73.7% |
| Review-queue precision (conf < 0.6) | n/a | n/a | 0.0% | 0.0% | 0.0% |
| Cost per case (USD) | $2.481 | $2.101 | $2.078 | $2.363 | $0.262 |
| Wall time per case | 159.2s | 138.8s | 139.1s | 157.0s | 31.9s |
| **Modeled reviewer effort (min/case)** | 4.3 min | 6.0 min | 4.7 min | 4.3 min | 4.8 min |
| Findings failing evidence-tier check (diagnostic) | 0 (0 mis-cited / 0 fabricated) — counted in the scores above | 0 (0 mis-cited / 0 fabricated) — counted in the scores above | 0 (0 mis-cited / 0 fabricated) — counted in the scores above | 0 (0 mis-cited / 0 fabricated) — counted in the scores above | 10 (4 mis-cited / 6 fabricated) — counted in the scores above |
| Parse errors | 0 | 0 | 0 | 0 | 0 |

Modeled reviewer effort — a parametric model, not a measurement; the formula was added AFTER the
benchmark ran (it is not the wall-time model in planning/04-eval-spec.md §4.1, which this table
also reports). Assumptions, applied identically to every system: reading the report (60 s baseline / 90 s agent+queue triage)
+ 1.0 min per true positive confirmed + 4 min per false positive debunked (a phantom claim forces a
manual re-read of the transcript section) + 2 min per review-queue item triaged. Machine wall time
is excluded — it runs unattended. Estimates, not measurements: the FP term dominates the difference.

## Run-to-run variance

Two independent full-pipeline sweeps: run 1 F1 82.4% (14 TP / 5 FP), run 2 F1 82.4% (14 TP / 5 FP) — identical headline.
All true positives reproduced at identical type and step. False-positive identity or count changed on: case_03, case_04, case_07, case_10 — FP wobble is the noisy margin, TP detection is not.
Evidence validation: 0/19 vs 0/19 findings invalid across the two runs.

## Evidence-tier check (diagnostic, asymmetric by design)

Every finding's quote is tiered against the per-system transcript view: ok / mis-cited (real text,
wrong step) / fabricated (text exists nowhere). Ellipsis-abridged quotes are allowed. The tiers
are a DIAGNOSTIC — the scores above use the pre-registered matching (baseline F1 75.7); run the
scorer with --strict to exclude tier-failing findings (baseline drops to 66.7 under that lens).

Known asymmetry, by design: Confess's findings are verbatim-enforced by its own tool layer, so
they cannot fail this check — that is the product, not a scoring property. The one-shot baseline
quotes loosely (serializer lines joined, elisions without ellipses) and accumulates tier failures;
loose-but-real quotes can also be labeled fabricated by segment matching, so the strict lens is
harsher FOR the baseline than for Confess. Both facts are the product story.
Scorer: `src/eval/score.ts`.

## Per-type breakdown

| TYPE | GT n | agent P / R | agent −gates P / R | agent −-memory P / R | agent (run 2) P / R | baseline P / R |
|---|---|---|---|---|---|---|
| hallucinated_success | 4 | 66.7% / 100.0% | 36.4% / 100.0% | 57.1% / 100.0% | 66.7% / 100.0% | 40.0% / 100.0% |
| constraint_violation | 3 | 100.0% / 100.0% | 100.0% / 100.0% | 100.0% / 100.0% | 100.0% / 100.0% | 100.0% / 100.0% |
| tool_misuse | 3 | 50.0% / 66.7% | 100.0% / 66.7% | 66.7% / 66.7% | 66.7% / 66.7% | 100.0% / 66.7% |
| retry_loop | 2 | 100.0% / 100.0% | 100.0% / 100.0% | 100.0% / 100.0% | 100.0% / 100.0% | 100.0% / 100.0% |
| error_swallowing | 3 | 75.0% / 100.0% | 50.0% / 100.0% | 60.0% / 100.0% | 60.0% / 100.0% | 60.0% / 100.0% |

## Per-case

| CASE | agent TP/FP/FN | agent −gates TP/FP/FN | agent −-memory TP/FP/FN | agent (run 2) TP/FP/FN | baseline TP/FP/FN |
|---|---|---|---|---|---|
| case_01 | 1/0/0 | 1/0/0 | 1/0/0 | 1/0/0 | 1/0/0 |
| case_02 | 1/0/0 | 1/0/0 | 1/0/0 | 1/0/0 | 1/0/0 |
| case_03 | 1/1/0 | 1/2/0 | 1/2/0 | 1/2/0 | 1/0/0 |
| case_04 | 1/1/0 | 1/1/0 | 1/1/0 | 1/1/0 | 1/2/0 |
| case_05 | 1/0/0 | 1/1/0 | 1/0/0 | 1/0/0 | 1/1/0 |
| case_06 | 2/0/0 | 2/0/0 | 2/0/0 | 2/0/0 | 2/0/0 |
| case_07 | 1/2/1 | 1/3/1 | 1/2/1 | 1/2/1 | 1/3/1 |
| case_08 | 1/0/0 | 1/1/0 | 1/0/0 | 1/0/0 | 1/1/0 |
| case_09 | 2/0/0 | 2/0/0 | 2/1/0 | 2/0/0 | 2/1/0 |
| case_10 | 1/1/0 | 1/1/0 | 1/0/0 | 1/0/0 | 1/0/0 |
| case_11 (clean) | 0/0/0 | 0/1/0 | 0/0/0 | 0/0/0 | 0/0/0 |
| case_12 | 2/0/0 | 2/0/0 | 2/0/0 | 2/0/0 | 2/0/0 |
