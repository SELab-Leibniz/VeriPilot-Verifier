import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runTaskOnboarding } from '../lib/runtime-v2/onboarding.mjs';
import { compileRuntimeV2Config } from '../lib/runtime-v2/config.mjs';
import { ensureTask, withTaskState } from '../lib/runtime-v2/task-store.mjs';
import { applyGroundTruthDelta, freezeGroundTruth, loadCurrentGroundTruth } from '../lib/runtime-v2/ground-truth-ledger.mjs';
import { rejectedGroundTruthSource } from '../lib/runtime-v2/ground-truth-provenance.mjs';
import { handleRuntimeV2Event, refreshRuntimeRequirements } from '../lib/runtime-v2/orchestrator.mjs';

const operation = (text='Original requirement.', ref='transcript:u1') => ({ operation:'ADD', category:'requirements', text,
  authority:'USER_EXPLICIT', severity:'HARD', source:{ref,kind:'USER_MESSAGE',subject:'MAIN_TASK'} });
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'rc-onboarding-full-source-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const task = await ensureTask({projectRoot:root,sessionId:'main'});
  await withTaskState({projectRoot:root,taskId:task.taskId},state=>{state.control={pendingRequirement:null};});
  const runtimeV2 = compileRuntimeV2Config({version:2,dynamicGroundTruth:{enabled:true,materialRoots:[],panel:{size:2,adjudicator:true}},
    skillCorrection:{enabled:false},artifactCorrection:{groundTruthReviewEnabled:false,stageMetricsEnabled:false},
    implementationCorrection:{enabled:false},stopCorrection:{enabled:true}},{policyRoot:path.join(root,'.runtime-corrector')});
  const snapshot = {entries:[{type:'user',uuid:'u1',message:{id:'m1',content:'x'.repeat(5500)+' ORIGINAL_TAIL'}},
    {type:'user',uuid:'u2',message:{id:'m2',content:'y'.repeat(5100)+' SUPPLEMENT_TAIL'}}],
    lastEntryKey:'u2',lastUserEntryKey:'u2',digest:'fixture',groundTruthDigest:'fixture-user'};
  return {root,task,runtimeV2,snapshot,input:{cwd:root,session_id:'main',hook_event_name:'Stop',hook_event_id:'source-contract'}};
}
function factoryFor(context,{adjudicate,sourceChecking=false,failAdjudicator=false}={}) {
  const calls=[];
  const factory = async args => {
    calls.push(args);
    if(failAdjudicator && args.role==='onboarding-adjudicator') throw Object.assign(new Error('Controlled adjudication binding error'),{code:'SOURCE_BINDING_INVALID'});
    const dir=path.join(context.root,'.runtime-correction/fake-review',String(calls.length));await fs.mkdir(dir,{recursive:true});
    let result;
    if(args.role==='onboarding-adjudicator') result={summary:'Controlled merge.',taskClassification:'CONTINUATION',operations:adjudicate ? adjudicate(args.request) : args.request.majorityOperations};
    else if(args.role==='stop-reviewer') result={summary:'Still working.',stopClassification:'INTERMEDIATE',findings:[],metricObjectJudgements:[]};
    else result={summary:'Controlled extraction.',taskClassification:'CONTINUATION',operations:args.role==='onboarding-extractor' ? [operation()] : [],skillGroundTruth:null};
    return {result,requestDirectory:dir,sourceBindingsValidated:sourceChecking,close:async()=>{}};
  };
  factory.calls=calls;factory.handoff=args=>factory(args);
  if(sourceChecking) {
    factory.nativeSourceDelivery=true;
    factory.validatesSourceBindings=true;
    factory.validations=[];
    factory.validateSourceBindings=function(operations,catalog) {
      assert.equal(this,factory,'canonical wrapper must preserve original method binding');
      factory.validations.push({operations,catalog});
      const issues=operations.map((op,index)=>({index,reason:rejectedGroundTruthSource(op,catalog)})).filter(x=>x.reason);
      if(issues.length) throw Object.assign(new Error('SOURCE_BINDING_INVALID'),{code:'SOURCE_BINDING_INVALID',sourceBindingIssues:issues});
    };
  }
  return factory;
}

test('extractors and adjudicator get the complete snapshot while legacy userMessages stay bounded',async t=>{
  const f=await fixture(t),factory=factoryFor(f);
  const outcome=await runTaskOnboarding({input:f.input,projectRoot:f.root,task:f.task,runtimeV2:f.runtimeV2,snapshot:f.snapshot,reviewerFactory:factory});
  assert.equal(outcome.status,'COMPLETED');assert.equal(factory.calls.length,3);
  for(const call of factory.calls) {
    assert.equal(call.evidence.snapshot,f.snapshot);
    assert.match(call.evidence.snapshot.entries[0].message.content,/ORIGINAL_TAIL$/);
    assert.match(call.evidence.snapshot.entries[1].message.content,/SUPPLEMENT_TAIL$/);
    assert.equal(call.request.userMessages[0].length,4000);
    assert.equal(call.request.userMessages[1].length,4000);
    assert.ok(!call.request.userMessages.some(text=>text.includes('_TAIL')));
  }
});

test('native merge with one bad authoritative binding does not apply or freeze a shortened ledger',async t=>{
  const f=await fixture(t),factory=factoryFor(f,{sourceChecking:true,adjudicate:request=>[
    ...request.majorityOperations,operation('Tail requirement with wrong identity.','transcript:unknown')
  ]});
  const outcome=await runTaskOnboarding({input:f.input,projectRoot:f.root,task:f.task,runtimeV2:f.runtimeV2,snapshot:f.snapshot,reviewerFactory:factory});
  assert.equal(outcome.status,'DEGRADED');assert.equal(outcome.reason,'APPLY_FAILED');
  assert.match(outcome.error,/SOURCE_BINDING_INVALID/);
  const current=await loadCurrentGroundTruth(f.root,f.task.taskId);
  assert.equal(current.version,0);assert.equal(current.frozenAtVersion,null);assert.deepEqual(current.claims,[]);
  assert.equal(factory.validations.length,1);
});

test('legacy reviewers without the native source capability keep their original deterministic fallback',async t=>{
  const f=await fixture(t),factory=factoryFor(f,{failAdjudicator:true});
  const outcome=await runTaskOnboarding({input:f.input,projectRoot:f.root,task:f.task,runtimeV2:f.runtimeV2,snapshot:f.snapshot,reviewerFactory:factory});
  assert.equal(outcome.status,'COMPLETED');
  const current=await loadCurrentGroundTruth(f.root,f.task.taskId);
  assert.equal(current.claims.length,1);assert.equal(current.claims[0].authority,'USER_EXPLICIT');assert.equal(current.claims[0].severity,'HARD');
});

test('native source fault in adjudication can still use the original valid panel merge',async t=>{
  const f=await fixture(t),factory=factoryFor(f,{sourceChecking:true,failAdjudicator:true});
  const outcome=await runTaskOnboarding({input:f.input,projectRoot:f.root,task:f.task,runtimeV2:f.runtimeV2,snapshot:f.snapshot,reviewerFactory:factory});
  assert.equal(outcome.status,'COMPLETED');assert.equal(factory.validations.length,1);
  const current=await loadCurrentGroundTruth(f.root,f.task.taskId);
  assert.equal(current.claims.length,1);assert.equal(current.claims[0].severity,'HARD');
});

test('canonical core wrapper carries native binding validation capability into onboarding',async t=>{
  const f=await fixture(t),factory=factoryFor(f,{sourceChecking:true});
  const transcript=path.join(f.root,'transcript.jsonl');await fs.writeFile(transcript,f.snapshot.entries.map(e=>JSON.stringify(e)).join('\n')+'\n');
  await handleRuntimeV2Event({input:{...f.input,transcript_path:transcript,last_assistant_message:'Stage complete.'},
    projectRoot:f.root,plan:{runtimeV2:f.runtimeV2},reviewerFactory:factory});
  assert.equal(factory.validations.length,1);
  assert.ok(factory.calls.filter(c=>c.role.startsWith('onboarding-')).every(c=>c.evidence.snapshot.entries.length===2));
});

test('incremental refresh retains the later full user supplement beyond the legacy inline cap',async t=>{
  const f=await fixture(t);
  await applyGroundTruthDelta({projectRoot:f.root,taskId:f.task.taskId,delta:{operations:[operation()]}});
  await freezeGroundTruth({projectRoot:f.root,taskId:f.task.taskId});
  const transcript=path.join(f.root,'transcript.jsonl');await fs.writeFile(transcript,f.snapshot.entries.map(e=>JSON.stringify(e)).join('\n')+'\n');
  let observed;
  const factory=async args=>{
    observed=args;
    const dir=path.join(f.root,'.runtime-correction/incremental-fixture');await fs.mkdir(dir,{recursive:true});
    return {result:{summary:'Add supplement.',taskClassification:'CONTINUATION',operations:[operation('Supplement from the later complete user message.','transcript:u2')],skillGroundTruth:null},requestDirectory:dir,close:async()=>{}};
  };
  const result=await refreshRuntimeRequirements({projectRoot:f.root,input:{...f.input,transcript_path:transcript},plan:{runtimeV2:f.runtimeV2},reviewerFactory:factory});
  assert.equal(result.baselineCommitted,true);
  assert.match(observed.evidence.snapshot.entries[1].message.content,/SUPPLEMENT_TAIL$/);
  assert.equal(observed.evidence.snapshot.entries[1].message.content.length,5116);
  const current=await loadCurrentGroundTruth(f.root,f.task.taskId);
  assert.equal(current.claims.length,2);assert.equal(current.frozenAtVersion,1);
});


test('a legacy validation marker without nativeSourceDelivery does not change fail-soft source filtering',async t=>{
  const f=await fixture(t),factory=factoryFor(f,{sourceChecking:true,adjudicate:request=>[
    ...request.majorityOperations,operation('Legacy unknown-source noise.','transcript:unknown')
  ]});
  delete factory.nativeSourceDelivery;
  const outcome=await runTaskOnboarding({input:f.input,projectRoot:f.root,task:f.task,runtimeV2:f.runtimeV2,snapshot:f.snapshot,reviewerFactory:factory});
  assert.equal(outcome.status,'COMPLETED');assert.equal(factory.validations.length,0);
  const current=await loadCurrentGroundTruth(f.root,f.task.taskId);assert.equal(current.claims.length,1);
});
