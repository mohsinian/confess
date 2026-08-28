# 00 — Naming & voice: CONFESS

The product is called **Confess**. Not "Trajectory Debugger". "Trajectory debugger" is the *category*
(judges' mental model), Confess is the *name* (what they remember). One line bridges them:
> *Confess — a trajectory debugger with a subpoena.* (or whichever tagline below wins on Day 3)

## Why the name works
- Literal fit: the tool's whole job is making an agent's session log **confess** — every failure it
  outputs is a *confession extracted from evidence the agent itself produced*. The tool never
  speculates; it confronts the log with its own tool_results.
- The hard case (`case_12`) is literally a **cover-up**: a success claim masking a constraint
  violation. The product story writes itself: *"Agents don't just fail — they cover up. Confess finds the cover-up."*
- Memorable in a 5-minute video; the repo/folder is already `confess`.

## Taglines (pick one in the video; use at most two across all docs)
1. **"Every agent tells a story. Confess checks the receipts."**
2. "AI agents claim success. Confess reads the evidence."
3. "Make your agent's session log confess."
4. "The interrogation room for AI coding agents."

## Vocabulary map (brand layer ↔ code layer)
Keep **code identifiers boring and precise** (finding, verdict, ledger, constraint, report) — the
rubric rewards technical soundness. Apply the theme only at the *surface*: README, CLI output,
report headers, video, case nicknames.

| Surface (brand) | Code / docs (precise) |
|---|---|
| "a confession" (casual prose only) | `Finding` / failure finding |
| "the evidence" | `evidence_quote` + `evidence_step` |
| "under interrogation" | per-case audit run |
| "The Cover-Up" (case_12 nickname) | hard multi-hop case |
| "the lineup" / "pending confession" | review queue → **use "Review Queue" in the report itself** (a human reads it; clarity wins) |
| "Confess checks the receipts" | verification stage (claims vs tool_results) |
| CLI banner: `confess v0.1 — interrogating case_12 …` | run header |
| `report.md` header: `CONFESSIONS — case_12 (17 steps)` | findings table title |

SUPPORTED / CONTRADICTED / UNVERIFIABLE already sound like a courtroom — keep them verbatim.

## Voice rules (applies to README, reports, video, changelog)
- Dry, confident, slightly wry. The product is fun; the evidence is dead serious.
- Never cute about uncertainty: a low-confidence finding is *flagged for human review*, full stop —
  the joke never lands on the user's safety.
- One metaphor per artifact. The README gets the cover-up story; the reports stay clean.
- The agent under audit is referred to as "the agent" (never "the suspect") in technical sections;
  "suspect" is allowed exactly once per README, if it earns a smile.
