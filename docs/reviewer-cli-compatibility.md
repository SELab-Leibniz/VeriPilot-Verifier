# Reviewer CLI configuration and handoff

The plugin uses one project-level CLI launcher, independently of its host's
plugin-root variable. It does not detect product versions, change the hook
capability floor, introduce an HTTP transport, or invoke a shell to launch
reviewers. See [configuration](configuration.md) for validation and precedence.

```yaml
reviewerRuntime:
  executable: 'C:/Program Files/CodeAgentCLI/bin/codeagentcli.exe'
  argsPrefix: []
  sessionDialect: codeagent

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

Omit this block to retain the existing Claude executable resolution. Each v2
role keeps its existing `model`, `effort`, `timeoutMs`, `maxBudgetUsd`, `session`,
and `provider` configuration. Provider URLs and named key variables configure
the selected child CLI; they do not turn the plugin into an HTTP client. The
legacy v1 semantic path keeps its original flags and ambient-provider behavior.
The global Claude defaults remain 240 seconds. The 900-second values above are
an explicit project choice for low-throughput gateways and large fork/ground-
truth reviews; selecting the CodeAgent dialect does not silently change timeouts.

`sessionDialect` is explicit and is never inferred from the executable name.
It defaults to `claude`. The environment form must set the executable and
dialect together:

```text
RUNTIME_CORRECTOR_AGENT_EXECUTABLE=C:/Program Files/CodeAgentCLI/bin/codeagentcli.exe
RUNTIME_CORRECTOR_AGENT_SESSION_DIALECT=codeagent
```

When present, that environment pair replaces the complete configured launcher:
the configured `argsPrefix` and `sessionDialect` are not inherited. A dialect
environment variable without `RUNTIME_CORRECTOR_AGENT_EXECUTABLE` is invalid.

For Windows shell-shim installations, configure a native executable or a known
absolute JavaScript entry using Node, rather than a `.cmd`, `.bat`, or `.ps1`:

```yaml
reviewerRuntime:
  executable: 'C:/Program Files/nodejs/node.exe'
  argsPrefix: ['C:/Tools/CodeAgent/entry.js']
```

Paths are examples, not inferred installation locations. Arguments are literal
argv values. No shell expansion, product adapter, or automatic fallback is used.
The same Node-entry arrangement works on Linux and macOS with their own paths.

## Cross-role sessions

GT→Stop, GT→Skill, and GT→artifact always create a target role handle, lease,
request directory, and invocation journal identity. This does not perform an
extra GT extraction or apply the GT delta again.

| Target effective session mode | CLI session behavior |
| --- | --- |
| `independent` | Fresh session with the target's provider/key/model |
| `detached` | Fresh session using the original ambient environment |
| Compatible ambient `fork` | Resume the source reviewer session, without `--fork-session` |
| Other `fork` | Fork from the original host parent session |

Ambient reuse requires the same executable/prefix/session dialect, project and task owner,
session cwd, original parent session, and plugin root. The source must itself
derive from an ambient parent fork and have a session ID. A missing independent
provider/key retains the existing recorded downgrade to effective `fork`; it
never inherits another role's independent credentials or silently switches to
detached mode. Same-role reminders, schema repair, and follow-up keep their
original handle, provider, launcher, and existing absolute deadline.

The target owns copies of the already-read complete transcript entries, current
GT, metric population, and relevant Skill constraints. Transcript digest/cursor
identify the original snapshot; they are not a checksum of the reserialized
JSON file. Other source and artifact files still follow the existing current
disk-read and candidate-diff validation rules. This is not a workspace snapshot.

Target preparation finishes before source cleanup. The target retains its
inputs through the final repair. Closing a handle is idempotent and prevents
further follow-up; cleanup attempts both request removal and lease release.
Execution environments remain in memory, outside serialized evidence contexts.

## Release verification

Automated tests use real local Node subprocesses, not a model service. They
check actual argv/environment, role/provider transitions, request ownership,
frozen evidence, recursive-hook markers, deadlines, and cleanup. The existing
CI matrix runs on Windows, Linux, and macOS; a local run does not establish that
remote matrix has passed.

```sh
npm test
npm run benchmark:session-end
git diff --check main..HEAD
```

Local verification on macOS with Node v26.0.0 (2026-09-08): 462 tests passed,
zero failed/skipped; 127 Node source files passed syntax checks and 44 JSON
files parsed successfully. SessionEnd's warmed 20-sample groups measured p95
56.16ms taskless (150ms limit) and 56.46ms active-task (300ms limit). These are
local measurements, not Windows/Linux or live CodeAgent results.

## Session dialects

Both launchers retain the common reviewer argument surface: `--print`,
`--output-format json`, `--json-schema`, `--effort`, `--permission-mode`,
`--tools`, `--allowedTools`, `--disallowedTools`, `--strict-mcp-config`,
`--plugin-dir`, and optional `--model`, `--max-budget-usd`, `--fork-session`,
and `--no-session-persistence`.

| Operation | `claude` | `codeagent` |
| --- | --- | --- |
| Fresh session | no session flag | `--session-id <generated-reviewer-uuid>` |
| Resume | `--resume <id>` | `--sessions <id>` |
| Resume and fork | `--resume <id> --fork-session` | `--sessions <id> --fork-session` |
| One-shot resume | append `--no-session-persistence` | append `--no-session-persistence` |

The CodeAgent path rejects an argv containing `--resume` or `--continue` before
spawn. A fresh CodeAgent reviewer has a plugin-generated UUID. If the response
omits its session ID, the known UUID is retained; a different returned ID is a
protocol error. A fork must return its newly created session ID.

## Real CodeAgent acceptance (not replaced by the Node fixture)

The implementation environment did not have `codeagent` on PATH. The user's
successful base command establishes basic CLI operation only. Parent fork,
follow-up, read-only tool enforcement, provider routing, and recursion
suppression still need to pass using CodeAgent's own sessions and installed
plugin, before claiming full runtime support.

In a disposable project configured with `sessionDialect: codeagent`:

1. Install/load this plugin using CodeAgent's supported plugin mechanism. Start
   a CodeAgent session in that project, trigger a configured artifact write and
   Stop assessment, and retain its own parent session ID. Never substitute a
   Claude-created session ID.
2. Reproduce the emitted CLI contract below with that parent session. Capture
   the returned reviewer session ID, then test its follow-up form.
3. Through the actual Hook path, configure two test provider endpoints with
   distinct named environment keys for GT and Stop/artifact. Confirm routing
   at the endpoints and role-specific `REVIEWER_ENVELOPE` journal records.
   Do not put credentials into prompts or request files.
4. Verify Read/Grep work and Write/Edit/Skill/Agent/MCP tools are unavailable to
   the reviewer. Trigger a reviewer-internal hook and confirm it is suppressed
   rather than creating another GT/review cycle. Check the task journal for
   unchanged correction-budget behavior and absence of secrets.

POSIX shell example (replace paths and IDs; these requests may incur model costs):

```sh
codeagent 'Return the structured object {"ok":true}.' \
  --sessions CODEAGENT_PARENT_SESSION_ID --fork-session \
  --print --output-format json \
  --json-schema '{"type":"object","required":["ok"],"properties":{"ok":{"type":"boolean"}}}' \
  --effort low --permission-mode dontAsk \
  --plugin-dir /absolute/path/to/VeriPilot-Verifier \
  --tools Read,Grep --allowedTools Read,Grep --strict-mcp-config \
  --disallowedTools 'Write,Edit,Skill,Agent,mcp__*'
```

For follow-up, replace `--sessions CODEAGENT_PARENT_SESSION_ID --fork-session`
with `--sessions RETURNED_REVIEWER_SESSION_ID --no-session-persistence` while
keeping the other flags. A valid response is a single JSON envelope containing
`session_id` and `structured_output: {"ok":true}`. Role-specific schemas and
optional `--model`/`--max-budget-usd` must also work in the actual Hook run.
Windows should run the equivalent native executable with an argument array,
not copy POSIX quoting into cmd.exe. Full process-tree termination on Windows
is not promised; the existing direct-child fallback is unchanged.
