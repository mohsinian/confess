// Aggregates committed eval/results-*.json into the comparison tables
// (planning/04-eval-spec.md §4). No API calls — this is reproduction path A.
import fs from "node:fs";
import path from "node:path";
import { EVAL_DIR } from "../lib/cases.js";
import type { EvalRunResult } from "./score.js";

const pct = (x: number | null | undefined) => (x === null || x === undefined ? "n/a" : (x * 100).toFixed(1) + "%");

function loadResults(): EvalRunResult[] {
  if (!fs.existsSync(EVAL_DIR)) return [];
  return fs
    .readdirSync(EVAL_DIR)
    .filter((f) => /^results-.*\.json$/.test(f) && !f.includes("-run2"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(EVAL_DIR, f), "utf8")) as EvalRunResult)
    .sort((a, b) => a.run.localeCompare(b.run));
}

function systemLabel(run: string): string {
  if (run === "baseline") return "baseline";
  if (run.startsWith("agent-ablation")) return run.replace("agent-ablation", "agent −"); // e.g. agent −memory
  if (run.startsWith("agent")) return "agent";
  return run;
}

function headline(results: EvalRunResult[]): string {
  const lines: string[] = [
    "## Headline comparison",
    "",
    "| METRIC | " + results.map((r) => systemLabel(r.run)).join(" | ") + " |",
    "|---|" + results.map(() => "---").join("|") + "|",
  ];
  const row = (label: string, get: (r: EvalRunResult) => string) =>
    lines.push(`| ${label} | ` + results.map(get).join(" | ") + " |");

  row("**Failure-detection F1 (primary)**", (r) => `**${pct(r.overall.f1)}**`);
  row("Precision / Recall", (r) => `${pct(r.overall.precision)} / ${pct(r.overall.recall)}`);
  row("Step-localization accuracy (TPs within ±1)", (r) => pct(r.overall.localizationAccuracy));
  row("Clean-case false positives (case_11)", (r) => String(r.cleanCaseFp ?? "n/a"));
  row("Auto-asserted precision (conf ≥ 0.6)", (r) => pct(r.gate.autoPrecision));
  row("Review-queue precision (conf < 0.6)", (r) => pct(r.gate.reviewPrecision));
  row("Cost per case (USD)", (r) => `$${(r.totals.costUsd / r.cases.length).toFixed(3)}`);
  row("Wall time per case", (r) => `${(r.totals.wallMs / r.cases.length / 1000).toFixed(1)}s`);
  row("**Human review time per case (est.)**", (r) => humanMinutesPerCase(r));
  row("Parse errors", (r) => String(r.parseErrors));
  lines.push(
    "",
    "Human review time model (pre-registered in `planning/04-eval-spec.md` §4.1, assumptions stated,",
    "applied identically to every system): reading the report (60 s baseline / 90 s agent+queue triage)",
    "+ 1.0 min per true positive confirmed + 4 min per false positive debunked (a phantom claim forces a",
    "manual re-read of the transcript section) + 2 min per review-queue item triaged. Machine wall time",
    "is excluded — it runs unattended. Estimates, not measurements: the FP term dominates the difference.",
  );
  return lines.join("\n");
}

/**
 * Estimated reviewer minutes per case. Assumptions (printed with the table):
 * TP 1 min (evidence quote + rule id make confirmation fast), FP 4 min (debunk
 * = re-read transcript), review-queue item 2 min, report read 60 s baseline /
 * 90 s agent. Identical formula for every system — the comparison is fair.
 */
function humanMinutesPerCase(r: EvalRunResult): string {
  const n = r.cases.length || 1;
  const tp = r.overall.tp / n;
  const fp = r.overall.fp / n;
  const reviewQueue = r.cases.reduce((a, c) => a + c.matched.filter((m) => m.review).length, 0) / n;
  const readMin = r.run === "baseline" ? 1.0 : 1.5;
  const minutes = readMin + tp * 1 + fp * 4 + reviewQueue * 2;
  return `${minutes.toFixed(1)} min`;
}

function perTypeTable(results: EvalRunResult[]): string {
  const lines = ["## Per-type breakdown", "", "| TYPE | GT n | " + results.map((r) => systemLabel(r.run) + " P / R").join(" | ") + " |", "|---|---|" + results.map(() => "---").join("|") + "|"];
  const types = Object.keys(results[0]?.perType ?? {});
  for (const type of types) {
    lines.push(
      `| ${type} | ${results[0].perType[type].gtCount} | ` +
        results.map((r) => `${pct(r.perType[type]?.precision)} / ${pct(r.perType[type]?.recall)}`).join(" | ") +
        " |",
    );
  }
  return lines.join("\n");
}

function perCaseTable(results: EvalRunResult[]): string {
  const lines = ["## Per-case", "", "| CASE | " + results.map((r) => systemLabel(r.run) + " TP/FP/FN").join(" | ") + " |", "|---|" + results.map(() => "---").join("|") + "|"];
  for (const c of results[0]?.cases ?? []) {
    lines.push(
      `| ${c.case_id}${c.clean ? " (clean)" : ""} | ` +
        results
          .map((r) => {
            const rc = r.cases.find((x) => x.case_id === c.case_id);
            return rc ? `${rc.tp}/${rc.fp}/${rc.fn}` : "-";
          })
          .join(" | ") +
        " |",
    );
  }
  return lines.join("\n");
}

function main(): void {
  const results = loadResults();
  if (results.length === 0) {
    console.error("No eval/results-*.json found. Run `npm run eval -- --run <system>` first.");
    process.exit(1);
  }
  const parts = [
    `# Confess — evaluation results`,
    "",
    `Generated ${new Date().toISOString()} from committed artifacts (reproduction path A — no API calls).`,
    "Matching: exact failure-type + step within ±2 of primary_step (or in evidence_steps); greedy one-to-one.",
    "Confidence gate 0.60 fixed a priori (decision D10). Confidence never affects matching.",
    "",
    headline(results),
    "",
    perTypeTable(results),
    "",
    perCaseTable(results),
  ];
  const out = path.join(EVAL_DIR, "comparison.md");
  fs.writeFileSync(out, parts.join("\n") + "\n", "utf8");
  console.log(parts.join("\n"));
  console.log(`\n→ ${out}`);
}

main();
