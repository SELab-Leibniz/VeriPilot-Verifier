---
description: Check a stage artifact with the current project's Runtime Corrector policy
argument-hint: "[artifact-path]"
allowed-tools: Bash, PowerShell
---

Check a stage artifact with Runtime Corrector. Use `$ARGUMENTS` as the artifact path; if it is empty, use `ir.md`.

Run the following command with the available Bash or PowerShell tool, replacing `<artifact-path>` with the selected relative path:

```text
node -e "const fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url');const fail=(code,message)=>{throw Object.assign(new Error(code+': '+message),{code})};const declared=['CLAUDE_PLUGIN_ROOT','CODEAGENT3_PLUGIN_ROOT'].map(key=>[key,(process.env[key]||'').trim()]).filter(([,value])=>value);if(!declared.length)fail('PLUGIN_ROOT_MISSING','no supported plugin root is set');const roots=declared.map(([key,value])=>{if(!path.isAbsolute(value))fail('PLUGIN_ROOT_NOT_ABSOLUTE',key);try{const root=fs.realpathSync(value);if(!fs.statSync(root).isDirectory())fail('PLUGIN_ROOT_NOT_DIRECTORY',key);return[key,root]}catch(error){if(error.code&&error.code.startsWith('PLUGIN_ROOT_'))throw error;fail('PLUGIN_ROOT_NOT_DIRECTORY',key)}});if(new Set(roots.map(([,root])=>root)).size!==1)fail('PLUGIN_ROOT_CONFLICT',roots.map(([key,root])=>key+'='+root).join(','));const root=roots[0][1],entry=path.resolve(root,process.argv[1]),relative=path.relative(root,entry);if(relative.startsWith('..')||path.isAbsolute(relative))fail('PLUGIN_ROOT_ENTRY_ESCAPE',process.argv[1]);process.argv[1]=entry;import(pathToFileURL(entry).href).catch(error=>{console.error(error);process.exitCode=1})" "scripts/cli.mjs" check "<artifact-path>" --format text
```

Return the diagnostics, exact candidate Git Patch count, and explicit diagnostic and diff paths. This manual CLI check does not receive a PostToolUse `session_id`, so it runs deterministic checks and returns any configured reviewer as `agentReview: requested`; it does not create an isolated semantic-review fork. A Patch count of zero means no safe deterministic correction could be derived. Do not automatically apply a Patch; leave that decision to the main Agent after `git apply --check` succeeds.
