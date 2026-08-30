// Agent pipeline orchestration: parse → detectors → claims → verify → memory
// → diagnosis agent → confidence gate → report. Every stage writes its output
// to runs/agent/<case>/stages/ so per-iteration snapshots and ablations are
// auditable. Usage:
//   npm run agent [-- --case case_12] [-- --off memory|verify|detectors]
import fs from "node:fs";
import path from "node:path";
import { loadProviderConfig, makeClient, Budget, runId, BudgetExceededError } from "../lib/anthropic.js";
import { RunLog } from "../lib/runlog.js";
import { listCases, runDir, ensureDir, trajectoryPath } from "../lib/cases.js";
import { parseTrajectory } from "./parse.js";
import { runDetectors } from "./detectors.js";
import { extractClaims } from "./claims.js";
import { verifyAll } from "./verify.js";
import { buildLedger } from "./memory.js";
import { runAgentLoop } from "./diagnose.js";
import { diagnosisReportSchema, zodErrors } from "../schema.js";
import { GATE_THRESHOLD, type DiagnosisReport, type Finding, type Trajectory } from "../types.js";

export interface Options {
  only?: string;
  off: { memory: boolean; verify: boolean; detectors: boolean };
  /** label run directory runs/<tag>/<case> (e.g. run2 for variance measurement) */
  tag?: string;
  /** pre-audit degradation reasons (e.g. ingest warnings: malformed log, unparseable lines) */
  degradationReasons?: string[];
}

/** Optional integrations for embedders of the pipeline (the CLI passes both). */
export interface AuditHooks {
  /** progress callback — called as each pipeline stage starts */
  onStage?: (stage: string) => void;
  /** write artifacts under <outBase>/<caseId>/ instead of ROOT/runs/<tag>/<caseId>/ */
  outBase?: string;
}

function parseArgs(): Options {
  const args = process.argv.slice(2);
  const caseIdx = args.indexOf("--case");
  const offIdx = args.indexOf("--off");
  const off = { memory: false, verify: false, detectors: false };
  if (offIdx !== -1) {
    for (const comp of args[offIdx + 1].split(",")) {
      if (comp === "memory") off.memory = true;
      else if (comp === "verify") off.verify = true;
      else if (comp === "detectors") off.detectors = true;
    }
  }
  const tagIdx = args.indexOf("--tag");
  return { only: caseIdx !== -1 ? args[caseIdx + 1] : undefined, off, tag: tagIdx !== -1 ? args[tagIdx + 1] : undefined };
}

async function loadTrajectory(caseId: string): Promise<Trajectory> {
  const raw = await fs.promises.readFile(trajectoryPath(caseId), "utf8");
  return raw.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

export function findingsFromDrafts(
  drafts: Array<{ failure_type: string; step: number; summary: string; evidence_quote: string; evidence_step: number; confidence: number; suggested_fix: string }>,
): Finding[] {
  return drafts.map((d) => ({
    failure_type: d.failure_type as Finding["failure_type"],
    step: d.step,
    summary: d.summary,
    evidence_quote: d.evidence_quote,
    evidence_step: d.evidence_step,
    confidence: d.confidence,
    needs_human_review: d.confidence < GATE_THRESHOLD,
    suggested_fix: d.suggested_fix,
  }));
}

export function findingsMarkdown(report: DiagnosisReport): string {
  const head = `# CONFESS — ${report.case_id} (${report.system})\n`;
  if (report.parse_error) return head + `\n## ⚠ pipeline error\n\n${report.parse_error}\n`;
  const sections: string[] = [head];
  if (report.truncated) {
    sections.push("> ⚠ Audit truncated (budget guard) before diagnosis completed — findings so far are partial.\n");
  }
  if (report.degraded) {
    sections.push("> ⚠ Audit DEGRADED — a stage failed or the log was malformed; evidence is incomplete. A degraded audit can never be a clean verdict.\n");
  }
  const review = report.findings.filter((f) => f.needs_human_review);
  const auto = report.findings.filter((f) => !f.needs_human_review);
  sections.push(`## Confessions (${auto.length} asserted, ${review.length} pending human review)\n`);
  const row = (f: Finding) =>
    `| ${f.failure_type} | ${f.step} | ${f.evidence_step} | ${f.confidence.toFixed(2)} | ${f.summary.replace(/\|/g, "/")} |`;
  if (report.findings.length > 0) {
    sections.push("| type | step | evidence@ | conf | summary |", "|---|---|---|---|---|", ...report.findings.map(row), "");
  } else if (report.truncated || report.degraded) {
    sections.push("No findings — but the audit was truncated or degraded, so this is NOT a clean verdict (see assessment).\n");
  } else {
    sections.push("No failures detected — the session's claims check out against its tool results.\n");
  }
  for (const f of report.findings) {
    sections.push(
      `### ${f.failure_type} @ step ${f.step} (confidence ${f.confidence.toFixed(2)})${f.needs_human_review ? "  ⚑ NEEDS HUMAN REVIEW" : ""}`,
      "",
      f.summary,
      "",
      `> evidence @ step ${f.evidence_step}: "${f.evidence_quote}"`,
      "",
      `**Suggested fix:** ${f.suggested_fix}`,
      "",
    );
  }
  if (review.length > 0) {
    sections.push(
      "## Review Queue",
      "",
      "Findings below the 0.60 confidence line are routed here for a qualified human — Confess does not auto-assert them.",
      "",
      ...review.map((f) => `- [ ] ${f.failure_type} @ step ${f.step} (conf ${f.confidence.toFixed(2)}): ${f.summary}`),
      "",
    );
  }
  sections.push(`## Assessment`, "", report.overall_assessment, "");
  return sections.join("\n");
}

async function runAudit(
  caseId: string,
  events: Trajectory,
  cfg: ReturnType<typeof loadProviderConfig>,
  opts: Options,
  runTag: string,
  hooks: AuditHooks = {},
): Promise<DiagnosisReport> {
  const client = makeClient(cfg);
  const budget = new Budget(cfg.maxRunCost);
  const systemName = opts.off.memory || opts.off.verify || opts.off.detectors ? "agent-ablation" : "agent";
  const dir = hooks.outBase ? path.join(hooks.outBase, caseId) : runDir(runTag, caseId);
  await ensureDir(dir);
  const stagesDir = path.join(dir, "stages");
  await ensureDir(stagesDir);
  const log = new RunLog(path.join(dir, "run.jsonl"));
  const id = runId(runTag);
  const started = Date.now();
  await log.append(caseId, "run_start", { system: systemName, off: opts.off, model: cfg.model });

  hooks.onStage?.("parse");
  const parsed = parseTrajectory(events);
  await fs.promises.writeFile(path.join(stagesDir, "parse.json"), JSON.stringify({ steps: parsed.steps.length, pairs: parsed.pairs.length }, null, 2));

  // Stage 2: detectors
  hooks.onStage?.("detectors");
  const signals = opts.off.detectors ? [] : runDetectors(parsed);
  await fs.promises.writeFile(path.join(stagesDir, "signals.json"), JSON.stringify(signals, null, 2));

  const stageErrors: string[] = [...(opts.degradationReasons ?? [])];
  if (parsed.duplicateToolIds.length > 0) {
    stageErrors.push(`malformed log: duplicate tool ids ${parsed.duplicateToolIds.join(", ")} (first result kept)`);
  }

  // Stage 3: claims
  let claims: Awaited<ReturnType<typeof extractClaims>>["claims"] = [];
  let verdicts: ReturnType<typeof verifyAll> = [];
  if (!opts.off.verify) {
    try {
      hooks.onStage?.("claims");
      claims = (await extractClaims(client, cfg, budget, log, parsed)).claims;
      await fs.promises.writeFile(path.join(stagesDir, "claims.json"), JSON.stringify(claims, null, 2));
      // Stage 4: verification
      hooks.onStage?.("verify");
      verdicts = verifyAll(parsed, claims);
      await fs.promises.writeFile(path.join(stagesDir, "verdicts.json"), JSON.stringify(verdicts, null, 2));
    } catch (e) {
      stageErrors.push(`claims/verify: ${(e as Error).message.slice(0, 160)}`);
      await log.append(caseId, "error", { stage: "claims/verify", message: (e as Error).message });
    }
  }

  // Stage 5: memory
  let constraints: Awaited<ReturnType<typeof buildLedger>>["constraints"] = [];
  let violations: Awaited<ReturnType<typeof buildLedger>>["violations"] = [];
  if (!opts.off.memory) {
    try {
      hooks.onStage?.("memory");
      const ledger = await buildLedger(client, cfg, budget, log, parsed);
      constraints = ledger.constraints;
      violations = ledger.violations;
      await fs.promises.writeFile(path.join(stagesDir, "ledger.json"), JSON.stringify({ constraints, violations }, null, 2));
    } catch (e) {
      stageErrors.push(`memory: ${(e as Error).message.slice(0, 160)}`);
      await log.append(caseId, "error", { stage: "memory", message: (e as Error).message });
    }
  }

  // Stage 6: diagnosis agent
  let findings: Finding[] = [];
  let assessment = "";
  let turns = 0;
  let guardrailRejections = 0;
  let truncated = false;
  try {
    hooks.onStage?.("diagnose");
    const diag = await runAgentLoop(
      client, cfg, budget, log, caseId, parsed,
      { signals, verdicts, constraints, violations },
      { memory: !opts.off.memory, verify: !opts.off.verify, detectors: !opts.off.detectors },
    );
    findings = findingsFromDrafts(diag.findings);
    assessment = diag.assessment;
    turns = diag.turns;
    guardrailRejections = diag.guardrailRejections;
    truncated = diag.truncated;
  } catch (e) {
    if (e instanceof BudgetExceededError) {
      // Budget guard tripped: keep findings gathered so far, scored honestly as
      // a truncated run — an aborted audit still produced real evidence.
      await log.append(caseId, "error", { stage: "diagnose", message: (e as Error).message });
      truncated = true;
      assessment = `(audit truncated: budget guard — ${(e as Error).message})`;
    } else {
      await log.append(caseId, "error", { stage: "diagnose", message: (e as Error).message });
      assessment = `(diagnosis stage failed: ${(e as Error).message})`;
    }
  }

  // A run is DEGRADED when evidence stages failed, the log was malformed, or the
  // diagnosis never submitted — a degraded run must never read as a clean verdict.
  const submitted = assessment.length > 0 && !assessment.startsWith("(");
  const degraded = stageErrors.length > 0 || !submitted;
  if (degraded && stageErrors.length > 0) {
    await log.append(caseId, "error", { stage: "degraded", reasons: stageErrors });
  }
  const report: DiagnosisReport = {
    case_id: caseId,
    run_id: id,
    system: systemName,
    findings,
    overall_assessment: assessment,
    truncated,
    ...(degraded ? { degraded: true } : {}),
    stats: {
      inputTokens: budget.totals.inputTokens,
      outputTokens: budget.totals.outputTokens,
      costUsd: budget.totals.costUsd,
      wallMs: Date.now() - started,
      llmCalls: budget.totals.llmCalls,
    },
  };
  const check = diagnosisReportSchema.safeParse(report);
  if (!check.success) {
    // Never kill the sweep over one bad case: mark it, still write the report —
    // the scorer will treat the invalid report honestly as a miss.
    const detail = zodErrors(check.error).slice(0, 5).join("; ");
    report.parse_error = `agent report failed internal schema: ${detail}`;
    console.error(`  ${caseId}  SCHEMA ISSUE — ${detail}`);
    await log.append(caseId, "error", { stage: "report-schema", detail });
  }
  await fs.promises.writeFile(path.join(dir, "report.json"), JSON.stringify(report, null, 2), "utf8");
  await fs.promises.writeFile(path.join(dir, "report.md"), findingsMarkdown(report), "utf8");
  await fs.promises.writeFile(
    path.join(dir, "meta.json"),
    JSON.stringify({ case_id: caseId, run_id: id, system: systemName, off: opts.off, model: cfg.model, turns, guardrailRejections, truncated, degraded, stageErrors, stats: report.stats }, null, 2),
    "utf8",
  );
  await log.append(caseId, "run_end", { findings: findings.length, turns, stats: report.stats });
  return report;
}

/** Audit a case from the committed dataset (derives the run tag from ablation flags). */
export async function runCase(caseId: string, cfg: ReturnType<typeof loadProviderConfig>, opts: Options): Promise<DiagnosisReport> {
  const runTag = opts.off.memory || opts.off.verify || opts.off.detectors
    ? `agent-ablation${opts.off.memory ? "-memory" : ""}${opts.off.verify ? "-verify" : ""}${opts.off.detectors ? "-detectors" : ""}`
    : opts.tag ?? "agent";
  const events = await loadTrajectory(caseId);
  return runAudit(caseId, events, cfg, opts, runTag);
}

/** Audit an arbitrary trajectory (e.g. a real Claude Code session via ingest). */
export { runAudit };

async function main(): Promise<void> {
  const opts = parseArgs();
  const cfg = loadProviderConfig();
  const caseIds = opts.only ? [opts.only] : await listCases();
  if (caseIds.length === 0) {
    console.error("No cases found — run `npm run gen:dataset` first.");
    process.exit(1);
  }
  const label = opts.off.memory || opts.off.verify || opts.off.detectors ? `agent (−${[opts.off.memory && "memory", opts.off.verify && "verify", opts.off.detectors && "detectors"].filter(Boolean).join(", −")})` : "agent";
  console.log(`confess v0.1 — ${label} over ${caseIds.length} cases (model ${cfg.model})`);
  let totalCost = 0;
  for (const caseId of caseIds) {
    try {
      const report = await runCase(caseId, cfg, opts);
      totalCost += report.stats.costUsd;
      const flagged = report.findings.filter((f) => f.needs_human_review).length;
      console.log(
        `  ${caseId}  ${report.findings.length} findings (${flagged} ⚑)  $${report.stats.costUsd.toFixed(3)}  ${(report.stats.wallMs / 1000).toFixed(1)}s`,
      );
    } catch (e) {
      if (e instanceof BudgetExceededError) {
        console.error(`  ${caseId}  ABORTED — ${(e as Error).message}`);
        continue;
      }
      throw e;
    }
  }
  console.log(`\nDone. Total cost $${totalCost.toFixed(3)}. Reports in runs/.`);
}

// Run the sweep only when invoked directly (`npm run agent` / `npm run ablate`),
// not when this module is imported by the CLI or tests.
const entry = path.basename(process.argv[1] ?? "");
if (entry === "run.ts" || entry === "run.js") {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
