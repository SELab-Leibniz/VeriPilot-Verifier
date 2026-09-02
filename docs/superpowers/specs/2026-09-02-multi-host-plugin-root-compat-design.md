# Multi-Host Plugin Root Compatibility Design

## Status

Approved on 2026-09-02 for implementation on `codex/multi-host-plugin-root-compat`.

## Goal

Allow one Runtime Corrector plugin artifact to run when its host exposes either
`CLAUDE_PLUGIN_ROOT` or `CODEAGENT3_PLUGIN_ROOT`, without changing the existing
core-hooks JSON-stdio protocol, business decisions, persistent state, or release
budgets. The same artifact must work on Windows, Linux, and macOS.

## Compatibility boundary

This work adds a host-root adapter above the existing
`claude-plugin-core-hooks-json-stdio` capability floor. It does not select code
by product name or version. A compatible host must still provide:

- the existing `hooks/hooks.json` command-hook structure;
- one complete shell-form `command` string per hook and no required `args`;
- hook input as one JSON object on stdin;
- the existing event-specific JSON output unions on stdout;
- Node.js 18 or newer on `PATH`;
- at least one supported plugin-root environment variable.

If CodeAgent3 uses a different manifest or discovery path, that host receives a
thin generated declaration view from the same canonical hook map. It must not
receive a second runtime implementation.

## Architecture

### 1. Shell-neutral bootstrap

Every declared hook remains one complete command string. Instead of expanding a
root path into the shell command, a fixed ASCII `node -e` bootstrap reads the
two root variables from `process.env`, validates them, resolves the selected
entry with Node path APIs, updates `process.argv[1]`, and imports the entry via
`pathToFileURL`.

The bootstrap must not use POSIX parameter expansion, PowerShell environment
syntax, cmd.exe `%VAR%` syntax, a shell pipeline, `eval`, or a version probe.
The root value therefore never becomes executable shell text. Paths containing
spaces, Unicode, shell metacharacters, backslashes, or UNC prefixes remain data.

### 2. Canonical in-process resolver

`lib/plugin-root.mjs` owns root validation after an entry loads. Its public
interface is:

```js
export async function resolvePluginRoot({
  env = process.env,
  executingModuleUrl,
  explicitRoot = null,
} = {})
```

It returns:

```js
{
  root, // canonical realpath
  source: "module" | "explicit",
  declarations: {
    CLAUDE_PLUGIN_ROOT: string | null,
    CODEAGENT3_PLUGIN_ROOT: string | null,
  },
}
```

Rules:

- blank values count as absent;
- a declared or explicit root must be absolute, exist, and be a directory;
- one declared root is accepted when it matches the executing module root;
- two roots are accepted only when their canonical realpaths are equal;
- two different roots fail with `PLUGIN_ROOT_CONFLICT` before business code;
- a declaration different from the loaded module root fails with
  `PLUGIN_ROOT_EXECUTION_MISMATCH`;
- no declaration is accepted only for explicit library/test injection; hook and
  CLI entrypoints require a host declaration;
- entry paths must remain inside the canonical plugin root;
- the installed artifact identity is checked using the shipped plugin manifest.

The actual executing module root is authoritative. Environment variables are
host declarations, not a late resource-selection mechanism.

### 3. Explicit root propagation

Each executable entry resolves the root once and passes the canonical value to
`loadConfig`, `handleHook`, `handleRuntimeV2Event`, and `runSemanticReview`.
Deep runtime modules keep their existing module-relative defaults for direct
library calls, but no executable path reads a Claude-specific variable again.

Reviewer subprocesses receive the canonical root through `--plugin-dir`.
Existing recursion suppression, credential cleanup, reviewer selection, and
process lifecycle behavior are unchanged. The parent host variables are
preserved rather than copied or renamed.

### 4. Commands and Skills

The seven commands and the two root-dependent Skills use the same fixed Node
bootstrap. They stop depending on `$PWD`; the CLI already defaults to
`process.cwd()`. Their tool contract permits Bash and PowerShell so the same
instructions can execute on Windows without Git Bash. Host-level `$ARGUMENTS`
substitution remains the source of command arguments.

The generated Stage recovery command uses the same host-neutral invocation and
does not expose either host variable in shell syntax.

## Conflict and failure behavior

| State | Result |
|---|---|
| Claude root only | Run from its canonical root |
| CodeAgent3 root only | Run from its canonical root |
| Both roots canonicalize to the same directory | Run once |
| Both roots canonicalize to different directories | Fail before importing the entry |
| Root missing, relative, missing, or not a directory | Fail before business work |
| Declared root differs from executing module | Fail before loading plugin resources |

Bootstrap diagnostics go to stderr and stdout remains empty. Existing hook
fail-soft/fail-closed behavior continues to apply only after the real entry has
loaded; the adapter does not invent a new protocol output.

## Unchanged invariants

- no `PostToolBatch`, Hook `args`, prompt/HTTP/agent Hook, async Hook, or product
  version routing;
- no changes to hook event names, matchers, timeouts, or output unions;
- no changes to Ground Truth authority, task/journal schemas, correction
  barrier, correction budgets, reviewer judgements, or Stop decisions;
- SessionEnd remains bounded, silent, fail-open, and independent of the full
  runtime dependency graph;
- plugin, marketplace, command, and Skill identities remain unchanged.

## Verification

Tests must execute the declared command strings rather than extracting and
directly spawning their target files. Coverage includes:

- Claude-only, CodeAgent3-only, equivalent dual roots, conflicting roots, and
  missing roots;
- symlink-equivalent roots, relative paths, nonexistent paths, and module/root
  mismatch;
- all declared hook processes and the canonical seven event inputs with exact
  output unions;
- spaces, Unicode, shell metacharacters, Windows drive paths, and UNC paths;
- Linux/macOS `sh`, Windows cmd.exe, Windows PowerShell, and Windows Git Bash in
  platform CI;
- command/Skill CLI invocations and generated recovery commands;
- canonical root propagation into v1, runtime-v2, Skill loading, and reviewer
  `--plugin-dir`;
- the full test suite and existing SessionEnd release benchmark.
