# Claude Plugin Core Hooks JSON-stdio Capability Floor

## Goal

Make Runtime Corrector run on the legacy Claude plugin capability floor represented by the restored upstream mirror, while preserving the current Ground Truth, onboarding, lazy correction barrier, PostToolUse reconciliation, reviewer, journal, and Stop-gate semantics.

The production implementation must depend on capabilities, never on a Claude Code package version. Package versions may appear only in reproducible test-run metadata.

## Capability contract

The immutable contract name is `claude-plugin-core-hooks-json-stdio`.

Required capabilities:

- command hooks are declared with one complete shell `command` string;
- hook input is one JSON object on stdin, optionally prefixed by a UTF-8 BOM;
- hook output is either empty stdout or exactly one JSON object followed by a newline;
- the plugin uses `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `PreCompact`, and `SessionEnd`;
- tool events provide `tool_use_id`; no event requires `hook_event_id`;
- Stop blocking uses top-level `decision` and `reason`;
- Stop infrastructure release uses top-level `continue` and `systemMessage`;
- marketplace description and version metadata use the supported metadata envelope;
- `${CLAUDE_PLUGIN_ROOT}` is expanded by the host inside the command string;
- SessionEnd is short-budget, silent, and best-effort.

Optional capabilities:

- `PowerShell` and `Monitor` tool events may exist and remain in the matcher;
- their absence must not affect installation, correctness, or baseline tests.

Ignored extensions:

- unknown input fields are tolerated and must not alter business decisions;
- no future event is routed into an existing Verifier event automatically.

## Architecture

Introduce a pure protocol boundary at `lib/protocol/claude-core-hooks.mjs`:

```text
host stdin JSON
  -> decodeHookInput(raw)
  -> existing Runtime Corrector code
  -> encodeHookOutput(eventName, outcome)
  -> empty stdout or one JSON line
```

The adapter validates the minimum event fields, removes no supported values, ignores additional fields, and never reads project state. It does not own retries, persistence, Stop budgets, task selection, or reviewer decisions.

Tool deliveries continue to use `tool_use_id`. Lifecycle events retain the current deterministic event-id fallback. The adapter does not fabricate `hook_event_id`, add a random UUID, or add a new delivery ledger.

## Event output mapping

| Event/result | Output |
|---|---|
| no developer feedback | empty stdout |
| UserPromptSubmit feedback | matching `hookSpecificOutput.additionalContext` |
| PostToolUse feedback | matching `hookSpecificOutput.additionalContext` |
| Skill PreToolUse | existing `permissionDecision: "allow"`, with optional context |
| Stop block | `{ "decision": "block", "reason": "..." }` |
| Stop normal allow | empty stdout |
| Stop unverified release | `{ "continue": true, "systemMessage": "..." }` |
| SessionStart, PreCompact, SessionEnd | empty stdout |

Stop release detection must recognize the nested runtime outcome at `outcome.stop.verificationUnavailable` as well as the outer crash path.

## Static plugin metadata

Every command hook uses a single quoted command string, for example:

```json
{
  "type": "command",
  "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/runtime-event.mjs\""
}
```

`args` is forbidden. `PostToolBatch`, prompt hooks, HTTP hooks, agent hooks, and async hooks are forbidden. PostToolUse remains matcher-free for reconciliation, with the existing artifact guard matcher preserved.

Marketplace-only description and version values move into the supported `metadata` envelope. The plugin manifest keeps its normal plugin metadata. Command `argument-hint` values that contain brackets are quoted YAML scalars.

## SessionEnd

SessionEnd gets a dedicated lightweight entry point. It must not load configuration, reviewers, onboarding, or the complete event orchestrator. It performs only internal-run exclusion, O(1) session-to-task lookup, and best-effort lifecycle journaling. Cleanup already performed by SessionStart remains the recovery path. SessionEnd always exits zero and emits no stdout.

Targets:

- no task: p95 at or below 150 ms;
- active task: p95 at or below 300 ms;
- hard process deadline below 1,200 ms.

These are release targets, not user-configurable behavior.

## Business invariants

The compatibility work must not change:

- Ground Truth authority, versioning, or freeze rules;
- onboarding trigger conditions or panel decisions;
- correction-barrier tool coverage;
- PostToolUse reconciliation and watcher locking;
- reviewer selection, prompts, or timeouts;
- Stop fail-closed policy, correction budget, infrastructure-failure ceiling, or user escape hatch;
- task, session-index, Ground Truth, or journal schemas;
- shadow-mode visibility semantics.

The existing main-branch `CHECKER_ERROR` fail-closed fix is a prerequisite because omitting it would weaken the current Stop invariant independently of protocol compatibility.

## Verification contract

Tests own a version-free `legacy-feature-baseline` fixture set extracted from the upstream capability evidence. Production code must not import the mirror or its package.

Release requires:

- strict parsing of hook configuration with no `args` and correct effective script paths;
- official-shape input fixtures without `hook_event_id`;
- event-specific output-union validation;
- process-level stdin/stdout/exit tests;
- Stop clean, blocking, bounded unverified release, outer crash, and `CHECKER_ERROR` coverage;
- command and skill discovery/frontmatter coverage;
- SessionEnd silence and deadline coverage;
- full existing test-suite success;
- no runtime version detection, multi-profile routing, or `PostToolBatch`.

## Rollback

No persisted schema changes are allowed. Rollback replaces the plugin artifact with the last artifact that passed the same capability-floor tests; no task, journal, or Ground Truth migration is required.
