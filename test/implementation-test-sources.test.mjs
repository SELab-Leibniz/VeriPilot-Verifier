import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {runImplementationReview,collectSourceManifest} from '../lib/runtime-v2/impl-review.mjs';
import {compileRuntimeV2Config} from '../lib/runtime-v2/config.mjs';
import {ensureTask} from '../lib/runtime-v2/task-store.mjs';
import {withTestReviewProof} from './helpers/review-proof.mjs';

test('M12 receives first-party test code while production-only M16 stays isolated',async t=>{
 const parent=path.resolve('.runtime-correction/test-temp');await fs.mkdir(parent,{recursive:true});
 const root=await fs.mkdtemp(path.join(parent,'impl-test-source-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.writeFile(path.join(root,'todo.py'),'def value(): return 42\n');
 await fs.writeFile(path.join(root,'test_todo.py'),'import unittest\n');
 const task=await ensureTask({projectRoot:root,sessionId:'contract'}),scopes=[];
 const sourceId='test-contract',object=metricId=>({objectId:metricId+':'+sourceId,metricId,sourceId,sourceRevisionId:sourceId+'@1',
  verificationTarget:'IMPLEMENTATION',authority:'USER_EXPLICIT',hard:true,description:'Deliver test_todo.py using unittest.'});
 const population={metrics:{M12:[object('M12')],M16:[object('M16')]},reviewPolicy:{metrics:{M09:false,M12:true,M16:true}}};
 const groundTruth={taskId:task.taskId,version:1,digest:'frozen',claims:[{claimId:sourceId,category:'testContracts',text:object('M12').description,
  status:'ACTIVE',severity:'HARD',authority:'USER_EXPLICIT',verificationTarget:'IMPLEMENTATION'}]};
 const factory=Object.assign(async params=>{
  const objects=Object.values(params.request.population.metrics).flat(),paths=params.request.sourceManifest.map(file=>file.path);
  scopes.push({metrics:objects.map(object=>object.metricId),paths});
  const rows=objects.map(object=>object.metricId==='M12'?{objectId:object.objectId,judgement:paths.includes('test_todo.py')?'PASS':'DEVIATION',
   reason:paths.includes('test_todo.py')?'The assigned test source is present.':'The bounded source view incorrectly appears to have no test_todo.py.',
   evidence:[(paths.includes('test_todo.py')?'test_todo.py':'todo.py')+'#L1']}:
   {objectId:object.objectId,judgement:'UNVERIFIED',reason:'This contract exercises source partition, not a production trace.',evidence:[]});
  return withTestReviewProof(params,{result:{summary:'Controlled source-scope contract',findings:[],metricObjectJudgements:rows},close:async()=>{}});
 },{supportsReviewCollection:true});
 const runtimeV2=compileRuntimeV2Config({version:2,dynamicGroundTruth:{enabled:false},implementationCorrection:{enabled:true,platform:null}});
 const result=await runImplementationReview({projectRoot:root,sessionCwd:root,taskId:task.taskId,parentSessionId:'contract',runtimeV2,population,groundTruth,
  reviewerFactory:factory,deviceVerifier:async()=>({findings:[],assurance:{level:'static'},build:{status:'skipped'},smoke:{status:'skipped'}})});
 assert.equal(result.metricObjectJudgements.find(row=>row.objectId==='M12:'+sourceId).judgement,'PASS',JSON.stringify({result,scopes}));
 assert(scopes.find(scope=>scope.metrics.includes('M12')).paths.includes('test_todo.py'));
 assert(!scopes.find(scope=>scope.metrics.includes('M16')).paths.includes('test_todo.py'));
 assert.equal(result.metricObjectJudgements.find(row=>row.objectId==='M16:'+sourceId).judgement,'UNVERIFIED');
});

test('test-source expansion preserves private exclusions and production separation at every depth',async t=>{
 const parent=path.resolve('.runtime-correction/test-temp');await fs.mkdir(parent,{recursive:true});
 const root=await fs.mkdtemp(path.join(parent,'impl-manifest-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const files=['todo.py','test_todo.py','src/value.py','src/value.test.js','tests/test_value.py','__tests__/value.spec.js',
  'tests/secrets.py','src/auth.json','tests/.env.py','tests/node_modules/fake.py','.runtime-correction/tests/fake.py'];
 for(const file of files){await fs.mkdir(path.dirname(path.join(root,file)),{recursive:true});await fs.writeFile(path.join(root,file),'pass\n');}
 const production=(await collectSourceManifest(root)).map(file=>file.path);
 const expanded=(await collectSourceManifest(root,null,{includeTestSources:true})).map(file=>file.path);
 assert.deepEqual(production.sort(),['src/value.py','todo.py']);
 assert.deepEqual(expanded.sort(),files.slice(0,6).sort());
});

for(const supportsReviewCollection of [false,true])test(`test citations cannot prove M16 through ${supportsReviewCollection?'collection':'legacy mixed'} transport`,async t=>{
 const parent=path.resolve('.runtime-correction/test-temp');await fs.mkdir(parent,{recursive:true});
 const root=await fs.mkdtemp(path.join(parent,'impl-production-fence-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.writeFile(path.join(root,'todo.py'),'pass\n');await fs.writeFile(path.join(root,'test_todo.py'),'import unittest\n');
 const task=await ensureTask({projectRoot:root,sessionId:'contract'});
 const object=metricId=>({objectId:metricId+':test',metricId,sourceId:'test',verificationTarget:'IMPLEMENTATION',description:'Source contract'});
 const population={metrics:{M12:[object('M12')],M16:[object('M16')]},reviewPolicy:{metrics:{M09:false,M12:true,M16:true}}};
 const factory=Object.assign(async params=>withTestReviewProof(params,{result:{summary:'Deliberately invalid production oracle',findings:[],
  metricObjectJudgements:Object.values(params.request.population.metrics).flat().map(object=>({objectId:object.objectId,judgement:'PASS',reason:'Test code only',evidence:['test_todo.py#L1']}))},close:async()=>{}}),{supportsReviewCollection});
 const result=await runImplementationReview({projectRoot:root,sessionCwd:root,taskId:task.taskId,parentSessionId:'contract',
  runtimeV2:compileRuntimeV2Config({version:2,implementationCorrection:{enabled:true,platform:null}}),population,groundTruth:{claims:[]},reviewerFactory:factory,
  deviceVerifier:async()=>({findings:[],assurance:{level:'static'},build:{status:'skipped'},smoke:{status:'skipped'}})});
 assert.equal(result.status,'FAILED');
 assert.equal(result.metricObjectJudgements.find(row=>row.objectId==='M12:test').judgement,'PASS');
 assert(['CHECKER_ERROR','UNVERIFIED'].includes(result.metricObjectJudgements.find(row=>row.objectId==='M16:test').judgement));
 if(!supportsReviewCollection)assert.equal(result.reviewerJudgements.find(row=>row.objectId==='M16:test').judgement,'PASS','retain the invalid raw conclusion for audit');
});
