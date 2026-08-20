---
description: Materialize the auto-derived Runtime Corrector configuration into an editable project config
allowed-tools: Bash
---

Initialize Runtime Corrector for the current working directory by MATERIALIZING the derived
configuration: init runs the same derivation the zero-config runtime performs (task-material
discovery plus platform fingerprinting) and writes the result as a commented, editable
`config.yaml`.

Run this exact command with Bash:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" init --cwd "$PWD"
```

Do not overwrite an existing `.runtime-corrector` directory. After the command succeeds, report:

- `config.yaml` — the materialized version 2 configuration, listing the detected task materials
  (`dynamicGroundTruth.materialRoots`) and the detected platform
  (`implementationCorrection.platform`, `null` when no marker was found). Explain that the file is
  now the explicit source of truth: editing it overrides derivation, and deleting it returns the
  project to zero-config auto-derivation.
- `config.reference.yaml` — the fully commented version 1 artifact/stage reference for teams that
  later want per-artifact rules and reviews.
- `example.rules.yaml`, `example.reviewer.md`, `README.md` — editable starting points for
  deterministic rules and semantic-review criteria.

Point out that reviewer provider examples in `config.yaml` store environment-variable NAMES only
(`apiKeyEnv`); never write an API key or endpoint secret into configuration. Point to
`examples/ir-planning-selection-prd-contract/` only when the user wants that specific four-stage
workflow.

Use the CLI output and the created project-owned files as the only explanation sources. Do not
inspect the plugin's `scripts/`, `lib/`, or other implementation files. For artifact/stage work,
use `/runtime-corrector:explain <stage>` after a stage is configured and enabled.
