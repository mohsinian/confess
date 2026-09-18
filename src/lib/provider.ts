// Provider-agnostic LLM access. One minimal client interface over two wire
// protocols: Anthropic (direct, or an Anthropic-compatible router with Bearer
// auth) and any OpenAI-compatible endpoint (OpenRouter, Together, Groq, vLLM,
// Ollama, LM Studio). Every call: temperature 0, retries, zod validation, ONE
// repair round-trip, usage/cost accounting, per-run budget abort, run logging.
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { z, type ZodType } from "zod";
import { jsonrepair } from "jsonrepair";
import { zodErrors } from "../schema.js";
import type { RunLog } from "./runlog.js";

// ── Provider config ─────────────────────────────────────────────────────────

export type ProviderKind = "anthropic" | "openai";
/** native = wire-level tool calling; json = tools described in the prompt, calls parsed from model output */
export type ToolMode = "native" | "json";

export interface ProviderConfig {
  provider: ProviderKind;
  /** Bearer token for Anthropic-compatible routers (e.g. AgentRouter) */
  authToken?: string;
  apiKey?: string;
  baseUrl?: string;
  model: string;
  /** false when the model fell back to a built-in default (or is unset) */
  modelExplicit: boolean;
  maxRunCost: number;
  /** resolved USD per million tokens */
  price: { input: number; output: number };
  toolMode: ToolMode;
}

/** CLI flags beat environment variables. */
export interface ProviderOverrides {
  provider?: ProviderKind;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

export const MODEL_CANDIDATES = ["claude-opus-5", "claude-opus-4-8", "claude-opus-4-6"];
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const OLLAMA_BASE_URL = "http://localhost:11434/v1";

export function isLocalBaseUrl(baseUrl?: string): boolean {
  if (!baseUrl) return false;
  try {
    const h = new URL(baseUrl).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
  } catch {
    return false;
  }
}

function pick(...vals: Array<string | undefined>): string | undefined {
  for (const v of vals) {
    const t = v?.trim();
    if (t) return t;
  }
  return undefined;
}

export function loadProviderConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: ProviderOverrides = {},
): ProviderConfig {
  const providerRaw = overrides.provider ?? pick(env.CONFESS_PROVIDER) ??
    (env.OPENAI_API_KEY || env.OPENAI_BASE_URL ? "openai" : "anthropic");
  if (providerRaw !== "anthropic" && providerRaw !== "openai") {
    throw new Error(`CONFESS_PROVIDER must be "anthropic" or "openai" (got "${providerRaw}")`);
  }
  const provider: ProviderKind = providerRaw;

  const baseUrl =
    pick(overrides.baseUrl, env.CONFESS_BASE_URL, provider === "openai" ? env.OPENAI_BASE_URL : env.ANTHROPIC_BASE_URL) ??
    (provider === "openai" ? DEFAULT_OPENAI_BASE_URL : undefined);

  const authToken = provider === "anthropic" ? pick(env.ANTHROPIC_AUTH_TOKEN) : undefined;
  const apiKey =
    pick(overrides.apiKey, env.CONFESS_API_KEY, provider === "openai" ? env.OPENAI_API_KEY : env.ANTHROPIC_API_KEY) ??
    (isLocalBaseUrl(baseUrl) ? "local" : undefined); // local servers ignore the key; clients still want one

  if (!authToken && !apiKey) {
    throw new Error(
      "No provider credentials. Run `confess-audit setup`, or set ANTHROPIC_API_KEY (direct), " +
        "ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL (router), or OPENAI_API_KEY + OPENAI_BASE_URL " +
        "(OpenAI-compatible) — see .env.example. Local Ollama needs no key: confess-audit --local --model <name>.",
    );
  }

  const model = pick(overrides.model, env.CONFESS_MODEL, provider === "openai" ? env.OPENAI_MODEL : env.ANTHROPIC_MODEL);
  const modelExplicit = model !== undefined;

  return {
    provider,
    authToken,
    apiKey,
    baseUrl,
    model: model ?? (provider === "anthropic" ? MODEL_CANDIDATES[0] : ""),
    modelExplicit,
    maxRunCost: Number(env.MAX_RUN_COST ?? 8), // synthetic cases need ~5; real transcripts with large results need more
    price: resolvePrice(env, model ?? "", baseUrl),
    toolMode: pick(env.CONFESS_TOOL_MODE) === "json" ? "json" : "native",
  };
}

// ── Cost accounting ─────────────────────────────────────────────────────────
// Claude list prices; a few well-known hosted models; local endpoints are free.
// Unknown remote models assume expensive (the budget guard trips early, never
// late). Exact pricing: CONFESS_PRICE_INPUT / CONFESS_PRICE_OUTPUT per Mtok.

export const PRICE_TABLE: Array<{ match: RegExp; input: number; output: number }> = [
  { match: /sonnet/i, input: 3, output: 15 },
  { match: /haiku/i, input: 0.8, output: 4 },
  { match: /opus/i, input: 15, output: 75 },
  { match: /gpt-4o-mini/i, input: 0.15, output: 0.6 },
  { match: /gpt-4o/i, input: 2.5, output: 10 },
  { match: /deepseek/i, input: 0.3, output: 1.2 },
];

export function priceForModel(model: string): { input: number; output: number } {
  const hit = PRICE_TABLE.find((p) => p.match.test(model));
  return hit ?? { input: 15, output: 75 }; // unknown model → assume expensive
}

function resolvePrice(
  env: NodeJS.ProcessEnv,
  model: string,
  baseUrl?: string,
): { input: number; output: number } {
  if (env.CONFESS_PRICE_INPUT !== undefined && env.CONFESS_PRICE_OUTPUT !== undefined) {
    const input = Number(env.CONFESS_PRICE_INPUT);
    const output = Number(env.CONFESS_PRICE_OUTPUT);
    if (Number.isFinite(input) && Number.isFinite(output) && input >= 0 && output >= 0) return { input, output };
  }
  if (isLocalBaseUrl(baseUrl)) return { input: 0, output: 0 };
  return priceForModel(model);
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
  constructor(
    public limit: number,
    private price: { input: number; output: number },
  ) {}

  addUsage(usage: { inputTokens: number; outputTokens: number }): void {
    this.totals.inputTokens += usage.inputTokens;
    this.totals.outputTokens += usage.outputTokens;
    this.totals.costUsd += (usage.inputTokens / 1e6) * this.price.input + (usage.outputTokens / 1e6) * this.price.output;
    this.totals.llmCalls += 1;
    if (this.totals.costUsd > this.limit) throw new BudgetExceededError(this.totals.costUsd, this.limit);
  }
}

// ── Client interface ────────────────────────────────────────────────────────

export interface LlmTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultMsg {
  id: string;
  output: string;
  isError: boolean;
}

export type LlmMessage =
  | { role: "user" | "assistant"; content: string }
  | { role: "assistant"; content: string; toolCalls: ToolCall[] }
  | { role: "tool"; results: ToolResultMsg[] };

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "other";

export interface ChatRequest {
  system: string;
  messages: LlmMessage[];
  maxTokens: number;
  tools?: LlmTool[];
}

export interface ChatResponse {
  text: string;
  toolCalls: ToolCall[];
  stopReason: StopReason;
  model: string; // the model the API reports it actually used
  usage: { inputTokens: number; outputTokens: number };
}

export interface LlmClient {
  chat(req: ChatRequest): Promise<ChatResponse>;
}

// ── Anthropic implementation ────────────────────────────────────────────────

export function toAnthropicMessage(m: LlmMessage): Anthropic.MessageParam {
  if (m.role === "tool") {
    return {
      role: "user",
      content: m.results.map((r) => ({
        type: "tool_result" as const,
        tool_use_id: r.id,
        content: r.output,
        is_error: r.isError,
      })),
    };
  }
  if (m.role === "assistant" && "toolCalls" in m) {
    const content: Anthropic.ContentBlockParam[] = [];
    if (m.content) content.push({ type: "text", text: m.content });
    for (const tc of m.toolCalls) content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
    return { role: "assistant", content };
  }
  return { role: m.role, content: m.content };
}

class AnthropicClient implements LlmClient {
  private sdk: Anthropic;
  constructor(private cfg: ProviderConfig) {
    this.sdk = new Anthropic({
      ...(cfg.authToken ? { authToken: cfg.authToken } : {}),
      ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
      ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}),
      maxRetries: 2,
      timeout: 720_000, // Opus via router: 32K-token transcript generations need up to ~10 min
      // Router compatibility only: AgentRouter gates on client identity and answers
      // 401 "unauthorized client detected" without the Claude Code user-agent.
      // Direct Anthropic and OpenAI-compatible providers need none of this.
      ...(cfg.baseUrl
        ? { defaultHeaders: { "user-agent": "claude-cli/2.0.14 (external, cli)", "x-app": "cli" } }
        : {}),
    });
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const response = await this.sdk.messages.create({
      model: this.cfg.model,
      max_tokens: req.maxTokens,
      temperature: 0,
      system: req.system,
      messages: req.messages.map(toAnthropicMessage),
      ...(req.tools ? { tools: req.tools as Anthropic.Tool[] } : {}),
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
    const toolCalls: ToolCall[] = message.content
      .filter((b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> }));
    const sr = message.stop_reason;
    return {
      text,
      toolCalls,
      stopReason: sr === "tool_use" ? "tool_use" : sr === "max_tokens" ? "max_tokens" : sr === "end_turn" ? "end_turn" : "other",
      model: message.model ?? this.cfg.model,
      usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens },
    };
  }
}

// ── OpenAI-compatible implementation (plain fetch — no SDK dependency) ─────

interface OaiMessage {
  role: string;
  content: string | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

export function toOpenAiMessages(req: ChatRequest): OaiMessage[] {
  const out: OaiMessage[] = [{ role: "system", content: req.system }];
  for (const m of req.messages) {
    if (m.role === "tool") {
      for (const r of m.results) out.push({ role: "tool", tool_call_id: r.id, content: r.output });
    } else if (m.role === "assistant" && "toolCalls" in m) {
      out.push({
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.input) },
        })),
      });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

function parseToolArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    try {
      return JSON.parse(jsonrepair(raw)) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}

async function postChatCompletions(baseUrl: string, apiKey: string | undefined, body: unknown): Promise<string> {
  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1000 * attempt));
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(720_000),
      });
    } catch (e) {
      lastError = e as Error; // network-level failure — retry
      continue;
    }
    if (res.ok) return res.text();
    const detail = (await res.text()).slice(0, 300);
    if (res.status === 429 || res.status >= 500) {
      lastError = new Error(`HTTP ${res.status} from ${url}: ${detail}`);
      continue;
    }
    throw new Error(`HTTP ${res.status} from ${url}: ${detail}`); // 4xx won't heal — fail fast
  }
  throw lastError ?? new Error("request failed");
}

class OpenAiClient implements LlmClient {
  constructor(private cfg: ProviderConfig) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const raw = await postChatCompletions(this.cfg.baseUrl ?? DEFAULT_OPENAI_BASE_URL, this.cfg.apiKey, {
      model: this.cfg.model,
      max_tokens: req.maxTokens,
      temperature: 0,
      messages: toOpenAiMessages(req),
      ...(req.tools
        ? {
            tools: req.tools.map((t) => ({
              type: "function",
              function: { name: t.name, description: t.description, parameters: t.input_schema },
            })),
          }
        : {}),
    });
    const json = JSON.parse(raw) as {
      model?: string;
      choices?: Array<{ finish_reason?: string; message?: { content?: string | null; tool_calls?: OaiMessage["tool_calls"] } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const choice = json.choices?.[0];
    if (!choice) throw new Error("OpenAI-compatible endpoint returned no choices");
    const toolCalls: ToolCall[] = (choice.message?.tool_calls ?? [])
      .map((tc, i) => ({
        id: tc.id || `call_${Date.now()}_${i}`,
        name: tc.function?.name ?? "",
        input: parseToolArguments(tc.function?.arguments),
      }))
      .filter((tc) => tc.name.length > 0);
    const finish = choice.finish_reason;
    return {
      text: typeof choice.message?.content === "string" ? choice.message.content : "",
      toolCalls,
      stopReason:
        toolCalls.length > 0 || finish === "tool_calls"
          ? "tool_use"
          : finish === "length"
            ? "max_tokens"
            : finish === "stop"
              ? "end_turn"
              : "other",
      model: json.model ?? this.cfg.model,
      usage: { inputTokens: json.usage?.prompt_tokens ?? 0, outputTokens: json.usage?.completion_tokens ?? 0 },
    };
  }
}

export function makeClient(cfg: ProviderConfig): LlmClient {
  return cfg.provider === "openai" ? new OpenAiClient(cfg) : new AnthropicClient(cfg);
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
  client: LlmClient,
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
  const response = await client.chat({
    system: opts.system,
    messages: opts.messages,
    maxTokens,
  });
  const usage = {
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
    costUsd:
      (response.usage.inputTokens / 1e6) * cfg.price.input + (response.usage.outputTokens / 1e6) * cfg.price.output,
  };
  opts.budget.addUsage(response.usage);
  await opts.log?.append(opts.stage, "response", { stopReason: response.stopReason, text: response.text }, usage);
  return { text: response.text, model: response.model || cfg.model, usage };
}

export interface JsonCallResult<T> extends CallResult {
  data: T;
  repairs: number;
}

// One call + zod validation + ONE repair round-trip on failure (policy D6/rule 1
// — identical for baseline and agent, so JSON robustness is never a confound).
export async function callJson<T>(
  client: LlmClient,
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
