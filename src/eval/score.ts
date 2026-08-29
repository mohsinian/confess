// Scorer: matching + metrics (planning/04-eval-spec.md).
// Primary metric: failure-detection F1 — type must match EXACTLY, step within
// ±2 of primary_step or in evidence_steps. Greedy one-to-one matching sorted by
// (step distance, confidence). Confidence never affects matching (D9).
//
// CLI: npm run eval -- --run baseline [--out results-baseline] [--selftest]
import fs from "node:fs";
import path from "node:path";
import { EVAL_DIR, listCases, labelsPath, runDir, ensureDir, trajectoryPath } from "../lib/cases.js";
import { diagnosisReportSchema, labelsFileSchema } from "../schema.js";
import { FAILURE_TYPES, type DiagnosisReport, type FailureLabel, type Finding, type LabelsFile } from "../types.js";

export interface CaseScore {
  case_id: string;
  clean: boolean;
  tp: number;
  fp: number;
  fn: number;
  parseErrors: number;
  fnTypes: string[]; // missed GT types
  fpSteps: number[]; // unmatched prediction steps
  fpTypes: string[]; // unmatched prediction types
  /** findings excluded because their evidence did not validate against the log */
  invalidEvidence: number;
  localizationWithin1: number; // TPs with |Δstep| ≤ 1
  matched: Array<{ gtId: string; predStep: number; gtStep: number; type: string; delta: number; review: boolean }>;
}

export interface MatchInput {
  findings: Finding[];
  labels: FailureLabel[];
}

export interface MatchResult {
  tp: number; fp: number; fn: number;
  localizationWithin1: number;
  matched: CaseScore["matched"];
  fnTypes: string[]; fpSteps: number[]; fpTypes: string[];
}

export function matchFindings(findings: Finding[], labels: FailureLabel[]): MatchResult {
  const pairs: Array<{ pi: number; gi: number; dist: number }> = [];
  labels.forEach((g, gi) => {
    findings.forEach((p, pi) => {
      if (p.failure_type !== g.type) return; // exact type match, no cross-type credit
      const near = Math.abs(p.step - g.primary_step) <= 2;
      const inEvidence = g.evidence_steps.includes(p.step);
      if (near || inEvidence) {
        pairs.push({ pi, gi, dist: Math.abs(p.step - g.primary_step) });
      }
    });
  });
  // Greedy one-to-one: closest pairs first; ties broken by prediction confidence.
  pairs.sort((a, b) => a.dist - b.dist || (findings[b.pi].confidence - findings[a.pi].confidence));
  const usedP = new Set<number>();
  const usedG = new Set<number>();
  const matched: CaseScore["matched"] = [];
  for (const pair of pairs) {
    if (usedP.has(pair.pi) || usedG.has(pair.gi)) continue;
    usedP.add(pair.pi);
    usedG.add(pair.gi);
    const g = labels[pair.gi];
    const p = findings[pair.pi];
    matched.push({
      gtId: g.id, predStep: p.step, gtStep: g.primary_step,
      type: g.type, delta: p.step - g.primary_step, review: p.needs_human_review,
    });
  }
  const tp = matched.length;
  const fp = findings.length - tp;
  const fn = labels.length - tp;
  return {
    tp, fp, fn,
    localizationWithin1: matched.filter((m) => Math.abs(m.delta) <= 1).length,
    matched,
    fnTypes: labels.filter((_, gi) => !usedG.has(gi)).map((g) => g.type),
    fpSteps: findings.filter((_, pi) => !usedP.has(pi)).map((p) => p.step),
    fpTypes: findings.filter((_, pi) => !usedP.has(pi)).map((p) => p.failure_type),
  };
}

export interface Metrics {
  precision: number | null; // null = no predictions (reported as n/a, never as 0)
  recall: number | null;
  f1: number | null;
  tp: number; fp: number; fn: number;
}

export function metricsFromCounts(tp: number, fp: number, fn: number): Metrics {
  const precision = tp + fp > 0 ? tp / (tp + fp) : null;
  const recall = tp + fn > 0 ? tp / (tp + fn) : null;
  const f1 = precision !== null && recall !== null && precision + recall > 0
    ? (2 * precision * recall) / (precision + recall)
    : tp + fn === 0 ? null : 0;
  return { precision, recall, f1, tp, fp, fn };
}

export interface EvalRunResult {
  run: string;
  generatedAt: string;
  cases: CaseScore[];
  overall: Metrics & { localizationAccuracy: number | null };
  perType: Record<string, Metrics & { gtCount: number }>;
  gate: {
    autoTp: number; autoFp: number; reviewTp: number; reviewFp: number;
    autoPrecision: number | null; reviewPrecision: number | null;
  };
  cleanCaseFp: number | null;
  parseErrors: number;
  invalidEvidence: number;
  misCitedEvidence: number;
  fabricatedEvidence: number;
  totals: { inputTokens: number; outputTokens: number; costUsd: number; wallMs: number; llmCalls: number };
}

/**
 * Evidence validation, three tiers (ground rule 9: a TP must have checkable receipts):
 *  - ok:         every non-trivial segment of the quote (ellipsis-abridged allowed)
 *                appears in the cited step's canonical serialization
 *  - mis-cited:  segments appear somewhere in the log, but not in the cited step
 *  - fabricated: segments appear nowhere — invented evidence
 * Systems were shown the serialized transcript, so validation runs against the same
 * serialization (tool_use rendered as "name {json}", results as content), full text.
 */
const SEGMENT_MIN = 12; // ignore tiny fragments ("Error", a bare path) when segmenting

function stepText(events: Array<Record<string, unknown>>, step: number): string | null {
  // Mirrors lib/serialize.ts's rendering — systems were audited against this
  // canonical view (arrows, flags, rendered inputs), so validation uses it too.
  const ev = events.find((e) => (e.step as number) === step) as { content: Array<Record<string, unknown>> } | undefined;
  if (!ev) return null;
  return ev.content
    .map((b) => {
      if (b.type === "text") return String(b.text ?? "");
      if (b.type === "tool_use") return `  → tool_use ${b.id} ${b.name} ${JSON.stringify(b.input)}`;
      const isErr = b.is_error === true;
      const exit = /\[exit code: (\d+)\]\s*$/.exec(String(b.content ?? ""));
      const flag = isErr ? "[ERROR]" : exit && exit[1] !== "0" ? `[exit ${exit[1]}]` : "[ok]";
      return `  ← tool_result for ${b.tool_use_id} ${flag}\n${String(b.content ?? "")}`;
    })
    .join("\n");
}

function evidenceTier(f: Finding, events: Array<Record<string, unknown>>): "ok" | "mis-cited" | "fabricated" {
  const cited = stepText(events, f.evidence_step);
  const offending = stepText(events, f.step);
  if (cited === null || offending === null) return "fabricated"; // cites steps that do not exist
  const norm = (x: string) => x.replace(/\s+/g, " ").trim();
  const hay = norm(cited);
  const whole = norm(events.map((e) => stepText(events, e.step as number) ?? "").join("\n"));
  const segments = norm(f.evidence_quote)
    .split(/…|\.\.\./)
    .map((x) => x.trim())
    .filter((x) => x.length >= SEGMENT_MIN);
  if (segments.length === 0) return "fabricated"; // nothing checkable
  const inCited = segments.every((seg) => hay.includes(seg));
  if (inCited) return "ok";
  const inLog = segments.every((seg) => whole.includes(seg));
  return inLog ? "mis-cited" : "fabricated";
}

export async function scoreRun(runName: string, caseIds: string[]): Promise<EvalRunResult> {
  const cases: CaseScore[] = [];
  const totals = { inputTokens: 0, outputTokens: 0, costUsd: 0, wallMs: 0, llmCalls: 0 };
  let parseErrors = 0;
  let invalidEvidenceTotal = 0;
  let misCitedTotal = 0;
  let fabricatedTotal = 0;
  let autoTp = 0, autoFp = 0, reviewTp = 0, reviewFp = 0, cleanCaseFp: number | null = null;

  for (const caseId of caseIds) {
    const labelsFileRaw = JSON.parse(await fs.promises.readFile(labelsPath(caseId), "utf8"));
    const labelsFile = labelsFileSchema.parse(labelsFileRaw) as LabelsFile;
    let findings: Finding[] = [];
    let caseParseErrors = 0;
    try {
      const reportRaw = JSON.parse(
        await fs.promises.readFile(path.join(runDir(runName, caseId), "report.json"), "utf8"),
      );
      const check = diagnosisReportSchema.safeParse(reportRaw);
      if (!check.success) {
        // Honest scoring: an invalid report counts as all-missed, never dropped.
        caseParseErrors = 1;
        parseErrors += 1;
      } else {
        const report = check.data as DiagnosisReport;
        findings = report.findings;
        totals.inputTokens += report.stats.inputTokens;
        totals.outputTokens += report.stats.outputTokens;
        totals.costUsd += report.stats.costUsd;
        totals.wallMs += report.stats.wallMs;
        totals.llmCalls += report.stats.llmCalls;
      }
    } catch {
      caseParseErrors = 1;
      parseErrors += 1;
    }

    // Evidence integrity (ground rule 9): a finding must have checkable receipts.
    // Tiers: ok → scored normally; mis-cited (quote exists elsewhere in the log) and
    // fabricated (quote exists nowhere) → excluded from matching, counted, never
    // silently dropped. Type+step proximity alone must never earn a TP.
    let misCited = 0;
    let fabricated = 0;
    let events: Array<Record<string, unknown>> = [];
    try {
      events = (await fs.promises.readFile(trajectoryPath(caseId), "utf8"))
        .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    } catch { /* trajectory missing — skip validation, score as before */ }
    if (events.length > 0) {
      const valid = findings.filter((f) => {
        const tier = evidenceTier(f, events);
        if (tier === "mis-cited") misCited++;
        if (tier === "fabricated") fabricated++;
        return tier === "ok";
      });
      findings = valid;
    }
    const invalidEvidence = misCited + fabricated;

    invalidEvidenceTotal += invalidEvidence;
    misCitedTotal += misCited;
    fabricatedTotal += fabricated;
    const m = matchFindings(findings, labelsFile.failures);
    for (const match of m.matched) {
      if (match.review) reviewTp++; else autoTp++;
    }
    // Unmatched predictions split by their gate flag.
    for (const p of findings) {
      const wasMatched = m.matched.some((mm) => mm.predStep === p.step && mm.type === p.failure_type);
      if (!wasMatched) {
        if (p.needs_human_review) reviewFp++; else autoFp++;
      }
    }
    if (labelsFile.clean) cleanCaseFp = m.fp;

    cases.push({
      case_id: caseId,
      clean: labelsFile.clean,
      tp: m.tp, fp: m.fp, fn: m.fn,
      parseErrors: caseParseErrors,
      fnTypes: m.fnTypes,
      fpSteps: m.fpSteps,
      fpTypes: m.fpTypes,
      invalidEvidence,
      localizationWithin1: m.localizationWithin1,
      matched: m.matched,
    });
  }

  const tp = cases.reduce((a, c) => a + c.tp, 0);
  const fp = cases.reduce((a, c) => a + c.fp, 0);
  const fn = cases.reduce((a, c) => a + c.fn, 0);
  const loc = cases.reduce((a, c) => a + c.localizationWithin1, 0);
  const overall = {
    ...metricsFromCounts(tp, fp, fn),
    localizationAccuracy: tp > 0 ? loc / tp : null,
  };

  const perType: EvalRunResult["perType"] = {};
  const typeDetail = new Map<string, { tp: number; fp: number; fn: number; gt: number }>();
  const bump = (type: string, key: "tp" | "fp" | "fn" | "gt") => {
    const d = typeDetail.get(type) ?? { tp: 0, fp: 0, fn: 0, gt: 0 };
    d[key]++;
    typeDetail.set(type, d);
  };
  for (const c of cases) {
    for (const t of c.fnTypes) { bump(t, "fn"); bump(t, "gt"); }
    for (const t of c.fpTypes) bump(t, "fp");
    for (const m of c.matched) { bump(m.type, "tp"); bump(m.type, "gt"); }
  }
  for (const type of FAILURE_TYPES) {
    const d = typeDetail.get(type) ?? { tp: 0, fp: 0, fn: 0, gt: 0 };
    perType[type] = { ...metricsFromCounts(d.tp, d.fp, d.fn), gtCount: d.gt };
  }

  return {
    run: runName,
    generatedAt: new Date().toISOString(),
    cases,
    overall,
    perType,
    gate: {
      autoTp, autoFp, reviewTp, reviewFp,
      autoPrecision: autoTp + autoFp > 0 ? autoTp / (autoTp + autoFp) : null,
      reviewPrecision: reviewTp + reviewFp > 0 ? reviewTp / (reviewTp + reviewFp) : null,
    },
    cleanCaseFp,
    parseErrors,
    invalidEvidence: invalidEvidenceTotal,
    misCitedEvidence: misCitedTotal,
    fabricatedEvidence: fabricatedTotal,
    totals,
  };
}

// ── Selftest (planning/04-eval-spec.md §6) — no API needed ──────────────────

function selftest(): boolean {
  const label = (type: Finding["failure_type"], step: number, id: string): FailureLabel => ({
    id, type, primary_step: step, evidence_steps: [], description: "", mutation_id: "x",
  });
  const finding = (type: Finding["failure_type"], step: number, confidence = 0.9): Finding => ({
    failure_type: type, step, summary: "s", evidence_quote: "q", evidence_step: step,
    confidence, needs_human_review: confidence < 0.6, suggested_fix: "f",
  });
  const tests: Array<{ name: string; run: () => boolean; detail?: string }> = [];

  const t = (name: string, run: () => boolean) => tests.push({ name, run });

  t("perfect match → P=R=F1=1", () => {
    const m = matchFindings([finding("retry_loop", 5)], [label("retry_loop", 5, "f1")]);
    return m.tp === 1 && m.fp === 0 && m.fn === 0;
  });
  t("empty predictions on failing case → recall 0, precision n/a", () => {
    const m = matchFindings([], [label("retry_loop", 5, "f1")]);
    const met = metricsFromCounts(m.tp, m.fp, m.fn);
    return met.recall === 0 && met.precision === null && met.f1 === 0;
  });
  t("duplicate prediction → one TP + one FP (one-to-one)", () => {
    const m = matchFindings([finding("retry_loop", 5), finding("retry_loop", 5)], [label("retry_loop", 5, "f1")]);
    return m.tp === 1 && m.fp === 1;
  });
  t("wrong type at right step → FN + FP (no partial credit)", () => {
    const m = matchFindings([finding("tool_misuse", 5)], [label("retry_loop", 5, "f1")]);
    return m.tp === 0 && m.fn === 1 && m.fp === 1;
  });
  t("±2 tolerance: step+2 matches, step+3 does not", () => {
    const a = matchFindings([finding("retry_loop", 7)], [label("retry_loop", 5, "f1")]);
    const b = matchFindings([finding("retry_loop", 8)], [label("retry_loop", 5, "f1")]);
    return a.tp === 1 && b.tp === 0;
  });
  t("evidence_steps match beyond tolerance", () => {
    const l = label("constraint_violation", 9, "f1");
    l.evidence_steps = [2, 14];
    const m = matchFindings([finding("constraint_violation", 14)], [l]);
    return m.tp === 1;
  });
  t("localization: |Δ|≤1 counted separately", () => {
    const m = matchFindings([finding("retry_loop", 6)], [label("retry_loop", 5, "f1")]);
    const m2 = matchFindings([finding("retry_loop", 7)], [label("retry_loop", 5, "f1")]);
    return m.localizationWithin1 === 1 && m2.localizationWithin1 === 0;
  });
  t("confidence never affects matching (low-conf still matches)", () => {
    const m = matchFindings([finding("retry_loop", 5, 0.3)], [label("retry_loop", 5, "f1")]);
    return m.tp === 1;
  });

  let failed = 0;
  for (const test of tests) {
    const ok = test.run();
    if (!ok) failed++;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${test.name}`);
  }
  console.log(failed === 0 ? "selftest: all green" : `selftest: ${failed} FAILED`);
  return failed === 0;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

async function main() {
  if (process.argv.includes("--selftest")) {
    process.exit(selftest() ? 0 : 1);
  }
  const args = process.argv.slice(2);
  const runIdx = args.indexOf("--run");
  const outIdx = args.indexOf("--out");
  // Some npm versions drop args after "--" — also accept the run name positionally.
  const positional = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--run" && args[i - 1] !== "--out" && args[i - 1] !== "--tag");
  const runName = runIdx !== -1 ? args[runIdx + 1] : positional ?? "baseline";
  const outName = outIdx !== -1 ? args[outIdx + 1] : `results-${runName}`;
  const caseIds = await listCases();
  if (caseIds.length === 0) {
    console.error("No cases found — run `npm run gen:dataset` first.");
    process.exit(1);
  }
  const result = await scoreRun(runName, caseIds);
  await ensureDir(EVAL_DIR);
  await fs.promises.writeFile(
    path.join(EVAL_DIR, `${outName}.json`),
    JSON.stringify(result, null, 2),
    "utf8",
  );
  const o = result.overall;
  const pct = (x: number | null) => (x === null ? "n/a" : (x * 100).toFixed(1) + "%");
  console.log(`\neval: ${runName} over ${caseIds.length} cases`);
  console.log(`  F1 ${pct(o.f1)}  P ${pct(o.precision)}  R ${pct(o.recall)}  (TP ${o.tp} / FP ${o.fp} / FN ${o.fn})`);
  console.log(`  localization(±1) ${pct(o.localizationAccuracy)}  clean-case FP ${result.cleanCaseFp ?? "-"}  parseErrors ${result.parseErrors}`);
  console.log(`  cost $${result.totals.costUsd.toFixed(3)}  tokens in/out ${result.totals.inputTokens}/${result.totals.outputTokens}`);
  console.log(`  → eval/${outName}.json (markdown tables: npm run report)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
