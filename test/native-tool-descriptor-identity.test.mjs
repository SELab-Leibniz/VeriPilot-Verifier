import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { withNativeToolDescriptorIdentity } from '../lib/openclaw/native-config.mjs';
import { createNativeTaskSession } from '../lib/openclaw/task-session.mjs';
import { createOpenClawReviewerFactory } from '../lib/openclaw/reviewer.mjs';
import { releaseDocumentSessions } from '../lib/document-session.mjs';
import { validateJsonSchema } from '../lib/json-schema-validator.mjs';
import { REVIEW_SCHEMA } from '../lib/semantic-review.mjs';
const sourceRoot=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const owner={agentId:'main',sessionId:'private-session',sessionKey:'agent:main:runtime-corrector:private-session',runId:'native-dispatch'};
const value=config=>config.plugins.entries['runtime-corrector'].config.nativeToolDescriptorIdentity;
const freeze=item=>{if(item&&typeof item==='object'){Object.values(item).forEach(freeze);Object.freeze(item);}return item;};

test('descriptor overlay changes only its internal identity and preserves frozen operator policies',()=>{
 const input=freeze({plugins:{enabled:false,allow:['other'],entries:{'runtime-corrector':{enabled:false,config:{enabled:false,reviewerModel:'catalog/reviewer',hookTimeoutMs:3000}},other:{enabled:true}}},tools:{allow:['read'],deny:['exec'],byProvider:{catalog:{deny:['write']}}},agents:{list:[{id:'main',tools:{deny:['source_read']}}]},session:{writeLock:{maxHoldMs:123456}},models:{mode:'merge'}});
 const before=structuredClone(input),out=withNativeToolDescriptorIdentity(input,owner);
 assert.match(value(out),/^rc-native-tools-v1:[a-f0-9]{64}$/);assert.notEqual(out,input);
 const stripped=structuredClone(out);delete stripped.plugins.entries['runtime-corrector'].config.nativeToolDescriptorIdentity;
 assert.deepEqual(stripped,before);assert.deepEqual(input,before);assert.equal(out.plugins.entries.other,input.plugins.entries.other);
 assert.equal(value(withNativeToolDescriptorIdentity(input,owner)),value(out));
});

test('actual session and native run identities separate every private dispatch without accepting missing identities',()=>{
 const first=value(withNativeToolDescriptorIdentity({},owner));
 for(const key of Object.keys(owner))assert.notEqual(value(withNativeToolDescriptorIdentity({},{...owner,[key]:owner[key]+'-next'})),first,key);
 for(const key of Object.keys(owner))for(const invalid of [undefined,'','   ',7,'x'.repeat(2049)])assert.throws(()=>withNativeToolDescriptorIdentity({},{...owner,[key]:invalid}),/NATIVE_TOOL_DESCRIPTOR_IDENTITY_REQUIRED/);
});

test('normal plugin config remains optional and default-free while the internal overlay satisfies its declared schema',async()=>{
 const manifest=JSON.parse(await fs.readFile(path.join(sourceRoot,'packaging/hosts/openclaw/openclaw.plugin.json')));
 const schema=manifest.configSchema,field=schema.properties.nativeToolDescriptorIdentity;
 assert.equal(Object.hasOwn(field,'default'),false);assert(!schema.required?.includes('nativeToolDescriptorIdentity'));
 assert.deepEqual(validateJsonSchema({},schema),[]);
 const config=withNativeToolDescriptorIdentity({},owner).plugins.entries['runtime-corrector'].config;
 assert.deepEqual(validateJsonSchema(config,schema),[]);assert(validateJsonSchema({nativeToolDescriptorIdentity:'foreign'},schema).length>0);
});

test('task-native retries keep their actual session/deadline/policy while rotating descriptor identity with runId',async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'rc-descriptor-task-'))),calls=[];let session;
 t.after(async()=>{await session?.close();await fs.rm(root,{recursive:true,force:true});});
 const inputConfig={tools:{deny:['write']},agents:{defaults:{model:'fixture/model'}},plugins:{entries:{'runtime-corrector':{config:{enabled:true}}}}};const before=structuredClone(inputConfig);
 session=await createNativeTaskSession({projectRoot:root,taskId:'native-descriptor-task',role:'stop-reviewer',reviewer:{timeoutMs:5000}},{api:{runtime:{version:'2026.7.1-2',agent:{}}},selection:{config:inputConfig,provider:'fixture',model:'model'},nativeRunner:async params=>{calls.push(params);return{payloads:[],meta:{}};}});
 const worker={tools:[],cwd:root,outputDir:root,prompt:'Current source review.',systemPrompt:'',active(){},isComplete:()=>true,phase:()=> 'CANDIDATE_COMPLETE',onAssistantMessageStart(){}};
 await session.run(worker);await session.run(worker);assert.equal((await session.awaitOwnedSettlement()).runIds.length,2);
 assert.equal(calls.length,2);assert.equal(calls[0].sessionId,calls[1].sessionId);assert.notEqual(calls[0].runId,calls[1].runId);assert.notEqual(value(calls[0].config),value(calls[1].config));
 for(const p of calls){assert.equal(value(p.config),value(withNativeToolDescriptorIdentity({},p)));assert.equal(p.timeoutMs<=5000,true);assert.deepEqual(p.config.tools.deny.includes('write'),true);assert.deepEqual(p.toolsAllow,[]);}
 assert.deepEqual(inputConfig,before);
});

test('pooled native document invocations use their actual new run identity without replacing the shared operator config',async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'rc-descriptor-document-'))),calls=[];let callbackFailure;
 t.after(async()=>{await releaseDocumentSessions(root);await fs.rm(root,{recursive:true,force:true});});
 await fs.writeFile(path.join(root,'a.md'),'Current public specification.\n');
 const semantic={projectRoot:root,artifactFiles:['a.md']},requestPath=path.join(root,'request.json');await fs.writeFile(requestPath,JSON.stringify(semantic));
 const config={agents:{defaults:{model:'fixture/model'}},tools:{deny:['exec']},plugins:{entries:{'runtime-corrector':{config:{enabled:true}}}}},before=structuredClone(config);
 const run=async p=>{try{calls.push(p);assert.equal(value(p.config),value(withNativeToolDescriptorIdentity({},p)));return{payloads:[{text:JSON.stringify({summary:'aligned',findings:[],edits:[]})}],meta:{}};}catch(e){callbackFailure=e;throw e;}};
 const api={config,runtime:{version:'2026.7.1-2',agent:{runEmbeddedAgent:run}}};
 const factory=createOpenClawReviewerFactory(api),input={projectRoot:root,taskId:'native-descriptor-document',role:'artifact-reviewer',pluginRoot:sourceRoot,schema:REVIEW_SCHEMA,reviewer:{timeoutMs:5000},request:{semanticReviewRequestPath:requestPath},evidence:{semanticRequest:semantic,snapshot:{entries:[],digest:'first'}}};
 try{const first=await factory(input);try{assert.equal(first.result.summary,'aligned');}finally{await first.close();}
  input.evidence.snapshot.digest='second';const second=await factory(input);try{assert.equal(second.result.summary,'aligned');}finally{await second.close();}
 }finally{if(callbackFailure)throw callbackFailure;}
 assert.equal(calls.length,2);assert.equal(calls[0].sessionId,calls[1].sessionId);assert.notEqual(calls[0].runId,calls[1].runId);assert.notEqual(value(calls[0].config),value(calls[1].config));assert.deepEqual(config,before);
 for(const p of calls){assert.equal(p.timeoutMs<=5000,true);assert(p.config.tools.deny.includes('exec'));}
});
