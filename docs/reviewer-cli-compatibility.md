# Reviewer CLI compatibility

Runtime Corrector selects its reviewer protocol at build time. The repository
root is source, not an installable plugin. Build one host from
`plugin-target.json`, or build both release artifacts:

```sh
npm run build:plugin
npm run build:plugins
```

The outputs are `dist/runtime-corrector-claude/` and
`dist/runtime-corrector-codeagent/`. Each contains only its own manifest,
active adapter, plugin-root contract, session arguments, defaults, and
executable resolver.

## Launcher configuration

`reviewerRuntime` chooses an executable; it never chooses the host protocol:

```yaml
reviewerRuntime:
  executable: 'C:/Program Files/CodeAgentCLI/bin/codeagentcli.exe'
  argsPrefix: []
```

The launch plan is the frozen pair `{ executable, argsPrefix }`. Removed legacy
session-protocol configuration produces a migration error. The executable is
not inspected to infer a product.

Resolution priority is:

1. `RUNTIME_CORRECTOR_AGENT_EXECUTABLE`;
2. project `reviewerRuntime.executable`;
3. the active host's dedicated environment variable;
4. the active host's known native installation path;
5. the active host's PATH command.

Claude recognizes `RUNTIME_CORRECTOR_CLAUDE_EXECUTABLE`,
`CLAUDE_CODE_EXECUTABLE`, its known native Windows installations, then
`claude.exe` / `claude`. CodeAgent recognizes
`RUNTIME_CORRECTOR_CODEAGENT_EXECUTABLE`,
`%ProgramFiles%/CodeAgentCLI/bin/codeagentcli.exe`, then
`codeagentcli.exe` / `codeagentcli`.

On Windows, configure a native executable. `.cmd`, `.bat`, and `.ps1`
reviewer shims are rejected. A supported wrapper uses `node.exe` plus an
absolute JavaScript entry in `argsPrefix`. Arguments are literal argv values;
the launcher never invokes a shell.

## Session protocol

Both artifacts keep the common argument surface: `--print`,
`--output-format json`, `--json-schema`, `--effort`,
`--permission-mode`, `--tools`, `--allowedTools`,
`--disallowedTools`, `--strict-mcp-config`, `--plugin-dir`, and optional
`--model`, `--max-budget-usd`, `--fork-session`, and
`--no-session-persistence`.

| Operation | Claude artifact | CodeAgent artifact |
| --- | --- | --- |
| Fresh | no session flag | no session flag |
| Resume | `--resume <id>` | `--sessions <id>` |
| Resume and fork | `--resume <id> --fork-session` | `--sessions <id> --fork-session` |
| Temporary resume | `--resume <id> --no-session-persistence` | `--sessions <id> --no-session-persistence` |

CodeAgent creates and persists a fresh `--print` session without
`--session-id`, returns `session_id` in the JSON result, and resumes it with
`--sessions`. The CodeAgent adapter defensively rejects `--session-id`,
`--resume`, and `--continue` anywhere in the complete invocation.

A fresh CodeAgent result without `session_id` fails with
`REVIEWER_SESSION_ID_MISSING`. A resumed result may omit the ID and reuse its
known input ID; a different returned ID is a protocol error. A fork must return
a non-empty ID different from its parent. If the first envelope is parseable
but its structured output is invalid, format and schema repair resume that
returned session. An unparseable envelope cannot be retried safely as another
fresh session.

## Provider and timeouts

Claude defaults semantic and v2 role reviews to 240 seconds. CodeAgent defaults
both to 900 seconds. Explicit project timeouts override the host default.

```yaml
reviewerRuntime:
  executable: 'C:/Program Files/CodeAgentCLI/bin/codeagentcli.exe'
  argsPrefix: []

limits:
  semanticReviewTimeoutMs: 900000

reviewers:
  defaults:
    session: independent
    timeoutMs: 900000
    provider:
      baseUrl: https://your-gateway.example
      apiKeyEnv: CODEAGENT_REVIEWER_API_KEY
      model: glm-5.3
```

Independent reviewers retain the existing
`ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` injection and provider-model
override because CodeAgent accepts that gateway interface. Parent credentials
are cleared first. Tokens are never added to argv, request files, journals,
logs, or error output.

## Cross-role handoff

GT to Stop, Skill, and artifact review always creates a target handle, lease,
request directory, and journal identity. Compatible ambient roles may resume
the source reviewer session. Compatibility requires the same build host,
executable/prefix, project/task owner, session cwd, parent session, plugin root,
credentials, and host-specific reviewer context. Claude additionally compares
`CLAUDE_CONFIG_DIR`; CodeAgent does not.

`independent` and `detached` start fresh. Compatible handoff resumes the
source role; incompatible handoff forks from the original parent. Format
retry, schema repair, Ground Truth repair, follow-up, and every handoff route
through the same active host adapter.

## Verification

The automated suite uses local fake CLIs to capture argv and environment. It
covers both build artifacts, all seven hooks, fresh/resume/fork behavior,
repair and handoff paths, secret redaction, Windows Git Bash drive paths, and
the SessionEnd watchdog. A live gateway smoke test still requires an installed
CodeAgent executable and disposable credentials.

```sh
npm test
npm run build:plugins
npm run test:artifacts
npm run benchmark:session-end
```
