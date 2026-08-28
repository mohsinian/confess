// Stage 2 — deterministic detectors (planning/06-agent-spec.md): retry loops
// and unacknowledged errors. Pure code — signals are LEADS for the diagnosis
// agent, never scored directly.
import type { PairedStep, ParsedTrajectory } from "./parse.js";
import { eventText } from "./parse.js";

export type Signal =
  | {
      kind: "retry_loop";
      steps: number[];
      tool: string;
      command: string;
      occurrences: number;
      note: string;
    }
  | {
      kind: "unacknowledged_error";
      errorStep: number; // the failing tool_result step
      nextAssistantStep: number; // the assistant turn that (maybe) should have reacted
      ackScore: number; // 0–1 lexical acknowledgment score
      excerpt: string;
      note: string;
    };

// ── Retry-loop detector ─────────────────────────────────────────────────────

function normalizedArgs(pair: PairedStep): string {
  // Stable normalization: sorted keys, collapsed whitespace, no description field.
  const input = { ...(pair.use.input as Record<string, unknown>) };
  delete (input as { description?: unknown }).description;
  return JSON.stringify(input, Object.keys(input).sort()).replace(/\s+/g, "");
}

export function detectRetryLoops(parsed: ParsedTrajectory, minOccurrences = 3): Signal[] {
  const signals: Signal[] = [];
  const byKey = new Map<string, PairedStep[]>();
  for (const pair of parsed.pairs) {
    if (!pair.isFailure) continue;
    const key = `${pair.use.name}::${normalizedArgs(pair)}`;
    const list = byKey.get(key) ?? [];
    list.push(pair);
    byKey.set(key, list);
  }
  for (const [key, occurrences] of byKey) {
    if (occurrences.length < minOccurrences) continue;
    // Consecutive-or-near-consecutive: no *different* call to the same tool between attempts.
    const steps = occurrences.map((o) => o.index);
    let coherent = true;
    for (let i = 1; i < occurrences.length; i++) {
      const between = parsed.pairs.filter(
        (p) =>
          p.index > occurrences[i - 1].index &&
          p.index < occurrences[i].index &&
          p.use.name === occurrences[i].use.name &&
          normalizedArgs(p) !== key.split("::")[1],
      );
      if (between.length > 0) {
        coherent = false;
        break;
      }
    }
    if (!coherent) continue;
    const [tool, args] = key.split("::");
    const command = String((occurrences[0].use.input as { command?: string }).command ?? args);
    signals.push({
      kind: "retry_loop",
      steps,
      tool,
      command: command.slice(0, 160),
      occurrences: occurrences.length,
      note: `${occurrences.length} identical failing ${tool} calls at steps ${steps.join(", ")} with no adaptation`,
    });
  }
  return signals;
}

// ── Unacknowledged-error detector ───────────────────────────────────────────

const ACK_TERMS = [
  "error", "failed", "failure", "exit code", "doesn't exist", "not found", "denied",
  "timed out", "timeout", "refused", "issue", "problem", "fix", "instead", "retry",
  "let me", "hmm", "ah", "looks like", "seems", "debug", "investigate", "wrong",
];

function ackScoreFor(text: string): number {
  const lower = text.toLowerCase();
  if (lower.length === 0) return 0;
  const hits = ACK_TERMS.filter((t) => lower.includes(t)).length;
  return Math.min(1, hits / 3); // 3 distinct acknowledgment terms ≈ fully acknowledged
}

export function detectUnacknowledgedErrors(parsed: ParsedTrajectory, ackBelow = 0.35): Signal[] {
  const signals: Signal[] = [];
  for (const pair of parsed.pairs) {
    if (!pair.isFailure) continue;
    // The assistant event right after the failing result.
    const nextAssistant = parsed.steps.find((s) => s.index > pair.resultStep && s.type === "assistant");
    if (!nextAssistant) continue;
    const text = eventText(nextAssistant);
    const score = ackScoreFor(text);
    if (score < ackBelow) {
      signals.push({
        kind: "unacknowledged_error",
        errorStep: pair.resultStep,
        nextAssistantStep: nextAssistant.index,
        ackScore: Number(score.toFixed(2)),
        excerpt: pair.result.content.slice(0, 160),
        note: `error at step ${pair.resultStep} (ack score ${score.toFixed(2)}); next assistant turn at step ${nextAssistant.index} proceeds without addressing it`,
      });
    }
  }
  return signals;
}

export function runDetectors(parsed: ParsedTrajectory): Signal[] {
  return [...detectRetryLoops(parsed), ...detectUnacknowledgedErrors(parsed)];
}
