// Prospective external workflow-controller phase. No plugin tool capability.
// Callback inputs are trusted coordinator services, never actor JSON authority.
import {createHash} from 'node:crypto';
import {businessCompleted} from './business-completion.mjs';

const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sha=/^[a-f0-9]{64}$/u;
const relative=value=>typeof value==='string'&&value.length>0&&!value.startsWith('/')
  &&!/[\\\0\r\n]/u.test(value)&&value.split('/').every(part=>part&&part!=='.'&&part!=='..');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function snapshot(value) {
  if(!value||!sha.test(value.sourceSnapshotSha256??'')||!sha.test(value.businessPatchSha256??'')
    ||!Array.isArray(value.files)||!Array.isArray(value.directories))throw new Error('ARCHIVE_SNAPSHOT_UNAVAILABLE');
  const files=new Map();
  for(const row of value.files) {
    if(!relative(row.path)||!sha.test(row.sha256??'')||!Number.isSafeInteger(row.bytes)||row.bytes<0
      ||!Number.isSafeInteger(row.mode)||row.mode<0||row.mode>0o7777||files.has(row.path))
      throw new Error('ARCHIVE_SNAPSHOT_UNAVAILABLE');
    files.set(row.path,{sha256:row.sha256,bytes:row.bytes,mode:row.mode});
  }
  if(value.directories.some(name=>!relative(name))||new Set(value.directories).size!==value.directories.length)
    throw new Error('ARCHIVE_SNAPSHOT_UNAVAILABLE');
  return {...value,files,directories:new Set(value.directories)};
}
const rowsUnder=(files,prefix)=>[...files].filter(([name])=>name.startsWith(prefix+'/'))
  .map(([name,row])=>[name.slice(prefix.length+1),row]).sort(([a],[b])=>a.localeCompare(b));
function differences(before,after) {
  return [...new Set([...before.files.keys(),...after.files.keys()])]
    .filter(name=>!same(before.files.get(name),after.files.get(name))).sort();
}
const utcDay=value=>new Date(value).toISOString().slice(0,10);
export function openSpecArchiveInventorySha256(value) {
  const rows=value.files instanceof Map?[...value.files].map(([path,row])=>({path,...row})):value.files;
  return digest({files:[...rows].sort((a,b)=>a.path<b.path?-1:Number(a.path>b.path)),directories:[...value.directories].sort()});
}

export async function settleOpenSpecArchivePhase({
  changeName,deadlineAt,implementationReady,proposalTurn,applyTurn,rcEnabled,nativeStop,expectedBusinessPatchSha256,
  inspectApply,capture,invokeArchive,validateMerged,finalCheck,now=Date.now,
}) {
  const result={kind:'CONTROLLED_OPENSPEC_ARCHIVE_PHASE_V2',changeName,status:'NOT_ATTEMPTED',
    complete:false,actualArchiveObserved:false,proposalFinalRunId:proposalTurn?.finalRunId??null,
    proposalTerminalStatus:proposalTurn?.terminal?.status??null,applyFinalRunId:applyTurn?.finalRunId??null,
    applyTerminalStatus:applyTurn?.terminal?.status??null,nativeStopSettled:nativeStop?.nativeStopSettled??null,
    readProofGranted:false,assessmentGranted:false,historicalStatusesRewritten:false};
  const stop=(status,reason)=>Object.assign(result,{status,reason,finishedAt:now()});
  if(!/^[a-z0-9][a-z0-9_-]*$/u.test(changeName??'')||!Number.isSafeInteger(deadlineAt)
    ||typeof rcEnabled!=='boolean'||!sha.test(expectedBusinessPatchSha256??''))return stop('NOT_ATTEMPTED','ARCHIVE_INPUT_UNAVAILABLE');
  if(!implementationReady||proposalTurn?.openSpec?.readyToApply!==true
    ||!businessCompleted(applyTurn?.terminal,applyTurn?.finalRunId)||applyTurn?.settled!==true)
    return stop('NOT_ATTEMPTED','ARCHIVE_IMPLEMENTATION_NOT_APPROVED_COMPLETE');
  if(rcEnabled&&nativeStop?.nativeStopSettled!==true)
    return stop('NOT_ATTEMPTED','ARCHIVE_NATIVE_STOP_UNSETTLED');
  if(now()>=deadlineAt)return stop('NOT_ATTEMPTED','ARCHIVE_NO_ORIGINAL_BUDGET');
  if([inspectApply,capture,invokeArchive,validateMerged,finalCheck].some(fn=>typeof fn!=='function'))
    return stop('NOT_ATTEMPTED','ARCHIVE_TRUSTED_INTEGRATION_REQUIRED');
  const active='openspec/changes/'+changeName;
  let before,after;
  try {
    const checkpoint=await inspectApply({changeName,deadlineAt});
    if(checkpoint?.changeName!==changeName||checkpoint.planVerified!==true||checkpoint.applyComplete!==true
      ||checkpoint.approvedScopePreserved!==true)
      return stop('NOT_ATTEMPTED','ARCHIVE_CURRENT_APPLY_CHECKPOINT_UNAVAILABLE');
    before=snapshot(await capture({phase:'before-archive',changeName,deadlineAt}));
    if(before.businessPatchSha256!==expectedBusinessPatchSha256)
      return stop('NOT_ATTEMPTED','ARCHIVE_FROZEN_CANDIDATE_CHANGED');
    const activeRows=rowsUnder(before.files,active);
    if(!before.directories.has(active)||!activeRows.length)
      return stop('NOT_ATTEMPTED','ARCHIVE_CURRENT_CHANGE_UNAVAILABLE');
    const invokedAt=now(),timeoutMs=Math.min(90000,deadlineAt-invokedAt);
    if(timeoutMs<=0)return stop('NOT_ATTEMPTED','ARCHIVE_NO_ORIGINAL_BUDGET');
    const destinations=[...new Set([utcDay(invokedAt),utcDay(invokedAt+timeoutMs)])]
      .map(day=>'openspec/changes/archive/'+day+'-'+changeName);
    if(destinations.some(name=>before.directories.has(name)||rowsUnder(before.files,name).length))
      return stop('NOT_ATTEMPTED','ARCHIVE_DESTINATION_EXISTS');
    const affectedSpecs=activeRows.map(([name])=>/^specs\/([^/]+)\/spec\.md$/u.exec(name))
      .filter(Boolean).map(match=>'openspec/specs/'+match[1]+'/spec.md').sort();
    result.preArchive={sourceSnapshotSha256:before.sourceSnapshotSha256,
      businessPatchSha256:before.businessPatchSha256,changeFilesSha256:digest(activeRows),
      checkpoint,invokedAt,deadlineAt};
    const args=['archive',changeName,'--yes'];
    result.invocation={args,timeoutMs,startedAt:invokedAt};
    try {
      result.command=await invokeArchive({args,timeoutMs,deadlineAt,
        signal:AbortSignal.timeout(Math.max(1,timeoutMs))});
    } catch(error) {
      result.command={exitCode:Number.isInteger(error?.code)?error.code:null,outputComplete:false,
        errorName:error?.name??'Error',stdout:typeof error?.stdout==='string'?error.stdout:'',
        stderr:typeof error?.stderr==='string'?error.stderr:''};
    }
    after=snapshot(await capture({phase:'after-archive',changeName,deadlineAt}));
    result.postArchive={sourceSnapshotSha256:after.sourceSnapshotSha256,businessPatchSha256:after.businessPatchSha256,
      inventorySha256:openSpecArchiveInventorySha256(after)};
    result.changedPaths=differences(before,after);
    result.deliveryFiles=result.changedPaths.map(path=>after.files.has(path)?{path,...after.files.get(path)}:{path,deleted:true});
    const newDestinations=destinations.filter(name=>after.directories.has(name)&&!before.directories.has(name));
    result.activeChangeGone=!after.directories.has(active)&&rowsUnder(after.files,active).length===0;
    result.newArchivePaths=newDestinations;
    result.implementationUnchanged=before.businessPatchSha256===after.businessPatchSha256;
    result.archiveFilesExact=newDestinations.length===1&&same(rowsUnder(after.files,newDestinations[0]),activeRows);
    result.changedDirectories=[...new Set([...before.directories,...after.directories])]
      .filter(name=>before.directories.has(name)!==after.directories.has(name)).sort();
    const allowedMasterDirectories=new Set(['openspec/specs',...affectedSpecs.map(name=>name.slice(0,-8))]);
    result.allowedDocsOnly=newDestinations.length===1&&result.changedPaths.every(name=>
      name.startsWith(active+'/')||name.startsWith(newDestinations[0]+'/')||affectedSpecs.includes(name))
      &&result.changedDirectories.every(name=>name===active||name.startsWith(active+'/')
        ||name===newDestinations[0]||name.startsWith(newDestinations[0]+'/')
        ||name==='openspec/changes/archive'||allowedMasterDirectories.has(name));
    if(result.command?.exitCode!==0||result.command?.outputComplete!==true)
      return stop('UNVERIFIED_OR_PARTIAL','ARCHIVE_COMMAND_FAILED_OR_PARTIAL');
    if(!result.activeChangeGone||newDestinations.length!==1||!result.archiveFilesExact)
      return stop('UNVERIFIED_OR_PARTIAL','ARCHIVE_MOVE_POSTCONDITION_UNVERIFIED');
    if(!result.implementationUnchanged||!result.allowedDocsOnly)
      return stop('UNVERIFIED_OR_PARTIAL','ARCHIVE_SCOPE_OR_IMPLEMENTATION_CHANGED');
    if(now()>=deadlineAt)return stop('UNVERIFIED_OR_PARTIAL','ARCHIVE_FINISHED_OUTSIDE_ORIGINAL_BUDGET');
    result.actualArchiveObserved=true;
    result.mergedValidation=await validateMerged({changeName,archivePath:newDestinations[0],
      affectedSpecs,sourceSnapshotSha256:after.sourceSnapshotSha256,deadlineAt,
      timeoutMs:Math.min(90000,deadlineAt-now())});
    if(result.mergedValidation?.valid!==true||result.mergedValidation?.exitCode!==0
      ||result.mergedValidation?.sourceSnapshotSha256!==after.sourceSnapshotSha256
      ||!Array.isArray(result.mergedValidation.checkedSpecPaths)
      ||affectedSpecs.some(name=>!result.mergedValidation.checkedSpecPaths.includes(name)))
      return stop('UNVERIFIED_OR_PARTIAL','ARCHIVE_MERGED_SPECS_UNVERIFIED');
    if(now()>=deadlineAt)return stop('UNVERIFIED_OR_PARTIAL','ARCHIVE_FINISHED_OUTSIDE_ORIGINAL_BUDGET');
    result.finalCodeCheck=await finalCheck({changeName,deadlineAt,
      sourceSnapshotSha256:after.sourceSnapshotSha256,businessPatchSha256:after.businessPatchSha256});
    if(result.finalCodeCheck?.executed!==true||result.finalCodeCheck?.complete!==true
      ||result.finalCodeCheck?.success!==true
      ||result.finalCodeCheck?.sourceSnapshotSha256!==after.sourceSnapshotSha256
      ||result.finalCodeCheck?.businessPatchSha256!==after.businessPatchSha256)
      return stop('UNVERIFIED_OR_PARTIAL','ARCHIVE_CURRENT_FINAL_CHECK_UNVERIFIED');
    const terminal=snapshot(await capture({phase:'after-final-check',changeName,deadlineAt}));
    if(terminal.sourceSnapshotSha256!==after.sourceSnapshotSha256
      ||terminal.businessPatchSha256!==after.businessPatchSha256
      ||differences(after,terminal).length)
      return stop('UNVERIFIED_OR_PARTIAL','ARCHIVE_FINAL_SUBJECT_CHANGED');
    if(now()>=deadlineAt)return stop('UNVERIFIED_OR_PARTIAL','ARCHIVE_FINISHED_OUTSIDE_ORIGINAL_BUDGET');
    result.complete=true;return stop('COMPLETE','ARCHIVE_AND_CURRENT_FINAL_CHECK_OBSERVED');
  } catch(error) {
    result.errorName=error?.name??'Error';
    return stop(result.invocation?'UNVERIFIED_OR_PARTIAL':'NOT_ATTEMPTED',
      /^[A-Z0-9_]+$/u.test(error?.message??'')?error.message:'ARCHIVE_PHASE_UNAVAILABLE');
  }
}
