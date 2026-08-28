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
  /** step index of user text events (constraints live here) */
  userTextSteps: number[];
  /** final assistant step (the closing summary) */
  finalAssistantStep: number;
}

const EXIT_RE = /\[exit code: (\d+)\]\s*$/;

export function parseTrajectory(events: Trajectory): ParsedTrajectory {
  const steps: Step[] = events.map((ev) => ({ index: ev.step, type: ev.type, blocks: ev.content }));

  // Map tool_use id → its result block (searching forward only, normally the next event).
  const resultMap = new Map<string, { result: ToolResultBlock; step: number }>();
  for (const ev of events) {
    for (const b of ev.content) {
      if (b.type === "tool_result") resultMap.set(b.tool_use_id, { result: b, step: ev.step });
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

  return { steps, pairs, userTextSteps, finalAssistantStep };
}

/** all text of an event joined (assistant narration or user instruction) */
export function eventText(step: Step): string {
  return step.blocks
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join(" ");
}
