# CONFESS — Implementation Plan (master index)

**Project:** **Confess** (repo: `confess/`) — feed it an AI coding agent's session log (user
instructions, agent text, tool_use / tool_result events), get back a diagnosis: which steps failed,
what failure type, the evidence, a suggested fix, and a confidence score. Low-confidence findings are
routed to a human-review queue instead of auto-asserted. Category (for judges): *a trajectory
debugger with a subpoena* — every failure it reports is a confession extracted from evidence the
agent itself produced. Full naming/voice rules: [`00-naming-and-voice.md`](00-naming-and-voice.md).

**Event:** micro1 Agentic Workflows Hackathon (brief: [`reference/hackathon-brief.txt`](reference/hackathon-brief.txt),
source PDF: `C:\coding in windows\light-poc\necessary resources so far\micro1 - First Hackathon97ce7c5.pdf`).

**Build window:** 3 working days (Day 1 = data/schema/baseline/scorer, Day 2 = agent pipeline,
Day 3 = eval/changelog/deliverables). Hour-by-hour schedule in [`07-schedule.md`](07-schedule.md).

---

## Document map

| # | File | What it contains | Status |
|---|------|------------------|--------|
| 0 | [00-naming-and-voice.md](00-naming-and-voice.md) | Name, taglines, vocabulary map (brand layer vs code layer), voice rules | Locked |
| 1 | [01-rubric-map.md](01-rubric-map.md) | Line-by-line mapping of every rubric point, ground rule, and deliverable to a concrete artifact we build | Locked |
| 2 | [02-architecture.md](02-architecture.md) | System design, pipeline diagram, repo layout, tech stack, decisions D1–D12 with rationale | Locked |
| 3 | [03-data-spec.md](03-data-spec.md) | Trajectory JSONL schema, the 5-type failure taxonomy with boundary rules, injection recipes, the 12-case matrix, dataset generator design, QA checklist | Locked |
| 4 | [04-eval-spec.md](04-eval-spec.md) | Matching algorithm, metrics (primary + secondary), report tables, fairness rules, pre-registered choices, variance handling | Locked |
| 5 | [05-baseline-spec.md](05-baseline-spec.md) | The one-shot baseline: exact prompt, runner behavior, parsing + retry policy, fairness constraints | Locked |
| 6 | [06-agent-spec.md](06-agent-spec.md) | Every agent module: parser, detectors, claim extraction, verification tool, constraint memory, diagnosis agent (tools + prompts), confidence gate, self-logging | Locked |
| 7 | [07-schedule.md](07-schedule.md) | Day-by-day hour-by-hour execution plan with acceptance criteria, risk register, cut list | Locked |
| 8 | [08-deliverables.md](08-deliverables.md) | Outlines for README / Improvement Changelog / Reproduction Guide, the 5-minute video script, trajectory export format, final submission checklist | Locked |

**Locked** = decided during planning; change only by editing the doc and noting why in its
*Decision log* section. This prevents mid-build re-litigating.

---

## Quick facts (memorize these)

- **Primary metric:** failure-detection **F1** (a predicted failure counts only if the *type* is exact
  and the *step* is within tolerance of ground truth). Secondary: per-type recall, localization
  accuracy, clean-case false positives, cost/task, wall-time/task.
- **Taxonomy (exactly 5, no more):** `hallucinated_success`, `constraint_violation`, `tool_misuse`,
  `retry_loop`, `error_swallowing`.
- **Dataset:** 12 synthetic cases (10 standard, 1 clean with distractors only, 1 hard multi-hop).
  Ground truth comes from deterministic failure *injection*, so labels are exact by construction.
- **Stack:** TypeScript + Node 22 + `@anthropic-ai/sdk` + `zod`. One model for everything via an
  Anthropic-compatible proxy (**AgentRouter**: `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL=https://agentrouter.org`
  + `ANTHROPIC_MODEL`, Opus-class) — baseline and agent get the **same** model, temperature 0, same
  taxonomy definitions. A direct Anthropic key works with zero code change (decision D13).
- **Log format:** custom-but-realistic JSONL mirroring Anthropic API content blocks (decision D1).
- **Total API budget:** ~**$45–70** at Opus-class pricing (estimate + levers in [02-architecture.md](02-architecture.md) §5).

## Definition of done (maps to the 4 required deliverables)

- [ ] **D1 — Code + changelog:** repo runs `gen / baseline / agent / eval / ablate` from a clean
  env; README states user + bottleneck + value; CHANGELOG.md has an entry per iteration with
  evidence; closes with main failure mode + hot take.
- [ ] **D2 — Reproduction guide:** clean-env setup, exact commands for baseline/agent/eval, versions,
  expected runtime, cost, expected output, and the no-API-key path (run eval on committed artifacts).
- [ ] **D3 — Video ≤ 5 min:** problem → baseline miss → full agent walkthrough on the hard case →
  comparison table → changelog + biggest contributor + one removed experiment → hot take.
- [ ] **D4 — Agent trajectories:** 2–3 rendered trajectories of the debugger itself showing tool
  calls, tool responses, a retry, and the human-review checkpoint.
- [ ] Eval numbers exist for: baseline, final agent, ≥1 ablation, and per-iteration snapshots.
- [ ] All run artifacts committed (`dataset/`, `runs/`, `eval/`) — evidence for every claim (ground rule 09).
- [ ] No credentials in repo; `.env.example` only (ground rule 08).
