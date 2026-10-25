# Runtime Corrector

[中文](README.md) · [Documentation](docs/README.md)

Runtime Corrector checks artifacts, source-bound requirements and completion evidence while a host agent works. It returns confirmed deviations to that agent and does not apply patches to business files itself. Version 1 provides rules, schemas, workflow edges and isolated semantic review. Opt-in version 2 adds Ground Truth, Skill monitoring and bounded Stop correction.

## Install

```sh
npm run build:plugins
claude --plugin-dir ./dist/runtime-corrector-claude
```

Install `dist/runtime-corrector-codeagent` with CodeAgent's plugin installer. For OpenClaw use `openclaw plugins install ./dist/runtime-corrector-openclaw`; MatrixAssistant requires its bundled CLI and the configuration step in the [host guide](docs/openclaw.md).

`npm run build:plugin` builds the default OpenClaw artifact. Select another host with `npm run build:plugin -- --host claude`. The source checkout is not an installable plugin root.

Claude/CodeAgent CLI and hooks require **Node.js >= 18** on Windows, Linux and macOS. Build-time adapters select `.claude-plugin` / `CLAUDE_PLUGIN_ROOT` or `.cac-plugin` / `CODEAGENT3_PLUGIN_ROOT`. Roots are canonicalized and checked before use. OpenClaw supports exactly `2026.7.1-2` and `2026.10.3`, with different Node requirements and continuation limits described in the host guide. Its artifact bundles a private TypeBox 1.3.27 loaded through a relative path, with the original license and lockfile. Builds verify the bundled archive's SHA-512; installation needs no dependency download and does not use or modify system or other projects' TypeBox. Claude/CodeAgent basic CLI and hooks need no npm installation.

## Start

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
