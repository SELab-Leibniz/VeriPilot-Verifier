import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {applyCollateralReceipt} from '../lib/runtime-v2/regression-triage.mjs';
import {installRegressionCaseExclusions} from '../scripts/bench/regression-workspace.mjs';
import {collateralSuiteReceipt} from '../scripts/bench/arkts-regression-check.mjs';

const request={requestId:'bound-rerun',baselineSha256:'baseline',exclusions:[{id:'entry::Suite::obsolete',path:'entry/src/test/suite.test.ets'}],probes:['entry::Suite::dependent','entry::Suite::real regression']};
const reviewed={status:'UNVERIFIED',cases:[{id:'entry::Suite::obsolete',verdict:'AUTHORIZED_CHANGE'},
  {id:'entry::Suite::dependent',verdict:'UNVERIFIED'},{id:'entry::Suite::real regression',verdict:'UNVERIFIED'},
  {id:'already-proven',verdict:'REGRESSION',objectId:'M16:standing'}]};
const baseline={statuses:Object.fromEntries([...request.exclusions.map(x=>x.id),...request.probes].map(id=>[id,'PASS']))};
const current={completeRuntime:true,statuses:{'entry::Suite::dependent':'PASS','entry::Suite::real regression':'FAIL'}};
const proof=()=>collateralSuiteReceipt(request,baseline,current);
const run=p=>({exitCode:1,outputTail:'RC_REGRESSION_COLLATERAL '+JSON.stringify(p)+'\n'});

test('a complete whole-suite rerun removes collateral failure while preserving a genuine regression',()=>{
  const result=applyCollateralReceipt(reviewed,request,run(proof()));
  assert.deepEqual(result.cases.map(x=>x.verdict),['AUTHORIZED_CHANGE','COLLATERAL_FAILURE','UNVERIFIED','REGRESSION']);
  assert.equal(result.status,'UNVERIFIED');
  assert.equal(result.cases[3].objectId,'M16:standing');
});

test('a passing isolate, partial suite, changed exclusion or stale receipt never grants an exemption',()=>{
  const p=proof();
  for(const bad of [{...p,requestId:'old'},{...p,baselineSha256:'other'},{...p,complete:false},
    {...p,excludedIds:[...p.excludedIds,'unreviewed']},{...p,taskStartSuite:false},
    {...p,failures:undefined},{...p,failures:[...p.failures,'newly-exposed-real-regression']},
    {...p,observedSurvivingCount:1}])assert.equal(applyCollateralReceipt(reviewed,request,run(bad)),reviewed);
  for(const bad of [{...run(p),exitCode:2},{...run(p),reason:'TIMEOUT'},
    {...run(p),outputTail:'RC_REGRESSION_CASE {"status":"PASS"}'},
    {...run(p),outputTail:run(p).outputTail.repeat(2)}])assert.equal(applyCollateralReceipt(reviewed,request,bad),reviewed);
});

test('whole-suite receipt rejects missing survivors and exclusions that still ran',()=>{
  assert.equal(proof().complete,true);
  assert.equal(collateralSuiteReceipt(request,baseline,{...current,statuses:{'entry::Suite::dependent':'PASS'}}).complete,false);
  assert.equal(collateralSuiteReceipt(request,baseline,{...current,statuses:{...current.statuses,'entry::Suite::obsolete':'FAIL'}}).complete,false);
});

test('an exact public registration is disabled only in the disposable tree; ambiguous targets fail closed',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'rc-public-exclusion-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const file=path.join(root,request.exclusions[0].path);await fs.mkdir(path.dirname(file),{recursive:true});
  const source="describe('Suite', () => {\n  it('obsolete', 0, () => {});\n  it('dependent', 0, () => {});\n});\n";
  await fs.writeFile(file,source);
  await installRegressionCaseExclusions(root,request.exclusions);
  const modified=await fs.readFile(file,'utf8');assert(modified.includes("if (false) it('obsolete'"));assert(modified.includes("  it('dependent'"));
  await fs.writeFile(file,source.replace("  it('dependent'", "  it('obsolete'"));
  await assert.rejects(installRegressionCaseExclusions(root,request.exclusions),/ambiguous/);
  await assert.rejects(installRegressionCaseExclusions(root,[{...request.exclusions[0],path:'../outside.test.ets'}]),/identity/);
});
