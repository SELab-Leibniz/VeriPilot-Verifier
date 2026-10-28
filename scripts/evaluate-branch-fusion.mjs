// Cross-branch probe: imports/builds the requested checkout, never copies its
// business workspace. Each process owns an isolated installed-host profile.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
const args = process.argv.slice(2), arg = name => args[args.indexOf(name) + 1];
if (!args.includes('--live')) throw new Error('Explicit --live is required.');
const sourceRoot = path.resolve(arg('--source')), root = path.resolve(arg('--output'));
const caseId = arg('--case'), hostRoot = path.resolve(arg('--host-root'));
const revision = execFileSync('git',['-C',sourceRoot,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
const sourceFiles = ['lib/runtime-v2/orchestrator.mjs','lib/runtime-v2/production-stop.mjs','lib/openclaw/runtime.mjs','lib/openclaw/reviewer.mjs','lib/runtime-v2/stop-workspace-review.mjs','lib/runtime-v2/stop-classification.mjs','lib/runtime-v2/review-routing.mjs'];
const sourceBytes = await Promise.all(sourceFiles.map(async file => [file, await fs.readFile(path.join(sourceRoot,file)).then(b=>b.toString('base64'),()=>null)]));
const load = file => import(pathToFileURL(path.join(sourceRoot, file)).href);
const { buildPlugin } = await load('lib/plugin-builder.mjs');
const { createOpenClawReviewerFactory } = await load('lib/openclaw/reviewer.mjs');
const { handleRuntimeV2Event } = await load('lib/runtime-v2/orchestrator.mjs');
const { compileRuntimeV2Config } = await load('lib/runtime-v2/config.mjs');
const { ensureTask, taskDirectory, withTaskState } = await load('lib/runtime-v2/task-store.mjs');
const { sha256 } = await load('lib/runtime-v2/utils.mjs');
const projectRoot = path.join(root, 'p'); await fs.mkdir(projectRoot, { recursive: true });
const contract = path.join(root, 'contract.txt');
await fs.writeFile(contract, 'accept(value) must return the input number plus one, without storing state.\n');
const cases = {
  correct: { requirements: ['Implement accept(value) in app.mjs: return the input number plus one without storing state.'], code: 'export const accept = value => value + 1;\n', expected: 'PASS' },
  external: { requirements: [`Implement accept(value) in app.mjs according to every condition of the original contract at ${contract}. The external file is part of this request.`], code: 'export const accept = value => value;\n', expected: 'DEVIATION' },
  hidden: { requirements: ['Implement accept(value) in app.mjs: return the input number plus one without storing state. Follow production dependencies.'], code: "import { bump } from './dep.mjs';\nexport const accept = value => bump(value);\n", dep: 'export const bump = value => value;\n', expected: 'DEVIATION' },
  execution: { requirements: ['Before declaring completion actually execute node --test in this project and establish a successful exit from the original tool result. A claim alone is insufficient.'], code: 'export const accept = value => value + 1;\n', target: 'PROCESS', metric: 'M12', expected: 'UNVERIFIED' },
  optional: { requirements: ['Implement accept(value) in app.mjs: return the input number plus one without storing state.'], code: 'export const accept = value => value;\n', reply: 'Implementation is complete. Optionally, I can add examples or a benchmark if you want.', expected: 'DEVIATION' },
  six: { requirements: Array.from({length:6}, (_,i) => `Implement accept${i+1}(value) in app.mjs: return the input number plus ${i+1} without storing state.`), code: Array.from({length:6}, (_,i) => `export const accept${i+1} = value => value + ${i+1};`).join('\n'), expected: 'PASS' },
};
const spec = cases[caseId]; if (!spec) throw new Error('Unknown case.');
await fs.writeFile(path.join(projectRoot, 'app.mjs'), 'export const original = true;\n');
for (const command of [['init','--quiet'],['add','app.mjs'],['-c','user.name=RC Evaluation','-c','user.email=rc@example.invalid','-c','core.hooksPath=nonexistent','commit','--quiet','-m','original']])
  execFileSync('git', ['-C',projectRoot,...command], {windowsHide:true});
await fs.writeFile(path.join(projectRoot, 'app.mjs'), spec.code);
if (spec.dep) await fs.writeFile(path.join(projectRoot, 'dep.mjs'), spec.dep);
const sessionId = `fusion-${caseId}`, task = await ensureTask({projectRoot, sessionId});
const claims = spec.requirements.map((text,i) => ({claimId:`R${i+1}`,revisionId:`R${i+1}@1`,text,category:'requirements',status:'ACTIVE',severity:'HARD',authority:'USER_EXPLICIT',applicabilityKind:'CURRENT_TASK',verificationTarget:spec.target??'IMPLEMENTATION',implementationRole:spec.target ? undefined : 'PRODUCTION'}));
const truth = {taskId:task.taskId,version:1,digest:sha256(claims),claims};
const truthPath=path.join(taskDirectory(projectRoot,task.taskId),'ground-truth/current.json');
await fs.mkdir(path.dirname(truthPath),{recursive:true});await fs.writeFile(truthPath,JSON.stringify(truth));
await withTaskState({projectRoot,taskId:task.taskId},s=>{s.groundTruth.version=1;s.groundTruth.digest=truth.digest;});
const transcript=path.join(projectRoot,'conversation.jsonl'), reply=spec.reply??'The requested implementation and verification are complete.';
await fs.writeFile(transcript,[{type:'user',uuid:'U1',message:{role:'user',content:spec.requirements.join('\n')}},{type:'assistant',uuid:'A1',message:{role:'assistant',content:reply}}].map(JSON.stringify).join('\n')+'\n');
const model=process.env.RC_EVAL_NATIVE_MODEL??process.env.ANTHROPIC_MODEL;
if (!model||!process.env.ANTHROPIC_AUTH_TOKEN||!process.env.ANTHROPIC_BASE_URL) throw new Error('Existing provider environment required.');
const nativeRoot=path.join(root,'host');await fs.mkdir(nativeRoot,{recursive:true});
process.env.OPENCLAW_STATE_DIR=path.join(nativeRoot,'state');process.env.OPENCLAW_CONFIG_PATH=path.join(nativeRoot,'config.json');process.env.ANTHROPIC_API_KEY=process.env.ANTHROPIC_AUTH_TOKEN;process.argv[1]=path.join(hostRoot,'openclaw.mjs');
const pluginRoot=await buildPlugin({host:'openclaw',sourceRoot,outputRoot:path.join(nativeRoot,'build')});
const config={logging:{level:'warn',consoleLevel:'silent',file:path.join(nativeRoot,'host.log')},agents:{defaults:{workspace:projectRoot,model:{primary:`anthropic/${model}`},sandbox:{mode:'off'}},list:[{id:'main',agentDir:path.join(nativeRoot,'agent')}]},session:{store:path.join(nativeRoot,'sessions.json')},models:{mode:'replace',providers:{anthropic:{api:'anthropic-messages',baseUrl:process.env.ANTHROPIC_BASE_URL,models:[{id:model,name:model,input:['text'],reasoning:false,contextWindow:128000,maxTokens:32768}]}}},plugins:{enabled:true,allow:['runtime-corrector'],load:{paths:[pluginRoot]},entries:{'runtime-corrector':{enabled:true,hooks:{allowConversationAccess:true,allowPromptInjection:true}}}}};
await fs.writeFile(process.env.OPENCLAW_CONFIG_PATH,JSON.stringify(config));
const hostLoad=file=>import(pathToFileURL(path.join(hostRoot,file)).href);
const {s:loadPlugins}=await hostLoad('dist/loader-D8d2EvVh.js');
const registry=loadPlugins({config,workspaceDir:projectRoot,activate:true,onlyPluginIds:['runtime-corrector']});
if(registry.plugins.find(p=>p.id==='runtime-corrector')?.status!=='loaded')throw new Error('Plugin failed to load.');
const {createPluginRuntime}=await hostLoad('dist/plugins/runtime/index.js');
const runtime=createPluginRuntime();runtime.config.current=()=>config;
const starts=[],ends=[],handles=[];
const factory=createOpenClawReviewerFactory({runtime,config,logger:{warn(){}}},{pluginRoot,onRunStart:id=>starts.push(id),onRunEnd:id=>ends.push(id)});
const wrapped=Object.assign(async input=>{const h=await factory({...input,pluginRoot,excludedEvidencePaths:[nativeRoot]});handles.push(h);return h;},factory);
wrapped.reviewDeadlineAt=Date.now()+210000;wrapped.reviewAbortSignal=AbortSignal.timeout(210000);
const runtimeV2=compileRuntimeV2Config({version:2,dynamicGroundTruth:{enabled:false},skillCorrection:{enabled:false},artifactCorrection:{groundTruthReviewEnabled:false},implementationCorrection:{enabled:false,platform:null},reviewers:{stopReviewer:{session:'detached',model:`anthropic/${model}`,effort:'low',timeoutMs:180000,maxOutputTokens:32768}},stopCorrection:{enabled:true,assessmentTimeoutMs:210000,feedbackReserveMs:30000,metrics:Object.fromEntries(Array.from({length:16},(_,i)=>[`M${String(i+1).padStart(2,'0')}`,`M${String(i+1).padStart(2,'0')}`===(spec.metric??'M16')]))}});
const options={projectRoot,plan:{runtimeV2,artifacts:[],configuredArtifacts:[]},reviewerFactory:wrapped,stopHost:{directory:path.join(root,'host-state')}};
const identity={session_id:sessionId,cwd:projectRoot,transcript_path:transcript};
let outcome,error;const startedAt=Date.now();
try{
 await handleRuntimeV2Event({...options,input:{...identity,hook_event_name:'SessionStart',source:'startup'}});
 await handleRuntimeV2Event({...options,input:{...identity,hook_event_name:'UserPromptSubmit',hook_event_id:'original-user',prompt:spec.requirements.join('\n')}});
 await handleRuntimeV2Event({...options,input:{...identity,hook_event_name:'PreToolUse',hook_event_id:'fixture-write',tool_name:'Write',tool_input:{file_path:path.join(projectRoot,'app.mjs'),content:spec.code}}});
 outcome=await handleRuntimeV2Event({...options,input:{...identity,hook_event_name:'Stop',hook_event_id:'original-stop',last_assistant_message:reply}});
}catch(e){error={code:e.code??'ERROR',message:String(e.message).replaceAll(process.env.ANTHROPIC_BASE_URL,'<provider>').slice(0,500)};}
finally{for(const h of handles)await h.close?.();}
const transcripts=[];async function walk(dir){for(const e of await fs.readdir(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(e.isDirectory())await walk(f);else if(e.name==='host-session.jsonl')transcripts.push(f);}}await walk(projectRoot);
const calls=new Map(),errors=new Set(),usage=new Map();
for(const f of transcripts)for(const line of(await fs.readFile(f,'utf8')).split('\n')){let frame;try{frame=JSON.parse(line);}catch{continue;}const m=frame.message;if(m?.role==='toolResult'&&m.isError)errors.add(f+':'+m.toolCallId);if(m?.role!=='assistant')continue;if(m.usage)usage.set(f+':'+frame.id,m.usage);for(const b of m.content??[])if(b.type==='toolCall')calls.set(f+':'+b.id,b.name);}
if (error) for (const [key,secret] of Object.entries(process.env)) if (/KEY|TOKEN|SECRET|PASSWORD|BASE_URL/i.test(key) && secret?.length>7) error.message=error.message.split(secret).join('<redacted>');
if (!outcome?.stop) error ??= {code:'HARNESS_NO_STOP',message:JSON.stringify(outcome).slice(0,600)};
const rows=outcome?.stop?.review?.metricObjectJudgements??[],expectedCount=claims.length;
const record={case:caseId,sourceRoot,revision,sourceDigest:sha256(sourceBytes),model,expected:spec.expected,expectedCount,status:outcome?.stop?.status??null,reasonCode:outcome?.stop?.reasonCode,classification:outcome?.stop?.review?.stopClassification,rows,match:rows.length===expectedCount&&rows.every(r=>r.judgement===spec.expected),elapsedMs:Date.now()-startedAt,reviewStarts:starts.length,reviewEnds:ends.length,toolCalls:calls.size,toolErrors:errors.size,sourceReads:[...calls.values()].filter(n=>n==='source_read').length,hostTokenCounters:Object.fromEntries(['input','output','cacheRead','cacheWrite','totalTokens'].map(k=>[k,[...usage.values()].reduce((s,u)=>s+(u[k]??0),0)])),error,transcripts,outputRoot:root};
await fs.writeFile(path.join(root,'result.json'),JSON.stringify(record,null,2));
console.log(JSON.stringify({...record,rows:rows.map(r=>({objectId:r.objectId,judgement:r.judgement})),transcripts:transcripts.length}));
// Installed host singletons may retain timers. All awaited reviews and receipts
// are settled before this explicit development-process exit.
process.exit(record.match&&!error?0:1);
