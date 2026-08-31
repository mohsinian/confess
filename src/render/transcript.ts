// Render a dataset case's raw trajectory.jsonl into the readable transcript view
// (the same serialization the baseline prompt and the agent's read_steps tool use).
// Usage: npm run transcript case_12 [--out docs/video]
import fs from "node:fs";
import path from "node:path";
import { ROOT, trajectoryPath } from "../lib/cases.js";
import { serializeTrajectory } from "../lib/serialize.js";
import type { Trajectory } from "../types.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const caseId = args.find((a) => /^case_\d+$/.test(a)) ?? "case_12";
  const outIdx = args.indexOf("--out");
  const outDir = outIdx !== -1 ? path.resolve(args[outIdx + 1]) : path.join(ROOT, "docs", "video");

  const events: Trajectory = (await fs.promises.readFile(trajectoryPath(caseId), "utf8"))
    .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

  // Camera-friendly: shorter result blocks than the pipeline's default
  const text = serializeTrajectory(events, { maxResultChars: 500 });

  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${caseId}-transcript.txt`);
  await fs.promises.writeFile(file, text, "utf8");
  console.log(`${caseId}: ${events.length} steps → ${path.relative(ROOT, file)} (${text.split("\n").length} lines)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
