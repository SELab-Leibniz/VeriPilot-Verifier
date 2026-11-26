// Scripted decisions, actual SessionStart/Stop, source receipts and public correction.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { initialSddText } from './helpers/initial-sdd-pressure.mjs';
const [revision, experiment, out, mode] = process.argv.slice(2);
assert(['before','after'].includes(mode));
await fs.mkdir(out);
const load = (root, file) => import(pathToFileURL(path.resolve(root,file)));
const { handleRuntimeV2Event } = await load(revision,'lib/runtime-v2/orchestrator.mjs');
const { compileRuntimeV2Config } = await load(revision,'lib/runtime-v2/config.mjs');
const { ensureTask } = await load(revision,'lib/runtime-v2/task-store.mjs');
const { scriptedWorkspaceReview } = await load(revision,'test/helpers/scripted-workspace-review.mjs');
const { materialize } = await load(experiment,'corpus/store.mjs');
const runtimeV2 = compileRuntimeV2Config({version:2,dynamicGroundTruth:{enabled:false},
  stopCorrection:{enabled:true,originalRequirementsBasis:true,deviationOnly:true}});
const json = async file => JSON.parse(await fs.readFile(file,'utf8'));
const sha = data => createHash('sha256').update(data).digest('hex');
const unpack = result => JSON.parse(result.content[0].text);
const frame = {stopClassification:'TASK_COMPLETE',completionClaim:true};
async function hook({workspace,transcript,sessionId}, stopId, script, start) {
  const entries = (await fs.readFile(transcript,'utf8')).trim().split('\n').map(JSON.parse);
  const event = name => handleRuntimeV2Event({projectRoot:workspace,plan:{artifacts:[],runtimeV2},
    reviewerFactory:input => scriptedWorkspaceReview(input,{script:async args=>{try{return await script(args);}catch(error){console.error(error.code,error.message);throw error;}}}),
    stopHost:{directory:path.join(workspace,'.runtime-correction','host'),stopId,startProtocol:{version:1}},
    input:{session_id:sessionId,hook_event_name:name,cwd:workspace,transcript_path:transcript,
      source:'startup',last_assistant_message:entries.at(-1).message.content}});
  if(start){await ensureTask({projectRoot:workspace,sessionId});await event('SessionStart');}
  const {stop} = await event('Stop');
  return {status:stop.status,code:stop.reasonCode,decision:stop.decision,feedback:stop.feedback,
    partialFeedbackEligible:stop.partialFeedbackEligible,report:stop.acceptanceReport,coverage:stop.coverage};
}
const results = {};
async function save(){await fs.writeFile(path.join(out,'observations.json'),JSON.stringify(results,null,2));}
const workspace=path.resolve(out,'sdd'), sessionId='partial-review',transcript=path.join(workspace,'session.jsonl');
await fs.mkdir(workspace);
const lines=initialSddText(4547,'chinese').split('\n');
lines[0]='# SDD. Only lines 2, 3 and the final line specify acceptance conditions. All intervening text is historical background.';
lines[1]='Sealed mode must allow zero retries.';
lines[2]='The operator signoff file must contain the word approved.';
lines[lines.length-1]='Standard mode must allow three retries.';
const spec=path.join(workspace,'AGENTS.md'), impl=path.join(workspace,'retry.mjs');
await fs.writeFile(spec,lines.join('\n'));await fs.writeFile(impl,'export const retries = {sealed:3,standard:3};\n');
const entries=[{type:'user',uuid:'request',message:{content:'Implement AGENTS.md in full.'}},
  {type:'assistant',uuid:'delivery',message:{content:'Task complete.'}}];
const writeTranscript=()=>fs.writeFile(transcript,entries.map(x=>JSON.stringify(x)).join('\n')+'\n');
await writeTranscript();
const item=n=>({metricId:'M16',text:lines[n-1],verificationTarget:'IMPLEMENTATION',path:spec,lineStart:n,lineEnd:n});
const trace=[];
const first=await hook({workspace,sessionId,transcript},'first',async({task,call,read,worker})=>{
  assert(task.basisFiles.includes(spec),'The pressure document must be a mandatory source.');
  for(const f of task.basisFiles) if(f!==spec) await read(f);
  await call('source_read',{path:spec,offset:1,limit:10});await read(impl);
  await call('append_original_checklist',{items:[item(2),item(3)]});
  try {await call('seal_original_checklist',{partial:true,extractedRanges:[{path:spec,start:1,end:10}]});}
  catch(err){
    trace.push(err.code);
    if(mode==='before') try { await call('seal_original_checklist',{}); } catch(original){trace.push(original.code);throw original;}
    throw err;
  }
  const page=unpack(await call('review_checklist',frame));
  for(const o of [...page.items].sort((a,b)=>Number(a.description===lines[1])-Number(b.description===lines[1]))){
    if(o.description===lines[2]) await call('submit_review',{taskId:o.taskId,verdict:'UNVERIFIED',reason:'Operator signoff is unavailable.'});
    if(o.description===lines[1]) await call('submit_review',{taskId:o.taskId,verdict:'DEVIATION',reason:'Sealed mode returns 3 retries; change it to 0.',citations:[{path:impl,start:1,end:1}]});
  }
  assert(worker.isComplete(),'Native host must be able to return immediately after the saved defect.');
  trace.push('interrupted-after-receipts');throw Object.assign(new Error('Host context interrupted'),{code:'CONTEXT_OVERFLOW'});
},true);
results.early={sha256:sha(lines.join('\n')),lines:lines.length,trace,first};await save();
// The same business repair and follow-up transcript are replayed on both revisions.
await fs.writeFile(impl,'export const retries = {sealed:0,standard:3};\n');
await fs.writeFile(path.join(workspace,'signoff.txt'),'approved');
entries.push({type:'assistant',uuid:'repair',message:{content:'Fixed sealed mode and delivered operator signoff. Task complete.'}});
await writeTranscript();
if(mode==='after'){
  assert(first.partialFeedbackEligible && first.decision==='block' && first.report.confirmedDeviations.length===1,JSON.stringify(first));
  assert(first.report.missingEvidence.some(x=>x.reason.includes('signoff')));
  assert(first.report.unreviewedScope.some(x=>x.reason.includes('11')));
  const resumed=await hook({workspace,sessionId,transcript},'second',async({task,call,read})=>{
    assert(task.extractionResume.ranges.some(r=>r.end===10));
    for(const f of task.basisFiles) if(f!==spec) await read(f);
    let offset=11;
    while(offset!==null){const r=await call('source_read',{path:spec,offset,limit:200});offset=r.details.page.nextOffset;}
    await call('append_original_checklist',{items:[item(lines.length)]});
    await call('seal_original_checklist',{});
    const page=unpack(await call('review_checklist',frame));assert.equal(page.items.length,3);
    const citeId=await read(impl);await read(path.join(workspace,'signoff.txt'));
    assert.equal((await fs.readFile(path.join(workspace,'signoff.txt'),'utf8')).trim(),'approved');
    assert.deepEqual((await import(pathToFileURL(impl))).retries,{sealed:0,standard:3});
    for(const o of page.items) if(o.previousDeviation) await call('submit_review',{taskId:o.taskId,verdict:'PASS',reason:'Sealed mode now has zero retries.',citeIds:[citeId]});
    await call('finish_stop_review',{summary:'Reviewed the remaining original and the current repaired implementation.'});
  },false);
  results.early.resumed=resumed;await save();assert.equal(resumed.status,'NO_DEVIATION_FOUND',JSON.stringify(resumed));
} else {
  assert.equal(first.report.confirmedDeviations.length,0);
  assert(trace.includes('TASK_BASIS_UNREAD'));
  const resumed=await hook({workspace,sessionId,transcript},'second',async({task,call,read})=>{
    for(const f of task.basisFiles) if(f!==spec) await read(f);
    let offset=11;
    while(offset!==null) offset=(await call('source_read',{path:spec,offset,limit:200})).details.page.nextOffset;
    await call('append_original_checklist',{items:[item(lines.length)]});
    await call('seal_original_checklist',{});
  },false);
  results.early.resumed=resumed;await save();assert.equal(resumed.status,'UNVERIFIED');
}
const trials=(await json(path.join(experiment,'explore-r1a-real/results.json'))).trials;
for(const [id,name] of [['t-bfa76c3174a7d07042','crossStage'],['t-3d89a0524144a149d5','oldExecution'],
  ...(mode==='after'?[['t-bfa76c3174a7d07042','crossStageChecked']]:[])]){
  const fixture=await materialize(id,path.join(out,name));
  const attempt=trials.find(t=>t.id===id).candidate.attemptId;
  const base=path.join(experiment,'runs/versions/r1a-explore/artifacts',attempt,'raw/reviews');
  const folder=path.join(base,(await fs.readdir(base))[0]);
  const basis=await json(path.join(folder,'original-checklist.json')), saved=await json(path.join(folder,'review.json'));
  const submissions=[];
  const stop=await hook(fixture,name,async({task,call,read})=>{
    for(const file of task.basisFiles){
      if(file.endsWith('exchange.json')){
        let at=0;do{at=unpack(await call('source_read',{path:file,byteOffset:at,byteLimit:3400})).page.nextByteOffset;}while(at!==null);
      }else await read(file);
    }
    const items=Object.values(basis.population.metrics).flat().filter(o=>o.originalSource).map(o=>{
      const s=o.originalSource;
      return {metricId:o.metricId,text:o.description,verificationTarget:o.verificationTarget,
        ...(o.implementationRole?{implementationRole:o.implementationRole}:{}),path:s.kind==='USER_MESSAGE'?task.basisFiles.find(f=>path.basename(f).startsWith('user-original')):path.join(fixture.workspace,s.ref),lineStart:s.start,lineEnd:s.end};
    });
    await call('set_original_checklist',{items});
    const page=unpack(await call('review_checklist',frame));
    for(const row of saved.metricObjectJudgements){
      const original=Object.values(basis.population.metrics).flat().find(o=>o.objectId===row.objectId);
      const o=page.items.find(o=>o.description===original.description);
      const citations=saved.citations.filter(c=>c.usedBy.includes(row.objectId)).map(c=>({path:c.path.includes('\\execution\\')?path.join(task.processDirectory,path.basename(c.path)):path.join(fixture.workspace,c.path.split('\\workspace\\').at(-1)),start:c.start,end:c.end}));
      try {
        submissions.push(unpack(await call('submit_review',{taskId:o.taskId,verdict:row.judgement,reason:row.reason,citations})));
      } catch(error) {
        if(error.code!=='TASK_CITATION_INVALID') throw error;
        submissions.push({rejected:error.code,reason:error.message});
      }
    }
    const checkedGroups=[];
    if(name==='crossStageChecked'){
      const file=name=>path.join(fixture.workspace,name);
      const expected=[...(await fs.readFile(file('docs/brief.md'),'utf8')).matchAll(/^区段 (\S+) 在(.+?)环节由(.+?)接手，检修分钟按 (\d+) 执行/gmu)]
        .map(([,key,route,owner,n])=>({key,owner,route,limit:Number(n)}));
      const catalog=await json(file('catalog/index.json')),actual=[],citations=[];
      for(const name of catalog){
        const rows=(await fs.readFile(file(name),'utf8')).trim().split('\n').map(JSON.parse);
        actual.push(...rows);citations.push({path:file(name),start:1,end:rows.length});
      }
      assert.equal(expected.length,288);assert.deepEqual(actual,expected);
      const version=(await json(file('release.json'))).revision;
      const manifest={path:file('release.json'),start:3,end:3};
      const phases=[];
      for(const phase of ['approved','implemented','archived']){
        const source=file('workflow/'+phase+'.json');assert.equal((await json(source)).revision,version);
        phases.push({path:source,start:3,end:3});
      }
      await read(path.join(task.processDirectory,'000004-0000.txt'));
      const run={path:path.join(task.processDirectory,'000005-0000.txt'),start:1,end:1};
      await read(run.path);
      for(const o of page.items.filter(o=>o.groupCheckRequired)){
        const process=o.verificationTarget==='PROCESS', stage=o.originalSource.start===3;
        checkedGroups.push({taskIds:[o.taskId],method:process?'Matched invocation and output to delivery revision.':
          stage?'Compared three workflow revisions with current delivery.':'Compared every keyed tuple in the active catalog with its original.',
          citations:process?[manifest,run]:stage?[manifest,...phases]:citations});
      }
      assert.equal(checkedGroups.length,3);
    }
    await call('finish_stop_review',{summary:saved.summary,...(checkedGroups.length?{checkedGroups}:{})});
  },true);
  results[name]={id,attempt,submissions,stop};await save();
  if (mode==='after' && name==='crossStage') {
    assert.equal(stop.coverage.scanCompleted,false);
    assert(stop.report.unreviewedScope.some(item=>item.reason.includes('区段')));
  }
  if (mode==='after' && name==='oldExecution') {
    assert.equal(stop.report.confirmedDeviations.length,0);
    assert.equal(submissions.filter(s=>s.rejected==='TASK_CITATION_INVALID').length,2);
    assert(stop.report.missingEvidence.some(item=>item.reason.includes('RIV-410') && item.reason.includes('RIV-411')));
  }
  assert.equal(stop.status,name==='crossStageChecked'||mode==='before'&&name==='crossStage'?'NO_DEVIATION_FOUND':mode==='before'?'DEVIATION':'UNVERIFIED',JSON.stringify(stop));
}
console.log(out);
