---
description: Show or change which Runtime Corrector stages are enabled
argument-hint: [<stage> <on|off>]
allowed-tools: Bash
---

Give the user a simple, transparent stage control view.

If `$ARGUMENTS` is empty, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" stages --cwd "$PWD"
```

If `$ARGUMENTS` contains a stage and `on` or `off`, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" stage $ARGUMENTS --cwd "$PWD"
```

Report the resulting on/off state and the corresponding editable `*.rules.yaml` and `*.reviewer.md` files. Do not edit artifact files or any criteria beyond the requested stage switch.

Stage names come only from the project's installed `artifacts[]`; `app-design`, `planning`, and every
other configured Stage use the same command and safety boundary.

For multi-stage natural-language requests such as “only enable Selection and PRD Contract”, use the `runtime-corrector-control` Skill so it can read current state and apply the minimal set of stage changes.
