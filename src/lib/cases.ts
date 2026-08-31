// Canonical paths for dataset / runs / eval artifacts. All file IO goes through here.
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const DATASET_DIR = path.join(ROOT, "dataset", "cases");
export const CACHE_DIR = path.join(ROOT, "dataset", ".cache");
export const RUNS_DIR = path.join(ROOT, "runs");
export const EVAL_DIR = path.join(ROOT, "eval");

export function caseDir(caseId: string): string {
  return path.join(DATASET_DIR, caseId);
}

export function trajectoryPath(caseId: string): string {
  return path.join(caseDir(caseId), "trajectory.jsonl");
}

export function labelsPath(caseId: string): string {
  return path.join(caseDir(caseId), "labels.json");
}


export function runDir(system: string, caseId: string): string {
  return path.join(RUNS_DIR, system, caseId);
}

export async function listCases(): Promise<string[]> {
  if (!fs.existsSync(DATASET_DIR)) return [];
  const entries = await fs.promises.readdir(DATASET_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && /^case_\d+$/.test(e.name))
    .map((e) => e.name)
    .sort();
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true });
}
