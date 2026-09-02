# Multi-Host Plugin Root Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one Runtime Corrector artifact resolve either Claude or CodeAgent3 plugin roots across Windows, Linux, and macOS without changing runtime business semantics.

**Architecture:** A fixed Node `-e` bootstrap locates each declared entry without shell-specific variable expansion. Once loaded, one canonical resolver validates the host declarations against the executing module and every entry explicitly propagates that root to existing services.

**Tech Stack:** Node.js ESM, Node.js built-in `fs/path/url/child_process`, JSON hook declarations, Markdown command and Skill frontmatter, `node:test`.

**Spec:** `docs/superpowers/specs/2026-09-02-multi-host-plugin-root-compat-design.md`

## Global Constraints

- Support Node.js `>=18` and use built-in modules only.
- Keep the existing `claude-plugin-core-hooks-json-stdio` input/output union unchanged.
- Do not add Hook `args`, `PostToolBatch`, async Hooks, product/version probes, or profile routing.
- Do not change Ground Truth, task/journal schemas, correction barriers, budgets, reviewer decisions, or Stop decisions.
- Treat conflicting canonical roots as an error; never silently prioritize a host.
- Keep SessionEnd silent, bounded, fail-open, and dependency-light.
- Use strict RED -> GREEN -> REFACTOR for every production behavior.

---

### Task 1: Canonical plugin-root resolver

**Files:**
- Create: `lib/plugin-root.mjs`
- Create: `test/plugin-root.test.mjs`

**Interfaces:**
- Consumes: `executingModuleUrl`, optional `explicitRoot`, and a supplied environment object.
- Produces: `resolvePluginRoot(options)` and stable `error.code` values for missing, invalid, conflicting, mismatched, escaping, and wrong-identity roots.

- [ ] **Step 1: Write resolver tests before the module exists**

Cover literal expected outcomes for Claude-only, CodeAgent3-only, equal roots,
symlink-equivalent roots, conflict, blank/missing values, relative paths,
non-directories, explicit injection, execution mismatch, and entry escape.

```js
const resolved = await resolvePluginRoot({
  env: { CODEAGENT3_PLUGIN_ROOT: pluginRoot },
  executingModuleUrl: pathToFileURL(path.join(pluginRoot, "scripts", "runtime-event.mjs")),
});
assert.equal(resolved.root, await realpath(pluginRoot));
assert.equal(resolved.declarations.CODEAGENT3_PLUGIN_ROOT, pluginRoot);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test test/plugin-root.test.mjs`

Expected: failure because `lib/plugin-root.mjs` does not exist.

- [ ] **Step 3: Implement the minimal resolver**

Use `fs.promises.realpath/stat/readFile`, `path.isAbsolute/relative/resolve`, and
`fileURLToPath`. Attach a stable `code` to every boundary error and validate the
shipped `.claude-plugin/plugin.json` identity without changing that manifest.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `node --test test/plugin-root.test.mjs`

Expected: all resolver cases pass with stdout/stderr clean.

- [ ] **Step 5: Commit the resolver slice**

```bash
git add lib/plugin-root.mjs test/plugin-root.test.mjs
git commit -m "feat: resolve dual plugin roots safely"
```

### Task 2: Cross-platform hook bootstrap

**Files:**
- Modify: `hooks/hooks.json`
- Modify: `test/plugin-capability-floor.test.mjs`
- Modify: `test/session-end-process.test.mjs`
- Create: `test/plugin-bootstrap-process.test.mjs`

**Interfaces:**
- Consumes: one shell-form command, stdin JSON, and either supported root variable.
- Produces: the same entry process, arguments, exit status, stdout union, and stderr-only bootstrap diagnostics.

- [ ] **Step 1: Add failing process tests for raw declared commands**

Execute the actual hook command through the platform shell with Claude-only and
CodeAgent3-only environments. Add equal/conflicting/missing-root cases and a
plugin path containing spaces and Unicode. Assert exact stdout, exit code, and
that conflicts do not create runtime state.

```js
const completed = await runDeclaredHook({
  command,
  env: { CODEAGENT3_PLUGIN_ROOT: spacedPluginRoot },
  input: canonicalInputs.SessionStart,
});
assert.equal(completed.code, 0);
assert.equal(completed.stdout, "");
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test test/plugin-bootstrap-process.test.mjs test/plugin-capability-floor.test.mjs test/session-end-process.test.mjs`

Expected: CodeAgent3-only declared processes fail to locate their entry and the
old declaration-shape assertions fail.

- [ ] **Step 3: Replace all eight declarations with the fixed Node bootstrap**

The inline code must validate absolute canonical roots before importing a
hard-coded relative entry, set `process.argv[1]` to that entry, use
`pathToFileURL`, write errors only to stderr, and set a nonzero exit code.

- [ ] **Step 4: Update process helpers without bypassing declarations**

Keep direct-entry helpers only for protocol-unit tests. Compatibility tests must
execute the raw command using explicit shell binaries on each available OS and
must skip only shells that do not exist on that OS.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `node --test test/plugin-bootstrap-process.test.mjs test/plugin-capability-floor.test.mjs test/session-end-process.test.mjs`

Expected: both host roots produce the existing exact output unions; conflict
and missing-root cases fail before business side effects.

- [ ] **Step 6: Commit the declaration slice**

```bash
git add hooks/hooks.json test/plugin-bootstrap-process.test.mjs test/plugin-capability-floor.test.mjs test/session-end-process.test.mjs
git commit -m "feat: bootstrap hooks across plugin hosts"
```

### Task 3: Explicit canonical-root propagation

**Files:**
- Modify: `scripts/runtime-event.mjs`
- Modify: `scripts/post-tool-use.mjs`
- Modify: `scripts/evidence-distinctness-guard.mjs`
- Modify: `scripts/benchmark-session-end.mjs`
- Modify: `lib/runtime-corrector.mjs`
- Modify: `test/runtime-corrector.test.mjs`
- Create: `test/plugin-root-propagation.test.mjs`

**Interfaces:**
- Consumes: `resolvePluginRoot({ executingModuleUrl: import.meta.url })` once per executable.
- Produces: one canonical string passed to `handleHook(input, { deferPersistence, pluginRoot })`, `loadConfig`, `handleRuntimeV2Event`, and `runSemanticReview`.

- [ ] **Step 1: Write failing propagation tests**

Use a CodeAgent3-only copied/symlinked plugin fixture with a project policy that
requires plugin defaults and bundled Skill discovery. Capture reviewer arguments
and assert `--plugin-dir` equals the canonical root. Exercise PostToolUse so v1,
v2, Skill, and reviewer consumers share the same root.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test test/plugin-root-propagation.test.mjs test/runtime-corrector.test.mjs`

Expected: current entrypoints pass `undefined` or Claude-only roots in at least
one CodeAgent3-only path.

- [ ] **Step 3: Resolve once and pass the root explicitly**

Add `pluginRoot` to `handleHook` options and pass it through the existing runtime
service option object. Replace executable reads of `process.env.CLAUDE_PLUGIN_ROOT`
with one resolver result. Do not remove module-relative defaults used by direct
library calls.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `node --test test/plugin-root-propagation.test.mjs test/runtime-corrector.test.mjs test/shadow-fail-open.test.mjs`

Expected: canonical root equality throughout, with existing shadow and failure
semantics unchanged.

- [ ] **Step 5: Commit the propagation slice**

```bash
git add scripts/runtime-event.mjs scripts/post-tool-use.mjs scripts/evidence-distinctness-guard.mjs scripts/benchmark-session-end.mjs lib/runtime-corrector.mjs test/plugin-root-propagation.test.mjs test/runtime-corrector.test.mjs
git commit -m "refactor: propagate canonical plugin root"
```

### Task 4: Cross-platform commands, Skills, and recovery guidance

**Files:**
- Modify: `commands/check.md`
- Modify: `commands/explain.md`
- Modify: `commands/help.md`
- Modify: `commands/init.md`
- Modify: `commands/spec.md`
- Modify: `commands/stages.md`
- Modify: `commands/validate.md`
- Modify: `skills/runtime-corrector-init/SKILL.md`
- Modify: `skills/runtime-corrector-control/SKILL.md`
- Modify: `examples/veripilot-guarded-delivery/run-guarded-delivery/SKILL.md`
- Modify: `lib/stage-specification.mjs`
- Modify: `test/plugin-capability-floor.test.mjs`
- Modify: `test/runtime-corrector.test.mjs`

**Interfaces:**
- Consumes: the same Node bootstrap and host-provided command arguments.
- Produces: CLI invocations that need neither a shell-specific root expression nor `$PWD`.

- [ ] **Step 1: Add failing command/Skill execution tests**

Parse every command and root-dependent Skill frontmatter, require scalar
`allowed-tools` covering Bash and PowerShell, extract the fenced invocation, and
execute representative `help`, `validate`, `stages`, `explain`, `spec`, and
`check` commands with each root variable.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test test/plugin-capability-floor.test.mjs test/runtime-corrector.test.mjs`

Expected: Claude-specific path syntax and Bash-only declarations fail the new
behavioral contract.

- [ ] **Step 3: Replace root and cwd shell syntax**

Use the fixed Node bootstrap, permit `Bash, PowerShell`, omit `--cwd` where the
current directory is intended, and retain explicit `--cwd` only for a user-named
target. Preserve command arguments and all user-facing business guidance.

- [ ] **Step 4: Make Stage recovery host-neutral**

Return the slash command as the primary recovery mechanism and a Node-bootstrap
CLI command that contains neither host root variable nor `$PWD`.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `node --test test/plugin-capability-floor.test.mjs test/runtime-corrector.test.mjs`

Expected: declarations parse, representative commands execute with either root,
and existing stage-control behavior stays unchanged.

- [ ] **Step 6: Commit the command/Skill slice**

```bash
git add commands skills examples/veripilot-guarded-delivery/run-guarded-delivery/SKILL.md lib/stage-specification.mjs test/plugin-capability-floor.test.mjs test/runtime-corrector.test.mjs
git commit -m "docs: make plugin commands host neutral"
```

### Task 5: Release gates and documentation

**Files:**
- Modify: `docs/interfaces.md`
- Modify: `docs/PROPOSAL.md`
- Modify: `README.md`
- Modify: `tutorial.html`
- Modify: `test/plugin-capability-floor.test.mjs`

**Interfaces:**
- Consumes: the shipped declarations, manifests, commands, Skills, resolver, and canonical capability fixtures.
- Produces: one documented `dual-host-plugin-root` extension over the unchanged legacy protocol floor.

- [ ] **Step 1: Add the final static and behavioral release assertions**

Assert there is no production version routing, `PostToolBatch`, Hook `args`, or
shell-variable fallback; all manifests and discovery surfaces agree; and every
declared command maps to an expected entry and exact event union.

- [ ] **Step 2: Run the release-focused suite**

Run: `node --test test/plugin-root.test.mjs test/plugin-bootstrap-process.test.mjs test/plugin-root-propagation.test.mjs test/plugin-capability-floor.test.mjs test/session-end-process.test.mjs`

Expected: all focused compatibility tests pass.

- [ ] **Step 3: Update user and interface documentation**

Document both root variables, conflict behavior, Node 18 requirement, supported
OS shells, and the unchanged JSON-stdio capability floor. State that CodeAgent3
must expose the same hook command/stdin/stdout contract or provide its thin
host-specific declaration view.

- [ ] **Step 4: Run full verification**

Run:

```bash
npm test
npm run benchmark:session-end
node --check lib/plugin-root.mjs
node --check scripts/runtime-event.mjs
node --check scripts/post-tool-use.mjs
node --check scripts/evidence-distinctness-guard.mjs
node --check scripts/session-end.mjs
git diff --check 0d5275e..HEAD
git status --short
```

Expected: zero test failures, benchmark within existing p95 limits, syntax exit
zero, no whitespace errors, and only intended files changed.

- [ ] **Step 5: Commit the release slice**

```bash
git add README.md docs tutorial.html test/plugin-capability-floor.test.mjs
git commit -m "docs: define dual-host plugin-root capability"
```

## Self-review

- Spec coverage: Tasks 1-4 implement bootstrap, resolver, propagation, commands,
  Skills, conflict policy, and platform behavior; Task 5 covers publication and
  all release gates.
- Placeholder scan: the plan contains no deferred implementation placeholders;
  CodeAgent3's alternate manifest location is explicitly a host-contract branch,
  not an unfinished code step.
- Type consistency: every consumer uses `resolvePluginRoot()` and a canonical
  string named `pluginRoot`; no task introduces a competing root abstraction.

