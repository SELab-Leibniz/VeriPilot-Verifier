import path from 'node:path';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {atomicWriteJson,readJson,sha256} from '../runtime-v2/utils.mjs';
import {withTaskResourceLock} from '../runtime-v2/task-store.mjs';
import {outsideDecision} from '../runtime-v2/decision-scope.mjs';
import {boundHostFeedback} from '../runtime-v2/feedback-delivery.mjs';

async function loadTranscriptRuntime(){
 let packageFile;
 try{packageFile=createRequire(import.meta.url).resolve('openclaw/package.json');}
 catch{packageFile=path.join(path.dirname(await fs.realpath(process.argv[1])),'package.json');}
 const pkg=JSON.parse(await fs.readFile(packageFile,'utf8'));
 if(pkg.name!=='openclaw'||pkg.version!=='2026.7.1-2')throw new Error('RC_NOTICE_HOST_UNVERIFIED');
 return import(pathToFileURL(path.join(path.dirname(packageFile),'dist/plugin-sdk/session-transcript-runtime.js')));
}

// The public identity-scoped transcript API checks session ownership, locking
// and idempotency, then broadcasts session.message to MA's existing subscriber.
// It needs neither privileged Gateway dispatch nor credentials or model work.
// Never blindly retry an ambiguous append: reconcile its unique marker first.
export function createReviewNoticePublisher(api,{loadTranscript=loadTranscriptRuntime,
 waitForUi=()=>new Promise(resolve=>setTimeout(resolve,5250))}={}){
 let sdk;
 const native=['2026.7.1-2','2026.10.3'].includes(api.runtime.version);
 return async function publish({state,record,taskId,isCurrent=()=>true}){
  if(!taskId||!['UNVERIFIED','DEVIATION','SKIPPED'].includes(record.reviewStatus)
    ||['ADMITTED','QUEUED','STARTED','WAIT_TERMINAL','ORIGINAL_REQUESTED'].includes(record.followupStatus)
    ||!isCurrent())return;
  const id=sha256([state.sessionId,record.evaluationId??record.occurrenceId??record.runId,record.reasonCode??record.reviewStatus]);
  const file=path.join(state.projectRoot,'.runtime-correction/openclaw/review-notices',id+'.json');
  return outsideDecision(()=>withTaskResourceLock({projectRoot:state.projectRoot,taskId,resource:'review-notice-'+id,reclaimDeadOwner:true},async()=>{
   const old=await readJson(file);
   if(old?.status==='DELIVERED')return old;
   const marker=`[RC_REVIEW_RESULT ${id}]`;
   const notice={id,sessionId:state.sessionId,sessionKey:state.sessionKey,runId:record.runId,
     evaluationId:record.evaluationId,reviewStatus:record.reviewStatus,reasonCode:record.reasonCode,
     marker,status:'PENDING',createdAt:old?.createdAt??Date.now()};
   await atomicWriteJson(file,notice);
   if(!native&&typeof api.runtime.gateway?.request!=='function'){
     notice.status='UNAVAILABLE';notice.error='NATIVE_CHAT_INJECT_UNAVAILABLE';await atomicWriteJson(file,notice);return notice;
   }
   const reconcile=async()=>{
     if(native){
       sdk??=loadTranscript();
       const latest=await (await sdk).readLatestAssistantTextByIdentity({agentId:state.agentId??'main',sessionId:state.sessionId,sessionKey:state.sessionKey});
       return latest?.text?.includes(marker)?latest:null;
     }
     const history=await api.runtime.gateway.request('chat.history',{sessionKey:state.sessionKey,limit:100},{timeoutMs:5000});
     return (history.messages??[]).find(message=>JSON.stringify(message).includes(marker));
   };
   try{
     if(old?.status==='UNKNOWN'||old?.status==='SENDING'){
       const existing=await reconcile();
       if(existing){Object.assign(notice,{status:'DELIVERED',messageId:existing.id??existing.uuid,reconciled:true,deliveredAt:Date.now()});await atomicWriteJson(file,notice);return notice;}
       notice.status='UNKNOWN';notice.error='PREVIOUS_APPEND_NOT_CONFIRMED';await atomicWriteJson(file,notice);return notice;
     }
     if(!isCurrent()){notice.status='STALE';await atomicWriteJson(file,notice);return notice;}
     // MA 1.10.1 suppresses session snapshots for five seconds after a native
     // chat final. A distinct review result must arrive outside that window.
     if(native){
       try{sdk??=loadTranscript();await sdk;}
       catch{notice.status='UNAVAILABLE';notice.error='NATIVE_SESSION_NOTICE_UNAVAILABLE';await atomicWriteJson(file,notice);return notice;}
       await waitForUi();
     }
     if(!isCurrent()){notice.status='STALE';await atomicWriteJson(file,notice);return notice;}
     const message=boundHostFeedback(record.verificationFeedback??'本次审查未完成；本次放行不代表验收通过。',{
       prefix:`${marker}\nRC 审查结果：${record.reviewStatus}\n原因：${record.reasonCode??'STOP_REVIEW_INCOMPLETE'}`});
     Object.assign(notice,{status:'SENDING',message});await atomicWriteJson(file,notice);
     let response;
     if(native){
       sdk??=loadTranscript();
       response=await (await sdk).appendAssistantMirrorMessageByIdentity({agentId:state.agentId??'main',sessionId:state.sessionId,
         sessionKey:state.sessionKey,config:api.runtime.config?.current?.()??api.config,text:message,idempotencyKey:id,updateMode:'inline'});
       notice.transport='session.message';
       if(response?.ok!==true)throw Object.assign(new Error('Native session append was rejected'),{code:response?.code??'RC_NOTICE_APPEND_REJECTED'});
     }else response=await api.runtime.gateway.request('chat.inject',{sessionKey:state.sessionKey,message,label:'RC'},{timeoutMs:5000});
     if(response?.ok!==true||!response.messageId)throw new Error('Native chat append was not acknowledged');
     Object.assign(notice,{status:'DELIVERED',messageId:response.messageId,deliveredAt:Date.now()});
   }catch(error){
     notice.status='UNKNOWN';notice.error=error.code??'CHAT_NOTICE_ACK_UNCONFIRMED';
     try{const existing=await reconcile();if(existing)Object.assign(notice,{status:'DELIVERED',messageId:existing.id??existing.uuid,reconciled:true,deliveredAt:Date.now()});}catch{/* Receipt retains uncertainty. */}
   }
   await atomicWriteJson(file,notice);return notice;
  }));
 };
}
