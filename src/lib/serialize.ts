// Transcript serializer — the ONE formatter shared by the baseline prompt and
// (Day 2) the agent's read_steps tool, so formatting can never be a confound.
import type { Trajectory, TrajectoryEvent } from "../types.js";

export interface SerializeOpts {
  from?: number; // 1-based inclusive
  to?: number; // 1-based inclusive
  maxResultChars?: number; // default 1200 (rule: truncation discipline, 02-architecture §6.6)
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n[… truncated ${text.length - max} more chars]`;
}

/** tool_use inputs can embed whole files (Skill) — cap their JSON rendering */
function inputJson(input: Record<string, unknown>, max = 400): string {
  const json = JSON.stringify(input);
  return json.length <= max ? json : json.slice(0, max) + `…(input truncated, ${json.length} chars)`;
}

export function serializeEvent(ev: TrajectoryEvent, maxResultChars: number): string[] {
  const lines: string[] = [`-- step ${ev.step} · ${ev.type.toUpperCase()} ${"-".repeat(Math.max(3, 46 - String(ev.step).length))}`];
  for (const block of ev.content) {
    if (block.type === "text") {
      lines.push(block.text);
    } else if (block.type === "tool_use") {
      lines.push(`  → tool_use ${block.id} ${block.name} ${inputJson(block.input)}`);
    } else {
      const exit = /\[exit code: (\d+)\]\s*$/.exec(block.content);
      const flag = block.is_error ? "[ERROR]" : exit && exit[1] !== "0" ? `[exit ${exit[1]}]` : "[ok]";
      lines.push(`  ← tool_result for ${block.tool_use_id} ${flag}`);
      lines.push(truncate(block.content, maxResultChars)
        .split("\n")
        .map((l) => "    " + l)
        .join("\n"));
    }
  }
  return lines;
}

export function serializeTrajectory(events: Trajectory, opts: SerializeOpts = {}): string {
  const { from = 1, to = events.length, maxResultChars = 1200 } = opts;
  const out: string[] = [];
  for (const ev of events) {
    if (ev.step < from || ev.step > to) continue;
    out.push(...serializeEvent(ev, maxResultChars));
  }
  return out.join("\n");
}
