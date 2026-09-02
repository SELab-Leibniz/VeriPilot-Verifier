---
description: Get the complete authoritative specification packet for one Runtime Corrector stage
argument-hint: <stage>
allowed-tools: Bash, PowerShell
---

Retrieve the complete stage map before authoring or recovering from repeated failures.

Run:

```text
node -e "const fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url');const fail=(code,message)=>{throw Object.assign(new Error(code+': '+message),{code})};const declared=['CLAUDE_PLUGIN_ROOT','CODEAGENT3_PLUGIN_ROOT'].map(key=>[key,(process.env[key]||'').trim()]).filter(([,value])=>value);if(!declared.length)fail('PLUGIN_ROOT_MISSING','no supported plugin root is set');const roots=declared.map(([key,value])=>{if(!path.isAbsolute(value))fail('PLUGIN_ROOT_NOT_ABSOLUTE',key);try{const root=fs.realpathSync(value);if(!fs.statSync(root).isDirectory())fail('PLUGIN_ROOT_NOT_DIRECTORY',key);return[key,root]}catch(error){if(error.code&&error.code.startsWith('PLUGIN_ROOT_'))throw error;fail('PLUGIN_ROOT_NOT_DIRECTORY',key)}});if(new Set(roots.map(([,root])=>root)).size!==1)fail('PLUGIN_ROOT_CONFLICT',roots.map(([key,root])=>key+'='+root).join(','));const root=roots[0][1],entry=path.resolve(root,process.argv[1]),relative=path.relative(root,entry);if(relative.startsWith('..')||path.isAbsolute(relative))fail('PLUGIN_ROOT_ENTRY_ESCAPE',process.argv[1]);process.argv[1]=entry;import(pathToFileURL(entry).href).catch(error=>{console.error(error);process.exitCode=1})" "scripts/cli.mjs" spec "$ARGUMENTS" --format text
```

Treat the output as one atomic specification packet: plugin-global exact format contract, active project artifact mapping, deterministic rules, every referenced JSON Schema, Agent reviewer, and recovery rules. Do not read plugin tests or implementation source to infer missing syntax. When the user is recovering a failed stage, read the complete packet before the next artifact edit and report any genuine contradiction instead of guessing.
