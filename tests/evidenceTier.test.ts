// Focused regression tests for the evidence-integrity classifier (audit round 2):
// ok / mis-cited / fabricated tiers, ellipsis abridgement, missing steps,
// text beyond serializer caps, per-system result caps.
import { evidenceTier, stepText } from "../src/eval/score.js";
import type { Finding } from "../src/types.js";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : " — " + detail}`);
}

// Synthetic log matching the serializer's canonical view: tool_use rendered as
// "  → tool_use id name {json}", results as "  ← tool_result for id FLAG\ncontent".
const events = [
  {
    step: 1, type: "user",
    content: [{ type: "text", text: "Fix the tests. Do not modify package.json." }],
  },
  {
    step: 2, type: "assistant",
    content: [{ type: "text", text: "Running the suite." }, { type: "tool_use", id: "tu_001", name: "Bash", input: { command: "npm test", description: "tests" } }],
  },
  {
    step: 3, type: "user",
    content: [{ type: "tool_result", tool_use_id: "tu_001", content: "Tests: 2 failed | 10 passed\n[exit code: 1]", is_error: false }],
  },
  {
    step: 4, type: "assistant",
    content: [{ type: "text", text: "All tests pass. Done." }],
  },
  // step 6: a 3,000-char result whose exit marker sits at the END (tail)
  {
    step: 5, type: "assistant",
    content: [{ type: "text", text: "Fetching the report." }, { type: "tool_use", id: "tu_002", name: "WebFetch", input: { url: "https://example.com/report" } }],
  },
  {
    step: 6, type: "user",
    content: [{ type: "tool_result", tool_use_id: "tu_002", content: "preamble ".repeat(380) + "…final verdict…\n[exit code: 0]" }],
  },
  {
    step: 7, type: "assistant",
    content: [{ type: "text", text: "Report fetched and consistent." }],
  },
];

function findingOf(partial: Partial<Finding>): Finding {
  return {
    failure_type: "hallucinated_success", step: 4, summary: "s",
    evidence_quote: "q", evidence_step: 3, confidence: 0.9,
    needs_human_review: false, suggested_fix: "f",
    ...partial,
  };
}

async function main(): Promise<void> {
  console.log("tests/evidenceTier.test.ts — evidence-integrity classifier\n");

  // 1. Correctly cited
  check(
    "ok: verbatim quote from the cited step",
    evidenceTier(findingOf({ step: 4, evidence_step: 3, evidence_quote: "Tests: 2 failed | 10 passed [exit code: 1]" }), events as never, undefined) === "ok",
  );

  // 2. Ellipsis-abridged quote (segments both real, in the cited step)
  check(
    "ok: ellipsis-abridged quote with all segments in the cited step",
    evidenceTier(findingOf({ step: 4, evidence_step: 3, evidence_quote: "Tests: 2 failed … [exit code: 1]" }), events as never, undefined) === "ok",
  );

  // 3. Fabricated: segments exist nowhere
  check(
    "fabricated: quote exists nowhere in the log",
    evidenceTier(findingOf({ step: 4, evidence_step: 3, evidence_quote: "AssertionError: expected 401, received 200 exactly" }), events as never, undefined) === "fabricated",
  );

  // 4. Mis-cited: real text, wrong cited step
  check(
    "mis-cited: real quote cited against a step that doesn't contain it",
    evidenceTier(findingOf({ step: 4, evidence_step: 4, evidence_quote: "Tests: 2 failed | 10 passed" }), events as never, undefined) === "mis-cited",
  );

  // 5. Missing cited / offending steps
  check(
    "fabricated: cited step does not exist",
    evidenceTier(findingOf({ step: 4, evidence_step: 99, evidence_quote: "Tests: 2 failed" }), events as never, undefined) === "fabricated",
  );
  check(
    "fabricated: offending step does not exist",
    evidenceTier(findingOf({ step: 99, evidence_step: 3, evidence_quote: "Tests: 2 failed" }), events as never, undefined) === "fabricated",
  );

  // 6. Text beyond the serializer cap: with a 1200-char cap, the tail exit marker
  //    is preserved by the tail rule, so a tail-only quote still validates.
  const tailQuote = "[exit code: 0]";
  check(
    "ok: exit marker survives result capping via tail preservation",
    evidenceTier(findingOf({ step: 7, evidence_step: 6, evidence_quote: tailQuote }), events as never, 1200) === "ok",
  );
  // A quote from the MIDDLE of a capped result is beyond the visible window → mis-cited.
  const midText = "final verdict";
  check(
    "ok under agent view (uncapped): mid-result quote is visible",
    evidenceTier(findingOf({ step: 7, evidence_step: 6, evidence_quote: midText }), events as never, undefined) === "ok",
  );

  // 7. Degenerate quotes
  check(
    "fabricated: nothing checkable (quote shorter than segment minimum)",
    evidenceTier(findingOf({ step: 4, evidence_step: 3, evidence_quote: "… … …" }), events as never, undefined) === "fabricated",
  );

  // 8. stepText reproduces the serializer's arrow decorations (the canonical view)
  const st = stepText(events as never, 3, undefined) ?? "";
  check(
    "stepText includes serializer arrow decoration",
    st.includes("← tool_result for tu_001") && st.includes("[exit 1]"),
    st.slice(0, 80),
  );

  // 9. Baseline-cap view: uncapped text beyond 1200 chars must NOT validate for a
  //    baseline-system finding, even though it exists in the full log.
  const midCapQuote = "final verdict";
  check(
    "mis-cited under baseline cap: quote from beyond the 1200-char view",
    evidenceTier(findingOf({ step: 7, evidence_step: 6, evidence_quote: midCapQuote }), events as never, 1200) === "mis-cited",
  );

  console.log(failures === 0 ? "\nevidence-tier tests: all green" : `\nevidence-tier tests: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
