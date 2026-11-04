import { promises as fs } from "node:fs";
import path from "node:path";
import { hasLinkedPath, isSameFile } from "../path-utils.mjs";
import { matchConfiguredArtifact } from "../artifact-pipeline.mjs";
import { instructionFileNames } from "../active-host.mjs";
import { assessStopCorrection } from "./stop-correction-assessment.mjs";
import { createStopCorrectionStore } from "./stop-correction-store.mjs";
import { createStopReviewStore } from "./stop-review-store.mjs";
import { reviewScopeClaims } from "./review-scope.mjs";
import { reviewProofOwners, validateReviewJudgement } from "./review-result-validation.mjs";
import { validateProductionTrace } from "../review-task/production-trace.mjs";
import { buildMetricPopulation, calculateMetricReport } from "./metrics.mjs";
import { appendTaskJournal, taskDirectory, withTaskState, decisionGuard, findTask } from "./task-store.mjs";
import { decisionScope, outsideDecision } from "./decision-scope.mjs";
import { atomicWriteJson, readJson, sha256, uniqueId, safeId } from "./utils.mjs";

import { fingerprint } from "./evidence-state.mjs";
import { expectedFilesCurrent } from './expected-files.mjs';
import { SKILL_SOURCE_CONTRACT_VERSION } from './skill-source.mjs';
import { captureConditionSnapshot } from '../review-task/task-evidence.mjs';

import { hasStopReviews } from "./metric-policy.mjs";
import { loadCurrentGroundTruth } from "./ground-truth-ledger.mjs";
import { materialManifest } from "./onboarding.mjs";
import { recordUserMessages, transcriptUserMessages } from "./original-requirements.mjs";

import { validateStructuredReviewEvidence } from './review-evidence-validation.mjs';
import { restrictStopReviewOutput } from './metric-policy.mjs';

import { recordDeviationFindings, markMetricPassesFixed } from './deviations.mjs';
import { prepareHostFeedback, boundHostFeedback } from './feedback-delivery.mjs';
import { processRetryObjects, saveProcessRetryBasis } from './stop-process-retry.mjs';
import { CONDITIONAL_REVIEW_POLICY_VERSION, conditionWindowCurrent } from '../review-task/task-evidence.mjs';

// Build a manifest for this Stop. The host's process snapshot is still
// separate from these original requirement sources. With a session, user
// messages come from the session log, which keeps those a host compaction
// removed from the transcript; without one, nothing is written.
export async function loadStopOriginalRequirements({ projectRoot, sessionId = null, snapshot, materialRoots = [], plan = {}, loadMaterials = materialManifest }) {
  const userMessages = [], userHashes = new Map();
  // The log keeps the first text seen for a ref; the live transcript is checked
  // again so that a ref whose text changed still fails instead.
  for (const { ref, timestamp, text, retainedAfterCompaction } of [...await recordUserMessages({ projectRoot, sessionId, snapshot }),
    ...transcriptUserMessages(snapshot)]) {
    if (text.includes('[runtime-corrector:stop-feedback]')) continue;
    const hash = sha256(text);
    if (userHashes.has(ref)) {
      if (userHashes.get(ref) !== hash) throw Object.assign(new Error('Conflicting original user message identities.'), { code: 'STOP_TASK_BASIS_UNAVAILABLE' });
      continue;
    }
    userHashes.set(ref, hash);
    userMessages.push({ order: userMessages.length + 1, ref, timestamp, sha256: hash, text,
      ...(retainedAfterCompaction ? { retainedAfterCompaction } : {}) });
  }

  const seen = new Set(), artifacts = plan.configuredArtifacts ?? plan.artifacts ?? [];
  const sensitiveName = file => /^(?:\.env(?:\.|$)|\.npmrc$|\.pypirc$|(?:credentials|secrets)(?:\.|$)|id_(?:rsa|ed25519)$)/iu.test(path.basename(file));
  async function originalFile(file) {
    const absolute = path.resolve(projectRoot, file), relative = path.relative(projectRoot, absolute).replaceAll('\\', '/');
    const inProject = relative !== '..' && !relative.startsWith('../') && !path.isAbsolute(relative);
    if (sensitiveName(absolute) || relative.split('/').some(part => ['.git', 'node_modules', 'oh_modules', '.runtime-correction'].includes(part))
      || inProject && matchConfiguredArtifact(relative, artifacts, plan.workflowCorrelation)) return null;
    const name = inProject ? relative : absolute.replaceAll('\\', '/');
    try {
      const stat = await fs.stat(absolute);
      if (!stat.isFile() || stat.size > 4 * 1024 * 1024 || await hasLinkedPath(absolute)) return null;
      const identity = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
      if (seen.has(identity)) return null;
      const bytes = await fs.readFile(absolute);
      if (bytes.includes(0) || !Buffer.from(bytes.toString('utf8')).equals(bytes)) return null;
      seen.add(identity);
      return { path: name, bytes: bytes.length, sha256: sha256(bytes) };
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'EINVAL', 'ENAMETOOLONG'].includes(error.code)) return null;
      throw error;
    }
  }
  const projectFiles = [], materials = [], referencedFiles = [];
  for (const name of instructionFileNames) {
    const file = await originalFile(name);
    if (file) projectFiles.push(file);
  }
  for (const entry of (await loadMaterials(materialRoots.filter(root => !sensitiveName(root)))).entries) {
    const file = await originalFile(path.resolve(entry.root, entry.path));
    if (file) materials.push(file);
  }
  for (const message of userMessages) {
    for (const token of message.text.match(/[^\s`'"“”‘’<>()[\]{}，。；：、！？|*]+\.[A-Za-z0-9]{1,8}/gu) ?? []) {
      // Naming a code target in the request does not make its current
      // implementation a requirement source. Declared material roots can
      // explicitly designate source files when they are original inputs.
      if (!/\.(?:adoc|csv|json5?|markdown|mdx?|rst|toml|tsv|txt|xml|ya?ml)$/iu.test(token)) continue;
      const file = await originalFile(token);
      if (file) referencedFiles.push(file);
    }
  }
  const digest = sha256({ userMessages: userMessages.map(({ ref, sha256: hash }) => [ref, hash]), materials, projectFiles, referencedFiles });
  return { digest, userMessages, materials, projectFiles, referencedFiles };
}

export function stopSessionDirectory({ input, host, env = process.env }) {
  if (path.isAbsolute(host?.directory ?? "")) return host.directory;
  if (path.isAbsolute(env.RUNTIME_CORRECTOR_STOP_SESSION_DIRECTORY ?? "")) return env.RUNTIME_CORRECTOR_STOP_SESSION_DIRECTORY;
  // Claude's actual transcript stays with its real session when cwd changes.
  // Native projections must supply their stable host directory explicitly.
  if (!host && path.isAbsolute(input.transcript_path ?? "")) return path.join(path.dirname(input.transcript_path), ".runtime-corrector-stop-sessions");
  return null;
}

async function evidenceCurrent(record) {
  if (!await expectedFilesCurrent(record.reviewEvidence?.expectedFiles)) return false;
  for (const [requested, real] of Object.entries(record.reviewEvidence?.readPaths ?? {})) {
    try { if (!await isSameFile(requested, real)) return false; } catch { return false; }
  }
  for (const citation of record.sourceCitations ?? []) {
    const file = citation.frozen ? citation.snapshotPath : citation.path;
    try {
      if (await hasLinkedPath(file) || sha256(await fs.readFile(file)) !== citation.contentHash) return false;
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
  const state = await store.inspect();
  let groundTruth;
  const ledgerClaims = async sourceIds => reviewScopeClaims(await (groundTruth ??= loadCurrentGroundTruth(projectRoot, taskId)), { sourceIds });
  const valid = [];
  for (const deviation of deviations) {
    if (deviation.findingPath) {
      const expectedRoot=path.join(taskDirectory(projectRoot,taskId),'review-components');
      const relative=path.relative(expectedRoot,deviation.findingPath);
      if(relative==='..'||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative))continue;
      const record=await readJson(deviation.findingPath);
      if(record&&sha256(record)===deviation.receiptId&&record.hard===true&&await evidenceCurrent(record)
        &&(record.originalRequirementsBasis === true || sha256(await ledgerClaims(record.sourceIds))===sha256(record.claims)))valid.push(deviation);
      continue;
    }
    const item = state?.items[`${deviation.metricId}:${deviation.objectId}`];
    if (item?.definition.basis.object.hard === true && item.current?.receiptId === deviation.receiptId && item.current.valid !== false
      && (item.definition.basis.originalRequirementsBasis === true
        || sha256(await ledgerClaims([item.definition.basis.object.sourceId])) === sha256(item.definition.basis.claims))
      && await evidenceCurrent(item.current)) valid.push(deviation);
  }
  return valid;
}

/** Retire only the still-current conclusion, never an older receipt or flow. */
export async function invalidateCurrentStopVerification({ projectRoot, taskId, sessionId, expectedTask, evaluationId,
  reasonCode, signal, deadlineAt = Infinity }) {
  const active = await findTask({ projectRoot, sessionId });
  if (!expectedTask || active?.taskId !== taskId || expectedTask.verification?.evaluationId !== evaluationId) return null;
  const captured = decisionGuard(expectedTask), id = uniqueId('verification-invalidated'); let audit = null;
  await withTaskState({ projectRoot, taskId }, state => {
    const current = decisionGuard(state);
    if (signal?.aborted || Date.now() >= deadlineAt || state.control?.cancelled
      || ['generation', 'correctionEpoch', 'pendingRevision', 'cancelEpoch', 'enabledRevision'].some(key => current[key] !== captured[key])
      || sha256(state.verification ?? null) !== sha256(expectedTask.verification ?? null)) return;
    const previousVerification = structuredClone(state.verification);
    audit = { type: 'STOP_VERIFICATION_INVALIDATED', evaluationId: id, taskId, reasonCode,
      previousVerification, currentBasis: { requirementVersion: state.groundTruth.version, requirementDigest: state.groundTruth.digest },
      at: new Date().toISOString() };
    state.verification = { ...previousVerification, status: 'UNVERIFIED', evaluationId: id, assessmentId: id,
      reasonCode, previousVerification: { evaluationId: previousVerification.evaluationId, status: previousVerification.status }, updatedAt: audit.at };
    state.stop.lastAssessmentId = id;
    if (state.status === 'COMPLETED') state.status = 'COMPLETED_WITH_ISSUES';
  });
  if (!audit) return null;
  const file = path.join(taskDirectory(projectRoot, taskId), 'evaluations', `${id}.json`);
  await atomicWriteJson(file, audit);
  await appendTaskJournal(projectRoot, taskId, { type: audit.type, evaluationId: id, previousEvaluationId: evaluationId, reasonCode });
  return { evaluationId: id, path: file };
}

/** One automatic Stop entry. It never calls the legacy assessment/retry loop.
 * Unsupported start-fence capabilities are explicit and cannot mint a start. */
export async function runProductionStop({ input, projectRoot, task, runtimeV2, reviewerFactory, host, env,
  snapshot, prepare, readOriginalRequirements, isCurrent = async () => true, verificationOnly = false, verificationId,stopFeedbackDeferred=false }) {
  const deviationOnly = (task.stop?.reviewPolicy ?? runtimeV2.stopCorrection).deviationOnly === true;
  if(runtimeV2.shadowMode===true){verificationOnly=true;verificationId??=host?.stopId??input.hook_event_id??snapshot.assistantKeys?.at(-1)??sha256(input.last_assistant_message??'');}
  const directory = stopSessionDirectory({ input, host, env }) ?? (verificationOnly ? taskDirectory(projectRoot, task.taskId) : null);
  const stopId = verificationOnly ? `verify:${verificationId}` : host?.stopId ?? `${input.session_id}:${snapshot.assistantKeys?.at(-1) ?? sha256(input.last_assistant_message ?? "")}`;
  const sourceId = snapshot.lastUserEntryKey;
  const flowId = host?.flowId ?? sha256([input.session_id, sourceId]);
  const evaluationId = `stop-${sha256([input.session_id, stopId]).slice(0, 24)}`;
  let taskId = task.taskId;
  let evaluationPath = path.join(taskDirectory(projectRoot, taskId), "evaluations", `${evaluationId}.json`);
  const prior = await readJson(evaluationPath);
  const reviewPolicyVersion = sha256({ conditional: CONDITIONAL_REVIEW_POLICY_VERSION, skillSource: SKILL_SOURCE_CONTRACT_VERSION,
    ...(deviationOnly ? { deviationOnly } : {}),
    ...(readOriginalRequirements ? { originalRequirementsBasis: true } : {}) });
  let originalRequirements;
  const reviewBasisBinding = async state => {
    try {
      if ((!readOriginalRequirements && state.groundTruth.onboardingPending?.length) || state.documentCoverage?.status === 'UNVERIFIED') return null;
      const basis = state.groundTruth.sharedBasis, sources = basis?.sources ?? [];
      if (!readOriginalRequirements) for (const source of sources.filter(value => value.kind !== 'USER_MESSAGE')) {
        const file = path.resolve(projectRoot, source.ref);
        if (await hasLinkedPath(file) || sha256(await fs.readFile(file)) !== source.sha256) return null;
      }
      const ids = [...new Set([...(basis?.adoptedSkills ?? []).map(value => value.skillId), ...Object.values(state.watchers ?? {}).map(w => w.skillId)])].sort();
      const graphs = await Promise.all(ids.map(async id => [id, sha256(await fs.readFile(path.join(taskDirectory(projectRoot, taskId), 'skills', safeId(id), 'skill-ground-truth.json')))]));
      return sha256({ reviewPolicyVersion, guard: decisionGuard(state), originalBasis: readOriginalRequirements
        ? (originalRequirements ?? await readOriginalRequirements()).digest : basis?.basisDigest ?? null,
        sourceCursor: sha256(snapshot.entries ?? []), graphs });
    } catch { return null; }
  };
  if (prior?.outcome && runtimeV2.stopCorrection.enabled) {
    const currentBasis = await reviewBasisBinding(task);
    const priorStatus = prior.outcome.status;
    const requiresCurrentVerification = priorStatus === 'PASS' || deviationOnly && priorStatus === 'NO_DEVIATION_FOUND';
    const stillCurrent = !requiresCurrentVerification
      || task.verification?.evaluationId === evaluationId && task.verification?.status === priorStatus;
    if (prior.reviewPolicyVersion === reviewPolicyVersion && currentBasis && prior.reviewBasisBinding === currentBasis
      && stillCurrent && await evidenceCurrent({ sourceCitations: prior.sourceCitations, reviewEvidence: prior.evidence }))
      return { ...prior.outcome, evaluationId, reused: true };
    const reasonCode = prior.reviewPolicyVersion !== reviewPolicyVersion ? 'STOP_REVIEW_POLICY_STALE'
      : !stillCurrent ? 'STOP_REVIEW_SUPERSEDED' : 'STOP_REVIEW_STALE';
    await invalidateCurrentStopVerification({ projectRoot, taskId, sessionId: input.session_id, expectedTask: task, evaluationId,
      reasonCode, signal: reviewerFactory.reviewAbortSignal, deadlineAt: reviewerFactory.reviewDeadlineAt });
    return { ...prior.outcome, evaluationId, reused: true, status: 'UNVERIFIED', decision: 'allow', admission: null, report: null, review: null,
      verificationIncomplete: true, reasonCode,
      feedback: '[runtime-corrector:status] UNVERIFIED：历史审查的政策或当前依据已失效，本次未获当前验收；原记录保留。' };
  }
  const pending = new Map();
  const assessmentContext = decisionScope.getStore()?.context;
  let prepared, reviewStore, core;
  const stopReviewerJudgements=[], qualityProofs=[],collections=[],groupRecords=[],checkerIssues=[],providerDegradations=[];
  const findingRecords=new Map(),findings=[];
  let qualityResult=null,scopeCounts=null,scanCompleted=false;
  async function checkedConditionContext(handle, object, row) {
    if (object.applicabilityKind !== 'CONDITIONAL') return null;
    const binding = handle.proofs?.[object.objectId]?.conditionBinding;
    if (!binding) {
      if (row.conditionAssessment?.evidenceKind === 'PROCESS_WINDOW') throw Object.assign(new Error('A program-owned conditional window certificate is required.'), { code: 'REVIEW_ITEM_EVIDENCE_UNAVAILABLE' });
      return null;
    }
    if (binding.policy !== CONDITIONAL_REVIEW_POLICY_VERSION || binding.cursor !== sha256(snapshot.entries ?? [])
      || binding.objectId !== object.objectId || binding.objectRevision !== object.sourceRevisionId || binding.objectDigest !== sha256(object)
      || ['activation', 'reason', 'evidenceKind', 'afterCallId'].some(key => binding[key] !== row.conditionAssessment?.[key]))
      throw Object.assign(new Error('Conditional policy, object, revision or cursor no longer matches its qualified assessment.'), { code: 'REVIEW_ITEM_EVIDENCE_UNAVAILABLE' });
    if (binding.window) {
      const captured = await captureConditionSnapshot(snapshot, binding.window.sourcePath);
      if (!captured.complete || captured.cursor !== binding.cursor || captured.hash !== binding.window.sourceHash
        || !await conditionWindowCurrent(binding.window)) throw Object.assign(new Error('The original conditional window changed.'), { code: 'REVIEW_COLLECTION_STALE' });
    }
    return { currentCursor: binding.cursor, processWindow: binding.window };
  }
  async function conditionContextResolver(handle, objects, rows) {
    const byId = new Map(objects.map(object => [object.objectId, object])), values = new Map();
    for (const row of rows) {
      const object = byId.get(row.objectId);
      if (object?.applicabilityKind !== 'CONDITIONAL') continue;
      try { values.set(row.objectId, { value: await checkedConditionContext(handle, object, row) }); }
      catch (error) {
        if (/STALE|CANCEL|DEADLINE/u.test(error.code ?? '')) throw error;
        values.set(row.objectId, { error });
      }
    }
    // This callback is program-owned, built from checked handle proofs and
    // current originals. It never comes from a model report or stored row.
    return objectId => { const entry = values.get(objectId); if (entry?.error) throw entry.error; return entry?.value ?? null; };
  }
  async function retainFindings(handle,objects,{deterministic=false,role='stop-reviewer'}={}) {
    const citations=await handle.getSourceCitations?.(handle.result)??handle.sourceCitations??[];
    const sourceIds = new Set((handle.result.findings ?? []).flatMap(finding => finding.violatedGroundTruthIds ?? []));
    const conditional = new Set(objects.filter(object => object.applicabilityKind === 'CONDITIONAL' && sourceIds.has(object.sourceId)).map(object => object.objectId));
    const checked={...prepared.classification,metricObjectJudgements:structuredClone((handle.result.metricObjectJudgements ?? []).filter(row => conditional.has(row.objectId))),
      fileAssessments:[],findings:structuredClone(handle.result.findings??[])};
    if(!deterministic)checkerIssues.push(...validateStructuredReviewEvidence(checked,objects,citations,projectRoot,{findingRole:role,
      roleForObject: id => handle.rowRoles?.[id] ?? role,
      conditionContextForObject: await conditionContextResolver(handle, objects, checked.metricObjectJudgements) }));
    for(const finding of checked.findings){
      if(findings.some(value=>value.deviationKey===finding.deviationKey))continue;
      if(!await evidenceCurrent({...handle,sourceCitations:citations}))throw Object.assign(new Error('Finding evidence changed'),{code:'REVIEW_COLLECTION_STALE'});
      const sourceIds=finding.violatedGroundTruthIds??[];
      const hard=['error','blocker'].includes(finding.severity)&&(deterministic||(prepared.groundTruth.claims??[])
        .some(claim=>sourceIds.includes(claim.claimId)&&claim.status==='ACTIVE'&&claim.severity==='HARD'));
      const record={finding,hard,sourceIds,claims:reviewScopeClaims(prepared.groundTruth,{sourceIds}),sourceCitations:citations,reviewEvidence:handle.reviewEvidence??null,
        ...(originalRequirements ? { originalRequirementsBasis: true } : {}) };
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
        if (readOriginalRequirements) originalRequirements = await readOriginalRequirements();
        prepared = await prepare(originalRequirements ? { ...context, originalRequirements } : context);
        taskId = prepared.taskId ?? taskId;
        evaluationPath = path.join(taskDirectory(projectRoot, taskId), "evaluations", `${evaluationId}.json`);
        let handle = prepared.unifiedReview;
        if (!handle?.result) throw Object.assign(new Error('Stop preparation must return the single workspace review.'), { code: 'STOP_WORKSPACE_REVIEW_REQUIRED' });
        if (!await evidenceCurrent(handle)) throw Object.assign(new Error('Workspace review evidence changed'), { code: 'REVIEW_COLLECTION_STALE' });
        const filteredResult = restrictStopReviewOutput(handle.result, prepared.population);
        if (deviationOnly && (filteredResult.metricObjectJudgements.some(row => row.judgement !== 'DEVIATION')
          || filteredResult.fileAssessments?.some(row => row.status !== 'DEVIATION')))
          throw Object.assign(new Error('A deviation-only review must submit only deviations.'), { code: 'STOP_REVIEW_INVALID' });
        const metricResult = structuredClone({ ...filteredResult, findings: [], fileAssessments: [] });
        stopReviewerJudgements.push(...handle.result.metricObjectJudgements);
        const objects = Object.values(prepared.population.metrics).flat();
        checkerIssues.push(...validateStructuredReviewEvidence(metricResult, objects, handle.sourceCitations, projectRoot, {
          roleForObject: id => handle.rowRoles?.[id] ?? 'stop-reviewer',
          conditionContextForObject: await conditionContextResolver(handle, objects, metricResult.metricObjectJudgements) }));
        metricResult.metricObjectJudgements = metricResult.metricObjectJudgements.map(({ conditionBinding, ...row }) => row);
        handle = prepared.unifiedReview = { ...handle, result: { ...filteredResult, metricObjectJudgements: metricResult.metricObjectJudgements } };
        // Reuse this full review for the no-progress guard. No negative-only
        // worker or second implementation reviewer is necessary.
        const retry = !verificationOnly && await processRetryObjects({ projectRoot, task, population: prepared.population,
          truth: prepared.groundTruth, snapshot, classification: prepared.classification });
        if (retry && !checkerIssues.length && !handle.result.findings?.length && handle.collection?.complete !== false) {
          const ids = new Set(retry.objects.map(object => object.objectId));
          const rows = handle.result.metricObjectJudgements;
          const objects = Object.values(prepared.population.metrics).flat();
          if (rows.length === objects.length && retry.objects.every(object => rows.find(row => row.objectId === object.objectId)?.judgement === 'DEVIATION')
            && rows.every(row => row.judgement !== 'UNVERIFIED' && (row.judgement !== 'DEVIATION' || ids.has(row.objectId)))) {
            let proven = true;
            try {
              for (const object of objects) {
                const row = rows.find(row => row.objectId === object.objectId);
                validateReviewJudgement({ row, object, citations: handle.sourceCitations.filter(c => c.usedBy?.includes(object.objectId)), classification: prepared.classification,
                  conditionContext: await checkedConditionContext(handle, object, row) });
                if (object.metricId === 'M16' && row.judgement === 'PASS')
                  validateProductionTrace(row.productionTrace ?? handle.proofs?.[object.objectId]?.productionTrace, handle.proofs?.[object.objectId]?.sourceCiteIds ?? row.evidence);
              }
            } catch { proven = false; }
            if (proven) throw Object.assign(new Error('Unchanged process deviations are retained; the full workspace review found no corrective progress.'), { code: 'PROCESS_CORRECTION_NO_PROGRESS' });
          }
        }
        const fileResult = { metricObjectJudgements: [], findings: [], fileAssessments: structuredClone(handle.result.fileAssessments ?? []) };
        checkerIssues.push(...validateStructuredReviewEvidence(fileResult, [], handle.sourceCitations ?? [], projectRoot));
        const files = fileResult.fileAssessments;
        scopeCounts = { fullObjectCount: prepared.population.scopeSelection?.fullObjectCount ?? objects.length, selectedObjectCount: objects.length, fileTargetCount: 0 };
        if (runtimeV2.stopCorrection.fileQualityReviewEnabled && ['TASK_COMPLETE', 'STAGE_COMPLETE'].includes(prepared.classification.stopClassification)) {
          const key = file => process.platform === 'win32' ? path.resolve(projectRoot, file).toLowerCase() : path.resolve(projectRoot, file);
          const targets = new Map((prepared.request.artifactCandidates ?? []).flatMap(binding => binding.files ?? []).map(file => [key(file.path), file]));
          scopeCounts.fileTargetCount = targets.size;
          for (const file of files) if (!targets.has(key(file.path))) {
            checkerIssues.push({ type: 'UNKNOWN_FILE', objectId: file.path, message: 'Unassigned file-quality result.' });
            Object.assign(file, { status: 'UNVERIFIED', reason: 'This file was not a requested quality target.', evidence: [] });
          }
          if (!deviationOnly) {
            for (const [name, target] of targets) if (!files.some(file => key(file.path) === name))
              files.push({ path: target.path, status: 'UNVERIFIED', reason: 'The requested file-quality review was not submitted.', evidence: [] });
          }
        }
        qualityResult = { files, complete: files.length > 0 && files.every(file => file.status === 'PASS') };
        qualityProofs.push(handle);
        if (handle.providerDegradation) providerDegradations.push(handle.providerDegradation);
        if (!deviationOnly && handle.collection && ['TASK_COMPLETE','STAGE_COMPLETE'].includes(prepared.classification.stopClassification)) {
          const objects = Object.values(prepared.population.metrics).flat();
          const saved = new Set(handle.result.metricObjectJudgements.filter(row => row.judgement !== 'CHECKER_ERROR').map(row => row.objectId));
          collections.push({ ...handle.collection, totalItems: objects.length, completedItems: saved.size,
            totalObjects: objects.length, reviewedObjects: saved.size,
            items: objects.map(object => ({ objectId: object.objectId, status: saved.has(object.objectId) ? 'COMPLETED' : 'UNVERIFIED',
              ...(handle.artifacts ? { path: path.join(handle.artifacts, 'items', `${sha256(object.objectId)}.json`) } : {}) })) });
        }
        await retainFindings(handle, Object.values(prepared.fullPopulation.metrics).flat());
        if (prepared.deterministicReview) await retainFindings({ result: { findings: prepared.deterministicReview.findings },
          reviewEvidence: prepared.deterministicReview.reviewEvidence }, [], { deterministic: true });
        if (deviationOnly && handle.collection) collections.push(handle.collection);
        if (!deviationOnly && !['TASK_COMPLETE','STAGE_COMPLETE'].includes(prepared.classification.stopClassification))
          collections.push({ ...handle.collection, complete: handle.collection?.complete !== false, mode: 'findings-only', failures: handle.collection?.failures ?? [],
            totalItems: 1, completedItems: handle.collection?.complete === false ? 0 : 1, totalObjects: 0, reviewedObjects: 0, items: [] });
        const reported = deviationOnly ? new Set(metricResult.metricObjectJudgements.filter(row => row.judgement === 'DEVIATION')
          .map(row => row.objectId)) : null;
        return { scopeId: `${path.resolve(projectRoot)}:${taskId}`, items: objects.filter(object => !reported || reported.has(object.objectId)).map(object => ({
          objectId: object.objectId, metricId: object.metricId, revisionId: object.sourceRevisionId,
          ...(verificationOnly||prepared.recheckObjectIds?.includes(object.objectId) ? { recheckRequestId: verificationId??stopId } : {}),
          basis: { object, claims: reviewScopeClaims(prepared.groundTruth, { sourceIds: [object.sourceId] }),
            ...(deviationOnly ? { deviationOnly } : {}),
            ...(originalRequirements ? { originalRequirementsBasis: true } : {}),
            ...(object.applicabilityKind === 'CONDITIONAL' ? { conditionalReviewPolicy: CONDITIONAL_REVIEW_POLICY_VERSION } : {}) }, dependencies: [],
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
            const originalRow = handle.result.metricObjectJudgements.find(row => row.objectId === item.objectId);
            const conditionContext = await checkedConditionContext(handle, item.basis.object, originalRow);
            const checkedRow = validateReviewJudgement({ row: { ...result,
              ...(originalRow?.conditionAssessment ? { conditionAssessment: originalRow.conditionAssessment } : {}) },
              object: item.basis.object, citations, role:handle.rowRoles?.[item.objectId]??'stop-reviewer', classification: prepared.classification,
              conditionContext });
            if (item.metricId === "M16" && result.judgement === "PASS") validateProductionTrace(result.productionTrace,
              handle.proofs?.[item.objectId]?.sourceCiteIds ?? result.evidence);
            return { result, ...(originalRow?.conditionAssessment ? { conditionAssessment: originalRow.conditionAssessment } : {}),
              ...(checkedRow.conditionBinding ? { conditionBinding: checkedRow.conditionBinding } : {}),
              reviewer:handle.rowRoles?.[item.objectId]??'stop-reviewer',sourceCitations: citations, reviewEvidence: handle.reviewEvidence,
              ...(reviewProofOwners(item.basis.object).includes("PROCESS") ? { processDigest: snapshot.digest } : {}),
              snapshotKey: sha256({ basis: item.basis, citations: citations.map(c => [c.path, c.contentHash, c.start, c.end]),
                dependencies:handle.reviewEvidence?.fingerprints??null,
                process: reviewProofOwners(item.basis.object).includes("PROCESS") ? snapshot.digest : null }) };
          } });
        return reviewStore;
      },
      // These groups settle independent receipts; they never launch a model.
      reviewGroup: async ({ brief, submit }) => {
        const objects = brief.items.map(item => item.basis.object);
        const original = prepared.unifiedReview;
        const result = structuredClone(restrictStopReviewOutput({ ...original.result,
          metricObjectJudgements: original.result.metricObjectJudgements.filter(row => objects.some(object => object.objectId === row.objectId)),
          findings: [], fileAssessments: [] }, prepared.population));
        for (const object of objects) if (!result.metricObjectJudgements.some(row => row.objectId === object.objectId)) {
          checkerIssues.push({ type: 'MISSING_OBJECT', objectId: object.objectId, message: 'The reviewer omitted an assigned original object.' });
          result.metricObjectJudgements.push({ objectId: object.objectId, judgement: 'UNVERIFIED', reason: 'The reviewer omitted an assigned original object.', evidence: [] });
        }
        const citations = original.sourceCitations ?? [];
        const handle = { ...original, result, sourceCitations: citations };
        const receipts = [];
        for (const row of result.metricObjectJudgements) {
          const item = brief.items.find(item => item.objectId === row.objectId);
          if (!item) throw new Error('A group submitted an unassigned object.');
          pending.set(`${brief.groupId}:${row.objectId}`, handle);
          const proof = handle.proofs?.[row.objectId];
          receipts.push(await submit({ objectId: row.objectId, revisionId: item.revisionId,
            result: { judgement: row.judgement === 'CHECKER_ERROR' ? 'UNVERIFIED' : row.judgement,
              reason: row.reason, evidence: row.evidence,
              ...(row.productionTrace || proof?.productionTrace ? { productionTrace: row.productionTrace ?? proof.productionTrace } : {}) } }));
        }
        const componentPath = path.join(taskDirectory(projectRoot,taskId), 'review-components',evaluationId,`${brief.groupId}.json`);
        await atomicWriteJson(componentPath, { groupId: brief.groupId, status: 'COMPLETED', result,
          sourceCitations: citations, proofs: handle.proofs, artifacts: handle.artifacts });
        groupRecords.push({ groupId: brief.groupId, objectIds: objects.map(value => value.objectId), path: componentPath, status: 'COMPLETED' });
        return receipts.length === 1 ? receipts[0] : receipts;
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
        scanCompleted = !incomplete && !checkerIssues.length && !summary.failures?.length && summary.reasonCode === 'COMPLETED';
        if (deviationOnly) {
          if ((await Promise.all(qualityProofs.map(evidenceCurrent))).some(value => !value))
            return { ...summary, deviations: [], complete: false, status: 'UNVERIFIED', reasonCode: 'REVIEW_COLLECTION_STALE' };
          const deviations = [...summary.deviations, ...supplemental];
          const files = qualityResult?.files ?? [];
          const complete = scanCompleted && summary.items.every(item => item.receiptId && item.result.judgement === 'DEVIATION');
          const foundDeviation = deviations.length > 0 || findings.length > 0 || files.length > 0;
          const failures = [...summary.failures, ...collections.flatMap(value => value.failures ?? [])];
          // A scan over an empty scope proves nothing about the delivered work.
          if (complete && !foundDeviation && !scopeCounts?.selectedObjectCount && !scopeCounts?.fileTargetCount) return { ...summary, deviations,
            fileAssessments: files, complete: false, status: 'UNVERIFIED', failures,
            progress: { ...summary.progress, reasonCode: 'STOP_NO_REVIEW_SCOPE', scopeReasonCode: prepared.population.scopeSelection?.reasonCode ?? null } };
          const status = complete ? (foundDeviation ? 'DEVIATION' : 'NO_DEVIATION_FOUND') : 'UNVERIFIED';
          return { ...summary, deviations, fileAssessments: files, complete, status, failures };
        }
        summary={...summary,deviations:[...summary.deviations,...supplemental],complete:(intermediate?collections.every(value=>value.complete):summary.complete)&&!incomplete,
          status:incomplete?'UNVERIFIED':summary.deviations.length||supplemental.length?'DEVIATION':intermediate?'UNVERIFIED':summary.status,
          failures:[...(summary.failures??[]),...collections.flatMap(value=>value.failures??[])]};
        if(checkerIssues.length)summary={...summary,status:'UNVERIFIED',complete:false};
        if(intermediate)return { ...summary, progress: { ...summary.progress, reasonCode: 'FINDINGS_ONLY_SCOPE' } };
        if (!summary.items.length && !runtimeV2.stopCorrection.fileQualityReviewEnabled) return {
          ...summary, status: 'UNVERIFIED', complete: false,
          progress: { ...summary.progress, reasonCode: prepared.population.scopeSelection?.reasonCode ?? 'NO_APPLICABLE_METRIC_OBJECTS' },
        };
        if (!runtimeV2.stopCorrection.fileQualityReviewEnabled) return summary;
        let {files,complete}=qualityResult ?? { files: [], complete: false };
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
  const expectedFiles = deviationOnly ? qualityProofs.flatMap(handle => handle.reviewEvidence?.expectedFiles ?? [])
    : savedItems.flatMap(item => item.current.reviewEvidence?.expectedFiles ?? []);
  const evidence = { ...hostEvidence, expectedFiles, files: Object.keys(fingerprints), fingerprints, unstable,
    missing: Object.entries(fingerprints).filter(([, hash]) => hash === "missing").map(([file]) => file) };
  const rows = (core.summary?.items ?? []).filter(item => !deviationOnly || item.receiptId && item.result.judgement === 'DEVIATION').map(item => {
    const saved = savedItems.find(saved => saved.current.receiptId === item.receiptId)?.current;
    return { objectId: item.objectId, ...item.result,
      ...(saved?.conditionAssessment ? { conditionAssessment: saved.conditionAssessment } : {}),
      reviewer: saved?.reviewer ?? 'stop-reviewer' };
  });
  const disabledPopulation=status==='DISABLED'?await buildMetricPopulation({projectRoot,taskId,groundTruth:await loadCurrentGroundTruth(projectRoot,taskId),reviewPolicy:runtimeV2.stopCorrection}):null;
  let reportPopulation = prepared?.population ?? disabledPopulation;
  if (deviationOnly && prepared) {
    const reported = new Set(rows.map(row => row.objectId));
    reportPopulation = { ...reportPopulation, metrics: Object.fromEntries(Object.entries(reportPopulation.metrics)
      .map(([metricId, objects]) => [metricId, objects.filter(object => reported.has(object.objectId))])) };
  }
  const report = disabledPopulation||prepared&&(deviationOnly||['TASK_COMPLETE','STAGE_COMPLETE'].includes(prepared.classification.stopClassification)) ? calculateMetricReport({ population: reportPopulation, judgements: rows }) : null;
  if (report && deviationOnly && prepared) for (const metric of report.metrics) if (metric.objects.length)
    Object.assign(metric, { status: 'DEVIATION', numerator: 0, denominator: 0, value: null });
  if (report) report.status = status;
  if(report&&checkerIssues.length){report.checkerIssues.push(...checkerIssues);report.status='CHECKER_ERROR';}
  const admission = core.admission;
  const collectionComplete=(core.summary?.metricsComplete??core.summary?.complete)===true;
  const collection={complete:collectionComplete,status:collectionComplete?'COMPLETED':'UNVERIFIED',mode:deviationOnly?'deviation-only':prepared&&!['TASK_COMPLETE','STAGE_COMPLETE'].includes(prepared.classification.stopClassification)?'findings-only':'metrics',
    basis:{populationDigest:prepared?.population.digest,groundTruthDigest:prepared?.groundTruth.digest},totalObjects:deviationOnly&&prepared
      ? Object.values(prepared.population.metrics).flat().length : core.summary?.items?.length??collections.reduce((sum,value)=>sum+value.totalObjects,0),
    reviewedObjects:core.summary?.progress?.completed??(deviationOnly?0:collections.reduce((sum,value)=>sum+value.reviewedObjects,0)),
    totalItems:collections.length&&!deviationOnly?collections.reduce((sum,value)=>sum+value.totalItems,0):core.summary?.progress?.groups??0,
    completedItems:collections.length&&!deviationOnly?collections.reduce((sum,value)=>sum+value.completedItems,0):groupRecords.length,
    items:collections.length&&!deviationOnly?collections.flatMap(value=>value.items??[]):groupRecords,failures:[...(core.summary?.failures??[]),...collections.flatMap(value=>value.failures??[])]};
  collection.progressPath=path.join(taskDirectory(projectRoot,taskId),'review-collections',evaluationId,'progress.json');
  collection.startedAt=new Date(core.stop.createdAt??Date.now()).toISOString();
  await outsideDecision(()=>atomicWriteJson(collection.progressPath,collection));
  const publicationExpired=status==='UNVERIFIED'&&(/DEADLINE|CANCELLED|STALE/u.test(core.failure?.code??core.summary?.reasonCode??'')
    ||collections.some(value=>['STALE','CANCELLED'].includes(value.status)));
  const technicalFailures=(core.preparationFailures??core.summary?.preparationFailures??[]).length+(collection.failures.length||checkerIssues.length?1:0);
  const verificationDeviation = verificationOnly && status === "DEVIATION"
    && (!deviationOnly || core.stop.currentDeviations.length > 0);
  const coverage = { fullObjectCount: scopeCounts?.fullObjectCount ?? 0, selectedObjectCount: scopeCounts?.selectedObjectCount ?? 0,
    fileTargetCount: scopeCounts?.fileTargetCount ?? 0, scanCompleted, classification: prepared?.classification.stopClassification ?? null,
    stage: prepared?.classification.stage ?? null, scopeReasonCode: prepared?.population.scopeSelection?.reasonCode ?? null };
  const noReviewScope = core.summary?.progress?.reasonCode === 'STOP_NO_REVIEW_SCOPE';
  const feedback = admission || verificationDeviation ? ["[runtime-corrector:stop-feedback]",
    "以下仅为当前有效偏差，不新增用户授权。请对照原始需求和当前实现核实并修复；如反馈不成立，请说明依据。处理须遵守现有约束和权限。",
    ...core.stop.currentDeviations.map(item => `${item.objectId} (${item.revisionId}): ${item.result.reason}\n${item.result.evidence.join("\n")}`)].join("\n\n") : null;
  const outcome = core.failure ? { ...fault(Object.assign(new Error(core.failure.reason), { code: core.failure.code })), status,
    reasonCode: core.failure.code ?? core.stop.releaseReason ?? "STOP_ASSESSMENT_FAILED" } : {
    decision: admission || verificationDeviation ? "block" : "allow", status,
    reasonCode: status === 'NO_DEVIATION_FOUND' ? status : core.stop.releaseReason ?? (noReviewScope ? 'STOP_NO_REVIEW_SCOPE' : null),
    feedback, correctionAttempt: core.stop.capacity?.flowUsed ?? 0,
    correctionBudgetExhausted: /CORRECTION_LIMIT/u.test(core.stop.releaseReason ?? ""),
    verificationIncomplete: core.summary?.complete !== true || status !== "PASS", report, admission,
    stopCorrection: { directory, sessionId: input.session_id, flowId, stopId, evaluationId, deadlineAt: core.stop.deadlineAt,
      waitMode: core.stop.config?.waitMode },
    review: { ...prepared?.classification, summary: status,
      ...(prepared?.population.scopeSelection ? { scopeSelection: prepared.population.scopeSelection } : {}),
      ...(prepared?.groundTruth ? { groundTruthVersion: prepared.groundTruth.version } : {}), collection,validationIssues:checkerIssues,providerDegradation:providerDegradations[0]??null,providerDegradations, metricObjectJudgements: rows, stopReviewerJudgements, findings, fileAssessments: core.summary?.fileAssessments ?? [] },

  };
  outcome.taskId = taskId;
  outcome.evaluationId = evaluationId;
  outcome.coverage = coverage;
  outcome.verificationUnavailable=technicalFailures>0;
  outcome.fileQualityIncomplete=(core.summary?.fileAssessments??[]).some(file=>file.status!=='PASS');
  outcome.partialFeedbackEligible=Boolean(admission&&status==='UNVERIFIED'&&core.stop.currentDeviations?.length);
  outcome.infrastructureAttempt=core.infrastructureAttempts??core.summary?.infrastructureAttempts??(technicalFailures?1:0);
  if (status === 'UNVERIFIED' && core.summary?.complete === true && savedItems.some(item =>
    item.current.conditionBinding?.activation === 'PENDING_REQUIRED_TRIGGER')) outcome.reasonCode = 'REVIEW_CONDITION_PENDING_REQUIRED_TRIGGER';
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
  if (!outcome.feedback && outcome.verificationIncomplete && status === "UNVERIFIED") {
    const state = noReviewScope ? `本次 Stop 没有可审查的对象（${coverage.scopeReasonCode ?? '未选定范围'}），未执行偏差扫描`
      : core.summary?.complete === true ? outcome.reasonCode === 'REVIEW_CONDITION_PENDING_REQUIRED_TRIGGER'
      ? '审查已完成，必需条件仍待触发' : '审查已完成，仍有义务未获验证' : '终审未完成';
    outcome.feedback = `[runtime-corrector:status] UNVERIFIED：${state}（${outcome.reasonCode ?? "STOP_REVIEW_INCOMPLETE"}）。${outcome.error?String(outcome.error).slice(0,1200):''}本次放行不代表验收通过；未验证状态不自动派发业务修复。${(core.summary?.fileAssessments??[]).filter(file=>file.status!=='PASS').map(file=>`${file.path} [${file.status}]: ${file.reason}`).join('; ').slice(0,1024)} 详情：${evaluationPath}`;
  }
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
    if (!deviationOnly) {
      const bySource=new Map();for(const object of report.metrics.flatMap(metric=>metric.objects??[])){
        const list=bySource.get(object.sourceId)??[];list.push(object);bySource.set(object.sourceId,list);
      }
      await markMetricPassesFixed({projectRoot,taskId,passedObjectIds:[...bySource].filter(([,objects])=>objects.every(object=>['PASS','NOT_APPLICABLE'].includes(object.judgement))).map(([id])=>id)});
    }
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
  const currentTask = await findTask({ projectRoot, sessionId: input.session_id, explicitTaskId: taskId });
  await atomicWriteJson(evaluationPath, { evaluationId, reviewPolicyVersion, reviewBasisBinding: currentTask ? await reviewBasisBinding(currentTask) : null,
    core, outcome, coverage, metricReport: publicationExpired?null:report,...(publicationExpired?{historicalMetricReport:report}:{}),
    review: outcome.review,implementationReview:outcome.implementationReview, sourceCitations, evidence });
  await withTaskState({ projectRoot, taskId }, state => {
    const previousVerification=state.verification?{status:state.verification.status,evaluationId:state.verification.evaluationId,assessmentId:state.verification.assessmentId,reasonCode:state.verification.reasonCode}:null;
    state.stop.lastAssessmentId = evaluationId;
    if(processRetry)state.stop.processRetry=processRetry;else delete state.stop.processRetry;
    state.stop.correctionAttempts = core.stop.capacity?.flowUsed ?? state.stop.correctionAttempts;
    state.stop.correctionProtocol = "workspace-v1";
    state.stop.infrastructureTotalFailures=(state.stop.infrastructureTotalFailures??0)+technicalFailures;
    state.stop.infrastructureFailures=technicalFailures?(state.stop.infrastructureFailures??0)+1:core.summary?0:state.stop.infrastructureFailures??0;
    state.verification = { status, evaluationId, reasonCode: outcome.reasonCode, coverage, updatedAt: new Date().toISOString(),
      ...(!core.summary&&previousVerification?{previousVerification}:{}),
      assessmentId: assessmentContext?.assessmentId ?? evaluationId,
      rulesDigest: assessmentContext?.rulesDigest ?? sha256(runtimeV2), evidence,
      ...(originalRequirements ? { requirementVersion: state.groundTruth.version, requirementDigest: state.groundTruth.digest,
        originalRequirementsDigest: originalRequirements.digest } : { requirementVersion: prepared?.groundTruth.version ?? state.groundTruth.version,
        requirementDigest: prepared?.groundTruth.digest ?? state.groundTruth.digest }),
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
