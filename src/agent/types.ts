// Agent-side type re-exports + zod schemas for LLM JSON outputs (claims, ledger).
import { z } from "zod";

export type {
  Claim, ClaimType, Constraint, LedgerViolation, Verdict, VerdictKind,
} from "../types.js";
export type { ParsedTrajectory, PairedStep, Step } from "./parse.js";
export type { Signal } from "./detectors.js";

export const claimSchema = z.object({
  step: z.number().int().min(1),
  claimText: z.string().min(1),
  claimType: z.enum([
    "tests_passed",
    "command_succeeded",
    "file_created",
    "file_edited",
    "lint_clean",
    "numeric_result",
    "other_outcome",
  ]),
  subject: z.string().optional(),
  expectedValue: z.string().optional(),
});

export const constraintSchema = z.object({
  id: z.string(),
  sourceStep: z.number().int().min(1),
  statement: z.string().min(1),
  checkKind: z.enum(["banned_file_edit", "banned_command", "required_tool", "general"]),
  target: z.string().optional(),
});
