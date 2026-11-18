import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {applyCollateralReceipt} from '../lib/runtime-v2/regression-triage.mjs';
import { confirmCollateralRegressionFailures, runStopRegressionCheck, STANDING_REGRESSION } from '../lib/runtime-v2/regression-evidence.mjs';
import { normalizeRegressionCheck } from '../lib/runtime-v2/stop-correction-config.mjs';
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
  assert.equal(collateralSuiteReceipt(request,baseline,{...current,statuses:{...current.statuses,'entry::Suite::unexpected':'PASS'}}).complete,false);
});

test('a task-start verifier dispatches collateral checks only with the explicit protocol', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-collateral-protocol-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, 'project');
  await fs.mkdir(projectRoot);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
    '-c', 'commit.gpgsign=false', ...args], { cwd: projectRoot, windowsHide: true, stdio: 'pipe' });
  git('init', '-q');
  git('commit', '--allow-empty', '-qm', 'task start');

  const verifier = path.join(root, 'verify.mjs');
  const baselineFile = path.join(root, 'baseline.json');
  const outputDirectory = path.join(root, 'evidence');
  const failures = [...request.exclusions.map(item => item.id), ...request.probes].map(id => ({ id, title: id }));
  const inventory = { complete: true, failures: failures.map(failure => ({ ...failure,
    originalTest: { path: request.exclusions[0].path } })) };
  await fs.writeFile(baselineFile, JSON.stringify({ completeRuntime: true, ...baseline }));
  await fs.writeFile(verifier, `import fs from 'node:fs';
    const prefix = '--exclude-cases=';
    const flag = process.argv.find(arg => arg.startsWith(prefix));
    if (!flag) {
      console.log('RC_REGRESSION_INVENTORY ' + JSON.stringify({ complete: true, failures: ${JSON.stringify(failures)} }));
    } else {
      const request = JSON.parse(fs.readFileSync(flag.slice(prefix.length), 'utf8'));
      const proof = { requestId: request.requestId, baselineSha256: request.baselineSha256,
        taskStartSuite: true, complete: true, excludedIds: request.exclusions.map(item => item.id),
        expectedSurvivingCount: 2, observedSurvivingCount: 2,
        failures: [request.probes[1]], probes: { [request.probes[0]]: 'PASS', [request.probes[1]]: 'FAIL' } };
      console.log('RC_REGRESSION_COLLATERAL ' + JSON.stringify(proof));
    }
    process.exitCode = 1;
  `);
  const population = { metrics: { M16: [{ programStanding: STANDING_REGRESSION }] } };
  const initial = collateralProtocol => runStopRegressionCheck({ projectRoot, population,
    config: normalizeRegressionCheck({ enabled: true, testSource: 'task-start', command: [process.execPath, verifier],
      baselineFile, ...(collateralProtocol ? { collateralProtocol } : {}) }) });
  const confirm = run => confirmCollateralRegressionFailures({ projectRoot, inventory, reviewed, run, outputDirectory });
  const ordinary = await initial();
  assert.equal(ordinary.status, 'FAILED');
  assert.equal(await confirm(ordinary), reviewed);
  await assert.rejects(fs.access(outputDirectory), { code: 'ENOENT' });

  const controlled = await initial('exclude-cases-v1');
  assert.equal(controlled.collateralProtocol, 'exclude-cases-v1');
  assert.notEqual(controlled.key, ordinary.key);
  const confirmed = await confirm(controlled);
  assert.deepEqual(confirmed.cases.map(item => item.verdict),
    ['AUTHORIZED_CHANGE', 'COLLATERAL_FAILURE', 'UNVERIFIED', 'REGRESSION']);
  assert.equal((await fs.readdir(outputDirectory)).length, 2);
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
