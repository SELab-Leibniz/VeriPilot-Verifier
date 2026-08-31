# Claude Plugin Capability Floor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Runtime Corrector conform to the version-free `claude-plugin-core-hooks-json-stdio` capability floor without changing its business state machine.

**Architecture:** A pure adapter decodes baseline hook input and encodes event-specific output around the existing Runtime Corrector entry points. Static plugin declarations use only the capability floor, while SessionEnd receives a small dedicated process that preserves best-effort lifecycle journaling without loading the full runtime.

**Tech Stack:** Node.js ESM, `node:test`, JSON/YAML plugin metadata, existing zero-dependency Runtime Corrector modules.

**Spec:** `docs/superpowers/specs/2026-08-31-claude-plugin-capability-floor-design.md`

## Global Constraints

- Production code and configuration MUST NOT inspect or branch on a Claude Code version.
- Ground Truth, onboarding, lazy barrier, PostToolUse reconciliation, reviewer, journal, Stop budgets, task schemas, and shadow-mode semantics MUST remain unchanged.
- `PostToolBatch`, prompt hooks, HTTP hooks, agent hooks, and async hooks MUST NOT be introduced.
- Tool events MUST work without `hook_event_id` and continue to prefer `tool_use_id`.
- Unknown input fields MUST be tolerated; only required baseline fields are validated.
- Hook stdout MUST be empty or exactly one event-valid JSON object followed by a newline; diagnostics go to stderr or persisted journals.
- `PowerShell` and `Monitor` remain optional matcher names; correctness MUST NOT depend on either being emitted.
- No persisted state migration is allowed.

---

### Task 1: Preserve CHECKER_ERROR Fail-Closed Semantics

**Files:**
- Create: `test/stop-checker-fail-closed.test.mjs`
- Modify: `lib/runtime-v2/orchestrator.mjs`
- Modify: `lib/messages.mjs`

**Interfaces:**
- Consumes: `calculateMetricReport({ population, metricIds, judgements })`.
- Produces: `stopAssessmentBlocks(report, blockingFindings): boolean` and localized `stop.checkerError` feedback.

- [ ] **Step 1: Add the incident regression tests**

Add literal population fixtures proving that an omitted frozen object yields `CHECKER_ERROR` with no `blockingObjects`, and assert `stopAssessmentBlocks(report, []) === true`. Also assert a fully judged PASS returns false and hard findings still return true.

- [ ] **Step 2: Verify the tests fail for the missing export**

Run: `node --test test/stop-checker-fail-closed.test.mjs`

Expected: FAIL because `stopAssessmentBlocks` is not exported.

- [ ] **Step 3: Add the minimum fail-closed helper and feedback**

Implement:

```js
export function stopAssessmentBlocks(report, blockingFindings) {
  return report.status === "CHECKER_ERROR"
    || report.blockingObjects.length > 0
    || blockingFindings.length > 0;
}
```

Use the helper in Stop assessment and add localized feedback listing at most five `CHECKER_ERROR` objects.

- [ ] **Step 4: Verify the regression and Stop tests**

Run: `node --test test/stop-checker-fail-closed.test.mjs test/runtime-v2.test.mjs test/stop-gate-escape.test.mjs`

Expected: all selected tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/messages.mjs lib/runtime-v2/orchestrator.mjs test/stop-checker-fail-closed.test.mjs
git commit -m "fix: preserve fail-closed stop assessment"
```

### Task 2: Add the Pure Claude Hook Protocol Adapter

**Files:**
- Create: `lib/protocol/claude-core-hooks.mjs`
- Create: `test/claude-core-hooks.test.mjs`

**Interfaces:**
- Produces: `decodeHookInput(raw: string): object`.
- Produces: `encodeHookOutput(eventName: string, input: object, outcome: object): object | null`.
- The decoder removes one leading UTF-8 BOM, parses one JSON object, validates common and event-required fields, returns a shallow copy including unknown fields, and never invents `hook_event_id`.

- [ ] **Step 1: Add table-driven decoder tests**

Use literal baseline inputs for all seven events. Assert BOM input parses, unknown fields survive, missing common fields fail, event-specific required fields fail, and decoded output lacks `hook_event_id` when input lacks it.

- [ ] **Step 2: Add event-output tests**

Assert literal outputs for UserPromptSubmit, PostToolUse, Skill PreToolUse, Stop block, nested Stop verification-unavailable release, and null output for Stop allow and lifecycle events.

- [ ] **Step 3: Verify the adapter tests fail**

Run: `node --test test/claude-core-hooks.test.mjs`

Expected: FAIL because `lib/protocol/claude-core-hooks.mjs` does not exist.

- [ ] **Step 4: Implement the minimum pure adapter**

Use an event-to-required-fields table. Reject arrays, null, blank stdin, multiple/non-JSON payloads, unsupported event names, and wrong required-field types. Do not reject additional properties. Implement the exact output union from the design spec; Skill is the only PreToolUse event that receives the existing `permissionDecision: "allow"` behavior.

- [ ] **Step 5: Verify adapter tests pass**

Run: `node --test test/claude-core-hooks.test.mjs`

Expected: all adapter tests pass.

- [ ] **Step 6: Commit**

```bash
git add lib/protocol/claude-core-hooks.mjs test/claude-core-hooks.test.mjs
git commit -m "feat: add Claude hook capability adapter"
```

### Task 3: Integrate the Adapter and Static Plugin Contract

**Files:**
- Modify: `scripts/runtime-event.mjs`
- Modify: `scripts/post-tool-use.mjs`
- Modify: `hooks/hooks.json`
- Modify: `.claude-plugin/marketplace.json`
- Modify: `commands/check.md`
- Modify: `commands/stages.md`
- Modify: `test/runtime-corrector.test.mjs`
- Modify: `test/shadow-fail-open.test.mjs`
- Create: `test/plugin-capability-floor.test.mjs`

**Interfaces:**
- Consumes: `decodeHookInput` and `encodeHookOutput` from Task 2.
- Produces: effective host commands and process output conforming to the capability-floor fixtures.

- [ ] **Step 1: Add static contract tests**

Parse `hooks/hooks.json` and assert every hook has a non-empty complete `command`, no own `args`, a quoted `${CLAUDE_PLUGIN_ROOT}` script path, no `PostToolBatch`, matcher-free primary PostToolUse reconciliation, and preserved optional `PowerShell|Monitor` matcher names. Parse marketplace and assert marketplace description/version live under `metadata`, while plugin identity and local source remain consistent.

- [ ] **Step 2: Add process-boundary tests**

Spawn the command target derived from the parsed hook declaration with baseline fixtures that omit `hook_event_id`. Assert empty or one-line stdout, valid Stop block/release unions, PostToolUse event-name matching, BOM support, and shadow silence. Replace existing raw `args[0]` assertions with effective-command assertions.

- [ ] **Step 3: Verify the new tests fail for the current declarations/output path**

Run: `node --test test/plugin-capability-floor.test.mjs test/runtime-corrector.test.mjs test/shadow-fail-open.test.mjs`

Expected: FAIL on unsupported `args`, marketplace metadata placement, or protocol integration.

- [ ] **Step 4: Integrate the adapter**

Replace local JSON parsing and `contextOutput`/`eventOutput` duplication in the two entry points with Task 2 functions. Preserve current catches, shadow decisions, persisted warnings, and Stop crash ceiling. Ensure all stdout writes use adapter output and never serialize `null`.

- [ ] **Step 5: Update static metadata**

Change every hook declaration to a single command like `node "${CLAUDE_PLUGIN_ROOT}/scripts/runtime-event.mjs"`; remove all `args`. Move marketplace-only description/version to `metadata`. Quote bracketed `argument-hint` values in `commands/check.md` and `commands/stages.md`.

- [ ] **Step 6: Verify integration tests pass**

Run: `node --test test/claude-core-hooks.test.mjs test/plugin-capability-floor.test.mjs test/runtime-corrector.test.mjs test/shadow-fail-open.test.mjs`

Expected: all selected tests pass.

- [ ] **Step 7: Commit**

```bash
git add scripts/runtime-event.mjs scripts/post-tool-use.mjs hooks/hooks.json .claude-plugin/marketplace.json commands/check.md commands/stages.md test/runtime-corrector.test.mjs test/shadow-fail-open.test.mjs test/plugin-capability-floor.test.mjs
git commit -m "fix: target Claude core hook capability floor"
```

### Task 4: Add a Lightweight SessionEnd Boundary

**Files:**
- Create: `lib/runtime-v2/session-end.mjs`
- Create: `scripts/session-end.mjs`
- Modify: `lib/runtime-v2/orchestrator.mjs`
- Modify: `hooks/hooks.json`
- Create: `test/session-end-process.test.mjs`
- Modify: `test/lazy-correction-barrier.test.mjs`
- Modify: `test/shadow-fail-open.test.mjs`

**Interfaces:**
- Produces: `handleRuntimeV2SessionEnd({ input, projectRoot, env }): Promise<object>` from the focused lifecycle module.
- Consumes: existing internal-run inspection, session-index task lookup, journal append, and deterministic event identity behavior.

- [ ] **Step 1: Add SessionEnd process tests**

Spawn the declared SessionEnd command with taskless and active-task fixtures. Assert exit code zero, empty stdout, no config failure record, no task creation, one lifecycle journal when a task exists, and completion within 1,200 ms. Inject stale cleanup work and verify SessionEnd does not scan it.

- [ ] **Step 2: Verify the process tests fail against the full runtime entry**

Run: `node --test test/session-end-process.test.mjs`

Expected: FAIL because SessionEnd still targets `runtime-event.mjs` or performs cleanup before journaling.

- [ ] **Step 3: Extract the minimum lifecycle handler and entry point**

Move the existing fail-open session-to-task journal behavior into `lib/runtime-v2/session-end.mjs`. Do not load config, reviewer, onboarding, or cleanup modules. Export it through `orchestrator.mjs` only for compatibility with existing imports. Add `scripts/session-end.mjs` to decode input, reject non-SessionEnd events, call the handler, emit no stdout, and exit zero on all failures.

- [ ] **Step 4: Route SessionEnd to the dedicated command**

Change only the SessionEnd hook command to `node "${CLAUDE_PLUGIN_ROOT}/scripts/session-end.mjs"`. Keep cleanup in the existing SessionStart recovery path.

- [ ] **Step 5: Verify lifecycle and process tests pass**

Run: `node --test test/session-end-process.test.mjs test/lazy-correction-barrier.test.mjs test/shadow-fail-open.test.mjs`

Expected: all selected tests pass.

- [ ] **Step 6: Commit**

```bash
git add lib/runtime-v2/session-end.mjs scripts/session-end.mjs lib/runtime-v2/orchestrator.mjs hooks/hooks.json test/session-end-process.test.mjs test/lazy-correction-barrier.test.mjs test/shadow-fail-open.test.mjs
git commit -m "perf: isolate SessionEnd lifecycle handling"
```

### Task 5: Freeze the Version-Free Compatibility Fixture and Documentation

**Files:**
- Create: `test/compat/legacy-feature-baseline/contract.json`
- Create: `test/compat/legacy-feature-baseline/input/*.json`
- Create: `test/compat/legacy-feature-baseline/output/*.json`
- Modify: `test/plugin-capability-floor.test.mjs`
- Modify: `docs/interfaces.md`
- Modify: `README.md`

**Interfaces:**
- Produces: an immutable repository-owned compatibility oracle used only by tests and documentation.

- [ ] **Step 1: Add fixture-consumption tests**

Load `contract.json`, every input fixture, and every output fixture. Assert all declared events have an input fixture, each fixture decodes, each expected output matches the encoder, command and skill discovery equals the declared names, and no contract identifier contains a Claude package version.

- [ ] **Step 2: Verify fixture tests fail because the fixture set is absent**

Run: `node --test test/plugin-capability-floor.test.mjs`

Expected: FAIL with missing `legacy-feature-baseline/contract.json`.

- [ ] **Step 3: Add literal fixtures and user-facing capability documentation**

Declare the seven events, seven commands (`check`, `explain`, `help`, `init`, `spec`, `stages`, `validate`), four skills (`runtime-corrector-control`, `runtime-corrector-init`, `runtime-corrector-workflow`, `semantic-review`), optional tools, and event output forms. Document that compatibility is capability-based, that Monitor/PowerShell are optional, and that no runtime version detection occurs.

- [ ] **Step 4: Verify fixture tests and documentation-adjacent behavior**

Run: `node --test test/plugin-capability-floor.test.mjs test/runtime-corrector.test.mjs`

Expected: all selected tests pass.

- [ ] **Step 5: Commit**

```bash
git add test/compat/legacy-feature-baseline test/plugin-capability-floor.test.mjs docs/interfaces.md README.md
git commit -m "docs: define Claude plugin capability floor"
```

### Task 6: Full Verification and Regression Audit

**Files:**
- Modify only files required by failures proven in this task.

**Interfaces:**
- Consumes: all prior task outputs.
- Produces: fresh verification evidence and a clean compatibility diff.

- [ ] **Step 1: Run focused protocol and Stop verification**

Run:

```bash
node --test \
  test/claude-core-hooks.test.mjs \
  test/plugin-capability-floor.test.mjs \
  test/session-end-process.test.mjs \
  test/stop-checker-fail-closed.test.mjs \
  test/runtime-v2.test.mjs \
  test/stop-gate-escape.test.mjs \
  test/shadow-fail-open.test.mjs
```

Expected: zero failures.

- [ ] **Step 2: Run the complete suite**

Run: `npm test`

Expected: zero failures.

- [ ] **Step 3: Audit forbidden compatibility mechanisms**

Run:

```bash
rg -n 'PostToolBatch|claude\s+--version|claudeVersion|compatMode|"args"' hooks scripts lib test/compat
```

Expected: no production occurrence; historical assertions may only reject forbidden values.

- [ ] **Step 4: Inspect repository state and diff**

Run: `git status --short` and `git diff --check`.

Expected: no unintended or whitespace-error changes.

- [ ] **Step 5: Commit any test-proven corrections**

If Step 1 or 2 exposed a regression, add its failing test first, verify RED, make the minimum correction, verify GREEN, and commit only that correction. If no correction is required, do not create an empty commit.
