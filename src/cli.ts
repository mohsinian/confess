#!/usr/bin/env node
// confess-audit — one command, one session, receipts checked.
//
//   npx confess-audit                       audit your most recent Claude Code session
//   npx confess-audit <session.jsonl>       audit a specific transcript
//   npx confess-audit --list                browse recent sessions
//   npx confess-audit --off verify,memory   cheaper audit (detectors + diagnosis agent)
//
// Findings print to the terminal; the full report lands in ./confess-reports/.
// Credentials come from the environment (ANTHROPIC_API_KEY, or ANTHROPIC_AUTH_TOKEN
// + ANTHROPIC_BASE_URL for a router) or from a .env in the current directory.
// Read-only: Confess parses the log and calls the model — it never executes
// anything the audited session ran.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { loadProviderConfig } from "./lib/anthropic.js";
import { ensureDir } from "./lib/cases.js";
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

Credentials:
  ANTHROPIC_API_KEY=sk-ant-...                    (direct Anthropic)
  ANTHROPIC_AUTH_TOKEN=... ANTHROPIC_BASE_URL=... (Anthropic-compatible router)
  or a .env file in the current directory (same variable names).
  A typical session audit costs ~$1–3 with an Opus-class model.

Exit codes: 0 complete (findings or clean) · 1 partial (budget-truncated) or error.`;

interface CliArgs {
  file?: string;
  list: boolean;
  yes: boolean;
  out?: string;
  help: boolean;
  off: Options["off"];
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const cli: CliArgs = { list: false, yes: false, help: false, off: { memory: false, verify: false, detectors: false } };
  const flagValue = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  cli.out = flagValue("--out");
  const off = flagValue("--off");
  if (off !== undefined) {
    for (const comp of off.split(",")) {
      if (comp === "memory") cli.off.memory = true;
      else if (comp === "verify") cli.off.verify = true;
      else if (comp === "detectors") cli.off.detectors = true;
    }
  }
  cli.list = argv.includes("--list");
  cli.yes = argv.includes("--yes");
  cli.help = argv.includes("--help") || argv.includes("-h");
  const positionalIdx = argv.findIndex(
    (a, i) => !a.startsWith("--") && a.endsWith(".jsonl") && argv[i - 1] !== "--out" && argv[i - 1] !== "--off",
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

// ── cost checkpoint (ground rule: human approval before the spend) ─────────

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

  let cfg: ReturnType<typeof loadProviderConfig>;
  try {
    cfg = loadProviderConfig();
  } catch (e) {
    console.error(`\n${(e as Error).message}`);
    console.error(
      `\nFor a one-off run, export credentials in your shell (or put them in ./.env):\n` +
        `  export ANTHROPIC_API_KEY=sk-ant-...\n` +
        `  — or —\n` +
        `  export ANTHROPIC_AUTH_TOKEN=<router key>\n` +
        `  export ANTHROPIC_BASE_URL=https://agentrouter.org`,
    );
    process.exit(1);
  }

  const offLabel = cli.off.memory || cli.off.verify || cli.off.detectors
    ? [cli.off.memory && "memory", cli.off.verify && "verify", cli.off.detectors && "detectors"].filter(Boolean).join(", −")
    : null;
  console.log(`\n  model: ${cfg.model}${offLabel ? ` (−${offLabel})` : ""} · typical audit $1–3 · budget guard aborts at $${cfg.maxRunCost.toFixed(2)}`);
  if (!cli.yes) {
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
  const report = await runAudit(
    session + configTag,
    events,
    cfg,
    { off: cli.off },
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
  } else if (report.findings.length === 0) {
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
