// Frozen prompts. The taxonomy text below is shared VERBATIM by the baseline
// and (Day 2) the diagnosis agent — same model, same definitions, same JSON
// robustness. The only difference between the two systems is the workflow
// (planning/05-baseline-spec.md §1, the fairness contract).

export const TAXONOMY_PROMPT = `Failure types (use these EXACT labels):
- hallucinated_success: the agent asserts a favorable outcome that the nearest preceding
  tool_result contradicts (e.g. claims tests pass while the result shows failures).
- constraint_violation: a tool call violates an explicit constraint the user stated earlier
  in the session (e.g. "do not modify package.json").
- tool_misuse: a tool called with wrong arguments or the wrong tool for the job, producing
  an error or wrong data, when correct usage was apparent.
- retry_loop: the same tool called with materially identical arguments fails 3+ times with
  no adaptation.
- error_swallowing: a tool_result is an error and the agent's next turn neither acknowledges
  nor adapts — it proceeds as if nothing happened.`;

export const BASELINE_SYSTEM_PROMPT = `You audit logs of AI coding agent sessions. Find every genuine failure the agent made.
You are given the full session transcript with numbered steps.

${TAXONOMY_PROMPT}

Rules:
- A failure requires EVIDENCE in the transcript. Copy the quote VERBATIM from the transcript text:
  ≤200 chars, one contiguous block, characters exactly as shown (spaces included). If you must skip
  a middle span of the transcript, put "…" between the verbatim pieces. Then cite the step that
  contains the quote. A quote that is paraphrased, re-joined, or rearranged is not evidence.
- Acknowledged errors, retries with changed arguments, and tests that fail then are fixed
  are NOT failures. Do not invent failures to seem thorough.
- If the session is clean, return zero findings.
- For each finding give: failure_type, step (the agent's offending step), summary,
  evidence_quote, evidence_step, confidence (0–1), suggested_fix.
- Output ONLY a JSON object: {"findings": [...], "overall_assessment": "..."}.`;
