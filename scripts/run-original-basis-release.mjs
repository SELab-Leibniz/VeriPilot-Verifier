
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { runBoundedProcess } from './bench/bounded-process.mjs';
import { digest, loadArktsTask } from './bench/arkts-dataset.mjs';
import { arktsHiddenReward } from './bench/simplify-arkts-inputs.mjs';
import { applyJavaEnvironment, resolveJavaHome } from './bench/arkts-java.mjs';
import { loadRcConfigOverrides } from './bench/rc-config-overrides.mjs';
import { collectReleaseEvidence, computeReleaseVerdict } from './bench/release-evidence.mjs';
import { seedReleaseRoot } from './bench/seed-release-root.mjs';
import { countProfileCredentialMatches, redactEvaluationText, resolveSimplifyProvider } from './helpers/simplify-native-evaluation.mjs';

const usage = `node scripts/run-original-basis-release.mjs --phase=quick|e2e --root=<run root> --deadline-at=<epoch ms>
  --host-root=<OpenClaw 2026.7.1-2> --tool-root=<command-line-tools> --dataset=<swe-arkts-bench> --package=<tgz> --openclaw-profile=<profile>
  [--release=<out>/release.json | --package-sha256=<sha> --source-commit=<sha>]   new package from scripts/build-release-package.mjs
  [--java-home=<jdk>]                              else RC_JAVA_HOME, JAVA_HOME, DevEco Studio jbr
  [--rc-config-overrides=<json>]                   deep-merged into the business RC config (see scripts/bench/arkts-regression-check.mjs --help)
  [--stop-profile=assessment|release]              quick only: release uses the template stopCorrection (waitMode until_pass)
  [--baseline-local-tests]                         record the workspace's own tests before the model starts
  [--seed-from=<old root>]                         fresh root: mirror the bare cache, pin frozen commits, copy the pinned workflow
  [--rate-limit-backoff-ms=300000] [--pair-pause-ms=90000] [--resume]`;
const { values: args } = parseArgs({ options: Object.fromEntries([
  ...['phase','root','host-root','tool-root','dataset','package','openclaw-profile','deadline-at','release','package-sha256','source-commit','java-home',
    'rc-config-overrides','stop-profile','seed-from','rate-limit-backoff-ms','pair-pause-ms'].map(key=>[key,{type:'string'}]),
  ...['resume','baseline-local-tests','help'].map(key=>[key,{type:'boolean'}]),
]) });
if(args.help){ console.log(usage); process.exit(0); }
if(args.release){
  const release=JSON.parse(await fs.readFile(args.release,'utf8'));
  assert(!args.package&&!args['package-sha256']&&!args['source-commit'], '--release replaces --package, --package-sha256 and --source-commit');
  Object.assign(args,{package:release.archive,'package-sha256':release.packageSha256,'source-commit':release.sourceCommit});
}
const root = path.resolve(args.root);
const phase = args.phase;
assert(['quick','e2e'].includes(phase), usage);
const deadline = Number(args['deadline-at']);
assert(Number.isFinite(deadline));
const stopProfile = args['stop-profile'] ?? 'assessment';
assert(['assessment','release'].includes(stopProfile) && (stopProfile==='assessment' || phase==='quick'));
const read = async file => JSON.parse(await fs.readFile(file,'utf8'));
const optional = file => read(file).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
const write = (file,data)=>fs.writeFile(file,JSON.stringify(data,null,2)+'\n',{flag:'wx'});
const inputFile = 'docs/original-basis-release-inputs.json';
const inputBytes=await fs.readFile(inputFile), inputs=JSON.parse(inputBytes);
// A new package is admitted only with its exact source commit; each runner
// re-verifies the archive digest and every runtime module against it.
const packageSha256=args['package-sha256']??inputs.packageSha256, sourceCommit=args['source-commit']??null;
assert(packageSha256===inputs.packageSha256 || /^[0-9a-f]{40}$/u.test(sourceCommit??''), '--package-sha256 for a new package requires --source-commit');
assert.equal(digest(await fs.readFile(args.package)),packageSha256);
const overrides=await loadRcConfigOverrides(args['rc-config-overrides'] && path.resolve(args['rc-config-overrides']));
const java=resolveJavaHome({explicit:args['java-home']});
applyJavaEnvironment(java.javaHome);
if(args['seed-from']&&!args.resume) await seedReleaseRoot({from:args['seed-from'],root,frozen:inputs.frozen,dataset:args.dataset,label:'seed-'+phase});
const model='deepseek-v4-flash';
const {identity,credential}=await resolveSimplifyProvider('host-profile',model,args['openclaw-profile']);
const batch=path.join(root,phase);
if(!args.resume) await fs.mkdir(batch,{recursive:Boolean(args['seed-from'])});
const identityFile=path.join(batch,'identity.json');
const schedule = phase==='quick' ? [1,2].flatMap(repeat=>inputs.frozen.map(sample=>({id:sample.id+'-'+repeat,group:repeat,case:sample.case,sample})))
  : ['security_tool_1','security_tool_2'].map(id=>({id,case:id,group:1}));
// Experiment arms are part of the identity, so a resume can never mix them.
const pinned = { phase, manifestSha256:digest(inputBytes), packageSha256, identity, schedule, deadline,
  ...(sourceCommit?{sourceCommit}:{}), ...(overrides?{rcConfigOverridesSha256:overrides.sha256}:{}),
  ...(stopProfile!=='assessment'?{stopProfile}:{}), ...(args['baseline-local-tests']?{baselineLocalTests:true}:{}) };
if(args.resume) assert.deepEqual(await read(identityFile),pinned);
else await write(identityFile,pinned);
const fallbackFile=path.join(batch,'serial-fallback.json');
let serial = Boolean(await optional(fallbackFile) || phase === 'e2e' && await optional(path.join(root,'quick','serial-fallback.json')));
const common = { 'host-root':args['host-root'], 'tool-root':args['tool-root'], dataset:args.dataset, package:args.package,
  'openclaw-profile':args['openclaw-profile'], provider:'host-profile', model, cache:path.join(root,'cache'),
  'workspace-root':path.join(root,'b'), 'json5-package':path.join(args['host-root'],'package.json'), 'java-home':java.javaHome };
const cli = flags => Object.entries(flags).map(([key,value])=>'--'+key+'='+value);
const observations=[];
for(const slot of schedule) {
  const files=(await fs.readdir(batch)).filter(name=>name.startsWith(slot.id+'-attempt-')).sort();
  for (const name of files) {
    const saved=await read(path.join(batch,name,'observation.json'));
    assert.equal(saved.slot,slot.id);
    assert.equal(saved.manifestSha256,pinned.manifestSha256);
    observations.push(saved);
  }
}
const limited = row => ['rate-limited','peer-paused'].includes(row.state);
function retained(slot) { return observations.find(row=>row.slot===slot.id && !row.frameworkError && !limited(row)); }
const logLines=async directory=>{
  const names=await fs.readdir(directory).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
  return Promise.all(names.filter(name=>/\.log$/u.test(name)&&!name.endsWith('.coverage.log')).map(async name=>({
    file:path.join(directory,name),text:await fs.readFile(path.join(directory,name),'utf8'),
  })));
};
let scanHits=0;
const progress = async latest => {
  const remaining = schedule.filter(slot=>!retained(slot)).length;
  await fs.writeFile(path.join(root,'progress.md'),[
    '# RC 原文简化版进度','',
    '- 当前步骤　'+(phase==='quick'?'冻结对象快速验证':'端到端'),
    '- 已完成序号　'+(schedule.length-remaining)+'/'+schedule.length,
    '- 最近一次　'+latest.slot+' '+latest.state+(latest.verdict?' 跑通='+latest.verdict.runThrough:''),
    '- 限流或错误　'+(latest.reason??'无'),
    '- 预计剩余时间　'+(remaining? (phase==='quick'?'下一组约 10 分钟内完成首轮审查':'端到端外层上限每次 120 分钟'):'0'),
    '',
  ].join('\n'));
};
async function executeSlot(slot, concurrency, rateFile, controller) {
  const previous=observations.filter(row=>row.slot===slot.id);
  if(previous.filter(row=>row.frameworkError).length>=3) throw new Error('Infrastructure retry cap reached for '+slot.id);
  if(previous.filter(limited).length>=4) throw new Error('Rate-limit retry cap reached for '+slot.id);
  const attempt=previous.length+1, output=path.join(batch,slot.id+'-attempt-'+attempt);
  await fs.mkdir(output);
  const evaluation=path.join(output,'evaluation');
  const startedAt=Date.now();
  const options={...common,case:slot.case,output:evaluation,'package-sha256':packageSha256,
    ...(sourceCommit?{'source-commit':sourceCommit}:{}), ...(overrides?{'rc-config-overrides':overrides.file}:{}),
    ...(rateFile?{'pair-rate-limit-file':rateFile,'pair-rate-limit-pause-ms':Number(args['pair-pause-ms']??90_000)}:{})};
  let command, timeout;
  if(phase==='quick'){
    command=['scripts/run-arkts-rc-case.mjs','--live','--release-build',...(args['baseline-local-tests']?['--baseline-local-tests']:[]),...cli({...options,
      'simplify-arm':'B12','phase-timeout-ms':600000,'plan-sha256':inputs.planSha256,'stop-profile':stopProfile,
      frozen:slot.sample.root,'freeze-sha256':slot.sample.sha256,'frozen-package-sha256':inputs.frozenSourceSha256})];
    timeout=65*60_000;
  } else {
    command=['scripts/run-release-e2e.mjs','--live',...(args['baseline-local-tests']?['--baseline-local-tests']:[]),
      ...cli({...options,'workflow-root':path.join(root,'workflow'),'deadline-at':Math.min(deadline,startedAt+120*60_000-8000)})];
    timeout=120*60_000;
  }
  const execution=await runBoundedProcess(process.execPath,command,{
    timeoutMs:Math.min(timeout,deadline-startedAt),maxTail:10_000,signal:controller.signal,
  });
  const result=await optional(path.join(evaluation,'result.json'));
  const manifest=await optional(path.join(evaluation,'manifest.json'));
  const boundary=await optional(path.join(evaluation,'provider-boundary.json'));
  const requests=boundary?.requests??result?.modelRequests??0;
  const peerPaused=boundary?.failure==='PROFILE_PAIR_RATE_LIMIT';
  const rateLimited=!peerPaused && Boolean(boundary?.failure?.includes('RATE_LIMIT') || result?.state==='rate-limited');
  let frameworkError=!rateLimited && !peerPaused && Boolean(result?.frameworkError || !result && execution.reason!=='deadline');
  let hidden=null, hiddenError=null;
  if(phase==='e2e'&&result?.frozen&&!rateLimited&&!peerPaused&&!frameworkError&&Date.now()<deadline){
    const calibration=inputs.calibration[slot.case];
    assert.equal(digest(await fs.readFile(path.join(calibration.root,'results.json'))),calibration.sha256);
    const grader=await runBoundedProcess(process.execPath,['scripts/calibrate-arkts-bench.mjs',
      ...cli(Object.fromEntries(['case','dataset','tool-root','cache','workspace-root','json5-package','java-home'].map(key=>[key,options[key]]))),
      ...cli({output:path.join(output,'grading'),candidate:path.join(evaluation,'freeze/candidate.patch'),
        'calibration-dir':calibration.root,'phase-timeout-ms':600000})],
      { timeoutMs:Math.max(1,Math.min(15*60_000,deadline-Date.now())),maxTail:6000,signal:controller.signal });
    const grade=await optional(path.join(output,'grading/results.json'));
    if (!grade) { frameworkError=true; hiddenError=redactEvaluationText(grader.tail||grader.reason); }
    else {
      const {datasetDigest}=await loadArktsTask(args.dataset,slot.case);
      const candidate=grade.results.find(row=>row.phase==='candidate');
      hidden={ execution:candidate?.execution,executed:candidate?.executed===true,
        score:arktsHiddenReward(grade,result.frozen.patchSha256,slot.case,datasetDigest),
        evidence:path.join(output,'grading/results.json') };
    }
  }
  const logs=await Promise.all([logLines(evaluation),logLines(path.join(output,'grading')),
    manifest?.projectRoot ? logLines(path.join(manifest.projectRoot,'.runtime-correction/bench-checks')) : []]);
  const joined=logs.flat();
  const conflict=joined.some(({text})=>/EADDRINUSE|Address already in use|Previewer[^\r\n]{0,160}(?:port.{0,40}(?:occupied|in use|conflict)|端口.{0,20}(?:占用|冲突))/iu.test(text));
  frameworkError ||= conflict;
  const locks=joined.flatMap(({file,text})=>[...text.matchAll(/^\[RC_ARKTS_LOCK\] (\{[^\r\n]*\})/gmu)].map(match=>({file,...JSON.parse(match[1])})));
  const matches=await countProfileCredentialMatches(output,credential)
    +(manifest?.projectRoot ? await countProfileCredentialMatches(manifest.projectRoot,credential) : 0);
  await write(path.join(output,'leak-scan.json'),{matches});
  scanHits+=matches;
  if(matches) controller.abort();
  let verdict=null;
  if(phase==='e2e'&&result&&manifest?.projectRoot){
    const evidence=result.stopReviews ? result : await collectReleaseEvidence({projectRoot:manifest.projectRoot,sessionId:result.sessionId,
      nativeRoot:path.join(evaluation,'native-host'),turns:result.turns??[]});
    const computed=computeReleaseVerdict({businessNatural:result.businessNatural,frameworkError,hidden,documentReviews:evidence.documentReviews,
      stopReviews:evidence.stopReviews,materialBasis:evidence.materialBasis??[],turns:result.turns??[],mutationPaths:result.frozen?.mutationPaths,
      nativeStopRecords:evidence.nativeStopRecords??result.nativeStopRecords??[],nativeStopSettled:result.nativeStopSettled??null});
    verdict={runThrough:computed.runThrough,reasons:computed.reasons,finalCoverage:computed.finalCoverage,codeChanged:computed.codeChanged};
  }
  const state=peerPaused?'peer-paused':rateLimited?'rate-limited':frameworkError?'framework-error':result?.state??'timed-out';
  const observation={slot:slot.id,attempt,manifestSha256:pinned.manifestSha256,concurrency,startedAt,elapsedMs:Date.now()-startedAt,
    state,reason:conflict?'PREVIEWER_PORT_CONFLICT':boundary?.failure??result?.reason??execution.reason,frameworkError,
    modelRequests:requests,pairPausedMs:boundary?.pairPausedMs??null,java:manifest?.java??null,result,hidden,hiddenError,locks,matches,evidence:output,
    ranThrough:phase==='e2e' ? verdict?.runThrough===true : null,verdict,
    processTail:matches?'[withheld after credential scan]':result?null:redactEvaluationText(execution.tail)};
  await write(path.join(output,'observation.json'),observation);
  observations.push(observation);
  await progress(observation);
  console.log(JSON.stringify({slot:slot.id,state,ranThrough:observation.ranThrough,reasons:verdict?.reasons,matches}));
  return observation;
}
if(!observations.length&&!args.resume&&phase==='e2e'){
  for(const calibration of Object.values(inputs.calibration)) assert.equal(digest(await fs.readFile(path.join(calibration.root,'results.json'))),calibration.sha256);
}
const backoffMs=Number(args['rate-limit-backoff-ms']??300_000);
for(const group of [...new Set(schedule.map(slot=>slot.group))]){
  for(;;){
    const queue=schedule.filter(slot=>slot.group===group&&!retained(slot));
    if(!queue.length || Date.now()+1000>=deadline) break;
    const slots=queue.slice(0,serial?1:queue.length);
    const rateFile=slots.length>1 ? path.join(batch,'rate-'+group+'-'+Date.now()+'.txt'):null;
    const controller=new AbortController();
    const results=await Promise.allSettled(slots.map(slot=>executeSlot(slot,slots.length,rateFile,controller)));
    if(scanHits) throw new Error('Credential scan matches: '+scanHits);
    for(const item of results) if(item.status==='rejected') throw item.reason;
    const errors=results.map(item=>item.value).filter(row=>row.frameworkError||limited(row));
    if(!errors.length) continue;
    if(slots.length>1 && !serial){
      serial=true;
      await write(fallbackFile,{at:new Date().toISOString(),affected:errors.map(({slot,state,reason})=>({slot,state,reason}))});
    }
    // Infrastructure errors stop the batch; provider rate limits back off and
    // continue serially inside the same deadline.
    if(errors.some(row=>row.frameworkError)){ process.exitCode=1; break; }
    await sleep(Math.max(0,Math.min(backoffMs,deadline-Date.now()-1000)));
  }
  if(process.exitCode) break;
}
await write(path.join(batch,'observations-'+Date.now()+'.json'),{observations,retained:schedule.map(retained).filter(Boolean),serial});
