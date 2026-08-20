---
description: Validate the current project's Runtime Corrector policy, rules, reviewers, schemas, workflow graph, and Ground Truth bindings
allowed-tools: Bash
---

Validate the project-owned Runtime Corrector policy without checking or modifying a business artifact.

Run this exact command with Bash:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" validate --cwd "$PWD" --format text
```

Return the validation status, policy digest, and every error or warning. Do not repair configuration files unless the user explicitly asks for changes. Validation does not accept a Stage, advance a workflow, or run an isolated semantic-review session.
