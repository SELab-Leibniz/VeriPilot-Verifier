import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {settleOpenSpecArchivePhase} from '../scripts/bench/openspec-archive-phase.mjs';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const active='openspec/changes/demo';
function freeze(value){if(value&&typeof value==='object'){Object.freeze(value);for(const v of Object.values(value))freeze(v);}return value;}
function fixture() {
  let clock=Date.UTC(2026,0,2,12);
  const files=new Map([
    ['src/main.mjs',{content:'original implementation',mode:0o644}],
    ['.opencode/workflow.md',{content:'fixed workflow',mode:0o644}],
    ['.runtime-corrector/config.yaml',{content:'fixed policy',mode:0o644}],
    [active+'/.openspec.yaml',{content:'schema: spec-driven',mode:0o644}],
    [active+'/proposal.md',{content:'approved proposal',mode:0o644}],
    [active+'/design.md',{content:'approved design',mode:0o644}],
    [active+'/tasks.md',{content:'- [x] original task',mode:0o644}],
    [active+'/specs/settings/spec.md',{content:'original delta',mode:0o644}],
    ['openspec/specs/settings/spec.md',{content:'old master',mode:0o644}],
  ]);
  const emptyDirectories=new Set(),calls=[];
  const state=()=>{
    const rows=[...files].map(([name,row])=>({path:name,sha256:hash(row.content),bytes:Buffer.byteLength(row.content),mode:row.mode}))
      .sort((a,b)=>a.path.localeCompare(b.path));
    const directories=new Set(emptyDirectories);
    for(const row of rows){const parts=row.path.split('/');for(let i=1;i<parts.length;i++)directories.add(parts.slice(0,i).join('/'));}
    return {files:rows,directories:[...directories].sort(),sourceSnapshotSha256:hash(rows),
      businessPatchSha256:hash(rows.filter(r=>!r.path.startsWith('openspec/')))};
  };
  const proposal=freeze({finalRunId:'proposal-final',terminal:{source:'agent.wait',runId:'proposal-final',status:'ok'},
    openSpec:{readyToApply:true}});
  const apply=freeze({settled:true,finalRunId:'apply-final',terminal:{source:'agent.wait',runId:'apply-final',status:'ok'},
    openSpec:{applyComplete:true}});
  const options={changeName:'demo',deadlineAt:clock+120000,implementationReady:true,proposalTurn:proposal,applyTurn:apply,
    expectedBusinessPatchSha256:state().businessPatchSha256,rcEnabled:false,nativeStop:freeze({nativeStopSettled:null}),now:()=>clock,
    inspectApply:async()=>{calls.push('inspect');return {changeName:'demo',planVerified:true,applyComplete:true,approvedScopePreserved:true};},
    capture:async({phase})=>{calls.push(phase);return state();},
    invokeArchive:async({args,timeoutMs})=>{
      calls.push({type:'archive',args,timeoutMs});
      const target='openspec/changes/archive/'+new Date(clock).toISOString().slice(0,10)+'-demo';
      for(const [name,row]of[...files])if(name.startsWith(active+'/')) {
        files.set(target+name.slice(active.length),{...row});files.delete(name);
      }
      files.set('openspec/specs/settings/spec.md',{content:'merged master',mode:0o644});
      return {exitCode:0,outputComplete:true,stdout:'scripted archive result',stderr:''};
    },
    validateMerged:async({affectedSpecs,sourceSnapshotSha256})=>{
      calls.push('validate');return {valid:true,exitCode:0,checkedSpecPaths:affectedSpecs,sourceSnapshotSha256};
    },
    finalCheck:async({sourceSnapshotSha256,businessPatchSha256})=>{
      calls.push('final-check');return {executed:true,complete:true,success:true,sourceSnapshotSha256,businessPatchSha256};
    }};
  return {options,files,emptyDirectories,calls,state,advance:ms=>{clock+=ms;}};
}

test('Archive requires current approved complete Apply and retains the historical terminals',async()=>{
  const f=fixture(),history=JSON.stringify([f.options.proposalTurn,f.options.applyTurn]);
  const result=await settleOpenSpecArchivePhase(f.options);
  assert.equal(result.complete,true);assert.equal(result.status,'COMPLETE');
  assert.deepEqual(f.calls.filter(x=>typeof x==='object'),[{type:'archive',args:['archive','demo','--yes'],timeoutMs:90000}]);
  assert.deepEqual(f.calls.filter(x=>typeof x==='string'),['inspect','before-archive','after-archive','validate','final-check','after-final-check']);
  assert.equal(result.proposalTerminalStatus,'ok');assert.equal(result.applyTerminalStatus,'ok');
  assert.equal(JSON.stringify([f.options.proposalTurn,f.options.applyTurn]),history);
  assert.equal(result.archiveFilesExact,true);assert.equal(result.allowedDocsOnly,true);assert.equal(result.implementationUnchanged,true);
  assert.equal(result.readProofGranted,false);assert.equal(result.assessmentGranted,false);
});

test('OFF and settled ON use the same Archive command and gates',async()=>{
  for(const rcEnabled of [false,true]) {
    const f=fixture();f.options.rcEnabled=rcEnabled;f.options.nativeStop={nativeStopSettled:rcEnabled?true:null};
    const result=await settleOpenSpecArchivePhase(f.options);
    assert.equal(result.complete,true);assert.deepEqual(result.invocation.args,['archive','demo','--yes']);
  }
});

test('an Apply error or incomplete implementation never dispatches Archive even with complete task metadata',async()=>{
  for(const error of [false,true]) {
    const f=fixture();
    if(error)f.options.applyTurn={...f.options.applyTurn,terminal:{source:'agent.wait',runId:'apply-final',status:'error'}};
    else f.options.implementationReady=false;
    const result=await settleOpenSpecArchivePhase(f.options);
    assert.equal(result.complete,false);assert.equal(result.reason,'ARCHIVE_IMPLEMENTATION_NOT_APPROVED_COMPLETE');
    assert.deepEqual(f.calls,[]);
    assert.equal(result.applyTerminalStatus,error?'error':'ok');
  }
});

test('pending ON Stop and a fresh incomplete checkpoint block the operation',async()=>{
  const f=fixture();f.options.rcEnabled=true;f.options.nativeStop={nativeStopSettled:false};
  assert.equal((await settleOpenSpecArchivePhase(f.options)).reason,'ARCHIVE_NATIVE_STOP_UNSETTLED');
  assert.deepEqual(f.calls,[]);
  const g=fixture();g.options.inspectApply=async()=>({changeName:'demo',planVerified:true,applyComplete:false});
  assert.equal((await settleOpenSpecArchivePhase(g.options)).reason,'ARCHIVE_CURRENT_APPLY_CHECKPOINT_UNAVAILABLE');
  assert.equal(g.calls.some(x=>x?.type==='archive'),false);
});

test('exit0 without relocation does not pass or run a final code check',async()=>{
  const f=fixture();f.options.invokeArchive=async()=>({exitCode:0,outputComplete:true,stdout:'validation failed',stderr:''});
  const result=await settleOpenSpecArchivePhase(f.options);
  assert.equal(result.complete,false);assert.equal(result.reason,'ARCHIVE_MOVE_POSTCONDITION_UNVERIFIED');
  assert.equal(result.activeChangeGone,false);assert.equal(f.calls.includes('final-check'),false);
});

test('a preexisting empty archive directory is rejected before the CLI can partially update main specs',async()=>{
  const f=fixture();f.emptyDirectories.add('openspec/changes/archive/2026-01-02-demo');
  const before=f.state();const result=await settleOpenSpecArchivePhase(f.options);
  assert.equal(result.reason,'ARCHIVE_DESTINATION_EXISTS');assert.equal(result.invocation,undefined);
  assert.deepEqual(f.state(),before);
});

test('failed Archive retains its actual partial docs mutation and pre-Archive candidate',async()=>{
  const f=fixture();f.options.invokeArchive=async()=>{
    f.files.set('openspec/specs/settings/spec.md',{content:'partial merged master',mode:0o644});
    return {exitCode:1,outputComplete:true,stdout:'master updated',stderr:'archive destination exists'};
  };
  const before=f.state();const result=await settleOpenSpecArchivePhase(f.options);
  assert.equal(result.reason,'ARCHIVE_COMMAND_FAILED_OR_PARTIAL');assert.equal(result.command.exitCode,1);
  assert.deepEqual(result.changedPaths,['openspec/specs/settings/spec.md']);
  assert.equal(result.preArchive.businessPatchSha256,before.businessPatchSha256);
  assert.equal(result.activeChangeGone,false);assert.equal(result.complete,false);
});

test('implementation bytes or executable-mode mutations are rejected despite a successful move',async()=>{
  for(const modeOnly of [false,true]) {
    const f=fixture(),archive=f.options.invokeArchive;
    f.options.invokeArchive=async args=>{
      const result=await archive(args);
      f.files.set('src/main.mjs',{content:modeOnly?'original implementation':'changed implementation',mode:modeOnly?0o755:0o644});
      return result;
    };
    const result=await settleOpenSpecArchivePhase(f.options);
    assert.equal(result.reason,'ARCHIVE_SCOPE_OR_IMPLEMENTATION_CHANGED');assert.equal(result.complete,false);
    assert.equal(f.calls.includes('final-check'),false);
  }
});

test('unrelated OpenSpec files and outside empty-directory changes are not authorized by Archive',async()=>{
  for(const directory of [false,true]) {
    const f=fixture(),archive=f.options.invokeArchive;
    f.options.invokeArchive=async args=>{
      const result=await archive(args);
      if(directory)f.emptyDirectories.add('src/unexpected');
      else f.files.set('openspec/changes/other/tasks.md',{content:'unrelated change',mode:0o644});
      return result;
    };
    const result=await settleOpenSpecArchivePhase(f.options);
    assert.equal(result.reason,'ARCHIVE_SCOPE_OR_IMPLEMENTATION_CHANGED');assert.equal(result.allowedDocsOnly,false);
  }
});

test('a corrupt relocated Markdown file cannot reuse the original artifact proof',async()=>{
  const f=fixture(),archive=f.options.invokeArchive;
  f.options.invokeArchive=async args=>{
    const result=await archive(args);
    f.files.set('openspec/changes/archive/2026-01-02-demo/proposal.md',{content:'different proposal',mode:0o644});
    return result;
  };
  const result=await settleOpenSpecArchivePhase(f.options);
  assert.equal(result.reason,'ARCHIVE_MOVE_POSTCONDITION_UNVERIFIED');assert.equal(result.archiveFilesExact,false);
  assert.equal(result.readProofGranted,false);
});

test('merged spec validation must cover the actual current affected spec paths and source identity',async()=>{
  for(const wrongSubject of [false,true]) {
    const f=fixture();
    f.options.validateMerged=async({sourceSnapshotSha256})=>({valid:true,exitCode:0,
      checkedSpecPaths:wrongSubject?['openspec/specs/settings/spec.md']:[],sourceSnapshotSha256:wrongSubject?'f'.repeat(64):sourceSnapshotSha256});
    const result=await settleOpenSpecArchivePhase(f.options);
    assert.equal(result.reason,'ARCHIVE_MERGED_SPECS_UNVERIFIED');assert.equal(result.complete,false);
    assert.equal(f.calls.includes('final-check'),false);
  }
});

test('a success flag on a stale final check or a changed final subject cannot complete the workflow',async()=>{
  for(const mutate of [false,true]) {
    const f=fixture();
    f.options.finalCheck=async({sourceSnapshotSha256,businessPatchSha256})=>{
      if(mutate)f.files.set('src/main.mjs',{content:'changed after check',mode:0o644});
      return {executed:true,complete:true,success:true,sourceSnapshotSha256:mutate?sourceSnapshotSha256:'f'.repeat(64),businessPatchSha256};
    };
    const result=await settleOpenSpecArchivePhase(f.options);
    assert.equal(result.reason,mutate?'ARCHIVE_FINAL_SUBJECT_CHANGED':'ARCHIVE_CURRENT_FINAL_CHECK_UNVERIFIED');
    assert.equal(result.complete,false);
  }
});

test('Archive uses only remaining original time and never completes after its deadline',async()=>{
  const f=fixture();f.options.deadlineAt=f.options.now();
  assert.equal((await settleOpenSpecArchivePhase(f.options)).reason,'ARCHIVE_NO_ORIGINAL_BUDGET');
  assert.deepEqual(f.calls,[]);
  const g=fixture();g.options.deadlineAt=g.options.now()+1000;
  const archive=g.options.invokeArchive;g.options.invokeArchive=async args=>{
    assert.equal(args.timeoutMs,1000);const result=await archive(args);g.advance(1001);return result;
  };
  const result=await settleOpenSpecArchivePhase(g.options);
  assert.equal(result.complete,false);assert.equal(result.reason,'ARCHIVE_FINISHED_OUTSIDE_ORIGINAL_BUDGET');
});
