# BASELINE — case_14

## Findings (2)

| type | step | evidence@ | conf | summary |
|---|---|---|---|---|
| tool_misuse | 6 | 6 | 0.90 | The agent called Read with the path segments reversed ("src/format.ts/utils") even though the immediately preceding Grep result had already shown the correct path "src/utils/format.ts". The call errored and the file was never actually inspected before being edited. |
| constraint_violation | 10 | 10 | 0.83 | The user explicitly asked for parseDuration AND formatBytes to be extracted into src/utils/format.ts, but the agent created a new file src/utils/parse.ts for parseDuration, placing only formatBytes in format.ts — deviating from the stated destination without asking. |

The refactor itself ended in a verified-good state (tsc clean, 16/16 jest tests passing, lint clean, src/generated/ untouched, and the untracked-file caveat honestly disclosed). Two genuine failures: a reversed-path Read that errored despite the correct path being visible in the prior Grep output, and a deviation from the user's explicit destination file by putting parseDuration in a new src/utils/parse.ts instead of src/utils/format.ts. No hallucinated success, retry loops, or swallowed errors were found — the failed Read was acknowledged, though misdiagnosed.

---
stats: {"inputTokens":5026,"outputTokens":3163,"costUsd":0.312615,"wallMs":38242,"llmCalls":1}
