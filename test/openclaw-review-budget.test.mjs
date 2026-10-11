import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildPlugin} from '../lib/plugin-builder.mjs';
import {pathToFileURL} from 'node:url';
let artifactRoot,outputRoot,createOpenClawRuntime;
before(async()=>{outputRoot=await fs.mkdtemp(path.join(os.tmpdir(),'rc-budget-build-'));artifactRoot=await buildPlugin({host:'openclaw',sourceRoot:path.resolve('.'),outputRoot});({createOpenClawRuntime}=await import(pathToFileURL(path.join(artifactRoot,'lib/openclaw/runtime.mjs'))));});
after(()=>fs.rm(outputRoot,{recursive:true,force:true,maxRetries:3}));

async function fixture(t,stageBudget=null) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'rc-direct-budget-'));t.after(()=>fs.rm(root,{recursive:true,force:true,maxRetries:3}));
 await fs.mkdir(path.join(root,'.runtime-corrector'));
 await fs.writeFile(path.join(root,'.runtime-corrector/config.yaml'),`version: 2\nartifacts: []\ndynamicGroundTruth:\n  enabled: true\n  materialRoots: []\n  panel:\n    size: 1\n    adjudicator: false\nstopCorrection:\n  enabled: true\n${stageBudget?`  assessmentTimeoutMs: ${stageBudget}\n`:''}implementationCorrection:\n  enabled: false\nreviewers:\n  defaults:\n    timeoutMs: 1200000\n`);
 const calls=[],warnings=[];const api={id:'runtime-corrector',rootDir:artifactRoot,pluginConfig:{},config:{agents:{defaults:{model:{primary:'test/test'}}}},logger:{warn:x=>warnings.push(x)},runtime:{agent:{runEmbeddedAgent:async params=>{
  calls.push(params);return {payloads:[{text:JSON.stringify({summary:'No inferred changes.',taskClassification:'CONTINUATION',operations:[]})}],meta:{}};
 }}}};
 return {root,calls,warnings,runtime:createOpenClawRuntime(api,{pluginRoot:artifactRoot})};
}

async function finish(f,id,parentMs=3600000) {
 const file=path.join(f.root,'native.jsonl'),prompt='Implement the requested Python app.';
 await fs.writeFile(file,[{type:'message',id:'user',message:{role:'user',content:prompt}},
  {type:'message',id:'done',parentId:'user',message:{role:'assistant',content:'All requested task work is complete.'}}].map(JSON.stringify).join('\n'));
 const ctx={workspaceDir:f.root,sessionId:id,sessionFile:file,sessionKey:'agent:main:'+id,runId:id,agentId:'main',provider:'test',modelId:'test',prompt};
 const state=await f.runtime.beginSupervised(ctx,new AbortController().signal,{deadlineAt:Date.now()+parentMs});
 return {state,file,ctx};
}

test('controller-owned terminal assessment uses role20 while actual Hook keeps the original bound',async t=>{
 const direct=await fixture(t),a=await finish(direct,'direct');
 await direct.runtime.assessSupervised(a.state,{transcriptPath:a.file,text:'All requested task work is complete.',assessmentId:'direct-test',stopHookActive:false});
 assert(direct.calls.length>0,direct.warnings.join('\n'));assert(direct.calls[0].timeoutMs>1000000,`direct extractor kept its existing18min phase ceiling, got ${direct.calls[0].timeoutMs}`);
 const hooked=await fixture(t),b=await finish(hooked,'hook');
 await hooked.runtime.finalize({lastAssistantMessage:'All requested task work is complete.',stopHookActive:false},b.ctx);
 assert(hooked.calls.length>0,hooked.warnings.join('\n'));assert(hooked.calls[0].timeoutMs<600000);
});

test('explicit RC assessment budget is used by direct manual verification windows',async t=>{
 const f=await fixture(t,1800000);assert.equal(await f.runtime.effectiveReviewTimeout({workspaceDir:f.root}),1800000);
});

test('controller review still respects parent absolute deadline',async t=>{
 const f=await fixture(t),a=await finish(f,'parent',1500);
 await f.runtime.assessSupervised(a.state,{transcriptPath:a.file,text:'All requested task work is complete.',assessmentId:'parent-test',stopHookActive:false});
 assert(f.calls.length>0,f.warnings.join('\n'));assert(f.calls[0].timeoutMs<=1500);
});

test('historical files removed before assessment are not invented required evidence; changes after capture remain stale',async t=>{
 const f=await fixture(t),a=await finish(f,'historical');const current=path.join(f.root,'app.py'),removed=path.join(f.root,'unused.py');
 await fs.writeFile(current,'current source');await fs.writeFile(removed,'temporary source');a.state.observedPaths.add(current);a.state.observedPaths.add(removed);await fs.unlink(removed);
 const files=await f.runtime.evidenceFiles(a.state);assert(files.includes(current));assert(!files.includes(removed));assert(files.includes(path.join(f.root,'.runtime-corrector/config.yaml')));
 const {createEvidenceLedger}=await import('../lib/openclaw/evidence.mjs');const ledger=createEvidenceLedger(f.root);await ledger.capture(files);assert(await ledger.matches());
 await fs.unlink(current);assert.equal(await ledger.matches(),false,'deletion during review is still stale');
 const required=createEvidenceLedger(f.root);await required.capture([removed]);assert.equal(await required.matches(),false,'explicit required missing file remains a blocker');
});

test('project YAML defaults and individual roles can independently override format repairs',async t=>{
 const f=await fixture(t),file=path.join(f.root,'.runtime-corrector/config.yaml');let text=await fs.readFile(file,'utf8');text=text.replace('    timeoutMs: 1200000','    timeoutMs: 1200000\n    formatRepairAttempts: 2\n  stopReviewer:\n    formatRepairAttempts: 0');await fs.writeFile(file,text);
 const {loadConfig}=await import('../lib/runtime-corrector.mjs');const plan=await loadConfig({cwd:f.root,pluginRoot:artifactRoot});assert.equal(plan.runtimeV2.reviewers.stopReviewer.formatRepairAttempts,0);assert.equal(plan.runtimeV2.reviewers.implementationReviewer.formatRepairAttempts,2);
});
