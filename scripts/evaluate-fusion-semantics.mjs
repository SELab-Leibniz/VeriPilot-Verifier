// Deterministic cross-branch experiments. Scripted verdicts test requirement,
// scope and receipt transport only; these are not model-accuracy samples.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const args=process.argv.slice(2),arg=k=>args[args.indexOf(k)+1];
const source=path.resolve(arg('--source')),output=path.resolve(arg('--output'));
const load=f=>import(pathToFileURL(path.join(source,f)).href);
const {handleRuntimeV2Event}=await load('lib/runtime-v2/orchestrator.mjs');
const {compileRuntimeV2Config}=await load('lib/runtime-v2/config.mjs');
const {ensureTask}=await load('lib/runtime-v2/task-store.mjs');
const {applyGroundTruthDelta,freezeGroundTruth,loadCurrentGroundTruth}=await load('lib/runtime-v2/ground-truth-ledger.mjs');
const {buildMetricPopulation}=await load('lib/runtime-v2/metrics.mjs');
const {GROUND_TRUTH_REVIEW_SCHEMA}=await load('lib/runtime-v2/reviewer.mjs');
const supportsImplementationRole=!!GROUND_TRUTH_REVIEW_SCHEMA.properties.operations.items.properties.implementationRole;
const workspace=await fs.access(path.join(source,'lib/runtime-v2/stop-workspace-review.mjs')).then(()=>true,()=>false);
const run=workspace?(await load('test/helpers/scripted-workspace-review.mjs')).scriptedWorkspaceReview:(await load('lib/runtime-v2/stop-task-group.mjs')).runStopTaskGroup;
const observed=workspace?null:(await load('test/helpers/observed-review.mjs')).observedTaskResult;
const catalog=id=>({ref:`transcript:${id}`,kind:'USER_MESSAGE',aliases:[id,'user']});
const operation=(text,id,extra={})=>({operation:'ADD',category:'requirements',text,authority:'USER_EXPLICIT',severity:'HARD',applicabilityKind:'CURRENT_TASK',verificationTarget:'IMPLEMENTATION',...(supportsImplementationRole?{implementationRole:'PRODUCTION'}:{}),source:{ref:`transcript:${id}`,kind:'USER_MESSAGE',subject:'MAIN_TASK'},...extra});
const records=[];
for(const scenario of ['new-user-at-stop','empty-stage','test-source-ownership']){
 const root=path.join(output,scenario);await fs.mkdir(root,{recursive:true});await fs.writeFile(path.join(root,'app.py'),'def quicksort(v): return sorted(v)\ndef insertion_sort(v): return sorted(v)\n');
 const transcript=path.join(root,'conversation.jsonl'),entries=[{type:'user',uuid:'U1',message:{role:'user',content:'Implement quicksort.'}},{type:'assistant',uuid:'A1',message:{role:'assistant',content:'Implementation complete.'}}];
 const persist=()=>fs.writeFile(transcript,entries.map(JSON.stringify).join('\n')+'\n');await persist();
 const task=await ensureTask({projectRoot:root,sessionId:'semantic'});
 await applyGroundTruthDelta({projectRoot:root,taskId:task.taskId,sourceCatalog:[catalog('U1')],delta:{operations:[operation('Implement quicksort.','U1')]}});
 await freezeGroundTruth({projectRoot:root,taskId:task.taskId});
 const runtimeV2=compileRuntimeV2Config({version:2,dynamicGroundTruth:{enabled:true,panel:{size:0}},skillCorrection:{enabled:false},implementationCorrection:{enabled:false,platform:null},stopCorrection:{enabled:true,metrics:Object.fromEntries(Array.from({length:16},(_,i)=>[`M${String(i+1).padStart(2,'0')}`,i===15]))}});
 const classification={stopClassification:scenario==='empty-stage'?'STAGE_COMPLETE':'TASK_COMPLETE',stage:scenario==='empty-stage'?'implementation':null};
 const reviewed=[],factory=async input=>{
  if(input.role==='ground-truth-extractor')return{result:{summary:'Controlled delta from original user.',taskClassification:scenario==='new-user-at-stop'?'NEW_TASK':'NO_CHANGE',operations:scenario==='new-user-at-stop'?[operation('Implement insertion sort.','U2')]:[]},close:async()=>{}};
  if(input.request.reviewScope.kind==='classification')return{result:{...classification,summary:'Original output claims completion.',findings:[],metricObjectJudgements:[]},close:async()=>{}};
  if(workspace)return run(input,{file:path.join(root,'app.py'),classification,verdict:item=>{reviewed.push(item.objectId);return'PASS';}});
  return run(input,{runTask:async options=>{for(const item of options.tasks){reviewed.push(item.objectId??item.id);await options.onItemResult(await observed({...options,task:item},{file:'project/app.py',verdict:'PASS'}));}return{completed:true};}});
 };
 factory.supportsStopTasks=true;factory.supportsStopGroups=true;factory.supportsReviewCollection=true;
 const event=(hook,fields={})=>handleRuntimeV2Event({projectRoot:root,plan:{runtimeV2,configuredArtifacts:[{stage:'implementation',metrics:[]}]},reviewerFactory:factory,stopHost:{directory:path.join(root,'host-state')},input:{cwd:root,session_id:'semantic',transcript_path:transcript,hook_event_name:hook,hook_event_id:crypto.randomUUID(),last_assistant_message:'Implementation complete.',...fields}});
 await event('SessionStart',{source:'startup'});
 let record;
 if(scenario==='test-source-ownership'){
  await applyGroundTruthDelta({projectRoot:root,taskId:task.taskId,sourceCatalog:[catalog('U1'),catalog('U2')],delta:{operations:[operation('Write sorting test source.','U2',{implementationRole:'TEST'}),operation('Actually run the sorting tests.','U2',{verificationTarget:'PROCESS',implementationRole:undefined})]}});
  const truth=await loadCurrentGroundTruth(root,task.taskId),p=await buildMetricPopulation({projectRoot:root,taskId:task.taskId,groundTruth:truth});
  record={scenario,m12:p.metrics.M12.length,m16:p.metrics.M16.length,match:p.metrics.M12.length===3&&p.metrics.M16.length===1};
 }else{
  if(scenario==='new-user-at-stop'){entries.push({type:'user',uuid:'U2',message:{role:'user',content:'Also implement insertion sort.'}});await persist();}
  const result=await event('Stop'),truth=await loadCurrentGroundTruth(root,task.taskId);
  const rows=result.stop?.review?.metricObjectJudgements??[];
  record={scenario,status:result.stop?.status,reason:result.stop?.reasonCode,error:result.stop?.error??null,rows,claims:truth.claims.map(c=>c.text),reviewed,scope:result.stop?.review?.scopeSelection??null,
   match:scenario==='new-user-at-stop'?truth.claims.length===2&&rows.length===2&&result.stop.status==='PASS':result.stop?.status==='UNVERIFIED'&&result.stop?.reasonCode==='STOP_STAGE_METRICS_UNDECLARED'&&reviewed.length===0};
 }
 records.push(record);console.log(JSON.stringify(record));
}
await fs.writeFile(path.join(output,'results.json'),JSON.stringify({source,kind:'deterministic-transport-and-semantics',records},null,2));
process.exitCode=records.every(r=>r.match)?0:1;
