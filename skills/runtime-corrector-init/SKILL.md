---
name: runtime-corrector-init
description: Materialize the auto-derived Runtime Corrector configuration into an editable project config.yaml, together with a v1 artifact reference template, an example deterministic rule file, and example Agent review criteria. Use when a user asks to initialize, set up, install, or create Runtime Corrector project rules; mentions runtime-corrector init; or reports that .runtime-corrector is missing.
allowed-tools: Bash, PowerShell
---

# Runtime Corrector Init

Materialize the configuration the zero-config runtime would derive for this project, so the
detected task materials and platform become visible, reviewable, and editable — without requiring
a globally installed `runtime-corrector` command.

## Workflow

1. Treat the current working directory as the target project unless the user explicitly names another project directory.
2. Check whether `<target>/.runtime-corrector` already exists.
3. If it exists, stop without changing it. Report that Runtime Corrector will not overwrite user-owned rules and identify the existing files.
4. If it does not exist, run the plugin-bundled CLI with the available Bash or PowerShell tool:

   ```text
   node -e "const fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url');const fail=(code,message)=>{throw Object.assign(new Error(code+': '+message),{code})};const declared=['CLAUDE_PLUGIN_ROOT','CODEAGENT3_PLUGIN_ROOT'].map(key=>[key,(process.env[key]||'').trim()]).filter(([,value])=>value);if(!declared.length)fail('PLUGIN_ROOT_MISSING','no supported plugin root is set');const roots=declared.map(([key,value])=>{if(!path.isAbsolute(value))fail('PLUGIN_ROOT_NOT_ABSOLUTE',key);try{const root=fs.realpathSync(value);if(!fs.statSync(root).isDirectory())fail('PLUGIN_ROOT_NOT_DIRECTORY',key);return[key,root]}catch(error){if(error.code&&error.code.startsWith('PLUGIN_ROOT_'))throw error;fail('PLUGIN_ROOT_NOT_DIRECTORY',key)}});if(new Set(roots.map(([,root])=>root)).size!==1)fail('PLUGIN_ROOT_CONFLICT',roots.map(([key,root])=>key+'='+root).join(','));const root=roots[0][1],entry=path.resolve(root,process.argv[1]),relative=path.relative(root,entry);if(relative.startsWith('..')||path.isAbsolute(relative))fail('PLUGIN_ROOT_ENTRY_ESCAPE',process.argv[1]);process.argv[1]=entry;import(pathToFileURL(entry).href).catch(error=>{console.error(error);process.exitCode=1})" "scripts/cli.mjs" init
   ```

   When the user explicitly names another target, append `--cwd "<absolute-target>"`.
5. Verify that these files now exist:

   ```text
   .runtime-corrector/
   |-- README.md
   |-- config.yaml
   |-- config.reference.yaml
   |-- example.rules.yaml
   `-- example.reviewer.md
   ```

6. Report what each file controls:
   - `config.yaml`: the MATERIALIZED version 2 configuration — the same derivation the plugin
     performs with no config at all, written out: detected task materials
     (`dynamicGroundTruth.materialRoots`), detected platform
     (`implementationCorrection.platform`, `null` when no marker was found), onboarding panel,
     terminal correction, and commented reviewer session/provider examples.
   - `config.reference.yaml`: the fully commented version 1 artifact/stage reference (matching,
     `patterns` / `pathTemplates`, hard rules, semantic review, workflow correlation, limits).
   - `README.md`: the project-facing operating model.
   - `example.rules.yaml`: an editable deterministic-rule example.
   - `example.reviewer.md`: an editable natural-language semantic-review example.
7. State clearly: editing `config.yaml` overrides derivation; deleting it returns the project to
   zero-config auto-derivation; the derived values in it reflect what init detected right now.
8. If reviewer providers come up: `apiKeyEnv` holds the NAME of an environment variable. Never
   write an API key, token, or endpoint secret into any configuration file.
9. If the user explicitly wants IR → Planning → Selection → PRD Contract, point them to
   `examples/ir-planning-selection-prd-contract/`; do not silently install it as the default.

## Guardrails

- Use the bundled CLI path above. Do not depend on a global `runtime-corrector` command or system PATH.
- Treat the CLI output and created project-owned policy files as authoritative. Do not read plugin `scripts/`, `lib/`, or other source code to explain initialization or author artifacts; use the `explain` command when an operational summary is needed.
- Never overwrite, merge, or delete an existing `.runtime-corrector` directory.
- Do not enable version 1 artifact stages on the user's behalf; `artifacts: []` is intentional until the project declares real artifacts.
- Do not create or edit a generated artifact unless the user separately asks for that work.
- Do not apply generated `.diff` files automatically. They are candidate Git patches for the main Agent to inspect and decide whether to apply.
- Keep the completion message concrete: target directory, created files, detected materials/platform, and the next editable entry points.

## Invocation Examples

- `Use $runtime-corrector-init to materialize the derived config here.`
- `请初始化 Runtime Corrector。`
- `创建 .runtime-corrector。`
- `runtime-corrector init`
