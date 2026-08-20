---
description: Show Runtime Corrector commands, natural-language controls, current stages, and editable policy files
allowed-tools: Bash
---

Show the project-aware Runtime Corrector help without inspecting plugin source code.

Run this exact command with Bash:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" help --cwd "$PWD"
```

Return the output directly, then answer any follow-up using only that output and the project-owned `.runtime-corrector/README.md`, `config.yaml`, `*.rules.yaml`, and `*.reviewer.md` files. Do not edit stage switches, criteria, or artifacts unless the user explicitly asks for a change.
