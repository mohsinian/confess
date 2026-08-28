// One-shot baseline: what a person with an LLM does today — paste the whole
// log, ask for failures. Same model, temp 0, same taxonomy text, same one
// repair policy as the agent. Usage: npm run baseline [-- --case case_01]
import fs from "node:fs";
import path from "node:path";
import { loadProviderConfig, makeClient, Budget, callJson, runId, BudgetExceededError } from "../lib/anthropic.js";
import { RunLog } from "../lib/runlog.js";
import { listCases, runDir, ensureDir, trajectoryPath } from "../lib/cases.js";
import { serializeTrajectory } from "../lib/serialize.js";
import { llmReportSchema } from "../schema.js";
import { BASELINE_SYSTEM_PROMPT } from "./prompts.js";
import { GATE_THRESHOLD, type DiagnosisReport, type Finding, type Trajectory } from "../types.js";

async function loadTrajectory(caseId: string): Promise<Trajectory> {
  const raw = await fs.promises.readFile(trajectoryPath(caseId), "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function findingMarkdown(report: DiagnosisReport): string {
  if (report.parse_error) {
    return `## ⚠ parse error\n\n${report.parse_error}\n`;
  }
  if (report.findings.length === 0) {
    return `No failures detected.\n\n${report.overall_assessment}\n`;
  }
  const rows = report.findings.map(
    (f) =>
      `| ${f.failure_type} | ${f.step} | ${f.evidence_step} | ${f.confidence.toFixed(2)}${f.needs_human_review ? " ⚑ review" : ""} | ${f.summary.replace(/\|/g, "/")} |`,
  );
  return [
    `## Findings (${report.findings.length})`,
    "",
    "| type | step | evidence@ | conf | summary |",
    "|---|---|---|---|---|",
    ...rows,
    "",
    report.overall_assessment,
  ].join("\n");
}

async function runCase(caseId: string, cfg: ReturnType<typeof loadProviderConfig>): Promise<DiagnosisReport> {
  const client = makeClient(cfg);
  const budget = new Budget(cfg.maxRunCost);
  const id = runId("baseline");
  const dir = runDir("baseline", caseId);
  await ensureDir(dir);
  const log = new RunLog(path.join(dir, "run.jsonl"));
  await log.append(caseId, "run_start", { system: "baseline", model: cfg.model });

  const events = await loadTrajectory(caseId);
  const transcript = serializeTrajectory(events);
  const started = Date.now();

  let findings: Finding[] = [];
  let assessment = "";
  let parseError: string | undefined;
  try {
    const result = await callJson(client, cfg, {
      stage: `baseline:${caseId}`,
      system: BASELINE_SYSTEM_PROMPT,
      messages: [{ role: "user", content: `# Session transcript\n\n${transcript}` }],
      schema: llmReportSchema,
      maxTokens: 8000,
      budget,
      log,
    });
    findings = result.data.findings.map((f) => ({
      ...f,
      needs_human_review: f.confidence < GATE_THRESHOLD,
    }));
    assessment = result.data.overall_assessment;
  } catch (e) {
    if (e instanceof BudgetExceededError) throw e;
    parseError = `baseline output could not be salvaged: ${(e as Error).message}`;
    console.error(`  ${caseId}: PARSE ERROR — ${parseError.split("\n")[0]}`);
  }

  const report: DiagnosisReport = {
    case_id: caseId,
    run_id: id,
    system: "baseline",
    findings,
    overall_assessment: assessment || parseError || "(no assessment)",
    ...(parseError ? { parse_error: parseError } : {}),
    stats: {
      inputTokens: budget.totals.inputTokens,
      outputTokens: budget.totals.outputTokens,
      costUsd: budget.totals.costUsd,
      wallMs: Date.now() - started,
      llmCalls: budget.totals.llmCalls,
    },
  };
  await fs.promises.writeFile(path.join(dir, "report.json"), JSON.stringify(report, null, 2), "utf8");
  await fs.promises.writeFile(
    path.join(dir, "report.md"),
    `# BASELINE — ${caseId}\n\n${findingMarkdown(report)}\n\n---\nstats: ${JSON.stringify(report.stats)}\n`,
    "utf8",
  );
  await fs.promises.writeFile(
    path.join(dir, "meta.json"),
    JSON.stringify({ case_id: caseId, run_id: id, system: "baseline", model: cfg.model, stats: report.stats }, null, 2),
    "utf8",
  );
  await log.append(caseId, "run_end", { findings: findings.length, stats: report.stats });
  return report;
}

async function main() {
  const args = process.argv.slice(2);
  const caseIdx = args.indexOf("--case");
  const only = caseIdx !== -1 ? args[caseIdx + 1] : undefined;
  const cfg = loadProviderConfig();
  const caseIds = only ? [only] : await listCases();
  if (caseIds.length === 0) {
    console.error("No cases found — run `npm run gen:dataset` first.");
    process.exit(1);
  }
  console.log(`confess v0.1 — baseline over ${caseIds.length} cases (model ${cfg.model})`);
  let totalCost = 0;
  for (const caseId of caseIds) {
    const report = await runCase(caseId, cfg);
    totalCost += report.stats.costUsd;
    const flags = report.findings.filter((f) => f.needs_human_review).length;
    console.log(
      `  ${caseId}  ${report.findings.length} findings (${flags} flagged)  $${report.stats.costUsd.toFixed(3)}  ${(report.stats.wallMs / 1000).toFixed(1)}s${report.parse_error ? "  [PARSE ERROR]" : ""}`,
    );
  }
  console.log(`\nDone. Total cost $${totalCost.toFixed(3)}. Reports in runs/baseline/.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
