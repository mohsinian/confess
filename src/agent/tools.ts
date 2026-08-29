// Stage 6 tool definitions for the diagnosis agent. The log is accessed ONLY
// through these tools (context-efficient windowed reads, not a full dump).
import Anthropic from "@anthropic-ai/sdk";
import { isMeaningfulFailure, type ParsedTrajectory } from "./parse.js";
import { serializeTrajectory } from "../lib/serialize.js";
import { verifyClaim } from "./verify.js";
import type { Claim, Constraint, LedgerViolation, Signal, Verdict } from "./types.js";

export interface PrePass {
  signals: Signal[];
  verdicts: Verdict[];
  constraints: Constraint[];
  violations: LedgerViolation[];
}

export const DIAGNOSIS_TOOLS: Anthropic.Tool[] = [
  {
    name: "list_signals",
    description:
      "Get the deterministic pre-pass digest: retry-loop signals, unacknowledged-error signals, claim verdicts " +
      "(CONTRADICTED/UNVERIFIABLE with evidence steps), extracted user constraints, and ledger violations. " +
      "Treat as leads to confirm or dismiss — never as final verdicts.",
    input_schema: { type: "object" as const, properties: {} },
  },
  {
    name: "read_steps",
    description:
      "Read a window of the session transcript (serialized, with step numbers). Max window: 8 steps. " +
      "Use this before recording any finding, to confirm evidence in context.",
    input_schema: {
      type: "object" as const,
      properties: {
        from: { type: "integer", description: "first step (1-based, inclusive)" },
        to: { type: "integer", description: "last step (1-based, inclusive)" },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "search_log",
    description:
      "Search every event in the log for a substring (or regex). Returns matching steps with a one-line excerpt. " +
      "Max 20 hits.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "literal substring (or regex when regex=true)" },
        regex: { type: "boolean", description: "treat query as a regular expression" },
      },
      required: ["query"],
    },
  },
  {
    name: "verify_claim",
    description:
      "Re-run the deterministic claim verifier on the claims made at a given step. Returns verdicts with " +
      "rule ids and evidence quotes. Use when you need machine confirmation of a suspected false claim.",
    input_schema: {
      type: "object" as const,
      properties: { step: { type: "integer", description: "assistant step making the claim" } },
      required: ["step"],
    },
  },
  {
    name: "record_finding",
    description:
      "Record one confirmed failure. evidence_quote MUST be a verbatim substring of the transcript at " +
      "evidence_step (checked; rejected otherwise). confidence: 0.9+ deterministic contradiction; " +
      "0.7–0.9 strong inference; 0.6–0.7 pattern-based; below 0.6 speculative (a human reviews those).",
    input_schema: {
      type: "object" as const,
      properties: {
        failure_type: {
          type: "string",
          enum: ["hallucinated_success", "constraint_violation", "tool_misuse", "retry_loop", "error_swallowing"],
        },
        step: { type: "integer", description: "the agent's offending step" },
        summary: { type: "string", description: "1–2 sentences" },
        evidence_quote: { type: "string", description: "≤200 chars, verbatim from the log" },
        evidence_step: { type: "integer" },
        confidence: { type: "number" },
        suggested_fix: { type: "string" },
      },
      required: ["failure_type", "step", "summary", "evidence_quote", "evidence_step", "confidence", "suggested_fix"],
    },
  },
  {
    name: "submit_report",
    description:
      "Submit the final report. Rejected unless you have actually examined the log (read/searched steps) " +
      "and every recorded finding cites steps you have seen.",
    input_schema: {
      type: "object" as const,
      properties: {
        overall_assessment: { type: "string", description: "2–4 sentences, plain language" },
      },
      required: ["overall_assessment"],
    },
  },
];

// ── tool implementations (closures over the parsed trajectory + pre-pass) ──

export interface ToolboxResult {
  output: string;
  isError: boolean;
  /** bookkeeping for the submit guardrail */
  sawLogContent: boolean;
  stepsSeen: Set<number>;
}

export interface FindingDraft {
  failure_type: string;
  step: number;
  summary: string;
  evidence_quote: string;
  evidence_step: number;
  confidence: number;
  suggested_fix: string;
}

export class DiagnosisToolbox {
  findings: FindingDraft[] = [];
  submitted: string | null = null;
  sawLogContent = false;
  stepsSeen = new Set<number>();
  guardrailRejections = 0;

  constructor(
    private parsed: ParsedTrajectory,
    private prePass: PrePass,
    private enabled: { memory: boolean; verify: boolean; detectors: boolean },
  ) {}

  handle(name: string, input: Record<string, unknown>): ToolboxResult {
    switch (name) {
      case "list_signals": return this.listSignals();
      case "read_steps": return this.readSteps(Number(input.from), Number(input.to));
      case "search_log": return this.searchLog(String(input.query), input.regex === true);
      case "verify_claim": return this.verifyClaimAt(Number(input.step));
      case "record_finding": return this.recordFinding(input);
      case "submit_report": return this.submitReport(String(input.overall_assessment ?? ""));
      default: return { output: `unknown tool ${name}`, isError: true, sawLogContent: false, stepsSeen: new Set() };
    }
  }

  private ok(output: string, sawLog = false, steps: number[] = []): ToolboxResult {
    for (const s of steps) this.stepsSeen.add(s);
    if (sawLog) this.sawLogContent = true;
    return { output, isError: false, sawLogContent: sawLog, stepsSeen: new Set(steps) };
  }

  private err(output: string): ToolboxResult {
    return { output, isError: true, sawLogContent: false, stepsSeen: new Set() };
  }

  private listSignals(): ToolboxResult {
    const parts: string[] = [];
    if (this.enabled.detectors) {
      parts.push(
        this.prePass.signals.length
          ? this.prePass.signals.map((s) => `- [${s.kind}] ${"note" in s ? s.note : JSON.stringify(s)}`).join("\n")
          : "- no detector signals",
      );
    } else parts.push("(detector stage disabled in this configuration)");
    if (this.enabled.verify) {
      const bad = this.prePass.verdicts.filter((v) => v.verdict !== "SUPPORTED");
      parts.push(
        bad.length
          ? "Claim verdicts (non-SUPPORTED):\n" +
            bad.map((v) => `- [${v.verdict}] step ${v.claim.step} "${v.claim.claimText.slice(0, 80)}" rule=${v.ruleId}${v.evidenceStep ? ` evidence@${v.evidenceStep}` : ""}`).join("\n")
          : "Claim verdicts: all SUPPORTED (or no claims)",
      );
    } else parts.push("(verification stage disabled in this configuration)");
    if (this.enabled.memory) {
      parts.push(
        "Constraint ledger:\n" +
          (this.prePass.constraints.length
            ? this.prePass.constraints.map((c) => `- [${c.id}@step ${c.sourceStep}] ${c.checkKind}${c.target ? ` target="${c.target}"` : ""} "${c.statement}"`).join("\n")
            : "- no explicit constraints found") +
          (this.prePass.violations.length
            ? "\nLedger violations:\n" + this.prePass.violations.map((v) => `- ${v.how}`).join("\n")
            : "\nNo ledger violations detected by code checks"),
      );
    } else parts.push("(memory stage disabled in this configuration)");
    return this.ok(parts.join("\n\n"));
  }

  private readSteps(from: number, to: number): ToolboxResult {
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) {
      return this.err("read_steps needs integer from ≤ to, from ≥ 1");
    }
    const cappedTo = Math.min(to, from + 7); // window ≤ 8
    // Parser Steps use {index, blocks}; the serializer wants event shape {step, content}.
    const events = this.parsed.steps.map((s) => ({ step: s.index, type: s.type, content: s.blocks }));
    const text = serializeTrajectory(events, { from, to: cappedTo, maxResultChars: 700 });
    const seen = Array.from({ length: cappedTo - from + 1 }, (_, i) => from + i);
    return this.ok(text || `(no steps in ${from}–${cappedTo})`, true, seen);
  }

  private searchLog(query: string, useRegex: boolean): ToolboxResult {
    if (!query) return this.err("search_log needs a query");
    let re: RegExp;
    try {
      re = useRegex ? new RegExp(query, "i") : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    } catch (e) {
      return this.err(`bad regex: ${(e as Error).message}`);
    }
    const hits: string[] = [];
    for (const step of this.parsed.steps) {
      for (const b of step.blocks) {
        const text = b.type === "text" ? b.text : b.type === "tool_use" ? `${b.name} ${JSON.stringify(b.input).slice(0, 300)}` : b.content;
        const m = re.exec(text);
        if (m) {
          hits.push(`step ${step.index}: …${text.slice(Math.max(0, (m.index ?? 0) - 30), (m.index ?? 0) + 140).replace(/\s+/g, " ")}…`);
          this.stepsSeen.add(step.index);
          this.sawLogContent = true;
          break;
        }
      }
      if (hits.length >= 20) break;
    }
    return this.ok(hits.length ? hits.join("\n") : `no matches for "${query}"`, hits.length > 0);
  }

  private verifyClaimAt(step: number): ToolboxResult {
    if (!this.enabled.verify) return this.err("verification stage is disabled in this configuration");
    const verdicts = this.prePass.verdicts.filter((v) => v.claim.step === step);
    if (verdicts.length === 0) return this.err(`no claims were extracted at step ${step}`);
    this.sawLogContent = true;
    for (const v of verdicts) if (v.evidenceStep) this.stepsSeen.add(v.evidenceStep);
    return this.ok(
      verdicts
        .map((v) => `[${v.verdict}] "${v.claim.claimText}" rule=${v.ruleId}${v.evidenceStep ? ` evidence@step ${v.evidenceStep}` : ""}${v.evidenceQuote ? ` — "${v.evidenceQuote}"` : ""}`)
        .join("\n"),
      true,
      verdicts.map((v) => v.claim.step),
    );
  }

  private recordFinding(input: Record<string, unknown>): ToolboxResult {
    const evidenceStep = Number(input.evidence_step);
    const quote = String(input.evidence_quote ?? "");
    const confidence = Number(input.confidence);
    const step = Number(input.step);
    const failureType = String(input.failure_type ?? "");
    const summary = String(input.summary ?? "");
    const suggestedFix = String(input.suggested_fix ?? "");
    if (!["hallucinated_success", "constraint_violation", "tool_misuse", "retry_loop", "error_swallowing"].includes(failureType)) {
      return this.err(`invalid failure_type "${failureType}"`);
    }
    if (!Number.isInteger(step) || step < 1) return this.err("step must be a positive integer");
    if (!Number.isInteger(evidenceStep) || evidenceStep < 1) return this.err("evidence_step must be a positive integer");
    if (!(confidence >= 0 && confidence <= 1)) return this.err("confidence must be 0–1");
    if (!summary || !suggestedFix) return this.err("summary and suggested_fix are required");
    if (!quote) return this.err("evidence_quote is required (≤200 chars) — quote the actual evidence");
    if (quote.length > 200) return this.err("evidence_quote must be ≤200 chars");

    // Guardrail: the quote must be a verbatim substring of the cited step.
    const stepEv = this.parsed.steps.find((s) => s.index === evidenceStep);
    if (!stepEv) return this.err(`evidence_step ${evidenceStep} does not exist in this log`);
    const haystack = stepEv.blocks
      .map((b) => (b.type === "text" ? b.text : b.type === "tool_use" ? `${b.name} ${JSON.stringify(b.input)}` : b.content))
      .join("\n");
    if (!haystack.includes(quote)) {
      return this.err(
        `evidence_quote is not a verbatim substring of step ${evidenceStep}. Read the step again and copy exactly. ` +
          `Available excerpt: "${haystack.slice(0, 200).replace(/\s+/g, " ")}…"`,
      );
    }

    // Dedupe: one underlying defect = one finding (same type within ±1 step).
    const dupe = this.findings.find(
      (f) => f.failure_type === failureType && Math.abs(f.step - step) <= 1,
    );
    if (dupe) {
      return this.err(`a ${failureType} finding at step ${dupe.step} is already recorded — one defect, one finding. If you meant a DIFFERENT defect, cite its distinct step.`);
    }

    // Verification-before-assertion for machine-checkable types: HS must have a
    // verifier-CONTRADICTED claim near the step; ES must cite a real, unacknowledged error.
    if (failureType === "hallucinated_success" && this.enabled.verify) {
      const contradicted = this.prePass.verdicts.some(
        (v) => v.verdict === "CONTRADICTED" && Math.abs(v.claim.step - step) <= 1,
      );
      if (!contradicted) {
        return this.err(
          `hallucinated_success rejected: no claim at/next to step ${step} is CONTRADICTED by the verifier. ` +
            `Optimistic statements are NOT failures by themselves — run verify_claim on the claim's step; ` +
            `only record HS when a claim is contradicted by the nearest preceding tool_result.`,
        );
      }
    }
    if (failureType === "error_swallowing") {
      const pair = this.parsed.pairs.find((p) => p.resultStep === evidenceStep);
      const failing = pair ? isMeaningfulFailure(pair) : /error|fail|denied|timed out/i.test(haystack);
      if (!failing) {
        return this.err(`error_swallowing rejected: the cited result at step ${evidenceStep} is not an error (no is_error flag, exit 0, or error text).`);
      }
    }

    this.findings.push({
      failure_type: failureType, step, summary,
      evidence_quote: quote, evidence_step: evidenceStep,
      confidence, suggested_fix: suggestedFix,
    });
    this.stepsSeen.add(evidenceStep);
    this.sawLogContent = true;
    return this.ok(`finding recorded (${this.findings.length} total): ${failureType} @ step ${step}`, true, [evidenceStep]);
  }

  private submitReport(assessment: string): ToolboxResult {
    // Guardrail 1: must have examined the log through tools.
    if (!this.sawLogContent) {
      this.guardrailRejections++;
      return this.err("submit rejected: you have not examined the log. Use read_steps / search_log / verify_claim first, confirm or dismiss each lead, then submit.");
    }
    // Guardrail 2: every finding must cite evidence the agent has actually seen.
    const unseen = this.findings.filter((f) => !this.stepsSeen.has(f.evidence_step));
    if (unseen.length > 0) {
      this.guardrailRejections++;
      return this.err(`submit rejected: ${unseen.length} finding(s) cite steps you never read (evidence steps ${unseen.map((f) => f.evidence_step).join(", ")}). Read those steps or drop the findings.`);
    }
    this.submitted = assessment;
    return this.ok(`report submitted with ${this.findings.length} finding(s)`);
  }
}
