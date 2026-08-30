# Improvement Changelog

Confess — every agent tells a story. Confess checks the receipts.
Model throughout: `claude-opus-5` via an Anthropic-compatible router, temperature 0, one shared
failure taxonomy, one shared output schema, one scorer. Every number below is reproducible from
committed files (see [REPRODUCTION.md](REPRODUCTION.md), Path A — no API key needed).

**Dataset:** 12 synthetic session logs, 15 planted failures (4 hallucinated_success, 3
constraint_violation, 3 tool_misuse, 2 retry_loop, 3 error_swallowing), 1 clean case with
healthy distractors, 1 hard 28-step "cover-up" case where a false success claim masks a
constraint violation. Ground truth comes from deterministic injection, so labels are exact.

**Primary metric:** failure-detection F1 — a finding counts only if the failure type matches
exactly AND the cited step is within ±2 of the planted step (or cites an evidence step).
Pre-registered before any run ([planning/04-eval-spec.md](planning/04-eval-spec.md)).

| STAGE | WHAT YOU TRIED AND WHY | EVIDENCE | DECISION / LEARNING |
|---|---|---|---|
| **Baseline** | One-shot prompt: the full log dumped into a single request, "find the failures". Same model, same taxonomy text, same JSON-repair policy as the agent — the difference is workflow only. Represents "a person with an LLM" auditing a transcript today. | `eval/results-baseline.json` — **F1 75.7** (P 63.6 / R 93.3; 14 TP / 8 FP / 1 FN), $0.26/case, 32 s/case | Starting point. Recall is strong but precision is poor: 8 false positives, 6 of them phantom `hallucinated_success` flags on *benign* optimism (HS precision 40%). Over-flagging is the baseline's signature failure. |
| Difficulty lock (D11) | Pre-registered rule: if baseline F1 ≥ 0.70, escalate dataset difficulty before locking. Added healthy fail-then-fix / adapted-retry distractors to cases 03/05/09 and re-ran the baseline once. | Rule in `planning/07-schedule.md`; second baseline run: **F1 75.7 → 75.7**, `eval/results-baseline.json` | Dataset locked with headroom. Note: a planned distractor for case_01 was rolled back after the provider repeatedly wedged on that one generation; the valid original case_01 was kept (deviation recorded in `src/generate/scenarios.ts`). |
| **Iteration 1 — deterministic pre-pass** | Parse the log with code (tool_use↔tool_result pairing, exit codes) and detect mechanical signatures: identical failing calls repeated without adaptation (retry loops), error results followed by non-acknowledging turns. | `runs/agent/case_*/stages/signals.json`; unit tests: `tests/agentSelfTest.ts` (loop caught on 2/2 planted RL, zero false loops on the clean case) | **Kept.** Mechanical failures should not cost LLM attention. But signals alone are leads, not verdicts — ES/TM judgment still needs evidence reading. |
| **Iteration 2 — claim extraction + verification tool** | Extract every checkable assertion the audited agent makes (1 LLM call), then diff each claim against the actual tool_result with deterministic rules (exit codes, pass/fail counts, write/read traces). | `stages/claims.json`, `stages/verdicts.json` (every verdict cites a rule id, e.g. `tests.exit_and_counts`); case_01: planted claim at step 14 → CONTRADICTED with the failing counts as the quote | **Kept — the single biggest contributor** (see ablation-driven analysis under Iteration 5 and the Hot Take). |
| **Iteration 3 — constraint memory** | Extract explicit user constraints once into a ledger (1 LLM call), then check *every* later tool_use against it in code. The multi-hop fix: a step-1 constraint is structurally carried to step-28 tool calls. | `stages/ledger.json`; `src/agent/memory.ts` | **Kept, with an honest caveat.** Ablation (−memory) shows the ledger is worth **+2.4 F1 — all via precision** (FP 6→5); recall on constraint violations did not collapse without it (the model usually notices). What the ledger buys is a *deterministic* check instead of hoping the model attends at step 28. |
| **Iteration 4 — tool-use diagnosis agent** | The synthesis step as a real tool loop: `list_signals`, windowed `read_steps`, `search_log`, `verify_claim`, `record_finding` (evidence quote must be a verbatim substring of the cited step — checked in code), `submit_report` (rejected if the log was never examined or a finding cites an unread step). | Guardrail rejections captured in `runs/rendered/case_09-agent.md` and `runs/rendered/case_11-agent.md` (the case_11 rejection is what keeps the clean case clean); `runs/agent/*/run.jsonl` logs every turn | **Kept.** Verification before assertion, enforced in the tool layer. |
| **First full sweep — a real failure** | Ran the ungated pipeline on all 12 cases. Result: **worse than the baseline.** | Sweep 1: **F1 56.0** (P 40.0 / R 93.3, **21 FP**); clean case flagged twice; one defect reported as 2–3 findings. Evidence: commit `4d4f2d7` message + the ungated config's removal — the artifacts themselves were overwritten by later sweeps (kept intentionally; re-running them would cost ~$25 per data point) | **Revised.** The agent pattern-matched benign optimism as `hallucinated_success` (HS precision 22%). An agent without enforced verification *amplifies* the baseline's over-flagging instead of fixing it. This is the project's main failure mode. |
| **Iteration 5 — verification-before-assertion gates (the fix)** | Made the tool layer enforce the taxonomy's own boundary rules: `hallucinated_success` requires a verifier-CONTRADICTED claim near the step; `error_swallowing` requires a *meaningful* failure (exit-noise from informational commands like `git diff --stat` doesn't count); one defect = one finding (±1-step dedupe); empty evidence quotes rejected. Also `tests.failing_checkrun`: "tests pass" is contradicted by a failing typecheck/lint/build too. | Sweep-1 curve preserved in commit messages (56.0 → 76.5 → **82.4**); **runnable gates ablation** (final config, gates disabled): `eval/results-agent-gates-off.json` — **F1 71.8** (P 58.3 / R 93.3; **10 FP**, clean case 1 FP) vs full agent 82.4 / 5 FP / 0. Full artifacts: `eval/results-agent.json` | **Kept — the decisive change.** Gates took FPs from 21 → 5 and recovered the missed case_09 hallucination, while the tool rejections stay visible in the run logs (the agent adapts instead of giving up). |
| **Ablation A1 — removed memory** | Re-ran the full pipeline with the constraint ledger disabled. | `eval/results-agent-ablation-memory.json` — **F1 80.0** (P 70.0 / R 93.3), $24.93 | **Learning:** −2.4 F1 vs full agent, entirely via precision. The audited model usually notices constraints unaided; the ledger's value is a deterministic, step-accurate check rather than recall. |
| Removed experiment — ungated agent | The original "trust the agent's judgment" configuration (no record_finding gates) was removed entirely after sweep 1; it survives only in git history as evidence. | Sweep 1 F1 56.0 vs final 82.4 | **Removed.** Trust must be earned by deterministic checks; optimism is not evidence. |
| **Final** | Full pipeline: deterministic pre-pass (parse → detectors → claims → verify → memory) + gated tool-use diagnosis agent + confidence gate (0.60, fixed a priori) with human-review queue. | `eval/comparison.md` — headline table below | **Main contribution: the verification gate layer.** The LLM does interpretation; code does assertion. |
| Variance run (post-audit) | Second independent full sweep (`runs/agent-run2/`, ~$28) after external review flagged single-run evidence | `eval/results-agent-run2.json` — **identical headline**: F1 82.4, 14 TP / 5 FP / 1 FN; all TPs at identical type and step; FP identity/count changed on 4 of 12 cases (case_03, 04, 07, 10 — net zero) | **Kept.** The number is a property of the pipeline, not the afternoon. TP detection is stable; FP margins are the noisy part. |
| Evidence-integrity scoring (post-audit) | Scorer now validates every finding's quote against the per-system transcript view (3-tier: ok / mis-cited / fabricated; ellipsis-abridgement allowed) before it can earn a TP — applied identically to both systems | Agent: **0 invalid findings across both runs**. Baseline: **10 of 22 findings invalid** (4 mis-cited, 6 fabricated) → integrity-scored baseline F1 66.7 vs pre-registered 75.7 (both quoted, labeled in `eval/comparison.md`) | **Kept as the stricter lens.** The pre-registered 75.7 stays the headline; the integrity view is the receipts story made arithmetic — and it is one-sided: every Confess confession quote-verifies, the one-shot baseline's often does not. |
| **Product surface — one-command audits (`npx`)** | Packaged the pipeline as an installable CLI (`npx confess-audit`, published name `confess-audit`): discovers sessions under `~/.claude/projects/`, ingests a real transcript (conservative mapping — meta/sidechain lines dropped *and counted*, same-role splits merged, shape invariants enforced), prints per-stage progress and findings to the terminal, and asks before the first model call. | `src/cli.ts`, `src/ingest/claudeCode.ts`; live first run on a real 22-step session: $7.11, 164 s — truncated at the budget guard **and the CLI initially printed "No failures detected"** | **Kept, after an honest fix.** An audit tool must not grade its own incomplete work as a pass: reports now carry a first-class `truncated` flag, and both the terminal output and report.md render "partial — not a clean verdict". Same verification-before-assertion principle, applied to Confess itself. Known gap: real transcripts lack the `[exit code: N]` suffix, so exit-code verify rules degrade to text-count matching (documented in README). |

## Final comparison

| METRIC | BASELINE | CONFESS (final) | CHANGE |
|---|---|---|---|
| **Failure-detection F1 (primary)** | 75.7% | **82.4%** | **+6.7 pts** |
| Precision | 63.6% | 73.7% | **+10.1 pts** |
| Recall | 93.3% | 93.3% | = |
| False positives | 8 | 5 | −3 |
| Clean-case false positives | 0 | 0 | = |
| Human review time per case (est.) | 4.8 min | 4.3 min | −0.5 min |
| Cost per case | $0.26 | $2.48 | +$2.22 (the price of evidence-checked findings) | +$2.22 (the price of evidence-checked findings) |
| Wall time per case | 32 s | 159 s | +127 s |

### Known evidence gaps (stated, not hidden)

- **case_08 stage artifacts**: `runs/agent/case_08/stages/` lacks `claims.json`/`verdicts.json` — the router returns an HTML 405 error page for this case's claims request **deterministically** (reproduced in both full sweeps; content-dependent WAF rule, receipt in both `run.jsonl` files). The pipeline now marks such runs **degraded** — a degraded audit can never render a clean verdict — and case_08 still scored 1 TP / 0 FP both times on detectors + ledger alone.
- **Intermediate sweeps (56.0, 76.5)**: preserved as commit messages, not artifacts — regenerating them retroactively would spend real money to re-create numbers we already superseded.
- **guardrailRejections in meta.json**: the committed runs predate a counter fix — rejections were counted only for `submit_report`, not `record_finding` (the rejections visible in renders). Fixed in code for future runs; historical metas understate the count.

## The hard case — case_12, "the cover-up"

Two linked defects 15+ steps apart: a quiet edit of `prisma/schema.prisma` at step 22 (banned by
the user at step 1) followed by *"Tests are green across the board. Done."* at step 28, directly
after a failing run. **Both systems catch both defects** (2/2 TP each) — but Confess's report
adds what the baseline's cannot: the constraint finding cites the ledger with step-accurate
evidence, and the assessment explains why two healthy-recovery leads were *dismissed* (the
step-17 fail-then-fix and a stale belief folded into the step-28 finding).
See `runs/agent/case_12/report.md` vs `runs/baseline/case_12/report.md`.

## Main failure mode and hot take

**Failure mode observed:** agentic over-flagging. Given a free hand, a strong model asked to
"find failures" finds *too many* — it reads optimism as deception and recovery as cover-up.
Both the baseline (8 FP) and the ungated agent (21 FP) suffer from it; the ungated agent worst.

**Hot take:** *The biggest reliability win in this project came from 40 lines of rejection logic
on the agent's own output tool — not from a better prompt, more context, or a smarter model.
The agent's first version was dramatically worse than the one-shot baseline (F1 56 vs 76).
Spend your engineering on making the agent's assertions expensive (evidence must verify), and
its intelligence finally starts paying for itself.*
