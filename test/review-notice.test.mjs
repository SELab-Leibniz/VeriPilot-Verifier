import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createReviewNoticePublisher} from '../lib/openclaw/review-notice.mjs';
import {readMaContract} from './helpers/ma-transport.mjs';

async function fixture(t,{lostAck=false}={}){
 const parent=path.resolve('.runtime-correction/notice-tests');await fs.mkdir(parent,{recursive:true});
 const root=await fs.mkdtemp(path.join(parent,'run-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const calls=[],messages=[];
 const api={runtime:{gateway:{async request(method,params){
  calls.push({method,params});
  if(method==='chat.inject'){
   const message={id:'notice-1',role:'assistant',content:[{type:'text',text:params.message}]};messages.push(message);
   if(lostAck)throw new Error('Acknowledgement lost after append');
   return {ok:true,messageId:message.id};
  }
  assert.equal(method,'chat.history');return {messages};
 }}}};
 const state={projectRoot:root,sessionId:'session',sessionKey:'agent:main:notice'};
 const record={runId:'business',evaluationId:'evaluation',reviewStatus:'UNVERIFIED',reasonCode:'RC_REQUIRED_TOOLS_DENIED',
  verificationFeedback:'UNVERIFIED: mandatory review tools are explicitly disabled. No business correction was admitted.'};
 return {api,publish:createReviewNoticePublisher(api),input:{state,record,taskId:'task'},calls,messages};
}

test('incomplete Stop actually appends one native chat notice without invoking a model',async t=>{
 const f=await fixture(t);
 const [a,b]=await Promise.all([f.publish(f.input),f.publish(f.input)]);
 assert.equal(a.status,'DELIVERED');assert.equal(b.status,'DELIVERED');assert.equal(f.calls.length,1);
 assert.equal(f.calls[0].method,'chat.inject');assert.match(f.calls[0].params.message,/UNVERIFIED/);
 assert.match(f.calls[0].params.message,/RC_REQUIRED_TOOLS_DENIED/);
 assert.equal(f.messages[0].role,'assistant');
 await f.publish({...f.input,record:{...f.input.record,reviewStatus:'PASS'}});assert.equal(f.calls.length,1);
 await f.publish({...f.input,record:{...f.input.record,followupStatus:'ADMITTED'}});assert.equal(f.calls.length,1);
});

test('lost native acknowledgement is reconciled from history without duplicating the notice',async t=>{
 const f=await fixture(t,{lostAck:true});
 const result=await f.publish(f.input);assert.equal(result.status,'DELIVERED');assert.equal(result.reconciled,true);
 await f.publish(f.input);assert.equal(f.calls.filter(call=>call.method==='chat.inject').length,1);
});

test('a stale review cannot send a notice into a replacement task',async t=>{
 const f=await fixture(t);await f.publish({...f.input,isCurrent:()=>false});assert.deepEqual(f.calls,[]);
});

test('MA notices use the public session identity append without privileged Gateway dispatch',async t=>{
 const f=await fixture(t),appends=[];f.api.runtime.version='2026.7.1-2';
 const publish=createReviewNoticePublisher(f.api,{waitForUi:async()=>{},loadTranscript:async()=>({
  async appendAssistantMirrorMessageByIdentity(params){appends.push(params);return {ok:true,messageId:'native-notice'};},
  async readLatestAssistantTextByIdentity(){throw new Error('No ambiguous append occurred');},
 })});
 const result=await publish(f.input);await publish(f.input);
 assert.equal(result.status,'DELIVERED');assert.equal(result.transport,'session.message');
 assert.equal(appends.length,1);assert.equal(appends[0].sessionId,'session');assert.equal(appends[0].sessionKey,'agent:main:notice');
 assert.equal(appends[0].updateMode,'inline');assert.equal(appends[0].idempotencyKey,result.id);
 assert.match(appends[0].text,/RC_REQUIRED_TOOLS_DENIED/);assert.deepEqual(f.calls,[]);
});

test('a rejected identity append stays unconfirmed and never falls back to privileged dispatch',async t=>{
 const f=await fixture(t);f.api.runtime.version='2026.7.1-2';
 const publish=createReviewNoticePublisher(f.api,{waitForUi:async()=>{},loadTranscript:async()=>({
  async appendAssistantMirrorMessageByIdentity(){return {ok:false,code:'session-rebound'};},
  async readLatestAssistantTextByIdentity(){return undefined;},
 })});
 const result=await publish(f.input);assert.equal(result.status,'UNKNOWN');assert.equal(result.error,'session-rebound');assert.deepEqual(f.calls,[]);
});

test('a replacement during the native UI deduplication window cannot append the old result',async t=>{
 const f=await fixture(t);f.api.runtime.version='2026.7.1-2';let current=true,appended=false;
 const publish=createReviewNoticePublisher(f.api,{waitForUi:async()=>{current=false;},loadTranscript:async()=>({
  async appendAssistantMirrorMessageByIdentity(){appended=true;},
 })});
 const result=await publish({...f.input,isCurrent:()=>current});
 assert.equal(result.status,'STALE');assert.equal(appended,false);assert.deepEqual(f.calls,[]);
});

test('the installed MA main/preload route receives the actual native final notice',{skip:!process.env.RC_MA_ROOT},async t=>{
 const f=await fixture(t);await f.publish(f.input);
 const contract=readMaContract(process.env.RC_MA_ROOT);
 const delivered=contract.route({event:'chat',payload:{runId:'inject-notice-1',sessionKey:f.input.state.sessionKey,seq:0,state:'final',message:f.messages[0]}});
 const message=delivered.find(value=>value.channel==='gateway:chat-message');
 assert(message,'the installed MA router must forward the native final message');
 assert.match(JSON.stringify(message),/UNVERIFIED/);assert.match(JSON.stringify(message),/RC_REQUIRED_TOOLS_DENIED/);
});

test('the installed MA renderer receives a distinct session notice outside its native-final deduplication window',{skip:!process.env.RC_MA_ROOT},()=>{
 const contract=readMaContract(process.env.RC_MA_ROOT),sessionKey='agent:main:notice-experiment';
 const event={event:'session.message',payload:{sessionKey,message:{role:'assistant',content:[{type:'text',text:'UNVERIFIED RC_REQUIRED_TOOLS_DENIED'}]}}};
 const early=contract.snapshotClient({sessionKey,now:()=>144999,lastFinalAt:140000});
 const ready=contract.snapshotClient({sessionKey,now:()=>145250,lastFinalAt:140000});
 for(const item of contract.route(event))if(item.channel==='gateway:session-snapshot'){early.receive(item.payload);ready.receive(item.payload);}
 assert.equal(early.events.length,0,'the actual renderer guard must remain exercised');
 assert.equal(ready.events.length,1);assert.equal(ready.events[0].state,'final');
 assert.match(JSON.stringify(ready.events),/UNVERIFIED RC_REQUIRED_TOOLS_DENIED/);assert.deepEqual(ready.warnings,[]);
});
