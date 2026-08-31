# Reproduction guide

Written for a clean machine. Two paths: **A** reproduces every number offline from committed
artifacts (~5 min, no API key); **B** regenerates everything live (~70 min, ~$65).

## Requirements

- Node.js ≥ 22 (`node --version`), npm
- Git
- For Path B only: an Anthropic-compatible endpoint (AgentRouter or direct Anthropic key)

Versions are pinned in `package-lock.json` (`npm ci` installs exactly these). Key dependencies:
`@anthropic-ai/sdk` 0.122, `zod` 4.5, `tsx` 4.23, `jsonrepair`, `typescript` 7.

```bash
git clone https://github.com/mohsinian/confess.git
cd confess
npm ci
npx tsc --noEmit        # optional: typecheck
npm run selftest        # 59 no-LLM checks — all green expected
```

## One-off audit, no clone (npx)

```bash
npx confess-audit            # audits your most recent Claude Code session; --list to browse
npx confess-audit <file>     # or a specific transcript
```

Credentials via environment variables or `./.env` (same provider setup as Path B). Typical
cost ~$1–3 per session, guard-capped at `MAX_RUN_COST` (default $8.00) — large sessions can
hit the cap; truncated audits are labeled **partial**, never clean. Reports land in
`./confess-reports/` and stay local.

## Path A — offline (no API key, ~5 minutes, $0)

All model outputs and the dataset are committed (`dataset/`, `runs/`, `eval/`).

```bash
npm run eval -- --run baseline
npm run eval -- --run agent
npm run eval -- --run agent-ablation-memory --out results-agent-ablation-memory
npm run report
```

Expected output (headline lines):

```
eval: baseline over 22 of 22 cases
  F1 70.8%  P 57.5%  R 92.0%  (TP 23 / FP 17 / FN 2)
  localization(±1) 77.8%  clean-case FP 0  parseErrors 0

eval: agent over 22 of 22 cases
  F1 79.3%  P 69.7%  R 92.0%  (TP 23 / FP 10 / FN 2)
  localization(±1) 87.0%  clean-case FP 0  parseErrors 0
```

`npm run report` rewrites `eval/comparison.md` — the headline table there should read
**79.3 / 80.0 (locked-12) / 70.8** (agent / −memory locked-12 / baseline). `*` localization is 92.3% for the agent's
original 13-TP pass and 85.7% over the final 14 TPs; the committed `eval/comparison.md` shows
85.7% for both systems on the final matching.

Read a result without an API key:

```bash
npm run demo -- --case case_12   # renders runs/agent/case_12/run.jsonl → readable trajectory
cat runs/agent/case_12/report.md # the cover-up report
```

## Path B — live regeneration (~70 min, ~$65 total)

### Provider setup (either works, zero code change)

**(a) AgentRouter proxy** (what we built with — [docs](https://agentrouter.org/docs/claude-code.html)):
```
ANTHROPIC_AUTH_TOKEN=<your router key>     # sent as Bearer
ANTHROPIC_BASE_URL=https://agentrouter.org # no /v1 suffix
ANTHROPIC_MODEL=claude-opus-5
```

**(b) Direct Anthropic:**
```
ANTHROPIC_API_KEY=sk-ant-...
```

Both variants are documented in `.env.example`. The model string actually used is recorded in
every run's `meta.json`. Note: AgentRouter gates on client identity — requests carry the Claude
Code `user-agent` header (set once in `src/lib/anthropic.ts`).

### Commands, in order

```bash
cp .env.example .env                 # then paste your key into .env
npm run smoke                        # ~5 s, ≈$0.01 — must print OK and the resolved model

npm run gen:dataset                  # 12 clean sessions + deterministic injection, ~35 min, ≈$10
npm run baseline                     # one-shot baseline, ~7 min, ≈$3.20
npm run agent                        # Confess, ~32 min, ≈$30
npm run eval -- --run baseline
npm run eval -- --run agent
npm run ablate -- --off memory       # ablation, ~28 min, ≈$25
npm run eval -- --run agent-ablation-memory --out results-agent-ablation-memory
npm run report                       # rebuilds eval/comparison.md from all results-*.json
```

Expected wall/cost figures are from our run logs (`runs/*/case_*/meta.json`), not estimates.

### Expected results

- `eval/results-agent.json`: F1 0.824, P 0.737, R 0.933, 14 TP / 5 FP / 1 FN, clean-case FP 0
- `eval/results-baseline.json`: F1 0.757, P 0.636, R 0.933, 14 TP / 8 FP / 1 FN
- `eval/results-agent-ablation-memory.json`: F1 0.800 (P 0.700)
- 0 parse errors anywhere; case_12 shows 2/2 TP on both systems (the "cover-up" case)
- The known shared miss: case_07's `tool_misuse` — both systems miss it; if yours doesn't,
  that's a genuine improvement over our run (temperature-0 outputs are stable but not frozen)

### The --strict evidence lens

By default the scorer reports evidence-tier failures as a diagnostic (see the "Findings failing
evidence-tier check" row: agent 0, baseline 10) without changing scores. `--strict` excludes
tier-failing findings from matching — harsher for the baseline, whose quoting is looser than
Confess's tool-enforced verbatim quotes:

```bash
npx tsx src/eval/score.ts --run baseline --strict --out results-baseline-strict   # F1 66.7
npx tsx src/eval/score.ts --run agent --strict --out results-agent-strict         # F1 82.4 (unchanged)
```

### Variance

LLM steps are temperature 0 but not bit-deterministic (especially through a proxy). Expect
per-run movement of ±1 TP/FP. The committed artifacts are the exact ones behind every number in
README/CHANGELOG; Path B reproduces the *process* and lands within a few points.

## Data

22 synthetic cases in `dataset/cases/` (8 scenario packs; cases 13/24 are defined in
`src/generate/scenarios.ts` as `PENDING_CASES` and regenerate when the provider is healthy) —
`trajectory.jsonl` (the input log), `labels.json`
(ground truth, read only by `src/eval/`), `meta.json`. Generated by `src/generate/`: the LLM
writes a *clean* session from a frozen prompt (cached in `dataset/.cache/`, seed 42), then code
applies deterministic failure injections — so labels are exact by construction and regeneration
with the same seed replays the same injections. The clean `case_11` contains only healthy
distractors; `case_12` is the 28-step "cover-up".

## Note on npm argument forwarding

Some npm versions (observed on 10.9.0/Windows) silently drop arguments after `--` in
`npm run` scripts — e.g. `npm run eval -- --run agent` scoring the default run instead.
Every eval run prints the scope it selected (`eval: <name> over N cases`) — check that line.
If args are dropped on your setup, invoke the scripts directly:

```bash
npx tsx src/eval/score.ts --run agent        # identical to npm run eval -- --run agent
npx tsx src/agent/run.ts --case case_12      # identical to npm run agent -- --case case_12
npx tsx src/render/renderTrajectory.ts --case case_12   # identical to npm run demo -- --case case_12
```

## Troubleshooting

- **401 "unauthorized client detected"** (AgentRouter): the client must present the Claude Code
  user-agent — `src/lib/anthropic.ts` sets it; don't remove `defaultHeaders`.
- **SDK receives a string instead of an object**: some proxies return JSON with a non-JSON
  content-type; `callRaw`/`smoke.ts` already normalize this.
- **`Request timed out` during generation**: the router can be slow; `timeout: 480_000` is set.
  Re-run — completed cases are cached, only failures regenerate.
- **`BUDGET GUARD` abort**: a case exceeded $8.00 (default). Findings so far are still written
  and scored as a truncated run. Raise via `MAX_RUN_COST` in `.env`.
- **Windows**: all IO is Node-side (no shell pipes in npm scripts); works in Git Bash and PowerShell.
