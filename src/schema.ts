// Zod schemas + cross-field trajectory invariants. Spec: planning/03-data-spec.md §1, §7.
import { z } from "zod";
import { FAILURE_TYPES } from "./types.js";

// ── Zod v3/v4 compatibility helper ──────────────────────────────────────────

export function zodErrors(error: z.ZodError): string[] {
  const issues = (error as unknown as { issues?: unknown[] }).issues ?? [];
  return issues.map((raw) => {
    const i = raw as { path?: (string | number | symbol)[]; message?: string };
    const path = (i.path ?? []).join(".");
    return `${path ? path + ": " : ""}${i.message ?? "invalid"}`;
  });
}

// ── Content blocks & events ─────────────────────────────────────────────────

export const textBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string().min(1),
});

export const toolUseSchema = z.object({
  type: z.literal("tool_use"),
  // Accepts our tu_001 ids and Claude Code's toolu_* ids
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{2,}$/, "tool_use id must be an identifier"),
  name: z.string().min(1), // real logs contain tools beyond the six we generate
  input: z.record(z.string(), z.unknown()),
});

export const toolResultSchema = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string().min(1),
  is_error: z.boolean().optional(),
  content: z.string(),
});

export const contentBlockSchema = z.discriminatedUnion("type", [
  textBlockSchema,
  toolUseSchema,
  toolResultSchema,
]);

export const eventSchema = z.object({
  step: z.number().int().min(1),
  type: z.enum(["user", "assistant"]),
  content: z.array(contentBlockSchema).min(1),
});

export const trajectorySchema = z.array(eventSchema);

// ── Cross-field invariants (planning/03-data-spec.md §1) ────────────────────

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export function validateTrajectory(events: unknown[]): ValidationResult {
  const errors: string[] = [];

  // Shape validation first — cross-field checks only run on structurally valid events.
  const parsed = trajectorySchema.safeParse(events);
  if (!parsed.success) {
    return { ok: false, errors: zodErrors(parsed.error) };
  }
  const evs = parsed.data;

  if (evs.length === 0) {
    return { ok: false, errors: ["trajectory is empty"] };
  }

  // 1. First event: user, text-only. Last event: assistant, text-only.
  const first = evs[0];
  if (first.type !== "user" || !first.content.every((b) => b.type === "text")) {
    errors.push("first event must be a user message containing only text");
  }
  const last = evs[evs.length - 1];
  if (last.type !== "assistant" || !last.content.every((b) => b.type === "text")) {
    errors.push("last event must be an assistant message containing only text");
  }

  // 2. Steps strictly sequential from 1 (the file's line numbering).
  evs.forEach((ev, i) => {
    if (ev.step !== i + 1) {
      errors.push(`event at index ${i} has step ${ev.step}, expected ${i + 1}`);
    }
  });

  // 3. No consecutive same-role events except user-tool_result after assistant.
  for (let i = 1; i < evs.length; i++) {
    const prev = evs[i - 1];
    const cur = evs[i];
    if (prev.type === "user" && cur.type === "user") {
      const prevHasResult = prev.content.some((b) => b.type === "tool_result");
      if (!prevHasResult) {
        errors.push(`steps ${prev.step}→${cur.step}: two user events in a row without a tool_result`);
      }
    }
    if (prev.type === "assistant" && cur.type === "assistant") {
      errors.push(`steps ${prev.step}→${cur.step}: two assistant events in a row`);
    }
  }

  // 4. tool_use ids unique; every tool_use answered by tool_result in the NEXT user event.
  const seenIds = new Set<string>();
  for (let i = 0; i < evs.length; i++) {
    const ev = evs[i];
    for (const block of ev.content) {
      if (block.type !== "tool_use") continue;
      if (seenIds.has(block.id)) errors.push(`duplicate tool_use id ${block.id} at step ${ev.step}`);
      seenIds.add(block.id);

      const next = evs[i + 1];
      if (!next || next.type !== "user") {
        errors.push(`tool_use ${block.id} at step ${ev.step} has no following user event`);
        continue;
      }
      const results = next.content.filter(
        (b): b is Extract<typeof b, { type: "tool_result" }> => b.type === "tool_result",
      );
      if (!results.some((r) => r.tool_use_id === block.id)) {
        errors.push(`tool_use ${block.id} at step ${ev.step} has no matching tool_result at step ${next.step}`);
      }
    }
    // A user event may only carry tool_results answering the immediately preceding assistant event.
    if (ev.type === "user") {
      for (const block of ev.content) {
        if (block.type !== "tool_result") continue;
        const prevAssistant = evs[i - 1];
        if (!prevAssistant || prevAssistant.type !== "assistant") {
          errors.push(`tool_result ${block.tool_use_id} at step ${ev.step} does not follow an assistant event`);
        } else if (
          !prevAssistant.content.some((b) => b.type === "tool_use" && b.id === block.tool_use_id)
        ) {
          errors.push(
            `tool_result ${block.tool_use_id} at step ${ev.step} does not answer the preceding assistant event`,
          );
        }
      }
    }
  }

  // 5. Bash tool_result content must end with "[exit code: N]".
  for (const ev of evs) {
    for (const block of ev.content) {
      if (block.type !== "tool_result") continue;
      const prevAssistant = evs[ev.step - 2]; // step is 1-based; previous event
      const isBashResult =
        prevAssistant &&
        prevAssistant.type === "assistant" &&
        prevAssistant.content.some(
          (b) => b.type === "tool_use" && b.id === block.tool_use_id && b.name === "Bash",
        );
      if (isBashResult && !/\[exit code: \d+\]\s*$/.test(block.content)) {
        errors.push(`Bash tool_result ${block.tool_use_id} at step ${ev.step} missing "[exit code: N]" suffix`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

// ── Findings, reports, labels ───────────────────────────────────────────────

export const failureTypeSchema = z.enum(FAILURE_TYPES);

// What the LLM emits (needs_human_review is computed in code, never trusted from the model).
export const llmFindingSchema = z.object({
  failure_type: failureTypeSchema,
  step: z.number().int().min(1),
  summary: z.string().min(1),
  evidence_quote: z.string().min(1),
  evidence_step: z.number().int().min(1),
  confidence: z.number().min(0).max(1),
  suggested_fix: z.string().min(1),
});

export const findingSchema = llmFindingSchema.extend({
  needs_human_review: z.boolean(),
});

export const llmReportSchema = z.object({
  findings: z.array(llmFindingSchema),
  overall_assessment: z.string().min(1),
});

export const diagnosisReportSchema = z.object({
  case_id: z.string(),
  run_id: z.string(),
  system: z.enum(["baseline", "agent", "agent-ablation", "detectors-only"]),
  findings: z.array(findingSchema),
  overall_assessment: z.string(),
  parse_error: z.string().optional(),
  truncated: z.boolean().optional(),
  degraded: z.boolean().optional(),
  stats: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    costUsd: z.number(),
    wallMs: z.number(),
    llmCalls: z.number(),
  }),
});

export const failureLabelSchema = z.object({
  id: z.string(),
  type: failureTypeSchema,
  primary_step: z.number().int().min(1),
  evidence_steps: z.array(z.number().int().min(1)),
  description: z.string(),
  mutation_id: z.string(),
  masked_by: z.string().optional(),
  masks: z.string().optional(),
});

export const labelsFileSchema = z.object({
  case_id: z.string(),
  failures: z.array(failureLabelSchema),
  clean: z.boolean(),
  difficulty: z.enum(["standard", "clean", "hard"]),
});

export const caseMetaSchema = z.object({
  case_id: z.string(),
  title: z.string(),
  scenario: z.string(),
  seed: z.number().int(),
  base_model: z.string(),
  n_steps: z.number().int().min(1),
  difficulty: z.enum(["standard", "clean", "hard"]),
  generated_at: z.string(),
});
