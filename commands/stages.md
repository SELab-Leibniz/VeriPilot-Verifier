---
description: Show or change which Runtime Corrector stages are enabled
argument-hint: "[<stage> <on|off>]"
allowed-tools: Bash, PowerShell
---

Give the user a simple, transparent stage control view.

If `$ARGUMENTS` is empty, run:

```text
node -e "const fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url');const fail=(code,message)=>{throw Object.assign(new Error(code+': '+message),{code})};const inside=(parent,candidate)=>{const relative=path.relative(parent,candidate);return relative===''||(relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative))};const native=value=>process.platform==='win32'&&value[0]==='/'&&/[a-zA-Z]/.test(value[1])&&(value.length===2||value[2]==='/')?value[1]+':'+(value.length===2?path.sep:value.slice(2).replaceAll('/',path.sep)):value;const key='CLAUDE_PLUGIN_ROOT',foreignKey='CODEAGENT3_PLUGIN_ROOT',value=(process.env[key]||'').trim();if(!value){if((process.env[foreignKey]||'').trim())fail('PLUGIN_HOST_MISMATCH',foreignKey+' is set but this artifact requires '+key);fail('PLUGIN_ROOT_MISSING',key)}const declaredPath=native(value);if(!path.isAbsolute(declaredPath))fail('PLUGIN_ROOT_NOT_ABSOLUTE',key);let root;try{root=fs.realpathSync(declaredPath);if(!fs.statSync(root).isDirectory())fail('PLUGIN_ROOT_NOT_DIRECTORY',key)}catch(error){if(error.code&&error.code.startsWith('PLUGIN_ROOT_'))throw error;fail('PLUGIN_ROOT_NOT_DIRECTORY',key)}let manifest;try{manifest=JSON.parse(fs.readFileSync(path.join(root,'.claude-plugin','plugin.json'),'utf8'))}catch(error){fail('PLUGIN_ROOT_IDENTITY_MISMATCH',error.message)}if(manifest?.name!=='runtime-corrector')fail('PLUGIN_ROOT_IDENTITY_MISMATCH','unexpected plugin identity');let entry;try{entry=fs.realpathSync(path.resolve(root,process.argv[1]));if(!fs.statSync(entry).isFile())fail('PLUGIN_ROOT_ENTRY_ESCAPE',process.argv[1])}catch(error){if(error.code&&error.code.startsWith('PLUGIN_ROOT_'))throw error;fail('PLUGIN_ROOT_ENTRY_ESCAPE',process.argv[1])}if(!inside(root,entry))fail('PLUGIN_ROOT_ENTRY_ESCAPE',process.argv[1]);process.argv[1]=entry;import(pathToFileURL(entry).href).catch(error=>{console.error(error);process.exitCode=1})" "scripts/cli.mjs" stages
```

If `$ARGUMENTS` contains a stage and `on` or `off`, run:

```text
node -e "const fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url');const fail=(code,message)=>{throw Object.assign(new Error(code+': '+message),{code})};const inside=(parent,candidate)=>{const relative=path.relative(parent,candidate);return relative===''||(relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative))};const native=value=>process.platform==='win32'&&value[0]==='/'&&/[a-zA-Z]/.test(value[1])&&(value.length===2||value[2]==='/')?value[1]+':'+(value.length===2?path.sep:value.slice(2).replaceAll('/',path.sep)):value;const key='CLAUDE_PLUGIN_ROOT',foreignKey='CODEAGENT3_PLUGIN_ROOT',value=(process.env[key]||'').trim();if(!value){if((process.env[foreignKey]||'').trim())fail('PLUGIN_HOST_MISMATCH',foreignKey+' is set but this artifact requires '+key);fail('PLUGIN_ROOT_MISSING',key)}const declaredPath=native(value);if(!path.isAbsolute(declaredPath))fail('PLUGIN_ROOT_NOT_ABSOLUTE',key);let root;try{root=fs.realpathSync(declaredPath);if(!fs.statSync(root).isDirectory())fail('PLUGIN_ROOT_NOT_DIRECTORY',key)}catch(error){if(error.code&&error.code.startsWith('PLUGIN_ROOT_'))throw error;fail('PLUGIN_ROOT_NOT_DIRECTORY',key)}let manifest;try{manifest=JSON.parse(fs.readFileSync(path.join(root,'.claude-plugin','plugin.json'),'utf8'))}catch(error){fail('PLUGIN_ROOT_IDENTITY_MISMATCH',error.message)}if(manifest?.name!=='runtime-corrector')fail('PLUGIN_ROOT_IDENTITY_MISMATCH','unexpected plugin identity');let entry;try{entry=fs.realpathSync(path.resolve(root,process.argv[1]));if(!fs.statSync(entry).isFile())fail('PLUGIN_ROOT_ENTRY_ESCAPE',process.argv[1])}catch(error){if(error.code&&error.code.startsWith('PLUGIN_ROOT_'))throw error;fail('PLUGIN_ROOT_ENTRY_ESCAPE',process.argv[1])}if(!inside(root,entry))fail('PLUGIN_ROOT_ENTRY_ESCAPE',process.argv[1]);process.argv[1]=entry;import(pathToFileURL(entry).href).catch(error=>{console.error(error);process.exitCode=1})" "scripts/cli.mjs" stage $ARGUMENTS
```

Report the resulting on/off state and the corresponding editable `*.rules.yaml` and `*.reviewer.md` files. Do not edit artifact files or any criteria beyond the requested stage switch.

Stage names come only from the project's installed `artifacts[]`; `app-design`, `planning`, and every
other configured Stage use the same command and safety boundary.

For multi-stage natural-language requests such as “only enable Selection and PRD Contract”, use the `runtime-corrector-control` Skill so it can read current state and apply the minimal set of stage changes.
