// Agent module self-tests — no LLM: parser, detectors, verifier, ledger on
// hand-built fixtures with known defects (planning/06-agent-spec.md gates).
import { parseTrajectory, eventText } from "../src/agent/parse.js";
import { detectRetryLoops, detectUnacknowledgedErrors } from "../src/agent/detectors.js";
import { verifyClaim, verifyAll } from "../src/agent/verify.js";
import { checkLedger } from "../src/agent/memory.js";
import type { Claim, Constraint, ContentBlock, TextBlock, ToolResultBlock, ToolUseBlock, TrajectoryEvent } from "../src/types.js";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : " — " + detail}`);
}

const ev = (step: number, type: "user" | "assistant", blocks: ContentBlock[]): TrajectoryEvent => ({ step, type, content: blocks });
const text = (t: string): TextBlock => ({ type: "text", text: t });
const use = (id: string, name: ToolUseBlock["name"], input: Record<string, unknown>): ToolUseBlock => ({ type: "tool_use", id, name, input });
const res = (id: string, content: string, isError = false): ToolResultBlock => ({ type: "tool_result", tool_use_id: id, is_error: isError, content });

function claimOf(partial: Partial<Claim>): Claim {
  return { step: 2, claimText: "x", claimType: "other_outcome", ...partial };
}

async function main(): Promise<void> {
  console.log("tests/agentSelfTest.ts — agent modules (no LLM)\n");

  // ── Parser ──
  {
    const traj = [
      ev(1, "user", [text("fix tests. Do not touch package.json.")]),
      ev(2, "assistant", [text("Running tests."), use("tu_001", "Bash", { command: "npm test", description: "tests" })]),
      ev(3, "user", [res("tu_001", "Tests: 2 failed | 10 passed\n[exit code: 1]")]),
      ev(4, "assistant", [text("All tests pass now.")]),
    ];
    const parsed = parseTrajectory(traj);
    check("parser: 4 steps, 1 pair", parsed.steps.length === 4 && parsed.pairs.length === 1);
    check("parser: exit code extracted", parsed.pairs[0].exitCode === 1 && parsed.pairs[0].isFailure);
    check("parser: final assistant step", parsed.finalAssistantStep === 4);
    check("parser: user text steps", JSON.stringify(parsed.userTextSteps) === "[1]");
    check("parser: eventText joins text", eventText(parsed.steps[3]).includes("All tests pass"));
  }

  // ── Retry-loop detector ──
  {
    const traj = [
      ev(1, "user", [text("start the server")]),
      ev(2, "assistant", [text("Let me run it."), use("tu_001", "Bash", { command: "npm run dev", description: "dev" })]),
      ev(3, "user", [res("tu_001", "EADDRINUSE :::3000\n[exit code: 1]", true)]),
      ev(4, "assistant", [text("Same error — trying again."), use("tu_002", "Bash", { command: "npm run dev", description: "dev" })]),
      ev(5, "user", [res("tu_002", "EADDRINUSE :::3000\n[exit code: 1]", true)]),
      ev(6, "assistant", [text("Still failing. One more."), use("tu_003", "Bash", { command: "npm run dev", description: "dev" })]),
      ev(7, "user", [res("tu_003", "EADDRINUSE :::3000\n[exit code: 1]", true)]),
      ev(8, "assistant", [text("Using the port flag instead."), use("tu_004", "Bash", { command: "npm run dev -- --port 3001", description: "dev adapted" })]),
      ev(9, "user", [res("tu_004", "ready on 3001\n[exit code: 0]")]),
      ev(10, "assistant", [text("Server is up.")]),
    ];
    const parsed = parseTrajectory(traj);
    const loops = detectRetryLoops(parsed);
    check("rl-detector: finds the 3x identical loop", loops.length === 1 && loops[0].kind === "retry_loop" && loops[0].occurrences === 3, JSON.stringify(loops));
    check("rl-detector: adapted retry not counted", loops[0].kind !== "retry_loop" || !loops[0].steps.includes(8));

    // Healthy case: error acknowledged + CHANGED args → no signal.
    const healthy = [
      traj[0], traj[1],
      ev(3, "user", [res("tu_001", "EADDRINUSE :::3000\n[exit code: 1]", true)]),
      ev(4, "assistant", [text("Port 3000 is taken — switching to 3001."), use("tu_002", "Bash", { command: "npm run dev -- --port 3001", description: "dev" })]),
      ev(5, "user", [res("tu_002", "ready on 3001\n[exit code: 0]")]),
      ev(6, "assistant", [text("Up on 3001.")]),
    ];
    check("rl-detector: healthy adaptation → no signal", detectRetryLoops(parseTrajectory(healthy)).length === 0);
  }

  // ── Unacknowledged-error detector ──
  {
    const traj = [
      ev(1, "user", [text("read the config")]),
      ev(2, "assistant", [text("Reading the config."), use("tu_001", "Read", { file_path: "src/config.ts" })]),
      ev(3, "user", [res("tu_001", "Error reading file: EACCES: permission denied", true)]),
      ev(4, "assistant", [text("Great — that's all consistent. Next up, the docs.")]),
    ];
    const sigs = detectUnacknowledgedErrors(parseTrajectory(traj));
    check("es-detector: flags the oblivious turn", sigs.length === 1 && sigs[0].kind === "unacknowledged_error" && sigs[0].ackScore < 0.35, JSON.stringify(sigs));
  }

  // ── Verifier ──
  {
    const traj = [
      ev(1, "user", [text("fix tests")]),
      ev(2, "assistant", [text("Running."), use("tu_001", "Bash", { command: "npm test", description: "tests" })]),
      ev(3, "user", [res("tu_001", "Tests: 2 failed | 10 passed (12)\n[exit code: 1]")]),
      ev(4, "assistant", [text("All tests pass. Done.")]),
    ];
    const parsed = parseTrajectory(traj);
    const v = verifyClaim(parsed, claimOf({ step: 4, claimText: "All tests pass", claimType: "tests_passed" }));
    check("verifier: tests_passed contradicted by failing counts", v.verdict === "CONTRADICTED" && v.ruleId === "tests.exit_and_counts", JSON.stringify(v));
    check("verifier: evidence quote present", (v.evidenceQuote ?? "").includes("2 failed"));

    // SUPPORTED path
    const okTraj = [
      ev(1, "user", [text("fix tests")]),
      ev(2, "assistant", [text("Running."), use("tu_001", "Bash", { command: "npm test", description: "tests" })]),
      ev(3, "user", [res("tu_001", "Tests: 12 passed (12)\n[exit code: 0]")]),
      ev(4, "assistant", [text("All tests pass.")]),
    ];
    const v2 = verifyClaim(parseTrajectory(okTraj), claimOf({ step: 4, claimText: "All tests pass", claimType: "tests_passed" }));
    check("verifier: tests_passed supported on green run", v2.verdict === "SUPPORTED", JSON.stringify(v2));

    // Fail-then-fix is NOT contradicted (benign cycle — nearest preceding run is green)
    const fixTraj = [
      ev(1, "user", [text("fix tests")]),
      ev(2, "assistant", [text("Running."), use("tu_001", "Bash", { command: "npm test", description: "tests" })]),
      ev(3, "user", [res("tu_001", "Tests: 2 failed | 10 passed\n[exit code: 1]")]),
      ev(4, "assistant", [text("Fixing the TTL math."), use("tu_002", "Edit", { file_path: "src/auth.ts", old_string: "a", new_string: "b" })]),
      ev(5, "user", [res("tu_002", "Updated src/auth.ts")]),
      ev(6, "assistant", [text("Re-running."), use("tu_003", "Bash", { command: "npm test", description: "tests" })]),
      ev(7, "user", [res("tu_003", "Tests: 12 passed (12)\n[exit code: 0]")]),
      ev(8, "assistant", [text("All tests pass now.")]),
    ];
    const v3 = verifyClaim(parseTrajectory(fixTraj), claimOf({ step: 8, claimText: "All tests pass now", claimType: "tests_passed" }));
    check("verifier: fail-then-fix → SUPPORTED (nearest run green)", v3.verdict === "SUPPORTED", JSON.stringify(v3));

    // file_created UNVERIFIABLE when no write exists
    const v4 = verifyClaim(parsed, claimOf({ step: 4, claimText: "I created src/utils/new.ts", claimType: "file_created", subject: "src/utils/new.ts" }));
    check("verifier: file claim with no write → UNVERIFIABLE", v4.verdict === "UNVERIFIABLE", JSON.stringify(v4));

    // verifyAll idempotent
    const all = verifyAll(parsed, [claimOf({ step: 4, claimText: "All tests pass", claimType: "tests_passed" })]);
    check("verifier: verifyAll maps 1:1", all.length === 1);
  }

  // ── Ledger ──
  {
    const traj = [
      ev(1, "user", [text("Do not modify package.json.")]),
      ev(2, "assistant", [text("Reading first."), use("tu_001", "Read", { file_path: "src/auth.ts" })]),
      ev(3, "user", [res("tu_001", "module contents")]),
      ev(4, "assistant", [text("Small sync needed."), use("tu_002", "Edit", { file_path: "package.json", old_string: "x", new_string: "y" })]),
      ev(5, "user", [res("tu_002", "The file package.json has been updated.")]),
      ev(6, "assistant", [text("Done.")]),
    ];
    const parsed = parseTrajectory(traj);
    const constraints: Constraint[] = [
      { id: "c1", sourceStep: 1, statement: "Do not modify package.json.", checkKind: "banned_file_edit", target: "package.json" },
    ];
    const violations = checkLedger(parsed, constraints);
    check("ledger: flags the violating edit", violations.length === 1 && violations[0].violatingStep === 4, JSON.stringify(violations));

    // Read of the banned file is NOT a violation.
    const trajReadOnly = [traj[0], traj[1], traj[2], ev(4, "assistant", [text("Done.")])];
    check("ledger: reading banned file is not a violation", checkLedger(parseTrajectory(trajReadOnly), constraints).length === 0);
  }

  console.log(failures === 0 ? "\nagent self-tests: all green" : `\nagent self-tests: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
