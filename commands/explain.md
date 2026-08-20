---
description: Explain the active Runtime Corrector policy without reading plugin source code
argument-hint: <stage>
allowed-tools: Bash
---

Explain which project-owned criteria Runtime Corrector will execute for `$ARGUMENTS`.

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" explain "$ARGUMENTS" --cwd "$PWD" --format text
```

Report the matched artifact policy, rules, any JSON Schemas, Agent reviewer, and execution order. Treat the listed project files as the complete authoring contract; do not inspect Runtime Corrector JavaScript implementation files.

`explain` is a short source overview. When exact syntax, every Schema, the full reviewer, or a deadlock recovery map is needed, use `/runtime-corrector:spec <stage>`.
