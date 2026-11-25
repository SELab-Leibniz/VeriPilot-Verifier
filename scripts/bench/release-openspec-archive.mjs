// External benchmark coordinator only. No actor tool or plugin authority.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {openSpecArchiveInventorySha256,settleOpenSpecArchivePhase} from './openspec-archive-phase.mjs';
import {copyArktsPublicTestSnapshot} from './arkts-public-test-snapshot.mjs';
import {captureBusinessCheckpoint,compareOpenSpecApplyScope} from './business-checkpoint.mjs';
import {localTestEvidence,publicLocalTestEvidence} from './local-test-evidence.mjs';
import {runArktsLocalTest} from './arkts-local-test.mjs';
import {runArktsRequiredLint} from './arkts-build-lint-check.mjs';
import {arktsBusinessDiffScope,isArktsCheckpointPath} from './business-checkpoint.mjs';
import {sealableMutationPaths} from './business-mutations.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const hash=value=>sha(JSON.stringify(value));
const save=(file,value)=>fs.writeFile(file,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
export const completeOpenSpecWorkflowProtocol=Object.freeze({version:2,id:'openspec-full-lifecycle-v2'});

async function regularInventory(root,{signal,prefix=''}={}) {
  const files=[],directories=[];
  async function walk(relative) {
    signal?.throwIfAborted();
    const absolute=path.join(root,relative),stat=await fs.lstat(absolute);
    if(await fs.realpath(absolute)!==absolute)throw Error('ARCHIVE_NONCANONICAL_SUBJECT');
    const name=prefix?(relative?prefix+'/'+relative:prefix):relative;
    if(stat.isDirectory()) {
      if(name)directories.push(name);
      for(const child of(await fs.readdir(absolute)).sort())await walk(relative?relative+'/'+child:child);
    }else if(stat.isFile()) {
      const bytes=await fs.readFile(absolute,{signal});
      if(bytes.length!==stat.size)throw Error('ARCHIVE_SUBJECT_CHANGED_DURING_CAPTURE');
      files.push({path:name.startsWith('/')?name.slice(1):name,sha256:sha(bytes),bytes:bytes.length,mode:stat.mode&0o777});
    }else throw Error('ARCHIVE_NONREGULAR_SUBJECT');
  }
  await walk('');
  return {files,directories};
}

async function captureWorkspaceInventory({projectRoot,destination,signal},services) {
  const sourceSnapshotSha256=await(services.copySnapshot??copyArktsPublicTestSnapshot)(projectRoot,destination,{signal});
  const inventory=await regularInventory(destination,{signal});
  // Policy is trusted coordinator state. Its complete inventory is also bound,
  // but has no separate byte/entry ceiling beyond the existing policy reader.
  let capturedPolicy=null;
  try {
    const policy=await regularInventory(path.join(projectRoot,'.runtime-corrector'),{signal,prefix:'.runtime-corrector'});
    inventory.files.push(...policy.files);inventory.directories.push(...policy.directories);
    capturedPolicy=hash(policy.files.map(row=>[row.path.slice('.runtime-corrector/'.length),row.sha256]));
  }catch(error){if(error.code!=='ENOENT')throw error;}
  return {...inventory,sourceSnapshotSha256,capturedPolicy};
}

// Tests replace these trusted services in-process; actor-supplied JSON cannot
// configure them. Defaults use the same existing public checks in both arms.
export async function runArchiveCurrentChecks(options,services={}) {
  const {projectRoot,toolRoot,javaHome,outputRoot,deadlineAt,sourceSnapshotSha256,businessPatchSha256,
    baselineLocalTests,publicTestWorker,instrument,publicAcceptance,lintRequirement}=options;
  const now=services.now??Date.now,remaining=()=>Math.floor(deadlineAt-now());
  const result={executed:false,complete:false,success:false,sourceSnapshotSha256,businessPatchSha256};
  if(remaining()<=0)return {...result,reason:'ARCHIVE_FINAL_CHECK_DEADLINE'};
  const signal=AbortSignal.timeout(Math.max(1,remaining()));
  const tested=await(services.runLocalTest??runArktsLocalTest)({projectRoot,toolRoot,javaHome,
    publicTestWorker,instrument,timeoutMs:remaining(),signal});
  result.executed=true;
  const {execution,raw,freshReport,output}=tested;
  await fs.writeFile(path.join(outputRoot,'final-public-tests.log'),output,{flag:'wx',mode:0o600});
  if(freshReport)await fs.writeFile(path.join(outputRoot,'final-public-tests.coverage.log'),raw,{flag:'wx',mode:0o600});
  const current=localTestEvidence(raw,execution,{freshReport,compileOutput:output});
  const summary=publicLocalTestEvidence(current,baselineLocalTests),comparison=summary.baselineComparison;
  const baselineAvailable=Boolean(baselineLocalTests);
  const runtimeSuccess=current.completeRuntime&&execution.outputComplete&&!execution.interrupted
    &&Number.isInteger(execution.exitCode)&&execution.exitCode>=0
    &&(!execution.snapshotSha256||execution.snapshotSha256===sourceSnapshotSha256)
    &&(baselineAvailable?comparison.comparable&&!comparison.regressions.length&&!comparison.newFailures.length
      &&!comparison.noLongerObserved.length:current.allObservedPassed&&execution.exitCode===0);
  result.publicTests={execution,localTests:summary};
  if(!runtimeSuccess||remaining()<=0)return {...result,reason:'ARCHIVE_FINAL_PUBLIC_TESTS_UNVERIFIED'};
  if(publicAcceptance) {
    if(remaining()<=0)return {...result,reason:'ARCHIVE_FINAL_CHECK_DEADLINE'};
    const runAcceptance=services.runAcceptance??(await import('./arkts-regression-check.mjs')).runArktsRequirementProbe;
    result.acceptance=await runAcceptance({project:projectRoot,toolRoot,javaHome,...publicAcceptance,
      publicTestWorker,instrument,deadlineAt,timeoutMs:remaining(),signal});
    const checks=result.acceptance.checks;
    if(result.acceptance.status!=='PASS'||result.acceptance.sha256!==publicAcceptance.sha256
      ||!Array.isArray(checks)||checks.length!==publicAcceptance.testIds.length
      ||checks.some((row,index)=>row.id!==publicAcceptance.testIds[index]||row.status!=='PASS'))
      return {...result,reason:'ARCHIVE_FINAL_PUBLIC_ACCEPTANCE_UNVERIFIED'};
  }
  if(lintRequirement) {
    if(remaining()<=0)return {...result,reason:'ARCHIVE_FINAL_CHECK_DEADLINE'};
    result.lint=await(services.runLint??runArktsRequiredLint)({projectRoot,toolRoot,javaHome,outputRoot,
      requirement:lintRequirement,signal,timeoutMs:Math.min(120000,remaining())});
    if(result.lint.success!==true||result.lint.snapshotSha256!==sourceSnapshotSha256)
      return {...result,reason:'ARCHIVE_FINAL_REQUIRED_LINT_UNVERIFIED'};
  }
  if(remaining()<=0)return {...result,reason:'ARCHIVE_FINAL_CHECK_DEADLINE'};
  return {...result,complete:true,success:true};
}

export async function runReleaseOpenSpecArchive(options,services={}) {
  const {outputRoot,projectRoot,preparedHead,changeName,sessionId,deadlineAt,proposalTurn,applyTurn,
    proposalCheckpoint,preArchiveFreeze,rcEnabled,nativeStop,implementationReady,
    readCheckpoint,invokeCli}=options;
  const directory=path.join(outputRoot,'archive-phase');
  await fs.mkdir(directory);
  const now=services.now??Date.now,remaining=()=>Math.floor(deadlineAt-now());
  const captureCheckpoint=services.captureCheckpoint??captureBusinessCheckpoint;
  let approvedCheckpoint;
  const capture=async({phase})=>{
    if(remaining()<=0)throw Error('ARCHIVE_NO_ORIGINAL_BUDGET');
    const signal=AbortSignal.timeout(Math.max(1,remaining()));
    const snapshotRoot=path.join(directory,phase);
    const inventory=await captureWorkspaceInventory({projectRoot,destination:snapshotRoot,signal},services);
    const {sourceSnapshotSha256,capturedPolicy}=inventory;
    const checkpoint=await captureCheckpoint({outputRoot:directory,projectRoot,preparedHead,sessionId,
      runId:applyTurn.finalRunId,stopReason:'archive-'+phase,success:true,includeBusinessPatch:true});
    if(phase==='before-archive') {
      const expected=approvedCheckpoint?.proposalRepairScope;
      const byPath=new Map(inventory.files.map(row=>[row.path,row]));
      const docs=expected?.draftFiles?.map(row=>[row.path,byPath.get(row.path)?.sha256??null]);
      if(!docs||hash(docs)!==expected.approvedDocumentsSha256
        ||byPath.get('openspec/changes/'+changeName+'/tasks.md')?.sha256!==expected.tasksMdSha256
        ||(expected.policy.status==='CAPTURED'?capturedPolicy!==expected.policy.sha256:capturedPolicy!==null))
        throw Error('ARCHIVE_APPROVED_DOCUMENTS_CHANGED');
    }
    const value={...inventory,sourceSnapshotSha256,businessPatchSha256:checkpoint.businessPatchSha256,
      snapshotRoot,checkpoint};
    await save(path.join(directory,phase+'.json'),value);
    return value;
  };
  const inspectApply=async()=>{
    const current=await readCheckpoint({changeName,deadlineAt});
    if(remaining()<=0)throw Error('ARCHIVE_NO_ORIGINAL_BUDGET');
    approvedCheckpoint=await captureCheckpoint({outputRoot:directory,projectRoot,preparedHead,sessionId,
      runId:applyTurn.finalRunId,stopReason:'archive-approved-scope',success:true,includeBusinessPatch:true,
      proposalRepairChange:changeName,requireProposalPolicy:rcEnabled});
    const scope=compareOpenSpecApplyScope(proposalCheckpoint,approvedCheckpoint,{changeName,sessionId,preparedHead,
      proposalRunId:proposalTurn.finalRunId,applyRunId:applyTurn.finalRunId});
    return {...current,approvedScopePreserved:scope.status==='PRESERVED',scope};
  };
  const invokeArchive=async({args,signal})=>{
    const result=await invokeCli(args,signal);
    return {exitCode:0,outputComplete:true,stdout:String(result.stdout??''),stderr:String(result.stderr??'')};
  };
  const validateMerged=async({affectedSpecs,sourceSnapshotSha256})=>{
    const checkedSpecPaths=[],commands=[];
    for(const file of affectedSpecs) {
      if(remaining()<=0)throw Error('ARCHIVE_NO_ORIGINAL_BUDGET');
      const capability=file.slice('openspec/specs/'.length,-'/spec.md'.length);
      const args=['validate',capability,'--type','spec','--strict','--json'];
      const result=await invokeCli(args,AbortSignal.timeout(Math.max(1,Math.min(90000,remaining()))));
      const parsed=JSON.parse(String(result.stdout));
      const rows=parsed?.items;
      const valid=Array.isArray(rows)&&rows.length===1&&rows[0].id===capability&&rows[0].type==='spec'
        &&rows[0].valid===true&&Array.isArray(rows[0].issues)&&!rows[0].issues.some(issue=>issue.level==='ERROR');
      commands.push({args,stdout:String(result.stdout),stderr:String(result.stderr??''),valid});
      if(!valid)return {valid:false,exitCode:0,sourceSnapshotSha256,checkedSpecPaths,commands};
      checkedSpecPaths.push(file);
    }
    return {valid:true,exitCode:0,sourceSnapshotSha256,checkedSpecPaths,commands};
  };
  const archive=await settleOpenSpecArchivePhase({changeName,deadlineAt,implementationReady,proposalTurn,applyTurn,
    expectedBusinessPatchSha256:preArchiveFreeze.patchSha256,rcEnabled,nativeStop,now,
    inspectApply,capture,invokeArchive,validateMerged,finalCheck:request=>(services.finalCheck??runArchiveCurrentChecks)({
      ...options,...request,outputRoot:directory},services)});
  archive.preArchiveCandidate={...preArchiveFreeze,directory:path.join(outputRoot,'freeze'),
    approvedDocumentScopeSha256:proposalCheckpoint?.proposalRepairScope?.approvedDocumentsSha256??null};
  archive.deadlineQualification='Original absolute deadline; late/failed cooperative filesystem or checkpoint work cannot qualify.';
  await save(path.join(directory,'result.json'),archive);
  return archive;
}

export async function completeReleaseOpenSpecWorkflow(options,services={}) {
  const {outputRoot,projectRoot,preparedHead,preArchiveFreeze,implementationReady,deadlineAt,git,commit}=options;
  const now=services.now??Date.now;
  const archive=await runReleaseOpenSpecArchive(options,services);
  let finalWorkspace=null;
  if(archive.changedPaths?.length) {
    try {
    const directory=path.join(outputRoot,'final-workspace');
    await fs.mkdir(directory);
    // Include trusted archive/master deltas even though they were not actor
    // tool mutations. Keep the original freeze and candidate.patch untouched.
    const mutationPaths=await sealableMutationPaths({projectRoot,
      paths:[...new Set([...preArchiveFreeze.mutationPaths,...archive.changedPaths])].filter(isArktsCheckpointPath),
      trackedPaths:git('ls-files','--cached','-z').toString().split('\0')});
    // After the deadline retain observed snapshots, without launching a new
    // delivery commit or granting completion.
    if(now()<deadlineAt) {
      if(mutationPaths.length)git('--literal-pathspecs','add','--all','--',...mutationPaths);
      commit('Freeze OpenSpec Archive workspace');
      const head=git('rev-parse','HEAD').toString().trim();
      const patch=git('diff','--binary',preparedHead,head);
      const business=git('diff','--binary',preparedHead,head,'--',...arktsBusinessDiffScope);
      await fs.writeFile(path.join(directory,'workspace.patch'),patch,{flag:'wx',mode:0o600});
      finalWorkspace={directory,commit:head,commitSha256:sha(git('cat-file','commit',head)),preparedHead,mutationPaths,
        workspacePatchSha256:sha(patch),businessPatchSha256:sha(business),
        preArchiveBusinessPatchSha256:preArchiveFreeze.patchSha256,businessUnchanged:sha(business)===preArchiveFreeze.patchSha256,
        archiveComplete:archive.complete===true,readProofTransferred:false,deliveryInOriginalBudget:now()<deadlineAt};
      const committedPaths=git('diff','--no-renames','--name-only','-z',preArchiveFreeze.commit,head,'--')
        .toString('utf8').split('\0').filter(Boolean).sort();
      const expectedPaths=[...archive.changedPaths].sort();
      finalWorkspace.committedScopeMatched=JSON.stringify(committedPaths)===JSON.stringify(expectedPaths);
      finalWorkspace.committedDeltaPaths=committedPaths;
      // Check the immutable delivered Git tree, rather than trusting a clean
      // implementation diff to attest unchanged Markdown. The current tree is
      // measured again independently below, including controller policy.
      let committedArchiveFilesMatched=true;
      for(const row of archive.deliveryFiles??[]) {
        if(now()>=deadlineAt)throw Error('ARCHIVE_DELIVERY_OUTSIDE_ORIGINAL_BUDGET');
        const tree=git('--literal-pathspecs','ls-tree','-z',head,'--',row.path).toString('utf8').split('\0').filter(Boolean);
        if(row.deleted) { if(tree.length)committedArchiveFilesMatched=false;continue; }
        const entry=tree.length===1?/^(100644|100755) blob [a-f0-9]+\t(.+)$/u.exec(tree[0]):null;
        if(!entry||entry[2]!==row.path) {committedArchiveFilesMatched=false;continue;}
        const body=git('show',head+':'+row.path);
        if(body.length!==row.bytes||sha(body)!==row.sha256||(entry[1]==='100755')!==Boolean(row.mode&0o111))
          committedArchiveFilesMatched=false;
      }
      const remaining=Math.floor(deadlineAt-now());
      if(remaining<=0)throw Error('ARCHIVE_DELIVERY_OUTSIDE_ORIGINAL_BUDGET');
      const current=await captureWorkspaceInventory({projectRoot,destination:path.join(directory,'current-subject'),
        signal:AbortSignal.timeout(Math.max(1,remaining))},services);
      finalWorkspace.committedArchiveFilesMatched=committedArchiveFilesMatched;
      finalWorkspace.currentSourceSnapshotSha256=current.sourceSnapshotSha256;
      finalWorkspace.currentInventorySha256=openSpecArchiveInventorySha256(current);
      finalWorkspace.currentSubjectMatched=current.sourceSnapshotSha256===archive.postArchive?.sourceSnapshotSha256
        &&finalWorkspace.currentInventorySha256===archive.postArchive?.inventorySha256
        &&git('rev-parse','HEAD').toString().trim()===head;
      if(!finalWorkspace.committedScopeMatched||!committedArchiveFilesMatched||!finalWorkspace.currentSubjectMatched)
        Object.assign(finalWorkspace,{status:'UNVERIFIED',reason:'ARCHIVE_FINAL_DELIVERY_SUBJECT_CHANGED'});
      finalWorkspace.deliveryInOriginalBudget=now()<deadlineAt;
      await save(path.join(directory,'freeze.json'),finalWorkspace);
    }
    }catch(error) {
      // Delivery failure is separate from the already sealed implementation.
      // Preserve a result for closed-candidate grading; never imply a seal.
      finalWorkspace={...finalWorkspace,status:'UNVERIFIED',reason:'ARCHIVE_FINAL_WORKSPACE_SEAL_UNAVAILABLE',
        errorCode:String(error?.code??error?.name??'Error').slice(0,80),businessUnchanged:null,
        archiveComplete:archive.complete===true,readProofTransferred:false};
    }
  }
  const businessNatural=implementationReady===true&&archive.complete===true
    &&finalWorkspace?.businessUnchanged===true&&finalWorkspace.committedArchiveFilesMatched===true
    &&finalWorkspace.currentSubjectMatched===true&&finalWorkspace.committedScopeMatched===true&&now()<deadlineAt;
  const reason=businessNatural?null:now()>=deadlineAt?'ARCHIVE_DELIVERY_OUTSIDE_ORIGINAL_BUDGET'
    :finalWorkspace?.businessUnchanged===false?'ARCHIVE_FINAL_BUSINESS_PATCH_CHANGED':finalWorkspace?.reason??archive.reason;
  return {workflowProtocol:completeOpenSpecWorkflowProtocol,implementationNatural:implementationReady,
    businessNaturalLegacy:implementationReady,businessNatural,controllerArchiveExplicit:true,modelArchiveTurn:false,
    pluginArchiveSupportQualified:false,preArchiveCandidate:archive.preArchiveCandidate,
    archive,finalWorkspace,workflowReason:reason,documentEvidenceStage:'pre-archive-approved-apply'};
}
