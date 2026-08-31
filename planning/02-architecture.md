# 02 — Architecture, stack, and locked decisions

## 1. System overview

Two evaluated systems share one input format, one output schema, one scorer:

```
                        ┌────────────────────────────────────────────────┐
                        │  dataset/cases/case_XX/trajectory.jsonl        │
                        │  (synthetic, failures injected deterministically)│
                        └───────────────┬────────────────────────────────┘
                                        │
              ┌─────────────────────────┴──────────────────────────┐
              │                                                    │
     ┌────────▼─────────┐                                ┌─────────▼──────────┐
     │  BASELINE        │                                │  AGENT SOLUTION    │
     │  one-shot prompt │                                │                    │
     │  (same model,    │                                │ 1. parse (code)    │
     │  temp 0, full    │                                │ 2. detectors (code)│
     │  log dumped in)  │                                │ 3. claim extract   │
     └────────┬─────────┘                                │    (LLM, temp 0)   │
              │                                          │ 4. verify (code)   │
              │                                          │ 5. memory ledger   │
              │                                          │    (LLM+code)      │
              │                                          │ 6. diagnosis agent │
              │                                          │    (tool-use loop) │
              │                                          │ 7. confidence gate │
              │                                          │    (code)          │
              └──────────────┬───────────────────────────┴────────────────────┘
                             │  report.json (identical schema for both)
                     ┌───────▼────────┐
                     │  eval/score.ts │  ← labels.json (ground truth from injection)
                     └───────┬────────┘
                             │  results tables (markdown + json)
```

Everything the agent system does is logged to `runs/` — the debugger's own tool-use trajectory is a
first-class deliverable, not a byproduct.

## 2. Locked decisions

These are decided **now** to prevent mid-build stalls. Change requires editing this section.

| # | Decision | Choice | Rationale / rejected alternative |
|---|---|---|---|
| D1 | Log format | **Custom-but-realistic JSONL** mirroring Anthropic API content blocks (`text`, `tool_use`, `tool_result`) and Claude-Code-style tool vocabulary (Read/Edit/Write/Bash/Grep/Glob) | Full control, no dependency on Claude Code internals; upgrade path to real transcripts is a thin adapter (rejected: parsing real `~/.claude/projects` JSONL — realism not worth the fragility in a 3-day build; a converter stub is a stretch goal S3) |
| D2 | Language/runtime | **TypeScript, Node 22, ESM**, run via `tsx` | Matches the "Anthropic TypeScript SDK" requirement; zod gives runtime validation of every LLM JSON output |
| D3 | Dependencies | `@anthropic-ai/sdk`, `zod`, `tsx`, `dotenv` only | Minimal install = fast clean-env reproduction |
| D4 | Model | One model for everything (dataset gen, claims, diagnosis, baseline), selected via `ANTHROPIC_MODEL`. **Build-time default: the Opus-class model on AgentRouter** (try `claude-opus-5` first; fall back to `claude-opus-4-8` / `claude-opus-4-6`, the IDs AgentRouter's docs list). Exact model string **echoed from the API response** (`response.model`) and recorded in every run's `meta.json` | Fairness (baseline vs agent identical model). Rejected: mixing models between baseline and agent (unfair) |
| D13 | API access | **Anthropic-compatible proxy (AgentRouter)** via the standard trio: `ANTHROPIC_AUTH_TOKEN` (router API key, sent as Bearer), `ANTHROPIC_BASE_URL=https://agentrouter.org` (**no `/v1` suffix**), `ANTHROPIC_MODEL`. `src/lib/anthropic.ts` reads all three explicitly and passes them to the SDK constructor (`authToken`/`baseURL`/model), so a direct Anthropic key (`ANTHROPIC_API_KEY`) works with zero code change — the code is provider-agnostic, the `.env` decides. Do **not** mix in the router's OpenAI-compatible endpoint (`agentrouter.org/v1`) | Matches how we access Claude (no direct subscription); same env contract Claude Code itself uses, so the SDK's Messages+tools path is exactly what the router serves |
| D5 | Determinism | `temperature: 0` on **all** LLM calls; seeded mutation selection; the generated dataset and all run artifacts are **committed** | Reproducibility rubric; honest variance note instead of pretending determinism |
| D6 | Agent shape | **Hybrid pipeline**: deterministic pre-pass (parse → detectors → claims → verify → memory) feeding a **tool-use diagnosis agent** that reads windows, re-verifies on demand, records findings, submits | A pure fixed pipeline isn't visibly "agentic"; a pure from-scratch agent wastes tokens re-deriving what code does perfectly. The hybrid shows purposeful orchestration |
| D7 | Taxonomy | **Exactly 5 types** (`hallucinated_success`, `constraint_violation`, `tool_misuse`, `retry_loop`, `error_swallowing`) with written boundary rules | 5 keeps per-type n ≥ 2 in 12 cases and scoring unambiguous; more types would dilute the dataset |
| D8 | Ground truth | Labels are the **injection log** — code plants each failure, so labels are exact by construction; no human annotation pass, no LLM judging GT | Eliminates label noise; the strongest possible eval story in 3 days |
| D9 | Matching | Type must match **exactly**; step matches if within ±2 of GT `primary_step` or in `evidence_steps`. Greedy one-to-one by (proximity, confidence). Pre-registered — no tuning after seeing results | ±1 is too strict for claim-vs-result attribution ambiguity; ±3 too loose. Fixed before any run = no test-set fitting |
| D10 | Confidence gate | Threshold **0.60, chosen a priori**, not tuned. `< 0.60 → needs_human_review` (still scored as a detection if it matches GT) | Avoids the criticism of tuning the gate on the test set; gate is a routing feature, not a metric hack |
| D11 | Dataset difficulty rule | If the baseline's first F1 ≥ 0.70, escalate difficulty (more distractors, lengthen cases 06/09/12) **before** locking the dataset on Day 1 evening, and re-run baseline once | A fair fight needs headroom; rule is pre-registered so it isn't post-hoc sabotage of the baseline |
| D12 | Eval runs | Agent eval runs **twice** on Day 3; report both scores and the range | Honest variance reporting for temp-0-but-not-fully-deterministic APIs |
| D14 | Dataset extension | After the external review, the benchmark grows from 12 to **22 committed cases** (25 GT failures): cases 13–23 across 3 new packs (F Python, G Node ops, H Go CLI). Targets the thin per-type cells (tool_misuse n=3, retry_loop n=2) and adds ambiguity-designed cases (16, 19, 21) to give the 0.60 review queue its first data points. Labels stay exact-by-construction (D8). The case_13/24 designs are committed (`PENDING_CASES`) — the provider wedged on those two clean-session prompts (7+ attempts, same symptom as the original case_01 wedge); they regenerate via the same commands when the provider is healthy. Difficulty policy: the extension locks as specified — the D11 escalation rule already consumed its single re-run on the original lock; if the baseline F1 ≥ 0.70 on the extended set, that is reported as zero-headroom, not escalated again | Judges see n≥4 per type and a clean-case precision estimate; the review queue was previously unmeasured (the largest open honesty gap) |
| D15 | Evidence integrity is scoring | A finding whose quote fails the evidence-tier check (ok / mis-cited / fabricated) is **excluded from matching** — reported, never silent. The view is **one shared full-text serialization** for every system (removes the old 1200-char baseline-only cap). The baseline prompt now demands verbatim contiguous quotes (same rule the agent's tool layer enforces), so the check measures evidence handling rather than prompt asymmetry. The parametric reviewer-effort model (60/90 s read + 1 min/TP + 4 min/FP + 2 min/queue item) is registered here for the extended benchmark; it is not the §4.1 wall-time model | Kills the two-lens numbers (75.7 vs 66.7) that muddied the earlier submission; ground rule 09 becomes a property of the scorer, not a story |


## 3. Repository layout

```
confess/                              (repo root = C:\coding in windows\confess)
├── README.md                         # deliverable: user, bottleneck, value, results, provenance
├── CHANGELOG.md                      # deliverable: improvement changelog (brief's table format)
├── REPRODUCTION.md                   # deliverable: clean-env guide, two paths
├── package.json / tsconfig.json / package-lock.json / .env.example / .gitignore
├── planning/                         # this plan (kept in repo — process transparency)
├── src/
│   ├── types.ts                      # all shared TS types (events, claims, verdicts, findings, reports)
│   ├── schema.ts                     # zod schemas + validators used everywhere
│   ├── lib/
│   │   ├── anthropic.ts              # client factory, retry wrapper, token/cost accounting, temp 0
│   │   └── runlog.ts                 # JSONL run logger (request/response/tool pairs/usage/retries)
│   ├── generate/
│   │   ├── scenarios.ts              # 5 scenario packs (domains, tool vocab, constraint lines, arcs)
│   │   ├── generateClean.ts          # LLM writes a clean base session per case (1 call + repair)
│   │   ├── mutations.ts              # deterministic failure injectors (the 5 recipes + distractors)
│   │   └── buildDataset.ts           # orchestrates; validates; writes trajectory.jsonl + labels.json
│   ├── baseline/
│   │   └── runBaseline.ts            # one-shot prompt, JSON parse + repair, cost/time capture
│   ├── agent/
│   │   ├── parse.ts                  # JSONL → Step[] with tool_use↔tool_result pairing
│   │   ├── detectors.ts              # retry-loop detector, unacknowledged-error scan (pure code)
│   │   ├── claims.ts                 # LLM claim extraction → Claim[] (typed, step-linked)
│   │   ├── verify.ts                 # verifier library: Claim → Verdict (SUPPORTED/CONTRADICTED/UNVERIFIABLE)
│   │   ├── memory.ts                 # constraint ledger: extract constraints, check later tool_uses
│   │   ├── tools.ts                  # Anthropic tool definitions for the diagnosis agent
│   │   ├── diagnose.ts               # the tool-use loop (max turns, submit guardrail)
│   │   └── run.ts                    # stage orchestration + per-stage logging + report writing
│   ├── eval/
│   │   ├── score.ts                  # matcher + metrics (see 04-eval-spec.md)
│   │   └── report.ts                 # markdown tables: comparison, per-type, per-case, ablations
│   └── render/
│       └── renderTrajectory.ts       # runs/*.jsonl → readable markdown (deliverable 04)
├── dataset/
│   ├── cases/case_01 … case_12/
│   │   ├── trajectory.jsonl          # the input log (what baseline & agent see)
│   │   ├── labels.json               # ground truth (used ONLY by eval)
│   │   └── meta.json                 # scenario, seed, model, difficulty, step count
├── runs/
│   ├── baseline/<case_id>/           # report.json, run.jsonl (every API call), meta.json
│   ├── agent/<case_id>/              # + stages/ (claims.json, verdicts.json, ledger.json, signals.json)
│   ├── agent-<flag>/<case_id>/       # ablation reruns (--off memory, --off verify)
│   └── rendered/                     # 2–3 human-readable trajectories (deliverable 04)
├── eval/
│   ├── results-baseline.json/.md     # committed evidence
│   ├── results-agent.json/.md
│   ├── results-agent-run2.json/.md
│   ├── results-ablation-memory.json/.md
│   └── results-ablation-verify.json/.md
└── docs/video/                       # script + final recording
```

## 4. npm scripts (the public CLI surface — goes in REPRODUCTION.md verbatim)

```
npm run gen:dataset                 # regenerate dataset (needs key, ~10 min, <$1.5)
npm run baseline                    # one-shot baseline over all 12 cases (needs key, ~4 min)
npm run agent                       # full agent pipeline over all 12 cases (needs key, ~15–25 min)
npm run agent -- --case case_12     # single case (used in the video)
npm run ablate -- --off memory      # rerun agent minus one component (memory | verify | detectors)
npm run eval -- --run agent         # score a committed run dir against labels (NO key needed)
npm run report                      # rebuild all comparison tables from committed eval results
npm run demo -- --case case_12      # pretty-print one full agent run: stages + findings + report
```

`eval` never calls the API → judges reproduce all tables with zero spend (path A in REPRODUCTION.md).

## 5. Cost & runtime envelope (estimate, recheck Day 1)

Assumptions: **Opus-class list pricing ≈ $15/MTok input, $75/MTok output** (upper bound — AgentRouter
bills its own credits, so real spend may be lower; Day-1 smoke test + run logs give the true number,
which replaces this table in REPRODUCTION.md). Cost accounting is built into `lib/anthropic.ts`.

| Stage | Calls | Tokens (in+out) est. | Cost est. | Wall time |
|---|---|---|---|---|
| Dataset generation | 12 × (1 gen + ≤1 repair) + mutation paraphrases | ~12 × 8K/6K | ~$7 | 10–15 min |
| Baseline | 12 × (1 + ≤1 repair) | ~12 × 9K/1.5K | ~$3 | 4–6 min |
| Agent (full) | 12 × (1 claims + ~8–14 diagnosis turns) | ~12 × 45K/8K | ~$15 | 15–25 min |
| Ablation − memory | 1 × agent | — | ~$15 | 15–25 min |
| Ablation − verify (stretch S2) | 1 × agent | — | ~$15 | 15–25 min |
| Day-3 variance rerun | 1 × agent | — | ~$15 | 15–25 min |
| **Total (full program)** | | | **~$70** | |
| **Total (lean: 1 ablation, rerun 6 cases only)** | | | **~$45** | |

Opus is ~5× Sonnet pricing; if budget becomes a concern, `ANTHROPIC_MODEL` swaps the whole program
to any cheaper model the router offers — one env var, every run records which model it used.
Hard budget guard: `lib/anthropic.ts` accumulates cost per run and aborts a case at `MAX_RUN_COST`
(default **$5.00/case**, raised from $2 for Opus-class pricing) — a visible safety control (also a
good look for ground rule 04 mindset).

**Day-1 first-hour provider smoke test (30 s):** with the three env vars set, send one 1-token
message; assert HTTP 200 and print `response.model` — this (a) verifies the Bearer auth works
through the SDK, (b) settles the exact model string (`claude-opus-5` vs `-4-8`/`-4-6`), (c) gives
the router's real per-token price signal if its usage data is echoed. Only Opus-class strings are
assumed; anything else the router offers also works unchanged.

## 6. Cross-cutting engineering rules

1. **Every LLM call** goes through `lib/anthropic.ts`: temp 0, timeout, 2 network retries, zod
   validation of expected JSON, **one** repair round-trip on schema failure (repair prompt + raw
   output logged). Same policy for baseline and agent = fairness + identical JSON robustness.
   Provider config lives here and nowhere else: `ANTHROPIC_AUTH_TOKEN`+`ANTHROPIC_BASE_URL`
   (router/Bearer) or `ANTHROPIC_API_KEY` (direct) — passed explicitly to the SDK constructor,
   never sprinkled through the codebase. `.env.example` documents both variants with AgentRouter
   as the default.
2. **Every run** writes `run.jsonl` via `lib/runlog.ts` before the next call is made (crash-safe):
   `{ts, stage, kind: request|response|tool_result|repair|error, payload, usage, costUsd}`.
3. **Labels never flow into baseline/agent code.** `labels.json` is read by `src/eval/**` only
   (enforced by module boundary; stated in REPRODUCTION.md).
4. **No shell text processing.** All file IO in Node (`fs`), forward slashes, paths via `path`.
   Windows + Git Bash is the dev environment; scripts must also work in PowerShell.
5. **Step indices are 1-based event line numbers** in `trajectory.jsonl` — one stable addressing
   scheme across parser, agent tools, findings, labels, and human reading.
6. **Truncation discipline:** tool_result content capped at ~1200 chars when embedded in prompts
   (full text stays on disk; findings quote ≤ 200 chars with an evidence step pointer).

## 7. Stretch goals (only after Definition of Done, in order)

- **S1 — second baseline:** "one general-purpose agent with basic tools" (Read/Grep over the raw
  JSONL, no specialized pipeline). Makes the improvement table richer; ~1.5 h.
- **S2 — second ablation:** `--off verify` if time didn't allow it on Day 3.
- **S3 — real-transcript adapter:** converter from Claude Code `~/.claude/projects` JSONL into our
  schema + one demo on a real (own, non-sensitive) transcript. Big realism points; only if ≤ 2 h.
- **S4 — pretty HTML trajectory viewer.** Lowest priority; markdown rendering is the deliverable.
