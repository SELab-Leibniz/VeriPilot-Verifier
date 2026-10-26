import { promises as fs } from "node:fs";
import path from "node:path";
import { assessStopCorrection } from "./stop-correction-assessment.mjs";
import { createStopCorrectionStore } from "./stop-correction-store.mjs";
import { createStopReviewStore } from "./stop-review-store.mjs";
import { reviewScopeClaims } from "./review-scope.mjs";
import { reviewProofOwners, validateReviewJudgement, validateReviewFile } from "./review-result-validation.mjs";
import { validateProductionTrace } from "../review-task/production-trace.mjs";
import { buildMetricPopulation, calculateMetricReport } from "./metrics.mjs";
import { appendTaskJournal, taskDirectory, withTaskState, decisionGuard } from "./task-store.mjs";
import { decisionScope, outsideDecision } from "./decision-scope.mjs";
import { atomicWriteJson, readJson, sha256 } from "./utils.mjs";
import { STOP_REVIEW_SCHEMA } from "./reviewer.mjs";
import { fingerprint } from "./evidence-state.mjs";
import { beforeStopDeadline } from "./stop-deadline.mjs";
import { hasStopReviews } from "./metric-policy.mjs";
import { loadCurrentGroundTruth } from "./ground-truth-ledger.mjs";
import { collectReviewItems } from "./review-collector.mjs";
import { runImplementationReview } from "./impl-review.mjs";
import {validateStructuredReviewEvidence} from './review-evidence-validation.mjs';
import {restrictStopReviewOutput} from './metric-policy.mjs';
import {implementationPopulation} from './review-routing.mjs';
import {recordDeviationFindings,markMetricPassesFixed} from './deviations.mjs';
import {prepareHostFeedback,boundHostFeedback} from './feedback-delivery.mjs';
import {saveProcessRetryBasis} from './stop-process-retry.mjs';

export function stopSessionDirectory({ input, host, env = process.env }) {
  if (path.isAbsolute(host?.directory ?? "")) return host.directory;
  if (path.isAbsolute(env.RUNTIME_CORRECTOR_STOP_SESSION_DIRECTORY ?? "")) return env.RUNTIME_CORRECTOR_STOP_SESSION_DIRECTORY;
  // Claude's actual transcript stays with its real session when cwd changes.
  // Native projections must supply their stable host directory explicitly.
  if (!host && path.isAbsolute(input.transcript_path ?? "")) return path.join(path.dirname(input.transcript_path), ".runtime-corrector-stop-sessions");
  return null;
}

async function evidenceCurrent(record) {
  for (const citation of record.sourceCitations ?? []) {
    const file = citation.frozen ? citation.snapshotPath : citation.path;
    try {
      if (await fs.realpath(file) !== path.resolve(file) || sha256(await fs.readFile(file)) !== citation.contentHash) return false;
    } catch { return false; }
  }
  for (const [file, expected] of Object.entries(record.reviewEvidence?.fingerprints ?? {})) {
    try { if (await fingerprint(file) !== expected) return false; } catch { return false; }
  }
  return true;
}

export async function stopFeedbackCurrent({ directory, sessionId, projectRoot, taskId, deviations }) {
  const store = createStopReviewStore({ directory, sessionId, scopeId: `${path.resolve(projectRoot)}:${taskId}`,
    validateResult: async () => { throw new Error("Read-only feedback validation cannot submit a result."); }, dependenciesCurrent: evidenceCurrent });
  const state = await store.inspect(), groundTruth = await loadCurrentGroundTruth(projectRoot, taskId);
  const valid = [];
  for (const deviation of deviations) {
    if (deviation.findingPath) {
      const expectedRoot=path.join(taskDirectory(projectRoot,taskId),'review-components');
      const relative=path.relative(expectedRoot,deviation.findingPath);
      if(relative==='..'||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative))continue;
      const record=await readJson(deviation.findingPath);
      if(record&&sha256(record)===deviation.receiptId&&record.hard===true&&await evidenceCurrent(record)
        &&sha256(reviewScopeClaims(groundTruth,{sourceIds:record.sourceIds}))===sha256(record.claims))valid.push(deviation);
      continue;
    }
    const item = state?.items[`${deviation.metricId}:${deviation.objectId}`];
    if (item?.definition.basis.object.hard === true && item.current?.receiptId === deviation.receiptId && item.current.valid !== false
      && sha256(reviewScopeClaims(groundTruth, { sourceIds: [item.definition.basis.object.sourceId] })) === sha256(item.definition.basis.claims)
      && await evidenceCurrent(item.current)) valid.push(deviation);
  }
  return valid;
}

/** One automatic Stop entry. It never calls the legacy assessment/retry loop.
 * Unsupported start-fence capabilities are explicit and cannot mint a start. */
export async function runProductionStop({ input, projectRoot, task, runtimeV2, reviewerFactory, host, env,
  snapshot, prepare, isCurrent = async () => true, verificationOnly = false, verificationId,stopFeedbackDeferred=false }) {
  if(runtimeV2.shadowMode===true){verificationOnly=true;verificationId??=host?.stopId??input.hook_event_id??snapshot.assistantKeys?.at(-1)??sha256(input.last_assistant_message??'');}
  const directory = stopSessionDirectory({ input, host, env }) ?? (verificationOnly ? taskDirectory(projectRoot, task.taskId) : null);
  const stopId = verificationOnly ? `verify:${verificationId}` : host?.stopId ?? `${input.session_id}:${snapshot.assistantKeys?.at(-1) ?? sha256(input.last_assistant_message ?? "")}`;
  const sourceId = snapshot.lastUserEntryKey;
  const flowId = host?.flowId ?? sha256([input.session_id, sourceId]);
  const evaluationId = `stop-${sha256([input.session_id, stopId]).slice(0, 24)}`;
  let taskId = task.taskId;
  let evaluationPath = path.join(taskDirectory(projectRoot, taskId), "evaluations", `${evaluationId}.json`);
  const prior = await readJson(evaluationPath);
  if (prior?.outcome && runtimeV2.stopCorrection.enabled) return { ...prior.outcome, reused: true };
  const pending = new Map();
  const assessmentContext = decisionScope.getStore()?.context;
  let prepared, reviewStore, core;
  const implementationReviews=[], stopReviewerJudgements=[], qualityProofs=[],collections=[],groupRecords=[],checkerIssues=[],providerDegradations=[];
  const findingRecords=new Map(),findings=[];
  let qualityResult=null;
  async function reviewFileQuality(window){
    const targets=(prepared.request.artifactCandidates??[]).flatMap(binding=>(binding.files??[]).map(file=>({path:file.path,sha256:file.sha256,artifactId:binding.artifactId})));
    const files=[];
    for(const target of targets){
      try{
        const handle=await beforeStopDeadline(()=>reviewerFactory({projectRoot,taskId,parentSessionId:input.session_id,role:'stop-reviewer',reviewer:runtimeV2.reviewers.stopReviewer,
          schema:{...STOP_REVIEW_SCHEMA,properties:{...STOP_REVIEW_SCHEMA.properties,metricObjectJudgements:{...STOP_REVIEW_SCHEMA.properties.metricObjectJudgements,maxItems:0},findings:{...STOP_REVIEW_SCHEMA.properties.findings,maxItems:0}}},
          deadlineAt:window.reviewDeadlineAt,abortSignal:window.signal,evidence:{snapshot,groundTruth:prepared.groundTruth},
          request:{...prepared.request,instructions:[...(prepared.request.instructions??[]),'Assess only the current delivery file against its original frozen obligations.'],population:{...prepared.population,metrics:{}},fixedStopClassification:prepared.classification,
            reviewScope:{kind:'file-quality',objectIds:[],sourceIds:[],qualityTarget:target}}}),{deadlineAt:window.reviewDeadlineAt,signal:window.signal,code:'STOP_REVIEW_DEADLINE'});
        try{
          const file=handle.result.fileAssessments?.find(file=>file.path===target.path),citations=await handle.getSourceCitations?.(handle.result)??handle.sourceCitations??[];
          if(!file||!await evidenceCurrent({...handle,sourceCitations:citations}))throw new Error('File quality proof is missing or stale.');
          const checked={fileAssessments:[structuredClone(file)],findings:[],metricObjectJudgements:[]};
          checkerIssues.push(...validateStructuredReviewEvidence(checked,[],citations,projectRoot));
          qualityProofs.push({...handle,sourceCitations:citations});files.push(checked.fileAssessments[0]);
        }finally{void handle.close?.();}
      }catch(cause){if(cause.code==='REVIEW_ITEM_EVIDENCE_UNAVAILABLE')checkerIssues.push({type:cause.code,objectId:target.path,message:cause.message});files.push({path:target.path,status:'UNVERIFIED',reason:cause.message,evidence:[]});}
    }
    return {files,complete:targets.length>0&&files.every(file=>file.status==='PASS')};
  }
  async function retainFindings(handle,objects,{deterministic=false,role='stop-reviewer'}={}) {
    const citations=await handle.getSourceCitations?.(handle.result)??handle.sourceCitations??[];
    const checked={...prepared.classification,metricObjectJudgements:[],fileAssessments:[],findings:structuredClone(handle.result.findings??[])};
    if(!deterministic)checkerIssues.push(...validateStructuredReviewEvidence(checked,objects,citations,projectRoot,{findingRole:role}));
    for(const finding of checked.findings){
      if(findings.some(value=>value.deviationKey===finding.deviationKey))continue;
      if(!await evidenceCurrent({...handle,sourceCitations:citations}))throw Object.assign(new Error('Finding evidence changed'),{code:'REVIEW_COLLECTION_STALE'});
      const sourceIds=finding.violatedGroundTruthIds??[];
      const hard=['error','blocker'].includes(finding.severity)&&(deterministic||(prepared.groundTruth.claims??[])
        .some(claim=>sourceIds.includes(claim.claimId)&&claim.status==='ACTIVE'&&claim.severity==='HARD'));
      const record={finding,hard,sourceIds,claims:reviewScopeClaims(prepared.groundTruth,{sourceIds}),sourceCitations:citations,reviewEvidence:handle.reviewEvidence??null};
      const findingPath=path.join(taskDirectory(projectRoot,taskId),'review-components',evaluationId,'findings',`${sha256(finding.deviationKey)}.json`);
      await outsideDecision(()=>atomicWriteJson(findingPath,record));
      const deviation={objectId:`finding:${finding.deviationKey}`,revisionId:sha256(record.claims),receiptId:sha256(record),findingPath,
        result:{judgement:'DEVIATION',reason:finding.reason,evidence:finding.actualEvidence??[]}};
      findings.push(finding);if(hard)findingRecords.set(deviation.receiptId,{record,deviation});
    }
  }
  const fault = cause => ({ decision: "allow", status: "UNVERIFIED", reasonCode: cause.code ?? "STOP_ASSESSMENT_FAILED",
    verificationIncomplete: true, feedback: null, correctionAttempt: 0, error: cause.message });
  try {
    const policy = runtimeV2.stopCorrection;
    const disabled = !policy.enabled || !hasStopReviews(policy);
    const zeroReason = policy.maxCorrectionsPerSession === 0 ? "SESSION_CORRECTION_LIMIT"
      : policy.maxCorrectionsPerFlow === 0 ? "FLOW_CORRECTION_LIMIT" : null;
    if (!verificationOnly && (disabled || zeroReason)) {
      const store = directory && createStopCorrectionStore({ directory });
      const existing = store && await store.inspect(input.session_id);
      if (disabled && existing) for (const pending of Object.values(existing.stops)) {
        if (pending.scope === path.resolve(projectRoot) && pending.releasedAt === undefined) await store.expireStop({
          sessionId: input.session_id, stopId: pending.id, force: true, scopeInvalidated: true, reasonCode: "STOP_CORRECTION_DISABLED" });
      }
      const entry = existing && sourceId ? await store.beginStop({ sessionId: input.session_id, flowId, stopId,
        sourceInput: { origin: "HUMAN", id: sourceId }, config: policy, scope: path.resolve(projectRoot) }) : null;
      core = { reused: false, summary: null, admission: null, stop: entry?.stop ?? { id: stopId, flowId, control: "ALLOW", config: policy,
        reviewStatus: disabled ? "DISABLED" : "SKIPPED", releaseReason: disabled ? "ALL_STOP_REVIEWS_DISABLED" : zeroReason } };
    } else {
    if (!directory) throw Object.assign(new Error("A stable host session store is unavailable."), { code: "STOP_SESSION_STORE_UNAVAILABLE" });
    if (!sourceId && !verificationOnly) throw Object.assign(new Error("No trusted real user input anchors this correction flow."), { code: "STOP_FLOW_SOURCE_REQUIRED" });
    const sessionStore = createStopCorrectionStore({ directory });
    core = await assessStopCorrection({ sessionStore, sessionId: input.session_id, flowId, stopId,
      sourceInput: { origin: "HUMAN", id: sourceId }, initialize: host?.initialize,
      config: runtimeV2.stopCorrection, signal: reviewerFactory.reviewAbortSignal, verificationOnly, scope: path.resolve(projectRoot),
      reviewOwner: { pid: process.pid },
      hostDeadlineAt: reviewerFactory.reviewDeadlineAt, isCurrent,
      // A host must actually enforce admission before business processing and
      // observe a real execution start. API acceptance alone is insufficient.
      admissionSupported: host?.startProtocol?.version === 1,
      prepare: async context => {
        prepared = await prepare(context);
        taskId = prepared.taskId ?? taskId;
        evaluationPath = path.join(taskDirectory(projectRoot, taskId), "evaluations", `${evaluationId}.json`);
        if(runtimeV2.stopCorrection.fileQualityReviewEnabled&&['TASK_COMPLETE','STAGE_COMPLETE'].includes(prepared.classification.stopClassification))
          qualityResult=await reviewFileQuality({reviewDeadlineAt:context.deadlineAt,signal:context.signal});
        if(!['TASK_COMPLETE','STAGE_COMPLETE'].includes(prepared.classification.stopClassification)) {
          const handle=await collectReviewItems({projectRoot,taskId,parentSessionId:input.session_id,role:'stop-reviewer',reviewer:runtimeV2.reviewers.stopReviewer,
            reviewerFactory,schema:STOP_REVIEW_SCHEMA,deadlineAt:context.deadlineAt,abortSignal:context.signal,classification:prepared.classification,
            request:{...prepared.request,population:prepared.fullPopulation,supplementalFileAssessments:false},evidence:{snapshot,groundTruth:prepared.groundTruth}});
          try{collections.push(handle.collection);await retainFindings(handle,Object.values(prepared.fullPopulation.metrics).flat());}
          finally{await handle.close?.();}
        }
        return { scopeId: `${path.resolve(projectRoot)}:${taskId}`, items: Object.values(prepared.population.metrics).flat().map(object => ({
          objectId: object.objectId, metricId: object.metricId, revisionId: object.sourceRevisionId,
          ...(verificationOnly||prepared.recheckObjectIds?.includes(object.objectId) ? { recheckRequestId: verificationId??stopId } : {}),
          basis: { object, claims: reviewScopeClaims(prepared.groundTruth, { sourceIds: [object.sourceId] }) }, dependencies: [],
        })) };
      },
      reviewStoreFor: scopeId => {
        reviewStore = createStopReviewStore({ directory, sessionId: input.session_id, scopeId,
          dependenciesCurrent: async (item, saved) => (!saved?.processDigest || saved.processDigest === snapshot.digest) && await evidenceCurrent(saved ?? {}),
          validateResult: async ({ item, result, group }) => {
            const handle = pending.get(`${group.id}:${item.objectId}`);
            if (!handle) throw new Error("No program-owned evidence accompanies this item submission.");
            const citations = (handle.sourceCitations ?? []).filter(citation => citation.usedBy?.includes(item.objectId));
            if (!await evidenceCurrent({ sourceCitations: citations, reviewEvidence: handle.reviewEvidence })) throw new Error("Current review evidence changed before saving.");
            for (const reference of result.evidence) if (!citations.some(citation => citation.selection === reference
              || `${citation.path}#L${citation.start}-L${citation.end}` === reference)) throw new Error("Unregistered item evidence.");
            validateReviewJudgement({ row: result, object: item.basis.object, citations, role:handle.rowRoles?.[item.objectId]??'stop-reviewer', classification: prepared.classification });
            if (item.metricId === "M16" && result.judgement === "PASS") validateProductionTrace(result.productionTrace,
              handle.proofs?.[item.objectId]?.sourceCiteIds ?? result.evidence);
            return { result, reviewer:handle.rowRoles?.[item.objectId]??'stop-reviewer',sourceCitations: citations, reviewEvidence: handle.reviewEvidence,
              ...(reviewProofOwners(item.basis.object).includes("PROCESS") ? { processDigest: snapshot.digest } : {}),
              snapshotKey: sha256({ basis: item.basis, citations: citations.map(c => [c.path, c.contentHash, c.start, c.end]),
                dependencies:handle.reviewEvidence?.fingerprints??null,
                process: reviewProofOwners(item.basis.object).includes("PROCESS") ? snapshot.digest : null }) };
          } });
        return reviewStore;
      },
      reviewGroup: async ({ brief, submit, signal }) => {
        const objects = brief.items.map(item => item.basis.object);
        const grouped=reviewerFactory.supportsStopGroups&&prepared.classification.stopClassification==='TASK_COMPLETE';
        const sourceOwned=new Set(Object.values(implementationPopulation({metrics:{[brief.metricId]:objects}},{groundTruth:prepared.groundTruth,
          stage:prepared.classification.stopClassification==='TASK_COMPLETE'?null:prepared.classification.stage}).population.metrics).flat().map(object=>object.objectId));
        const independent = runtimeV2.implementationCorrection.enabled && ['M09','M12','M16'].includes(brief.metricId)
          && sourceOwned.size>0;
        const accept = async handle => {
          if(handle.providerDegradation)providerDegradations.push(handle.providerDegradation);
          if(independent){
            const normal=handle.result.metricObjectJudgements??[];
            stopReviewerJudgements.push(...normal);
            const normalCitations=await handle.getSourceCitations?.(handle.result)??handle.sourceCitations??[];
            const reusable=[];
            for(const object of objects.filter(object=>['M09','M16'].includes(object.metricId))) {
              const row=normal.find(row=>row.objectId===object.objectId);
              if(!row||!['PASS','DEVIATION'].includes(row.judgement))continue;
              try{validateReviewJudgement({row,object,citations:normalCitations.filter(c=>c.usedBy?.includes(object.objectId))});
                if(object.metricId==='M16'&&row.judgement==='PASS')validateProductionTrace(row.productionTrace??handle.proofs?.[object.objectId]?.productionTrace,handle.proofs?.[object.objectId]?.sourceCiteIds??row.evidence);
                reusable.push(object.objectId);
              }catch{/* Unproven source claims must be independently checked. */}
            }
            const assigned=objects.filter(object=>sourceOwned.has(object.objectId)&&!reusable.includes(object.objectId));
            const impl=await runImplementationReview({projectRoot,sessionCwd:projectRoot,taskId,parentSessionId:input.session_id,runtimeV2,
              reviewerFactory:Object.assign(options=>reviewerFactory({...options,deadlineAt:brief.deadlineAt,abortSignal:signal}),reviewerFactory),
              population:{...prepared.population,metrics:{[brief.metricId]:assigned}},groundTruth:prepared.groundTruth,
              groundTruthPath:prepared.request.groundTruthPath,stage:prepared.classification.stopClassification==='TASK_COMPLETE'?null:prepared.classification.stage,
              deviceVerifier:async()=>({assurance:{level:'static',reason:'STOP_PROGRAM_EVIDENCE'},findings:[],build:{status:'skipped'},smoke:{status:'skipped'}})});
            impl.reusedStopSourceObjectIds=reusable;implementationReviews.push(impl);
            if(impl.status==='FAILED')checkerIssues.push({type:'IMPLEMENTATION_REVIEW_FAILED',message:impl.reviewerError??impl.summary});
            await retainFindings({result:{findings:(impl.findings??[]).filter(finding=>!(impl.deterministicFindings??[]).includes(finding)
              &&(prepared.population.reviewPolicy.metrics.M09!==false||!finding.deviationKey?.startsWith('impl:kit:')))},sourceCitations:impl.sourceCitations},objects,{role:'implementation-reviewer'});
            await retainFindings({result:{findings:impl.deterministicFindings??[]},reviewEvidence:impl.deterministicEvidence},[],{deterministic:true});
            if(!await evidenceCurrent({...handle,sourceCitations:normalCitations}))throw Object.assign(new Error('Review source changed during implementation review'),{code:'REVIEW_COLLECTION_STALE'});
            const rowRoles={},combined=[];
            for(const object of objects){
              const base=normal.find(row=>row.objectId===object.objectId),source=impl.metricObjectJudgements.find(row=>row.objectId===object.objectId);
              // Static success cannot certify a missing runtime observation or
              // erase an independently observed runtime deviation.
              const useSource=source&&base?.judgement!=='DEVIATION'&&!(object.metricId==='M12'&&source.judgement==='PASS');
              let row=useSource?source:base;
              if(!row)row={objectId:object.objectId,judgement:'UNVERIFIED',reason:'An assigned review component did not complete',evidence:[]};
              if(row.judgement==='CHECKER_ERROR')row={...row,judgement:'UNVERIFIED'};
              combined.push(row);if(useSource)rowRoles[object.objectId]='implementation-reviewer';
            }
            handle={...handle,rowRoles,getSourceCitations:undefined,proofs:{...handle.proofs,...impl.proofs},sourceCitations:[...normalCitations,...(impl.sourceCitations??[])],result:{...handle.result,metricObjectJudgements:combined}};
          } else stopReviewerJudgements.push(...(handle.result.metricObjectJudgements??[]));
          const citations=await handle.getSourceCitations?.(handle.result)??handle.sourceCitations??[];
          const checkedResult=structuredClone(restrictStopReviewOutput(handle.result,prepared.population));
          const originalFindings=checkedResult.findings;checkedResult.findings=[];
          checkerIssues.push(...validateStructuredReviewEvidence(checkedResult,objects,citations,projectRoot,{roleForObject:id=>handle.rowRoles?.[id]??'stop-reviewer'}));
          await retainFindings({...handle,result:{findings:originalFindings}},Object.values(prepared.fullPopulation.metrics).flat());
          handle={...handle,sourceCitations:citations,result:checkedResult};
          const receipts = [];
          for (const row of handle.result.metricObjectJudgements ?? []) {
            const item = brief.items.find(item => item.objectId === row.objectId);
            if (!item) throw new Error("A group submitted an unassigned object.");
            pending.set(`${brief.groupId}:${row.objectId}`, handle);
            const proof = handle.proofs?.[row.objectId];
            receipts.push(await submit({ objectId: row.objectId, revisionId: item.revisionId, result: { judgement: row.judgement==='CHECKER_ERROR'?'UNVERIFIED':row.judgement, reason: row.reason,
              evidence: row.evidence, ...(row.productionTrace || proof?.productionTrace ? { productionTrace: row.productionTrace ?? proof.productionTrace } : {}) } }));
          }
          return receipts.length === 1 ? receipts[0] : receipts;
        };
        const invoke=reviewerFactory.supportsReviewCollection&&!grouped?collectReviewItems:reviewerFactory;
        let handle;
        try{handle = await invoke({ reviewerFactory, projectRoot, taskId, parentSessionId: input.session_id, role: "stop-reviewer",
          reviewer: runtimeV2.reviewers.stopReviewer, schema: STOP_REVIEW_SCHEMA, deadlineAt: brief.deadlineAt, abortSignal: signal,
          onItemResult:independent?undefined:accept,
          request: { ...prepared.request, population: { ...prepared.population, metrics: { [brief.metricId]: objects } },
            reviewGroupId: brief.groupId, fixedStopClassification: prepared.classification,
            reviewScope: { kind:grouped?"stop-group":"metric", boundedBasis: true, objectIds: objects.map(object => object.objectId), sourceIds: objects.map(object => object.sourceId) } },
          classification:prepared.classification,evidence: { snapshot, groundTruth: prepared.groundTruth } });}
        catch(error){if(error.collection)collections.push(error.collection);throw error;}
        try { if (!grouped||independent) {
          for(const object of objects)if(!handle.result.metricObjectJudgements?.some(row=>row.objectId===object.objectId)){
            checkerIssues.push({type:'MISSING_OBJECT',objectId:object.objectId,message:'The reviewer omitted an assigned original object.'});
            (handle.result.metricObjectJudgements??=[]).push({objectId:object.objectId,judgement:'UNVERIFIED',reason:'The reviewer omitted an assigned original object.',evidence:[]});
          }
          if(handle.collection)collections.push(handle.collection);
          const sourceCitations = typeof handle.getSourceCitations === "function" ? await handle.getSourceCitations(handle.result) : handle.sourceCitations;
          await accept({ ...handle, sourceCitations });
        }
          const componentPath=path.join(taskDirectory(projectRoot,taskId),'review-components',evaluationId,`${brief.groupId}.json`);
          await atomicWriteJson(componentPath,{groupId:brief.groupId,status:'COMPLETED',result:handle.result,sourceCitations:handle.sourceCitations,proofs:handle.proofs,artifacts:handle.artifacts});
          groupRecords.push({groupId:brief.groupId,objectIds:objects.map(value=>value.objectId),path:componentPath,status:'COMPLETED'});
        } finally { void handle.close?.(); }
      },
      feedbackBasisCurrent: async deviations => {
        const state = await reviewStore.inspect();
        const valid = [];
        for (const deviation of deviations) {
          const supplementary=findingRecords.get(deviation.receiptId);
          if(supplementary&&await evidenceCurrent(supplementary.record)){valid.push(deviation);continue;}
          const item = state.items[`${deviation.metricId}:${deviation.objectId}`];
          if (item?.definition.basis.object.hard === true && item.current?.receiptId === deviation.receiptId
            && item.current.valid !== false && await evidenceCurrent(item.current)) valid.push(deviation);
        }
        return valid;
      },
      finalizeSummary: async (summary, window) => {
        const supplemental=[...findingRecords.values()].map(value=>value.deviation);
        const incomplete=collections.some(value=>!value.complete);
        const intermediate=!['TASK_COMPLETE','STAGE_COMPLETE'].includes(prepared.classification.stopClassification);
        summary={...summary,deviations:[...summary.deviations,...supplemental],complete:(intermediate?collections.every(value=>value.complete):summary.complete)&&!incomplete,
          status:incomplete?'UNVERIFIED':summary.deviations.length||supplemental.length?'DEVIATION':intermediate?'UNVERIFIED':summary.status,
          failures:[...(summary.failures??[]),...collections.flatMap(value=>value.failures??[])]};
        if(checkerIssues.length)summary={...summary,status:'UNVERIFIED',complete:false};
        if(intermediate)return summary;
        if (!runtimeV2.stopCorrection.fileQualityReviewEnabled) return summary;
        let {files,complete}=qualityResult??await reviewFileQuality(window);
        if((await Promise.all(qualityProofs.map(evidenceCurrent))).some(value=>!value)){
          files=files.map(file=>({...file,status:'UNVERIFIED',reason:'Delivery file changed after quality review.',evidence:[]}));complete=false;
        }
        const metricsComplete = summary.items.length === 0 || summary.complete;
        return { ...summary, metricsComplete, fileAssessments: files, complete: metricsComplete && complete,
          status: summary.deviations.length ? "DEVIATION" : metricsComplete && complete ? "PASS" : "UNVERIFIED" };
      } });
    }
  } catch (cause) { core = { failure: { code: cause.code, reason: cause.message }, stop: { reviewStatus: "UNVERIFIED", control: "ALLOW" } }; }
  const status = core.stop.reviewStatus==='SKIPPED'&&core.summary?.complete!==true?'UNVERIFIED':core.summary&&core.summary.complete!==true&&['PASS','DEVIATION'].includes(core.stop.reviewStatus)
    ? 'UNVERIFIED' : core.stop.reviewStatus;
  // Preserve the host's freshness/decision binding, including reused item
  // proofs. The SDK's private reads need not traverse native tool middleware.
  const savedItems = reviewStore ? Object.values((await reviewStore.inspect()).items)
    .filter(item => core.summary?.items.some(row => row.receiptId && row.receiptId === item.current?.receiptId)) : [];
  const sourceCitations = [...savedItems.flatMap(item => item.current.sourceCitations ?? []),...qualityProofs.flatMap(handle=>handle.sourceCitations)];
  const hostEvidence = typeof assessmentContext?.evidence === "function" ? assessmentContext.evidence() : null;
  const fingerprints = { ...hostEvidence?.fingerprints };
  let unstable = hostEvidence?.unstable === true;
  const capture = (file, hash) => {
    if (Object.hasOwn(fingerprints, file) && fingerprints[file] !== hash) unstable = true;
    fingerprints[file] = hash;
  };
  for (const item of savedItems) {
    for (const citation of item.current.sourceCitations ?? []) capture(citation.frozen ? citation.snapshotPath : citation.path, citation.contentHash);
    for (const [file, hash] of Object.entries(item.current.reviewEvidence?.fingerprints ?? {})) capture(file, hash);
  }
  for(const handle of qualityProofs){for(const citation of handle.sourceCitations)capture(citation.frozen?citation.snapshotPath:citation.path,citation.contentHash);
    for(const [file,hash] of Object.entries(handle.reviewEvidence?.fingerprints??{}))capture(file,hash);}
  const evidence = { ...hostEvidence, files: Object.keys(fingerprints), fingerprints, unstable,
    missing: Object.entries(fingerprints).filter(([, hash]) => hash === "missing").map(([file]) => file) };
  const rows = (core.summary?.items ?? []).map(item => ({ objectId: item.objectId, ...item.result,
    reviewer:savedItems.find(saved=>saved.current.receiptId===item.receiptId)?.current.reviewer??'stop-reviewer' }));
  const disabledPopulation=status==='DISABLED'?await buildMetricPopulation({projectRoot,taskId,groundTruth:await loadCurrentGroundTruth(projectRoot,taskId),reviewPolicy:runtimeV2.stopCorrection}):null;
  const report = disabledPopulation||prepared&&['TASK_COMPLETE','STAGE_COMPLETE'].includes(prepared.classification.stopClassification) ? calculateMetricReport({ population: prepared?.population??disabledPopulation, judgements: rows }) : null;
  if (report) report.status = status;
  if(report&&checkerIssues.length){report.checkerIssues.push(...checkerIssues);report.status='CHECKER_ERROR';}
  const admission = core.admission;
  const collectionComplete=(core.summary?.metricsComplete??core.summary?.complete)===true;
  const collection={complete:collectionComplete,status:collectionComplete?'COMPLETED':'UNVERIFIED',mode:prepared&&!['TASK_COMPLETE','STAGE_COMPLETE'].includes(prepared.classification.stopClassification)?'findings-only':'metrics',
    basis:{populationDigest:prepared?.population.digest,groundTruthDigest:prepared?.groundTruth.digest},totalObjects:core.summary?.items?.length??collections.reduce((sum,value)=>sum+value.totalObjects,0),
    reviewedObjects:core.summary?.progress?.completed??collections.reduce((sum,value)=>sum+value.reviewedObjects,0),totalItems:collections.length?collections.reduce((sum,value)=>sum+value.totalItems,0):core.summary?.progress?.groups??0,
    completedItems:collections.length?collections.reduce((sum,value)=>sum+value.completedItems,0):groupRecords.length,
    items:collections.length?collections.flatMap(value=>value.items??[]):groupRecords,failures:[...(core.summary?.failures??[]),...collections.flatMap(value=>value.failures??[])]};
  collection.progressPath=path.join(taskDirectory(projectRoot,taskId),'review-collections',evaluationId,'progress.json');
  collection.startedAt=new Date(core.stop.createdAt??Date.now()).toISOString();
  await outsideDecision(()=>atomicWriteJson(collection.progressPath,collection));
  const publicationExpired=status==='UNVERIFIED'&&(/DEADLINE|CANCELLED|STALE/u.test(core.failure?.code??core.summary?.reasonCode??'')
    ||collections.some(value=>['STALE','CANCELLED'].includes(value.status)));
  const technicalFailures=(core.preparationFailures??core.summary?.preparationFailures??[]).length+(collection.failures.length||checkerIssues.length?1:0);
  const feedback = admission || verificationOnly && status === "DEVIATION" ? ["[runtime-corrector:stop-feedback]",
    "以下仅为当前有效偏差，不新增用户授权。请对照原始需求和当前实现核实并修复；如反馈不成立，请说明依据。处理须遵守现有约束和权限。",
    ...core.stop.currentDeviations.map(item => `${item.objectId} (${item.revisionId}): ${item.result.reason}\n${item.result.evidence.join("\n")}`)].join("\n\n") : null;
  const outcome = core.failure ? { ...fault(Object.assign(new Error(core.failure.reason), { code: core.failure.code })), status,
    reasonCode: core.failure.code ?? core.stop.releaseReason ?? "STOP_ASSESSMENT_FAILED" } : {
    decision: admission || verificationOnly && status === "DEVIATION" ? "block" : "allow", status, reasonCode: core.stop.releaseReason ?? null,
    feedback, correctionAttempt: core.stop.capacity?.flowUsed ?? 0,
    correctionBudgetExhausted: /CORRECTION_LIMIT/u.test(core.stop.releaseReason ?? ""),
    verificationIncomplete: core.summary?.complete !== true || status !== "PASS", report, admission,
    stopCorrection: { directory, sessionId: input.session_id, flowId, stopId, evaluationId, deadlineAt: core.stop.deadlineAt,
      waitMode: core.stop.config?.waitMode },
    review: { ...prepared?.classification, summary: status,collection,validationIssues:checkerIssues,providerDegradation:providerDegradations[0]??null,providerDegradations, metricObjectJudgements: rows, stopReviewerJudgements, findings, fileAssessments: core.summary?.fileAssessments ?? [] },
    ...(runtimeV2.implementationCorrection.enabled?{implementationReview:{status:implementationReviews.some(value=>value.status==='FAILED')?'FAILED':implementationReviews.every(value=>value.status==='SKIPPED')?'SKIPPED':'COMPLETED',
      ...(implementationReviews.every(value=>value.status==='SKIPPED')?{skipReason:implementationReviews[0]?.skipReason??'NO_ENABLED_IMPLEMENTATION_OBJECTS'}:{}),
      reviews:implementationReviews,reusedStopSourceObjectIds:implementationReviews.flatMap(value=>value.reusedStopSourceObjectIds),
      metricObjectJudgements:implementationReviews.flatMap(value=>value.metricObjectJudgements),reviewerJudgements:implementationReviews.flatMap(value=>value.reviewerJudgements??[])}}:{}),
  };
  outcome.taskId = taskId;
  outcome.verificationUnavailable=technicalFailures>0;
  outcome.fileQualityIncomplete=(core.summary?.fileAssessments??[]).some(file=>file.status!=='PASS');
  outcome.partialFeedbackEligible=Boolean(admission&&status==='UNVERIFIED'&&core.stop.currentDeviations?.length);
  outcome.infrastructureAttempt=core.infrastructureAttempts??core.summary?.infrastructureAttempts??(technicalFailures?1:0);
  if(status==='UNVERIFIED'&&!outcome.reasonCode)outcome.reasonCode=core.summary?.failures?.[0]?.code??'STOP_REVIEW_INCOMPLETE';
  outcome.configWarnings = runtimeV2.stopCorrection.migrationWarnings;
  if (!outcome.feedback && outcome.reasonCode === "STOP_SESSION_MIGRATION_REQUIRED") outcome.feedback =
    `[runtime-corrector:status] 当前会话的历史纠偏次数尚未完成迁移核对，本次未自动审查，也未生成验收通过。详情：${evaluationPath}`;
  if (!outcome.feedback && outcome.reasonCode === "HOST_START_PROTOCOL_UNSUPPORTED") outcome.feedback =
    `[runtime-corrector:status] 已保留当前确认偏差；本版本的宿主实际启动、过期拦截与等待链尚未接通，因此没有自动续作，也未消耗业务额度。本次不算通过。详情：${evaluationPath}`;
  const capacityNotice = { SESSION_CORRECTION_LIMIT: "会话业务纠偏额度已用完，本次未自动审查。",
    FLOW_CORRECTION_LIMIT: "当前流程已达到业务纠偏上限，本次未自动审查。",
    SESSION_ADMISSION_PENDING: "会话可用名额被尚待核实的在途启动占用；这部分尚未计为已用，本次未自动审查。",
    FLOW_ADMISSION_PENDING: "当前流程可用名额被尚待核实的在途启动占用；这部分尚未计为已用，本次未自动审查。",
    CORRECTION_FLOW_CLOSED: "当前纠偏流程已结束，本次未重新启动自动审查。" }[outcome.reasonCode];
  if (!outcome.feedback && capacityNotice) outcome.feedback = `[runtime-corrector:status] UNVERIFIED (${outcome.reasonCode})：${capacityNotice}保留历史未解决事项，本次不生成验收通过。详情：${evaluationPath}`;
  if (!outcome.feedback && outcome.verificationIncomplete && status === "UNVERIFIED") outcome.feedback =
    `[runtime-corrector:status] UNVERIFIED：终审未完成（${outcome.reasonCode ?? "STOP_REVIEW_INCOMPLETE"}）。${outcome.error?String(outcome.error).slice(0,1200):''}本次放行不代表验收通过；未验证状态不自动派发业务修复。${(core.summary?.fileAssessments??[]).filter(file=>file.status!=='PASS').map(file=>`${file.path} [${file.status}]: ${file.reason}`).join('; ').slice(0,1024)} 详情：${evaluationPath}`;
  if(outcome.reasonCode==='PROCESS_CORRECTION_NO_PROGRESS'){delete outcome.report;outcome.feedback=`[runtime-corrector:status] UNVERIFIED: ${outcome.reasonCode}. ${core.failure.reason}`;}
  if(publicationExpired){
    if(outcome.admission&&!verificationOnly)await createStopCorrectionStore({directory}).expireStop({sessionId:input.session_id,stopId,force:true,scopeInvalidated:true,reasonCode:'STOP_REVIEW_STALE'});
    outcome.admission=null;outcome.decision='allow';outcome.partialFeedbackEligible=false;
    delete outcome.report;delete outcome.review;outcome.savedReviewCollection={...collection};
    outcome.reasonCode=core.failure?.code??collection.failures.find(value=>/STALE|DEADLINE|CANCELLED/u.test(value.code??''))?.code??'STOP_REVIEW_STALE';
    outcome.feedback=`[runtime-corrector:status] UNVERIFIED: ${outcome.reasonCode}. Saved items are historical work, not current valid verification.\n[RC_SAVED_REVIEW] ${collection.progressPath}`;}
  if(outcome.feedback)outcome.feedback=await prepareHostFeedback({projectRoot,taskId,text:outcome.feedback,review:outcome.review,report,citations:sourceCitations,
    implementationReview:outcome.implementationReview,locale:runtimeV2.locale});
  if(publicationExpired)outcome.feedback=boundHostFeedback(outcome.feedback,{prefix:`[RC_SAVED_REVIEW] ${collection.progressPath}`});
  if(report&&!publicationExpired){
    const bySource=new Map();for(const object of report.metrics.flatMap(metric=>metric.objects??[])){
      const list=bySource.get(object.sourceId)??[];list.push(object);bySource.set(object.sourceId,list);
    }
    await markMetricPassesFixed({projectRoot,taskId,passedObjectIds:[...bySource].filter(([,objects])=>objects.every(object=>['PASS','NOT_APPLICABLE'].includes(object.judgement))).map(([id])=>id)});
    await recordDeviationFindings({projectRoot,taskId,pipeline:'STOP',groundTruthVersion:prepared?.groundTruth.version,evaluationId,
      delivered:!verificationOnly&&!stopFeedbackDeferred&&!runtimeV2.shadowMode&&outcome.decision==='block',maxDeliveriesPerFamily:runtimeV2.deviationLoop?.maxDeliveriesPerFamily,
      findings:report.metrics.flatMap(metric=>(metric.objects??[]).filter(object=>object.judgement==='DEVIATION'&&object.hard).map(object=>({
        deviationKey:`metric:${object.metricId}:${object.sourceId}`,rootCauseId:'REQUIREMENT_OMITTED',severity:object.hard?'error':'warning',
        reason:object.reason,actualEvidence:object.evidence,violatedGroundTruthIds:[object.sourceId],expectedConstraint:'See the frozen original obligation.'}))) });
  }
  const processRetry=report&&outcome.decision==='block'?await saveProcessRetryBasis({projectRoot,taskId,report,review:outcome.review,evidence,snapshot,
    epochId:task.correctionEpoch.id,evaluationId,blockingFindings:findings.filter(finding=>findingRecords.size&&['error','blocker'].includes(finding.severity))}):null;
  const blockingFindingKeys=new Set([...findingRecords.values()].map(value=>value.record.finding.deviationKey));
  if(blockingFindingKeys.size&&!publicationExpired)await recordDeviationFindings({projectRoot,taskId,pipeline:'STOP',groundTruthVersion:prepared.groundTruth.version,evaluationId,
    delivered:!verificationOnly&&!stopFeedbackDeferred&&!runtimeV2.shadowMode&&outcome.decision==='block',findings:findings.filter(finding=>blockingFindingKeys.has(finding.deviationKey)),maxDeliveriesPerFamily:runtimeV2.deviationLoop?.maxDeliveriesPerFamily});
  await atomicWriteJson(evaluationPath, { evaluationId, core, outcome, metricReport: publicationExpired?null:report,...(publicationExpired?{historicalMetricReport:report}:{}),
    review: outcome.review,implementationReview:outcome.implementationReview, sourceCitations, evidence });
  await withTaskState({ projectRoot, taskId }, state => {
    const previousVerification=state.verification?{status:state.verification.status,evaluationId:state.verification.evaluationId,assessmentId:state.verification.assessmentId,reasonCode:state.verification.reasonCode}:null;
    state.stop.lastAssessmentId = evaluationId;
    if(processRetry)state.stop.processRetry=processRetry;else delete state.stop.processRetry;
    state.stop.correctionAttempts = core.stop.capacity?.flowUsed ?? state.stop.correctionAttempts;
    state.stop.correctionProtocol = "grouped-v1";
    state.stop.infrastructureTotalFailures=(state.stop.infrastructureTotalFailures??0)+technicalFailures;
    state.stop.infrastructureFailures=technicalFailures?(state.stop.infrastructureFailures??0)+1:core.summary?0:state.stop.infrastructureFailures??0;
    state.verification = { status, evaluationId, reasonCode: outcome.reasonCode, updatedAt: new Date().toISOString(),
      ...(!core.summary&&previousVerification?{previousVerification}:{}),
      assessmentId: assessmentContext?.assessmentId ?? evaluationId,
      rulesDigest: assessmentContext?.rulesDigest ?? sha256(runtimeV2), evidence,
      requirementVersion: prepared?.groundTruth.version ?? state.groundTruth.version,
      requirementDigest: prepared?.groundTruth.digest ?? state.groundTruth.digest,
      generation: decisionGuard(state).generation, cancelEpoch: decisionGuard(state).cancelEpoch };
    if(outcome.reasonCode==='PROCESS_CORRECTION_NO_PROGRESS'||status==='UNVERIFIED'&&(technicalFailures||!core.summary&&state.status==='STOPPED_UNVERIFIED'))state.status='STOPPED_UNVERIFIED';
    else if(prepared&&!['TASK_COMPLETE','STAGE_COMPLETE'].includes(prepared.classification.stopClassification))state.status='ACTIVE';
    else if (core.stop.control === "ALLOW") state.status = status === "PASS"
      ? prepared?.classification.stopClassification === "STAGE_COMPLETE" ? "ACTIVE" : "COMPLETED" : "COMPLETED_WITH_ISSUES";
    else state.status='ACTIVE';
  });
  await appendTaskJournal(projectRoot, taskId, { type: "STOP_CORRECTION_SETTLED", evaluationId, status,
    reasonCode: outcome.reasonCode, sessionId: input.session_id, flowId, stopId, admissionId: admission?.id ?? null });
  return outcome;
}
