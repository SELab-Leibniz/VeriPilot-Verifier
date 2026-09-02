---
description: Show Runtime Corrector commands, natural-language controls, current stages, and editable policy files
allowed-tools: Bash, PowerShell
---

Show the project-aware Runtime Corrector help without inspecting plugin source code.

Run this exact command with the available Bash or PowerShell tool:

```text
node -e "const fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url');const fail=(code,message)=>{throw Object.assign(new Error(code+': '+message),{code})};const declared=['CLAUDE_PLUGIN_ROOT','CODEAGENT3_PLUGIN_ROOT'].map(key=>[key,(process.env[key]||'').trim()]).filter(([,value])=>value);if(!declared.length)fail('PLUGIN_ROOT_MISSING','no supported plugin root is set');const roots=declared.map(([key,value])=>{if(!path.isAbsolute(value))fail('PLUGIN_ROOT_NOT_ABSOLUTE',key);try{const root=fs.realpathSync(value);if(!fs.statSync(root).isDirectory())fail('PLUGIN_ROOT_NOT_DIRECTORY',key);return[key,root]}catch(error){if(error.code&&error.code.startsWith('PLUGIN_ROOT_'))throw error;fail('PLUGIN_ROOT_NOT_DIRECTORY',key)}});if(new Set(roots.map(([,root])=>root)).size!==1)fail('PLUGIN_ROOT_CONFLICT',roots.map(([key,root])=>key+'='+root).join(','));const root=roots[0][1],entry=path.resolve(root,process.argv[1]),relative=path.relative(root,entry);if(relative.startsWith('..')||path.isAbsolute(relative))fail('PLUGIN_ROOT_ENTRY_ESCAPE',process.argv[1]);process.argv[1]=entry;import(pathToFileURL(entry).href).catch(error=>{console.error(error);process.exitCode=1})" "scripts/cli.mjs" help
```

Return the output directly, then answer any follow-up using only that output and the project-owned `.runtime-corrector/README.md`, `config.yaml`, `*.rules.yaml`, and `*.reviewer.md` files. Do not edit stage switches, criteria, or artifacts unless the user explicitly asks for a change.
