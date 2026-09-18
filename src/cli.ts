#!/usr/bin/env node
// confess-audit — one command, one session, receipts checked.
//
//   npx confess-audit                       audit your most recent Claude Code session
//   npx confess-audit <session.jsonl>       audit a specific transcript
//   npx confess-audit --list                browse recent sessions
//   npx confess-audit --off verify,memory   cheaper audit (detectors + diagnosis agent)
//   npx confess-audit setup                 interactive provider setup (writes ./.env)
//   npx confess-audit doctor                test credentials + model
//   npx confess-audit --local --model <m>   audit with local Ollama (free, no key)
//
// Findings print to the terminal; the full report lands in ./confess-reports/.
// Providers: Anthropic (direct or compatible router), any OpenAI-compatible
// endpoint (OpenRouter, Together, Groq, vLLM, …), or local Ollama/LM Studio.
// Read-only: Confess parses the log and calls the model — it never executes
// anything the audited session ran.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import {
  loadProviderConfig,
  OLLAMA_BASE_URL,
  type ProviderConfig,
  type ProviderOverrides,
} from "./lib/provider.js";
import { doctorMain, listOpenAiModels, runDoctor } from "./lib/doctor.js";
import { runAudit, type Options } from "./agent/run.js";
import { ingestClaudeCode } from "./ingest/claudeCode.js";

const REPORTS_DIRNAME = "confess-reports";
const USAGE = `confess-audit — audit an AI coding-agent session transcript.

Usage:
  confess-audit                        audit the most recent Claude Code session
  confess-audit <session.jsonl>        audit a specific transcript
  confess-audit --list                 list recent sessions (newest first)
  confess-audit --off verify,memory    skip claim-verification / constraint ledger (cheaper)
  confess-audit --out <dir>            write reports under <dir> (default ./confess-reports)
  confess-audit --yes                  skip the cost checkpoint

Setup & providers:
  confess-audit setup                  interactive setup — writes ./.env
  confess-audit doctor                 test credentials + model, list available models
  confess-audit --local --model qwen2.5-coder:32b   use local Ollama (free, no API key)
  --provider anthropic|openai  --base-url <url>  --api-key <key>  --model <name>

Environment (or ./.env):
  Anthropic direct:      ANTHROPIC_API_KEY=sk-ant-...
  Anthropic router:      ANTHROPIC_AUTH_TOKEN=... ANTHROPIC_BASE_URL=...
  OpenAI-compatible:     OPENAI_API_KEY=... OPENAI_BASE_URL=... OPENAI_MODEL=...
  Generic aliases:       CONFESS_PROVIDER / CONFESS_API_KEY / CONFESS_BASE_URL / CONFESS_MODEL
  Tweaks:                CONFESS_TOOL_MODE=json  (models without native tool calling)
                         CONFESS_PRICE_INPUT/OUTPUT  ($ per million tokens)
                         MAX_RUN_COST  (per-audit budget guard, default $8)

A typical audit costs ~$1–3 with an Opus-class model; local models are free.
Exit codes: 0 complete (findings or clean) · 1 partial (budget-truncated) or error.`;

const CREDENTIALS_HELP = `
Easiest:  confess-audit setup          (interactive — writes ./.env)
Or set environment variables yourself:
  Anthropic direct:      ANTHROPIC_API_KEY=sk-ant-...
  Anthropic router:      ANTHROPIC_AUTH_TOKEN=<key>  ANTHROPIC_BASE_URL=https://agentrouter.org
  OpenAI-compatible:     OPENAI_API_KEY=<key>  OPENAI_BASE_URL=<url>  OPENAI_MODEL=<name>
  Local Ollama:          no key needed — confess-audit --local --model <name>
Shell syntax — bash:       export ANTHROPIC_API_KEY=sk-ant-...
             PowerShell:   $env:ANTHROPIC_API_KEY="sk-ant-..."
             cmd:          set ANTHROPIC_API_KEY=sk-ant-...`;

interface CliArgs {
  command?: "setup" | "doctor";
  file?: string;
  list: boolean;
  yes: boolean;
  out?: string;
  help: boolean;
  local: boolean;
  off: Options["off"];
  overrides: ProviderOverrides;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const cli: CliArgs = {
    list: false,
    yes: false,
    help: false,
    local: false,
    off: { memory: false, verify: false, detectors: false, gates: false },
    overrides: {},
  };
  const flagValue = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  const first = argv[0];
  if (first === "setup" || first === "doctor") cli.command = first;
  cli.out = flagValue("--out");
  cli.overrides.provider = flagValue("--provider") as ProviderOverrides["provider"];
  cli.overrides.baseUrl = flagValue("--base-url");
  cli.overrides.apiKey = flagValue("--api-key");
  cli.overrides.model = flagValue("--model");
  cli.local = argv.includes("--local");
  if (cli.local) {
    cli.overrides.provider = "openai";
    cli.overrides.baseUrl ??= OLLAMA_BASE_URL;
    cli.overrides.apiKey ??= "ollama"; // Ollama ignores the key; the client still sends one
  }
  const valuedFlags = ["--out", "--off", "--provider", "--base-url", "--api-key", "--model"];
  const off = flagValue("--off");
  if (off !== undefined) {
    for (const comp of off.split(",")) {
      if (comp === "memory") cli.off.memory = true;
      else if (comp === "verify") cli.off.verify = true;
      else if (comp === "detectors") cli.off.detectors = true;
      else if (comp === "gates") cli.off.gates = true;
    }
  }
  cli.list = argv.includes("--list");
  cli.yes = argv.includes("--yes");
  cli.help = argv.includes("--help") || argv.includes("-h");
  const positionalIdx = argv.findIndex(
    (a, i) => !a.startsWith("--") && a.endsWith(".jsonl") && !valuedFlags.includes(argv[i - 1] ?? ""),
  );
  if (positionalIdx !== -1) cli.file = argv[positionalIdx];
  return cli;
}

// ── session discovery (~/.claude/projects/<project>/<session-uuid>.jsonl) ──

interface SessionFile {
  file: string;
  mtimeMs: number;
  sizeBytes: number;
}

export function findSessions(): SessionFile[] {
  const root = path.join(os.homedir(), ".claude", "projects");
  if (!fs.existsSync(root)) return [];
  const out: SessionFile[] = [];
  for (const project of fs.readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const dir = path.join(root, project.name);
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
      const file = path.join(dir, f.name);
      const st = fs.statSync(file);
      out.push({ file, mtimeMs: st.mtimeMs, sizeBytes: st.size });
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function age(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function listSessions(): void {
  const sessions = findSessions();
  if (sessions.length === 0) {
    console.error(`no Claude Code sessions found under ${path.join(os.homedir(), ".claude", "projects")}`);
    process.exit(1);
  }
  console.log(`recent sessions (newest first):\n`);
  for (const s of sessions.slice(0, 15)) {
    console.log(`  ${age(Date.now() - s.mtimeMs).padStart(8)}  ${(s.sizeBytes / 1024).toFixed(0).padStart(6)} KB  ${s.file}`);
  }
  if (sessions.length > 15) console.log(`  … and ${sessions.length - 15} more`);
  console.log(`\naudit one:  npx confess-audit "<path from above>"`);
}

// ── cost checkpoint (human approval before the spend) ─────────

async function confirmSpend(question: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

// ── interactive setup wizard ──────────────────────────────────

async function runSetup(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(`setup needs an interactive terminal. Configure manually instead:${CREDENTIALS_HELP}`);
    process.exit(1);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q: string) => (await rl.question(q)).trim();
  try {
    console.log(`confess-audit setup — writes a .env file in the current directory.\n`);
    console.log(`  1) Anthropic API (direct — key from console.anthropic.com)`);
    console.log(`  2) Anthropic-compatible router (e.g. AgentRouter)`);
    console.log(`  3) OpenAI-compatible API (OpenRouter, Together, Groq, vLLM, …)`);
    console.log(`  4) Local Ollama (free, private — no API key)`);
    const choice = await ask(`\nprovider [1-4]: `);
    const lines: string[] = [`# confess-audit configuration — written by \`confess-audit setup\``];

    if (choice === "1") {
      const key = await ask(`ANTHROPIC_API_KEY (sk-ant-...): `);
      if (!key) {
        console.error("no key given — aborting, nothing written.");
        process.exit(1);
      }
      const model = await ask(`model [claude-opus-5]: `);
      lines.push(`ANTHROPIC_API_KEY=${key}`, `ANTHROPIC_MODEL=${model || "claude-opus-5"}`);
    } else if (choice === "2") {
      const key = await ask(`router token: `);
      if (!key) {
        console.error("no token given — aborting, nothing written.");
        process.exit(1);
      }
      const base = (await ask(`base URL [https://agentrouter.org]: `)) || "https://agentrouter.org";
      const model = await ask(`model [claude-opus-5]: `);
      lines.push(`ANTHROPIC_AUTH_TOKEN=${key}`, `ANTHROPIC_BASE_URL=${base}`, `ANTHROPIC_MODEL=${model || "claude-opus-5"}`);
    } else if (choice === "3") {
      const base = (await ask(`base URL [https://openrouter.ai/api/v1]: `)) || "https://openrouter.ai/api/v1";
      const key = await ask(`API key: `);
      if (!key) {
        console.error("no key given — aborting, nothing written.");
        process.exit(1);
      }
      const model = await ask(`model (e.g. anthropic/claude-opus-4, openai/gpt-4o): `);
      if (!model) {
        console.error("no model given — aborting, nothing written.");
        process.exit(1);
      }
      lines.push(
        `OPENAI_BASE_URL=${base}`,
        `OPENAI_API_KEY=${key}`,
        `OPENAI_MODEL=${model}`,
        `# if audits fail with tool errors, this model may lack tool calling:`,
        `# CONFESS_TOOL_MODE=json`,
      );
    } else if (choice === "4") {
      process.stdout.write(`checking Ollama at ${OLLAMA_BASE_URL} … `);
      let picked = "";
      try {
        const ids = await listOpenAiModels(OLLAMA_BASE_URL);
        console.log(`found ${ids.length} model(s).`);
        if (ids.length > 0) {
          ids.forEach((id, i) => console.log(`  ${i + 1}) ${id}`));
          const sel = await ask(`model [1-${ids.length} or type a name]: `);
          const n = Number(sel);
          picked = Number.isInteger(n) && n >= 1 && n <= ids.length ? ids[n - 1] : sel;
        }
      } catch {
        console.log(`unreachable (is \`ollama serve\` running? config will still be written).`);
      }
      if (!picked) picked = await ask(`model name (e.g. qwen2.5-coder:32b): `);
      if (!picked) {
        console.error("no model given — aborting, nothing written.");
        process.exit(1);
      }
      lines.push(
        `# local Ollama — no API key needed`,
        `OPENAI_BASE_URL=${OLLAMA_BASE_URL}`,
        `OPENAI_MODEL=${picked}`,
        `# if audits fail with tool errors, this model may lack tool calling:`,
        `# CONFESS_TOOL_MODE=json`,
      );
    } else {
      console.error(`unknown choice "${choice}" — aborting, nothing written.`);
      process.exit(1);
    }

    const envPath = path.resolve(".env");
    if (fs.existsSync(envPath)) {
      const ow = (await ask(`\n.env already exists — overwrite? [y/N] `)).toLowerCase();
      if (ow !== "y" && ow !== "yes") {
        console.log("aborted — existing .env untouched.");
        process.exit(0);
      }
    }
    fs.writeFileSync(envPath, lines.join("\n") + "\n", "utf8");
    console.log(`\nwrote ${envPath}`);
    // dotenv ran at process start (before this .env existed) — inject for the test below.
    for (const line of lines) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line);
      if (m) process.env[m[1]] = m[2];
    }
    const test = (await ask(`test the connection now? [Y/n] `)).toLowerCase();
    if (test !== "n" && test !== "no") {
      const ok = await runDoctor(loadProviderConfig());
      if (ok) console.log(`\nsetup complete — run an audit with:  npx confess-audit`);
      else process.exit(1);
    } else {
      console.log(`\ndone — verify any time with:  npx confess-audit doctor`);
    }
  } finally {
    rl.close();
  }
}

// ── audit one session ──────────────────────────────────────────────────────

async function audit(cli: CliArgs): Promise<void> {
  let file = cli.file;
  if (!file) {
    const latest = findSessions()[0];
    if (!latest) {
      console.error(`no session file given and none found under ${path.join(os.homedir(), ".claude", "projects")}`);
      process.exit(1);
    }
    file = latest.file;
    console.log(`no file given — using the most recent session (${age(Date.now() - latest.mtimeMs)}):`);
    console.log(`  ${file}\n`);
  }
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) {
    console.error(`no such file: ${abs}`);
    process.exit(1);
  }

  const session = path.basename(abs, ".jsonl").slice(0, 8); // uuid prefix — short dir names
  const { events, warnings, stats } = ingestClaudeCode(abs);
  console.log(`confess v0.1 — ingesting ${abs}`);
  console.log(
    `  ${stats.rawLines} raw lines → ${events.length} steps ` +
      `(${stats.skippedMeta} meta, ${stats.skippedSidechain} sidechain, ${stats.skippedBlocks} non-text blocks, ${stats.mergedEvents} merged)` +
        (stats.truncatedResults + stats.truncatedTexts > 0
          ? ` — ⚠ capped ${stats.truncatedResults} result(s), ${stats.truncatedTexts} text block(s); oversized content was NOT fully audited`
          : ""),
  );
  if (warnings.length > 0) {
    console.log(`  ⚠ ${warnings.length} warning(s):`);
    for (const w of warnings.slice(0, 8)) console.log(`    - ${w}`);
  }
  if (events.length < 4) {
    console.error("  transcript too short to audit after ingestion — nothing to do.");
    process.exit(1);
  }

  let cfg: ProviderConfig;
  try {
    cfg = loadProviderConfig(process.env, cli.overrides);
  } catch (e) {
    console.error(`\n${(e as Error).message}`);
    console.error(CREDENTIALS_HELP);
    process.exit(1);
  }

  if (!cfg.model) {
    // OpenAI-compatible provider without a model — list what the endpoint offers.
    console.error(`\nno model configured for provider "${cfg.provider}".`);
    try {
      const ids = await listOpenAiModels(cfg.baseUrl!, cfg.apiKey);
      if (ids.length > 0) {
        console.error(`available at ${cfg.baseUrl}:\n` + ids.slice(0, 25).map((id) => `  ${id}`).join("\n"));
      }
    } catch {
      console.error(`(could not list models at ${cfg.baseUrl} — is the server running?)`);
    }
    console.error(`\npick one:  confess-audit ${cli.local ? "--local " : ""}--model <name> "${file}"`);
    console.error(`or persist:  CONFESS_MODEL=<name> in ./.env`);
    process.exit(1);
  }

  const free = cfg.price.input === 0 && cfg.price.output === 0;
  const offLabel = cli.off.memory || cli.off.verify || cli.off.detectors
    ? [cli.off.memory && "memory", cli.off.verify && "verify", cli.off.detectors && "detectors"].filter(Boolean).join(", −")
    : null;
  const providerLabel = `${cfg.provider}${cfg.baseUrl ? ` @ ${cfg.baseUrl}` : ""}`;
  console.log(
    `\n  model: ${cfg.model} · ${providerLabel}${offLabel ? ` (−${offLabel})` : ""}` +
      (free
        ? ` · free provider — no spend approval needed`
        : ` · typical audit $1–3 · budget guard aborts at $${cfg.maxRunCost.toFixed(2)}`),
  );
  if (cfg.provider === "openai" || !/claude/i.test(cfg.model)) {
    console.log(
      `  ⚠ this model is outside the published benchmark (Opus-class) — the guardrails still\n` +
        `    apply, but precision/recall may vary. Tool errors? Set CONFESS_TOOL_MODE=json.`,
    );
  }
  if (!cli.yes && !free) {
    const ok = await confirmSpend("  proceed with the audit? [y/N] ");
    if (!ok) {
      console.log("aborted — nothing was spent. (Skip this prompt with --yes.)");
      process.exit(0);
    }
  }

  const outBase = path.resolve(cli.out ?? REPORTS_DIRNAME);
  // Config-specific report dir: a cheap re-run (--off) must never overwrite a
  // full audit's report — they are different products about the same session.
  const configTag = offLabel ? "-off-" + [cli.off.memory && "memory", cli.off.verify && "verify", cli.off.detectors && "detectors"].filter(Boolean).join("-") : "";
  const reportDir = path.join(outBase, session + configTag);
  const started = Date.now();
  // Structural warnings degrade the audit (evidence may be incomplete); cosmetic
  // ones (trimming leading/trailing events) only print.
  const degradationReasons = warnings.filter((w) => w.startsWith("invariant:") || w.startsWith("line "));
  const report = await runAudit(
    session + configTag,
    events,
    cfg,
    { off: cli.off, degradationReasons },
    "claude-code",
    {
      onStage: (stage) => console.log(`  · ${stage}`),
      outBase,
    },
  );

  const flagged = report.findings.filter((f) => f.needs_human_review).length;
  console.log(
    `\n  ${report.findings.length} finding(s) (${flagged} ⚡ review)  $${report.stats.costUsd.toFixed(2)}  ${((Date.now() - started) / 1000).toFixed(0)}s`,
  );
  if (report.degraded) {
    console.log(
      `
  ⚠ AUDIT DEGRADED — a stage failed or the log was malformed; evidence is incomplete.
` +
        `  A degraded audit is never a clean verdict — see the report's assessment.`,
    );
    process.exitCode = 1;
  }
  if (report.truncated) {
    console.log(
      `\n  ⚠ AUDIT TRUNCATED before diagnosis completed (budget guard, $${report.stats.costUsd.toFixed(2)}).\n` +
        `  A partial audit is NOT a clean bill of health — raise MAX_RUN_COST in your\n` +
        `  environment, or re-run cheaper: confess-audit --off verify,memory <file>`,
    );
    process.exitCode = 1; // scripts can detect a partial audit without parsing output
  } else if (report.findings.length === 0 && !report.truncated && !report.degraded) {
    console.log("   No failures detected — the session's claims check out against its tool results.");
  }
  for (const f of report.findings) {
    console.log(
      `   • ${f.failure_type} @ step ${f.step} (conf ${f.confidence.toFixed(2)})${f.needs_human_review ? " ⚡" : ""}: ${f.summary.split("\n")[0].slice(0, 110)}`,
    );
  }
  console.log(`\n  report: ${path.join(reportDir, "report.md")}`);
}

async function main(): Promise<void> {
  const cli = parseArgs();
  if (cli.help) {
    console.log(USAGE);
    return;
  }
  if (cli.command === "setup") {
    await runSetup();
    return;
  }
  if (cli.command === "doctor") {
    await doctorMain(cli.overrides);
    return;
  }
  if (cli.list) {
    listSessions();
    return;
  }
  await audit(cli);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
