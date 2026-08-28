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
  row("Parse errors", (r) => String(r.parseErrors));
  return lines.join("\n");
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
