import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {OPENCLAW_TOOL_NAMES,BASELINE_TOOL_NAMES,configureOpenClawToolContract,assertOpenClawToolContract} from '../lib/openclaw/tool-contracts.mjs';
import {registerTaskTools,bindTaskTools} from '../lib/openclaw/task-tools.mjs';
import {assertRequiredReviewerTools,withNativeTaskToolPolicy} from '../lib/openclaw/native-config.mjs';
import entry from '../lib/openclaw/entry.mjs';

const sourceManifest=()=>fs.readFile(new URL('../packaging/hosts/openclaw/openclaw.plugin.json',import.meta.url),'utf8').then(JSON.parse);

test('tool contract configuration repairs missing declarations without operator tool-name edits',async()=>{
 const manifest=await sourceManifest();
 manifest.contracts.tools=['runtime_corrector'];
 assert.throws(()=>assertOpenClawToolContract(manifest),/every registered tool/);
 const configured=configureOpenClawToolContract(manifest);
 assert.deepEqual(configured.contracts.tools,OPENCLAW_TOOL_NAMES);
 assert.deepEqual(manifest.contracts.tools,['runtime_corrector']);
 assert.throws(()=>configureOpenClawToolContract(manifest,{public:['bad name'],task:['read'],baseline:['finish']}),/Invalid/);
 const config={tools:{profile:'coding',deny:['source_grep']},agents:{list:[{id:'main',tools:{deny:['finish_baseline']}}]}};
 const privateConfig=withNativeTaskToolPolicy(config,'main',BASELINE_TOOL_NAMES);
 assert.deepEqual(privateConfig.tools.allow,BASELINE_TOOL_NAMES);
 assert.deepEqual(privateConfig.tools.deny,['source_grep']);
 assert.deepEqual(privateConfig.agents.list[0].tools.deny,['finish_baseline']);
 assert(BASELINE_TOOL_NAMES.every(name=>privateConfig.agents.list[0].tools.alsoAllow.includes(name)));
 assert.equal(config.tools.allow,undefined);
});

test('required-tool preflight preserves and diagnoses operator denies before any model call',()=>{
 for(const [policy,config] of [
  ['tools',{tools:{deny:['finish_baseline']}}],
  ['agents.main.tools',{agents:{list:[{id:'main',tools:{deny:['source_*']}}]}}],
  ['tools.byProvider.fixture/model',{tools:{byProvider:{'fixture/model':{deny:['group:plugins']}}}}],
  ['tools',{tools:{deny:['runtime-corrector']}}],
 ]){
  const original=structuredClone(config);
  assert.throws(()=>assertRequiredReviewerTools(config,'main',BASELINE_TOOL_NAMES,{provider:'fixture',model:'model'}),error=>{
   assert.equal(error.code,'RC_REQUIRED_TOOLS_DENIED');assert(error.blockedTools.some(item=>item.policy===policy));
   assert.match(error.message,/finish_baseline|source_read/);return true;
  });
  assert.deepEqual(config,original);
 }
 assert.doesNotThrow(()=>assertRequiredReviewerTools({tools:{deny:['write','message']}},'main',BASELINE_TOOL_NAMES));
});

test('installed MA registry accepts the entire baseline factory and its session-scoped tools', {skip:!process.env.RC_OPENCLAW_HOST_ROOT},async()=>{
 const host=process.env.RC_OPENCLAW_HOST_ROOT;
 const {t:createPluginRegistry}=await import(pathToFileURL(path.join(host,'dist/registry-B8eQDFB4.js')));
 const manifest=configureOpenClawToolContract(await sourceManifest());
 function register(value){
  const hostRegistry=createPluginRegistry({activateGlobalSideEffects:false});
  const record={id:manifest.id,name:manifest.name,contracts:value.contracts,source:'isolated-contract-test',rootDir:host,toolNames:[]};
  registerTaskTools({registerTool:(tool,opts)=>hostRegistry.registerTool(record,tool,opts),on(){}});
  return hostRegistry.registry;
 }
 const broken=register({...manifest,contracts:{...manifest.contracts,tools:manifest.contracts.tools.filter(name=>!['save_baseline_batch','finish_baseline'].includes(name))}});
 assert.equal(broken.tools.length,0);
 assert(broken.diagnostics.some(d=>d.message.includes('save_baseline_batch')));
 const registered=register(manifest);
 assert.deepEqual(registered.diagnostics,[]);
 assert.equal(registered.tools.length,1);
 const sessionId=randomUUID(),sessionKey=`agent:main:runtime-corrector:${sessionId}`;
 const close=bindTaskTools({sessionId,sessionKey,active(){},tools:BASELINE_TOOL_NAMES.map(name=>({name,execute:async()=>({name})}))});
 try{
  const factory=registered.tools[0].factory;
  assert.equal(factory({sessionId:'unrelated',sessionKey:'business'}),null);
  const tools=factory({sessionId,sessionKey});
  assert.deepEqual(tools.map(tool=>tool.name),BASELINE_TOOL_NAMES);
  assert.deepEqual(await tools.find(tool=>tool.name==='finish_baseline').execute(),{name:'finish_baseline'});
 }finally{close();}
});

test('every tool registered by the complete plugin entry is covered by the installation contract',{skip:!process.env.RC_OPENCLAW_HOST_ROOT},async()=>{
 const host=process.env.RC_OPENCLAW_HOST_ROOT;
 const {t:createPluginRegistry}=await import(pathToFileURL(path.join(host,'dist/registry-B8eQDFB4.js')));
 const manifest=configureOpenClawToolContract(await sourceManifest());
 const registry=createPluginRegistry({activateGlobalSideEffects:false});
 const record={id:manifest.id,name:manifest.name,contracts:manifest.contracts,source:'complete-entry-contract',rootDir:host,toolNames:[]};
 entry.register({rootDir:process.cwd(),config:{},pluginConfig:{},logger:{info(){},warn(){},error(){}},
   runtime:{version:'2026.7.1-2',agent:{runEmbeddedAgent:async()=>assert.fail('registration must not run a model')}},
   registerTool:(factory,metadata)=>registry.registerTool(record,factory,metadata),
   registerCommand(){},registerGatewayMethod(){},registerHttpRoute(){},registerAgentToolResultMiddleware(){},on(){}});
 assert.deepEqual(registry.registry.diagnostics,[]);
 assert.deepEqual([...new Set(registry.registry.tools.flatMap(tool=>tool.names))].sort(),[...OPENCLAW_TOOL_NAMES].sort());
});
