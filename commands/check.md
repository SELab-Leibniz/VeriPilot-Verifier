---
description: Check a stage artifact with the current project's Runtime Corrector policy
argument-hint: [artifact-path]
allowed-tools: Bash
---

Check a stage artifact with Runtime Corrector. Use `$ARGUMENTS` as the artifact path; if it is empty, use `ir.md`.

Run the following command with Bash, replacing `<artifact-path>` with the selected relative path:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" check "<artifact-path>" --cwd "$PWD" --format text
```

Return the diagnostics, exact candidate Git Patch count, and explicit diagnostic and diff paths. This manual CLI check does not receive a PostToolUse `session_id`, so it runs deterministic checks and returns any configured reviewer as `agentReview: requested`; it does not create an isolated semantic-review fork. A Patch count of zero means no safe deterministic correction could be derived. Do not automatically apply a Patch; leave that decision to the main Agent after `git apply --check` succeeds.
