
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { runBoundedProcess } from './bench/bounded-process.mjs';
import { digest, loadArktsTask } from './bench/arkts-dataset.mjs';
import { arktsHiddenReward } from './bench/simplify-arkts-inputs.mjs';
import { countProfileCredentialMatches, redactEvaluationText, resolveSimplifyProvider } from './helpers/simplify-native-evaluation.mjs';

const { values: args } = parseArgs({ options: Object.fromEntries([
  ...['phase','root','host-root','tool-root','dataset','package','openclaw-profile','deadline-at'].map(key=>[key,{type:'string'}]),
  ['resume',{type:'boolean'}],
]) });
const root = path.resolve(args.root);
const phase = args.phase;
assert(['quick','e2e'].includes(phase));
const deadline = Number(args['deadline-at']);
assert(Number.isFinite(deadline));
const read = async file => JSON.parse(await fs.readFile(file,'utf8'));
const optional = file => read(file).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
const write = (file,data)=>fs.writeFile(file,JSON.stringify(data,null,2)+'\n',{flag:'wx'});
const inputFile = 'docs/original-basis-release-inputs.json';
const inputBytes=await fs.readFile(inputFile), inputs=JSON.parse(inputBytes);
assert.equal(digest(await fs.readFile(args.package)),inputs.packageSha256);
const model='deepseek-v4-flash';
const {identity,credential}=await resolveSimplifyProvider('host-profile',model,args['openclaw-profile']);
const batch=path.join(root,phase);
if(!args.resume) await fs.mkdir(batch);
const identityFile=path.join(batch,'identity.json');
const schedule = phase==='quick' ? [1,2].flatMap(repeat=>inputs.frozen.map(sample=>({id:sample.id+'-'+repeat,group:repeat,case:sample.case,sample})))
  : ['security_tool_1','security_tool_2'].map(id=>({id,case:id,group:1}));
const pinned = { phase, manifestSha256:digest(inputBytes), packageSha256:inputs.packageSha256, identity, schedule, deadline };
if(args.resume) assert.deepEqual(await read(identityFile),pinned);
else await write(identityFile,pinned);
const fallbackFile=path.join(batch,'serial-fallback.json');
let serial = Boolean(await optional(fallbackFile) || phase === 'e2e' && await optional(path.join(root,'quick','serial-fallback.json')));
const common = { 'host-root':args['host-root'], 'tool-root':args['tool-root'], dataset:args.dataset, package:args.package,
  'openclaw-profile':args['openclaw-profile'], provider:'host-profile', model, cache:path.join(root,'cache'),
  'workspace-root':path.join(root,'b'), 'json5-package':path.join(args['host-root'],'package.json') };
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
function retained(slot) { return observations.find(row=>row.slot===slot.id && !row.frameworkError && row.state!=='rate-limited'); }
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
    '- 最近一次　'+latest.slot+' '+latest.state,
    '- 限流或错误　'+(latest.reason??'无'),
    '- 预计剩余时间　'+(remaining? (phase==='quick'?'下一组约 10 分钟内完成首轮审查':'端到端外层上限每次 120 分钟'):'0'),
    '',
  ].join('\n'));
};
async function executeSlot(slot, concurrency, rateFile, controller) {
  const previous=observations.filter(row=>row.slot===slot.id);
  if(previous.filter(row=>row.frameworkError).length>=3) throw new Error('Infrastructure retry cap reached for '+slot.id);
  const attempt=previous.length+1, output=path.join(batch,slot.id+'-attempt-'+attempt);
  await fs.mkdir(output);
  const evaluation=path.join(output,'evaluation');
  const startedAt=Date.now();
  const options={...common,case:slot.case,output:evaluation,'package-sha256':inputs.packageSha256,
    ...(rateFile?{'pair-rate-limit-file':rateFile}:{})};
  let command, timeout;
  if(phase==='quick'){
    command=['scripts/run-arkts-rc-case.mjs','--live','--release-build',...cli({...options,
      'simplify-arm':'B12','phase-timeout-ms':600000,'plan-sha256':inputs.planSha256,
      frozen:slot.sample.root,'freeze-sha256':slot.sample.sha256,'frozen-package-sha256':inputs.frozenSourceSha256})];
    timeout=65*60_000;
  } else {
    command=['scripts/run-release-e2e.mjs','--live',...cli({...options,'workflow-root':path.join(root,'workflow'),
      'deadline-at':Math.min(deadline,startedAt+120*60_000-8000)})];
    timeout=120*60_000;
  }
  const execution=await runBoundedProcess(process.execPath,command,{
    timeoutMs:Math.min(timeout,deadline-startedAt),maxTail:10_000,signal:controller.signal,
  });
  const result=await optional(path.join(evaluation,'result.json'));
  const manifest=await optional(path.join(evaluation,'manifest.json'));
  const boundary=await optional(path.join(evaluation,'provider-boundary.json'));
  const requests=boundary?.requests??result?.modelRequests??0;
  const rateLimited=Boolean(boundary?.failure?.includes('RATE_LIMIT') || result?.state==='rate-limited');
  let frameworkError=!rateLimited && Boolean(result?.frameworkError || !result && execution.reason!=='deadline');
  let hidden=null, hiddenError=null;
  if(phase==='e2e'&&result?.frozen&&!rateLimited&&!frameworkError&&Date.now()<deadline){
    const calibration=inputs.calibration[slot.case];
    assert.equal(digest(await fs.readFile(path.join(calibration.root,'results.json'))),calibration.sha256);
    const grader=await runBoundedProcess(process.execPath,['scripts/calibrate-arkts-bench.mjs',
      ...cli(Object.fromEntries(['case','dataset','tool-root','cache','workspace-root','json5-package'].map(key=>[key,options[key]]))),
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
  const state=rateLimited?'rate-limited':frameworkError?'framework-error':result?.state??'timed-out';
  const observation={slot:slot.id,attempt,manifestSha256:pinned.manifestSha256,concurrency,startedAt,elapsedMs:Date.now()-startedAt,
    state,reason:conflict?'PREVIEWER_PORT_CONFLICT':boundary?.failure??result?.reason??execution.reason,frameworkError,
    modelRequests:requests,result,hidden,hiddenError,locks,matches,evidence:output,ranThrough:phase==='e2e'
      ? Boolean(result?.businessNatural && result.documentReviews?.length && result.stopSettled && hidden?.executed) : null,
    processTail:matches?'[withheld after credential scan]':result?null:redactEvaluationText(execution.tail)};
  await write(path.join(output,'observation.json'),observation);
  observations.push(observation);
  await progress(observation);
  console.log(JSON.stringify({slot:slot.id,state,ranThrough:observation.ranThrough,matches}));
  return observation;
}
if(!observations.length&&!args.resume&&phase==='e2e'){
  for(const calibration of Object.values(inputs.calibration)) assert.equal(digest(await fs.readFile(path.join(calibration.root,'results.json'))),calibration.sha256);
}
for(const group of [...new Set(schedule.map(slot=>slot.group))]){
  const queue=schedule.filter(slot=>slot.group===group&&!retained(slot));
  while(queue.length && Date.now()+1000<deadline){
    const slots=queue.splice(0,serial?1:queue.length);
    const rateFile=slots.length>1 ? path.join(batch,'rate-'+group+'-'+Date.now()+'.txt'):null;
    const controller=new AbortController();
    const results=await Promise.allSettled(slots.map(slot=>executeSlot(slot,slots.length,rateFile,controller)));
    if(scanHits) throw new Error('Credential scan matches: '+scanHits);
    for(const item of results) if(item.status==='rejected') throw item.reason;
    const errors=results.map(item=>item.value).filter(row=>row.frameworkError||row.state==='rate-limited');
    if(errors.length){
      if(slots.length>1 && !serial){
        serial=true;
        await write(fallbackFile,{at:new Date().toISOString(),affected:errors.map(({slot,state,reason})=>({slot,state,reason}))});
      }
      process.exitCode=1;
      break;
    }
  }
  if(process.exitCode) break;
}
await write(path.join(batch,'observations-'+Date.now()+'.json'),{observations,retained:schedule.map(retained).filter(Boolean),serial});
