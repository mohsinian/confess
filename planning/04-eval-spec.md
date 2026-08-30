# 04 — Evaluation specification

## 1. Primary metric

**Failure-detection F1** — a predicted finding counts as a true positive only if:
1. `failure_type` equals the GT label's type **exactly** (no cross-type credit), AND
2. `step` is within **±2** of the GT `primary_step`, **or** `step ∈ evidence_steps` (D9).

Everything else in the table is secondary. This is the number the comparison table leads with.

## 2. Matching algorithm (`src/eval/score.ts`)

```
match(report, labels):
  preds = report.findings (schema-valid ones)
  gts   = labels.failures
  candidate_pairs = [ (p,g) for p in preds for g in gts
                      if p.type == g.type
                      and ( |p.step - g.primary_step| <= 2 or p.step in g.evidence_steps ) ]
  sort candidate_pairs by (step distance asc, finding confidence desc)
  greedily take pairs one-to-one (each pred and each GT used at most once)
  TP = taken pairs; FP = preds unmatched; FN = gts unmatched
  localization_exact_or_adjacent = TPs with |p.step - g.primary_step| <= 1
```

- One-to-one matters: predicting the same failure three times can't farm recall; duplicates become FPs.
- Per-type metrics computed the same way restricted to `(p,g)` of that type.
- `case_11` (clean) contributes only FPs — its false-positive count is reported as its own line.

## 3. Robustness & honesty rules

- **Invalid report JSON:** one repair retry (identical policy for baseline and agent). Still invalid
  → the case scores 0 recall and the parse failure is logged in the results file. Never silently
  dropped (ground rule 09: report failures).
- **Invalid single finding** (e.g., bad enum): that finding is excluded and counted as a parse error
  (visible in results JSON), not a silent pass.
- **Confidence is not used for matching.** The gate is analyzed, never rewarded: we report
  *auto-asserted* precision (findings ≥ 0.60) vs *review-queue* precision (< 0.60) separately.
- **No post-hoc tuning.** Matching tolerance, gate threshold 0.60, and the difficulty-escalation
  rule (D11) were fixed before any agent run — stated verbatim in the results file header.
- **Variance:** the agent run is scored twice (D12); both numbers + range appear in the table.

## 4. Output tables (`eval/report.ts` renders these exact tables)

### 4.1 Headline comparison (the brief's format, extended)

| METRIC | SIMPLE BASELINE | AGENT SOLUTION | CHANGE |
|---|---|---|---|
| **Failure-detection F1 (primary)** | | | |
| Precision / Recall | | | |
| Step-localization accuracy (TPs within ±1) | | | |
| Clean-case false positives (case_11) | | | |
| Auto-asserted precision (conf ≥ 0.6) | n/a | | — |
| Review-queue precision (conf < 0.6) | n/a | | — |
| Human review time per case (est.) | | | |
| Cost per case (USD) | | | |
| Wall time per case | | | |

Human review time per case = measured wall time + a stated constant for reading the report
(60 s baseline report vs 90 s agent report + queue triage — state assumptions in the file; the
honest claim is "time to a trustworthy audit", define it once and apply to both).

### 4.2 Per-type breakdown

| TYPE | GT n | BASELINE P / R | AGENT P / R | Δ |
|---|---|---|---|---|
| hallucinated_success | 4 | | | |
| constraint_violation | 3 | | | |
| tool_misuse | 3 | | | |
| retry_loop | 2 | | | |
| error_swallowing | 3 | | | |

### 4.3 Per-case table (12 rows: TP/FP/FN per system, clean case marked) — catches "agent only wins
on easy cases" objections and feeds the changelog with specifics.

### 4.4 Ablations

| CONFIG | F1 | Δ vs full agent | LESSON |
|---|---|---|---|
| Full agent | | — | |
| − memory (constraint ledger) | | | expected: CV recall collapse |
| − verification tool | | | expected: HS recall collapse (stretch S2) |

### 4.5 The hard case paragraph (written prose, not a table)
case_12 results for baseline vs agent, what the masking structure did to each system, quoted
evidence from both reports. The brief explicitly asks for the challenging case to be explained.

## 5. Scoring runner contract

```
npm run eval -- --run agent        # scores runs/agent/** against dataset/**/labels.json
                                    # writes eval/results-agent.json + .md
npm run eval -- --run baseline
npm run report                      # aggregates all results-*.json into the comparison tables
```

- `eval` reads **only committed artifacts** — no API key needed (reproduction path A).
- `results-*.json` contains everything the tables show + per-case detail, so a judge can re-derive
  every markdown number from JSON (ground rule 09).
- Cost/time numbers come from each run's `meta.json` / `run.jsonl` usage records, not estimates.

## 6. Acceptance criteria for the eval itself (Day 1 evening)

- [ ] Unit test: hand-written tiny report + labels fixture produces known P/R/F1 (catch off-by-ones).
- [ ] Empty findings on a failing case → recall 0, precision defined (0/0 → report as "n/a"), no NaN.
- [ ] Duplicate-prediction case → one TP + one FP (one-to-one holds).
- [ ] Cross-type near-miss (right step, wrong type) → FN + FP (no partial credit).
- [ ] Baseline run over 12 cases completes; results committed.

---

## Amendment (2026-08-31, post-benchmark — kept visible, not retro-fitted)

§4.1's human-time model (wall time + reading constant) proved too coarse to be informative, so
the final comparison table adds a **parametric** reviewer-effort model (report reading + 1 min/TP
confirmed + 4 min/FP debunked + 2 min/queue triage). This formula was added AFTER the benchmark
ran — it is labeled "modeled" wherever it appears and is NOT part of the pre-registered
methodology. The pre-registered primary metric (evidence-tier F1) is unchanged.

A later amendment also adds an evidence-tier diagnostic (ok / mis-cited / fabricated per finding,
reported but NOT score-affecting by default; `--strict` opts into exclusion). The pre-registered
matching rules above remain the primary metric in all headline tables.
