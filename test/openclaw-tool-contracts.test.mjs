import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {OPENCLAW_TOOL_NAMES,TASK_TOOL_NAMES,BASELINE_TOOL_NAMES,configureOpenClawToolContract,assertOpenClawToolContract} from '../lib/openclaw/tool-contracts.mjs';
import {registerTaskTools,bindTaskTools} from '../lib/openclaw/task-tools.mjs';
import {assertRequiredReviewerTools,withNativeTaskToolPolicy} from '../lib/openclaw/native-config.mjs';
import entry from '../lib/openclaw/entry.mjs';
import os from 'node:os';
import { buildPlugin } from '../lib/plugin-builder.mjs';
import { validateArtifactSkills } from '../scripts/bench/validate-artifact-skills.mjs';
import { createDocumentTools } from '../lib/document-tools.mjs';
import { loadConfig } from '../lib/runtime-corrector.mjs';
import { compileRuntimeV2Config } from '../lib/runtime-v2/config.mjs';
import { loadStopOriginalRequirements } from '../lib/runtime-v2/production-stop.mjs';
import { runWorkspaceStopReview } from '../lib/runtime-v2/stop-workspace-review.mjs';
import { stopProtocolFixture } from './helpers/stop-protocol.mjs';

const sourceManifest=()=>fs.readFile(new URL('../packaging/hosts/openclaw/openclaw.plugin.json',import.meta.url),'utf8').then(JSON.parse);

test('actual A, B1, B2, B12 and F worker tools are declared by the OpenClaw plugin', async t => {
  const source = await sourceManifest();
  const declared = new Set(configureOpenClawToolContract(source).contracts.tools);
  const assertDeclared = (arm, tools) => {
    assert(tools.length > 0, `${arm} exposed no tools`);
    assert.deepEqual(tools.filter(name => !declared.has(name)), [], `${arm} has undeclared worker tools`);
  };
  for (const [arm, originalRequirementsBasis, deviationOnly, strictOrigin = false] of [
    ['A', false, false], ['B1', true, false], ['B2', false, true], ['B12', true, true], ['default project', true, true],
    ['B12 strict origin', true, true, true],
  ]) await t.test(arm, async subtest => {
    const fixture = await stopProtocolFixture(subtest, 'findings');
    const { input, root } = fixture;
    const fromTemplate = arm === 'default project';
    if (fromTemplate) await fs.cp(new URL('../.runtime-corrector-default/', import.meta.url), path.join(root, '.runtime-corrector'), { recursive: true });
    const runtime = fromTemplate ? (await loadConfig({ cwd: root })).runtimeV2
      : compileRuntimeV2Config({ version: 2, dynamicGroundTruth: { enabled: !originalRequirementsBasis },
        stopCorrection: { enabled: true, originalRequirementsBasis, deviationOnly,
          requireCurrentProductionCoverage: strictOrigin, requireProductionOriginCoverage: strictOrigin } });
    assert.equal(Boolean(runtime.stopCorrection.originalRequirementsBasis), originalRequirementsBasis);
    assert.equal(Boolean(runtime.stopCorrection.deviationOnly), deviationOnly);
    input.request.population.reviewPolicy = { metrics: runtime.stopCorrection.metrics, deviationOnly: runtime.stopCorrection.deviationOnly,
      requireCurrentProductionCoverage: runtime.stopCorrection.requireCurrentProductionCoverage,
      requireProductionOriginCoverage: runtime.stopCorrection.requireProductionOriginCoverage };
    if (runtime.stopCorrection.originalRequirementsBasis) input.evidence.originalRequirements = await loadStopOriginalRequirements({
      projectRoot: root, snapshot: input.evidence.snapshot,
    });
    let tools, systemPrompt;
    const captured = new Error('Offline worker tools captured');
    const session = { sessionId: randomUUID(), deadlineAt: Date.now() + 20_000, signal: new AbortController().signal, active() {},
      async run(worker) {
        tools = worker.tools.map(tool => tool.name);
        systemPrompt = worker.systemPrompt;
        throw captured;
      } };
    await assert.rejects(runWorkspaceStopReview(input, { session }), error =>
      error.code === 'TASK_NO_VALID_SUBMISSION' && error.cause === captured);
    assert.equal(tools.includes('set_original_checklist'), originalRequirementsBasis);
    assert.equal(tools.includes('review_production_origin'), strictOrigin);
    assert.equal(systemPrompt.includes('breaks existing behavior that the request did not ask to change'), false);
    assert.equal(systemPrompt.includes('standing REGRESSION item'), false, 'regression guidance follows the program standing item, absent without source changes');
    assertDeclared(arm, tools);
    if (originalRequirementsBasis) assert(source.contracts.tools.includes('set_original_checklist'));
    if (strictOrigin) assert(source.contracts.tools.includes('review_production_origin'));
  });
  await t.test('F', async subtest => {
    const { root } = await stopProtocolFixture(subtest, 'findings');
    const runtime = compileRuntimeV2Config({ version: 2, artifactCorrection: { originalRequirementsEnabled: true } });
    assert.equal(runtime.artifactCorrection.originalRequirementsEnabled, true);
    const originalRequirements = await loadStopOriginalRequirements({ projectRoot: root,
      snapshot: { entries: [{ type: 'user', uuid: 'requirement', message: { content: 'Keep the design local.' } }] } });
    const document = await createDocumentTools({ projectRoot: root, semantic: { artifactFiles: ['spec.md'], originalRequirements } });
    assertDeclared('F', [document.tool.name]);
  });
});

test('packaged Skill metadata parses with the installed host YAML parser before model dispatch', {skip:!process.env.RC_OPENCLAW_HOST_ROOT}, async t => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'rc-skill-yaml-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const artifact=await buildPlugin({host:'openclaw',sourceRoot:process.cwd(),outputRoot:root});
 const records=await validateArtifactSkills(artifact,process.env.RC_OPENCLAW_HOST_ROOT);
 assert(records.some(record=>record.name==='runtime-corrector-control'));
 const file=path.join(artifact,'skills/runtime-corrector-control/SKILL.md');
 await fs.writeFile(file,(await fs.readFile(file,'utf8')).replace(/^description:.*$/mu,'description: Invalid mapping: requires quoting'));
 await assert.rejects(validateArtifactSkills(artifact,process.env.RC_OPENCLAW_HOST_ROOT),/Invalid Skill YAML/);
});

test('the full registration contract includes every actual factory even without an installed-host fixture',async()=>{
 const names=new Set(),hooks=new Map(),manifest=configureOpenClawToolContract(await sourceManifest());
 entry.register({rootDir:process.cwd(),config:{},pluginConfig:{},logger:{info(){},warn(){},error(){}},
  runtime:{version:'2026.7.1-2',agent:{runEmbeddedAgent:async()=>assert.fail('contract inspection must not call a model')}},
  registerTool(_factory,metadata){for(const name of metadata.names)names.add(name);},
  registerCommand(){},registerGatewayMethod(){},registerHttpRoute(){},registerAgentToolResultMiddleware(){},on(name,hook){hooks.set(name,hook);}});
 assert(names.has('rc_skill_care'));
 assert.deepEqual([...names].sort(),[...manifest.contracts.tools].sort());
 assert(TASK_TOOL_NAMES.includes('finish_baseline_audit'));
 assert(TASK_TOOL_NAMES.includes('review_production_origin'));
 assert(!BASELINE_TOOL_NAMES.includes('review_production_origin'));
 assert(TASK_TOOL_NAMES.includes('commit_baseline_inventory'));
 assert(!BASELINE_TOOL_NAMES.includes('commit_baseline_inventory'));
 const groups=JSON.parse(await fs.readFile(new URL('../config/openclaw-tool-contracts.json',import.meta.url),'utf8'));
 assert.deepEqual(groups.public,['runtime_corrector','rc_document','rc_skill_care','rc_progress']);
 assert.deepEqual(BASELINE_TOOL_NAMES,['source_read','source_grep','source_find','source_ls','review_history','baseline_notes','save_baseline_batch','finish_baseline']);
 const sessionId=randomUUID(),sessionKey=`agent:main:runtime-corrector:${sessionId}`,runId=randomUUID(),observed=[];
 const close=bindTaskTools({sessionId,sessionKey,runId,active(){},tools:[],observeReceipt:event=>observed.push(event)});
 try{
  const persist=hooks.get('tool_result_persist'),ctx={sessionId,sessionKey,runId};
  const finish={toolName:'finish_baseline_audit',toolCallId:'owned-finish',isSynthetic:false};
  assert.equal(persist({...finish,isSynthetic:true},ctx),undefined);
  persist(finish,{...ctx,runId:'foreign'});persist(finish,{...ctx,sessionId:'foreign'});
  persist({...finish,toolName:'finish_baseline'},ctx);
  assert.equal(observed.length,0);
  assert.equal(persist(finish,ctx),undefined); // Synchronous bridge never rewrites a host message.
  persist({...finish,toolName:'source_read'},ctx);
  const inventory={...finish,toolName:'commit_baseline_inventory'};
  persist({...inventory,isSynthetic:true},ctx);persist(inventory,{...ctx,runId:'foreign'});
  assert.equal(observed.length,2);
  assert.equal(persist(inventory,ctx),undefined);
  assert.deepEqual(observed.map(event=>event.toolName),['finish_baseline_audit','source_read','commit_baseline_inventory']);
 }finally{close();}
});

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
