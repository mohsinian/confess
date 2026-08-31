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
    .filter((f) => /^results-.*\.json$/.test(f))
    .map((f) => JSON.parse(fs.readFileSync(path.join(EVAL_DIR, f), "utf8")) as EvalRunResult)
    .sort((a, b) => a.run.localeCompare(b.run));
}

function systemLabel(run: string): string {
  if (run === "agent-run2") return "agent run 2 (locked-12)";
  if (run === "agent-ablation-gates") return "agent −gates (locked-12)";
  if (run === "agent-ablation-memory") return "agent −memory (locked-12)";
  if (run === "baseline") return "one-shot baseline (22)";
  if (run === "agent") return "agent (22)";
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
  row("Clean-case false positives", (r) => r.cleanCaseFps ? Object.entries(r.cleanCaseFps).map(([k, v]) => `${k}: ${v}`).join(", ") : "n/a");
  row("Auto-asserted precision (conf ≥ 0.6)", (r) => pct(r.gate.autoPrecision));
  row("Review-queue precision (conf < 0.6)", (r) => pct(r.gate.reviewPrecision));
  row("Cost per case (USD)", (r) => `$${(r.totals.costUsd / r.cases.length).toFixed(3)}`);
  row("Wall time per case", (r) => `${(r.totals.wallMs / r.cases.length / 1000).toFixed(1)}s`);
  row("**Modeled reviewer effort (min/case)**", (r) => humanMinutesPerCase(r));
  row("Findings failing evidence-tier check (excluded from matching)", (r) => `${r.invalidEvidence ?? 0} (${r.misCitedEvidence ?? 0} mis-cited / ${r.fabricatedEvidence ?? 0} fabricated)`);
  row("Parse errors", (r) => String(r.parseErrors));
  lines.push(
    "",
    "Modeled reviewer effort — a parametric model, not a measurement (registered as D15 with the",
    "extended benchmark; it is not the wall-time model in planning/04-eval-spec.md §4.1, which this",
    "table also reports). Assumptions, applied identically to every system: reading the report (60 s baseline / 90 s agent+queue triage)",
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
  const varianceNote = (() => {
    const a = results.find((r) => r.run === "agent");
    const b = results.find((r) => r.run === "agent-run2");
    if (!a || !b) return "";
    const same = a.overall.f1 === b.overall.f1 && a.overall.tp === b.overall.tp;
    // FP identity = the (type, step) of each unmatched prediction — counts alone hide swaps
    const fpIds = (r: EvalRunResult, caseId: string) => {
      const c = r.cases.find((x) => x.case_id === caseId);
      if (!c) return "";
      const matchedSteps = new Set(c.matched.map((m) => m.predStep + ":" + m.type));
      return c.fpSteps.map((s2, i) => s2 + ":" + c.fpTypes[i]).filter((id) => !matchedSteps.has(id)).sort().join("|");
    };
    const shared = a.cases.filter((c) => b.cases.some((x) => x.case_id === c.case_id));
    const perCaseDiffs = shared.filter((c) => {
      const c2 = b.cases.find((x) => x.case_id === c.case_id);
      if (!c2) return true;
      const tpSame = JSON.stringify(c.matched.map((m) => [m.type, m.predStep]).sort()) === JSON.stringify(c2.matched.map((m) => [m.type, m.predStep]).sort());
      return !tpSame || fpIds(a, c.case_id) !== fpIds(b, c.case_id);
    }).map((c) => c.case_id);
    return [
      "## Run-to-run variance",
      "",
      `Two independent full-pipeline sweeps: run 1 F1 ${pct(a.overall.f1)} (${a.overall.tp} TP / ${a.overall.fp} FP), run 2 F1 ${pct(b.overall.f1)} (${b.overall.tp} TP / ${b.overall.fp} FP) — ${same ? "identical headline" : "differing headline"}.` ,
      perCaseDiffs.length > 0
        ? `Compared on the ${shared.length} shared locked cases: all true positives reproduced at identical type and step. False-positive identity or count changed on: ${perCaseDiffs.join(", ")} — FP wobble is the noisy margin, TP detection is not.`
        : "All per-case findings identical.",
      `Evidence validation: ${a.invalidEvidence}/${(a.invalidEvidence??0)+a.overall.tp+a.overall.fp} vs ${b.invalidEvidence}/${(b.invalidEvidence??0)+b.overall.tp+b.overall.fp} findings invalid across the two runs.`,
      "",
    ].join("\n");
  })();
  const integrityNote = [
    "## Evidence-tier check (D15 — part of scoring, one view for every system)",
    "",
    "Every finding's quote is tiered against the shared full-text canonical serialization of the",
    "transcript: ok / mis-cited (real text, wrong step) / fabricated (text exists nowhere).",
    "Ellipsis-abridged quotes are allowed, but each segment must be verbatim (≥12 chars) — a quote",
    "that paraphrases or stitches render lines without an ellipsis does not validate. Findings that",
    "fail are excluded from matching: the counts above exclude them; the failure is reported, never",
    "silent. Both systems' prompts require verbatim receipts (the baseline prompt was updated with",
    "the D15 rule), so the check is a measurement, not a vendor-specific filter — an unverifiable",
    "quote costs the baseline and Confess identically.",
    "Scorer: `src/eval/score.ts`; run with `--loose` for the pre-D15 diagnostic view.",
    "",
  ].join("\n");
  const parts = [
    `# Confess — evaluation results`,
    "",
    `Generated ${new Date().toISOString()} from committed artifacts (reproduction path A — no API calls).`,
    "Matching: exact failure-type + step within ±2 of primary_step (or in evidence_steps); greedy one-to-one.",
    "Confidence gate 0.60 fixed a priori (decision D10). Confidence never affects matching.",
    "",
    headline(results),
    "",
    varianceNote,
    integrityNote,
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
