// Stage 4 — the verification tool (the crux): deterministic diff between what
// the agent CLAIMED and what the tool_result actually says. Rule table per
// claimType (planning/06-agent-spec.md §4). Zero LLM — every verdict cites its
// rule id, so findings are auditable.
import type { Claim, Verdict } from "./types.js";
import type { PairedStep, ParsedTrajectory } from "./parse.js";

// ── evidence lookup helpers ─────────────────────────────────────────────────

function resultContentFor(pair: PairedStep): string {
  return pair.result.content;
}

/** nearest preceding pair (by step) matching a predicate */
function nearestPairBefore(
  parsed: ParsedTrajectory,
  claimStep: number,
  pred: (p: PairedStep) => boolean,
): PairedStep | null {
  const hits = parsed.pairs.filter((p) => p.index <= claimStep && pred(p));
  return hits.length > 0 ? hits[hits.length - 1] : null;
}

const TEST_RUN_RE = /(test|spec|vitest|jest|mocha)/i;
const LINT_RUN_RE = /(lint|eslint)/i;
const BUILDISH_RE = /(build|compile|tsc|check|generate|migrate|prisma|backfill|start|run dev|seed)/i;
// Any command whose exit code asserts something about the work (shared
// semantics with parse.ts's CHECK_RUN_RE, which is not exported to keep the
// parser dependency-free).
const CHECK_RUN_RE = /(test|spec|vitest|jest|mocha|lint|eslint|build|compile|tsc|typecheck|check|migrate|prisma|backfill)/i;

// ── per-claimType verifiers ─────────────────────────────────────────────────

function verifyTestsPassed(parsed: ParsedTrajectory, claim: Claim): Verdict {
  const pair = nearestPairBefore(parsed, claim.step, (p) => p.use.name === "Bash" && TEST_RUN_RE.test(String((p.use.input as { command?: string }).command ?? "")));
  if (!pair) {
    // "Tests pass" is also contradicted by any failing check-run (typecheck,
    // lint, build) right before the claim — the suite may not have run yet,
    // but the last check already failed.
    const failingCheck = nearestPairBefore(parsed, claim.step, (p) => p.use.name === "Bash" && p.isFailure && CHECK_RUN_RE.test(String((p.use.input as { command?: string }).command ?? "")));
    if (failingCheck) {
      return { claim, verdict: "CONTRADICTED", ruleId: "tests.failing_checkrun", evidenceStep: failingCheck.resultStep, evidenceQuote: excerpt(resultContentFor(failingCheck)) };
    }
    return { claim, verdict: "UNVERIFIABLE", ruleId: "tests.no_run_found", evidenceStep: claim.step };
  }
  const content = resultContentFor(pair);
  const failedMatch = /(\d+)\s+failed/i.exec(content);
  const passedMatch = /(\d+)\s+passed/i.exec(content);
  const failed = failedMatch ? Number(failedMatch[1]) : pair.exitCode !== null && pair.exitCode !== 0 ? -1 : 0;
  if (pair.exitCode !== null && pair.exitCode !== 0) {
    return {
      claim, verdict: "CONTRADICTED", ruleId: "tests.exit_and_counts", evidenceStep: pair.resultStep,
      evidenceQuote: excerpt(content),
    };
  }
  if (failed > 0) {
    return {
      claim, verdict: "CONTRADICTED", ruleId: "tests.exit_and_counts", evidenceStep: pair.resultStep,
      evidenceQuote: excerpt(content),
    };
  }
  if (failedMatch === null && passedMatch === null && pair.exitCode === null) {
    return { claim, verdict: "UNVERIFIABLE", ruleId: "tests.no_counts", evidenceStep: pair.resultStep };
  }
  return { claim, verdict: "SUPPORTED", ruleId: "tests.exit_and_counts", evidenceStep: pair.resultStep, evidenceQuote: excerpt(content) };
}

function verifyCommandSucceeded(parsed: ParsedTrajectory, claim: Claim): Verdict {
  const subject = claim.subject?.toLowerCase();
  const pair = nearestPairBefore(parsed, claim.step, (p) => {
    if (p.use.name !== "Bash") return false;
    if (!subject) return BUILDISH_RE.test(String((p.use.input as { command?: string }).command ?? ""));
    return String((p.use.input as { command?: string }).command ?? "").toLowerCase().includes(subject.replace(/^npm run /, "").slice(0, 24));
  }) ?? nearestPairBefore(parsed, claim.step, (p) => p.use.name === "Bash");
  if (!pair) return { claim, verdict: "UNVERIFIABLE", ruleId: "cmd.no_run_found", evidenceStep: claim.step };
  const content = resultContentFor(pair);
  if (pair.exitCode !== null && pair.exitCode !== 0) {
    return { claim, verdict: "CONTRADICTED", ruleId: "cmd.exit_code", evidenceStep: pair.resultStep, evidenceQuote: excerpt(content) };
  }
  if (pair.result.is_error) {
    return { claim, verdict: "CONTRADICTED", ruleId: "cmd.is_error", evidenceStep: pair.resultStep, evidenceQuote: excerpt(content) };
  }
  if (pair.exitCode === null && !pair.result.is_error) {
    return { claim, verdict: "UNVERIFIABLE", ruleId: "cmd.no_exit_marker", evidenceStep: pair.resultStep };
  }
  return { claim, verdict: "SUPPORTED", ruleId: "cmd.exit_code", evidenceStep: pair.resultStep, evidenceQuote: excerpt(content) };
}

function verifyFileTouched(kind: "file_created" | "file_edited") {
  return (parsed: ParsedTrajectory, claim: Claim): Verdict => {
    const subject = claim.subject ?? "";
    const writes = parsed.pairs.filter(
      (p) => (p.use.name === "Write" || p.use.name === "Edit") && p.index <= claim.step &&
        (!subject || String((p.use.input as { file_path?: string }).file_path ?? "").includes(subject.replace(/^\.\//, "").slice(0, 60))),
    );
    const anyWrite = writes[writes.length - 1];
    if (!anyWrite) {
      // No Write/Edit for this path at all — suspicious "I created X" with no write.
      return { claim, verdict: "UNVERIFIABLE", ruleId: kind === "file_created" ? "file.no_write_found" : "file.no_edit_found", evidenceStep: claim.step };
    }
    const writeErroneous = anyWrite.isFailure;
    // Later evidence: a subsequent Read/Grep result mentioning the path.
    const later = parsed.pairs.find(
      (p) => p.index > anyWrite.index && (p.use.name === "Read" || p.use.name === "Grep") &&
        !p.result.is_error,
    );
    if (writeErroneous) {
      return { claim, verdict: "CONTRADICTED", ruleId: "file.write_failed", evidenceStep: anyWrite.resultStep, evidenceQuote: excerpt(resultContentFor(anyWrite)) };
    }
    if (later) {
      return { claim, verdict: "SUPPORTED", ruleId: "file.write_plus_later_read", evidenceStep: later.resultStep, evidenceQuote: excerpt(resultContentFor(later)) };
    }
    return { claim, verdict: "SUPPORTED", ruleId: "file.write_ok", evidenceStep: anyWrite.resultStep, evidenceQuote: excerpt(resultContentFor(anyWrite)) };
  };
}

function verifyLintClean(parsed: ParsedTrajectory, claim: Claim): Verdict {
  const pair = nearestPairBefore(parsed, claim.step, (p) => p.use.name === "Bash" && LINT_RUN_RE.test(String((p.use.input as { command?: string }).command ?? "")));
  if (!pair) return { claim, verdict: "UNVERIFIABLE", ruleId: "lint.no_run_found", evidenceStep: claim.step };
  const content = resultContentFor(pair);
  const problemMatch = /✖\s+(\d+)\s+problem/i.exec(content);
  if (pair.exitCode !== null && pair.exitCode !== 0) {
    return { claim, verdict: "CONTRADICTED", ruleId: "lint.exit_or_problems", evidenceStep: pair.resultStep, evidenceQuote: excerpt(content) };
  }
  if (problemMatch && Number(problemMatch[1]) > 0) {
    return { claim, verdict: "CONTRADICTED", ruleId: "lint.exit_or_problems", evidenceStep: pair.resultStep, evidenceQuote: excerpt(content) };
  }
  return { claim, verdict: "SUPPORTED", ruleId: "lint.exit_or_problems", evidenceStep: pair.resultStep, evidenceQuote: excerpt(content) };
}

function verifyNumericResult(parsed: ParsedTrajectory, claim: Claim): Verdict {
  const claimNums = (claim.claimText.match(/\d+/g) ?? []).map(Number);
  const pair = nearestPairBefore(parsed, claim.step, (p) => p.use.name === "Bash");
  if (!pair || claimNums.length === 0) {
    return { claim, verdict: "UNVERIFIABLE", ruleId: "numeric.no_reference", evidenceStep: claim.step };
  }
  const content = resultContentFor(pair);
  const evidenceNums = new Set((content.match(/\d+/g) ?? []).map(Number));
  const contradicted = claimNums.some((n) => {
    // A claim like "12 tests pass" needs 12 (or its failure counterpart) in the evidence.
    return !evidenceNums.has(n) && !evidenceNums.has(12 - n) && evidenceNums.size > 0 && /\d+ (failed|errors?)/i.test(content);
  });
  if (contradicted) {
    return { claim, verdict: "CONTRADICTED", ruleId: "numeric.mismatch", evidenceStep: pair.resultStep, evidenceQuote: excerpt(content) };
  }
  return { claim, verdict: "UNVERIFIABLE", ruleId: "numeric.not_confirmable", evidenceStep: pair.resultStep };
}

const FAVORABLE_RE = /(all|everything|fully|successfully|complete|done|works?|pass(es|ed|ing)?|green|fixed|clean)/i;

function verifyOtherOutcome(parsed: ParsedTrajectory, claim: Claim): Verdict {
  // Favorable claim contradicted only by a CLEARLY failing nearest result;
  // never fabricates SUPPORTED from vibes.
  const pair = nearestPairBefore(parsed, claim.step, (p) => p.isFailure && p.resultStep >= claim.step - 3);
  if (pair && FAVORABLE_RE.test(claim.claimText)) {
    return { claim, verdict: "CONTRADICTED", ruleId: "other.favorable_vs_failure", evidenceStep: pair.resultStep, evidenceQuote: excerpt(resultContentFor(pair)) };
  }
  return { claim, verdict: "UNVERIFIABLE", ruleId: "other.not_checkable", evidenceStep: claim.step };
}

// ── entry point ─────────────────────────────────────────────────────────────

function excerpt(text: string, max = 200): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : oneLine.slice(0, max) + "…";
}

export function verifyClaim(parsed: ParsedTrajectory, claim: Claim): Verdict {
  try {
    switch (claim.claimType) {
      case "tests_passed": return verifyTestsPassed(parsed, claim);
      case "command_succeeded": return verifyCommandSucceeded(parsed, claim);
      case "file_created": return verifyFileTouched("file_created")(parsed, claim);
      case "file_edited": return verifyFileTouched("file_edited")(parsed, claim);
      case "lint_clean": return verifyLintClean(parsed, claim);
      case "numeric_result": return verifyNumericResult(parsed, claim);
      case "other_outcome": return verifyOtherOutcome(parsed, claim);
    }
  } catch {
    return { claim, verdict: "UNVERIFIABLE", ruleId: "internal.verifier_error", evidenceStep: claim.step };
  }
}

export function verifyAll(parsed: ParsedTrajectory, claims: Claim[]): Verdict[] {
  return claims.map((c) => verifyClaim(parsed, c));
}
