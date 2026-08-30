// Ingest real Claude Code session transcripts (~/.claude/projects/**/*.jsonl)
// into Confess's trajectory format. The mapping is deliberately conservative:
// skip meta lines, keep the main chain only, normalize content-block shapes,
// merge consecutive same-role events, and report (not hide) anything dropped.
import fs from "node:fs";
import { validateTrajectory } from "../schema.js";
import type { ContentBlock, TextBlock, ToolResultBlock, ToolUseBlock, Trajectory, TrajectoryEvent } from "../types.js";

export interface IngestResult {
  events: Trajectory;
  warnings: string[];
  stats: {
    rawLines: number;
    skippedMeta: number;
    skippedSidechain: number;
    skippedBlocks: number; // thinking etc.
    mergedEvents: number;
    truncatedResults: number; // tool results capped at ingestion
    truncatedTexts: number; // text blocks capped at ingestion
  };
}

interface RawLine {
  type?: string;
  isSidechain?: boolean;
  message?: { role?: string; content?: unknown };
}

const META_TYPES = new Set([
  "mode", "permission-mode", "system", "file-history-snapshot", "atis-latch",
  "last-prompt", "ai-title", "attachment", "summary", "todo",
]);

function normalizeBlocks(content: unknown, warnings: string[], stats: IngestResult["stats"]): ContentBlock[] {
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "text", text: content } satisfies TextBlock] : [];
  }
  if (!Array.isArray(content)) return [];
  const blocks: ContentBlock[] = [];
  for (const b of content as Array<Record<string, unknown>>) {
    if (b.type === "text" && typeof b.text === "string" && b.text.length > 0) {
      // Real sessions include pasted documents; cap text blocks so one huge
      // paste can't dominate every downstream prompt.
      const cap = 4000;
      if (b.text.length > cap) stats.truncatedTexts++;
      const text = b.text.length > cap ? b.text.slice(0, cap) + " […truncated at ingestion]" : b.text;
      blocks.push({ type: "text", text });
    } else if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
      blocks.push({
        type: "tool_use",
        id: b.id,
        name: b.name,
        input: (b.input ?? {}) as Record<string, unknown>,
      } satisfies ToolUseBlock);
    } else if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
      const raw = b.content;
      let text: string;
      if (typeof raw === "string") text = raw;
      else if (Array.isArray(raw)) {
        text = (raw as Array<Record<string, unknown>>)
          .map((x) => (x.type === "text" ? String(x.text ?? "") : x.type === "image" ? "[image]" : ""))
          .join("\n");
      } else text = "";
      // Real transcripts contain 30K+ char results (web pages, file dumps).
      // Cap at ingest — the audit reads the same capped text it cites, so
      // verbatim-evidence checks stay consistent.
      const CAP = 2400;
      if (text.length > CAP) {
        stats.truncatedResults++;
        // Preserve the verdict tail: real transcripts end with the exit marker
        // AFTER long preamble, and that marker is what evidence checks key on.
        const tail = /\[exit code: \d+\]\s*$/.exec(text)?.[0];
        text = text.slice(0, CAP) + `\n[… truncated ${text.length - CAP} chars at ingestion]` + (tail ? `\n${tail}` : "");
      }
      const out: ToolResultBlock = {
        type: "tool_result",
        tool_use_id: b.tool_use_id,
        content: text,
      };
      if (b.is_error === true) out.is_error = true;
      blocks.push(out);
    } else {
      stats.skippedBlocks++; // thinking, images-in-assistant, redacted, …
    }
  }
  void warnings;
  return blocks;
}

export function ingestClaudeCode(file: string): IngestResult {
  const warnings: string[] = [];
  const stats = { rawLines: 0, skippedMeta: 0, skippedSidechain: 0, skippedBlocks: 0, mergedEvents: 0, truncatedResults: 0, truncatedTexts: 0 };
  const raw = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim());

  const collected: Array<{ type: "user" | "assistant"; blocks: ContentBlock[] }> = [];
  for (const line of raw) {
    stats.rawLines++;
    let parsed: RawLine;
    try {
      parsed = JSON.parse(line) as RawLine;
    } catch {
      warnings.push(`line ${stats.rawLines}: unparseable JSON — skipped`);
      continue;
    }
    if (parsed.type !== "user" && parsed.type !== "assistant") {
      stats.skippedMeta++;
      continue;
    }
    if (parsed.isSidechain) {
      stats.skippedSidechain++;
      continue;
    }
    const blocks = normalizeBlocks(parsed.message?.content, warnings, stats);
    if (blocks.length === 0) continue;
    const last = collected[collected.length - 1];
    // Real transcripts can contain consecutive same-role messages (interrupted
    // prompts, streaming splits) — merge them so pairing invariants hold.
    if (last && last.type === parsed.type) {
      last.blocks.push(...blocks);
      stats.mergedEvents++;
    } else {
      collected.push({ type: parsed.type, blocks });
    }
  }

  // Trim to invariants: first event user, last event assistant.
  while (collected.length > 0 && collected[0].type !== "user") {
    collected.shift();
    warnings.push("leading assistant event trimmed");
  }
  while (collected.length > 0 && collected[collected.length - 1].type !== "assistant") {
    collected.pop();
    warnings.push("trailing user event trimmed");
  }

  const events: Trajectory = collected.map((e, i) => ({
    step: i + 1,
    type: e.type,
    content: e.blocks,
  } satisfies TrajectoryEvent));

  const validation = validateTrajectory(events);
  if (!validation.ok) warnings.push(...validation.errors.map((e) => `invariant: ${e}`));
  return { events, warnings, stats };
}
