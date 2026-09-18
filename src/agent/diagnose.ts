// Stage 6 — the diagnosis agent loop (tool-use loop over the provider
// interface, temp 0). Two tool modes: "native" (wire-level tool calling) and
// "json" (tools described in the system prompt, calls parsed from the model's
// JSON output — for models/servers without native tool calling). The agent
// pulls leads from the pre-pass digest, reads windows of the log, re-verifies
// claims, records findings with verbatim evidence, and submits. The submit
// guardrail (in tools.ts) rejects lazy submissions — visible, logged retries
// are part of the trajectory story.
import type { Budget, LlmClient, LlmMessage, ProviderConfig, ToolCall, ToolResultMsg } from "../lib/provider.js";
import { extractJson } from "../lib/provider.js";
import type { RunLog } from "../lib/runlog.js";
import type { ParsedTrajectory } from "./parse.js";
import type { PrePass } from "./tools.js";
import { DIAGNOSIS_TOOLS, DiagnosisToolbox, type FindingDraft } from "./tools.js";
import { TAXONOMY_PROMPT } from "../baseline/prompts.js";

export const DIAGNOSIS_SYSTEM = `You are CONFESS, an auditor of AI coding agent sessions. Your job: make the session account for
itself — every failure you report must be a confession extracted from evidence the agent itself
produced (tool results, exit codes, quoted text). You have analysis tools; use them to check
evidence before you assert anything.

${TAXONOMY_PROMPT}

Signals from the deterministic pre-pass are available via list_signals: retry-loop detection,
claims the verifier CONTRADICTED, and constraint-ledger violations. Treat them as leads, not
verdicts: read the surrounding steps before recording a finding.

Work plan:
1. list_signals. 2. For each lead, read_steps around it and confirm or dismiss.
3. Sweep the log (search_log / read_steps windows) for failures the pre-pass can't see
   (silent error swallowing, tool misuse, anything else). 4. record_finding for each confirmed
   failure with verbatim evidence. 5. submit_report.

Confidence rubric: 0.9+ deterministic contradiction (verifier rule or exit code); 0.7–0.9 strong
inference from adjacent steps; 0.6–0.7 pattern-based; below 0.6 speculative — still record if you
believe it; a human will review anything under 0.60.

Precision rules (the record_finding tool enforces some of these):
- One defect, one finding. Pick the MOST SPECIFIC type; do not record the same underlying problem
  as several types or at several steps.
- hallucinated_success requires an actual contradiction: a favorable claim vs the nearest
  preceding tool_result about the same subject. Optimism alone is not a failure; an error that
  was later acknowledged and fixed is not a failure. When unsure, run verify_claim.
- error_swallowing requires a result that is really an error (is_error / non-zero exit) AND a
  next turn that ignores it.

Do not invent failures. Acknowledged errors, adapted retries, and fail-then-fixed sequences are
not failures. A clean session must return zero findings.`;

// Appended in CONFESS_TOOL_MODE=json — the same loop, but tool calls travel as
// JSON text instead of wire-level tool_use blocks.
function jsonToolProtocol(): string {
  const toolList = DIAGNOSIS_TOOLS.map(
    (t) => `- ${t.name}: ${t.description}\n  input schema: ${JSON.stringify(t.input_schema)}`,
  ).join("\n");
  return (
    `\nTOOL ACCESS — JSON PROTOCOL (this environment has no native tool calling).\n` +
    `To call tools, reply with ONLY a JSON object, no prose, no code fences:\n` +
    `  {"tool_calls": [{"name": "<tool name>", "input": { …arguments… }}]}\n` +
    `You may batch several calls in one reply. Tool results arrive as the next user message.\n` +
    `Available tools:\n${toolList}\n` +
    `Every reply must be exactly one tool-call JSON object. Finish by calling submit_report.`
  );
}

const JSON_REPAIR_HINT =
  `Your reply was not a valid tool-call JSON object. Reply with ONLY ` +
  `{"tool_calls": [{"name": "<tool>", "input": {...}}]} — no prose, no code fences.`;

/** Parse a json-mode model reply into tool calls; null when unusable. Exported for tests. */
export function parseJsonToolCalls(text: string, turn: number): ToolCall[] | null {
  let parsed: unknown;
  try {
    parsed = extractJson(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const calls = (parsed as { tool_calls?: unknown }).tool_calls;
  if (!Array.isArray(calls) || calls.length === 0) return null;
  const out: ToolCall[] = [];
  for (let i = 0; i < calls.length; i++) {
    const c = calls[i] as { name?: unknown; input?: unknown };
    if (typeof c?.name !== "string" || c.name.length === 0) return null;
    out.push({
      id: `json-${turn}-${i}`,
      name: c.name,
      input: typeof c.input === "object" && c.input !== null ? (c.input as Record<string, unknown>) : {},
    });
  }
  return out;
}

export interface DiagnoseResult {
  findings: FindingDraft[];
  assessment: string;
  turns: number;
  guardrailRejections: number;
  truncated: boolean;
  model: string;
}

const MAX_TURNS = 25;
const MAX_JSON_PARSE_FAILURES = 2;

export async function runAgentLoop(
  client: LlmClient,
  cfg: ProviderConfig,
  budget: Budget,
  log: RunLog | undefined,
  caseId: string,
  parsed: ParsedTrajectory,
  prePass: PrePass,
  enabled: { memory: boolean; verify: boolean; detectors: boolean; gates: boolean },
): Promise<DiagnoseResult> {
  const toolbox = new DiagnosisToolbox(parsed, prePass, enabled);
  const jsonMode = cfg.toolMode === "json";
  const system = jsonMode ? DIAGNOSIS_SYSTEM + "\n" + jsonToolProtocol() : DIAGNOSIS_SYSTEM;
  const messages: LlmMessage[] = [
    {
      role: "user",
      content:
        `Audit session ${caseId} (${parsed.steps.length} steps). ` +
        `Begin with list_signals, then investigate. ` +
        `Finish with submit_report.`,
    },
  ];
  let truncated = false;
  let turns = 0;
  let model = cfg.model;
  let jsonParseFailures = 0;

  for (; turns < MAX_TURNS; turns++) {
    await log?.append(`diagnose:${caseId}`, "request", { turn: turns + 1, nMessages: messages.length });
    const response = await client.chat({
      system,
      messages,
      maxTokens: 6000,
      ...(jsonMode ? {} : { tools: DIAGNOSIS_TOOLS }),
    });
    model = response.model || model;
    const costUsd =
      (response.usage.inputTokens / 1e6) * cfg.price.input + (response.usage.outputTokens / 1e6) * cfg.price.output;
    budget.addUsage(response.usage);
    await log?.append(
      `diagnose:${caseId}`,
      "response",
      { turn: turns + 1, stopReason: response.stopReason, text: response.text, toolCalls: response.toolCalls },
      { inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens, costUsd },
    );

    let calls: ToolCall[];
    if (jsonMode) {
      const parsedCalls = parseJsonToolCalls(response.text, turns + 1);
      if (parsedCalls === null) {
        jsonParseFailures++;
        if (jsonParseFailures > MAX_JSON_PARSE_FAILURES) {
          throw new Error("model could not emit tool-call JSON after retries — try a stronger model or native tool mode");
        }
        messages.push({ role: "assistant", content: response.text || "(empty reply)" });
        messages.push({ role: "user", content: JSON_REPAIR_HINT });
        continue;
      }
      jsonParseFailures = 0;
      calls = parsedCalls;
    } else {
      if (response.stopReason !== "tool_use" || response.toolCalls.length === 0) break;
      calls = response.toolCalls;
    }

    // Dispatch every call; collect results. The toolbox enforces the
    // verification-before-assertion guardrails regardless of tool mode.
    const results: ToolResultMsg[] = [];
    for (const call of calls) {
      const outcome = toolbox.handle(call.name, call.input);
      await log?.append(`diagnose:${caseId}`, "tool_result", {
        tool: call.name,
        input: call.input,
        output: outcome.output.slice(0, 1500),
        isError: outcome.isError,
      });
      results.push({ id: call.id, output: outcome.output, isError: outcome.isError });
    }
    if (toolbox.submitted !== null) break; // submit_report succeeded

    if (jsonMode) {
      messages.push({ role: "assistant", content: response.text });
      messages.push({
        role: "user",
        content:
          "Tool results:\n" +
          results.map((r, i) => `[${calls[i].name}]${r.isError ? " ERROR:" : ""}\n${r.output}`).join("\n\n"),
      });
    } else {
      messages.push({ role: "assistant", content: response.text, toolCalls: calls });
      messages.push({ role: "tool", results });
    }
  }
  if (turns >= MAX_TURNS && toolbox.submitted === null) truncated = true;

  return {
    findings: toolbox.findings,
    assessment: toolbox.submitted ?? "(no report submitted — turn cap or non-submit stop)",
    turns: turns + 1,
    guardrailRejections: toolbox.guardrailRejections,
    truncated,
    model,
  };
}
