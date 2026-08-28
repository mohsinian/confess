# 07 — Execution schedule, risks, cut list

Three build days. Every block has a **timebox** and an **acceptance gate**; when the timebox ends,
apply the cut list — never silently overrun. Assumes ~8–10 focused hours/day. All commands run from
repo root in Git Bash on Windows (rules in [02-architecture.md](02-architecture.md) §6).

---

## DAY 1 — Data, schema, baseline, scorer

| Time | Block | Deliverable | Acceptance gate |
|---|---|---|---|
| 0:00–0:45 | **Scaffold**: `npm init`, deps (`@anthropic-ai/sdk`, `zod`, `tsx`, `dotenv`), tsconfig ESM, `.env.example`, `.gitignore`, `src/types.ts` + `src/schema.ts` with all zod schemas from [03-data-spec.md](03-data-spec.md) | Compiling skeleton; `npx tsx src/schema.ts` validates the spec's example fragment | types compile; example events pass validation |
| 0:45–1:15 | **`lib/anthropic.ts` + `lib/runlog.ts`**: provider-agnostic client factory (AgentRouter env trio **or** direct `ANTHROPIC_API_KEY`, per D13), temp 0, retries, cost accounting, `$5/case` abort, JSONL run logger | Shared call wrapper used by everything after | **provider smoke test**: 1-token call returns 200, `response.model` printed and pinned as the default; usage/cost logged |
| 1:15–3:00 | **Scenario packs + clean generator**: `scenarios.ts` (5 packs, fields per spec §5.3), `generateClean.ts` with the frozen prompt (§5.2), zod validation + 1 repair round-trip | 12 clean base sessions on disk | 12/12 valid: pairing holds, exit-code suffix present, constraint sentence verbatim in CV cases, length within ±2 |
| 3:00–4:30 | **Mutations**: `mutations.ts` — 5 recipes + distractor checker, seed-driven positions, step re-numbering, label emission; `buildDataset.ts` | `dataset/cases/case_01..12/{trajectory.jsonl,labels.json,meta.json}` | injection invariants hold post-mutation (re-validated); labels spot-check 12/12 |
| 4:30–5:15 | **QA pass** (spec §5.4): scripted checks + realism eyeball of 3 cases + full read of case_11 | QA checklist ticked in commit message | all boxes ticked; top realism complaints fixed once globally |
| 5:15–6:00 | **Dinner-style break / buffer** | — | — |
| 6:00–7:00 | **Baseline**: `runBaseline.ts` — serializer, frozen prompt ([05-baseline-spec.md](05-baseline-spec.md) §3), parse + repair, cost capture | `runs/baseline/*` for 12 cases | 12/12 schema-valid reports (or honest parse_error records) |
| 7:00–8:00 | **Scorer**: `eval/score.ts` matcher + metrics + fixtures unit tests ([04-eval-spec.md](04-eval-spec.md) §6), `eval/report.ts` tables | `eval/results-baseline.{json,md}` | fixture tests pass; baseline numbers in the headline table |
| 8:00–8:30 | **Lock the dataset** (rule D11): if baseline F1 ≥ 0.70 → add distractors / lengthen 06, 09, 12 → regenerate → re-run baseline once | locked `dataset/` committed | difficulty decision recorded in commit + this file |
| 8:30–9:00 | **Checkpoint commit + changelog seed**: commit everything; write baseline predictions-vs-actual notes for CHANGELOG | git tag `day1-done` | `npm run baseline && npm run eval -- --run baseline` reproduce the committed tables |

**Day 1 fallback:** if generation quality is poor at 3:00, fall back to template-based base sessions
(scenario packs carry canned steps; LLM only paraphrases) — 45 min to build, less charming, fully
deterministic. Decide at 3:00, not 6:00.

---

## DAY 2 — Build Confess (the agent)

| Time | Block | Deliverable | Acceptance gate |
|---|---|---|---|
| 0:00–0:45 | **Stage 1 parser + Stage 2 detectors** (`parse.ts`, `detectors.ts`) | steps/pairs + signals | 12/12 pairing; RL signal on 2/2 planted loops; no false loop on case_11 → snapshot eval ("detectors-only" run records findings from signals alone — changelog Iteration 1) |
| 0:45–2:00 | **Stage 3 claims** (`claims.ts`) | `stages/claims.json` per case | spot-check gate from [06-agent-spec.md](06-agent-spec.md): planted HS claims extracted with correct type; no future-tense |
| 2:00–3:30 | **Stage 4 verification** (`verify.ts`) | `stages/verdicts.json` | planted HS claims → CONTRADICTED (4/4 across cases 01, 06, 09, 12); case_11 → zero CONTRADICTED → snapshot eval (Iteration 2: detectors + verifier, no memory) |
| 3:30–4:15 | **Meal / buffer** | — | — |
| 4:15–5:30 | **Stage 5 memory** (`memory.ts`) | `stages/ledger.json` | constraint extracted 3/3 (05, 08, 12) with literal target; violation flagged at planted step; case_11 clean → snapshot eval (Iteration 3) |
| 5:30–7:30 | **Stage 6 diagnosis agent** (`tools.ts`, `diagnose.ts`, `run.ts`): tool defs, system prompt, loop, submit-guardrail, truncation handling | full pipeline `npm run agent` | case_01 + case_12 produce schema-valid reports ≤ 25 turns; guardrail rejection demonstrated once on a crafted lazy submit (save the render for the video) |
| 7:30–8:30 | **Full sweep**: agent over 12 cases; fix what breaks (budget guard respected) | `runs/agent/*` complete | 12/12 valid reports; cost/case ≤ $2; wall time recorded |
| 8:30–9:00 | **Eval + commit**: `npm run eval -- --run agent`; fill Iteration 4 row; commit; render case_12 trajectory early (video asset safety) | `eval/results-agent.{json,md}`, `runs/rendered/case_12.md` | agent F1 vs baseline recorded; git tag `day2-done` |

**Day 2 fallback ladder** (if the agent loop eats time): (1) drop `search_log` (keep list_signals,
read_steps, verify_claim, record, submit) — context is small enough; (2) batch read_steps windows of
16; (3) hard cap turns at 15 and accept truncations. Never cut: run logging, submit-guardrail,
confidence gate — they are rubric-visible.

---

## DAY 3 — Eval, ablations, deliverables, video

| Time | Block | Deliverable | Acceptance gate |
|---|---|---|---|
| 0:00–0:45 | **Second agent run** (variance, D12) + final numbers | `results-agent-run2` | range reported; no unexplained >5-pt F1 swing (if swing, investigate before writing anything) |
| 0:45–2:00 | **Ablations**: `npm run ablate -- --off memory`; then `--off verify` if ≥ 60 min remain | `results-ablation-*.md` | memory-off shows CV recall drop (esp. case_12); verify-off shows HS drop; both committed |
| 2:00–3:30 | **Writing block 1**: README.md + CHANGELOG.md per outlines in [08-deliverables.md](08-deliverables.md) (numbers pulled from eval files, every claim cites a file) | full drafts | read-aloud pass: no filler, no uncited number, failures admitted |
| 3:30–4:15 | **Writing block 2**: REPRODUCTION.md (two paths, versions, runtime, cost from real logs) + review-queue example + provenance section | full draft | a friend-check: could a stranger run path A in < 10 min? |
| 4:15–5:00 | **Trajectory exports**: render 3 (case_12, one standard, case_11 clean) + annotate 5–10 lines each ("note the guardrail rejection here") | `runs/rendered/*.md` | each shows: tool calls, a tool response, a retry/repair, and the review-queue checkpoint |
| 5:00–5:30 | **Pick the hot take** (candidates in [01-rubric-map.md](01-rubric-map.md)); verify it against data; write it | hot take section | cites ≥ 1 specific run file |
| 5:30–6:45 | **Video**: record per shot list ([08-deliverables.md](08-deliverables.md) §5); ≤ 2 takes; watch once at 1.5× for pacing | `docs/video/confess-demo.mp4` ≤ 5:00, audible, 1080p | hits all 6 required beats |
| 6:45–7:30 | **Final checklist + submission**: [08-deliverables.md](08-deliverables.md) §6 checklist; `.env` NOT committed; clean-clone test: `git clone` to temp dir → `npm i` → path A eval reproduces tables | submission package | every Definition-of-Done box in planning/README.md ticked |

---

## Risk register

| # | Risk | Likelihood | Impact | Mitigation (pre-decided) |
|---|---|---|---|---|
| R1 | API/provider trouble (router auth, rate limits, model string) | Med | High | Day-1 first-hour provider smoke test (D13): verify Bearer auth + pin the model ID the router actually resolves; concurrency 2; exponential backoff in `lib/anthropic.ts`; $5/case budget guard; direct `ANTHROPIC_API_KEY` works as fallback with zero code change |
| R2 | Generated sessions unrealistic/lazy | Med | High | QA gate Day 1 4:30; template fallback (Day 1 note above); realism fixed globally via prompt, not per-case |
| R3 | Baseline too strong (no headroom) | Med | High | Pre-registered escalation rule D11; distractors + length are the levers |
| R4 | Baseline too weak (strawman smell) | Low | Med | Fairness contract in [05-baseline-spec.md](05-baseline-spec.md); give baseline the taxonomy + evidence rules — if it still fails, that's a real result; say so plainly |
| R5 | Agent loop unstable (invalid tool args, infinite loops) | Med | Med | zod-reject with error text as tool_result; turn cap; truncation scored honestly |
| R6 | Cost overrun | Low | Med | cost accounting per call; $2/case abort; whole-project expectation <$26 worst case |
| R7 | LLM nondeterminism muddies "reproducible" | Med | Med | temp 0; committed artifacts; path-A reproduction needs no key; variance row in tables |
| R8 | Time overrun on Day 2 agent | Med | High | fallback ladder above; stretch goals only after DoD |
| R9 | Windows path/shell quirks break judge reproduction | Med | Med | Node-only IO; no shell pipes in npm scripts; test clean-clone on Day 3 |
| R10 | Judge skepticism of synthetic data | Med | Low | Own it in README: injection gives *exact labels*; real-transcript adapter is stretch S3; synthetic = ground rule 07 compliance |

## Cut list (in order, when time runs out)
1. Stretch S1 (second baseline) → 2. Stretch S2 (verify ablation) → 3. Rendered third trajectory →
4. `search_log` tool → 5. Render polish (keep markdown) → 6. S3/S4 (never scheduled anyway).
**Never cut:** run logging, submit-guardrail, confidence gate, the hard case, both-path reproduction.

## Standing rules
- Commit at every acceptance gate; tag `day1-done`, `day2-done`, `submit`.
- Any deviation from a locked decision (D1–D12) gets one line in that decision's row: why, when.
- Numbers only enter prose through their eval/run file (ground rule 09).
