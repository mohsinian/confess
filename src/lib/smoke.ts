// Provider smoke test (Day-1 first hour, decision D13):
//  1. verifies Bearer/base-URL auth works through the SDK,
//  2. settles the exact model string (tries candidates in order),
//  3. prints latency + a price signal from usage data.
import Anthropic from "@anthropic-ai/sdk";
import { loadProviderConfig, makeClient, MODEL_CANDIDATES, Budget } from "./anthropic.js";

async function tryModel(client: Anthropic, model: string) {
  const started = Date.now();
  const raw = await client.messages.create({
    model,
    max_tokens: 8,
    temperature: 0,
    messages: [{ role: "user", content: "Reply with exactly: OK" }],
  });
  // Normalize proxies that return a JSON body with a non-JSON content-type.
  const response = (typeof raw === "string" ? JSON.parse(raw) : raw) as import("@anthropic-ai/sdk").Messages.Message;
  const text = response.content
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");
  return { model, resolved: response.model, text, ms: Date.now() - started, usage: response.usage };
}

async function main() {
  const cfg = loadProviderConfig();
  console.log(`Provider: ${cfg.authToken ? "router (Bearer)" : "direct (X-Api-Key)"}${cfg.baseUrl ? ` @ ${cfg.baseUrl}` : ""}`);
  const client = makeClient(cfg);

  const candidates = process.env.ANTHROPIC_MODEL ? [process.env.ANTHROPIC_MODEL] : MODEL_CANDIDATES;
  for (const model of candidates) {
    process.stdout.write(`Trying ${model} … `);
    try {
      const r = await tryModel(client, model);
      console.log(`OK (${r.ms} ms)`);
      console.log(`  requested:  ${r.model}`);
      console.log(`  resolved:   ${r.resolved}`);
      console.log(`  reply:      ${JSON.stringify(r.text)}`);
      console.log(`  usage:      ${JSON.stringify(r.usage)}`);
      if (process.env.ANTHROPIC_MODEL !== model) {
        console.log(`\n✔ Add this line to .env to pin the model:\n    ANTHROPIC_MODEL=${model}\n`);
      }
      return;
    } catch (e) {
      const msg = (e as Error).message.split("\n")[0];
      console.log(`FAILED — ${msg}`);
    }
  }
  console.error("\nNo candidate model worked. Check ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL / model names.");
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
