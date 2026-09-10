---
description: Materialize the auto-derived Runtime Corrector configuration into an editable project config
allowed-tools: Bash, PowerShell
---

Initialize Runtime Corrector for the current working directory by MATERIALIZING the derived
configuration: init runs the same derivation the zero-config runtime performs (task-material
discovery plus platform fingerprinting) and writes the result as a commented, editable
`config.yaml`.

Run this exact command with the available Bash or PowerShell tool:

```text
node -e "const fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url');const fail=(code,message)=>{throw Object.assign(new Error(code+': '+message),{code})};const inside=(parent,candidate)=>{const relative=path.relative(parent,candidate);return relative===''||(relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative))};const native=value=>process.platform==='win32'&&value[0]==='/'&&/[a-zA-Z]/.test(value[1])&&(value.length===2||value[2]==='/')?value[1]+':'+(value.length===2?path.sep:value.slice(2).replaceAll('/',path.sep)):value;const key='CLAUDE_PLUGIN_ROOT',foreignKey='CODEAGENT3_PLUGIN_ROOT',value=(process.env[key]||'').trim();if(!value){if((process.env[foreignKey]||'').trim())fail('PLUGIN_HOST_MISMATCH',foreignKey+' is set but this artifact requires '+key);fail('PLUGIN_ROOT_MISSING',key)}const declaredPath=native(value);if(!path.isAbsolute(declaredPath))fail('PLUGIN_ROOT_NOT_ABSOLUTE',key);let root;try{root=fs.realpathSync(declaredPath);if(!fs.statSync(root).isDirectory())fail('PLUGIN_ROOT_NOT_DIRECTORY',key)}catch(error){if(error.code&&error.code.startsWith('PLUGIN_ROOT_'))throw error;fail('PLUGIN_ROOT_NOT_DIRECTORY',key)}let manifest;try{manifest=JSON.parse(fs.readFileSync(path.join(root,'.claude-plugin','plugin.json'),'utf8'))}catch(error){fail('PLUGIN_ROOT_IDENTITY_MISMATCH',error.message)}if(manifest?.name!=='runtime-corrector')fail('PLUGIN_ROOT_IDENTITY_MISMATCH','unexpected plugin identity');let entry;try{entry=fs.realpathSync(path.resolve(root,process.argv[1]));if(!fs.statSync(entry).isFile())fail('PLUGIN_ROOT_ENTRY_ESCAPE',process.argv[1])}catch(error){if(error.code&&error.code.startsWith('PLUGIN_ROOT_'))throw error;fail('PLUGIN_ROOT_ENTRY_ESCAPE',process.argv[1])}if(!inside(root,entry))fail('PLUGIN_ROOT_ENTRY_ESCAPE',process.argv[1]);process.argv[1]=entry;import(pathToFileURL(entry).href).catch(error=>{console.error(error);process.exitCode=1})" "scripts/cli.mjs" init
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
