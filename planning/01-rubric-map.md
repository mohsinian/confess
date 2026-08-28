# 01 — Rubric & deliverables map

Every judging line from the brief, mapped to a concrete artifact. If a row has no artifact, it is a
gap; if an artifact has no row, it is scope creep. Source: [`reference/hackathon-brief.txt`](reference/hackathon-brief.txt).

## Scoring rubric (100 pts)

### Problem & User Value — 15 pts
*"A strong project solves a meaningful problem for a clearly defined user. Who experiences the bottleneck and why does solving it matter?"*

| Rubric ask | Our answer / artifact |
|---|---|
| Clearly defined user | **Developers and team leads who run AI coding agents (Claude Code & API agents) on real tasks and must review what the agent actually did.** Named personas in README §Who: (a) the engineer doing PR-style review of an agent session, (b) the team lead skimming yesterday's autonomous runs. |
| Real bottleneck | Reviewing a 20–60 step agent transcript by hand is slow and error-prone: failures hide in the middle of long logs, agents sometimes *claim* success that tool output contradicts, and constraints stated at step 2 get silently violated at step 15. The reviewer has no tool that checks claims against evidence — they re-read everything or trust the summary. README quantifies this: baseline one-shot audit (what a person with an LLM does today) misses X% of injected failures at Y min/case. |
| Why it matters | Undetected `hallucinated_success` ships broken code; undetected `constraint_violation` breaks team rules (e.g., "don't touch the schema"); the cost of a missed failure is downstream human debugging, which is far more expensive than the review itself. Value prop: **turn a 15–30 min manual re-read into a 1–2 min guided audit with evidence links.** |

### Agent Solution & Engineering — 30 pts
*"Uses agents purposefully and is technically sound. Which design choices helped the agent solve the problem?"*

| Design choice | Why it is purposeful (not decoration) | Evidence it helps |
|---|---|---|
| Deterministic parser (code, not LLM) | Splits raw JSONL into typed steps with tool_use↔tool_result pairing and step indices. Zero hallucination risk on structure; everything downstream cites stable step ids. | Parser has 100% pairing accuracy by test (`src/agent/parse.ts` unit check). |
| Verification tool (code-level claim checking) | The crux. An LLM extracts *structured claims* ("tests pass", "created file X"), then **deterministic verifiers diff the claim against the actual tool_result content** (exit codes, test-count regexes, file-path mentions). Produces SUPPORTED / CONTRADICTED / UNVERIFIABLE verdicts with evidence snippets. | Ablation A2 (verifier off) — expect `hallucinated_success` recall to collapse. |
| Memory (constraint ledger) | Constraints declared in early user turns ("don't modify package.json", "pnpm only") are extracted once into a structured ledger and checked against **every** later tool_use — literally carrying information forward across the session. Solves the multi-hop blindness of one-shot reads. | Ablation A1 (memory off) — expect `constraint_violation` recall to collapse, especially on `case_12`. |
| Deterministic detectors | Retry-loop detection (normalized tool signature repeated with failing results) and unacknowledged-error scan are pure code — cheaper and more reliable than asking an LLM to notice. | Detectors alone catch 100% of `retry_loop` GT in a unit smoke test. |
| Tool-use diagnosis agent | The synthesis step is an actual Anthropic SDK tool loop: the agent pulls step windows (`read_steps`), searches the log, re-runs the verifier on demand, and must `record_finding` with evidence before `submit_report`. **Submit is rejected if a finding cites a step the agent never read/verified** — verification before assertion, enforced in code. | The run log itself (deliverable D4) shows the loop, tool calls, and retries. |
| Confidence-gated human checkpoint | Findings below confidence 0.6 are routed to `review-queue.md` (human checkpoint) rather than auto-asserted — ground rule 05 compliance *and* honest uncertainty reporting. | Eval reports auto-asserted precision vs review-queue precision separately. |
| Context management | Signals summary + windowed reads instead of dumping the whole log into one context. Purposeful on long logs (the hard case is 20–26 steps by design). | Works on hard case where one-shot baseline context degrades. |

### End to End Quality — 20 pts
*"Completes a realistic and self contained execution and produces a final result the user can use, with the finish of something a person would sign their name to."*

- Final output per case = `report.md` (human-readable: findings table with type, step, quote,
  suggested fix, confidence, review flags) + `report.json` (machine-readable). A reviewer can act on
  it directly: every finding links to a step and quotes the contradicting evidence.
- Polish items: consistent report template, suggested-fix required for every finding, empty findings
  produce "no failures detected — 2 distractor events reviewed" style summary (not blank), CLI help
  text, deterministic exit codes, clean logs (no debug spam in default mode).
- Anti-"obvious AI draft" pass: README + reports reviewed once aloud on Day 3; remove filler
  ("delve", "in conclusion", bullet spam), keep numbers concrete, admit failures.

### Measured Improvement — 15 pts
*"Demonstrates gains over a fair baseline and uses the changelog to connect each iteration with evidence."*

- Fair baseline: same model, same temperature (0), same taxonomy definitions text, same JSON retry
  policy as the agent; difference is workflow only. Resource differences (token cost, # of LLM
  calls) reported openly in the comparison table.
- Same 12 cases for baseline, every iteration snapshot, ablations, and final. One primary metric
  (F1) + the brief's suggested rows (human time, cost per task).
- Changelog (CHANGELOG.md) uses exactly the brief's table: STAGE / WHAT YOU TRIED AND WHY /
  EVIDENCE / DECISION-LEARNING, one entry per iteration incl. removed experiments.
- One challenging case (`case_12`, multi-hop) called out with its own paragraph: what it revealed.

### Reproducibility — 15 pts
*"Another person has a clear path to run the solution and baseline and reach the main result from a clean environment."*

- REPRODUCTION.md: prerequisites (Node 22, API key), `npm install`, exact commands
  (`npm run baseline`, `npm run agent`, `npm run eval`, `npm run ablate -- --off memory`), versions
  (`package-lock.json` committed), expected runtime (per stage), expected cost, expected output files.
- **Two reproduction paths:** (a) no-key path — re-run `npm run eval` against committed run
  artifacts to reproduce all tables exactly; (b) live path — regenerate dataset and re-run
  everything (~$5–8, ~45 min). Nondeterminism of LLM steps handled by temp 0 + committed artifacts +
  a variance note (eval run twice; range reported).
- Dataset generation is seeded and re-runnable (`npm run gen:dataset -- --seed 42`).

### Hot Take / Insights — 5 pts
*"Turns an observed failure mode into a practical lesson for building more reliable agents."*

- Candidate hot takes (pick the truest one after Day 3 data, do not pre-write the conclusion):
  1. "Most of the win came from 40 lines of regex, not the LLM" — if deterministic verifiers alone
     account for most of the F1 gain → lesson: give agents cheap deterministic checks for
     checkable claims; spend LLM attention on interpretation.
  2. "The baseline's errors were confident, the agent's errors were humble" — if confidence gate
     concentrates FPs in the review queue → lesson: calibrated routing to humans beats better guesses.
  3. "Failures are attribution problems, not detection problems" — if most misses are wrong *step*
     rather than missed failure → lesson: step-linked evidence should be a schema requirement.
- Whichever lands, it must cite a specific observed case from `runs/` (ground rule 09).

## Ground rules compliance (all 10)

| # | Rule | How we comply |
|---|---|---|
| 01 | Build with tools you know | TS + Anthropic SDK only; no new frameworks |
| 02 | Pre-existing vs added | README §Provenance: everything written during the hackathon; planning docs timestamped |
| 03 | Licenses | MIT deps only (sdk, zod, tsx, dotenv) |
| 04 | Consequential actions sandboxed + human approval | **The debugger is read-only analysis** — it never executes logged commands. Stated in README. The human-review queue is the approval surface. |
| 05 | Qualified human reviewer for impactful outputs | Confidence gate: findings < 0.6 → `review-queue.md`; report template marks them "needs human review" |
| 06 | Legal/ethical, responsible data | Synthetic data only; no real user transcripts |
| 07 | Public/synthetic data | 100% synthetic, generator + seed committed |
| 08 | No credentials | `.env` gitignored; `.env.example` documents the provider variants (AgentRouter: `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_BASE_URL`/`ANTHROPIC_MODEL`, or direct `ANTHROPIC_API_KEY`) with no values filled in |
| 09 | Claims → evidence | Every number in README/changelog cites a file in `runs/` or `eval/` |
| 10 | Judges can reproduce | Two-path reproduction (no-key + live); repo is self-contained |

## The four deliverables → where they live

| Deliverable | Files |
|---|---|
| 01 Code + changelog | repo root: `src/**`, `README.md`, `CHANGELOG.md`, `planning/**` (process transparency) |
| 02 Reproduction guide | `REPRODUCTION.md` |
| 03 Video ≤ 5 min | `docs/video/` (script + recording; script in [08-deliverables.md](08-deliverables.md) §5) |
| 04 Agent trajectories | `runs/rendered/` — 2–3 rendered markdown trajectories of the debugger itself + one claim-extractor trace |
