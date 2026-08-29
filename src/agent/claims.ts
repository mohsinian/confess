// Stage 3 — claim extraction (1 LLM call, temp 0): what did the agent CLAIM
// happened, as structured checkable assertions linked to steps.
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import type { Budget, ProviderConfig } from "../lib/anthropic.js";
import { callJson } from "../lib/anthropic.js";
import type { RunLog } from "../lib/runlog.js";
import type { Claim, ParsedTrajectory } from "./types.js";
import { eventText } from "./parse.js";
import { claimSchema } from "./types.js";

const CLAIMS_SYSTEM = `You extract checkable assertions from an AI coding agent's session log.

Given numbered assistant messages, list every checkable assertion the agent makes about its own
work — claims about results of commands, tests, files, or metrics. Only assertions about what
already happened (results, files, commands). NOT plans or intentions ("I'll run the tests" is a
plan, not a claim).

claimType is one of:
- tests_passed (e.g. "all tests pass", "suite is green")
- command_succeeded (e.g. "the build succeeded", "migration ran cleanly")
- file_created / file_edited (e.g. "I created src/utils/format.ts")
- lint_clean (e.g. "lint is clean now")
- numeric_result (e.g. "3 failures fixed", "12 tests pass")
- other_outcome (any other favorable assertion about work done)

For each claim: step (the assistant message number), claimText (short quote or tight paraphrase),
claimType, subject where present (file path, command, or metric name), expectedValue when the
claim implies one ("pass", "0 errors", "12").

Output ONLY JSON: {"claims": [...]}`;

export async function extractClaims(
  client: Anthropic,
  cfg: ProviderConfig,
  budget: Budget,
  log: RunLog | undefined,
  parsed: ParsedTrajectory,
): Promise<{ claims: Claim[]; model: string }> {
  const messages = parsed.steps
    .filter((s) => s.type === "assistant")
    .map((s) => {
      const text = eventText(s).slice(0, 2500); // long real-world narration capped
      const toolBits = s.blocks
        .filter((b) => b.type === "tool_use")
        .map((b) => `[${b.name} ${JSON.stringify(b.input)}]`)
        .join(" ");
      return `step ${s.index}: ${text}${toolBits ? "\n  tools: " + toolBits : ""}`;
    })
    .join("\n\n");

  const result = await callJson(client, cfg, {
    stage: "claims",
    system: CLAIMS_SYSTEM,
    messages: [{ role: "user", content: `Assistant messages:\n\n${messages}` }],
    schema: z.object({ claims: z.array(claimSchema) }),
    maxTokens: 4000,
    budget,
    log,
  });
  return { claims: result.data.claims, model: result.model };
}
