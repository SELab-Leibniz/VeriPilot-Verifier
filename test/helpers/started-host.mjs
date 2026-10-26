// Driver for legacy mechanism fixtures, which create a brand-new host session
// in a fresh workspace. Production does not import this module. Drive the real
// session ledger and its trusted-start API, instead of treating a block or queue
// acknowledgement as correction usage. The migration/unsupported-host tests use
// the raw production entry and deliberately do not use this driver.
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {handleRuntimeV2Event as handleEvent} from '../../lib/runtime-v2/orchestrator.mjs';
import {createStopCorrectionStore} from '../../lib/runtime-v2/stop-correction-store.mjs';
import {withTaskState} from '../../lib/runtime-v2/task-store.mjs';
import {STOP_REVIEW_SCHEMA} from '../../lib/runtime-v2/reviewer.mjs';
import {markStopFeedbackDelivered} from '../../lib/runtime-v2/deviations.mjs';

export async function runStartedHostEvent(options){
 const input=options.input;
 const directory=path.join(path.dirname(input.transcript_path||path.join(options.projectRoot,'transcript.jsonl')),'.fixture-host-sessions');
 const store=createStopCorrectionStore({directory});
 if(!(await store.inspect(input.session_id)))await store.initializeSession({sessionId:input.session_id,
   initialize:{kind:'NEW_SESSION',evidence:{hook:'session_start',source:'startup',sessionId:input.session_id,fixture:true}}});
 const original=options.reviewerFactory;
 // Old scripted factories use the full Stop schema as their dispatch key.
 // Adapt that mock interface; classification remains a separate invocation.
 const factory=original&&Object.assign(async args=>{
   const classification=args.request?.reviewScope?.kind==='classification';
   const handle=await original(!original.supportsReviewCollection&&args.role==='stop-reviewer'?{...args,schema:STOP_REVIEW_SCHEMA}:args);
   if(classification&&!original.supportsReviewCollection)return {...handle,result:{summary:handle.result.summary??'Scripted scope selection',stopClassification:handle.result.stopClassification,
     stage:handle.result.stage??null,findings:[],metricObjectJudgements:[]}};
   return handle;
 },original);
 if(original?.handoff)factory.handoff=original.handoff;
 const result=await handleEvent({...options,reviewerFactory:factory??original,stopHost:{directory,startProtocol:{version:1},
   stopId:input.hook_event_id??options.assessmentContext?.assessmentId,...options.stopHost}});
 const admission=result.stop?.admission;
 if(admission&&result.stop.status!=='UNVERIFIED'&&options.plan.runtimeV2.shadowMode!==true&&options.assessmentContext?.mode!=='verify_only'){
   await store.delivery({sessionId:input.session_id,admissionId:admission.id,status:'DELIVERED'});
   await store.observeStart({sessionId:input.session_id,admissionId:admission.id,executionId:randomUUID(),observationId:randomUUID(),startedAt:Date.now()});
   const ledger=await store.inspect(input.session_id),used=ledger.flows[admission.flowId].used;
   if(!options.stopFeedbackDeferred)await markStopFeedbackDelivered({projectRoot:options.projectRoot,taskId:result.taskId,evaluationId:result.stop.stopCorrection.evaluationId});
   await withTaskState({projectRoot:options.projectRoot,taskId:result.taskId},state=>{state.stop.correctionAttempts=used;});
   result.stop.correctionAttempt=used;
 }
 return result;
}
