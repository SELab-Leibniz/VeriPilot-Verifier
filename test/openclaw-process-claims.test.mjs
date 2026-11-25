import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { stopProtocolFixture, materializeStopChecklist } from './helpers/stop-protocol.mjs';
import { normalizeMessages } from '../lib/openclaw/transcript.mjs';
import { sha256 } from '../lib/runtime-v2/utils.mjs';
import { compileRuntimeV2Config } from '../lib/runtime-v2/config.mjs';
import { resolveStopReviewPolicy } from '../lib/runtime-v2/metric-policy.mjs';
import { findTask, withTaskState, taskDirectory } from '../lib/runtime-v2/task-store.mjs';
import { runProductionStop } from '../lib/runtime-v2/production-stop.mjs';
import { validateReviewJudgement } from '../lib/runtime-v2/review-result-validation.mjs';

const invoke=(id,name,args)=>({id:'invoke-'+id,message:{role:'assistant',content:[{type:'toolCall',id,name,arguments:args}]}});
const result=(id,toolCallId,details,text='Captured native output.',toolName='exec')=>({id,message:{role:'toolResult',toolName,toolCallId,isError:false,details,content:[{type:'text',text}]}});
const running=()=>[invoke('exec-1','exec',{command:'generic operation'}),result('result-1','exec-1',{status:'running',sessionId:'process-one'})];
const terminal=(code=0,text)=>[invoke('exec-1','exec',{command:'generic operation'}),result('result-1','exec-1',{status:'completed',exitCode:code},text)];
const claimFrom=({requiredFiles,requiredFileCount,requiredFilesComplete,...claim})=>claim;

async function fixture(t,records,verificationTarget='PROCESS'){
 const f=await stopProtocolFixture(t,'findings');
 const claim={...f.input.evidence.groundTruth.claims[0],text:verificationTarget==='PROCESS'?'Observe the assigned process operation.':'Deliver the generic operation.',verificationTarget,applicabilityKind:'CURRENT_TASK'};
 const truth={version:1,digest:sha256([claim]),claims:[claim]};
 await fs.writeFile(f.input.request.groundTruthPath,JSON.stringify(truth));f.input.evidence.groundTruth=truth;
 await withTaskState({projectRoot:f.root,taskId:f.task.taskId},state=>{state.groundTruth.version=truth.version;state.groundTruth.digest=truth.digest;});
 const object={...f.input.request.population.metrics.M01[0],objectId:'M12:R1',metricId:'M12',verificationTarget,applicabilityKind:'CURRENT_TASK',description:claim.text,
  ...(verificationTarget==='IMPLEMENTATION'?{implementationRole:'PRODUCTION'}:{})};
 const policy=resolveStopReviewPolicy({deviationOnly:false,fileQualityReviewEnabled:false,metrics:{M12:true}});
 f.input.request.population={metrics:{M12:[object]},reviewPolicy:policy};
 f.input.request.fixedStopClassification={stopClassification:'TASK_COMPLETE',stage:null};f.input.request.reviewScope={kind:'workspace-stop'};
 const entries=normalizeMessages([{id:'user-original',message:{role:'user',content:claim.text}},...records]);
 f.input.evidence.snapshot={entries,digest:sha256(entries)};f.input.request.sourceManifest=[];
 const production=async(handle,id)=>runProductionStop({projectRoot:f.root,task:await findTask({projectRoot:f.root,sessionId:'protocol-host'}),
  input:{session_id:'protocol-host'},env:{},verificationOnly:true,verificationId:id,snapshot:f.input.evidence.snapshot,
  runtimeV2:compileRuntimeV2Config({version:2,stopCorrection:{enabled:true,deviationOnly:false,originalRequirementsBasis:false,fileQualityReviewEnabled:false}}),
  reviewerFactory:Object.assign(async()=>assert.fail('No new reviewer dispatch.'),{reviewDeadlineAt:Date.now()+20000}),
  prepare:async()=>({taskId:f.task.taskId,groundTruth:truth,classification:f.input.request.fixedStopClassification,population:f.input.request.population,
    fullPopulation:f.input.request.population,unifiedReview:handle,request:{artifactCandidates:[]}})});
 const run=async script=>{
  let failure;
  try{
   const handle=await f.run(async tools=>{try{await script(tools);}catch(error){failure=error;throw error;}});
   if(failure)throw failure;
   return handle;
  }catch(error){throw failure??error;}
 };
 return {...f,run,production,object};
}
async function readWhole(read,file,options={}){
 let offset=1,last;do{last=await read(file,{offset,...options});offset=last.details.page.nextOffset;}while(offset!==null);return last;
}
async function navigation(tools){
 await tools.readAll();const list=await materializeStopChecklist(await tools.submit('review_checklist',{stopClassification:'TASK_COMPLETE'}),tools.submit);
 assert.equal(list.processEvidence.navigationOnly,true);assert.equal(list.processEvidence.executionResultFileCount>=1,true);
 return list.processEvidence;
}
async function readFact(tools,fact){
 assert.equal(fact.requiredFilesComplete,true);
 const pages=[];for(const file of fact.requiredFiles)pages.push({file,page:await readWhole(tools.read,file)});
 return pages;
}
function submission(claim,citeId){return{taskId:'M12:R1',verdict:'PASS',reason:'The explicit captured process fact was checked; relevance remains a reviewer judgment.',
 processClaims:[claim],citeIds:[citeId],finish:true};}
function resultFile(guide,id){
 const pair=guide.nativeProcessFacts.find(f=>f.resultMessageId===id);assert(pair);
 return{fact:pair,file:pair.requiredFiles.at(-1)};
}

for(const [label,records,expected] of [
 ['running start',running(),{observedState:'STARTED_RUNNING',processSessionId:'process-one'}],
 ['terminal zero',terminal(0),{observedState:'TERMINATED',exitCode:0}],
 ['terminal nonzero',terminal(7),{observedState:'TERMINATED',exitCode:7}],
 ['terminal signal',[invoke('exec-1','exec',{command:'generic operation'}),result('result-1','exec-1',{status:'failed',exitSignal:'SIGTERM'})],{observedState:'TERMINATED',exitSignal:'SIGTERM'}],
])test('actual workspace ACKs accept factual '+label,async t=>{
 const f=await fixture(t,records);let claim;
 const handle=await f.run(async tools=>{const guide=await navigation(tools);const n=resultFile(guide,'result-1');claim=claimFrom(n.fact);
  for(const [key,value]of Object.entries(expected))assert.equal(claim[key],value);
  await readFact(tools,n.fact);const page=await readWhole(tools.read,n.file);
  await tools.submit('submit_review',submission(claim,page.details.citation.citeId));
 });
 assert.deepEqual(handle.result.metricObjectJudgements[0].processClaims,[claim]);
 assert(handle.sourceCitations.some(c=>c.readProof.processFacts?.some(fact=>fact.resultMessageId==='result-1')));
 if(label==='terminal zero'){
  const outcome=await f.production(handle,'typed-process-preservation');assert.equal(outcome.status,'NO_DEVIATION_FOUND',JSON.stringify(outcome));
  assert.deepEqual(outcome.review.metricObjectJudgements[0].processClaims,[claim]);
  const saved=JSON.parse(await fs.readFile(path.join(taskDirectory(f.root,f.task.taskId),'evaluations',outcome.evaluationId+'.json'),'utf8'));
  assert(saved.reviewPolicyVersion);assert.deepEqual(saved.outcome.review.metricObjectJudgements[0].processClaims,[claim]);
 }
 await handle.close();
});

test('running cannot certify termination; rejected claim remains repairable in same worker',async t=>{
 const f=await fixture(t,running());let attempts=0;
 const handle=await f.run(async tools=>{const guide=await navigation(tools),n=resultFile(guide,'result-1');await readFact(tools,n.fact);
  const page=await readWhole(tools.read,n.file),valid=claimFrom(n.fact),bad={...valid,observedState:'TERMINATED',exitCode:0};
  await assert.rejects(tools.submit('submit_review',submission(bad,page.details.citation.citeId)),{code:'REVIEW_ITEM_EVIDENCE_UNAVAILABLE'});attempts++;
  await tools.submit('submit_review',submission(valid,page.details.citation.citeId));
 });assert.equal(attempts,1);assert.equal(f.calls.length,1);assert.equal(handle.result.metricObjectJudgements[0].processClaims[0].observedState,'STARTED_RUNNING');await handle.close();
});

for(const mode of ['navigation-only','unacknowledged-invocation','invocation-only-citation'])test('native fact needs original read proof: '+mode,async t=>{
 const f=await fixture(t,terminal());let failed=false;
 const handle=await f.run(async tools=>{const guide=await navigation(tools),n=resultFile(guide,'result-1'),claim=claimFrom(n.fact);
  let citeId;
  if(mode==='unacknowledged-invocation')await readWhole(tools.read,n.fact.requiredFiles[0],{receipt:false});
  if(mode!=='navigation-only')citeId=(await readWhole(tools.read,n.file)).details.citation.citeId;
  if(mode==='invocation-only-citation'){
   await readFact(tools,n.fact);citeId=(await readWhole(tools.read,n.fact.requiredFiles[0])).details.citation.citeId;
  }
  await assert.rejects(tools.submit('submit_review',submission(claim,citeId)),{code:'REVIEW_ITEM_EVIDENCE_UNAVAILABLE'});failed=true;
  await readFact(tools,n.fact);citeId=(await readWhole(tools.read,n.file)).details.citation.citeId;
  await tools.submit('submit_review',submission(claim,citeId));
 });assert(failed);assert.equal(handle.result.metricObjectJudgements[0].judgement,'PASS');await handle.close();
});

for(const [label,outcome]of [['exit zero',{status:'completed',sessionId:'process-one',exitCode:0}],
 ['signal with SDK zero fallback',{status:'failed',sessionId:'process-one',exitCode:0,exitSignal:'SIGTERM'}]])
test('poll joins origin and every entry: '+label,async t=>{
 const f=await fixture(t,[...running(),invoke('poll-1','process',{action:'poll',sessionId:'process-one'}),result('poll-result','poll-1',outcome,'Captured poll output.','process')]);
 const handle=await f.run(async tools=>{const guide=await navigation(tools),n=resultFile(guide,'poll-result');assert.equal(n.fact.requiredFileCount,4);
  assert.equal(n.fact.invocationToolCallId,'exec-1');assert.equal(n.fact.resultToolCallId,'poll-1');
  await readWhole(tools.read,n.fact.requiredFiles[2]);const page=await readWhole(tools.read,n.file),claim=claimFrom(n.fact);
  await assert.rejects(tools.submit('submit_review',submission(claim,page.details.citation.citeId)),{code:'REVIEW_ITEM_EVIDENCE_UNAVAILABLE'});
  await readFact(tools,n.fact);
  const origin=resultFile(guide,'result-1'),originPage=await readWhole(tools.read,origin.file);
  await tools.submit('submit_review',{...submission(claim,page.details.citation.citeId),processClaims:[claimFrom(origin.fact),claim],
    citeIds:[originPage.details.citation.citeId,page.details.citation.citeId]});
 });const claims=handle.result.metricObjectJudgements[0].processClaims;
 assert.equal(claims.length,2);assert.equal(claims[0].invocationToolCallId,claims[1].invocationToolCallId);
 assert.equal(claims[1].processSessionId,'process-one');assert.equal(claims[1].exitCode,0);
 if(outcome.exitSignal)assert.equal(claims[1].exitSignal,'SIGTERM');
 await handle.close();
});

test('final collector validates original claims rather than dropping their contradiction',async t=>{
 const f=await fixture(t,terminal(0));
 const handle=await f.run(async tools=>{const guide=await navigation(tools),n=resultFile(guide,'result-1');await readFact(tools,n.fact);
  const page=await readWhole(tools.read,n.file);await tools.submit('submit_review',submission(claimFrom(n.fact),page.details.citation.citeId));
 });
 handle.result.metricObjectJudgements[0].processClaims[0].exitCode=7;
 const outcome=await f.production(handle,'typed-process-contradiction');
 assert.equal(outcome.status,'UNVERIFIED',JSON.stringify(outcome));
 assert.notEqual(outcome.review.metricObjectJudgements[0]?.judgement,'PASS');
 await handle.close();
});

test('every split result part must be acknowledged before a native claim',async t=>{
 const f=await fixture(t,terminal(0,'Captured output '.repeat(3000)));
 const handle=await f.run(async tools=>{const guide=await navigation(tools),n=resultFile(guide,'result-1');assert(n.fact.requiredFileCount>2);assert.equal(n.fact.requiredFilesComplete,true);
  for(const file of n.fact.requiredFiles.slice(0,-1))await readWhole(tools.read,file);
  const page=await readWhole(tools.read,n.fact.requiredFiles[1]),claim=claimFrom(n.fact);
  await assert.rejects(tools.submit('submit_review',submission(claim,page.details.citation.citeId)),{code:'REVIEW_ITEM_EVIDENCE_UNAVAILABLE'});
  await readWhole(tools.read,n.file);await tools.submit('submit_review',submission(claim,page.details.citation.citeId));
 });assert.equal(handle.result.metricObjectJudgements[0].judgement,'PASS');await handle.close();
});

test('mechanical validation cannot bypass a supplied unsupported process claim',()=>{
 assert.throws(()=>validateReviewJudgement({row:{judgement:'PASS',processClaims:[{invocationToolCallId:'x',resultMessageId:'y',resultToolCallId:'x',observedState:'TERMINATED',exitCode:0}]},object:{},citations:[],mechanicalEvidence:true}),{code:'REVIEW_ITEM_EVIDENCE_UNAVAILABLE'});
});

test('SOURCE-owned metric claims retain process snapshot guard; file assessments reject claims explicitly',async t=>{
 const f=await fixture(t,terminal(0),'IMPLEMENTATION');let claimed;
 assert.equal(f.input.schema.properties.fileAssessments.items.properties.processClaims,undefined);
 const handle=await f.run(async tools=>{await tools.readAll();
  const list=await materializeStopChecklist(await tools.submit('review_checklist',{stopClassification:'TASK_COMPLETE',includeProcessEvidence:true}),tools.submit);
  const n=resultFile(list.processEvidence,'result-1');await readFact(tools,n.fact);claimed=claimFrom(n.fact);
  const page=await readWhole(tools.read,n.file);
  await assert.rejects(tools.submit('submit_review',{...submission(claimed,page.details.citation.citeId),taskId:'file:spec.md'}),/processClaims apply to original metric items; omit for file assessments/);
  await tools.submit('submit_review',submission(claimed,page.details.citation.citeId));
 });
 const outcome=await f.production(handle,'source-with-process-claim');assert.equal(outcome.status,'NO_DEVIATION_FOUND',JSON.stringify(outcome));
 assert.deepEqual(outcome.review.metricObjectJudgements[0].processClaims,[claimed]);
 const directory=path.join(taskDirectory(f.root,f.task.taskId),'review-scopes');let checked=0;
 for(const file of await fs.readdir(directory)){
  const scope=JSON.parse(await fs.readFile(path.join(directory,file),'utf8'));
  for(const item of Object.values(scope.items))if(item.current?.result?.processClaims){
   assert.equal(item.current.processDigest,f.input.evidence.snapshot.digest);checked++;
  }
 }
 assert.equal(checked,1);await handle.close();
});

test('omitted claims preserve legacy behavior without certifying free-text completion',async t=>{
 const f=await fixture(t,running());const handle=await f.run(async tools=>{await navigation(tools);
  await tools.submit('submit_review',{taskId:'M12:R1',verdict:'PASS',reason:'Legacy semantic assessment remains untyped.',finish:true});
 });assert.equal(handle.result.metricObjectJudgements[0].judgement,'PASS');assert.equal(handle.result.metricObjectJudgements[0].processClaims,undefined);await handle.close();
});

test('typed claims refuse result bytes changed before first ACK',async t=>{
 const f=await fixture(t,terminal(0));let checked=false;
 const handle=await f.run(async tools=>{const guide=await navigation(tools),n=resultFile(guide,'result-1');
  const file=path.resolve(f.root,n.file),original=await fs.readFile(file,'utf8');
  assert(original.includes('"exitCode":0'));const changed=original.replace('"exitCode":0','"exitCode":7');
  assert.notEqual(changed,original);await fs.writeFile(file,changed);
  await readFact(tools,n.fact);const page=await readWhole(tools.read,n.file);
  assert.equal(page.details.citation.sha256,sha256(changed));
  await assert.rejects(tools.submit('submit_review',submission(claimFrom(n.fact),page.details.citation.citeId)),{code:'REVIEW_ITEM_EVIDENCE_UNAVAILABLE'});
  checked=true;await tools.submit('submit_review',{taskId:'M12:R1',verdict:'UNVERIFIED',reason:'Original captured result bytes were replaced before acknowledgement.',finish:true});
 });assert(checked);assert.equal(handle.result.metricObjectJudgements[0].judgement,'UNVERIFIED');await handle.close();
});

test('typed claims require original bytes in every split part, including an uncited part',async t=>{
 const f=await fixture(t,terminal(0,'Captured output '.repeat(3000)));let checked=false;
 const handle=await f.run(async tools=>{const guide=await navigation(tools),n=resultFile(guide,'result-1');assert(n.fact.requiredFileCount>2);
  const changedFile=path.resolve(f.root,n.fact.requiredFiles[1]);assert.notEqual(changedFile,path.resolve(f.root,n.file));
  const original=await fs.readFile(changedFile,'utf8'),changed=original.replace('Captured output','Modified output');assert.notEqual(changed,original);await fs.writeFile(changedFile,changed);
  await readFact(tools,n.fact);const page=await readWhole(tools.read,n.file);
  await assert.rejects(tools.submit('submit_review',submission(claimFrom(n.fact),page.details.citation.citeId)),{code:'REVIEW_ITEM_EVIDENCE_UNAVAILABLE'});
  checked=true;await tools.submit('submit_review',{taskId:'M12:R1',verdict:'UNVERIFIED',reason:'A required original result part was replaced.',finish:true});
 });assert(checked);assert.equal(handle.result.metricObjectJudgements[0].judgement,'UNVERIFIED');await handle.close();
});

test('unclaimed native parts do not acquire a new global original-byte guard',async t=>{
 const f=await fixture(t,terminal(0));
 const handle=await f.run(async tools=>{const guide=await navigation(tools),n=resultFile(guide,'result-1');
  const file=path.resolve(f.root,n.file),original=await fs.readFile(file,'utf8');await fs.writeFile(file,original.replace('"exitCode":0','"exitCode":7'));
  await tools.submit('submit_review',{taskId:'M12:R1',verdict:'UNVERIFIED',reason:'Legacy untyped process review remains unresolved.',finish:true});
 });assert.equal(handle.result.metricObjectJudgements[0].judgement,'UNVERIFIED');await handle.close();
});
