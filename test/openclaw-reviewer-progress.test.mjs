// Generic native progress is retained for non-Stop implementation/artifact roles.
// Stop completion and partial receipts are covered by the task protocol tests.
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createOpenClawReviewerFactory } from "../lib/openclaw/reviewer.mjs";
import { registerReviewerProgress } from "../lib/openclaw/reviewer-progress.mjs";
import { runBackgroundExecution } from "../lib/openclaw/internal-context.mjs";
import { STOP_REVIEW_SCHEMA } from "../lib/runtime-v2/reviewer.mjs";
import { ensureTask, taskDirectory } from "../lib/runtime-v2/task-store.mjs";
import { atomicWriteJson, sha256 } from "../lib/runtime-v2/utils.mjs";

const output = value => ({ payloads:[{text:typeof value==="string"?value:JSON.stringify(value)}],meta:{} });
async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"rc-private-progress-"));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const task=await ensureTask({projectRoot:root,sessionId:"host"});
  const file=path.join(root,"app.py"); await fs.writeFile(file,"# original input\nvalue = 1\n# actual source bytes\n");
  const gtPath=path.join(taskDirectory(root,task.taskId),"ground-truth/current.json");
  const groundTruth={version:2,claims:[{claimId:"R1",revisionId:"R1@2",text:"Respect the original requirement."}]};
  await atomicWriteJson(gtPath,groundTruth);
  const population={metrics:{M01:[1,2,3].map(i=>({objectId:`M01:R${i}`,metricId:"M01",sourceId:`R${i}`,sourceRevisionId:`R${i}@2`,description:`Original requirement ${i}`}))}};
  const input={projectRoot:root,taskId:task.taskId,role:"implementation-reviewer",reviewer:{timeoutMs:2000,formatRepairAttempts:1},schema:STOP_REVIEW_SCHEMA,
    request:{groundTruthPath:gtPath,population,sourceManifest:[{path:"app.py",sha256:sha256(await fs.readFile(file))}]},
    evidence:{groundTruth,snapshot:{digest:"frozen-digest",lastEntryKey:"a1",entries:[]},population}};
  return {root,task,file,gtPath,input,population};
}
function native(f,run,options={}) {
  let toolFactory;
  const api={rootDir:path.resolve("."),config:{agents:{defaults:{model:{primary:"controlled/controlled"}}}},
    registerTool:factory=>{toolFactory=factory;},runtime:{agent:{runEmbeddedAgent:run}}};
  registerReviewerProgress(api);
  const factory=createOpenClawReviewerFactory(api,options);
  return {factory,getTool:params=>toolFactory({sessionId:params.sessionId,workspaceDir:f.root}),toolFactory:ctx=>toolFactory(ctx)};
}
const completed = (classification="TASK_COMPLETE") => ({summary:"Original contract result",stopClassification:classification,findings:[],metricObjectJudgements:[]});
const item=(f,id,judgement="DEVIATION",state="COMPLETED")=>({objectId:id,state,judgement,reason:"Observed source differs from requested behavior.",unresolved:judgement==="PASS"?[]:["Host judgement remains."],refs:[{path:f.file,start:2,end:3}]});

test("private checkpoint short ACK/full get is scoped; normal result does not require save",async t=>{
  const f=await fixture(t);let tool;
  const n=native(f,async params=>{
    assert.equal(params.toolsAllow,undefined);
    tool=n.getTool(params);assert(tool);assert.equal(n.toolFactory({sessionId:"other"}),null);
    const ack=await tool.execute("s",{action:"save",item:item(f,"M01:R1")});
    assert.deepEqual(ack.details,{saved:true,objectId:"M01:R1",state:"COMPLETED"});assert.equal(ack.content[0].text.length<100,true);
    const full=(await tool.execute("g",{action:"get"})).details;
    assert.equal(full.items.length,1);assert.equal(full.requirementVersion,2);assert.equal(full.items[0].refs[0].exactQuote,"value = 1\n# actual source bytes");
    await assert.rejects(tool.execute("x",{action:"save",item:item(f,"M01:other")}),/NOT_AUTHORIZED/);
    return output(completed());
  });
  assert.equal(n.toolFactory({workspaceDir:f.root}),null);
  await runBackgroundExecution("background",async()=>assert.equal(n.toolFactory({workspaceDir:f.root}),null));
  const h=await n.factory(f.input);assert.deepEqual(h.result,completed());assert.equal(h.partialReview,undefined);
  await assert.rejects(tool.execute("late",{action:"get"}),/NOT_OWNED/);await h.close();
});

test("invalid final output recovers completed source-bound progress before private cleanup",async t=>{
  const f=await fixture(t);let calls=0,requestDirectory;
  const n=native(f,async params=>{
    calls++;requestDirectory=path.dirname(params.sessionFile);
    const tool=n.getTool(params);await tool.execute("s1",{action:"save",item:item(f,"M01:R1")});
    await tool.execute("s2",{action:"save",item:item(f,"M01:R2","PASS")});
    return output("{ invalid final");
  });let error;try{await n.factory(f.input);}catch(e){error=e;}
  assert.equal(calls,2);assert(error);assert.equal(error.partialReview.status,"PARTIAL");assert.equal(error.partialReview.finalClassification,null);
  assert.equal(error.partialReview.recoveredObjects,2);assert.deepEqual(error.partialReview.unreviewedObjectIds,["M01:R3"]);assert.equal(error.partialReviewIsActive(),true);
  await assert.rejects(fs.access(requestDirectory));
  for(const citation of error.partialReview.citations){const text=await fs.readFile(citation.snapshotPath,"utf8");assert.equal(text.split("\n").slice(citation.start-1,citation.end).join("\n"),citation.exactQuote);}
});

test("own reviewer timeout retains a partial checkpoint but caller cutoff cannot be bypassed",async t=>{
  for(const shared of [false,true]) {
    const f=await fixture(t);
    const n=native(f,async params=>{
      await n.getTool(params).execute("save",{action:"save",item:item(f,"M01:R1")});
      await new Promise((_,reject)=>{params.abortSignal.addEventListener("abort",()=>reject(params.abortSignal.reason),{once:true});});
    },shared?{deadlineAt:Date.now()+500}:{});
    let error;try{await n.factory({...f.input,reviewer:{timeoutMs:shared?2000:1000}});}catch(e){error=e;}
    assert(error);assert.equal(error.code,"REVIEWER_DEADLINE");
    assert.equal(error.partialReview?.recoveredObjects??0,shared?0:1);
  }
});

test("caller cancellation discards partial feedback and never delivers complete PASS",async t=>{
  const f=await fixture(t),controller=new AbortController();
  const n=native(f,async params=>{await n.getTool(params).execute("s",{action:"save",item:item(f,"M01:R1","PASS")});controller.abort(new Error("Cancelled host."));return output(completed());},{abortSignal:controller.signal});
  let error;try{await n.factory(f.input);}catch(e){error=e;}
  assert(error);assert.equal(error.partialReview,undefined);
});

test("bad references, incomplete PASS and changed source/version do not become recovered PASS",async t=>{
  for(const mutate of ["source","groundTruth"]) {
    const f=await fixture(t);let calls=0;
    const n=native(f,async params=>{
      calls++;const tool=n.getTool(params);
      await assert.rejects(tool.execute("bad",{action:"save",item:{...item(f,"M01:R3","PASS"),refs:[]}}),/INVALID/);
      await assert.rejects(tool.execute("unfinished",{action:"save",item:item(f,"M01:R3","PASS","IN_PROGRESS")}),/INVALID/);
      await assert.rejects(tool.execute("outside",{action:"save",item:{...item(f,"M01:R3"),refs:[{path:"/etc/hosts",start:1,end:1}]}}),/NOT_AUTHORIZED/);
      if(calls===1) {
        await tool.execute("s",{action:"save",item:item(f,"M01:R1","PASS")});
        if(mutate==="source")await fs.writeFile(f.file,"Changed after capture.\n");
        else await atomicWriteJson(f.gtPath,{version:3,claims:[]});
      }
      return output("bad JSON");
    });let error;try{await n.factory(f.input);}catch(e){error=e;}
    assert(error);assert.equal(error.partialReview,undefined);
  }
});

test("valid INTERMEDIATE hard finding and cross-role shared deadline retain original behavior",async t=>{
  const f=await fixture(t),deadlineAt=Date.now()+3000;
  const finding={deviationKey:"hard",rootCauseId:"OTHER",severity:"error",reason:"Observed forbidden behavior.",actualEvidence:["app.py:2-3"],expectedConstraint:"Original hard constraint",violatedGroundTruthIds:["R1"]};
  let calls=0;
  const n=native(f,async params=>{calls++;assert(params.timeoutMs<=deadlineAt-Date.now()+20);return output(calls===1?{ok:true}:{...completed("INTERMEDIATE"),findings:[finding]});},{deadlineAt});
  const origin=await n.factory({...f.input,role:"artifact-reviewer",reviewer:{timeoutMs:1000},schema:{type:"object",required:["ok"],properties:{ok:{type:"boolean"}}}});
  const h=await n.factory.handoff({...f.input,originHandle:origin});
  assert.equal(h.result.stopClassification,"INTERMEDIATE");assert.deepEqual(h.result.findings,[finding]);assert(h.sourceCitations.length);await h.close();
});

test("normal merged review can fetch implementation citations after the implementation closes",async t=>{
  const f=await fixture(t);
  const n=native(f,async()=>output(completed()));
  const stop=await n.factory({...f.input,role:"artifact-reviewer",request:{...f.input.request,sourceManifest:[]}});
  const implementation=await n.factory({...f.input,role:"implementation-reviewer"});await implementation.close();
  const citations=await stop.getSourceCitations({findings:[{deviationKey:"impl",actualEvidence:["app.py:2-3"]}],metricObjectJudgements:[]});
  assert.equal(citations.length,1);assert.equal(citations[0].exactQuote,"value = 1\n# actual source bytes");await fs.access(citations[0].snapshotPath);await stop.close();
});

test("private frozen citation remains readable after cleanup while business citations retain original paths",async t=>{
  const f=await fixture(t);let requestPath,basisPath;
  const n=native(f,async params=>{requestPath=path.join(path.dirname(params.sessionFile),"request.json");
    basisPath=JSON.parse(await fs.readFile(requestPath,"utf8")).groundTruthPath;return output(completed());});
  const h=await n.factory({...f.input,role:"artifact-reviewer"});
  const report={findings:[{deviationKey:"private",actualEvidence:[`${basisPath}:1-3`]},{deviationKey:"business",actualEvidence:["app.py:2-3"]}],metricObjectJudgements:[]};
  await h.close();await assert.rejects(fs.access(requestPath));
  await assert.rejects(fs.access(basisPath));
  const citations=await h.getSourceCitations(report),privateCitation=citations.find(c=>c.frozen),businessCitation=citations.find(c=>!c.frozen);
  assert(privateCitation);assert(businessCitation);assert.equal(businessCitation.path,await fs.realpath(f.file));
  const internal=await h.getSourceCitations({findings:[{deviationKey:"request",actualEvidence:[`${requestPath}:1-3`]}],metricObjectJudgements:[]});
  assert.equal(internal.some(c=>c.path===requestPath),false,"A private role request is never original business evidence.");
  const durable=await fs.readFile(privateCitation.snapshotPath,"utf8");
  assert.equal(durable.split("\n").slice(privateCitation.start-1,privateCitation.end).join("\n"),privateCitation.exactQuote);
});

test("OpenClaw manifest declares the private progress tool registered by the native entry",async()=>{
  const manifest=JSON.parse(await fs.readFile(new URL("../packaging/hosts/openclaw/openclaw.plugin.json",import.meta.url),"utf8"));
  assert(manifest.contracts.tools.includes("rc_progress"),"SDK registry requires rc_progress in contracts.tools");
});

test("caller-owned identities are enumerated and program checkpoints preserve valid rows on schema failure",async t=>{
  const f=await fixture(t);let calls=0;
  const valid={objectId:"M01:R1",judgement:"DEVIATION",reason:"Actual source contradicts a requirement.",evidence:["app.py#L2-L3"]};
  const n=native(f,async params=>{
    calls++;assert.match(params.extraSystemPrompt,/"enum"/);assert.match(params.extraSystemPrompt,/M01:R1/);
    return output({...completed(),metricObjectJudgements:[valid,{...valid,objectId:"M05:not-owned"}]});
  });let error;try{await n.factory(f.input);}catch(e){error=e;}
  assert(error);assert.equal(calls,2);assert.equal(error.partialReview.recoveredObjects,1);
  assert.deepEqual(error.partialReview.metricObjectJudgements.map(x=>x.objectId),["M01:R1"]);
  assert.equal(error.partialReview.finalClassification,null);
});

test("implementation progress uses the same source/version/expiry recovery guard",async t=>{
  const f=await fixture(t);let calls=0;
  const n=native(f,async()=>{calls++;return output({summary:"Partial source review",findings:[],metricObjectJudgements:[
    {objectId:"M01:R2",judgement:"PASS",reason:"Observed current source.",evidence:["app.py#L2-L3"]},
    {objectId:"invented",judgement:"PASS",reason:"Invalid identity.",evidence:["app.py#L2-L3"]}]});});
  const {IMPL_REVIEW_SCHEMA}=await import("../lib/runtime-v2/impl-review.mjs");let error;
  try{await n.factory({...f.input,role:"implementation-reviewer",schema:IMPL_REVIEW_SCHEMA});}catch(e){error=e;}
  assert(error);assert.equal(calls,2);assert.equal(error.partialReview.recoveredObjects,1);assert.equal(error.partialReview.finalClassification,null);
});

test("configured native role timeout is not silently capped by an absent plugin override",async t=>{
  const f=await fixture(t);
  for(const [configured, cap] of [[undefined, undefined], [1800000, undefined], [3600000, undefined], [3600000, 600000]]) {
    const expected = Math.min(configured ?? 1200000, cap ?? Infinity);
    const n=native(f,async params=>{
      assert(params.timeoutMs>=expected-1000);assert(params.timeoutMs<=expected);return output(completed());
    },cap===undefined?{}:{reviewerTimeoutMs:cap});
    const h=await n.factory({...f.input,reviewer:{timeoutMs:configured}});await h.close();
  }
});

test('claim references are enumerated separately from metric object identities and cannot be silently rewritten',async t=>{
 const f=await fixture(t);let calls=0;
 const n=native(f,async params=>{
  calls++;assert.match(params.extraSystemPrompt,/"violatedGroundTruthIds":\{"type":"array","items":\{"type":"string","enum":\["R1"\]/);
  return output({...completed(),findings:[{deviationKey:'d',rootCauseId:'r',severity:'error',reason:'Observed problem',actualEvidence:['app.py#L2-L3'],expectedConstraint:'R1',violatedGroundTruthIds:[calls===1?'M01:R1':'R1']}]});
 });const h=await n.factory(f.input);assert.equal(calls,2);assert.deepEqual(h.result.findings[0].violatedGroundTruthIds,['R1']);await h.close();
});

test('extra metric-row annotations do not restart a valid review or alter its judgement and evidence',async t=>{
 const f=await fixture(t);let calls=0;const row={objectId:'M01:R1',judgement:'DEVIATION',reason:'Current source contradicts the contract.',evidence:['app.py#L2-L3']};
 const n=native(f,async()=>{calls++;return output({...completed(),suggestedNextAction:'Extra envelope annotation',metricObjectJudgements:[{...row,expectedConstraint:'Extra explanation',suggestedNextAction:'Host decides',severity:'warning'}]});});
 const h=await n.factory(f.input);assert.equal(calls,1);assert.deepEqual(h.result.metricObjectJudgements,[row]);await h.close();
});
test('row annotation tolerance cannot supply a missing reason or make an invalid judgement pass',async t=>{
 for(const row of [{objectId:'M01:R1',judgement:'PASS',evidence:['app.py#L2-L3'],summary:'Not the required reason'},
  {objectId:'M01:R1',judgement:'looks-good',reason:'Unrecognized value',evidence:['app.py#L2-L3']}]){
  const f=await fixture(t);let calls=0;const n=native(f,async()=>{calls++;return output({...completed(),metricObjectJudgements:[row]});});
  await assert.rejects(n.factory(f.input));assert.equal(calls,2);
 }
});

test('file default allows three repairs in one session without resetting the role deadline',async t=>{
 const f=await fixture(t);delete f.input.reviewer.formatRepairAttempts;let calls=0;const sessions=[],timeouts=[];
 const n=native(f,async p=>{calls++;sessions.push(p.sessionId);timeouts.push(p.timeoutMs);await new Promise(r=>setTimeout(r,20));return output(calls===4?completed():'{ malformed');});
 const h=await n.factory(f.input);assert.equal(calls,4);assert.equal(new Set(sessions).size,1);assert(timeouts[3]<timeouts[0]);await h.close();
});
test('per-role format-repair setting overrides the RC default file, including disabling repair',async t=>{
 for(const repairs of [0,2]){const f=await fixture(t);let calls=0;const n=native(f,async()=>{calls++;return output('{ malformed');});
  await assert.rejects(n.factory({...f.input,reviewer:{timeoutMs:2000,formatRepairAttempts:repairs}}));assert.equal(calls,1+repairs);
 }
});
