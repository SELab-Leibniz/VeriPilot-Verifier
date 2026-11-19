# Runtime Corrector

[中文](README.md) · [Documentation](docs/README.md)

## Install and enable in OpenClaw

Download `runtime-corrector-openclaw-1.10.0.tgz` and use the CLI from the OpenClaw installation that will load it. For MatrixAssistant, use its bundled OpenClaw CLI. Supported host and Node versions are listed in the [host guide](docs/openclaw.md).

```sh
openclaw plugins install ./runtime-corrector-openclaw-1.10.0.tgz
```

The stock installer registers the plugin, enables it under the host's plugin policy, and links the host SDK. Restart the Gateway to load it, using the host's controls or `openclaw gateway restart` for a CLI-managed service.

With a working default model configured in OpenClaw, send this in an authenticated administrator chat:

```text
/rc-setup
```

This command grants the required conversation and prompt hooks and the main Agent's `runtime_corrector` tool. If no RC reviewer model is configured, it copies the host's default model; existing RC model and timeout settings are preserved. It accepts no arguments. Follow its reload or restart message before continuing.

Select the intended project in the host and run `/rc-project status`. If it reports `mode: legacy`, bind the project with `/rc-project bind /absolute/path/to/project`. This selects the RC scope and leaves the host working directory unchanged; keep the host tools pointed at that same project. Native project mode follows the host selector and disables RC binding. Then initialize in that Session:

```text
/rc-project init
```

For OpenSpec projects that should review proposal, design, tasks and delta specs together, choose this command instead:

```text
/rc-project init openspec-full-plan
```

Both commands refuse to overwrite an existing `.runtime-corrector/` and leave the project and first-enrollment Session switches off. The full-plan option selects the document topology and its companion rules; other template policies are preserved. It does not enable unconfigured strict coverage or task-readiness checks.

Enable the project and this Session, then check the effective state:

```text
/rc-project on
/rc-session on
/rc-session status
```

`effectiveEnabled: true` confirms that correction is enabled for this Session. If it is false, check `reason` before starting work. See the [project and Session guide](docs/session-control.md) for permissions and existing-project setup.

Runtime Corrector checks artifacts, source-bound requirements and completion evidence while a host agent works. It returns confirmed deviations to that agent and does not apply patches to business files itself. Version 1 provides rules, schemas, workflow edges and isolated semantic review. Opt-in version 2 adds Ground Truth, Skill monitoring and bounded Stop correction.

The default Claude, CodeAgent and OpenClaw / MatrixAssistant Stop paths share one reviewer session for scope selection, item checks and optional file-quality review. It reads original workspace and external files on demand, without copying the repository. Git diffs, host edits, plans, checklists and notes help organize the investigation; original-read receipts, evidence ownership and freshness still govern acceptance. See the [Stop guide](docs/stop-task-review.md).

## Build from source and install other hosts

```sh
npm run build:plugins
claude --plugin-dir ./dist/runtime-corrector-claude
```

Install `dist/runtime-corrector-codeagent` with CodeAgent's plugin installer. For OpenClaw use `openclaw plugins install ./dist/runtime-corrector-openclaw`; MatrixAssistant requires its bundled CLI and the configuration step in the [host guide](docs/openclaw.md).

`npm run build:plugin` builds the default OpenClaw artifact. Select another host with `npm run build:plugin -- --host claude`. The source checkout is not an installable plugin root.

Claude/CodeAgent CLI and hooks require **Node.js >= 18** on Windows, Linux and macOS. Build-time adapters select `.claude-plugin` / `CLAUDE_PLUGIN_ROOT` or `.cac-plugin` / `CODEAGENT3_PLUGIN_ROOT`. Roots are canonicalized and checked before use. OpenClaw supports exactly `2026.7.1-2` and `2026.10.3`, with different Node requirements and continuation limits described in the host guide. All three runtime artifacts use only Node.js builtins and exclude the old Stop workers, TypeBox and their dependency metadata. Installation needs no npm dependency download. Legacy workers remain available only for explicit repository development comparisons.

## CLI initialization and manual checks

Run `/runtime-corrector:init` in the project, or call the OpenClaw `runtime_corrector` tool with `{"command":"init"}` after reliable project selection. OpenClaw automatic mode requires an existing valid project configuration; initialize it with the packaged CLI first if necessary. Initialization preserves existing policies and leaves generic stages disabled. Declare real artifacts and enable the intended stages.

```sh
node <plugin>/scripts/cli.mjs validate --cwd <project> --format json
node <plugin>/scripts/cli.mjs check docs/requirements.md --cwd <project> --format json
```

The CLI performs deterministic checks and returns pending semantic work. Host hooks launch isolated reviews. Copy the [minimal project](examples/simple-project/) or [Stop configuration](examples/stop-metric-switches/.runtime-corrector/config.yaml) for a starting point.

## Example: enable correction for coding, disable it for review

A **project** is a code folder. A **Session** is one conversation. Suppose Session A writes Python quicksort and Session B only reviews the code in the same project.

**Step 1: allow RC in this project.** Initialize the project first. Keep its existing rules and set these fields in `.runtime-corrector/config.yaml`:

```yaml
# Allow correction in this project
enabled: true

# Start newly registered Sessions with correction OFF
sessionDefaults:
  enabled: false
```

Root `enabled` controls the whole project. `sessionDefaults.enabled` only supplies the initial choice for a Session not yet registered; it does not overwrite saved choices. Both fields default to `true` when omitted.

**Step 2: in Session A, send:**

```text
/rc-session on
```

A can now use the project's configured correction features. Individual artifact, Skill and Stop settings still apply.

**Step 3: in Session B, send:**

```text
/rc-session off
```

B keeps working without RC reviewing it. A is unaffected.

**Step 4: check each Session:**

```text
/rc-session status
```

Read these three fields first:

- `requestedEnabled`: the Session's chosen setting.
- `effectiveEnabled`: whether RC is actually allowed now; use this for the UI switch.
- `reason`: why it is OFF. `null` means no blocking reason; `RC_PROJECT_DISABLED` means the project is OFF.

To pause correction for both Sessions, set root `enabled` to `false`. Set it back to `true` to restore A ON and B OFF. File changes are observed at the next message, status query or other checkpoint. Choices persist in `.runtime-corrector/sessions.local.yaml` across restarts.

## Example: add a Session correction button to the host UI

The **host** is MatrixAssistant / OpenClaw. Host developers use these two methods; users can use the commands above.

**Step 1: read the current Session identity from the host.** These values are examples:

```js
const target = {
  sessionKey: "agent:main:coding",
  sessionId: "instance-a",
};
```

- `sessionKey`: which conversation to control.
- `sessionId`: its current instance ID; read it again after a reset.

**Step 2: read the current state.** `gateway` is the host's existing authenticated connection:

```js
const status = await gateway.request("runtime-corrector.session.get", target);
// Display status.effectiveEnabled.
```

**Step 3: save ON when the user chooses ON:**

```js
const saved = await gateway.request("runtime-corrector.session.set", {
  ...target,
  enabled: true,
});
// Display saved.effectiveEnabled and explain any saved.reason.
```

`enabled: true` means ON; use `false` for OFF. Show errors when a call fails instead of treating it as saved. The project master switch is edited in configuration; it has no dedicated RPC method.

The methods are registered in `lib/openclaw/session-control.mjs`, loaded by `lib/openclaw/entry.mjs`. See the [step-by-step guide](docs/session-control.md) for complete responses, field meanings, permissions and manual file-check examples.

Default Stop metrics are M08, M09, M12, M13, M15 and M16. File-quality review is off by default. Session and flow budgets each allow three actual correction starts. ALLOW means the host may stop; it does not certify PASS. Missing evidence, cancellation, expiry and checker failures retain their distinct states.

See [configuration](docs/configuration.md), [interfaces](docs/interfaces.md), [operation and trust boundaries](docs/how-it-works.md), [Stop review](docs/stop-task-review.md), and [quick start](docs/tutorial.md). Native Stop continuation and real-model end-to-end behavior have the limits stated in the host guide; offline tests do not establish model accuracy.

For MatrixAssistant, `until_pass` now schedules independent reviews after each host run ends. A separate RC control page manages pending tasks per session without modifying the native frontend. See [the multi-session design and control page](docs/until-pass-dispatch.md).
