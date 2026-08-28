// Crash-safe JSONL run logger. Every request/response/repair/tool interaction is
// appended BEFORE the next call is made — the log IS deliverable 04's raw material.
import fs from "node:fs";
import path from "node:path";

export type RunLogKind =
  | "run_start"
  | "run_end"
  | "stage_start"
  | "stage_end"
  | "request"
  | "response"
  | "repair"
  | "tool_result"
  | "error"
  | "note";

export interface RunLogEntry {
  ts: string; // ISO timestamp
  stage: string; // e.g. "generate", "baseline", "claims", "diagnose"
  kind: RunLogKind;
  payload: unknown;
  usage?: { inputTokens: number; outputTokens: number; costUsd: number };
}

export class RunLog {
  private file: string;

  constructor(file: string) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  async append(stage: string, kind: RunLogKind, payload: unknown, usage?: RunLogEntry["usage"]): Promise<void> {
    const entry: RunLogEntry = { ts: new Date().toISOString(), stage, kind, payload, usage };
    await fs.promises.appendFile(this.file, JSON.stringify(entry) + "\n", "utf8");
  }
}
