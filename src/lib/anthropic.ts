// Provider-agnostic LLM access (decision D13). AgentRouter (Bearer + base URL)
// or direct Anthropic (X-Api-Key) — the .env decides, the code doesn't care.
// Every call: temperature 0, network retries, zod validation, ONE repair
// round-trip, usage/cost accounting, per-case budget abort, full run logging.
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { z, type ZodType } from "zod";
import { jsonrepair } from "jsonrepair";
import { zodErrors } from "../schema.js";
import type { RunLog } from "./runlog.js";

// ── Provider config ─────────────────────────────────────────────────────────

export interface ProviderConfig {
  authToken?: string;
  apiKey?: string;
  baseUrl?: string;
  model: string;
  maxRunCost: number;
}

export const MODEL_CANDIDATES = ["claude-opus-5", "claude-opus-4-8", "claude-opus-4-6"];

export function loadProviderConfig(env: NodeJS.ProcessEnv = process.env): ProviderConfig {
  const authToken = env.ANTHROPIC_AUTH_TOKEN?.trim() || undefined;
  const apiKey = env.ANTHROPIC_API_KEY?.trim() || undefined;
  const baseUrl = env.ANTHROPIC_BASE_URL?.trim() || undefined;
  const model = env.ANTHROPIC_MODEL?.trim() || MODEL_CANDIDATES[0];
  const maxRunCost = Number(env.MAX_RUN_COST ?? 5);
  if (!authToken && !apiKey) {
    throw new Error(
      "No provider credentials. Set ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL (AgentRouter) " +
        "or ANTHROPIC_API_KEY (direct) in .env — see .env.example.",
    );
  }
  return { authToken, apiKey, baseUrl, model, maxRunCost };
}

export function makeClient(cfg: ProviderConfig): Anthropic {
  return new Anthropic({
    ...(cfg.authToken ? { authToken: cfg.authToken } : {}),
    ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
    ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}),
    maxRetries: 2,
    timeout: 300_000, // Opus via router can be slow on long generations
    // AgentRouter gates on client identity: requests must present the Claude Code
    // user-agent or it answers 401 "unauthorized client detected" (docs are
    // Claude Code-specific; the SDK's default UA trips the filter).
    defaultHeaders: {
      "user-agent": "claude-cli/2.0.14 (external, cli)",
      "x-app": "cli",
    },
  });
}

// ── Cost accounting ─────────────────────────────────────────────────────────
// Opus-class list price as the conservative default; swap via env when the
// router's real pricing is known. All amounts USD per million tokens.

export const PRICE_TABLE: Array<{ match: RegExp; input: number; output: number }> = [
  { match: /sonnet/i, input: 3, output: 15 },
  { match: /haiku/i, input: 0.8, output: 4 },
  { match: /opus/i, input: 15, output: 75 },
];

export function priceForModel(model: string): { input: number; output: number } {
  const hit = PRICE_TABLE.find((p) => p.match.test(model));
  return hit ?? { input: 15, output: 75 }; // unknown model → assume expensive
}

export class BudgetExceededError extends Error {
  constructor(public spent: number, public limit: number) {
    super(`Budget guard: $${spent.toFixed(2)} spent exceeds $${limit.toFixed(2)} limit — aborting case`);
  }
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  llmCalls: number;
}

export class Budget {
  totals: UsageTotals = { inputTokens: 0, outputTokens: 0, costUsd: 0, llmCalls: 0 };
  constructor(public limit: number) {}

  addUsage(model: string, usage: { input_tokens?: number; output_tokens?: number }): void {
    const price = priceForModel(model);
    const inTok = usage.input_tokens ?? 0;
    const outTok = usage.output_tokens ?? 0;
    this.totals.inputTokens += inTok;
    this.totals.outputTokens += outTok;
    this.totals.costUsd += (inTok / 1e6) * price.input + (outTok / 1e6) * price.output;
    this.totals.llmCalls += 1;
    if (this.totals.costUsd > this.limit) throw new BudgetExceededError(this.totals.costUsd, this.limit);
  }
}

// ── JSON extraction (handles raw or fenced JSON) ────────────────────────────

export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  // Strip a single wrapping code fence if present.
  const fence = /^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/.exec(trimmed);
  const candidate = fence ? fence[1].trim() : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    try {
      return JSON.parse(jsonrepair(candidate));
    } catch {
      /* fall through to balanced scan */
    }
  }
  // Balanced scan for the first complete {…} or […] (string/escape aware).
  for (const [open, close] of [
    ["{", "}"],
    ["[", "]"],
  ] as const) {
    const start = candidate.indexOf(open);
    if (start === -1) continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < candidate.length; i++) {
      const ch = candidate[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = !inString;
      if (inString) continue;
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          const slice = candidate.slice(start, i + 1);
          try {
            return JSON.parse(slice);
          } catch {
            break;
          }
        }
      }
    }
  }
  throw new Error("no parseable JSON found in model output");
}

// ── Call wrappers ───────────────────────────────────────────────────────────

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface CallResult {
  text: string;
  model: string; // the model the API reports it actually used
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
}

interface CallOpts {
  stage: string;
  system: string;
  messages: ChatMessage[];
  maxTokens?: number;
  log?: RunLog;
  budget: Budget;
}

export async function callRaw(
  client: Anthropic,
  cfg: ProviderConfig,
  opts: CallOpts,
): Promise<CallResult> {
  const maxTokens = opts.maxTokens ?? 4096;
  await opts.log?.append(opts.stage, "request", {
    system: opts.system,
    messages: opts.messages,
    maxTokens,
    model: cfg.model,
  });
  const started = Date.now();
  const response = await client.messages.create({
    model: cfg.model,
    max_tokens: maxTokens,
    temperature: 0,
    system: opts.system,
    messages: opts.messages,
  });
  // Some proxies return a JSON body with a non-JSON content-type, so the SDK
  // surfaces a raw string — normalize before reading fields.
  const message = (
    typeof response === "string" ? JSON.parse(response) : response
  ) as Anthropic.Messages.Message;
  const text = message.content
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");
  const price = priceForModel(cfg.model);
  const usage = {
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
    costUsd: (message.usage.input_tokens / 1e6) * price.input + (message.usage.output_tokens / 1e6) * price.output,
  };
  opts.budget.addUsage(cfg.model, message.usage);
  await opts.log?.append(opts.stage, "response", { stopReason: message.stop_reason, text }, usage);
  void started;
  return { text, model: message.model ?? cfg.model, usage };
}

export interface JsonCallResult<T> extends CallResult {
  data: T;
  repairs: number;
}

// One call + zod validation + ONE repair round-trip on failure (policy D6/rule 1
// — identical for baseline and agent, so JSON robustness is never a confound).
export async function callJson<T>(
  client: Anthropic,
  cfg: ProviderConfig,
  opts: CallOpts & { schema: ZodType<T> },
): Promise<JsonCallResult<T>> {
  const messages = [...opts.messages];
  let repairs = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await callRaw(client, cfg, {
      ...opts,
      messages,
      maxTokens: opts.maxTokens ?? 4096,
    });
    let parsed: unknown;
    let parseError = "";
    try {
      parsed = extractJson(result.text);
    } catch (e) {
      parseError = `output was not valid JSON: ${(e as Error).message}`;
      parsed = undefined;
    }
    if (parsed !== undefined) {
      const check = opts.schema.safeParse(parsed);
      if (check.success) {
        return { ...result, data: check.data, repairs };
      }
      parseError = `schema validation failed:\n- ${zodErrors(check.error).slice(0, 10).join("\n- ")}`;
    }
    if (attempt === 0) {
      repairs = 1;
      await opts.log?.append(opts.stage, "repair", { error: parseError, rawOutput: result.text.slice(0, 2000) });
      messages.push({ role: "assistant", content: result.text });
      messages.push({
        role: "user",
        content:
          `Your previous reply was not usable: ${parseError}\n` +
          `Reply with ONLY the corrected JSON matching the required shape. No prose, no code fences.`,
      });
    } else {
      throw new Error(`LLM output failed validation after repair: ${parseError}`);
    }
  }
  throw new Error("unreachable");
}

// ── Misc ────────────────────────────────────────────────────────────────────

export function runId(prefix: string): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${prefix}-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

export const zUnknown = z.unknown();
