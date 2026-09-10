# Confess — design docs (master index)

**Project:** **Confess** — feed it an AI coding agent's session log (user
instructions, agent text, tool_use / tool_result events), get back a diagnosis: which steps failed,
what failure type, the evidence, a suggested fix, and a confidence score. Low-confidence findings are
routed to a human-review queue instead of auto-asserted. The one-line category: *a trajectory
debugger with a subpoena* — every failure it reports is a confession extracted from evidence the
agent itself produced. Full naming/voice rules: [`00-naming-and-voice.md`](00-naming-and-voice.md).

These specs were written **before** the first dataset generation, baseline run, or agent run, and
locked at the time (edits after lock are appended as new decisions — D13+ were added post-lock, each
with rationale). This is what "pre-registered" means anywhere else in the repo.

---

## Document map

| # | File | What it contains | Status |
|---|------|------------------|--------|
| 0 | [00-naming-and-voice.md](00-naming-and-voice.md) | Name, taglines, vocabulary map (brand layer vs code layer), voice rules | Locked |
| 2 | [02-architecture.md](02-architecture.md) | System design, pipeline diagram, repo layout, tech stack, decisions D1–D15 with rationale | Locked |
| 3 | [03-data-spec.md](03-data-spec.md) | Trajectory JSONL schema, the 5-type failure taxonomy with boundary rules, injection recipes, the case matrix, dataset generator design, QA checklist | Locked |
| 4 | [04-eval-spec.md](04-eval-spec.md) | Matching algorithm, metrics (primary + secondary), report tables, fairness rules, pre-registered choices, variance handling | Locked |
| 5 | [05-baseline-spec.md](05-baseline-spec.md) | The one-shot baseline: exact prompt, runner behavior, parsing + retry policy, fairness constraints | Locked |
| 6 | [06-agent-spec.md](06-agent-spec.md) | Every agent module: parser, detectors, claim extraction, verification tool, constraint memory, diagnosis agent (tools + prompts), confidence gate, self-logging | Locked |

**Locked** = decided during planning; change only by editing the doc and noting why in its
*Decision log* section. This prevents mid-build re-litigating.

---

## Quick facts (memorize these)

- **Primary metric:** failure-detection **F1** (a predicted failure counts only if the *type* is exact
  and the *step* is within tolerance of ground truth). Secondary: per-type recall, localization
  accuracy, clean-case false positives, cost/task, wall-time/task.
- **Taxonomy (exactly 5, no more):** `hallucinated_success`, `constraint_violation`, `tool_misuse`,
  `retry_loop`, `error_swallowing`.
- **Dataset:** 22 synthetic cases (8 scenario packs; 10 standard, 1 clean with distractors only,
  1 hard multi-hop, plus ambiguity-designed cases 16/19/21). Ground truth comes from deterministic
  failure *injection*, so labels are exact by construction.
- **Stack:** TypeScript + Node 22 + `@anthropic-ai/sdk` + `zod`. One model for everything via an
  Anthropic-compatible proxy (`ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL` + `ANTHROPIC_MODEL`,
  Opus-class) — baseline and agent get the **same** model, temperature 0, same taxonomy definitions.
  A direct Anthropic key works with zero code change (decision D13).
- **Log format:** custom-but-realistic JSONL mirroring Anthropic API content blocks (decision D1).
- **Total API budget:** ~**$45–70** at Opus-class pricing (estimate + levers in [02-architecture.md](02-architecture.md) §5).
