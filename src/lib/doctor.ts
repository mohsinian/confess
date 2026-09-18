// Connection health check — the `confess-audit doctor` command (also `npm run
// smoke` for dev). Verifies auth with one tiny call, settles the exact model
// string (trying candidates for Anthropic when unpinned), and lists available
// models for OpenAI-compatible endpoints.
import { loadProviderConfig, makeClient, MODEL_CANDIDATES, type ProviderConfig, type ProviderOverrides } from "./provider.js";

/** GET <baseUrl>/models — supported by Ollama, LM Studio, vLLM, OpenRouter, … */
export async function listOpenAiModels(baseUrl: string, apiKey?: string): Promise<string[]> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as { data?: Array<{ id?: string }> };
  return (json.data ?? []).map((m) => m.id ?? "").filter((id) => id.length > 0);
}

export async function runDoctor(cfg: ProviderConfig): Promise<boolean> {
  const key = cfg.authToken ?? cfg.apiKey;
  console.log(`provider:  ${cfg.provider}${cfg.baseUrl ? ` @ ${cfg.baseUrl}` : ""}`);
  console.log(`auth:      ${key ? key.slice(0, 6) + "…" : "(none)"}`);
  console.log(
    `price:     ${cfg.price.input === 0 && cfg.price.output === 0 ? "free (local endpoint or price override)" : `~$${cfg.price.input} in / $${cfg.price.output} out per Mtok (estimate — CONFESS_PRICE_INPUT/OUTPUT to override)`}`,
  );
  console.log(`tool mode: ${cfg.toolMode}${cfg.toolMode === "json" ? " (tools via JSON prompting — for models without native tool calling)" : ""}\n`);

  let candidates: string[];
  if (cfg.modelExplicit) {
    candidates = [cfg.model];
  } else if (cfg.provider === "anthropic") {
    candidates = MODEL_CANDIDATES;
  } else {
    try {
      const ids = await listOpenAiModels(cfg.baseUrl!, cfg.apiKey);
      if (ids.length > 0) {
        console.log(`available models at ${cfg.baseUrl}:`);
        for (const id of ids.slice(0, 25)) console.log(`  ${id}`);
        if (ids.length > 25) console.log(`  … and ${ids.length - 25} more`);
      }
    } catch (e) {
      console.error(`could not list models: ${(e as Error).message}`);
    }
    console.error(`\nNo model configured. Re-run with one:\n  confess-audit doctor --model <id>\nor set CONFESS_MODEL=<id> in .env`);
    return false;
  }

  for (const model of candidates) {
    process.stdout.write(`trying ${model} … `);
    try {
      const client = makeClient({ ...cfg, model });
      const started = Date.now();
      const resp = await client.chat({
        system: "You are a health check.",
        messages: [{ role: "user", content: "Reply with exactly: OK" }],
        maxTokens: 16,
      });
      console.log(`OK (${Date.now() - started} ms)`);
      console.log(`  resolved:  ${resp.model}`);
      console.log(`  reply:     ${JSON.stringify(resp.text.slice(0, 80))}`);
      console.log(`  usage:     ${resp.usage.inputTokens} in / ${resp.usage.outputTokens} out`);
      if (cfg.model !== model) console.log(`\n✔ pin this model:  CONFESS_MODEL=${model}`);
      if (cfg.provider === "openai" && cfg.toolMode === "native") {
        console.log(`\nnote: the diagnosis stage uses tool calling — if audits die with tool errors, set CONFESS_TOOL_MODE=json`);
      }
      return true;
    } catch (e) {
      console.log(`FAILED — ${(e as Error).message.split("\n")[0]}`);
    }
  }
  console.error("\nNo model worked. Run `confess-audit setup`, or check your key / base URL / model name.");
  return false;
}

/** Shared by `confess-audit doctor` and `npm run smoke`. */
export async function doctorMain(overrides: ProviderOverrides = {}): Promise<void> {
  let cfg: ProviderConfig;
  try {
    cfg = loadProviderConfig(process.env, overrides);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  process.exit((await runDoctor(cfg)) ? 0 : 1);
}
