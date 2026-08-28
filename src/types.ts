// Confess — shared types. Spec: planning/03-data-spec.md.
// Code identifiers stay boring and precise; the brand lives at the surface layer.

// ── Trajectory events (the input format) ────────────────────────────────────

export type Role = "user" | "assistant";

export type ToolName = "Read" | "Edit" | "Write" | "Bash" | "Grep" | "Glob";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string; // tu_001, tu_002, … unique within a trajectory
  name: ToolName;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  is_error?: boolean;
  content: string; // Bash results must end with "[exit code: N]"
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface TrajectoryEvent {
  step: number; // 1-based, = line number in trajectory.jsonl
  type: Role;
  content: ContentBlock[];
}

export type Trajectory = TrajectoryEvent[];

// ── Failure taxonomy (locked: exactly 5 — decision D7) ─────────────────────

export const FAILURE_TYPES = [
  "hallucinated_success",
  "constraint_violation",
  "tool_misuse",
  "retry_loop",
  "error_swallowing",
] as const;

export type FailureType = (typeof FAILURE_TYPES)[number];

// ── Findings & reports (identical contract for baseline and agent) ─────────

export interface Finding {
  failure_type: FailureType;
  step: number; // primary step index the finding points at
  summary: string;
  evidence_quote: string; // ≤ 200 chars, verbatim from the log
  evidence_step: number;
  confidence: number; // 0–1
  needs_human_review: boolean; // computed: confidence < GATE_THRESHOLD
  suggested_fix: string;
}

export type SystemName = "baseline" | "agent" | "agent-ablation" | "detectors-only";

export interface RunStats {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  wallMs: number;
  llmCalls: number;
}

export interface DiagnosisReport {
  case_id: string;
  run_id: string;
  system: SystemName;
  findings: Finding[];
  overall_assessment: string;
  parse_error?: string; // set when the LLM output could not be salvaged
  stats: RunStats;
}

export const GATE_THRESHOLD = 0.6; // pre-registered (decision D10) — do not tune

// ── Ground truth labels (from deterministic injection — decision D8) ───────

export interface FailureLabel {
  id: string;
  type: FailureType;
  primary_step: number;
  evidence_steps: number[];
  description: string;
  mutation_id: string;
  masked_by?: string; // case_12: the HS claim that covers this violation
  masks?: string;
}

export type Difficulty = "standard" | "clean" | "hard";

export interface LabelsFile {
  case_id: string;
  failures: FailureLabel[];
  clean: boolean;
  difficulty: Difficulty;
}

export interface CaseMeta {
  case_id: string;
  title: string;
  scenario: string;
  seed: number;
  base_model: string;
  n_steps: number;
  difficulty: Difficulty;
  generated_at: string;
}

// ── Day-2 module types (declared now so interfaces stay stable) ─────────────

export type ClaimType =
  | "tests_passed"
  | "command_succeeded"
  | "file_created"
  | "file_edited"
  | "lint_clean"
  | "numeric_result"
  | "other_outcome";

export interface Claim {
  step: number;
  claimText: string;
  claimType: ClaimType;
  subject?: string;
  expectedValue?: string;
}

export type VerdictKind = "SUPPORTED" | "CONTRADICTED" | "UNVERIFIABLE";

export interface Verdict {
  claim: Claim;
  verdict: VerdictKind;
  evidenceStep?: number;
  evidenceQuote?: string;
  ruleId: string;
}

export interface Constraint {
  id: string;
  sourceStep: number;
  statement: string;
  checkKind: "banned_file_edit" | "banned_command" | "required_tool" | "general";
  target?: string;
}

export interface LedgerViolation {
  constraintId: string;
  violatingStep: number;
  how: string;
}
