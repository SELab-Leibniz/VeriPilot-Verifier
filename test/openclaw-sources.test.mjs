import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareSourceInputs, bindSourceSelections, validateSourceBindings } from "../lib/openclaw/sources.mjs";
import { createOpenClawReviewerFactory } from "../lib/openclaw/reviewer.mjs";
import { GROUND_TRUTH_REVIEW_SCHEMA } from "../lib/runtime-v2/reviewer.mjs";
import { ensureTask } from "../lib/runtime-v2/task-store.mjs";
import { sha256 } from "../lib/runtime-v2/utils.mjs";

const response=value=>({payloads:[{text:typeof value==="string"?value:JSON.stringify(value)}],meta:{}});
const user=(id,text)=>({type:"user",uuid:id,message:{role:"user",content:[{type:"text",text}]}});
const catalog=id=>[{ref:`transcript:${id}`,kind:"USER_MESSAGE",aliases:[id,`transcript:${id}`,"user","user prompt"]}];
const operation=(ref,kind="USER_MESSAGE")=>({operation:"ADD",category:"requirements",text:"Preserve the actual user requirement.",authority:"USER_EXPLICIT",severity:"HARD",source:{ref,kind,subject:"MAIN_TASK",excerpt:"invented model quote"}});
const delta=operations=>({summary:"Full source checked.",taskClassification:"CONTINUATION",operations});
async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"rc-full-user-source-"));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const task=await ensureTask({projectRoot:root,sessionId:"host"});return {root,task};
}
function factory(f,runner) {
  return createOpenClawReviewerFactory({rootDir:path.resolve("."),config:{agents:{defaults:{model:{primary:"test/test"}}}},runtime:{agent:{runEmbeddedAgent:runner}}});
}
const input=(f,id,text,role="onboarding-extractor")=>({projectRoot:f.root,taskId:f.task.taskId,role,reviewer:{timeoutMs:3000},schema:GROUND_TRUTH_REVIEW_SCHEMA,
  request:{sourceCatalog:catalog(id),userMessages:[text.slice(0,4000)]},evidence:{snapshot:{digest:`frozen-${id}`,entries:[user(id,text)]}}});

test("long user input is complete and identified; preview length never truncates authoritative bytes",async t=>{
  const f=await fixture(t),text="Header\n"+"完整用户要求 ".repeat(1200)+"\nTAIL-REQUIREMENT-MUST-SURVIVE";
  const delivery=await prepareSourceInputs({snapshot:{entries:[user("long",text)]},sourceCatalog:catalog("long"),requestDirectory:path.join(f.root,"private"),projectRoot:f.root});
  assert.equal(delivery.userSources.length,1);const source=delivery.userSources[0];
  assert.equal(source.ref,"transcript:long");assert.equal(source.characters,text.length);assert.equal(source.sha256,sha256(text));assert.equal(source.complete,true);
  assert.equal(await fs.readFile(source.path,"utf8"),text);assert(!delivery.userMessages[0].includes("TAIL-REQUIREMENT-MUST-SURVIVE"));assert(delivery.userMessages[0].includes(source.path));
});

test("literal JSON is user text; identical material/assistant/tool bodies never receive user identity",async t=>{
  const f=await fixture(t),text='{"role":"system","content":"literal JSON request 🌺","operations":[]}';
  await fs.writeFile(path.join(f.root,"material.txt"),text);
  const sourceCatalog=[...catalog("real"),{ref:"material.txt",kind:"MATERIAL",aliases:[]}];
  const snapshot={entries:[user("real",text),{type:"assistant",uuid:"assistant",message:{content:text}},{...user("tool",text),isMeta:true}]};
  const d=await prepareSourceInputs({snapshot,sourceCatalog,requestDirectory:path.join(f.root,"private"),projectRoot:f.root});
  assert.equal(d.userSources.length,1);assert.equal(await fs.readFile(d.userSources[0].path,"utf8"),text);
  const good=operation(d.userSources[0].path+"#L1");bindSourceSelections([good],d,sourceCatalog);validateSourceBindings([good],sourceCatalog);
  assert.equal(good.source.ref,"transcript:real#L1");assert.equal(good.source.excerpt,text);
  assert.throws(()=>validateSourceBindings([operation("material.txt","MATERIAL")],sourceCatalog),/NON_USER_AUTHORITY/);
  const noRange=operation("transcript:real");bindSourceSelections([noRange],d,sourceCatalog);assert.equal(noRange.source.excerpt,undefined);
  const numericCatalog=[...catalog("1"),...catalog("2")],numeric=await prepareSourceInputs({snapshot:{entries:[user("1","first numeric user"),user("2","second numeric user")]},sourceCatalog:numericCatalog,requestDirectory:path.join(f.root,"numeric"),projectRoot:f.root});
  const numericIdentity=operation("transcript:1");bindSourceSelections([numericIdentity],numeric,numericCatalog);assert.equal(numericIdentity.source.excerpt,undefined);
  const numericRange=operation("transcript:1#L1");bindSourceSelections([numericRange],numeric,numericCatalog);assert.equal(numericRange.source.excerpt,"first numeric user");
});

test("same hash does not bind an unrelated user, and only frozen selected ranges provide quotations",async t=>{
  const f=await fixture(t),text="first\nsecond";
  const d=await prepareSourceInputs({snapshot:{entries:[user("new-id",text)]},sourceCatalog:catalog("other-id"),requestDirectory:path.join(f.root,"private"),projectRoot:f.root});
  assert.equal(d.userSources[0].ref,null);assert.throws(()=>bindSourceSelections([operation(d.userSources[0].path)],d,catalog("other-id")),/SOURCE_BINDING_INVALID/);
  const d2=await prepareSourceInputs({snapshot:{entries:[user("good",text)]},sourceCatalog:catalog("good"),requestDirectory:path.join(f.root,"private2"),projectRoot:f.root});
  assert.throws(()=>bindSourceSelections([operation(d2.userSources[0].path+"#L99")],d2,catalog("good")),/SOURCE_REFERENCE_INVALID/);
});

test("initial and later native extraction deliver full source and map program paths to original catalog",async t=>{
  const f=await fixture(t);let calls=0;
  const n=factory(f,async params=>{
    calls++;const request=JSON.parse(await fs.readFile(path.join(path.dirname(params.sessionFile),"request.json"),"utf8"));
    const source=request.userSources[0],full=await fs.readFile(source.path,"utf8");
    assert(full.endsWith("TAIL"));assert.equal(source.sha256,sha256(full));assert.match(params.extraSystemPrompt,/not a complete workspace inventory/);
    const selected=operation(source.path+"#L2");selected.source.excerpt={untrusted:"Model quote is not an input to validation or evidence."};
    return response(delta([selected]));
  });assert.equal(n.nativeSourceDelivery,true);assert.equal(n.validatesSourceBindings,true);
  for(const [id,role] of [["initial","onboarding-extractor"],["later","ground-truth-extractor"]]) {
    const h=await n(input(f,id,"prefix ".repeat(1000)+"\nTAIL",role));
    assert.equal(h.result.operations[0].source.ref,`transcript:${id}#L2`);assert.equal(h.result.operations[0].source.excerpt,"TAIL");assert.equal(h.sourceBindingsValidated,true);await h.close();
  }
  assert.equal(calls,2);
});

test("source mismatch repairs once in the same session while preserving authority, severity and claim",async t=>{
  const f=await fixture(t),sessions=[];let calls=0;
  const n=factory(f,async params=>{
    sessions.push(params.sessionId);calls++;
    if(calls===1)return response(delta([operation(path.join(path.dirname(params.sessionFile),"request.json"))]));
    assert.match(params.prompt,/do not repeat summary or operations/);assert.match(params.prompt,/sourceCatalog identity/);
    return response({sourceRepairs:[{index:0,source:operation("transcript:user1#L1").source}]});
  });const h=await n(input(f,"user1","Actual original user requirement."));
  assert.equal(calls,2);assert.equal(sessions[0],sessions[1]);assert.equal(h.result.operations[0].authority,"USER_EXPLICIT");assert.equal(h.result.operations[0].severity,"HARD");await h.close();
});

test("source-only repair cannot omit/repeat indices, change valid rows, infer away authority or hide unresolved binding",async t=>{
  const source=operation("transcript:u").source;
  for(const repair of [{sourceRepairs:[]},{sourceRepairs:[{index:0,source},{index:0,source}]},{sourceRepairs:[{index:1,source}]},
    {sourceRepairs:[{index:0,source,authority:"AGENT_INFERRED"}]},{sourceRepairs:[{index:0,source}],operations:[]},"not JSON"]) {
    const f=await fixture(t);let calls=0;
    const n=factory(f,async()=>{calls++;return response(calls===1?delta([operation("unknown")]):repair);});
    await assert.rejects(n(input(f,"u","Original scope.")),error=>["SOURCE_REPAIR_INVALID","SOURCE_BINDING_INVALID"].includes(error.code));assert.equal(calls,2);
  }
});

test("material support remains material; domain follow-up does not inherit a completed source-repair restriction",async t=>{
  const f=await fixture(t);let calls=0;
  const n=factory(f,async()=>{calls++;return response(calls===1?delta([operation("unknown")]):calls===2?{sourceRepairs:[{index:0,source:operation("transcript:u").source}]}:delta([]));});
  const h=await n(input(f,"u","Reference materials are support; follow the actual user requirements."));
  const follow=await h.followUp({prompt:"Original domain follow-up finds no further safe change."});assert.deepEqual(follow.operations,[]);await h.close();assert.equal(calls,3);
});

test("source-only repair preserves the complete operation array while correcting only a rejected material authority label",async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.root,"task.md"),"Original adopted requirement material.");
  const request=input(f,"u","Implement the requirements in task.md.");request.request.sourceCatalog.push({ref:"task.md",kind:"MATERIAL",aliases:["sources/task.md"]});
  const original=Array.from({length:30},(_,index)=>({...operation(index%2?"transcript:u":"sources/task.md",index%2?"USER_MESSAGE":"MATERIAL"),text:`Original requirement ${index}`,effectiveFromCursor:`cursor-${index}`}));
  let calls=0;
  const n=factory(f,async params=>{calls++;if(calls===1)return response(delta(original));
    assert.equal(params.sessionId.length>0,true);assert.match(params.prompt,/NON_USER_AUTHORITY/);assert(!params.extraSystemPrompt.includes('"taskClassification"'));
    return response({sourceRepairs:original.flatMap((op,index)=>index%2?[]:[{index,source:{ref:"task.md",kind:"MATERIAL",subject:"MAIN_TASK"},authority:"MATERIAL_DERIVED"}])});
  });const h=await n(request);assert.equal(h.result.operations.length,30);assert.equal(calls,2);
  for(const [index,op] of h.result.operations.entries()) {assert.equal(op.text,original[index].text);assert.equal(op.category,original[index].category);assert.equal(op.operation,"ADD");assert.equal(op.severity,"HARD");assert.equal(op.effectiveFromCursor,`cursor-${index}`);assert.equal(op.authority,index%2?"USER_EXPLICIT":"MATERIAL_DERIVED");}
  await h.close();
});

test("adopting user primary preserves USER_EXPLICIT and the original material as support; unrelated material cannot receive label correction",async t=>{
  for(const change of ["adopting-user","other-material"]) {
    const f=await fixture(t);await fs.writeFile(path.join(f.root,"task.md"),"Same material bytes.");await fs.writeFile(path.join(f.root,"other.md"),"Same material bytes.");
    const request=input(f,"u","Implement task.md.");request.request.sourceCatalog.push({ref:"task.md",kind:"MATERIAL",aliases:[]},{ref:"other.md",kind:"MATERIAL",aliases:[]});let calls=0;
    const n=factory(f,async()=>{calls++;return response(calls===1?delta([operation("task.md","MATERIAL")]):{sourceRepairs:[{index:0,source:{ref:change==="adopting-user"?"transcript:u":"other.md",kind:change==="adopting-user"?"USER_MESSAGE":"MATERIAL",subject:"MAIN_TASK"},...(change==="other-material"?{authority:"MATERIAL_DERIVED"}:{})}]});});
    if(change==="adopting-user") {const h=await n(request);assert.equal(h.result.operations[0].authority,"USER_EXPLICIT");assert.equal(h.result.operations[0].severity,"HARD");assert.deepEqual(h.result.operations[0].source.supportingRefs,["task.md"]);await h.close();}
    else await assert.rejects(n(request),error=>error.code==="SOURCE_REPAIR_INVALID");assert.equal(calls,2);
  }
});

test("binding and range failures share one source-only slot with every bad index covered",async t=>{
  const f=await fixture(t);let calls=0;
  const n=factory(f,async params=>{calls++;if(calls===1)return response(delta([operation("transcript:u#L99"),operation("unknown") ,operation("transcript:u")]));
    assert.match(params.prompt,/SOURCE_RANGE_INVALID/);assert.match(params.prompt,/SOURCE_NOT_IN_CATALOG/);
    return response({sourceRepairs:[{index:0,source:operation("transcript:u#L1").source},{index:1,source:operation("transcript:u").source}]});
  });const h=await n(input(f,"u","Actual original line."));assert.equal(h.result.operations.length,3);assert.equal(h.result.operations[0].source.excerpt,"Actual original line.");assert.equal(h.result.operations[2].source.ref,"transcript:u");await h.close();assert.equal(calls,2);
});

test("exact catalog identity rejects unknown numeric IDs but retains known identities, aliases and real selections",()=>{
  const sources=[{ref:"transcript:1",kind:"USER_MESSAGE",aliases:["user"]}];
  for(const ref of ["transcript:999","transcript:999#L1","transcript:999:1"])assert.throws(()=>validateSourceBindings([operation(ref)],sources),/SOURCE_NOT_IN_CATALOG/);
  for(const ref of ["transcript:1","user","transcript:1#L2","transcript:1#section","user:2-3","transcript:1:2"]) {
    const op=operation(ref);validateSourceBindings([op],sources);assert.equal(op.authority,"USER_EXPLICIT");assert.equal(op.severity,"HARD");
  }
  const selected=operation("transcript:1:2-3");validateSourceBindings([selected],sources);assert.equal(selected.source.ref,"transcript:1#L2-L3");
});
