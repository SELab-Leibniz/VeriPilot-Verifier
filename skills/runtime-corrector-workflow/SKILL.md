---
name: runtime-corrector-workflow
description: Select and consistently reuse Runtime Corrector workflow instance keys before creating or continuing stage artifacts. Use when a project has .runtime-corrector pathTemplates and workflow.correlation, when a user wants to continue an existing change, start a new change, base a new change on historical artifacts, inspect protected workflow paths, or avoid mixing multiple historical changes.
---

# Runtime Corrector Workflow

Choose the workflow instance before writing stage artifacts. Do not create runtime state.

## Workflow

1. Treat the current working directory as the project unless the user names another directory.
2. Read the project-owned `.runtime-corrector/config.yaml` and the workflow prompt named by the user. If no prompt is named, use `workflow.yaml` when present.
3. Read `workflow.correlation.keys` and every artifact `pathTemplates` entry. Explain which output paths are protected.
4. If correlation is absent, state that the project uses legacy bundle mode: every matching file may be reviewed together. Do not imply that Runtime Corrector can distinguish historical changes.
5. When correlation is configured, scan template-matching project files and list the distinct existing instances. Derive keys only from template captures; do not use modification time or directory order.
6. Resolve intent before the first write:
   - For an explicit request to continue an existing change, reuse its exact key.
   - For an explicit request to create a new change, use the user-provided key. If none is provided, generate a short, stable, filename-safe key and tell the user before writing.
   - When historical instances exist and intent is ambiguous, ask whether to continue one of them or create a new instance.
   - For a new change based on history, create a new key. Treat historical artifacts as explicit read-only references, never as same-instance workflow sources.
7. Substitute the selected key into every stage output path. Substitute other placeholders, such as a date, independently; they do not change instance identity unless declared as correlation keys.
8. Before each stage write, verify that all outputs for the current change reuse the same correlation values. Write only the requested stage artifacts.
9. After writing, report the selected instance and created or updated paths.

## Guardrails

- Do not set or expose an active key.
- Do not create session or project state files.
- Do not infer history, select the latest file, rename keys, or automatically inherit an old change.
- Do not batch-check or modify every change.
- Do not migrate configuration automatically.
- Do not treat a historical change as the upstream of a new instance.
- Do not read plugin implementation files or use hidden interfaces. Project config, workflow prompts, `explain`, and `spec` are the public authority.
- Files outside configured templates are not protected by instance correlation.

