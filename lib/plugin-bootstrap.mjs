import * as activeHost from "./active-host.mjs";


// The returned source is embedded verbatim in Hook, command, and Skill
// declarations. It contains no double quote, dollar, percent, backtick, or
// newline so POSIX sh, Windows cmd, and PowerShell pass it to node -e as data.
export function pluginBootstrapSource(hostAdapter = activeHost, { rootArgument = false } = {}) {
  const rootKey = hostAdapter.pluginRootEnv;
  const foreignKey = hostAdapter.foreignPluginRootEnv;
  const manifestDirectory = hostAdapter.manifestDirectory;
  // Commands and Skills receive a host-expanded root argument. If a shell
  // leaves the ${...} token literal, detect it without embedding a dollar in
  // the node -e source and fall back to the exported host environment.
  const rootExpression = rootArgument
    ? "(()=>{const arg=process.argv[1]||'';return (((arg.charCodeAt(0)===36&&arg[1]==='{')?'':arg)||process.env[key]||'').trim()})()"
    : "(process.env[key]||'').trim()";
  const entryIndex = rootArgument ? 2 : 1;
  const installEntry = rootArgument ? "process.argv.splice(1,2,entry);" : "process.argv[1]=entry;";
  return "const fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url');"
    + "const fail=(code,message)=>{throw Object.assign(new Error(code+': '+message),{code})};"
    + "const inside=(parent,candidate)=>{const relative=path.relative(parent,candidate);return relative===''||(relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative))};"
    + "const native=value=>process.platform==='win32'&&value[0]==='/'&&/[a-zA-Z]/.test(value[1])&&(value.length===2||value[2]==='/')?value[1]+':'+(value.length===2?path.sep:value.slice(2).replaceAll('/',path.sep)):value;"
    + `const key='${rootKey}',foreignKey='${foreignKey}',value=${rootExpression};`
    + "if(!value){if((process.env[foreignKey]||'').trim())fail('PLUGIN_HOST_MISMATCH',foreignKey+' is set but this artifact requires '+key);fail('PLUGIN_ROOT_MISSING',key)}"
    + "const declaredPath=native(value);if(!path.isAbsolute(declaredPath))fail('PLUGIN_ROOT_NOT_ABSOLUTE',key);"
    + "let root;try{root=fs.realpathSync(declaredPath);if(!fs.statSync(root).isDirectory())fail('PLUGIN_ROOT_NOT_DIRECTORY',key)}catch(error){if(error.code&&error.code.startsWith('PLUGIN_ROOT_'))throw error;fail('PLUGIN_ROOT_NOT_DIRECTORY',key)}"
    + `let manifest;try{manifest=JSON.parse(fs.readFileSync(path.join(root,'${manifestDirectory}','plugin.json'),'utf8'))}catch(error){fail('PLUGIN_ROOT_IDENTITY_MISMATCH',error.message)}`
    + "if(manifest?.name!=='runtime-corrector')fail('PLUGIN_ROOT_IDENTITY_MISMATCH','unexpected plugin identity');"
    + `let entry;try{entry=fs.realpathSync(path.resolve(root,process.argv[${entryIndex}]));if(!fs.statSync(entry).isFile())fail('PLUGIN_ROOT_ENTRY_ESCAPE',process.argv[${entryIndex}])}catch(error){if(error.code&&error.code.startsWith('PLUGIN_ROOT_'))throw error;fail('PLUGIN_ROOT_ENTRY_ESCAPE',process.argv[${entryIndex}])}`
    + `if(!inside(root,entry))fail('PLUGIN_ROOT_ENTRY_ESCAPE',process.argv[${entryIndex}]);${installEntry}import(pathToFileURL(entry).href).catch(error=>{console.error(error);process.exitCode=1})`;
}


export const PLUGIN_BOOTSTRAP_SOURCE = pluginBootstrapSource();


export function pluginBootstrapCommand(entry, hostAdapter = activeHost, { inlineRoot = false } = {}) {
  if (!/^scripts\/[a-z0-9-]+\.mjs$/u.test(entry)) {
    throw new Error(`Unsupported plugin bootstrap entry: ${entry}`);
  }
  if (inlineRoot) {
    const rootReference = "${" + hostAdapter.pluginRootEnv + "}";
    return `node -e "${pluginBootstrapSource(hostAdapter, { rootArgument: true })}" "${rootReference}" "${entry}"`;
  }
  return `node -e "${pluginBootstrapSource(hostAdapter)}" "${entry}"`;
}
