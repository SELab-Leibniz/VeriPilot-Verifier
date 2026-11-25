import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {captureBusinessCheckpoint,arktsBusinessDiffScope} from '../scripts/bench/business-checkpoint.mjs';
import {completeReleaseOpenSpecWorkflow,runArchiveCurrentChecks} from '../scripts/bench/release-openspec-archive.mjs';
import {arktsInstrumentRuntime} from '../scripts/bench/arkts-instrument-results.mjs';
import {localTestEvidence} from '../scripts/bench/local-test-evidence.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const report=(status='PASS',title='preserves settings')=>{
  const frame=code=>['OHOS_REPORT_STATUS: class=Settings','OHOS_REPORT_STATUS: current=1','OHOS_REPORT_STATUS: id=JS',
    'OHOS_REPORT_STATUS: numtests=1','OHOS_REPORT_STATUS: test='+title,'OHOS_REPORT_STATUS_CODE: '+code].join('\n');
  return [frame(1),frame(status==='PASS'?0:-2),
    `OHOS_REPORT_RESULT: stream=Tests run: 1, Failure: ${status==='PASS'?0:1}, Error: 0, Pass: ${status==='PASS'?1:0}, Ignore: 0`,
    'OHOS_REPORT_CODE: '+(status==='PASS'?0:-1),'TestFinished-ResultCode: 0','user test finished.'].join('\n');
};
const tested=(status='PASS',extra={})=>({execution:{runtime:arktsInstrumentRuntime,compileSucceeded:true,
  exitCode:status==='PASS'?0:1,outputComplete:true,interrupted:false,...extra},output:'scripted native protocol output',
  raw:report(status),freshReport:true});

async function fixture(t) {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'rc-archive-workflow-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const projectRoot=path.join(root,'project'),outputRoot=path.join(root,'run'),active='openspec/changes/settings';
  await fs.mkdir(projectRoot);await fs.mkdir(outputRoot);
  const configs=path.join(root,'empty-git-config');await fs.writeFile(configs,'');
  const prior={GIT_CONFIG_GLOBAL:process.env.GIT_CONFIG_GLOBAL,GIT_CONFIG_SYSTEM:process.env.GIT_CONFIG_SYSTEM,
    GIT_CONFIG_NOSYSTEM:process.env.GIT_CONFIG_NOSYSTEM};
  Object.assign(process.env,{GIT_CONFIG_GLOBAL:configs,GIT_CONFIG_SYSTEM:configs,GIT_CONFIG_NOSYSTEM:'1'});
  t.after(()=>{for(const [key,value]of Object.entries(prior))if(value===undefined)delete process.env[key];else process.env[key]=value;});
  const git=(...args)=>execFileSync('git',['-c','core.longpaths=true','-C',projectRoot,...args],
    {windowsHide:true,maxBuffer:8*1024*1024,stdio:['ignore','pipe','pipe']});
  const commit=message=>git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','core.hooksPath=nonexistent',
    'commit','--quiet','--allow-empty','-m',message);
  const put=async(file,body)=>{const full=path.join(projectRoot,file);await fs.mkdir(path.dirname(full),{recursive:true});await fs.writeFile(full,body);};
  git('init','--quiet');
  await put('src/main.mjs','export const setting = false;\n');
  await put('.opencode/workflow.md','fixed workflow');await put('.runtime-corrector/config.yaml','fixed policy');
  await put('openspec/specs/settings/spec.md','# Settings\nOld master specification.\n');
  git('add','--all');commit('Prepared shared workspace');
  const preparedHead=git('rev-parse','HEAD').toString().trim();
  await put(active+'/proposal.md','# Proposal\nPreserve the original setting requirement.\n');
  await put(active+'/design.md','# Design\nUse one local setting.\n');
  await put(active+'/tasks.md','- [ ] Implement the original requirement\n');
  await put(active+'/specs/settings/spec.md','# Delta\nOriginal complete setting requirement.\n');
  const proposalCheckpoint=await captureBusinessCheckpoint({outputRoot,projectRoot,preparedHead,
    runId:'proposal-run',sessionId:'session',success:true,includeBusinessPatch:true,proposalRepairChange:'settings',requireProposalPolicy:true});
  await put(active+'/tasks.md','- [x] Implement the original requirement\n');
  await put('src/main.mjs','export const setting = true;\n');
  git('add','--all');commit('Freeze completed implementation');
  const head=git('rev-parse','HEAD').toString().trim();
  const patch=git('diff','--binary',preparedHead,head,'--',...arktsBusinessDiffScope);
  const workspace=git('diff','--binary',preparedHead,head);
  const freezeRoot=path.join(outputRoot,'freeze');await fs.mkdir(freezeRoot);
  await fs.writeFile(path.join(freezeRoot,'candidate.patch'),patch);
  await fs.writeFile(path.join(freezeRoot,'workspace.patch'),workspace);
  const mutationPaths=git('diff','--name-only','-z',preparedHead,head).toString().split('\0').filter(Boolean);
  const preArchiveFreeze={commit:head,commitSha256:hash(git('cat-file','commit',head)),preparedHead,
    patchSha256:hash(patch),workspacePatchSha256:hash(workspace),mutationPaths};
  await fs.writeFile(path.join(freezeRoot,'freeze.json'),JSON.stringify(preArchiveFreeze));
  const calls=[];
  const options={outputRoot,projectRoot,preparedHead,changeName:'settings',sessionId:'session',deadlineAt:Date.now()+60000,
    proposalTurn:{finalRunId:'proposal-run',terminal:{source:'agent.wait',runId:'proposal-run',status:'ok'},openSpec:{readyToApply:true}},
    applyTurn:{finalRunId:'apply-run',settled:true,terminal:{source:'agent.wait',runId:'apply-run',status:'ok'},openSpec:{applyComplete:true}},
    proposalCheckpoint,preArchiveFreeze,rcEnabled:false,nativeStop:{nativeStopSettled:null},implementationReady:true,git,commit,
    readCheckpoint:async()=>{calls.push('fresh-checkpoint');return {changeName:'settings',planVerified:true,applyComplete:true};},
    invokeCli:async args=>{
      calls.push(args);
      if(args[0]==='archive') {
        assert.deepEqual(args,['archive','settings','--yes']);
        const destination='openspec/changes/archive/'+new Date().toISOString().slice(0,10)+'-settings';
        await fs.mkdir(path.dirname(path.join(projectRoot,destination)),{recursive:true});
        await fs.rename(path.join(projectRoot,active),path.join(projectRoot,destination));
        await put('openspec/specs/settings/spec.md','# Settings\nMerged original requirement.\n');
        return {stdout:'scripted archive operation',stderr:''};
      }
      assert.deepEqual(args,['validate','settings','--type','spec','--strict','--json']);
      return {stdout:JSON.stringify({items:[{id:'settings',type:'spec',valid:true,issues:[]}]}),stderr:''};
    }};
  const services={runLocalTest:async request=>{calls.push('fresh-final-public-tests');assert(request.timeoutMs>0&&request.timeoutMs<=60000);
    await assert.rejects(fs.stat(path.join(projectRoot,active)),{code:'ENOENT'});return tested();}};
  return {root,options,services,calls,put,git,patch,workspace,active,freezeRoot};
}

test('wired controller preserves pre-Archive grading patch and seals the actual final relocated workspace',async t=>{
  const f=await fixture(t),history=JSON.stringify([f.options.proposalTurn,f.options.applyTurn]);
  const result=await completeReleaseOpenSpecWorkflow(f.options,f.services);
  assert.equal(result.workflowProtocol.id,'openspec-full-lifecycle-v2');assert.equal(result.businessNatural,true);
  assert.equal(result.businessNaturalLegacy,true);assert.equal(result.archive.complete,true);
  assert.equal(result.finalWorkspace.businessUnchanged,true);assert.equal(result.finalWorkspace.readProofTransferred,false);
  assert.equal(result.finalWorkspace.committedArchiveFilesMatched,true);assert.equal(result.finalWorkspace.currentSubjectMatched,true);
  assert.equal(result.finalWorkspace.committedScopeMatched,true);
  assert.equal(result.preArchiveCandidate.patchSha256,hash(f.patch));
  assert.deepEqual(await fs.readFile(path.join(f.freezeRoot,'candidate.patch')),f.patch);
  assert.deepEqual(await fs.readFile(path.join(f.freezeRoot,'workspace.patch')),f.workspace);
  assert.equal(JSON.stringify([f.options.proposalTurn,f.options.applyTurn]),history);
  const finalPatch=await fs.readFile(path.join(result.finalWorkspace.directory,'workspace.patch'),'utf8');
  assert.match(finalPatch,/openspec\/changes\/archive\/\d{4}-\d{2}-\d{2}-settings\/proposal\.md/u);
  assert.match(finalPatch,/openspec\/specs\/settings\/spec\.md/u);
  assert(result.finalWorkspace.mutationPaths.some(name=>name.startsWith('openspec/changes/archive/')));
  assert.equal(f.calls[0],'fresh-checkpoint');assert.equal(f.calls.at(-1),'fresh-final-public-tests');
  assert.equal(result.archive.readProofGranted,false);assert.equal(result.archive.assessmentGranted,false);
});

test('fresh approved document scope is checked rather than trusting the old completed Apply object',async t=>{
  const f=await fixture(t);await f.put(f.active+'/design.md','changed approved design');
  const result=await completeReleaseOpenSpecWorkflow(f.options,f.services);
  assert.equal(result.businessNatural,false);assert.equal(result.businessNaturalLegacy,true);
  assert.equal(result.archive.reason,'ARCHIVE_CURRENT_APPLY_CHECKPOINT_UNAVAILABLE');
  assert.equal(f.calls.some(Array.isArray),false);assert.equal(result.finalWorkspace,null);
});

test('implementation changes after the grading freeze cannot be silently archived as the frozen candidate',async t=>{
  const f=await fixture(t);await f.put('src/main.mjs','changed after freeze');
  const result=await completeReleaseOpenSpecWorkflow(f.options,f.services);
  assert.equal(result.archive.reason,'ARCHIVE_FROZEN_CANDIDATE_CHANGED');assert.equal(result.businessNatural,false);
  assert.equal(f.calls.some(Array.isArray),false);assert.deepEqual(await fs.readFile(path.join(f.freezeRoot,'candidate.patch')),f.patch);
});

test('a partial official-command failure preserves the original candidate and records the actual partial docs delivery',async t=>{
  const f=await fixture(t);f.options.invokeCli=async()=>{
    await f.put('openspec/specs/settings/spec.md','partially merged master');
    throw Object.assign(Error('archive destination collision'),{code:1,stdout:'master updated',stderr:'destination exists'});
  };
  const result=await completeReleaseOpenSpecWorkflow(f.options,f.services);
  assert.equal(result.archive.reason,'ARCHIVE_COMMAND_FAILED_OR_PARTIAL');assert.equal(result.businessNatural,false);
  assert.equal(result.finalWorkspace.archiveComplete,false);assert.equal(result.finalWorkspace.businessUnchanged,true);
  assert.deepEqual(await fs.readFile(path.join(f.freezeRoot,'candidate.patch')),f.patch);
  assert.match(await fs.readFile(path.join(result.finalWorkspace.directory,'workspace.patch'),'utf8'),/partially merged master/u);
  assert(!f.calls.includes('fresh-final-public-tests'));
});

test('fresh post-Archive test failure leaves implementation history intact and blocks full-workflow completion',async t=>{
  const f=await fixture(t);f.services.runLocalTest=async()=>tested('FAIL');
  const result=await completeReleaseOpenSpecWorkflow(f.options,f.services);
  assert.equal(result.businessNaturalLegacy,true);assert.equal(result.businessNatural,false);
  assert.equal(result.archive.reason,'ARCHIVE_CURRENT_FINAL_CHECK_UNVERIFIED');
  assert.equal(result.archive.finalCodeCheck.reason,'ARCHIVE_FINAL_PUBLIC_TESTS_UNVERIFIED');
  assert.equal(result.finalWorkspace.businessUnchanged,true);
});

test('changes made by a final check remain visible and cannot modify the pre-Archive grading artifact',async t=>{
  const f=await fixture(t);f.services.runLocalTest=async()=>{await f.put('src/main.mjs','unexpected check mutation');return tested();};
  const result=await completeReleaseOpenSpecWorkflow(f.options,f.services);
  assert.equal(result.businessNatural,false);assert.equal(result.archive.reason,'ARCHIVE_FINAL_SUBJECT_CHANGED');
  assert.equal(result.finalWorkspace.businessUnchanged,false);assert.equal(result.workflowReason,'ARCHIVE_FINAL_BUSINESS_PATCH_CHANGED');
  assert.deepEqual(await fs.readFile(path.join(f.freezeRoot,'candidate.patch')),f.patch);
});

test('ON pending Stop and an Apply business error do not run Archive or the final checks',async t=>{
  for(const pending of [true,false]) {
    const f=await fixture(t);f.options.rcEnabled=true;
    if(pending)f.options.nativeStop={nativeStopSettled:false};
    else f.options.applyTurn.terminal.status='error';
    const result=await completeReleaseOpenSpecWorkflow(f.options,f.services);
    assert.equal(result.businessNatural,false);assert.deepEqual(f.calls,[]);
    assert.equal(result.archive.applyTerminalStatus,pending?'ok':'error');
  }
});

test('current checks bind the measured subject and retain baseline failures without forgiving new ones or missing IDs',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'rc-archive-checks-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const base=tested('FAIL');const baselineLocalTests=localTestEvidence(base.raw,base.execution,{freshReport:true,compileOutput:base.output});
  for(const [name,value,baseline,expected]of[
    ['unchanged baseline failure',base,baselineLocalTests,true],
    ['new failure',base,null,false],
    ['foreign snapshot',tested('PASS',{snapshotSha256:'f'.repeat(64)}),null,false],
    ['missing original ID',{...tested('PASS'),raw:report('PASS','different test')},baselineLocalTests,false],
    ['cancelled',tested('PASS',{interrupted:true}),null,false],
  ]) {
    const outputRoot=path.join(root,name);await fs.mkdir(outputRoot);
    const result=await runArchiveCurrentChecks({outputRoot,deadlineAt:Date.now()+60000,sourceSnapshotSha256:'a'.repeat(64),
      businessPatchSha256:'b'.repeat(64),baselineLocalTests:baseline},{runLocalTest:async()=>value});
    assert.equal(result.success,expected,name);
  }
});

test('acceptance and required lint use only the original remaining time after the fresh runtime check',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'rc-archive-budget-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  let clock=100000;const deadlineAt=clock+10000,calls=[];
  const result=await runArchiveCurrentChecks({outputRoot:root,deadlineAt,sourceSnapshotSha256:'a'.repeat(64),
    businessPatchSha256:'b'.repeat(64),lintRequirement:{source:'AGENTS.md'},
    publicAcceptance:{sha256:'c'.repeat(64),testIds:['public::Settings::case']}},{now:()=>clock,
    runLocalTest:async options=>{calls.push(options.timeoutMs);clock+=3000;return tested();},
    runAcceptance:async options=>{calls.push(options.timeoutMs);assert.equal(options.deadlineAt,deadlineAt);clock+=2000;
      return {status:'PASS',sha256:'c'.repeat(64),checks:[{id:'public::Settings::case',status:'PASS'}]};},
    runLint:async options=>{calls.push(options.timeoutMs);clock+=1000;return {success:true,snapshotSha256:'a'.repeat(64)};}});
  assert.equal(result.success,true);assert.deepEqual(calls,[10000,7000,5000]);
});

test('actual runner selects this coordinator only through the prospective flag after the original freeze and active-path evidence',async()=>{
  const source=await fs.readFile(new URL('../scripts/run-release-e2e.mjs',import.meta.url),'utf8');
  assert.match(source,/\['complete-openspec-workflow', \{ type: 'boolean' \}\]/u);
  assert.match(source,/completeOpenSpecWorkflow \? await completeReleaseOpenSpecWorkflow\(/u);
  const invoke=source.indexOf('completeOpenSpecWorkflow ? await completeReleaseOpenSpecWorkflow(');
  assert(source.indexOf("await write(path.join(frozenRoot,'freeze.json'),frozen)")<invoke);
  assert(source.indexOf('const documentFeedback=')<invoke);
  assert.match(source,/preArchiveFreeze: frozen/u);assert.match(source,/readCheckpoint: \(\) => readOpenSpecCheckpoint/u);
  assert.match(source,/invokeCli: \(params, signal\) => runOpenSpecCli\(spec.options, params, signal\)/u);
  const original=await fs.readFile(new URL('../scripts/bench/original-basis-workflow.mjs',import.meta.url),'utf8');
  const whitelist=original.slice(original.indexOf('export function validateOpenSpecArgs'),original.indexOf('export async function prepareOpenSpecSession'));
  assert(!whitelist.includes("['archive'"),'The actor still cannot archive during Proposal or Apply');
});


test('a delivery Git failure does not erase the already valid coding freeze or rewrite Apply completion',async t=>{
  const f=await fixture(t);f.options.commit=()=>{throw Object.assign(Error('controlled delivery failure'),{code:'CONTROLLED_GIT_FAILURE'});};
  const result=await completeReleaseOpenSpecWorkflow(f.options,f.services);
  assert.equal(result.businessNaturalLegacy,true);assert.equal(result.businessNatural,false);
  assert.equal(result.archive.complete,true);assert.equal(result.finalWorkspace.status,'UNVERIFIED');
  assert.equal(result.workflowReason,'ARCHIVE_FINAL_WORKSPACE_SEAL_UNAVAILABLE');
  assert.equal(result.archive.applyTerminalStatus,'ok');
  assert.equal(result.preArchiveCandidate.commit,f.options.preArchiveFreeze.commit);
  assert.deepEqual(await fs.readFile(path.join(f.freezeRoot,'candidate.patch')),f.patch);
  assert.deepEqual(await fs.readFile(path.join(f.freezeRoot,'workspace.patch')),f.workspace);
});

test('docs or policy changed during Git sealing cannot become a completed final delivery',async t=>{
  for(const at of ['before-add-doc','after-add-doc','after-add-policy']) {
    const f=await fixture(t);let changed=false;
    f.options.git=(...args)=>{
      const add=args.includes('add');
      if(add&&!changed&&at==='before-add-doc')
        writeFileSync(path.join(f.options.projectRoot,'openspec/specs/settings/spec.md'),'unvalidated committed docs');
      const result=f.git(...args);
      if(add&&!changed) {
        if(at==='after-add-doc')writeFileSync(path.join(f.options.projectRoot,'openspec/specs/settings/spec.md'),'unvalidated current docs');
        if(at==='after-add-policy')writeFileSync(path.join(f.options.projectRoot,'.runtime-corrector/config.yaml'),'unvalidated policy');
        changed=true;
      }
      return result;
    };
    const result=await completeReleaseOpenSpecWorkflow(f.options,f.services);
    assert.equal(result.archive.complete,true,at);assert.equal(result.businessNatural,false,at);
    assert.equal(result.workflowReason,'ARCHIVE_FINAL_DELIVERY_SUBJECT_CHANGED',at);
    assert.equal(result.finalWorkspace.businessUnchanged,true,at);
    assert.equal(result.finalWorkspace.currentSubjectMatched,false,at);
    assert.equal(result.finalWorkspace.committedArchiveFilesMatched,at!=='before-add-doc',at);
    assert.deepEqual(await fs.readFile(path.join(f.freezeRoot,'candidate.patch')),f.patch);
  }
});

test('a trusted generic-fixture check executes against the current archived workspace without invoking the default SDK adapter',async t=>{
  const f=await fixture(t);let actualChecks=0;
  f.services.runLocalTest=()=>{throw Error('SDK adapter must not run for this generic engineering control');};
  f.services.finalCheck=async request=>{
    await assert.rejects(fs.stat(path.join(f.options.projectRoot,f.active)),{code:'ENOENT'});
    execFileSync(process.execPath,['--check',path.join(f.options.projectRoot,'src/main.mjs')],{stdio:['ignore','pipe','pipe']});
    actualChecks++;
    return {executed:true,complete:true,success:true,sourceSnapshotSha256:request.sourceSnapshotSha256,
      businessPatchSha256:request.businessPatchSha256,scope:'Actual Node syntax control; no SDK or feature/requirement proof'};
  };
  const result=await completeReleaseOpenSpecWorkflow(f.options,f.services);
  assert.equal(actualChecks,1);assert.equal(result.businessNatural,true);
  assert.match(result.archive.finalCodeCheck.scope,/no SDK/u);
});

test('an extra index-only OpenSpec blob cannot ride the delivery commit while the working tree remains valid',async t=>{
  const f=await fixture(t),unrelated='openspec/specs/unrelated/spec.md';let staged=false;
  const blobFile=path.join(f.root,'unvalidated-blob');await fs.writeFile(blobFile,'unvalidated unrelated document');
  const blob=f.git('hash-object','-w',blobFile).toString().trim();
  f.options.git=(...args)=>{
    if(args.includes('add')&&!staged) {
      f.git('update-index','--add','--cacheinfo','100644',blob,unrelated);staged=true;
    }
    return f.git(...args);
  };
  const result=await completeReleaseOpenSpecWorkflow(f.options,f.services);
  assert.equal(result.archive.complete,true);assert.equal(result.businessNatural,false);
  assert.equal(result.workflowReason,'ARCHIVE_FINAL_DELIVERY_SUBJECT_CHANGED');
  assert.equal(result.finalWorkspace.currentSubjectMatched,true);
  assert.equal(result.finalWorkspace.committedArchiveFilesMatched,true);
  assert.equal(result.finalWorkspace.businessUnchanged,true);
  assert.equal(result.finalWorkspace.committedScopeMatched,false);
  assert(result.finalWorkspace.committedDeltaPaths.includes(unrelated));
  await assert.rejects(fs.stat(path.join(f.options.projectRoot,unrelated)),{code:'ENOENT'});
  assert.deepEqual(await fs.readFile(path.join(f.freezeRoot,'candidate.patch')),f.patch);
});
