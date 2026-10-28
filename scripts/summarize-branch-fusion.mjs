// Offline summary of saved paired results; never launches models.
import fs from 'node:fs/promises';
import path from 'node:path';
const args=process.argv.slice(2),arg=k=>args[args.indexOf(k)+1];
const baseline=path.resolve(arg('--baseline-root')),fusion=path.resolve(arg('--fusion-root'));
const semantics=path.resolve(arg('--semantics-root')),output=path.resolve(arg('--output'));
const cases=['correct','external','hidden','execution','optional','six'];
const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const branches={};
for(const variant of ['a','b','f']){
 const records=[];
 for(const id of cases){
  const file=path.join(variant==='f'?fusion:baseline,variant==='f'?`final-${id}`:`${variant}-${id}-v3`,'result.json');
  const r=await read(file);
  records.push({case:id,revision:r.revision,sourceDigest:r.sourceDigest,model:r.model,expected:r.expected,expectedCount:r.expectedCount,
   status:r.status,reasonCode:r.reasonCode,classification:r.classification??null,match:r.match,
   rows:r.rows.map(row=>({objectId:row.objectId,judgement:row.judgement})),elapsedMs:r.elapsedMs,
   reviewStarts:r.reviewStarts,reviewEnds:r.reviewEnds,toolCalls:r.toolCalls,toolErrors:r.toolErrors,sourceReads:r.sourceReads,
   hostTokenCounters:r.hostTokenCounters,error:r.error??null,localEvidence:file});
 }
 const semantic=await read(path.join(semantics,variant,'results.json'));
 branches[variant]={records,summary:{cases:records.length,matchingCases:records.filter(r=>r.match).length,
  expectedObjects:records.reduce((n,r)=>n+r.expectedCount,0),submittedObjects:records.reduce((n,r)=>n+r.rows.length,0),
  ...Object.fromEntries(['elapsedMs','reviewStarts','reviewEnds','toolCalls','toolErrors','sourceReads'].map(k=>[k,records.reduce((n,r)=>n+r[k],0)])),
  hostTokens:records.reduce((n,r)=>n+r.hostTokenCounters.totalTokens,0)},
  semantics:semantic.records.map(r=>({scenario:r.scenario,match:r.match,status:r.status??null,reason:r.reason??null,
   claims:r.claims??null,objectIds:r.rows?.map(row=>row.objectId)??null,m12:r.m12??null,m16:r.m16??null}))};
}
const common=cases.filter(id=>branches.a.records.find(r=>r.case===id).match&&branches.f.records.find(r=>r.case===id).match);
const pairedTime=variant=>branches[variant].records.filter(r=>common.includes(r.case)).reduce((n,r)=>n+r.elapsedMs,0);
const summary={generatedAt:new Date().toISOString(),kind:'six fixed known-answer cases per variant; one draw per case; not population accuracy or billing',
 commonCommit:'1435ab857e82b152b7a9684801ba21edd661fb52',host:'installed OpenClaw 2026.7.1-2, read-only',
 branches,comparison:{fusionVsAElapsedChange:branches.f.summary.elapsedMs/branches.a.summary.elapsedMs-1,
  fusionVsBElapsedChange:branches.f.summary.elapsedMs/branches.b.summary.elapsedMs-1,
  commonSuccessfulCases:common,commonSuccessfulTimeMs:{a:pairedTime('a'),f:pairedTime('f')}},
 caveats:['No replicated sampling or statistical significance claim.','Initial program fixtures are not business-model execution.','A timed-out case remains in the aggregate.','F runtime digests also record a serialization-only scope metadata fix during the batch; review semantics and model limits stayed fixed.','Host token counters include cached input; prices are not configured.','Deterministic semantic cases use scripted transport and verdicts, separately from model samples.']};
if(args.includes('--gateway-root')){
 const root=path.resolve(arg('--gateway-root')),audit=await read(path.join(root,'audit.json')),raw=await read(path.join(root,'result.json'));
 const {privateRuns,evaluations,...facts}=audit;
 summary.actualHostCycle={...facts,providerRequests:raw.providerRequests,modelCallStarts:raw.modelStarts.length,
  faultKind:raw.injected?.kind,finalReview:audit.finalReview,localEvidence:root,
  freshnessProbe:await read(path.join(root,'stale-source-audit.json')).then(r=>({staleRejected:!r.complete,reportVerification:r.reportVerification})),
  processCleanup:await read(path.join(root,'process-cleanup.json')).then(r=>({pid:r.Pid,gatewayClosed:r.GatewayClosed,auditComplete:r.AuditComplete}))};
}
if(args.includes('--validation-root')){
 const root=path.resolve(arg('--validation-root'));
 const log=name=>fs.readFile(path.join(root,name),'utf8');
 const counts=async name=>Object.fromEntries([...(await log(name)).matchAll(/^[#ℹ] (tests|pass|fail|cancelled|skipped) (\d+)\r?$/gmu)].map(([,k,n])=>[k,Number(n)]));
 const lines=(await log('fusion-final-suite.log')).trim().split('\n');
 summary.validation={fullSuite:JSON.parse(lines.at(-1)),isolatedTimingRecheck:await counts('fusion-supervised-recheck.log'),
  package:await counts('fusion-package-final.log'),installedHost:await counts('fusion-installed-host.log'),
  browser:(await log('fusion-browser-chrome.log')).includes('PASS browser:'),localEvidence:root};
}
await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify({output,summary:Object.fromEntries(Object.entries(branches).map(([k,v])=>[k,v.summary])),comparison:summary.comparison}));
