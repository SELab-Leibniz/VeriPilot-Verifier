import { promises as fs } from "node:fs";
import path from "node:path";
import { assessStopCorrection } from "./stop-correction-assessment.mjs";
import { createStopCorrectionStore } from "./stop-correction-store.mjs";
import { createStopReviewStore } from "./stop-review-store.mjs";
import { reviewScopeClaims } from "./review-scope.mjs";
import { reviewProofOwners, validateReviewJudgement, validateReviewFile } from "./review-result-validation.mjs";
import { validateProductionTrace } from "../review-task/production-trace.mjs";
import { calculateMetricReport } from "./metrics.mjs";
import { appendTaskJournal, taskDirectory, withTaskState, decisionGuard } from "./task-store.mjs";
import { decisionScope } from "./decision-scope.mjs";
import { atomicWriteJson, readJson, sha256 } from "./utils.mjs";
import { STOP_REVIEW_SCHEMA } from "./reviewer.mjs";
import { fingerprint } from "./evidence-state.mjs";
import { beforeStopDeadline } from "./stop-deadline.mjs";
import { hasStopReviews } from "./metric-policy.mjs";
import { loadCurrentGroundTruth } from "./ground-truth-ledger.mjs";

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
  snapshot, prepare, isCurrent = async () => true, verificationOnly = false, verificationId }) {
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
        return { scopeId: `${path.resolve(projectRoot)}:${taskId}`, items: Object.values(prepared.population.metrics).flat().map(object => ({
          objectId: object.objectId, metricId: object.metricId, revisionId: object.sourceRevisionId,
          ...(verificationOnly ? { recheckRequestId: verificationId } : {}),
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
            validateReviewJudgement({ row: result, object: item.basis.object, citations, classification: prepared.classification });
            if (item.metricId === "M16" && result.judgement === "PASS") validateProductionTrace(result.productionTrace,
              handle.proofs?.[item.objectId]?.sourceCiteIds ?? result.evidence);
            return { result, sourceCitations: citations, reviewEvidence: handle.reviewEvidence,
              ...(reviewProofOwners(item.basis.object).includes("PROCESS") ? { processDigest: snapshot.digest } : {}),
              snapshotKey: sha256({ basis: item.basis, citations: citations.map(c => [c.path, c.contentHash, c.start, c.end]),
                process: reviewProofOwners(item.basis.object).includes("PROCESS") ? snapshot.digest : null }) };
          } });
        return reviewStore;
      },
      reviewGroup: async ({ brief, submit, signal }) => {
        const objects = brief.items.map(item => item.basis.object);
        const accept = async handle => {
          const receipts = [];
          for (const row of handle.result.metricObjectJudgements ?? []) {
            const item = brief.items.find(item => item.objectId === row.objectId);
            if (!item) throw new Error("A group submitted an unassigned object.");
            pending.set(`${brief.groupId}:${row.objectId}`, handle);
            const proof = handle.proofs?.[row.objectId];
            receipts.push(await submit({ objectId: row.objectId, revisionId: item.revisionId, result: { judgement: row.judgement, reason: row.reason,
              evidence: row.evidence, ...(row.productionTrace || proof?.productionTrace ? { productionTrace: row.productionTrace ?? proof.productionTrace } : {}) } }));
          }
          return receipts.length === 1 ? receipts[0] : receipts;
        };
        const handle = await reviewerFactory({ projectRoot, taskId, parentSessionId: input.session_id, role: "stop-reviewer",
          reviewer: runtimeV2.reviewers.stopReviewer, schema: STOP_REVIEW_SCHEMA, deadlineAt: brief.deadlineAt, abortSignal: signal,
          onItemResult: accept,
          request: { ...prepared.request, population: { ...prepared.population, metrics: { [brief.metricId]: objects } },
            reviewGroupId: brief.groupId, fixedStopClassification: prepared.classification,
            reviewScope: { kind: "stop-group", boundedBasis: true, objectIds: objects.map(object => object.objectId), sourceIds: objects.map(object => object.sourceId) } },
          evidence: { snapshot, groundTruth: prepared.groundTruth } });
        try { if (!reviewerFactory.supportsStopGroups) {
          const sourceCitations = typeof handle.getSourceCitations === "function" ? await handle.getSourceCitations(handle.result) : handle.sourceCitations;
          await accept({ ...handle, sourceCitations });
        } } finally { void handle.close?.(); }
      },
      feedbackBasisCurrent: async deviations => {
        const state = await reviewStore.inspect();
        const valid = [];
        for (const deviation of deviations) {
          const item = state.items[`${deviation.metricId}:${deviation.objectId}`];
          if (item?.definition.basis.object.hard === true && item.current?.receiptId === deviation.receiptId
            && item.current.valid !== false && await evidenceCurrent(item.current)) valid.push(deviation);
        }
        return valid;
      },
      finalizeSummary: async (summary, window) => {
        if (!runtimeV2.stopCorrection.fileQualityReviewEnabled) return summary;
        const targets = (prepared.request.artifactCandidates ?? []).flatMap(binding => (binding.files ?? [])
          .map(file => ({ path: file.path, sha256: file.sha256, artifactId: binding.artifactId })));
        const files = [];
        for (const target of targets) {
          try {
            const handle = await beforeStopDeadline(() => reviewerFactory({ projectRoot, taskId, parentSessionId: input.session_id,
              role: "stop-reviewer", reviewer: runtimeV2.reviewers.stopReviewer, schema: STOP_REVIEW_SCHEMA,
              deadlineAt: window.reviewDeadlineAt, abortSignal: window.signal, evidence: { snapshot, groundTruth: prepared.groundTruth },
              request: { ...prepared.request, population: { ...prepared.population, metrics: {} }, fixedStopClassification: prepared.classification,
                reviewScope: { kind: "file-quality", objectIds: [], sourceIds: [], qualityTarget: target } } }),
            { deadlineAt: window.reviewDeadlineAt, signal: window.signal, code: "STOP_REVIEW_DEADLINE" });
            try {
              const file = handle.result.fileAssessments?.find(file => file.path === target.path);
              if (!file || !await evidenceCurrent(handle)) throw new Error("File quality proof is missing or stale.");
              validateReviewFile({ file, citations: (handle.sourceCitations ?? []).filter(citation => citation.usedBy?.includes(target.path)) });
              files.push(file);
            } finally { void handle.close?.(); }
          } catch (cause) { files.push({ path: target.path, status: "UNVERIFIED", reason: cause.message, evidence: [] }); }
        }
        const complete = targets.length > 0 && files.every(file => file.status === "PASS");
        const metricsComplete = summary.items.length === 0 || summary.complete;
        return { ...summary, fileAssessments: files, complete: metricsComplete && complete,
          status: summary.deviations.length ? "DEVIATION" : metricsComplete && complete ? "PASS" : "UNVERIFIED" };
      } });
    }
  } catch (cause) { core = { failure: { code: cause.code, reason: cause.message }, stop: { reviewStatus: "UNVERIFIED", control: "ALLOW" } }; }
  const status = core.stop.reviewStatus;
  // Preserve the host's freshness/decision binding, including reused item
  // proofs. The SDK's private reads need not traverse native tool middleware.
  const savedItems = reviewStore ? Object.values((await reviewStore.inspect()).items)
    .filter(item => core.summary?.items.some(row => row.receiptId && row.receiptId === item.current?.receiptId)) : [];
  const sourceCitations = savedItems.flatMap(item => item.current.sourceCitations ?? []);
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
  const evidence = { ...hostEvidence, files: Object.keys(fingerprints), fingerprints, unstable,
    missing: Object.entries(fingerprints).filter(([, hash]) => hash === "missing").map(([file]) => file) };
  const rows = (core.summary?.items ?? []).map(item => ({ objectId: item.objectId, ...item.result }));
  const report = prepared ? calculateMetricReport({ population: prepared.population, judgements: rows }) : null;
  if (report) report.status = status;
  const admission = core.admission;
  const feedback = admission || verificationOnly && status === "DEVIATION" ? ["[runtime-corrector:stop-feedback]",
    "以下仅为当前有效偏差，不新增用户授权。依据原始要求、现有约束和权限处理。",
    ...core.stop.currentDeviations.map(item => `${item.objectId} (${item.revisionId}): ${item.result.reason}\n${item.result.evidence.join("\n")}`)].join("\n\n") : null;
  const outcome = core.failure ? { ...fault(Object.assign(new Error(core.failure.reason), { code: core.failure.code })), status,
    reasonCode: core.stop.releaseReason ?? core.failure.code } : {
    decision: admission || verificationOnly && status === "DEVIATION" ? "block" : "allow", status, reasonCode: core.stop.releaseReason ?? null,
    feedback, correctionAttempt: core.stop.capacity?.flowUsed ?? 0,
    correctionBudgetExhausted: /CORRECTION_LIMIT/u.test(core.stop.releaseReason ?? ""),
    verificationIncomplete: core.summary?.complete !== true || status !== "PASS", report, admission,
    stopCorrection: { directory, sessionId: input.session_id, flowId, stopId, evaluationId, deadlineAt: core.stop.deadlineAt,
      waitMode: core.stop.config?.waitMode },
    review: { ...prepared?.classification, summary: status, metricObjectJudgements: rows, findings: [], fileAssessments: core.summary?.fileAssessments ?? [] },
  };
  outcome.taskId = taskId;
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
  if (!outcome.feedback && capacityNotice) outcome.feedback = `[runtime-corrector:status] ${capacityNotice}保留历史未解决事项，本次不生成验收通过。详情：${evaluationPath}`;
  await atomicWriteJson(evaluationPath, { evaluationId, core, outcome, metricReport: report,
    review: outcome.review, sourceCitations, evidence });
  await withTaskState({ projectRoot, taskId }, state => {
    state.stop.lastAssessmentId = evaluationId;
    state.stop.correctionAttempts = core.stop.capacity?.flowUsed ?? state.stop.correctionAttempts;
    state.stop.correctionProtocol = "grouped-v1";
    state.verification = { status, evaluationId, reasonCode: outcome.reasonCode, updatedAt: new Date().toISOString(),
      assessmentId: assessmentContext?.assessmentId ?? evaluationId,
      rulesDigest: assessmentContext?.rulesDigest ?? sha256(runtimeV2), evidence,
      requirementVersion: prepared?.groundTruth.version ?? state.groundTruth.version,
      requirementDigest: prepared?.groundTruth.digest ?? state.groundTruth.digest,
      generation: decisionGuard(state).generation, cancelEpoch: decisionGuard(state).cancelEpoch };
    if (core.stop.control === "ALLOW") state.status = status === "PASS"
      ? prepared?.classification.stopClassification === "STAGE_COMPLETE" ? "ACTIVE" : "COMPLETED" : "COMPLETED_WITH_ISSUES";
  });
  await appendTaskJournal(projectRoot, taskId, { type: "STOP_CORRECTION_SETTLED", evaluationId, status,
    reasonCode: outcome.reasonCode, sessionId: input.session_id, flowId, stopId, admissionId: admission?.id ?? null });
  return outcome;
}
