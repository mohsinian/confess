// Trajectory renderer (deliverable 04): turns runs/<system>/<case>/run.jsonl
// into a readable markdown narrative — every LLM turn, every tool call and its
// response, repairs and guardrail rejections, ending with the report.
// Usage: npm run demo -- --case case_12 [--system agent] [--out runs/rendered]
import fs from "node:fs";
import path from "node:path";
import { ROOT, listCases, runDir, ensureDir } from "../lib/cases.js";
import type { RunLogEntry } from "../lib/runlog.js";

function parseArgs(): { caseId?: string; system: string; outDir: string } {
  const args = process.argv.slice(2);
  const caseIdx = args.indexOf("--case");
  const sysIdx = args.indexOf("--system");
  const outIdx = args.indexOf("--out");
  return {
    caseId: caseIdx !== -1 ? args[caseIdx + 1] : undefined,
    system: sysIdx !== -1 ? args[sysIdx + 1] : "agent",
    outDir: outIdx !== -1 ? args[outIdx + 1] : path.join(ROOT, "runs", "rendered"),
  };
}

function block(entry: RunLogEntry): string {
  const json = JSON.stringify(entry.payload, null, 2);
  if (json.length <= 1600) return "```json\n" + json + "\n```";
  return "```json\n" + json.slice(0, 1600) + "\n… [" + (json.length - 1600) + " more chars]\n```";
}

function renderFile(file: string, reportPath: string | null, title: string): string | null {
  if (!fs.existsSync(file)) return null;
  const entries = fs.readFileSync(file, "utf8")
    .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as RunLogEntry);

  const out: string[] = [
    `# Confess trajectory — ${title}`,
    "",
    `Rendered ${new Date().toISOString()} from \`${path.relative(ROOT, file)}\`.`,
    "Every LLM turn, tool call + response, repair, and guardrail rejection, in order.",
    "",
  ];
  let turn = 0;
  for (const e of entries) {
    if (e.kind === "run_start" || e.kind === "stage_start") {
      out.push(`## ${e.kind} — ${e.ts}`, "", "```json", JSON.stringify(e.payload), "```", "");
    } else if (e.kind === "request") {
      turn++;
      const p = e.payload as { turn?: number; nMessages?: number };
      out.push(`## turn ${p.turn ?? turn} — model call`, "", `_${e.usage ? `usage: in ${e.usage.inputTokens} / out ${e.usage.outputTokens} ($${e.usage.costUsd.toFixed(4)})_` : ""}`, "");
    } else if (e.kind === "response") {
      const p = e.payload as { stopReason?: string; content?: unknown; text?: string };
      if (Array.isArray(p.content)) {
        for (const b of p.content as Array<{ type: string; text?: string; name?: string; input?: unknown }>) {
          if (b.type === "text" && b.text) out.push(`**assistant:** ${b.text}`, "");
          if (b.type === "tool_use") {
            out.push(`**→ tool: ${b.name}**`, "", "```json", JSON.stringify(b.input, null, 2).slice(0, 900), "```", "");
          }
        }
      } else if (p.text) {
        out.push(`**assistant (text):**`, "", p.text.slice(0, 1200), "");
      }
      if (e.usage) out.push(`_usage: in ${e.usage.inputTokens} / out ${e.usage.outputTokens} — $${e.usage.costUsd.toFixed(4)}_`, "");
    } else if (e.kind === "tool_result") {
      const p = e.payload as { tool: string; output: string; isError: boolean };
      out.push(
        `**← ${p.tool} ${p.isError ? "(REJECTED)" : "ok"}:**`,
        "",
        "> " + p.output.split("\n").join("\n> ").slice(0, 1400),
        "",
      );
    } else if (e.kind === "repair") {
      out.push(`## ⚠ repair round-trip`, "", block(e), "");
    } else if (e.kind === "error") {
      out.push(`## ⚠ error`, "", block(e), "");
    } else if (e.kind === "run_end" || e.kind === "stage_end") {
      out.push(`## ${e.kind}`, "", "```json", JSON.stringify(e.payload, null, 2).slice(0, 1200), "```", "");
    }
  }
  // Append the final report if present.
  if (reportPath && fs.existsSync(reportPath)) {
    out.push("---", "", fs.readFileSync(reportPath, "utf8"));
  }
  return out.join("\n");
}

function renderCase(caseId: string, system: string): string | null {
  const dir = runDir(system, caseId);
  return renderFile(path.join(dir, "run.jsonl"), path.join(dir, "report.md"), `${caseId} (${system})`);
}

async function main(): Promise<void> {
  const { caseId, system, outDir } = parseArgs();
  await ensureDir(outDir);

  // --file <path>: render any JSONL run log directly (e.g. the dataset generator's
  // dataset/.cache/gen-case_XX.jsonl) — deliverable 04 asks for every agent we used.
  const fileIdx = process.argv.indexOf("--file");
  if (fileIdx !== -1) {
    const src = process.argv[fileIdx + 1];
    const md = renderFile(src, null, `${path.basename(src, ".jsonl")} (dataset generator)`);
    if (!md) {
      console.error(`no such file: ${src}`);
      process.exit(1);
    }
    const base = path.basename(src, ".jsonl");
    const out = path.join(outDir, `${base}-generator.md`);
    await fs.promises.writeFile(out, md, "utf8");
    console.log(`  ${base} → ${path.relative(ROOT, out)} (${md.split("\n").length} lines)`);
    return;
  }

  const ids = caseId ? [caseId] : await listCases();
  let rendered = 0;
  for (const id of ids) {
    const md = renderCase(id, system);
    if (!md) {
      console.log(`  ${id}: no run.jsonl for system "${system}" — skipped`);
      continue;
    }
    const file = path.join(outDir, `${id}-${system}.md`);
    await fs.promises.writeFile(file, md, "utf8");
    rendered++;
    console.log(`  ${id} → ${path.relative(ROOT, file)} (${md.split("\n").length} lines)`);
  }
  console.log(`\nRendered ${rendered} trajectory file(s).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
