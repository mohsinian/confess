# confess-audit

> **Judges / hackathon reviewers:** start with [SUBMISSION.md](SUBMISSION.md) — problem, bottleneck, results, hard case, and provenance. The improvement changelog is [CHANGELOG.md](CHANGELOG.md); the reproduction guide is [REPRODUCTION.md](REPRODUCTION.md).

**Every agent tells a story. Confess checks the receipts.**

`confess-audit` audits the session transcripts of AI coding agents and reports which steps
failed, what kind of failure it was, the verbatim evidence, a suggested fix, and a confidence
score. Findings below the confidence line go to a human review queue instead of being asserted.

Works with Claude Code session logs today (`~/.claude/projects/**/*.jsonl`).

## Quick start

```bash
npx confess-audit                       # audit your most recent Claude Code session
npx confess-audit --list                # browse sessions, newest first
npx confess-audit <file.jsonl>          # audit a specific transcript
npx confess-audit --off verify,memory   # cheaper pass (detectors + diagnosis agent)
```

Credentials: `ANTHROPIC_API_KEY` (direct Anthropic) or `ANTHROPIC_AUTH_TOKEN` +
`ANTHROPIC_BASE_URL` (any Anthropic-compatible router) — via environment variables or a
`.env` in the working directory.

The command confirms the model and expected cost before the first API call (`--yes` skips
the prompt). A typical audit costs ~$1–3 and takes 1–3 minutes. Findings print to the
terminal; the full report lands in `./confess-reports/<session>/report.md`.

## What it detects

| Type | Signature |
|---|---|
| `hallucinated_success` | claims "tests pass" — nearest tool result shows failures |
| `constraint_violation` | tool call touches what the user explicitly banned earlier |
| `tool_misuse` | wrong args / wrong tool, error or wrong data, correct usage was apparent |
| `retry_loop` | same failing call, materially identical args, 3+ times, no adaptation |
| `error_swallowing` | a real error result; next turn neither acknowledges nor adapts |

Acknowledged errors, adapted retries, and fail-then-fixed sequences are **not** failures —
enforcing that boundary is where most of the engineering went.

## How it works

Seven stages — deterministic code where code is better, an LLM where judgment is needed,
and gates that make assertions expensive:

```
trajectory.jsonl (the session log)
 1. parse          code    tool_use↔tool_result pairing, exit codes
 2. detectors      code    retry loops; ignored-error signals
 3. claims         LLM     every checkable assertion the agent made, step-linked
 4. verify         code    claim vs tool_result: SUPPORTED / CONTRADICTED / UNVERIFIABLE (rule ids)
 5. memory         LLM+code  constraint ledger: user's rules checked against every later tool call
 6. diagnose       agent   tool-use loop: read_steps, search_log, verify_claim, record_finding,
                           submit_report — with rejection guardrails
 7. gate + report  code    confidence < 0.60 → human review queue; report.json + report.md
```

The guardrails are the point: `record_finding` **rejects** a `hallucinated_success` finding
unless a claim near that step was actually CONTRADICTED by the verifier; rejects an
`error_swallowing` finding whose cited result isn't a real failure; rejects duplicate findings;
rejects evidence quotes that aren't verbatim substrings of the cited step; and `submit_report`
is refused if the agent never examined the log. Every rejection is logged and the agent adapts.

Confess is **read-only analysis**: it never executes the commands in the log it audits.

## Reading a report

- **Asserted findings** carry type, step, verbatim evidence quote, confidence, and a suggested fix.
- **Review queue** — findings below 0.60 confidence are routed for a qualified human, not auto-asserted.
- **Truncation honesty** — if the cost guard stops an audit early, the report is labeled
  *truncated — partial, not a clean verdict*. Never "No failures detected."

## Cost control

- Typical audit ~$1–3 with an Opus-class model; per-audit hard cap via `MAX_RUN_COST`
  (default $8.00).
- Cheaper pass: `--off verify,memory` (detectors + diagnosis agent only).
- Very large sessions can exceed the cap — raise `MAX_RUN_COST` or use the cheaper pass.

## Privacy

Read-only. Transcript quotes stay on your machine except for the model provider you
configure. Reports land in `./confess-reports/`. No telemetry.

## Benchmark

On a 22-session synthetic benchmark with planted failures (labels exact by construction),
the gated pipeline beats a one-shot "find the failures" prompt over the same logs, same model:

| METRIC | one-shot prompt | confess-audit |
|---|---|---|
| Failure-detection F1 | 70.8% | **79.3%** |
| Precision / Recall | 57.5% / 92.0% | 69.7% / 92.0% |
| False positives | 17 | **10** |
| Cost per session | $0.28 | $2.29 |

Stability: two independent sweeps on the original locked-12 subset produced **identical
headlines** (F1 82.4, 14 TP / 5 FP / 1 FN — all true positives at identical type and step).
The dataset was then extended to 22 sessions (8 scenario packs; cases 13/24 pending provider
regeneration) and the precision advantage **scaled with n**: recall identical at 92.0%, false
positives 17 vs 10. Evidence integrity: every Confess finding in the committed sweeps
quote-verifies against the transcript; the tier diagnostic exists because an earlier sweep
showed 10 quote failures (4 mis-cited, 6 fabricated) — kept as a regression guard. Full tables,
per-type breakdowns, ablations, and the tier diagnostic: [eval/comparison.md](eval/comparison.md).
The iteration-by-iteration development story: [CHANGELOG.md](CHANGELOG.md).
The honest shape of the win: recall is identical to the baseline — the gain is precision
(17 → 10 false positives across 22 sessions), i.e. less reviewer time spent debunking invented
failings, at ~$2 more per session. Machine wall time runs unattended and is reported separately.

- **The review queue never fired in the benchmark** — every agent finding scored ≥ 0.60
  confidence, so review-queue precision has no data points yet. The gate is exercised and
  correct in code (low-confidence findings route to a human and are labeled partial), but its
  *calibration* is unmeasured until the benchmark includes deliberately ambiguous cases.
- **Verification heuristics are labeled, not perfect** — verdicts carry rule ids
  (`tests.exit_and_counts`, `tests.failing_checkrun`, …) so machine-exact checks are
  distinguishable from pattern inference; path normalization (relative vs absolute,
  `../` traversal) is future work.
## Known limitations

- **Exit-code markers** — deterministic verification keys on a `[exit code: N]` suffix when
  present; Claude Code results don't carry it, so those rules fall back to matching pass/fail
  counts in the command output.
- **Format support** — Claude Code transcripts today. The pipeline's input format is plain
  JSONL (user/assistant events with text / tool_use / tool_result blocks); supporting another
  agent means writing one adapter.
- **Context size** — very long sessions cost more and can hit the budget cap; the audit then
  stops and says so honestly.

## Development

```bash
git clone https://github.com/mohsinian/confess.git
cd confess && npm ci
npm run selftest                    # 59 no-LLM checks
npm run build                       # emit dist/
npm run eval -- --run agent         # re-score committed runs offline (no API key)
npm run confess -- --list           # run the CLI from source
```

Full reproduction guide (offline re-scoring, dataset regeneration, ablations):
[REPRODUCTION.md](REPRODUCTION.md).

## License

[MIT](LICENSE)
