// Adapted from scripts/diagnostics/stop-task-integration.mjs. Uses real factory
// and collector only; oracles remain outside each model project. No Gateway.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
const base=path.dirname(fileURLToPath(import.meta.url)),lab=path.dirname(base),repo=path.resolve(lab,"../..");
const load=file=>import(pathToFileURL(path.join(repo,"lib",file)));
const {createOpenClawReviewerFactory}=await load("openclaw/reviewer.mjs");
const {canUseStopTaskReview}=await load("runtime-v2/stop-task-review.mjs");
const {collectReviewItems}=await load("runtime-v2/review-collector.mjs");
const {ensureTask,taskDirectory}=await load("runtime-v2/task-store.mjs");
const {applyGroundTruthDelta,freezeGroundTruth,currentGroundTruthPath,persistSkillGroundTruth}=await load("runtime-v2/ground-truth-ledger.mjs");
const {buildMetricPopulation,METRIC_CATALOG}=await load("runtime-v2/metrics.mjs");
const {scanSkillDirectory}=await load("runtime-v2/skill-source.mjs");
const {STOP_REVIEW_SCHEMA}=await load("runtime-v2/reviewer.mjs");
const {IMPL_REVIEW_SCHEMA}=await load("runtime-v2/impl-review.mjs");
const {prepareHostFeedback,HOST_FEEDBACK_MAX_BYTES}=await load("runtime-v2/feedback-delivery.mjs");
const {captureFiles}=await load("review-task/review-task.mjs");
const {sha256}=await load("runtime-v2/utils.mjs");
const hash=x=>createHash("sha256").update(x).digest("hex"),read=async p=>JSON.parse(await fs.readFile(p,"utf8"));
const args=process.argv.slice(2),live=args.includes("--live"),option=(name,fallback)=>args.find(a=>a.startsWith(`--${name}=`))?.slice(name.length+3)??fallback;
assert(args.every(a=>a==="--live"||a.startsWith("--out=")||a.startsWith("--cases=")));
const runName=option("out",`${live?"live":"preflight"}-${Date.now()}`);assert(/^[a-zA-Z0-9-]+$/u.test(runName));
const output=path.join(base,runName);await fs.mkdir(output);
const save=(p,v)=>fs.writeFile(p,JSON.stringify(v,null,2)+"\n");
const inside=(r,f)=>{const rel=path.relative(r,f);return rel!==".."&&!rel.startsWith(`..${path.sep}`)&&!path.isAbsolute(rel);};
const fingerprint=async root=>hash(JSON.stringify([...await captureFiles(root)].sort(([a],[b])=>a.localeCompare(b))));
const representative=["A201","A301","A401","A601","A701","P08-pass","P09-bool-is-int","P10-swallowed-corruption","P11-edit-then-read","P13-current-connected-proof","P14-gate-contradicted","P15-persisted-outcome-fails"];
const only=option("cases",null)?.split(","),freeze=await read(path.join(lab,"freeze.json"));
const selected=representative.filter(id=>!only||only.includes(id));assert(selected.length&&(!only||only.every(id=>selected.includes(id))));
const cases=selected.flatMap(id=>id==="P09-bool-is-int"?[{id,role:"stop-reviewer"},{id,role:"implementation-reviewer"}]:[{id,role:"stop-reviewer"}]);
const codePaths=["lib/openclaw/reviewer.mjs","lib/openclaw/stop-task-runtime.mjs","lib/runtime-v2/stop-task-review.mjs","lib/runtime-v2/review-collector.mjs","lib/runtime-v2/review-scope.mjs","lib/review-task/review-task.mjs","lib/review-task/history-memory.mjs","lib/review-task/prompt-profile.mjs","lib/review-task/prompts.json"];
const codeIdentity=async()=>Object.fromEntries(await Promise.all(codePaths.map(async p=>[p,hash(await fs.readFile(path.join(repo,p)))])));
const code=await codeIdentity();await save(path.join(output,"code-identity.json"),code);
let auth;
const redact=value=>(auth?.secrets??[]).reduce((s,secret)=>s.replaceAll(secret,"<redacted>"),String(value));
async function configuredModel(){
 const paths=[".openclaw/openclaw.json",".openclaw/agents/main/agent/models.json"].map(p=>path.join(os.homedir(),p));
 const bytes=await Promise.all(paths.map(p=>fs.readFile(p))),[config,cache]=bytes.map(b=>JSON.parse(b));
 const ref=typeof config.agents.defaults.model==="string"?config.agents.defaults.model:config.agents.defaults.model.primary;
 const slash=ref.indexOf("/"),providerId=ref.slice(0,slash),modelId=ref.slice(slash+1),original=config.models.providers[providerId],cached=cache.providers?.[providerId]??{};
 const provider={...cached,...original,apiKey:original.apiKey??cached.apiKey,headers:original.headers??cached.headers,models:original.models??cached.models};
 const resolve=v=>typeof v==="string"?v.replace(/\$\{([^}]+)\}/gu,(_,name)=>process.env[name]??""):v;
 const definition=provider.models.find(m=>m.id===modelId||m.id===ref);assert(provider.api&&provider.baseUrl&&definition&&resolve(provider.apiKey));
 const secrets=[resolve(provider.apiKey),...Object.values(provider.headers??{}).map(resolve)].filter(v=>typeof v==="string"&&v.length>=12);
 const merged=structuredClone(config);merged.models.providers[providerId]=provider;
 return{config:merged,providerId,modelId,secrets,identity:{ref,api:provider.api,contextWindow:definition.contextWindow,maxTokens:definition.maxTokens},unchanged:async()=>(await Promise.all(paths.map(p=>fs.readFile(p)))).every((b,i)=>b.equals(bytes[i]))};
}
async function citationsValid(citations,object){
 for(const cite of citations){const bytes=await fs.readFile(cite.snapshotPath);assert.equal(hash(bytes),cite.contentHash);const lines=bytes.toString("utf8").split("\n");assert(cite.start>=1&&cite.end>=cite.start&&cite.end<=lines.length);assert.equal(lines.slice(cite.start-1,cite.end).join("\n"),cite.exactQuote);if(!cite.frozen)assert.equal(hash(await fs.readFile(cite.path)),cite.contentHash);}
 if(["PASS","DEVIATION"].includes(object?.judgement))assert(citations.some(c=>c.usedBy?.includes(object.objectId)));return true;
}
const report={schemaVersion:"runtime-corrector.all-metric-integration.v1",startedAt:new Date().toISOString(),mode:live?"LIVE_PRODUCTION_FACTORY_COLLECTOR":"OFFLINE_PREFLIGHT",output,rows:[],originalProjectOrSessionAccessed:false,gatewayUsed:false,businessExecution:false,injectedWorker:false,oracleInModelInput:false,processEvidenceIsSynthetic:true,fullStopOrchestrator:false,wholeProjectPass:false,codeIdentity:code};
try{
 if(live)auth=await configuredModel();
 for(const item of cases){
  const entry=freeze.cases.find(c=>c.id===item.id);assert(entry,"Missing frozen fixture");
  const fixture=path.join(lab,"fixtures",item.id),workspace=path.join(fixture,"workspace"),taskPath=path.join(fixture,"task.json"),oraclePath=path.join(fixture,"oracle.json");
  assert.equal(await fingerprint(workspace),entry.fingerprint);assert.equal(hash(await fs.readFile(taskPath)),entry.taskSha256);assert.equal(hash(await fs.readFile(oraclePath)),entry.oracleSha256);
  const fixtureTask=await read(taskPath),oracle=await read(oraclePath),caseId=`${item.id}-${item.role==="implementation-reviewer"?"impl":"stop"}`;
  const directory=path.join(output,caseId),projectRoot=path.join(directory,"project");await fs.mkdir(projectRoot,{recursive:true});
  const targetManifest=[];
  for(const relative of fixtureTask.targetFiles){assert(/^(?:project|process)\//u.test(relative)&&!relative.includes(".."));const src=path.join(workspace,relative),dst=path.join(projectRoot,relative);assert(inside(projectRoot,dst));await fs.mkdir(path.dirname(dst),{recursive:true});const bytes=await fs.readFile(src);await fs.writeFile(dst,bytes);targetManifest.push({path:relative,sha256:hash(bytes),bytes:bytes.length});}
  assert(!targetManifest.some(r=>r.path.startsWith("basis/")||r.path.includes("oracle")),"Authority/oracle cannot become candidate targets");
  const sourceBefore=await fingerprint(projectRoot),sessionId=`integration-${randomUUID()}`,task=await ensureTask({projectRoot,sessionId});
  const sourceCatalog=[],operations=[],basisRecords=[];
  const operation=(claimId,category,text,ref,target)=>({operation:"ADD",claimId,category,text,authority:"MATERIAL_DERIVED",severity:"HARD",applicability:"CURRENT_TASK",verificationTarget:target,source:{ref,subject:"MAIN_TASK",kind:"MATERIAL"}});
  const target=fixtureTask.scope==="SOURCE_IMPLEMENTATION"?"IMPLEMENTATION":["PROCESS_COMPLIANCE","EXECUTION_CLOSURE"].includes(fixtureTask.scope)?"PROCESS":"ARTIFACT";
  const primaryId="assigned-obligation";
  if(entry.metricId!=="M08"){const ref=`fixture:${item.id}:task`;sourceCatalog.push({ref,kind:"MATERIAL"});operations.push(operation(primaryId,METRIC_CATALOG[entry.metricId].source[0],fixtureTask.requirement,ref,target));}
  for(const [index,relative]of fixtureTask.basisFiles.entries()){
   const bytes=await fs.readFile(path.join(workspace,relative)),ref=`fixture:${item.id}:${relative}`,claimId=`complete-basis-${index+1}`;
   sourceCatalog.push({ref,kind:"MATERIAL"});operations.push(operation(claimId,"constraints",`Complete original ${relative}, preserve every original condition and exception.\n[BEGIN ORIGINAL UTF-8]\n${bytes.toString("utf8")}\n[END ORIGINAL UTF-8]`,ref,"ARTIFACT"));basisRecords.push({path:relative,claimId,sha256:hash(bytes),bytes:bytes.length});
  }
  const applied=await applyGroundTruthDelta({projectRoot,taskId:task.taskId,sourceCatalog,evidenceCapture:"full",hookEventId:`fixture-${item.id}`,delta:{operations}});assert.equal(applied.accepted.length,operations.length);
  const {current:groundTruth}=await freezeGroundTruth({projectRoot,taskId:task.taskId,reason:"ISOLATED_METRIC_ADAPTER_TEST"});
  for(const basis of basisRecords)assert(groundTruth.claims.find(c=>c.claimId===basis.claimId).text.includes((await fs.readFile(path.join(workspace,basis.path))).toString("utf8")));
  let skillGroundTruth,skillSource,skillPath,skillSourcePath;
  if(entry.metricId==="M08"){
   const skillId="build-offline-kitchen",skillRoot=path.join(taskDirectory(projectRoot,task.taskId),"skills",skillId),sourceRoot=path.join(skillRoot,"source");await fs.mkdir(sourceRoot,{recursive:true});
   const original=await fs.readFile(path.join(workspace,"project/SKILL.md"));await fs.writeFile(path.join(sourceRoot,"SKILL.md"),original);
   skillSource=await scanSkillDirectory(sourceRoot);const statement=original.toString("utf8").split("\n").find(line=>line.startsWith("S06:"))?.slice(4).trim();assert(statement);
   const saved=await persistSkillGroundTruth({projectRoot,taskId:task.taskId,skillId,skillDigest:skillSource.digest,constraints:[{constraintId:"S06",kind:"STEP",modality:"MUST",statement,condition:"CURRENT_TASK",sourceRef:"project/SKILL.md#L2"}],taskOverlays:[]});
   skillGroundTruth=saved.document;skillPath=path.join(saved.directory,"skill-ground-truth.json");skillSourcePath=path.join(saved.directory,"skill-source.json");
   await save(skillSourcePath,{...skillSource,originalSource:{path:path.join(projectRoot,"project/SKILL.md"),sha256:hash(original)},syntheticFixture:true});
   assert.equal(hash(await fs.readFile(path.join(sourceRoot,"SKILL.md"))),hash(await fs.readFile(path.join(projectRoot,"project/SKILL.md"))));
  }
  const fullPopulation=await buildMetricPopulation({projectRoot,taskId:task.taskId,groundTruth,skillDocuments:skillGroundTruth?[skillGroundTruth]:[]});
  const objects=fullPopulation.metrics[entry.metricId].filter(o=>entry.metricId==="M08"?o.sourceId==="build-offline-kitchen:S06":o.sourceId===primaryId);assert.equal(objects.length,1);
  const object=objects[0],population={...fullPopulation,metrics:{[entry.metricId]:objects},digest:sha256({metricId:entry.metricId,objects})};
  const entries=[];
  for(const record of targetManifest.filter(f=>f.path.startsWith("process/")&&f.path.endsWith(".json"))){const capture=await read(path.join(projectRoot,record.path));entries.push(...(capture.entries??[]));}
  const classification={stopClassification:"TASK_COMPLETE",stage:"VERIFICATION"},implementation=item.role==="implementation-reviewer";
  const sourceManifest=implementation?targetManifest.filter(r=>r.path.startsWith("project/")&&/\.(?:py|[cm]?js|tsx?|ets)$/u.test(r.path)).map(({path,sha256})=>({path,sha256})):[];
  const request={schemaVersion:"runtime-corrector.all-metric-adapter-test.v1",projectRoot,taskId:task.taskId,population,groundTruthPath:currentGroundTruthPath(projectRoot,task.taskId),fixedStopClassification:classification,
   artifactCandidates:fixtureTask.scope==="METRIC_ARTIFACT_REVIEW"?[{artifactId:`fixture:${item.id}:candidate`,metricIds:[entry.metricId],files:targetManifest.map(({path,sha256})=>({path,sha256})),declaration:{configPath:null,configSha256:null,digest:entry.taskSha256}}]:[],
   reviewScope:{objectIds:[object.objectId],sourceIds:[object.sourceId],boundedBasis:true},
   instructions:[fixtureTask.requirement,`Frozen proof scope: ${fixtureTask.scope}. Only this object is assigned.`,"Complete basis is preserved in authoritative GT claims. Candidate copies contain only frozen task.targetFiles; basis files/oracle are never candidate targets.","Logical fixture project/... and process/... paths are retained inside the project copy. The read-only worker adds an outer project/ wrapper; that wrapper is packaging, not a different subject or source revision.","Process records are CONTROLLED SYNTHETIC EVIDENCE FOR ADAPTER TESTS, not actual business executions. Apply the frozen evidence-protocol within this hypothetical fixture. Never execute files, contact original sessions, infer a whole-project PASS, or treat a self-report as tool proof."],
   ...(implementation?{sourceManifest,sourceRoot:projectRoot}:{}),...(skillPath?{skillGroundTruthPath:skillPath,skillSourcePath}:{})};
  const input={projectRoot,sessionCwd:projectRoot,taskId:task.taskId,parentSessionId:sessionId,role:item.role,reviewer:{session:"detached",timeoutMs:120000},schema:structuredClone(implementation?IMPL_REVIEW_SCHEMA:STOP_REVIEW_SCHEMA),request,
   evidence:{groundTruth,population,snapshot:{entries,digest:sha256(entries),lastEntryKey:entries.at(-1)?.uuid??null},...(skillGroundTruth?{skillGroundTruth,skillSource}:{})}};
  const row={caseId,fixtureId:item.id,metricId:entry.metricId,role:item.role,fixtureProofScope:fixtureTask.scope,expected:oracle.expected,projectRoot,taskId:task.taskId,object,fixtureIdentity:entry,basis:basisRecords,targetManifest,syntheticProcessEntries:entries.length,routeEligibleNow:canUseStopTaskReview(input),preflight:!live,skillGroundTruthPath:skillPath??null,skillSourcePath:skillSourcePath??null};
  await save(path.join(directory,"fixture-stage.json"),{...row,request});
  const truthBefore=hash(await fs.readFile(request.groundTruthPath));let handle;
  if(live){
   let fallbackCalls=0,starts=0,ends=0;
   const forbidNative=async()=>{fallbackCalls++;throw Object.assign(new Error("Unexpected native reviewer fallback"),{code:"NATIVE_FALLBACK_FORBIDDEN"});};
   const api={config:auth.config,runtime:{version:"2026.10.3",config:{current:()=>auth.config},agent:{runEmbeddedAgent:forbidNative}}};
   const factory=createOpenClawReviewerFactory(api,{stopReviewEngine:"task",provider:auth.providerId,model:auth.modelId,reviewerTimeoutMs:120000,runEmbeddedAgent:forbidNative,onRunStart:()=>{starts++;},onRunEnd:()=>{ends++;}});
   try{
    assert(row.routeEligibleNow,"Production route is not integrated; do not fall back or inject a fake worker");
    handle=await collectReviewItems({...input,reviewerFactory:factory,...(implementation?{}:{classification}),deadlineAt:Date.now()+125000});
    const judgement=handle.result.metricObjectJudgements.find(j=>j.objectId===object.objectId),citations=await handle.getSourceCitations(handle.result);
    Object.assign(row,{completed:handle.collection.complete&&handle.collection.completedItems===1,verdict:judgement?.judgement??null,diagnosis:judgement?.reason??null,collection:handle.collection,citationIntegrity:await citationsValid(citations,judgement)});
    row.labelMatches=row.completed&&row.verdict===oracle.expected;
    const feedback=await prepareHostFeedback({projectRoot,taskId:task.taskId,text:`One isolated ${entry.metricId} object: ${row.verdict??"UNVERIFIED"}.`,review:{...handle.result,collection:handle.collection},citations,locale:"zh-CN"});
    row.feedbackBytes=Buffer.byteLength(feedback);assert(row.feedbackBytes<=HOST_FEEDBACK_MAX_BYTES);await fs.writeFile(path.join(directory,"feedback.txt"),feedback);
    await save(path.join(directory,"collection-result.json"),{result:handle.result,collection:handle.collection,citations});
   }catch(error){row.completed=false;row.error={code:error.code??"REVIEW_FAILED",message:redact(error.message),...(error.reviewDiagnostic?{diagnostic:error.reviewDiagnostic}:{})};}
   finally{await handle?.close?.();}
   row.callbacks={starts,ends,nativeFallbackCalls:fallbackCalls};assert.equal(fallbackCalls,0);
   const runs=path.join(taskDirectory(projectRoot,task.taskId),"review-task-runs");row.workerResults=[];
   for(const name of await fs.readdir(runs).catch(e=>{if(e.code==="ENOENT")return[];throw e;})){const file=path.join(runs,name,"review/result.json");const result=await read(file).catch(()=>null);row.workerResults.push({path:file,completed:result?.completed??false,verdict:result?.verdict??null,reason:result?.reason??null,metrics:result?.metrics??null,elapsedMs:result?.elapsedMs??null});}
  }
  row.targetBytesUnchanged=(await Promise.all(targetManifest.map(async r=>hash(await fs.readFile(path.join(projectRoot,r.path)))===r.sha256))).every(Boolean);
  row.groundTruthUnchanged=hash(await fs.readFile(request.groundTruthPath))===truthBefore;
  row.fixtureUnchanged=await fingerprint(workspace)===entry.fingerprint&&hash(await fs.readFile(taskPath))===entry.taskSha256&&hash(await fs.readFile(oraclePath))===entry.oracleSha256;
  row.modelProjectContainsNoBasisOrOracle=!(await fs.readdir(projectRoot)).some(name=>name==="basis"||name.startsWith("oracle"));
  assert(row.targetBytesUnchanged&&row.groundTruthUnchanged&&row.fixtureUnchanged&&row.modelProjectContainsNoBasisOrOracle);
  await save(path.join(directory,"report.json"),row);report.rows.push(row);await save(path.join(output,"progress.json"),{rows:report.rows});
  console.log(JSON.stringify({caseId,metricId:entry.metricId,preflight:!live,routeEligibleNow:row.routeEligibleNow,completed:row.completed??null,verdict:row.verdict??null}));
 }
 report.codeUnchanged=JSON.stringify(await codeIdentity())===JSON.stringify(code);report.model=auth?.identity??null;report.providerConfigurationUnchanged=auth?await auth.unchanged():null;
 report.credentialValueFindings=[];if(auth?.secrets.length)for(const [relative]of await captureFiles(output)){const bytes=await fs.readFile(path.join(output,relative));if(auth.secrets.some(s=>bytes.includes(Buffer.from(s))))report.credentialValueFindings.push(relative);}
 report.protectedInputs=report.codeUnchanged&&report.providerConfigurationUnchanged!==false&&!report.credentialValueFindings.length&&report.rows.every(r=>r.targetBytesUnchanged&&r.groundTruthUnchanged&&r.fixtureUnchanged&&r.modelProjectContainsNoBasisOrOracle);
 report.summary={cases:cases.length,metrics:new Set(report.rows.map(r=>r.metricId)).size,routeEligibleNow:report.rows.filter(r=>r.routeEligibleNow).length,completed:report.rows.filter(r=>r.completed).length,labelMatches:report.rows.filter(r=>r.labelMatches).length,sourceImplementationCases:report.rows.filter(r=>r.role==="implementation-reviewer").length};
 report.status=!report.protectedInputs?"PROTECTION_FAILED":!live?report.rows.every(r=>r.routeEligibleNow)?"PREFLIGHT_PASS":"PREFLIGHT_READY_PENDING_PRODUCTION_ROUTE":report.summary.completed===cases.length?"COMPLETE_PENDING_INDEPENDENT_SEMANTIC_AUDIT":"INCOMPLETE";
 report.limitations=["Synthetic process history validates transport and proof ownership, never real application executions.","Each result is one frozen obligation, not all metric objects or a complete Stop/Gateway lifecycle.","Expected labels are not sufficient: independent diagnosis/evidence audit is still required.","No fake worker, native fallback, budget increase or business repair is used."];
}catch(error){report.status="HARNESS_FAILED";report.error={code:error.code??"EXPERIMENT_ERROR",message:redact(error.stack)};}
await save(path.join(output,"report.json"),report);console.log(JSON.stringify({status:report.status,output,summary:report.summary}));
if(!["PREFLIGHT_PASS","PREFLIGHT_READY_PENDING_PRODUCTION_ROUTE","COMPLETE_PENDING_INDEPENDENT_SEMANTIC_AUDIT"].includes(report.status))process.exitCode=1;
