// Stage 1 — deterministic parser: raw trajectory → typed steps with
// tool_use↔tool_result pairing and parsed exit codes. Zero LLM.
import type { ToolResultBlock, ToolUseBlock, Trajectory, TrajectoryEvent } from "../types.js";

export interface Step {
  index: number; // 1-based event line number
  type: TrajectoryEvent["type"];
  blocks: TrajectoryEvent["content"];
}

export interface PairedStep {
  index: number; // step of the tool_use event
  resultStep: number; // step of the tool_result event
  use: ToolUseBlock;
  result: ToolResultBlock;
  /** Bash only: exit code parsed from the "[exit code: N]" suffix; null otherwise/missing */
  exitCode: number | null;
  isFailure: boolean; // is_error OR non-zero exit
}

export interface ParsedTrajectory {
  steps: Step[];
  pairs: PairedStep[];
  /** malformed-log signal: tool ids with more than one result (first wins) */
  duplicateToolIds: string[];
  /** step index of user text events (constraints live here) */
  userTextSteps: number[];
  /** final assistant step (the closing summary) */
  finalAssistantStep: number;
}

const EXIT_RE = /\[exit code: (\d+)\]\s*$/;

// Check-run = a command whose exit code asserts something about the work.
const CHECK_RUN_RE = /(test|spec|vitest|jest|mocha|lint|eslint|build|compile|tsc|typecheck|check|migrate|prisma|backfill)/i;
// Strong error text inside a result (independent of the exit-code suffix).
const ERROR_TEXT_RE = /error|failed|EADDRINUSE|EACCES|ECONNREFUSED|ETIMEDOUT|permission denied|not found|cannot find|missing script/i;

/**
 * Does this result indicate failure OF THE WORK? Informational commands
 * (git diff/status/log, ls, cat) can carry odd exit codes without the work
 * failing — error_swallowing must not fire on those.
 */
export function isMeaningfulFailure(pair: PairedStep): boolean {
  if (pair.result.is_error) return true;
  if (pair.exitCode === null || pair.exitCode === 0) return false;
  const command = String((pair.use.input as { command?: string }).command ?? "");
  if (CHECK_RUN_RE.test(command)) return true;
  return ERROR_TEXT_RE.test(pair.result.content);
}

export function parseTrajectory(events: Trajectory): ParsedTrajectory {
  const steps: Step[] = events.map((ev) => ({ index: ev.step, type: ev.type, blocks: ev.content }));

  // Map tool_use id → its result block (searching forward only, normally the next event).
  const resultMap = new Map<string, { result: ToolResultBlock; step: number }>();
  const duplicateToolIds: string[] = []; // malformed logs: first result wins, dupes counted
  for (const ev of events) {
    for (const b of ev.content) {
      if (b.type !== "tool_result") continue;
      if (resultMap.has(b.tool_use_id)) {
        duplicateToolIds.push(b.tool_use_id);
        continue;
      }
      resultMap.set(b.tool_use_id, { result: b, step: ev.step });
    }
  }

  const pairs: PairedStep[] = [];
  for (const ev of events) {
    for (const b of ev.content) {
      if (b.type !== "tool_use") continue;
      const hit = resultMap.get(b.id);
      if (!hit) continue;
      const exitMatch = b.name === "Bash" ? EXIT_RE.exec(hit.result.content) : null;
      const exitCode = exitMatch ? Number(exitMatch[1]) : null;
      pairs.push({
        index: ev.step,
        resultStep: hit.step,
        use: b,
        result: hit.result,
        exitCode,
        isFailure: hit.result.is_error === true || (exitCode !== null && exitCode !== 0),
      });
    }
  }
  pairs.sort((a, b) => a.index - b.index);

  const userTextSteps = events
    .filter((ev) => ev.type === "user" && ev.content.some((b) => b.type === "text"))
    .map((ev) => ev.step);
  const finalAssistantStep = [...events].reverse().find((ev) => ev.type === "assistant")?.step ?? 0;

  return { steps, pairs, userTextSteps, finalAssistantStep, duplicateToolIds };
}

/** all text of an event joined (assistant narration or user instruction) */
export function eventText(step: Step): string {
  return step.blocks
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join(" ");
}
