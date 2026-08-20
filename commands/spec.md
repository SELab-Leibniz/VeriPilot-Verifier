---
description: Get the complete authoritative specification packet for one Runtime Corrector stage
argument-hint: <stage>
allowed-tools: Bash
---

Retrieve the complete stage map before authoring or recovering from repeated failures.

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" spec "$ARGUMENTS" --cwd "$PWD" --format text
```

Treat the output as one atomic specification packet: plugin-global exact format contract, active project artifact mapping, deterministic rules, every referenced JSON Schema, Agent reviewer, and recovery rules. Do not read plugin tests or implementation source to infer missing syntax. When the user is recovering a failed stage, read the complete packet before the next artifact edit and report any genuine contradiction instead of guessing.
