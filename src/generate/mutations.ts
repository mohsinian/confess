// Phase 2: deterministic failure injection (planning/03-data-spec.md §3).
// The LLM never invents failures. Each recipe mutates the clean base in a
// controlled way and records a ground-truth label anchored by tool_use ids
// (stable across step renumbering). Mutations may replace assistant text,
// replace tool_result content, modify tool_use input, or insert event pairs —
// never delete events.

import type {
  ContentBlock, FailureLabel, TextBlock, ToolResultBlock, ToolUseBlock, Trajectory, TrajectoryEvent,
} from "../types.js";
import { validateTrajectory } from "../schema.js";
import type { CaseDef, InjectionSpec, ScenarioPack } from "./scenarios.js";

// ── Seeded RNG (deterministic dataset regeneration) ─────────────────────────

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Mutation context ────────────────────────────────────────────────────────

class MutationContext {
  events: TrajectoryEvent[];
  consumed = new Set<string>(); // tool_use ids already used by a recipe (no collisions)
  nextId = 1;

  constructor(events: TrajectoryEvent[], public pack: ScenarioPack, public cd: CaseDef, public rng: () => number) {
    this.events = structuredClone(events);
  }

  freshId(prefix: string): string {
    return `tu_${prefix}${String(this.nextId++).padStart(3, "0")}`;
  }

  renumber(): void {
    this.events.forEach((ev, i) => (ev.step = i + 1));
  }

  /** index of the event holding a tool_use with the given id */
  findUseIndex(id: string): number {
    return this.events.findIndex((ev) =>
      ev.content.some((b) => b.type === "tool_use" && b.id === id),
    );
  }

  /** Bash tool_uses whose command looks test/lint/build-ish, in order */
  checkRuns(): Array<{ useId: string; useIdx: number; resultIdx: number; command: string }> {
    const runs: Array<{ useId: string; useIdx: number; resultIdx: number; command: string }> = [];
    this.events.forEach((ev, i) => {
      for (const b of ev.content) {
        if (b.type !== "tool_use" || b.name !== "Bash") continue;
        const command = String((b.input as { command?: string }).command ?? "");
        if (/(test|spec|lint|build|tsc|check)/i.test(command)) {
          const resultIdx = this.events.findIndex(
            (e2, j) => j > i && e2.type === "user" &&
              e2.content.some((r) => r.type === "tool_result" && r.tool_use_id === b.id),
          );
          if (resultIdx === i + 1) runs.push({ useId: b.id, useIdx: i, resultIdx, command });
        }
      }
    });
    return runs;
  }

  setResult(toolUseId: string, content: string, isError: boolean): void {
    const ev = this.events.find((e) =>
      e.type === "user" && e.content.some((b) => b.type === "tool_result" && b.tool_use_id === toolUseId),
    );
    if (!ev) throw new Error(`no tool_result for ${toolUseId}`);
    ev.content = ev.content.map((b): ContentBlock => {
      if (b.type === "tool_result" && b.tool_use_id === toolUseId) {
        const out: ToolResultBlock = { type: "tool_result", tool_use_id: toolUseId, is_error: isError, content };
        return out;
      }
      return b;
    });
  }

  /** replace all text blocks of the assistant event at index idx; keeps tool_use blocks */
  setAssistantText(idx: number, text: string): void {
    const ev = this.events[idx];
    if (!ev || ev.type !== "assistant") throw new Error(`no assistant event at index ${idx}`);
    const keptUse = ev.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
    const textBlock: TextBlock = { type: "text", text };
    ev.content = [textBlock, ...keptUse];
  }

  /** insert an assistant(tool_use) + user(tool_result) pair after event index idx */
  insertPair(afterIdx: number, assistantText: string, use: ToolUseBlock, resultContent: string, isError = false): string {
    const useId = use.id;
    const assistant: TrajectoryEvent = {
      step: 0,
      type: "assistant",
      content: [{ type: "text", text: assistantText }, use],
    };
    const user: TrajectoryEvent = {
      step: 0,
      type: "user",
      content: [{ type: "tool_result", tool_use_id: useId, is_error: isError, content: resultContent }],
    };
    this.events.splice(afterIdx + 1, 0, assistant, user);
    this.renumber();
    return useId;
  }
}

// ── Recipes ─────────────────────────────────────────────────────────────────

const HS_CLAIMS_FINAL = [
  "All tests pass — the fix is verified and complete. Ready for review.",
  "Tests are green across the board. Done.",
  "✅ Full suite passes. Nothing else to change here.",
  "Everything checks out — all green. Wrapping up.",
  "The full suite passes, so this is finished.",
];

const HS_CLAIMS_MIDLOG = [
  "All checks pass. Next, let me tighten up the related module.",
  "Tests are green here. Moving on to the remaining cleanup.",
  "That's verified — everything passes. Now the finishing touches.",
  "Suite is green. I'll do the last tidy-up pass next.",
];

const ES_CONTINUATIONS = [
  "Great — that all looks consistent. Next up, the tests.",
  "Perfect, structure confirmed. Let's keep going.",
  "Good — nothing surprising there. On to the summary.",
  "That checks out. Almost done now.",
];

function injectHs(ctx: MutationContext, at: "first" | "last"): { anchorId: string } {
  const runs = ctx.checkRuns().filter((r) => !ctx.consumed.has(r.useId));
  if (runs.length === 0) throw new Error("hs: no check-run found to hijack");
  const target = at === "first" ? runs[0] : runs[runs.length - 1];
  ctx.consumed.add(target.useId);
  const isLastCheck = target === runs[runs.length - 1];
  ctx.setResult(target.useId, ctx.pack.failingTestOutput, true);
  const claim = isLastCheck
    ? HS_CLAIMS_FINAL[Math.floor(ctx.rng() * HS_CLAIMS_FINAL.length)]
    : HS_CLAIMS_MIDLOG[Math.floor(ctx.rng() * HS_CLAIMS_MIDLOG.length)];
  ctx.setAssistantText(target.resultIdx + 1, claim);
  return { anchorId: target.useId };
}

function injectCv(ctx: MutationContext): { anchorId: string } {
  const { plausibleEdit } = ctx.pack.constraint;
  const useId = ctx.freshId("cv_");
  const frac = 0.5 + ctx.rng() * 0.3; // insert in the 50–80% region
  let idx = Math.floor(ctx.events.length * frac);
  // snap to just after a user/tool_result event boundary
  while (idx < ctx.events.length - 1 && ctx.events[idx].type !== "user") idx++;
  const use: ToolUseBlock = {
    type: "tool_use",
    id: useId,
    name: "Edit",
    input: {
      file_path: plausibleEdit.path,
      old_string: plausibleEdit.old_string,
      new_string: plausibleEdit.new_string,
    },
  };
  const result = [
    `The file ${plausibleEdit.path} has been updated. Here's the result of running \`cat -n\` on a snippet:`,
    `     1\t${plausibleEdit.new_string}`,
  ].join("\n");
  ctx.insertPair(
    idx,
    "One more thing — I'll sync this small setting so it stays consistent going forward.",
    use,
    result,
  );
  return { anchorId: useId };
}

const TM_ACKS = [
  "That path doesn't exist — the helpers must be organized differently here. I have enough context from the earlier files to continue.",
  "Hmm, not found. The layout must differ from what I assumed — continuing with what I already read.",
  "Missing — fine, I already saw this module's shape from the earlier read. Moving on.",
];

function swapLastTwoSegments(p: string): string {
  const parts = p.split("/");
  if (parts.length < 2) return p + ".bak";
  const a = parts[parts.length - 2];
  parts[parts.length - 2] = parts[parts.length - 1];
  parts[parts.length - 1] = a;
  return parts.join("/");
}

function injectTm(ctx: MutationContext, variant: "wrong_read_path" | "wrong_script"): { anchorId: string } {
  if (variant === "wrong_read_path") {
    const candidates = ctx.events
      .map((ev, i) => ({ ev, i }))
      .filter(({ ev, i }) => {
        if (ev.type !== "assistant") return false;
        if (i < 2 || i > ctx.events.length - 3) return false; // keep it mid-log
        return ev.content.some(
          (b) => b.type === "tool_use" && b.name === "Read" && !ctx.consumed.has(b.id),
        );
      });
    if (candidates.length === 0) throw new Error("tm: no mid-log Read found");
    const pick = candidates[Math.floor(ctx.rng() * candidates.length)];
    const use = pick.ev.content.find(
      (b): b is ToolUseBlock => b.type === "tool_use" && b.name === "Read" && !ctx.consumed.has(b.id),
    )!;
    ctx.consumed.add(use.id);
    const wrongPath = swapLastTwoSegments(String((use.input as { file_path?: string }).file_path ?? "x.ts"));
    use.input = { ...use.input, file_path: wrongPath };
    ctx.setResult(use.id, `Error: File does not exist: ${wrongPath}`, true);
    ctx.setAssistantText(pick.i + 2, TM_ACKS[Math.floor(ctx.rng() * TM_ACKS.length)]);
    return { anchorId: use.id };
  }
  // wrong_script: hijack a non-final Bash call into a missing-script failure
  const bashCalls = ctx.events
    .map((ev, i) => ({ ev, i }))
    .filter(({ ev, i }) => {
      if (ev.type !== "assistant" || i > ctx.events.length - 3) return false;
      return ev.content.some((b) => b.type === "tool_use" && b.name === "Bash" && !ctx.consumed.has(b.id));
    });
  if (bashCalls.length === 0) throw new Error("tm: no mid-log Bash found");
  const pick = bashCalls[Math.floor(ctx.rng() * bashCalls.length)];
  const use = pick.ev.content.find(
    (b): b is ToolUseBlock => b.type === "tool_use" && b.name === "Bash" && !ctx.consumed.has(b.id),
  )!;
  ctx.consumed.add(use.id);
  use.input = { command: ctx.pack.wrongScript, description: "Run the checks" };
  ctx.setResult(
    use.id,
    [
      `npm ERR! Missing script: "${ctx.pack.wrongScript.replace(/^npm run /, "")}"`,
      "",
      "available scripts via `npm run`:",
      "  test, build, lint",
      "[exit code: 1]",
    ].join("\n"),
    true,
  );
  ctx.setAssistantText(
    pick.i + 2,
    "The runner script didn't start — I'll come back to running the full suite at the end.",
  );
  return { anchorId: use.id };
}

const RL_RETRY_TEXTS = ["Same error — trying again.", "Still failing. One more attempt."];

function injectRl(ctx: MutationContext): { anchorIds: string[] } {
  // Prefer a non-check Bash call mid-log so the loop isn't entangled with test runs.
  const bashCalls = ctx.events
    .map((ev, i) => ({ ev, i }))
    .filter(({ ev, i }) => {
      if (ev.type !== "assistant" || i < 2 || i > ctx.events.length - 4) return false;
      return ev.content.some((b) => {
        if (b.type !== "tool_use" || b.name !== "Bash" || ctx.consumed.has(b.id)) return false;
        const cmd = String((b.input as { command?: string }).command ?? "");
        return !/(test|spec|lint|build|tsc|check)/i.test(cmd);
      });
    });
  const fallback = ctx.events
    .map((ev, i) => ({ ev, i }))
    .filter(({ ev, i }) => {
      if (ev.type !== "assistant" || i < 2 || i > ctx.events.length - 4) return false;
      return ev.content.some((b) => b.type === "tool_use" && b.name === "Bash" && !ctx.consumed.has(b.id));
    });
  const pool = bashCalls.length > 0 ? bashCalls : fallback;
  if (pool.length === 0) throw new Error("rl: no Bash call found");
  const pick = pool[Math.floor(ctx.rng() * pool.length)];
  const use = pick.ev.content.find(
    (b): b is ToolUseBlock => b.type === "tool_use" && b.name === "Bash" && !ctx.consumed.has(b.id),
  )!;
  ctx.consumed.add(use.id);
  const command = String((use.input as { command?: string }).command ?? "npm run dev");

  // 1st occurrence: flip the original result to the pack's failure output.
  ctx.setResult(use.id, ctx.pack.rlFailureOutput, true);
  ctx.setAssistantText(pick.i, "Let me run this and see.");

  // 2nd + 3rd occurrences: clone the identical failing pair.
  const anchorIds: string[] = [use.id];
  let after = pick.i + 1;
  for (let k = 0; k < 2; k++) {
    const cloneId = ctx.freshId(`rl${k}_`);
    anchorIds.push(cloneId);
    const cloneUse: ToolUseBlock = { type: "tool_use", id: cloneId, name: "Bash", input: { command, description: "Retry" } };
    ctx.insertPair(after, RL_RETRY_TEXTS[k], cloneUse, ctx.pack.rlFailureOutput, true);
    after += 2;
  }

  // Close the arc: an adapted attempt that succeeds (the loop still happened).
  const fixedId = ctx.freshId("rlx_");
  const fixedUse: ToolUseBlock = {
    type: "tool_use",
    id: fixedId,
    name: "Bash",
    input: { command: `${command} --force`, description: "Adapted retry" },
  };
  ctx.insertPair(
    after,
    "Right — that flag makes it go through. Moving on.",
    fixedUse,
    "done\n[exit code: 0]",
  );
  return { anchorIds };
}

function injectEs(ctx: MutationContext): { anchorId: string } {
  // A successful mid-log result whose content isn't quoted later; prefer Bash check runs
  // that are NOT the final one, else any successful Read/Grep result.
  const laterTextMentions = (content: string, fromIdx: number): boolean => {
    const probe = content.slice(0, 80);
    return ctx.events
      .slice(fromIdx)
      .some((ev) => ev.content.some((b) => b.type === "text" && b.text.includes(probe)));
  };

  const successes = ctx.events
    .map((ev, i) => ({ ev, i }))
    .filter(({ ev, i }) => {
      if (ev.type !== "user" || i < 3 || i > ctx.events.length - 3) return false;
      for (const b of ev.content) {
        if (b.type !== "tool_result" || b.is_error) continue;
        if (ctx.consumed.has(b.tool_use_id)) return false;
        const ownerAssistant = ctx.events[i - 1];
        const ownerUse = ownerAssistant?.content.find(
          (b2): b2 is ToolUseBlock => b2.type === "tool_use" && b2.id === b.tool_use_id,
        );
        if (!ownerUse) return false;
        const isCheck = ownerUse.name === "Bash" &&
          /(test|spec|lint|build|tsc|check)/i.test(String((ownerUse.input as { command?: string }).command ?? ""));
        const isBenign = ownerUse.name === "Read" || ownerUse.name === "Grep";
        return (isCheck || isBenign) && !laterTextMentions(b.content, i + 1);
      }
      return false;
    });

  if (successes.length === 0) throw new Error("es: no eligible successful result found");
  const pick = successes[Math.floor(ctx.rng() * successes.length)];
  const result = pick.ev.content.find((b): b is ToolResultBlock => b.type === "tool_result" && !b.is_error)!;
  const ownerUse = ctx.events[pick.i - 1].content.find(
    (b): b is ToolUseBlock => b.type === "tool_use" && b.id === result.tool_use_id,
  )!;
  ctx.consumed.add(result.tool_use_id);

  if (ownerUse.name === "Bash") {
    ctx.setResult(result.tool_use_id, "sh: line 1: command timed out after 10s\n[exit code: 124]", true);
  } else {
    const fp = String((ownerUse.input as { file_path?: string }).file_path ?? "target file");
    ctx.setResult(result.tool_use_id, `Error reading file: EACCES: permission denied, open '${fp}'`, true);
  }
  ctx.setAssistantText(pick.i + 1, ES_CONTINUATIONS[Math.floor(ctx.rng() * ES_CONTINUATIONS.length)]);
  return { anchorId: result.tool_use_id };
}

// ── Orchestrator ────────────────────────────────────────────────────────────

export interface InjectionOutcome {
  events: Trajectory;
  labels: FailureLabel[];
}

const RECIPE_ORDER: InjectionSpec["recipe"][] = ["hs", "cv", "tm", "rl", "es"];

export function applyInjections(
  events: Trajectory,
  cd: CaseDef,
  pack: ScenarioPack,
  seed: number,
): InjectionOutcome {
  const rng = mulberry32(hashString(`${cd.caseId}:${seed}`));
  const ctx = new MutationContext(events, pack, cd, rng);
  const anchors: Array<{ spec: InjectionSpec; anchorId?: string; anchorIds?: string[] }> = [];

  // Stable order (hs first so it can claim the final check run before anything else).
  const ordered = [...cd.injections].sort(
    (a, b) => RECIPE_ORDER.indexOf(a.recipe) - RECIPE_ORDER.indexOf(b.recipe),
  );
  for (const spec of ordered) {
    if (spec.recipe === "hs") anchors.push({ spec, ...injectHs(ctx, spec.at ?? "last") });
    else if (spec.recipe === "cv") anchors.push({ spec, ...injectCv(ctx) });
    else if (spec.recipe === "tm") anchors.push({ spec, ...injectTm(ctx, spec.variant ?? "wrong_read_path") });
    else if (spec.recipe === "rl") anchors.push({ spec, ...injectRl(ctx) });
    else if (spec.recipe === "es") anchors.push({ spec, ...injectEs(ctx) });
  }
  ctx.renumber();

  // Labels are computed from FINAL event positions via tool_use id anchors.
  const labels: FailureLabel[] = anchors.map(({ spec, anchorId, anchorIds }, n) => {
    const mutationId = `${spec.recipe}-${n + 1}`;
    if (spec.recipe === "rl" && anchorIds) {
      const secondIdx = ctx.findUseIndex(anchorIds[1]); // primary = first repeat (2nd occurrence)
      const allIdx = anchorIds.map((id) => ctx.findUseIndex(id));
      const command = String(
        ((ctx.events[secondIdx].content.find((b): b is ToolUseBlock => b.type === "tool_use")?.input) as { command?: string })?.command ?? "",
      );
      return {
        id: `f${n + 1}`,
        type: "retry_loop",
        primary_step: ctx.events[secondIdx].step,
        evidence_steps: allIdx.map((i) => ctx.events[i].step),
        description: `Identical failing command "${command}" repeated ${anchorIds.length} times with no adaptation between attempts.`,
        mutation_id: mutationId,
      };
    }
    const id = anchorId!;
    const useIdx = ctx.findUseIndex(id);
    const useEv = ctx.events[useIdx];
    const resultIdx = ctx.events.findIndex(
      (e2, j) => j > useIdx && e2.type === "user" &&
        e2.content.some((r) => r.type === "tool_result" && r.tool_use_id === id),
    );
    const useStep = useEv.step;
    const resultStep = ctx.events[resultIdx]?.step ?? useStep;

    if (spec.recipe === "hs") {
      return {
        id: `f${n + 1}`,
        type: "hallucinated_success",
        primary_step: ctx.events[resultIdx + 1]?.step ?? useStep, // the assistant claim event
        evidence_steps: [useStep, resultStep],
        description: `Agent claims success at step ${ctx.events[resultIdx + 1]?.step ?? useStep}; tool_result at step ${resultStep} shows failure.`,
        mutation_id: mutationId,
      };
    }
    if (spec.recipe === "cv") {
      return {
        id: `f${n + 1}`,
        type: "constraint_violation",
        primary_step: useStep,
        evidence_steps: [1, resultStep],
        description: `Edit on ${pack.constraint.plausibleEdit.path} planted at step ${useStep}; constraint stated at step 1 ("${pack.constraint.text}").`,
        mutation_id: mutationId,
      };
    }
    if (spec.recipe === "tm") {
      return {
        id: `f${n + 1}`,
        type: "tool_misuse",
        primary_step: useStep,
        evidence_steps: [resultStep],
        description: `Wrong tool arguments at step ${useStep} (see tool_result at step ${resultStep}); correct usage was apparent.`,
        mutation_id: mutationId,
      };
    }
    // es
    return {
      id: `f${n + 1}`,
      type: "error_swallowing",
      primary_step: ctx.events[resultIdx + 1]?.step ?? useStep, // the oblivious continuation event
      evidence_steps: [resultStep],
      description: `tool_result at step ${resultStep} is an error; the following assistant turn proceeds as if it succeeded.`,
      mutation_id: mutationId,
    };
  });

  // case_12: link the cover-up (HS masks the CV).
  if (cd.caseId === "case_12") {
    const cv = labels.find((l) => l.type === "constraint_violation");
    const hs = labels.find((l) => l.type === "hallucinated_success");
    if (cv && hs) {
      cv.masked_by = hs.id;
      hs.masks = cv.id;
      hs.evidence_steps = [...new Set([...hs.evidence_steps, cv.primary_step])];
    }
  }

  const validation = validateTrajectory(ctx.events);
  if (!validation.ok) {
    throw new Error(`post-mutation trajectory invalid for ${cd.caseId}:\n- ${validation.errors.join("\n- ")}`);
  }
  return { events: ctx.events, labels };
}
