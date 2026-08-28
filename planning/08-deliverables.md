# 08 — Deliverables: outlines, changelog skeleton, video script, submission checklist

Voice rules from [00-naming-and-voice.md](00-naming-and-voice.md) apply to everything written here.
Every number that appears in prose must exist in a committed file under `runs/` or `eval/`.

## 1. README.md outline (repo root)

```
# CONFESS — every agent tells a story. Confess checks the receipts.
   (one-paragraph what-it-is; category line: "a trajectory debugger with a subpoena")

## Who has this problem            ← rubric: Problem & User Value (15)
   Two personas: (1) engineer reviewing an agent's session before trusting/merging its work;
   (2) team lead skimming overnight autonomous runs. Quote a (synthetic) 20-step transcript
   snippet where the failure is invisible in the summary. Name the bottleneck: claims aren't
   checked against evidence, constraints decay over long logs, middle-of-log failures hide.
## What Confess does
   Screenshot-ish ASCII of one report; the 5 failure types in one table; the pipeline in 7 lines.
   Read-only guarantee (analysis only — never executes logged commands). Review-queue explanation.
## Why it matters (value prop)
   Missed hallucinated_success ships broken code; missed constraint_violation breaks team rules.
   Turn a 15–30 min manual re-read into a 1–2 min evidence-linked audit.
## Results (headline)
   The comparison table from eval/ + the Cover-Up case paragraph + link to eval/*.md.
## How it works
   Pipeline diagram + 2 paragraphs: deterministic pre-pass, verification tool, constraint memory,
   diagnosis agent, confidence gate. Link to planning/ for full specs.
## Improvement changelog → CHANGELOG.md
## Reproduction → REPRODUCTION.md
## Provenance & compliance
   Everything written during the hackathon; synthetic data only; credentials via .env only;
   read-only analysis; human review for low-confidence findings.
## Hot take
   (chosen Day 3; candidates in 01-rubric-map.md)
```

## 2. CHANGELOG.md skeleton (the brief's exact table)

| STAGE | WHAT YOU TRIED AND WHY | EVIDENCE | DECISION / LEARNING |
|---|---|---|---|
| Baseline | One-shot full-log prompt, same model — represents "paste it into an LLM and ask" | `eval/results-baseline.md` F1 + which types missed | Starting point; misses mid-log HS, most CV; over-flags benign retries |
| Iteration 1 | Deterministic parse + retry-loop & unacknowledged-error detectors — failures with mechanical signatures shouldn't cost LLM attention | detectors-only snapshot | Kept. RL solved by code; ES still needs judgment |
| Iteration 2 | Claim extraction + verification tool — diff what the agent *claims* against what tool_results *say* | snapshot eval; HS recall before/after | Kept. Biggest single contributor (expected — verify with ablation) |
| Iteration 3 | Constraint memory ledger — carry step-2 constraints to step-20 tool calls | snapshot; case_12 CV found/missed | Kept. Solves the multi-hop blind spot |
| Iteration 4 | Tool-use diagnosis agent + submit-guardrail — findings must cite verified steps | `runs/agent/*`, rendered trajectory | Kept. Guardrail rejection visible in trajectory |
| Iteration 5 | Confidence gate (0.60, a priori) → review queue | auto vs review precision split | Kept. FPs concentrate in the review queue |
| **Ablation A1** | **Removed: memory** — test whether the ledger is load-bearing | `results-ablation-memory.md` | *(fill: expected CV recall collapse)* |
| Ablation A2 (if run) | Removed: verification tool | `results-ablation-verify.md` | *(fill)* |
| Final | Full pipeline, agent run twice for variance | `results-agent*.md` | Main contributor + honest variance note |

Write entries the day they happen (30 s at each Day-2 gate); Day 3 only fills evidence cells and the
learning column. Removed-experiment row is genuinely run, never fabricated.

## 3. REPRODUCTION.md outline

```
# Reproduction guide
## Requirements: Node ≥22, npm, an Anthropic-compatible endpoint. Versions: package-lock.json committed.
## Provider setup (either works, zero code change):
   (a) AgentRouter proxy (what we built with): ANTHROPIC_AUTH_TOKEN=<router key>,
       ANTHROPIC_BASE_URL=https://agentrouter.org  (no /v1), ANTHROPIC_MODEL=<pinned model>
   (b) Direct Anthropic: ANTHROPIC_API_KEY=<key>, optional ANTHROPIC_MODEL
   Both variants are in .env.example; the model string actually used is recorded in every run's meta.json.
## Path A — no API key (5–10 min): git clone → npm ci → npm run eval -- --run baseline →
   --run agent → npm run report. Expected: tables identical to eval/*.md (artifacts committed).
## Path B — live (≈45–60 min, ≈$45–70 at Opus-class pricing): cp .env.example .env, add key →
   npm run gen:dataset → baseline → agent → eval → report. Expected runtime per stage table;
   expected variance note. Budget lever: swap ANTHROPIC_MODEL to a cheaper model the provider offers.
## What you'll see: expected console output excerpts (paste real ones), where reports land
   (runs/<system>/<case>/report.md), what the review queue looks like.
## Data: 12 synthetic cases, seeded; labels from deterministic injection (link to 03-data-spec).
## Cost & time: measured numbers from meta.json files, not estimates.
## Troubleshooting: rate limits, model name override, provider/auth errors, Windows notes.
```

## 4. Trajectory exports (deliverable 04)

`runs/rendered/`: `case_12-confession.md` (the hero artifact — the Cover-Up found), one standard
case, `case_11-clean.md` (zero confessions + distractors dismissed — precision story). Format:
turn-by-turn (tool call → tool result → agent reasoning), long results truncated with step
pointers, **annotations in blockquotes** flagging: one repair/retry, one submit-guardrail
rejection, the review-queue checkpoint. Plus one claim-extractor trace (secondary agent).

## 5. Video script (≤ 5:00, shot list + spoken beats)

| Time | Shot | Spoken beat |
|---|---|---|
| 0:00–0:20 | Title card: CONFESS + tagline | "AI coding agents don't just fail — sometimes they cover up. This session claims all tests pass. The tool result says two failed. Confess finds that gap." |
| 0:20–0:50 | README personas + Cover-Up transcript on screen | Who has the problem: engineers reviewing agent sessions; bottleneck: claims unchecked against evidence; 15–30 min manual re-reads |
| 0:50–1:30 | Terminal: run baseline on case_12, show its report missing the CV (and whatever it missed for real) | "The honest baseline — same model, one prompt. Reasonable, and it misses X of Y failures." (state real numbers) |
| 1:30–3:15 | Terminal: `npm run demo -- --case case_12` — stages streaming live: parse → detectors → claims → **verifier CONTRADICTED** (zoom) → ledger violation → agent tool calls → findings | Walk the pipeline once, narrating each tool response as it arrives; end on report.md: both failures, evidence quotes, confidence, review queue |
| 3:15–3:50 | Comparison table on screen | F1 + cost + time, baseline vs Confess; honest note on extra cost; the Cover-Up paragraph |
| 3:50–4:30 | CHANGELOG.md scrolled slowly | Changelog in one breath; biggest contributor (verification tool — with ablation number); the removed-experiment row (memory ablation) and what it taught |
| 4:30–5:00 | Review queue + close | "Low-confidence findings go to a human — it's an auditor, not a judge. Hot take: [chosen take]. Confess: every agent tells a story; this one checks the receipts." |

Recording notes: 1080p terminal at ≥ 14 pt font; one take of live demo, cut to pre-recorded B-roll
if live stumbles; captions for numbers; ≤ 2 takes total (timebox 75 min incl. watch-through).

## 6. Final submission checklist (Day 3, in order)

- [ ] `git status` clean; `.env` absent from repo; `.env.example` correct
- [ ] Clean-clone test to temp dir: `npm ci` → path A reproduces committed tables
- [ ] README / CHANGELOG / REPRODUCTION final read-aloud pass (no filler, every number cited)
- [ ] Video ≤ 5:00, watchable at 1×, all six beats present
- [ ] 3 rendered trajectories committed with annotations
- [ ] Eval artifacts for: baseline, agent ×2, ablation memory (+ verify), per-iteration snapshots
- [ ] planning/ folder kept in repo (process transparency; pre-existing vs added is unambiguous)
- [ ] Every Definition-of-Done box in planning/README.md ticked
- [ ] Submit + push tag `submit`
