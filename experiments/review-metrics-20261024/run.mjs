// Isolated review-only comparison. Oracles never enter any worker workspace.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runReviewTask, captureFiles } from '../../lib/review-task/review-task.mjs';
import { ModelRuntime } from '../../lib/review-task/sdk.mjs';
import { METRIC_CATALOG } from '../../lib/runtime-v2/metrics.mjs';

const lab=path.dirname(fileURLToPath(import.meta.url)), repo=path.resolve(lab,'../..');
const args=process.argv.slice(2), mode=args[0], option=(name,fallback)=>args.find(a=>a.startsWith(`--${name}=`))?.slice(name.length+3)??fallback;
const hash=x=>createHash('sha256').update(x).digest('hex'), read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const save=async(p,v)=>fs.writeFile(p,JSON.stringify(v,null,2)+'\n');
const inside=(r,f)=>{const x=path.relative(r,f);return x!== '..'&&!x.startsWith(`..${path.sep}`)&&!path.isAbsolute(x);};
const fingerprint=async root=>hash(JSON.stringify([...await captureFiles(root)].sort(([a],[b])=>a.localeCompare(b))));
const workerFiles=['lib/review-task/review-task.mjs','lib/review-task/history-memory.mjs','lib/review-task/sdk.mjs','lib/review-task/package-lock.json'];
const workerIdentity=async()=>Object.fromEntries(await Promise.all(workerFiles.map(async f=>[f,hash(await fs.readFile(path.join(repo,f)))])));

async function configuredRuntime(output){
 const files=['.openclaw/openclaw.json','.openclaw/agents/main/agent/models.json'].map(p=>path.join(os.homedir(),p));
 const bytes=await Promise.all(files.map(f=>fs.readFile(f))), [config,cache]=bytes.map(b=>JSON.parse(b));
 const p=config.agents.defaults.model, primary=typeof p==='string'?p:p.primary, slash=primary.indexOf('/');
 const providerId=primary.slice(0,slash), modelId=primary.slice(slash+1), c=config.models.providers[providerId], cached=cache.providers?.[providerId]??{};
 const provider={...cached,...c,apiKey:c.apiKey??cached.apiKey,headers:c.headers??cached.headers};
 const resolve=value=>typeof value==='string'?value.replace(/\$\{([^}]+)\}/gu,(_,name)=>{if(!process.env[name])throw new Error('Configured credential unavailable');return process.env[name];}):value;
 const key=resolve(provider.apiKey), definition=provider.models.find(m=>m.id===modelId||m.id===primary);
 assert(key&&definition&&Number.isInteger(definition.contextWindow));
 const runtime=await ModelRuntime.create({authPath:path.join(output,'unused-auth.json'),modelsPath:null,refreshOnCreate:false});
 runtime.registerProvider('all-metrics-lab',{api:provider.api,baseUrl:provider.baseUrl,apiKey:key,headers:Object.fromEntries(Object.entries(provider.headers??{}).map(([k,v])=>[k,resolve(v)])),models:[{...definition,id:modelId,name:definition.name??modelId,input:['text'],contextWindow:Math.min(definition.contextWindow,config.agents.defaults.contextTokens??Infinity),cost:definition.cost??{input:0,output:0,cacheRead:0,cacheWrite:0}}]});
 return {runtime,model:runtime.getModel('all-metrics-lab',modelId),identity:{primary,contextWindow:definition.contextWindow,contextTokens:config.agents.defaults.contextTokens??null},unchanged:async()=>(await Promise.all(files.map(f=>fs.readFile(f)))).every((b,i)=>b.equals(bytes[i]))};
}

if(mode==='prepare'){
 const destination=path.join(lab,'fixtures');await fs.mkdir(destination);
 const cases=[],profiles={};
 for(const family of ['artifact-family','process-family']){
  const document=await read(path.join(lab,family,'family.json'));Object.assign(profiles,document.profiles);
  for(const item of document.cases){
   assert(/^M(?:0[1-9]|1[0-5])$/u.test(item.metricId)&&METRIC_CATALOG[item.metricId]);
   assert(/^[A-Za-z0-9_-]+$/u.test(item.id)&&['dev','holdout'].includes(item.split)&&['PASS','DEVIATION','UNVERIFIED'].includes(item.expected));
   assert(!cases.some(c=>c.id===item.id));
   const directory=path.join(destination,item.id),workspace=path.join(directory,'workspace');await fs.mkdir(workspace,{recursive:true});
   const basis={...item.basisFiles,'basis/metric.json':JSON.stringify({metricId:item.metricId,...METRIC_CATALOG[item.metricId],scope:item.scope})+'\n'};
   for(const [file,body]of Object.entries({...basis,...item.targetFiles})){
    const target=path.resolve(workspace,file);assert(inside(workspace,target)&&!path.isAbsolute(file)&&!file.includes('..'));
    await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,body);
   }
   const task={id:item.id,metricId:item.metricId,scope:item.scope,phase:'VERIFICATION',requirement:item.requirement,basisFiles:Object.keys(basis),targetFiles:Object.keys(item.targetFiles),targetPrefixes:['project/','process/']};
   await save(path.join(directory,'task.json'),task);await save(path.join(directory,'oracle.json'),{expected:item.expected,mechanism:item.expectedMechanism,scope:item.scope});
   cases.push({id:item.id,metricId:item.metricId,scope:item.scope,split:item.split,fingerprint:await fingerprint(workspace),taskSha256:hash(await fs.readFile(path.join(directory,'task.json'))),oracleSha256:hash(await fs.readFile(path.join(directory,'oracle.json')))});
  }
 }
 await save(path.join(lab,'candidate.json'),{version:'all-metric-candidate-v1',profiles});
 await save(path.join(lab,'freeze.json'),{preparedAt:new Date().toISOString(),cases,workerIdentity:await workerIdentity(),candidateSha256:hash(await fs.readFile(path.join(lab,'candidate.json')))});
 console.log(JSON.stringify({status:'FROZEN',cases:cases.length,metrics:Object.keys(profiles)}));
}else if(mode==='run'){
 const variant=option('variant','baseline'), split=option('split','dev'), runName=option('out',`${variant}-${split}-01`), live=args.includes('--live');
 assert(['baseline','candidate','selected'].includes(variant)&&['dev','holdout','all'].includes(split)&&/^[a-zA-Z0-9-]+$/u.test(runName));
 const freezeFile=option('freeze','freeze.json'),profileFile=option('profile',variant==='selected'?'selected.json':'candidate.json');
 assert(/^[a-zA-Z0-9-]+\.json$/u.test(freezeFile)&&/^[a-zA-Z0-9-]+\.json$/u.test(profileFile));
 const freeze=await read(path.join(lab,freezeFile)),candidateBytes=await fs.readFile(path.join(lab,profileFile)),candidate=JSON.parse(candidateBytes);
 if(variant!=='selected')assert.equal(hash(candidateBytes),freeze.candidateSha256);
 assert.deepEqual(await workerIdentity(),freeze.workerIdentity);
 const only=option('cases',null)?.split(','),selected=freeze.cases.filter(c=>(split==='all'||c.split===split)&&(!only||only.includes(c.id)));
 assert(selected.length);if(only)assert(only.every(id=>selected.some(c=>c.id===id)));
 const output=path.join(lab,runName);await fs.mkdir(output);
 const config=live?await configuredRuntime(output):null;
 await save(path.join(output,'run.json'),{variant,split,live,model:config?.identity,workerIdentity:freeze.workerIdentity,cases:selected.map(c=>c.id),profileHash:hash(candidateBytes),limits:{maxAttempts:2,maxTurns:100,maxTokens:8192,totalTokenBudget:null,deadline:null}});
 const rows=[];let cursor=0,writeQueue=Promise.resolve();
 const runCase=async item=>{
  const directory=path.join(lab,'fixtures',item.id),workspace=path.join(directory,'workspace'),task=await read(path.join(directory,'task.json')),oracle=await read(path.join(directory,'oracle.json'));
  assert.equal(await fingerprint(workspace),item.fingerprint);assert.equal(hash(await fs.readFile(path.join(directory,'task.json'))),item.taskSha256);assert.equal(hash(await fs.readFile(path.join(directory,'oracle.json'))),item.oracleSha256);
  await fs.mkdir(path.join(output,item.id));
  let result,integrity=false,error=null,reusedFrom=null;
  console.log(JSON.stringify({phase:'start',variant,caseId:item.id}));
  try{
   if(live){
    const reuse=option('reuse',null),append=variant==='baseline'?'':candidate.profiles[item.metricId].promptAppend;
    if(reuse&&variant==='selected'&&append===''){
     assert(/^[a-zA-Z0-9-]+$/u.test(reuse));const original=await read(path.join(lab,reuse,item.id,'report.json')),originalRun=await read(path.join(lab,reuse,'run.json'));
     assert.equal(originalRun.variant,'baseline');assert.deepEqual(originalRun.workerIdentity,freeze.workerIdentity);assert.deepEqual(originalRun.model,config.identity);assert(original.result?.completed&&original.inputUnchanged&&original.citationIntegrity);
     result=original.result;reusedFrom=path.join(lab,reuse,item.id,'report.json');
    }else result=await runReviewTask({task,root:workspace,outputDir:path.join(output,item.id,'review'),modelRuntime:config.runtime,model:config.model,maxAttempts:2,maxTurns:100,maxTokens:8192,promptAppend:append});
    for(const ref of result.refs??[]){const bytes=await fs.readFile(path.join(result.artifacts,'frozen-source',ref.path));assert.equal(hash(bytes),ref.sha256);assert(ref.start>=1&&ref.end>=ref.start&&ref.end<=bytes.toString('utf8').split('\n').length);}
    integrity=true;
   }
  }catch(e){error={code:e.code??'EXPERIMENT_ERROR',message:'Review failed; inspect private worker trace.'};}
  const row={caseId:item.id,metricId:item.metricId,split:item.split,scope:item.scope,expected:oracle.expected,expectedMechanism:oracle.mechanism,result,citationIntegrity:integrity,labelMatches:live?Boolean(result?.completed&&result.verdict===oracle.expected):null,error,reusedFrom,inputUnchanged:await fingerprint(workspace)===item.fingerprint,semanticAudit:'PENDING'};
  await save(path.join(output,item.id,'report.json'),row);rows.push(row);writeQueue=writeQueue.then(()=>save(path.join(output,'progress.json'),{rows}));await writeQueue;
  console.log(JSON.stringify({phase:'finished',variant,caseId:item.id,completed:result?.completed,verdict:result?.verdict,labelMatches:row.labelMatches,reason:result?.reason,turns:result?.metrics?.turns,elapsedMs:result?.elapsedMs}));
 };
 await Promise.all(Array.from({length:Math.min(2,selected.length)},async()=>{while(cursor<selected.length)await runCase(selected[cursor++]);}));await writeQueue;
 const protectedInputs=rows.every(r=>r.inputUnchanged)&&JSON.stringify(await workerIdentity())===JSON.stringify(freeze.workerIdentity)&&(!config||await config.unchanged())&&hash(await fs.readFile(path.join(lab,profileFile)))===hash(candidateBytes);
 const report={variant,split,mode:live?'LIVE_REVIEW_ONLY':'PREFLIGHT',status:protectedInputs?'COMPLETE_PENDING_SEMANTIC_AUDIT':'INPUT_CHANGED',protectedInputs,rows:rows.sort((a,b)=>a.caseId.localeCompare(b.caseId)),summary:{cases:rows.length,completed:rows.filter(r=>r.result?.completed).length,labelMatches:rows.filter(r=>r.labelMatches).length,citationIntegrity:rows.filter(r=>r.citationIntegrity).length},originalProjectOrSessionUsed:false,productionIntegrated:false,businessExecution:false};
 await save(path.join(output,'report.json'),report);console.log(JSON.stringify({output,summary:report.summary,status:report.status}));
 if(!protectedInputs||live&&rows.some(r=>!r.result?.completed))process.exitCode=1;
}else throw new Error('prepare | run --variant=baseline|candidate|selected --split=dev|holdout|all --out=NEW [--live]');
