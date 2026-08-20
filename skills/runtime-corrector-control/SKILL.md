---
name: runtime-corrector-control
description: Control Runtime Corrector from natural-language Claude conversation. Use for “帮助/怎么用/校验配置/查看阶段/只开启/启用/关闭/禁用/开关/规则在哪里/审阅标准在哪里/完整规范/规范地图/迷路/死锁/重复失败”, or when a user wants to validate, view, enable, disable, select, understand, or recover a built-in or project-defined correction stage or change project-local correction criteria.
---

# Runtime Corrector Control

Give users one transparent control model in Claude: stage switches select when correction runs, `*.rules.yaml` defines deterministic checks, and `*.reviewer.md` defines Agent semantic review.

## Workflow

1. Treat the current working directory as the target project unless the user explicitly names another directory.
2. For general help, run:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" help --cwd "$PWD"
   ```

   For a policy validation request, run:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" validate --cwd "$PWD" --format json
   ```

   Report every error and warning plus the policy digest. Validation is read-only and does not accept or advance a workflow stage.

3. Before changing stages, read the installed stage state:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" stages --cwd "$PWD" --format json
   ```

   Use this command for status-only requests too. Do not infer active state by reading `config.yaml`; older valid configs may omit `enabledStages`, and the CLI handles that compatibility rule.

4. Resolve stage names only from the `stages` JSON returned in step 3. When an installed project Stage
   uses `ir`, `planning`, `selection`, or `prd-contract`, common aliases such as “PRD”,
   “PRD Contract”, and “需求契约” may map to `prd-contract`. Preserve every other installed name such
   as `app-design` exactly, and never invent an uninstalled Stage.
5. For a requested single-stage change, run exactly one bundled CLI command:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" stage <stage> <on|off> --cwd "$PWD"
   ```

6. For “only enable” requests, compare the requested stages with the JSON status, then turn each installed requested stage on and every other installed stage off. Do not assume only the four built-in stages are installed.
7. After any switch change, run `stages` again and report the complete resulting state. Explain that switching a stage off preserves its criteria files and switching it on restores use of those same files.
8. If the user asks to understand a stage, run the project-aware explanation instead of inspecting plugin implementation:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" explain <stage> --cwd "$PWD"
   ```

   If the user asks for the complete contract, a map, recovery from repeated failures, or exact authoring syntax, run the complete specification packet instead:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" spec <stage> --cwd "$PWD"
   ```

   Read the entire packet before editing. It combines the plugin-global format contract with the current project rules, referenced Schemas, and reviewer.

9. If the user asks to modify a hard rule or Agent review standard, first identify the exact project-owned file from `stages` or `explain`. Read and edit only the requested `*.rules.yaml` or `*.reviewer.md` content, preserve unrelated criteria, and summarize the effective change.

## Guardrails

- Use the plugin-bundled CLI. Do not depend on a global command or system PATH.
- If `.runtime-corrector` is missing, do not invent state or silently initialize. Tell the user to run `/runtime-corrector:init` or ask Claude to initialize Runtime Corrector.
- Never edit generated stage artifacts merely to fulfill a control request.
- Never delete criteria when disabling a stage.
- Never read plugin `scripts/`, `lib/`, or other implementation files to explain behavior. Project-owned policy files and CLI output are the customer-visible authority.
- Never read plugin tests to discover a hidden passing example. Use `spec <stage>`; if it is incomplete or contradictory, report that as a plugin defect.
- Do not claim the plugin automatically edits artifacts or applies patches. It diagnoses, provides review context, and lets the main Agent decide the minimum correction.

## Example requests

- `Runtime Corrector 怎么用？`
- `只开启 Selection 和 PRD Contract 纠偏。`
- `先关闭 Planning，其他阶段不动。`
- `查看当前启用了哪些阶段。`
- `Selection 的硬规则和 Agent 审阅标准在哪里？`
- `Selection 连续失败了，给我完整规范地图。`
- `把 PRD reviewer 的范围扩张判定改得更严格。`
