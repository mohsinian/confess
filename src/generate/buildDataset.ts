// Dataset builder: clean generation (LLM, cached) + deterministic injection.
// Usage: npm run gen:dataset [-- --seed 42] [-- --case case_01] [-- --fresh]
import fs from "node:fs";
import path from "node:path";
import { loadProviderConfig, makeClient, Budget } from "../lib/anthropic.js";
import { RunLog } from "../lib/runlog.js";
import { CACHE_DIR, caseDir, ensureDir } from "../lib/cases.js";
import { CASES, getCase, gtTotals, packFor } from "./scenarios.js";
import { generateCleanSession } from "./generateClean.js";
import { applyInjections } from "./mutations.js";
import type { CaseMeta, LabelsFile, Trajectory } from "../types.js";
import { labelsFileSchema, caseMetaSchema } from "../schema.js";

function parseArgs(): { seed: number; only?: string; fresh: boolean } {
  const args = process.argv.slice(2);
  const seedIdx = args.indexOf("--seed");
  const caseIdx = args.indexOf("--case");
  return {
    seed: seedIdx !== -1 ? Number(args[seedIdx + 1]) : 42,
    only: caseIdx !== -1 ? args[caseIdx + 1] : undefined,
    fresh: args.includes("--fresh"),
  };
}

function cleanCachePath(caseId: string): string {
  return path.join(CACHE_DIR, `clean-${caseId}.json`);
}

async function loadCachedClean(caseId: string): Promise<Trajectory | null> {
  try {
    const raw = JSON.parse(await fs.promises.readFile(cleanCachePath(caseId), "utf8"));
    return (raw.events ?? null) as Trajectory | null;
  } catch {
    return null;
  }
}

async function main() {
  const { seed, only, fresh } = parseArgs();
  const cfg = loadProviderConfig();
  const client = makeClient(cfg);

  const cases = only ? [getCase(only)] : CASES;
  const summary: Array<{ caseId: string; steps: number; labels: number; repairs: number; cached: boolean }> = [];

  for (const cd of cases) {
    const pack = packFor(cd);
    const budget = new Budget(cfg.maxRunCost);
    const log = new RunLog(path.join(CACHE_DIR, `gen-${cd.caseId}.jsonl`));
    await log.append(cd.caseId, "stage_start", { scenario: pack.id, injections: cd.injections, seed });

    // Phase 1: clean base (cached unless --fresh).
    let clean: Trajectory | null = null;
    let repairs = 0;
    let cached = false;
    if (!fresh) clean = await loadCachedClean(cd.caseId);
    if (clean) {
      cached = true;
      await log.append(cd.caseId, "note", { using: "cached clean base" });
    } else {
      const gen = await generateCleanSession(client, cfg, budget, log, cd, pack);
      clean = gen.events;
      repairs = gen.repairs;
      await ensureDir(CACHE_DIR);
      await fs.promises.writeFile(cleanCachePath(cd.caseId), JSON.stringify({ events: clean, model: gen.model }, null, 2));
    }

    // Phase 2: deterministic injection.
    const { events, labels } = applyInjections(clean, cd, pack, seed);

    // Write the case directory.
    const dir = caseDir(cd.caseId);
    await ensureDir(dir);
    await fs.promises.writeFile(
      path.join(dir, "trajectory.jsonl"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
      "utf8",
    );
    const labelsFile: LabelsFile = {
      case_id: cd.caseId,
      failures: labels,
      clean: labels.length === 0,
      difficulty: cd.difficulty,
    };
    const meta: CaseMeta = {
      case_id: cd.caseId,
      title: cd.title,
      scenario: `${pack.id}: ${pack.title}`,
      seed,
      base_model: cfg.model,
      n_steps: events.length,
      difficulty: cd.difficulty,
      generated_at: new Date().toISOString(),
    };
    // Validate what we write — the eval reads these exact files.
    const lcheck = labelsFileSchema.safeParse(labelsFile);
    const mcheck = caseMetaSchema.safeParse(meta);
    if (!lcheck.success || !mcheck.success) {
      throw new Error(`label/meta schema violation for ${cd.caseId} (this is a generator bug)`);
    }
    await fs.promises.writeFile(path.join(dir, "labels.json"), JSON.stringify(labelsFile, null, 2), "utf8");
    await fs.promises.writeFile(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
    await log.append(cd.caseId, "stage_end", { steps: events.length, labels: labels.length });

    summary.push({ caseId: cd.caseId, steps: events.length, labels: labels.length, repairs, cached });
    console.log(
      `  ${cd.caseId}  ${String(events.length).padStart(2)} steps  ${labels.length} labels  ${labels.map((l) => l.type).join(", ") || "clean"}${cached ? "  (cached base)" : ""}`,
    );
  }

  console.log("\nDataset built. Ground-truth totals:");
  const totals = gtTotals();
  for (const [type, n] of Object.entries(totals)) console.log(`  ${type.padEnd(22)} ${n}`);
  console.log(`  total: ${Object.values(totals).reduce((a, b) => a + b, 0)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
