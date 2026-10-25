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

Claude/CodeAgent CLI and hooks require **Node.js >= 18** on Windows, Linux and macOS. Build-time adapters select `.claude-plugin` / `CLAUDE_PLUGIN_ROOT` or `.cac-plugin` / `CODEAGENT3_PLUGIN_ROOT`. Roots are canonicalized and checked before use. OpenClaw supports exactly `2026.7.1-2` and `2026.10.3`, with different Node requirements and continuation limits described in the host guide. Its native review worker uses pinned `typebox`; artifacts include matching dependency locks. Claude/CodeAgent basic CLI and hooks need no npm installation.

## Start

Run `/runtime-corrector:init` in the project, or call the OpenClaw `runtime_corrector` tool with `{"command":"init"}` after reliable project selection. OpenClaw automatic mode requires an existing valid project configuration; initialize it with the packaged CLI first if necessary. Initialization preserves existing policies and leaves generic stages disabled. Declare real artifacts and enable the intended stages.

```sh
node <plugin>/scripts/cli.mjs validate --cwd <project> --format json
node <plugin>/scripts/cli.mjs check docs/requirements.md --cwd <project> --format json
```

The CLI performs deterministic checks and returns pending semantic work. Host hooks launch isolated reviews. Copy the [minimal project](examples/simple-project/) or [Stop configuration](examples/stop-metric-switches/.runtime-corrector/config.yaml) for a starting point.

Default Stop metrics are M08, M09, M12, M13, M15 and M16. File-quality review is off by default. Session and flow budgets each allow three actual correction starts. ALLOW means the host may stop; it does not certify PASS. Missing evidence, cancellation, expiry and checker failures retain their distinct states.

See [configuration](docs/configuration.md), [interfaces](docs/interfaces.md), [operation and trust boundaries](docs/how-it-works.md), [Stop review](docs/stop-task-review.md), and [quick start](docs/tutorial.md). Native Stop continuation and real-model end-to-end behavior have the limits stated in the host guide; offline tests do not establish model accuracy.
