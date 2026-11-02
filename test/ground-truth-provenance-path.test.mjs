import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {groundTruthSourceCatalog,rejectedGroundTruthSource,groundTruthAdmissionFailure,groundTruthAdmissionContext} from '../lib/runtime-v2/ground-truth-provenance.mjs';

test('an observer-owned ancestor name cannot turn legitimate business materials into internal reviewer evidence',async t=>{
 const parent=path.resolve('.runtime-correction/provenance-tests');await fs.mkdir(parent,{recursive:true});
 const root=await fs.mkdtemp(path.join(parent,'project-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.mkdir(path.join(root,'materials'));const file=path.join(root,'materials/requirements.md');await fs.writeFile(file,'Original business requirement');
 const catalog=await groundTruthSourceCatalog({projectRoot:root,materials:{entries:[{root:path.dirname(file),path:path.basename(file)}]}});
 const operation={authority:'MATERIAL_DERIVED',source:{ref:file,kind:'MATERIAL',subject:'MAIN_TASK'}};
 assert.equal(rejectedGroundTruthSource(operation,catalog),null);
 assert.equal(rejectedGroundTruthSource({...operation,source:{...operation.source,ref:path.join(root,'.runtime-correction/tasks/t/request.json')}},catalog),'INTERNAL_SOURCE');
 const privateFile=path.join(root,'.runtime-correction/reviewer.md');
 const privateCatalog=await groundTruthSourceCatalog({projectRoot:root,materials:{entries:[{root:path.dirname(privateFile),path:path.basename(privateFile)}]}});
 assert.equal(rejectedGroundTruthSource({...operation,source:{...operation.source,ref:privateFile}},privateCatalog),'INTERNAL_SOURCE');
});

test('one pure admission policy preserves old, ambiguous, frozen and NEW_TASK boundaries before and after classification',()=>{
 const catalog=[{ref:'transcript:U1',kind:'USER_MESSAGE',aliases:['user'],contentDigest:'one'},
  {ref:'transcript:U2',kind:'USER_MESSAGE',aliases:['user'],contentDigest:'two'},{ref:'contract.md',kind:'MATERIAL'}];
 const current={version:1,digest:'current',claims:[{claimId:'existing',status:'ACTIVE',authority:'USER_EXPLICIT',source:{ref:'transcript:U1'}}],
  userSourceRefs:['transcript:U1'],userSourceHashes:{'transcript:U1':'one'}};
 const user=ref=>({operation:'ADD',authority:'USER_EXPLICIT',source:{ref,kind:'USER_MESSAGE',subject:'MAIN_TASK'}});
 const material={operation:'ADD',authority:'MATERIAL_DERIVED',source:{ref:'contract.md',kind:'MATERIAL',subject:'MAIN_TASK'}};
 const classify=(operations,taskClassification='CONTINUATION')=>({operations,taskClassification});
 const frozen={...current,frozenAtVersion:1}, before=structuredClone({current,catalog});
 assert.equal(groundTruthAdmissionFailure(classify([user('transcript:U2'),material],'NEW_TASK'),current,catalog),null);
 assert.equal(groundTruthAdmissionFailure(classify([material]),current,catalog,{classificationKnown:false}),null);
 assert.equal(groundTruthAdmissionFailure(classify([user('transcript:U1')],'NEW_TASK'),current,catalog,{classificationKnown:false}),null);
 assert.equal(groundTruthAdmissionFailure(classify([user('transcript:U1')],'NEW_TASK'),current,catalog).reason,'NEW_TASK_WITHOUT_PENDING_USER_OPERATION');
 for(const ref of ['transcript:U1#L1-L1','user'])
  assert.equal(groundTruthAdmissionFailure(classify([user(ref)]),frozen,catalog,{classificationKnown:false}).reason,'PROCESSED_OR_AMBIGUOUS_USER_SOURCE');
 for(const operation of [material,{...user('transcript:U2'),authority:'AGENT_INFERRED'}])
  assert.equal(groundTruthAdmissionFailure(classify([operation]),frozen,catalog,{classificationKnown:false}).reason,'FROZEN_NON_USER_OPERATION');
 assert.equal(groundTruthAdmissionFailure(classify([user('unknown')]),current,catalog).reason,'SOURCE_REJECTED');
 assert.equal(groundTruthAdmissionFailure(classify([{...material,source:{ref:'assistant:review',kind:'MATERIAL'}}]),current,catalog).reason,'SOURCE_REJECTED');
 assert.equal(groundTruthAdmissionFailure(classify([user('transcript:U2')]),frozen,catalog),null);
 assert.equal(groundTruthAdmissionFailure(classify([],'NO_CHANGE'),frozen,catalog),null);
 const consumed={...frozen,userSourceRefs:['transcript:U1','transcript:U2'],userSourceHashes:{'transcript:U1':'one','transcript:U2':'two'}};
 const navigation=groundTruthAdmissionContext(consumed,catalog);
 assert.equal(navigation.mode,'READ_ONLY_RECONCILIATION');assert.deepEqual(navigation.eligibleUserRefs,[]);
 assert.equal(navigation.currentClaims[0].claimId,'existing');assert.match(navigation.repair,/full mode.*NO_CHANGE/u);
 assert.deepEqual({current,catalog},before,'The shared policy must not rewrite sources, claims or candidate operations');
});
