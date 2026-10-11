import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {readReport} from '../lib/openclaw/report.mjs';
import {ensureTask,withTaskState,taskDirectory} from '../lib/runtime-v2/task-store.mjs';
import {atomicWriteJson,sha256} from '../lib/runtime-v2/utils.mjs';

async function fixture(t) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'rc-retained-observation-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const task=await ensureTask({projectRoot:root,sessionId:'host'});await withTaskState({projectRoot:root,taskId:task.taskId},s=>{s.groundTruth.version=1;s.verification={status:'UNVERIFIED'};});
 const directory=taskDirectory(root,task.taskId),file=path.join(root,'ACCEPTANCE.md');await fs.writeFile(file,'# Acceptance\nOverstated current verification\n');
 const ids=['M03:R1','M06:R1','M13:R1'];await atomicWriteJson(path.join(directory,'metrics/population.json'),{groundTruthVersion:1,metrics:{M03:ids.map(objectId=>({objectId,sourceId:'R1'}))}});
 const save=async(name,status,judgement)=>atomicWriteJson(path.join(directory,'evaluations',name),{evaluationId:name,metricReport:{groundTruthVersion:1,status,metrics:[{objects:ids.map(objectId=>({objectId,sourceId:'R1',judgement,reason:'The stated verification exceeds the actual recorded scope.'}))}]},sourceCitations:ids.map(id=>({path:file,contentHash:sha256('# Acceptance\nOverstated current verification\n'),start:2,end:2,usedBy:[id]}))});
 await save('stop-0001.json','CHECKER_ERROR','DEVIATION');await save('stop-0002.json','CHECKER_ERROR','PASS');
 return {root,task,file,save,binding:{workspaceDir:root,sessionId:'host'}};
}
test('later checker failure cannot hide current source-bound observations or convert partial PASS to closure',async t=>{
 const f=await fixture(t);const r=await readReport(f.binding);assert.equal(r.verification,'UNVERIFIED');assert.equal(r.retainedObservations.length,1);assert.equal(r.retainedObservations[0].objectIds.length,3);assert.match(r.summary,/已有依据支持的偏离/);assert.match(r.summary,/ACCEPTANCE\.md#L2-L2/);assert.doesNotMatch(r.summary,/^\*\*验收通过/);
});
test('changed source bytes or changed requirement version invalidate retained observations',async t=>{
 const f=await fixture(t);await fs.writeFile(f.file,'# Changed bytes\n');assert.equal((await readReport(f.binding)).retainedObservations.length,0);
 await fs.writeFile(f.file,'# Acceptance\nOverstated current verification\n');await withTaskState({projectRoot:f.root,taskId:f.task.taskId},s=>{s.groundTruth.version=2;});assert.equal((await readReport(f.binding)).retainedObservations.length,0);
});
test('later complete valid PASS suppresses earlier observation without changing task verification',async t=>{
 const f=await fixture(t);await f.save('stop-0003.json','PASS','PASS');const r=await readReport(f.binding);assert.equal(r.retainedObservations.length,0);assert.equal(r.verification,'UNVERIFIED');
});

test('native partial output is retained in the final report with exact current identities and citations',async t=>{
 const f=await fixture(t), directory=taskDirectory(f.root,f.task.taskId);
 const citation=id=>({path:f.file,contentHash:sha256('# Acceptance\nOverstated current verification\n'),start:2,end:2,usedBy:[id]});
 await atomicWriteJson(path.join(directory,'evaluations/stop-0003.json'),{evaluationId:'stop-0003',status:'UNVERIFIED',partialReview:{requirementVersion:1,metricObjectJudgements:[
  {objectId:'M03:R1',judgement:'DEVIATION',reason:'Current documented scope remains partial.'},
  {objectId:'M06:R1',judgement:'PASS',reason:'One completed check.'},
  {objectId:'not-owned',judgement:'DEVIATION',reason:'Must never be shown.'}],citations:['M03:R1','M06:R1','not-owned'].map(citation)}});
 const r=await readReport(f.binding);assert.equal(r.verification,'UNVERIFIED');assert.equal(r.retainedObservations.length,1);
 assert.deepEqual(r.partialProgress,{evaluationId:'stop-0003',saved:2,total:3,missing:1});assert.match(r.summary,/已保存 2\/3/);assert.doesNotMatch(r.summary,/Must never be shown/);
 await f.save('stop-0004.json','PASS','PASS');assert.equal((await readReport(f.binding)).partialProgress,null);await fs.unlink(path.join(directory,'evaluations/stop-0004.json'));
 await fs.writeFile(f.file,'changed');const changed=await readReport(f.binding);assert.equal(changed.retainedObservations.length,0);assert.equal(changed.partialProgress.saved,0);
});

test('current stage PASS is reported as stage-only, while changed evidence remains stale',async t=>{
 const f=await fixture(t),directory=taskDirectory(f.root,f.task.taskId);await f.save('stop-0003.json','PASS','PASS');const evalFile=path.join(directory,'evaluations/stop-0003.json');const evaluation=JSON.parse(await fs.readFile(evalFile,'utf8'));evaluation.review={stopClassification:'STAGE_COMPLETE'};await atomicWriteJson(evalFile,evaluation);
 await withTaskState({projectRoot:f.root,taskId:f.task.taskId},s=>{s.status='ACTIVE';s.groundTruth.digest='requirements';s.control??={cancelEpoch:0};s.control.generation='owner';s.verification={status:'PASS',evaluationId:'stop-0003',assessmentId:'a',requirementVersion:1,requirementDigest:'requirements',rulesDigest:'rules',generation:'owner',cancelEpoch:s.control.cancelEpoch,evidence:{files:[f.file],fingerprints:{[f.file]:sha256('# Acceptance\nOverstated current verification\n')}}};});
 const current=await readReport(f.binding);assert.equal(current.stageVerified,true);assert.equal(current.verification,'UNVERIFIED');assert.match(current.summary,/当前阶段验收通过/);assert.doesNotMatch(current.summary,/验收结论已失效/);
 await fs.writeFile(f.file,'Changed source');const changed=await readReport(f.binding);assert.equal(changed.stageVerified,false);assert.equal(changed.verification,'STALE');assert.match(changed.summary,/验收结论已失效/);
});
