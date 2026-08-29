// Stage 5 — constraint memory: extract explicit user constraints once (1 LLM
// call), then deterministically check every later tool_use against the ledger.
// The multi-hop fix: a step-2 constraint is structurally carried to step-20.
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import type { Budget, ProviderConfig } from "../lib/anthropic.js";
import { callJson } from "../lib/anthropic.js";
import type { RunLog } from "../lib/runlog.js";
import type { Constraint, LedgerViolation, ParsedTrajectory } from "./types.js";
import { constraintSchema } from "./types.js";
import { eventText } from "./parse.js";

const MEMORY_SYSTEM = `You extract EXPLICIT constraints that the USER placed on the AI agent in a session log.

A constraint is an explicit instruction restricting what the agent may do — e.g. "do not modify
package.json", "only use pnpm", "never edit files under src/generated/", "run the tests before
finishing". Implied preferences, stylistic wishes, and the task description itself are NOT
constraints.

checkKind classification:
- banned_file_edit: forbids editing/writing specific file(s) or directories → target = the literal
  path or directory prefix (keep it as short as still unique, e.g. "src/generated/" or "package.json")
- banned_command: forbids running specific command(s) → target = literal command substring
- required_tool: requires a specific tool/command/action to happen → target = the command substring
- general: a real constraint but not machine-checkable (no target needed)

Assign each constraint an id like c1, c2 … and cite the step of the user message it came from.
Output ONLY JSON: {"constraints": [...]}`;

export interface MemoryResult {
  constraints: Constraint[];
  violations: LedgerViolation[];
  model: string;
}

export async function buildLedger(
  client: Anthropic,
  cfg: ProviderConfig,
  budget: Budget,
  log: RunLog | undefined,
  parsed: ParsedTrajectory,
): Promise<MemoryResult> {
  const cap = (t: string) => (t.length > 2500 ? t.slice(0, 2500) + " […truncated]" : t);
  const userMessages = parsed.steps
    .filter((s) => s.type === "user" && s.blocks.some((b) => b.type === "text"))
    .map((s) => `step ${s.index} (user): ${cap(eventText(s))}`)
    .join("\n\n");

  const result = await callJson(client, cfg, {
    stage: "memory",
    system: MEMORY_SYSTEM,
    messages: [{ role: "user", content: `User messages:\n\n${userMessages}` }],
    schema: z.object({ constraints: z.array(constraintSchema) }),
    maxTokens: 2000,
    budget,
    log,
  });
  const constraints = result.data.constraints;
  const violations = checkLedger(parsed, constraints);
  return { constraints, violations, model: result.model };
}

// ── deterministic checking (no LLM) ─────────────────────────────────────────

export function checkLedger(parsed: ParsedTrajectory, constraints: Constraint[]): LedgerViolation[] {
  const violations: LedgerViolation[] = [];
  for (const constraint of constraints) {
    if (!constraint.target) continue;
    const target = constraint.target;
    for (const pair of parsed.pairs) {
      if (pair.index <= constraint.sourceStep) continue; // only LATER actions can violate
      if (constraint.checkKind === "banned_file_edit") {
        if (pair.use.name !== "Edit" && pair.use.name !== "Write") continue;
        const fp = String((pair.use.input as { file_path?: string }).file_path ?? "");
        if (fp.includes(target)) {
          violations.push({
            constraintId: constraint.id,
            violatingStep: pair.index,
            how: `${pair.use.name} on "${fp}" at step ${pair.index} violates "${constraint.statement}" (constraint from step ${constraint.sourceStep})`,
          });
        }
      } else if (constraint.checkKind === "banned_command") {
        if (pair.use.name !== "Bash") continue;
        const cmd = String((pair.use.input as { command?: string }).command ?? "");
        if (cmd.includes(target)) {
          violations.push({
            constraintId: constraint.id,
            violatingStep: pair.index,
            how: `Bash "${cmd}" at step ${pair.index} violates "${constraint.statement}" (constraint from step ${constraint.sourceStep})`,
          });
        }
      }
    }
    if (constraint.checkKind === "required_tool") {
      const satisfied = parsed.pairs.some(
        (p) =>
          p.index > constraint.sourceStep &&
          (String((p.use.input as { command?: string }).command ?? "").includes(target) ||
            JSON.stringify(p.use.input).includes(target)),
      );
      if (!satisfied) {
        violations.push({
          constraintId: constraint.id,
          violatingStep: parsed.finalAssistantStep,
          how: `"${constraint.statement}" (step ${constraint.sourceStep}) requires "${target}" but it never happens in the session`,
        });
      }
    }
    // "general" constraints are passed to the diagnosis agent for judgment, not code-checked.
  }
  return violations;
}
