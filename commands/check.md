---
description: Check a stage artifact with the current project's Runtime Corrector policy
argument-hint: "[artifact-path]"
allowed-tools: Bash, PowerShell
---

Check a stage artifact with Runtime Corrector. Use `$ARGUMENTS` as the artifact path; if it is empty, use `ir.md`.

Run the following command with the available Bash or PowerShell tool, replacing `<artifact-path>` with the selected relative path:

```text
node -e "const fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url');const fail=(code,message)=>{throw Object.assign(new Error(code+': '+message),{code})};const inside=(parent,candidate)=>{const relative=path.relative(parent,candidate);return relative===''||(relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative))};const native=value=>process.platform==='win32'&&value[0]==='/'&&/[a-zA-Z]/.test(value[1])&&(value.length===2||value[2]==='/')?value[1]+':'+(value.length===2?path.sep:value.slice(2).replaceAll('/',path.sep)):value;const key='CLAUDE_PLUGIN_ROOT',foreignKey='CODEAGENT3_PLUGIN_ROOT',value=(process.env[key]||'').trim();if(!value){if((process.env[foreignKey]||'').trim())fail('PLUGIN_HOST_MISMATCH',foreignKey+' is set but this artifact requires '+key);fail('PLUGIN_ROOT_MISSING',key)}const declaredPath=native(value);if(!path.isAbsolute(declaredPath))fail('PLUGIN_ROOT_NOT_ABSOLUTE',key);let root;try{root=fs.realpathSync(declaredPath);if(!fs.statSync(root).isDirectory())fail('PLUGIN_ROOT_NOT_DIRECTORY',key)}catch(error){if(error.code&&error.code.startsWith('PLUGIN_ROOT_'))throw error;fail('PLUGIN_ROOT_NOT_DIRECTORY',key)}let manifest;try{manifest=JSON.parse(fs.readFileSync(path.join(root,'.claude-plugin','plugin.json'),'utf8'))}catch(error){fail('PLUGIN_ROOT_IDENTITY_MISMATCH',error.message)}if(manifest?.name!=='runtime-corrector')fail('PLUGIN_ROOT_IDENTITY_MISMATCH','unexpected plugin identity');let entry;try{entry=fs.realpathSync(path.resolve(root,process.argv[1]));if(!fs.statSync(entry).isFile())fail('PLUGIN_ROOT_ENTRY_ESCAPE',process.argv[1])}catch(error){if(error.code&&error.code.startsWith('PLUGIN_ROOT_'))throw error;fail('PLUGIN_ROOT_ENTRY_ESCAPE',process.argv[1])}if(!inside(root,entry))fail('PLUGIN_ROOT_ENTRY_ESCAPE',process.argv[1]);process.argv[1]=entry;import(pathToFileURL(entry).href).catch(error=>{console.error(error);process.exitCode=1})" "scripts/cli.mjs" check "<artifact-path>" --format text
```

Return the diagnostics, exact candidate Git Patch count, and explicit diagnostic and diff paths. This manual CLI check does not receive a PostToolUse `session_id`, so it runs deterministic checks and returns any configured reviewer as `agentReview: requested`; it does not create an isolated semantic-review fork. A Patch count of zero means no safe deterministic correction could be derived. Do not automatically apply a Patch; leave that decision to the main Agent after `git apply --check` succeeds.
