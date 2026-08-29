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
| **Iteration 4 — tool-use diagnosis agent** | The synthesis step as a real tool loop: `list_signals`, windowed `read_steps`, `search_log`, `verify_claim`, `record_finding` (evidence quote must be a verbatim substring of the cited step — checked in code), `submit_report` (rejected if the log was never examined or a finding cites an unread step). | A guardrail rejection captured in `runs/rendered/case_12-agent.md`; `runs/agent/*/run.jsonl` logs every turn | **Kept.** Verification before assertion, enforced in the tool layer. |
| **First full sweep — a real failure** | Ran the ungated pipeline on all 12 cases. Result: **worse than the baseline.** | Sweep 1: **F1 56.0** (P 40.0 / R 93.3, **21 FP**) — recorded in commit history; clean case flagged twice; one defect reported as 2–3 findings | **Revised.** The agent pattern-matched benign optimism as `hallucinated_success` (HS precision 22%). An agent without enforced verification *amplifies* the baseline's over-flagging instead of fixing it. This is the project's main failure mode. |
| **Iteration 5 — verification-before-assertion gates (the fix)** | Made the tool layer enforce the taxonomy's own boundary rules: `hallucinated_success` requires a verifier-CONTRADICTED claim near the step; `error_swallowing` requires a *meaningful* failure (exit-noise from informational commands like `git diff --stat` doesn't count); one defect = one finding (±1-step dedupe); empty evidence quotes rejected. Also `tests.failing_checkrun`: "tests pass" is contradicted by a failing typecheck/lint/build too. | Sweeps in git history: 56.0 → 76.5 → **82.4**; `eval/results-agent.json`: **F1 82.4** (P 73.7 / R 93.3; 14 TP / 5 FP / 1 FN), clean case 0 FP, 0 parse errors | **Kept — the decisive change.** Gates took FPs from 21 → 5 and recovered the missed case_09 hallucination, while the tool rejections stay visible in the run logs (the agent adapts instead of giving up). |
| **Ablation A1 — removed memory** | Re-ran the full pipeline with the constraint ledger disabled. | `eval/results-agent-ablation-memory.json` — **F1 80.0** (P 70.0 / R 93.3), $24.93 | **Learning:** −2.4 F1 vs full agent, entirely via precision. The audited model usually notices constraints unaided; the ledger's value is a deterministic, step-accurate check rather than recall. |
| Removed experiment — ungated agent | The original "trust the agent's judgment" configuration (no record_finding gates) was removed entirely after sweep 1; it survives only in git history as evidence. | Sweep 1 F1 56.0 vs final 82.4 | **Removed.** Trust must be earned by deterministic checks; optimism is not evidence. |
| **Final** | Full pipeline: deterministic pre-pass (parse → detectors → claims → verify → memory) + gated tool-use diagnosis agent + confidence gate (0.60, fixed a priori) with human-review queue. | `eval/comparison.md` — headline table below | **Main contribution: the verification gate layer.** The LLM does interpretation; code does assertion. |

## Final comparison

| METRIC | BASELINE | CONFESS (final) | CHANGE |
|---|---|---|---|
| **Failure-detection F1 (primary)** | 75.7% | **82.4%** | **+6.7 pts** |
| Precision | 63.6% | 73.7% | **+10.1 pts** |
| Recall | 93.3% | 93.3% | = |
| False positives | 8 | 5 | −3 |
| Clean-case false positives | 0 | 0 | = |
| Cost per case | $0.26 | $2.48 | +$2.22 (the price of evidence-checked findings) |
| Wall time per case | 32 s | 159 s | +127 s |

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
