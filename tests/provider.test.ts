// Provider-layer self-tests — no LLM: env/flag config resolution, pricing,
// budget guard, OpenAI message translation, json-mode tool-call parsing.
import {
  Budget,
  BudgetExceededError,
  isLocalBaseUrl,
  loadProviderConfig,
  priceForModel,
  toOpenAiMessages,
} from "../src/lib/provider.js";
import { parseJsonToolCalls } from "../src/agent/diagnose.js";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : " — " + detail}`);
}

function main(): void {
  console.log("tests/provider.test.ts — provider config + wire translation (no LLM)\n");

  // ── config resolution ──
  {
    const cfg = loadProviderConfig({ ANTHROPIC_API_KEY: "sk-ant-x" });
    check("anthropic direct: provider + key", cfg.provider === "anthropic" && cfg.apiKey === "sk-ant-x");
    check("anthropic direct: default model + not explicit", cfg.model === "claude-opus-5" && !cfg.modelExplicit);
    check("anthropic direct: default budget", cfg.maxRunCost === 8);
  }
  {
    const cfg = loadProviderConfig({ ANTHROPIC_AUTH_TOKEN: "tok", ANTHROPIC_BASE_URL: "https://router.example" });
    check("router: bearer token + base url", cfg.authToken === "tok" && cfg.baseUrl === "https://router.example");
  }
  {
    const cfg = loadProviderConfig({ OPENAI_API_KEY: "sk-or-x", OPENAI_BASE_URL: "https://openrouter.ai/api/v1", OPENAI_MODEL: "openai/gpt-4o" });
    check("openai: auto-detected from OPENAI_* env", cfg.provider === "openai" && cfg.model === "openai/gpt-4o" && cfg.modelExplicit);
  }
  {
    const cfg = loadProviderConfig({ CONFESS_PROVIDER: "openai", CONFESS_API_KEY: "k", CONFESS_MODEL: "m" });
    check("generic CONFESS_* aliases resolve", cfg.provider === "openai" && cfg.apiKey === "k" && cfg.model === "m");
    check("openai default base url", cfg.baseUrl === "https://api.openai.com/v1");
  }
  {
    const cfg = loadProviderConfig({ ANTHROPIC_API_KEY: "env-key", ANTHROPIC_MODEL: "env-model" }, { apiKey: "flag-key", model: "flag-model" });
    check("CLI overrides beat env", cfg.apiKey === "flag-key" && cfg.model === "flag-model");
  }
  {
    const cfg = loadProviderConfig({ OPENAI_BASE_URL: "http://localhost:11434/v1", OPENAI_MODEL: "qwen2.5-coder:32b" });
    check("local endpoint: no key needed, price 0", cfg.apiKey === "local" && cfg.price.input === 0 && cfg.price.output === 0);
  }
  {
    let threw = false;
    try {
      loadProviderConfig({ CONFESS_PROVIDER: "gemini" });
    } catch {
      threw = true;
    }
    check("invalid CONFESS_PROVIDER rejected", threw);
  }
  {
    let threw = false;
    try {
      loadProviderConfig({});
    } catch {
      threw = true;
    }
    check("missing credentials rejected", threw);
  }
  {
    const cfg = loadProviderConfig({ OPENAI_API_KEY: "k", OPENAI_MODEL: "m", CONFESS_PRICE_INPUT: "1.5", CONFESS_PRICE_OUTPUT: "6" });
    check("price override via env", cfg.price.input === 1.5 && cfg.price.output === 6);
  }
  {
    const cfg = loadProviderConfig({ ANTHROPIC_API_KEY: "k", CONFESS_TOOL_MODE: "json" });
    check("tool mode json via env", cfg.toolMode === "json");
  }

  // ── pricing + local detection ──
  {
    check("price table: opus", priceForModel("claude-opus-5").input === 15);
    check("price table: gpt-4o", priceForModel("openai/gpt-4o").input === 2.5);
    check("price table: unknown assumes expensive", priceForModel("some-new-model").input === 15);
    check(
      "isLocalBaseUrl",
      isLocalBaseUrl("http://localhost:11434/v1") &&
        isLocalBaseUrl("http://127.0.0.1:1234/v1") &&
        isLocalBaseUrl("http://[::1]:8080") &&
        !isLocalBaseUrl("https://openrouter.ai/api/v1") &&
        !isLocalBaseUrl(undefined),
    );
  }

  // ── budget guard ──
  {
    const budget = new Budget(10, { input: 15, output: 75 });
    budget.addUsage({ inputTokens: 100_000, outputTokens: 10_000 }); // $2.25
    check("budget accumulates", Math.abs(budget.totals.costUsd - 2.25) < 1e-9 && budget.totals.llmCalls === 1);
    let threw = false;
    try {
      budget.addUsage({ inputTokens: 1_000_000, outputTokens: 0 }); // +$15 → over $10
    } catch (e) {
      threw = e instanceof BudgetExceededError;
    }
    check("budget guard throws over limit", threw);
  }

  // ── OpenAI wire translation ──
  {
    const msgs = toOpenAiMessages({
      system: "sys",
      maxTokens: 100,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "looking", toolCalls: [{ id: "c1", name: "read_steps", input: { from: 1, to: 2 } }] },
        { role: "tool", results: [{ id: "c1", output: "…", isError: false }] },
      ],
    });
    check("system prepended", msgs[0].role === "system" && msgs[0].content === "sys");
    check("assistant tool_calls serialized", msgs[2].tool_calls?.[0].function.name === "read_steps" && msgs[2].tool_calls?.[0].function.arguments === '{"from":1,"to":2}');
    check("tool result → tool message", msgs[3].role === "tool" && msgs[3].tool_call_id === "c1");
  }

  // ── json tool-mode parsing ──
  {
    const ok = parseJsonToolCalls('{"tool_calls": [{"name": "list_signals", "input": {}}]}', 1);
    check("json mode: parses tool call", ok !== null && ok[0].name === "list_signals" && ok[0].id === "json-1-0");
    const fenced = parseJsonToolCalls('```json\n{"tool_calls": [{"name": "read_steps", "input": {"from": 1}}]}\n```', 2);
    check("json mode: strips code fence", fenced !== null && fenced[0].name === "read_steps");
    check("json mode: prose rejected", parseJsonToolCalls("let me think about this…", 3) === null);
    check("json mode: empty calls rejected", parseJsonToolCalls('{"tool_calls": []}', 4) === null);
    check("json mode: nameless call rejected", parseJsonToolCalls('{"tool_calls": [{"input": {}}]}', 5) === null);
    const noInput = parseJsonToolCalls('{"tool_calls": [{"name": "list_signals"}]}', 6);
    check("json mode: missing input → {}", noInput !== null && Object.keys(noInput[0].input).length === 0);
  }

  console.log(failures === 0 ? "\nall provider checks passed" : `\n${failures} FAILURE(S)`);
  if (failures > 0) process.exit(1);
}

main();
