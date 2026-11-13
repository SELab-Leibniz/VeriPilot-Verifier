import { selectStopPopulation, eligibleStopStages } from './review-routing.mjs';
import { recordRuntimeResponse, recordObservation } from './response-record.mjs';
import { decisionScope, scopedDecision, outsideDecision, createDecisionAttempt, stageAppend } from "./decision-scope.mjs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { hasLinkedPath, isSameFile } from '../path-utils.mjs';
import { validateJsonSchema } from "../json-schema-validator.mjs";

import { loadCurrentGroundTruth, applyGroundTruthDelta, planGroundTruthDelta, persistSkillGroundTruth } from "./ground-truth-ledger.mjs";
import { BASELINE_COVERAGE_SCHEMA, coveredImplementationClaims } from './baseline-coverage-audit.mjs';
import { dismissInformationalFamilies, familyIdForFinding, loopBoundedFamilyIds, markMetricPassesFixed, recordDeviationFindings, ROOT_CAUSE_IDS } from "./deviations.mjs";
import { eventId } from "./event-identity.mjs";
import { runDeterministicImplementationChecks } from "./impl-review.mjs";
import { loadPlatformAdapter } from "./platform-adapter.mjs";
import { implementationPopulation, VERIFICATION_ROUTING_INSTRUCTIONS } from "./review-routing.mjs";
import { groundTruthSourceCatalog, groundTruthAdmissionFailure, SOURCE_INSTRUCTIONS, pendingUserSourceRefs } from "./ground-truth-provenance.mjs";
import { cleanupExpiredInternalRuns, inspectInternalRun } from "./internal-run.mjs";
import { buildMetricPopulation, calculateMetricReport, isSourceOnlyDelivery } from "./metrics.mjs";
import { runStopRegressionCheck, confirmCollateralRegressionFailures } from "./regression-evidence.mjs";
import { validateStructuredReviewEvidence } from './review-evidence-validation.mjs';
import { validateProductionTrace } from '../review-task/production-trace.mjs';
import { resolveStopReviewPolicy, enabledStopMetricIds, hasStopReviews } from "./metric-policy.mjs";
import { collectArtifactCandidates } from "./artifact-candidates.mjs";
import { materialManifest, maybeRunTaskOnboarding } from "./onboarding.mjs";
import { archivesUserMessages, buildOriginalRequirements, recordUserMessages } from "./original-requirements.mjs";
import { sharedOriginalBasis, sharedBasisMatches, guardSharedBasis } from './baseline-shared-basis.mjs';
import { runAutomaticBaselineRefresh } from './baseline-refresh-attempt.mjs';
import { OUTPUT_TREE_DIRECTORY } from "./paths.mjs";
import { PROCESS_REVIEW_INSTRUCTIONS } from "./process-checks.mjs";

import { prepareHostFeedback } from "./feedback-delivery.mjs";
import { runProductionStop, stopSessionDirectory, invalidateCurrentStopVerification, loadStopOriginalRequirements, recordDocumentOnlyStop } from "./production-stop.mjs";
import { captureTaskStart, documentOnlyChanges, taskChanges } from "./task-changes.mjs";
import { appendFrameReproduction, frameReproduction, readStopFrame, requirementFrameEnabled } from "./requirement-frame.mjs";
import { createStopCorrectionStore } from "./stop-correction-store.mjs";
import { deviceVerification, runCommand as runDeviceCommand } from "./device-verify.mjs";
import { beforeStopDeadline } from "./stop-deadline.mjs";
import { GROUND_TRUTH_REVIEW_SCHEMA, SKILL_GROUND_TRUTH_REVIEW_SCHEMA, SKILL_REVIEW_SCHEMA, STOP_REVIEW_SCHEMA, handoffRoleReviewer, startRoleReviewer, resolveReviewerSession } from "./reviewer.mjs";
import { resolveSkillDirectory, scanSkillDirectory, selectedSkill, skillIdFromInput, retainedSkillSourceIdentity,
  bindSkillGraph, bindSkillGraphFromQuotes, skillSourceUnits, SKILL_SOURCE_CONTRACT_VERSION, SKILL_SOURCE_QUOTE_INTERPRETATION_SCHEMA,
  skillConditionalTargets, skillConditionKey } from "./skill-source.mjs";
import { CONDITIONAL_REVIEW_POLICY_VERSION, CONDITIONAL_REVIEW_INSTRUCTIONS, validateConditionalAssessment,
  requiresConditionWindow, bindConditionProcessWindow, captureConditionSnapshot, conditionWindowCurrent } from '../review-task/task-evidence.mjs';
import { handleRuntimeV2SessionEnd } from "./session-end.mjs";
import {
  appendTaskJournal,
  ensureTask,
  findTask,
  startCorrectionEpoch,
  taskDirectory,
  taskStatePath,
  withTaskResourceLock,
  withTaskState,
  withTaskDecision,
  decisionGuard,
} from "./task-store.mjs";
import {
  latestAssistantText,
  readTranscriptSnapshot,
  reconcileTurnState,
  unresolvedSiblingToolUseIds,
  processToolEvidence,
} from "./transcript.mjs";
import {
  atomicWriteJson,
  cleanupStaleAtomicWrites,
  readJson,
  safeId,
  sha256,
  uniqueId,
} from "./utils.mjs";


const TURN_RECONCILE_EVENTS = new Set([
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "PreCompact",
]);
const SKILL_CHECK_EVENTS = new Set(["UserPromptSubmit", "PostToolUse", "Stop"]);
const WATCHER_RECONCILE_LOCK_TIMEOUT_MS = 1_250_000;
const CORRECTION_BARRIER_TOOLS = new Set([
  "Skill",
  "Bash",
  "PowerShell",
  "Write",
  "Edit",
  "NotebookEdit",
  "Monitor",
]);
const INCOMPLETE_CLAIM_PATTERN = /(?:\b(?:not|never)\s+(?:(?:all|every)\s+(?:requirements?|tasks?)\s+(?:are|have\s+been)\s+)?(?:yet\s+|fully\s+)?(?:done|complete(?:d)?|finished|implemented|fixed|resolved|delivered|satisfied|fulfilled)\b|\b(?:haven['’]t|hasn['’]t|have\s+not|has\s+not|didn['’]t|did\s+not)\s+(?:yet\s+|fully\s+)?(?:complete(?:d)?|finish(?:ed)?|implement(?:ed)?|fix(?:ed)?|resolve(?:d)?|deliver(?:ed)?|satisf(?:y|ied))\b|\b(?:work|implementation|integration|task)\s+(?:still\s+)?remains?\b|并非(?:所有|全部)(?:要求|需求|任务|工作)(?:均|都|全部)?(?:已)?(?:满足|完成|实现|解决)|(?:尚未|还没有|没有|并未|仍未|未能|不曾)(?:全部|完全)?(?:完成|实现|修复|解决|交付|满足))/iu;
const RESIDUAL_COMPLETION_WORK_PATTERN = /\b(?:tests?|verification|validation|review|integration)\s+(?:(?:are|is)\s+)?(?:still\s+)?(?:pending|remain(?:s|ing)?)\b/iu;
const COMPLETION_CLAIM_PATTERN = /(?:(?:已|已经|现已|全部|均已|成功)(?:完成|实现|修复|修好|解决|交付|做好|做完)|(?:完成|实现|修复|修好|解决|交付|做好|做完)(?:了|完毕|并(?:验证|测试)?|[,，。！!]|$)|(?:所有|全部)(?:要求|需求|任务|工作)(?:均|都|全部)?(?:已)?(?:满足|完成|实现|解决)|开发完毕|(?:无需|无须|不需要)(?:再)?(?:做)?(?:修改|改动|变更)|\b(?:i\s+(?:(?:have|'ve)\s+)?(?:completed|finished|implemented|fixed|resolved|delivered)\b)|\b(?:all|every)\s+(?:requirements?|requested\s+changes?|tasks?|work\s+items?)\s+(?:(?:are|were)\s+|(?:have|has)\s+been\s+)?(?:satisfied|fulfilled|complete(?:d)?|implemented|addressed)\b|\bno\s+(?:further\s+)?changes?\s+(?:(?:are|were)\s+)?(?:required|needed)\b|\b(?:everything|(?:the\s+)?(?:task|stage|implementation|project|work|feature|requested\s+changes?))\s+(?:(?:(?:is|was)\s+|(?:has|have)\s+been\s+)(?:complete(?:d)?|finished|implemented|fixed|resolved|delivered)\b|(?:complete(?:d)?|finished|implemented|fixed|resolved|delivered)(?:\s+(?:and\s+)?(?:tested|verified))?(?=\s*(?:[.!]|$)))|(?:^|\n)\s*(?:done|complete(?:d)?|finished|implemented|fixed|resolved|delivered)(?:\s+(?:and\s+)?(?:tested|verified))?[.!]?\s*(?:$|\n))/imu;

function sanitizedHookInput(input) {
  return {
    hookEventName: input.hook_event_name,
    toolName: input.tool_name ?? null,
    toolInput: input.tool_name === "Skill" ? input.tool_input : null,
    prompt: input.hook_event_name === "UserPromptSubmit" ? input.prompt ?? null : null,
    lastAssistantMessage: input.hook_event_name === "Stop"
      ? input.last_assistant_message ?? null
      : null,
    stopHookActive: input.stop_hook_active ?? false,
  };
}

async function skillDocuments(projectRoot, taskId) {
  const root = path.join(taskDirectory(projectRoot, taskId), "skills");
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const documents = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const document = await readJson(path.join(root, entry.name, "skill-ground-truth.json"));
    if (document) documents.push(document);
  }
  return documents;
}

function groundTruthScope(input, skill = null, artifact = null) {
  if (skill) return `skill:${skill.skillId}:${skill.source.digest}`;
  if (artifact) return `artifact:${artifact.nodeId ?? artifact.stage ?? "unknown"}`;
  if (input.hook_event_name === "Stop") return "stop";
  if (input.hook_event_name === "UserPromptSubmit") return "user-prompt";
  return `event:${input.hook_event_name}`;
}

async function markSourceCursor(projectRoot, taskId, scope, digest) {
  await withTaskState({ projectRoot, taskId }, (state) => {
    state.groundTruth.sourceCursors[scope] = digest;
  });
}

async function sourceCursor(projectRoot, taskId, scope) {
  let cursor;
  await withTaskState({ projectRoot, taskId }, (state) => {
    cursor = state.groundTruth.sourceCursors[scope] ?? null;
  });
  return cursor;
}

async function currentSkillGroundTruth(projectRoot, taskId, skillId, source) {
  const skillDigest = source.digest;
  let document;
  try {
    document = await readJson(path.join(taskDirectory(projectRoot, taskId), "skills", safeId(skillId), "skill-ground-truth.json"));
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  if (!document || document.taskId !== taskId || document.skillId !== skillId || document.skillDigest !== skillDigest) return null;
  if (document.sourceContract?.version !== SKILL_SOURCE_CONTRACT_VERSION
    || document.sourceContract?.conditionalPolicy !== CONDITIONAL_REVIEW_POLICY_VERSION) return null;
  const owner = await readJson(taskStatePath(projectRoot, taskId));
  if (Object.values(owner?.watchers ?? {}).some(w => w.skillId === skillId && w.sourceInterpretationDispute === document.digest)) return null;
  const payload = { constraints: document.constraints, taskOverlays: document.taskOverlays };
  if (validateJsonSchema(payload, SKILL_GROUND_TRUTH_REVIEW_SCHEMA.properties.skillGroundTruth).length) return null;
  try {
    const bound = bindSkillGraph({ constraints: document.constraints.map(c => ({ constraintId: c.constraintId, sourceUnitIds: c.sourceUnitIds,
      interpretation: { ...c.sourceInterpretation, externalConditions: c.sourceInterpretation.externalConditions.map(({ condition, duty, verificationTarget }) => ({ condition, duty, verificationTarget })) } })),
      taskOverlays: [] }, source);
    if (sha256(bound.constraints) !== sha256(document.constraints) || bound.sourceContract.digest !== document.sourceContract.digest) return null;
  } catch { return null; }
  return document.digest === sha256({ skillId, skillDigest, ...payload, sourceContract: document.sourceContract }) ? document : null;
}

const readonlyFailure = message => Object.assign(new Error(message), { code: 'BASELINE_BUDGET_UNVERIFIED' });
const retryableGraphTransport = error => error?.reviewerRuntimeFailure === true && error.stopTaskFailure !== true
  && !/DEADLINE|CANCEL|STALE|DENIED|DRAINING|PERMISSION|INVALID|UNVERIFIED|BASIS|SOURCE|INPUT_CHANGED|NO_PROGRESS/u.test(error.code ?? '');
async function verifyGraphInvocations(entries, taskId) {
  if (!entries.length) throw Object.assign(new Error('Failed graph has no trusted invocation boundary'), { code: 'OWNED_SETTLEMENT_UNVERIFIED' });
  for (const entry of entries) {
    if (typeof entry.observer?.verifyClosed !== 'function') throw Object.assign(new Error('Graph invocation has no host-owned dispatch manifest'), { code: 'OWNED_SETTLEMENT_UNVERIFIED' });
    const manifest = await entry.observer.verifyClosed();
    if (manifest?.taskId !== taskId || !manifest.sessionId || !Array.isArray(manifest.runs)
      || (manifest.runs.length ? manifest.status !== 'SETTLED' : manifest.status !== 'PRE_DISPATCH_CLOSED'))
      throw Object.assign(new Error('Graph invocation has no exact closed host manifest'), { code: 'OWNED_SETTLEMENT_UNVERIFIED' });
  }
}

async function refreshGroundTruth(options) {
  if (!['PreToolUse', 'PostToolUse'].includes(options.input.hook_event_name)
    || !options.runtimeV2.dynamicGroundTruth.enabled) return refreshGroundTruthUncached(options);
  const task = await findTask({ projectRoot: options.projectRoot, sessionId: options.input.session_id,
    explicitTaskId: options.task.taskId }) ?? options.task;
  const factory = options.reviewerFactory;
  let key;
  try {
    const materials = await (factory.materialManifest ?? materialManifest)(options.runtimeV2.dynamicGroundTruth.materialRoots);
    const basis = await sharedOriginalBasis({ ...options, task, materials,
      reviewerIdentity: factory.reviewCacheIdentity?.(options.runtimeV2.reviewers.groundTruthExtractor)
        ?? options.runtimeV2.reviewers.groundTruthExtractor, readOriginalMaterial: factory.readOriginalMaterial });
    key = sha256({ protocol: 'automatic-baseline-refresh-v1', basis: basis.digest,
      baseline: [task.groundTruth.version, task.groundTruth.digest], cancelEpoch: task.control?.cancelEpoch ?? 0 });
  } catch (error) {
    return { task, current: await loadCurrentGroundTruth(options.projectRoot, task.taskId), changed: false, unverified: true, error };
  }
  const result = await runAutomaticBaselineRefresh({ projectRoot: options.projectRoot, taskId: task.taskId, key,
    actionId: eventId(options.input),
    retryOnNewAction: options.input.hook_event_name === 'PreToolUse' && options.input.tool_name === 'Skill',
    deadlineAt: factory.reviewDeadlineAt, signal: factory.reviewAbortSignal,
    run: () => refreshGroundTruthUncached({ ...options, task }) });
  if (!result?.deferred) return result;
  return { task, current: await loadCurrentGroundTruth(options.projectRoot, task.taskId), changed: false, unverified: true,
    deferred: true, error: Object.assign(new Error(`${result.reason}: requirement update remains pending; automatic retries share the same source revision budget.`),
      { code: result.reason, retryAt: result.retryAt, previousCode: result.previousCode }) };
}

async function refreshGroundTruthUncached(options) {
  options = { ...options, task: await findTask({ projectRoot: options.projectRoot, sessionId: options.input.session_id, explicitTaskId: options.task.taskId }) ?? options.task };
  const calculate = async () => {
    const parent = scopedDecision(taskStatePath(options.projectRoot, options.task.taskId));
    const attempt = createDecisionAttempt({ parent, signal: options.reviewerFactory.reviewAbortSignal,
      deadlineAt: options.reviewerFactory.reviewDeadlineAt ?? Infinity });
    const slot = options.readonlyBaselineRetry, candidate = slot?.candidate;
    if (slot) slot.candidate = null;
    let result;
    try {
      if (candidate && (candidate.parent !== parent || candidate.assessmentId !== parent.context.assessmentId
        || candidate.signal !== options.reviewerFactory.reviewAbortSignal || candidate.deadlineAt !== options.reviewerFactory.reviewDeadlineAt
        || candidate.taskId !== options.task.taskId || candidate.rootSessionId !== options.task.rootSessionId
        || candidate.hookEventId !== eventId(options.input) || candidate.guard !== sha256(decisionGuard(options.task))))
        throw readonlyFailure('Read-only baseline belongs to another assessment or owner');
      result = await decisionScope.run(attempt.scope, () => refreshGroundTruthInternal({ ...options, readonlyCandidate: candidate }));
    }
    catch (error) { result = { task: options.task, changed: false, unverified: true, error }; }
    if (!result.unverified) {
      try { attempt.accept(); }
      catch (error) { result = { ...result, changed: false, unverified: true, error }; }
    }
    if (result.unverified) {
      attempt.discard(result.error);
      result.error = attempt.reason ?? result.error;
      try { await result.handle?.close?.(); } catch { /* failed ownership never becomes an accepted candidate */ }
      if (slot && result.readonlyRetry && attempt.status === 'DISCARDED' && retryableGraphTransport(result.error)) {
        try {
          await result.readonlyRetry.handle.baselineTask.verifyCompleted();
          await verifyGraphInvocations(result.readonlyRetry.graphInvocations, options.task.taskId);
          slot.candidate = { ...result.readonlyRetry, parent, assessmentId: parent.context.assessmentId,
            signal: options.reviewerFactory.reviewAbortSignal, deadlineAt: options.reviewerFactory.reviewDeadlineAt,
            taskId: options.task.taskId, rootSessionId: options.task.rootSessionId, hookEventId: eventId(options.input),
            guard: sha256(decisionGuard(options.task)) };
        } catch (error) { result.error = error; }
      }
      // Keep actual dispatch/failure/quarantine history, not events claiming a
      // discarded formal change. Raw worker receipts remain historical files.
      const audits = new Set(['REVIEWER_ENVELOPE', 'GROUND_TRUTH_REFRESH_FAILED', 'TASK_SWITCH_SUPPRESSED',
        'GROUND_TRUTH_POST_FREEZE_OPS_DROPPED', 'BASELINE_AUDIT_UNRESOLVED', 'BASELINE_AUDIT_REPAIR_STARTED']);
      for (const event of attempt.takeEvents(event => audits.has(event.value?.type)))
        stageAppend(path.join(parent.directory, event.file), event.value);
      await appendTaskJournal(options.projectRoot, options.task.taskId, { type: 'GROUND_TRUTH_ALIGNMENT_ATTEMPT_FAILED',
        hookEventId: eventId(options.input), code: result.error?.code ?? 'EXTRACTION_FAILED', discardedApplication: result.publicationFailed === true });
      result.current = await loadCurrentGroundTruth(options.projectRoot, options.task.taskId);
    }
    return result;
  };
  if (scopedDecision(taskStatePath(options.projectRoot, options.task.taskId))) return calculate();
  let output;
  try {
    const publication = await withTaskDecision({ projectRoot: options.projectRoot, taskId: options.task.taskId,
      context: { assessmentId: uniqueId('basis-refresh'), kind: 'requirements', guard: decisionGuard(options.task),
        deadlineAt: options.reviewerFactory.reviewDeadlineAt, abortSignal: options.reviewerFactory.reviewAbortSignal } }, async () => {
      output = await calculate();
      return { handled: true, taskId: options.task.taskId, baselineVersion: output.current.version,
        ...(output.unverified ? { unverified: true } : {}) };
    });
    if (publication.stale) {
      await output?.handle?.close();
      return { task: options.task, current: await loadCurrentGroundTruth(options.projectRoot, options.task.taskId),
        changed: false, unverified: true, error: new Error(`Original alignment publication rejected: ${publication.reason}`) };
    }
    return output;
  } catch (error) {
    return { task: options.task, current: await loadCurrentGroundTruth(options.projectRoot, options.task.taskId),
      changed: false, unverified: true, error };
  }
}

const SKILL_GRAPH_SCHEMA = { type: 'object', additionalProperties: false, required: ['summary', 'skillGroundTruth'],
  properties: { summary: GROUND_TRUTH_REVIEW_SCHEMA.properties.summary,
    skillGroundTruth: { type: 'object', additionalProperties: false, required: ['constraints', 'taskOverlays'], properties: {
      constraints: { type: 'array', maxItems: 500, items: { type: 'object', additionalProperties: false,
        required: ['constraintId', 'sourceUnitIds', 'interpretation'], properties: { constraintId: { type: 'string', minLength: 1 },
          sourceUnitIds: { type: 'array', minItems: 1, maxItems: 1, items: { type: 'string' } }, label: { type: 'string', maxLength: 120 },
          interpretation: SKILL_SOURCE_QUOTE_INTERPRETATION_SCHEMA } } },
      taskOverlays: { type: 'array', maxItems: 0 },
    } } } };

const SKILL_WORKFLOW_SCOPE_INSTRUCTION = 'Distinguish later workflow edits/corrections that may reactivate a duty from function-runtime inputs or implementation branches. The same actor performing both actions does not make a workflow event internal. Justify scope against the complete original unit, headings, exceptions and context; never classify from keywords or actor identity. Preserve independent current duties with any grounded external branch. If the proposed scope is not grounded, use UNCERTAIN (and CONFLICT in semantic review); copying every word does not certify its interpretation.';
const SKILL_REVIEW_REPAIR_INSTRUCTION = 'Return one complete SKILL_REVIEW object, not a patch. Repair the indicated field using current acknowledged original evidence, and explicitly resubmit summary, completionStatus, findings, all sourceInterpretationReviews required by this graph and its conditionalAssessments, plus checkerError when needed. Earlier CONFIRMED labels are not new evidence; recheck unsupported or stale content rather than inheriting it. Keep honest CONFLICT/UNCERTAIN/UNKNOWN/checkerError; never invent PASS or a business correction.';

const graphBasisDigest = (basis, skill, current) => sha256({ basis: basis.digest, skill: skill.source.digest,
  baselineVersion: current.version, baselineDigest: current.digest,
  sourceContract: SKILL_SOURCE_CONTRACT_VERSION, conditionalPolicy: CONDITIONAL_REVIEW_POLICY_VERSION });

async function localSkillGraph({ projectRoot, sessionCwd, task, skill, basis, current, input, snapshot, runtimeV2, reviewerFactory, materials, graphInvocations = null }) {
  if (!skill) return null;
  const scope = groundTruthScope(input, skill), digest = graphBasisDigest(basis, skill, current);
  if (await sourceCursor(projectRoot, task.taskId, scope) === digest
    && await currentSkillGroundTruth(projectRoot, task.taskId, skill.skillId, skill.source)) return null;
  const navigation = skillSourceUnits(skill.source);
  const observation = graphInvocations ? { observer: null } : null;
  if (observation) graphInvocations.push(observation);
  const handle = await reviewerFactory({ projectRoot, sessionCwd, taskId: task.taskId, parentSessionId: input.session_id,
    ...(observation ? { onOwnedInvocation(observer) {
      if (observation.observer || typeof observer?.verifyClosed !== 'function') throw readonlyFailure('Graph host supplied an invalid invocation capability');
      observation.observer = observer;
    } } : {}),
    role: 'ground-truth-extractor', reviewer: runtimeV2.reviewers.groundTruthExtractor, schema: SKILL_GRAPH_SCHEMA,
    request: { schemaVersion: 'runtime-corrector.skill-graph-request.v1', skillGraphOnly: true,
      instructions: [...SOURCE_INSTRUCTIONS,
        'Interpret every complete original sourceUnitId once, including descriptions, permissions and advice. Original identity/binding is deterministic; normativity and scope are your semantic interpretation and must be explained, never inferred from a word-prefix/verb list. Return no derived statement, modality or prerequisite. Labels and source order are navigation, never authority. Read original Skill pages through rc_skill_care; navigation is not disclosure.',
        'For each unit provide explicit normativity MANDATORY/PROHIBITED/ADVISORY/PERMISSION/DESCRIPTION/MIXED/UNCERTAIN, scope CURRENT_TASK/INTERNAL_BRANCH/EXTERNAL_TRIGGER/COMPOUND/UNCERTAIN and concise reason. currentDuties selects each independent duty with {quote:exact original text}; externalConditions selects its condition and duty each with {quote:exact original text}, plus the actual verificationTarget. Each quote must match exactly once within this complete original unit, with punctuation/whitespace intact; ambiguous or absent matches are unresolved, never choose the first occurrence. Do not generate numeric spans/contextSpans. The program locates UTF16 positions and their context complement mechanically. Explicitly set remainderDisposition CONTEXT_ONLY or UNCERTAIN and remainderReason explaining whether ALL remaining original text contains any other mandatory duty. A computed complement never proves that semantic assertion. Keep all duties, exceptions, original headings and full context; never enlarge an obligation to swallow permission just to obtain a unique quote.',
        'An independent imperative remains mandatory beside a permission; a description creates no mandatory action. MIXED does not make its advice/permission/context mandatory: select only independent current duties. Internal implementation branches (e.g. handling invalid supplied input) are current implementation duties, not external task exemptions. A sole external trigger has exactly one condition/duty and no independent current duty. COMPOUND retains independent current duties plus external branches, or multiple external branches, without allowing a branch exemption to exclude the parent. If interpretation/subdivision or the remainder is uncertain, say UNCERTAIN; do not invent scope or obligations. Soft/description units explicitly have no duty/condition selections and scope CURRENT_TASK. Global alignment is separate; return no global operations.',
        SKILL_WORKFLOW_SCOPE_INSTRUCTION,
        'Every original heading has one HEADING_SCOPE owner. That unit includes its complete section so exceptions/conditions in later body paragraphs still qualify the heading rule. Select a heading duty only within its supplied ownedSpans; body duties have separate BODY owners. Do not repeat the same heading duty for each body/context copy, infer MUST from Markdown, strengthen a heading by discarding an Unless/exception, or treat section body context as independent duties of the heading unit. Explicitly interpret every owner including descriptive headings. remainderDisposition describes remaining text relative to this owner; mandatory body text may be context here only when its own BODY unit preserves its obligation.'],
      sourceUnits: navigation.units.map(({ id, file, start, end, text, kind, ownedSpans }) => ({ id, file, start, end, characters: text.length,
        sourceOwnership: { kind: kind ?? 'BODY', ownedSpans: ownedSpans ?? [{ start: 0, end: text.length }] } })),
      taskId: task.taskId, skill: { skillId: skill.skillId, directory: skill.directory, digest: skill.source.digest,
        ...(skill.source.identity ? { sourceIdentity: skill.source.identity } : {}),
        truncated: skill.source.truncated, files: skill.source.files.map(({ path, sha256, bytes }) => ({ path, sha256, bytes })) }, materials, sourceCatalog: basis.catalog,
      currentGroundTruth: { path: path.join(taskDirectory(projectRoot, task.taskId), 'ground-truth/current.json'),
        version: current.version, digest: current.digest } },
    evidence: { snapshot, groundTruth: current, skillSource: skill.source } });
  try {
    let candidate = handle.result;
    for (let attempt = 0; ; attempt++) {
      try {
        const graph = bindSkillGraphFromQuotes(candidate.skillGroundTruth, skill.source);
        graph.sourceContract.conditionalPolicy = CONDITIONAL_REVIEW_POLICY_VERSION;
        return { graph, scope, digest };
      } catch (error) {
        if (error.code === 'SKILL_SOURCE_INTERPRETATION_UNRESOLVED') throw error;
        if (!handle.followUp || attempt >= (runtimeV2.reviewers.groundTruthExtractor.formatRepairAttempts ?? 2)) throw error;
        candidate = await handle.followUp({ prompt: `${error.message}\nRecover using complete original sourceUnitIds and explicit source interpretations from the existing request. Keep uncertainty honest; no global re-extraction or invented authority.`, nextSchema: SKILL_GRAPH_SCHEMA });
      }
    }
  } finally { await handle.close(); }
}

async function refreshLocalSkillGraphs(options) {
  const { projectRoot, pluginRoot, task, basis, input, runtimeV2 } = options;
  const skills = new Map(options.skill ? [[options.skill.skillId, options.skill]] : []);
  // Completed watchers do not retire adopted Skill authority. A missing or
  // stale derived graph must be restored before building the Stop population.
  if (input.hook_event_name === 'Stop' && runtimeV2.skillCorrection.enabled) for (const adopted of basis.adoptedSkills) {
    if (skills.has(adopted.skillId)) continue;
    const directory = await resolveSkillDirectory({ skillId: adopted.skillId, projectRoot, pluginRoot,
      configuredRoots: runtimeV2.skillCorrection.skillRoots, sourceIdentity: adopted.sourceIdentity ?? retainedSkillSourceIdentity(task, adopted.skillId) });
    if (!directory) throw new Error(`Adopted Skill cannot be resolved: ${adopted.skillId}`);
    const source = await scanSkillDirectory(directory, { cache: false, sourceIdentity: adopted.sourceIdentity ?? retainedSkillSourceIdentity(task, adopted.skillId) });
    if (source.truncated || source.digest !== adopted.digest)
      throw Object.assign(new Error('Adopted Skill changed before graph alignment'), { code: 'BASELINE_INPUT_CHANGED' });
    skills.set(adopted.skillId, { skillId: adopted.skillId, directory, source });
  }
  for (const skill of skills.values()) {
    const graph = await localSkillGraph({ ...options, skill });
    if (!graph) continue;
    await persistSkillGroundTruth({ projectRoot, taskId: task.taskId, skillId: skill.skillId, skillDigest: skill.source.digest,
      constraints: graph.graph.constraints, taskOverlays: graph.graph.taskOverlays, sourceContract: graph.graph.sourceContract });
    await markSourceCursor(projectRoot, task.taskId, graph.scope, graph.digest);
  }
}

async function refreshGroundTruthInternal({
  input,
  projectRoot,
  sessionCwd,
  task,
  runtimeV2,
  pluginRoot,
  reviewerFactory,
  skill = null,
  artifact = null,
  snapshot,
  readonlyBaselineRetry = null,
  readonlyCandidate = null,
}) {
  if (!runtimeV2.dynamicGroundTruth.enabled) {
    const current = await loadCurrentGroundTruth(projectRoot, task.taskId);
    // Skill correction has its own original-source graph. Disabling global
    // requirement extraction must not silently disable a selected Skill.
    if (!skill || !runtimeV2.skillCorrection.enabled) return { task, changed: false, current };
    try {
      await verifyPendingSkillSelections({ projectRoot, pluginRoot, task, runtimeV2 });
      const materials = await (reviewerFactory.materialManifest ?? materialManifest)(runtimeV2.dynamicGroundTruth.materialRoots);
      const basis = await sharedOriginalBasis({ projectRoot, pluginRoot, task, snapshot, materials, runtimeV2, skill, readOriginalMaterial: reviewerFactory.readOriginalMaterial });
      await refreshLocalSkillGraphs({ projectRoot, pluginRoot, sessionCwd, task, skill, basis, current,
        input, snapshot, runtimeV2, reviewerFactory, materials });
      const fresh = await sharedOriginalBasis({ projectRoot, pluginRoot, task,
        snapshot: await readTranscriptSnapshot(input.transcript_path),
        materials: await (reviewerFactory.materialManifest ?? materialManifest)(runtimeV2.dynamicGroundTruth.materialRoots), runtimeV2, skill,
        readOriginalMaterial: reviewerFactory.readOriginalMaterial });
      const latest = await loadCurrentGroundTruth(projectRoot, task.taskId);
      if (fresh.digest !== basis.digest || latest.version !== current.version || latest.digest !== current.digest)
        throw Object.assign(new Error('Original Skill basis changed during local extraction'), { code: 'BASELINE_INPUT_CHANGED' });
      return { task, changed: false, current };
    } catch (error) { return { task, changed: false, current, unverified: true, error }; }
  }
  if (skill?.source.truncated) {
    return { task, changed: false, current: await loadCurrentGroundTruth(projectRoot, task.taskId), unverified: true,
      error: new Error("The original Skill source exceeds the capture budget; incomplete instructions cannot establish a watcher.") };
  }
  const materials = await (reviewerFactory.materialManifest ?? materialManifest)(runtimeV2.dynamicGroundTruth.materialRoots);
  const current = await loadCurrentGroundTruth(projectRoot, task.taskId);
  const committedTruth = await outsideDecision(() => loadCurrentGroundTruth(projectRoot, task.taskId));
  const committedRecord = await outsideDecision(async () => (await findTask({ projectRoot,
    sessionId: input.session_id, explicitTaskId: task.taskId }))?.groundTruth.sharedBasis);
  let basis;
  const reviewerIdentity = () => reviewerFactory.reviewCacheIdentity?.(runtimeV2.reviewers.groundTruthExtractor) ?? runtimeV2.reviewers.groundTruthExtractor;
  try {
    await verifyPendingSkillSelections({ projectRoot, pluginRoot, task, runtimeV2 });
    basis = await sharedOriginalBasis({ projectRoot, pluginRoot, task, snapshot, materials, runtimeV2, skill, reviewerIdentity: reviewerIdentity(), readOriginalMaterial: reviewerFactory.readOriginalMaterial });
  }
  catch (error) { return { task, current, changed: false, unverified: true, error }; }
  const sourceCatalog = basis.catalog, scope = 'shared-original-basis', digest = basis.digest;
  const assertBasis = async () => {
    reviewerFactory.reviewAbortSignal?.throwIfAborted();
    const latest = await findTask({ projectRoot, sessionId: input.session_id, explicitTaskId: task.taskId });
    const latestTruth = await outsideDecision(() => loadCurrentGroundTruth(projectRoot, task.taskId));
    await verifyPendingSkillSelections({ projectRoot, pluginRoot, task: latest, runtimeV2 });
    const latestSnapshot = await readTranscriptSnapshot(input.transcript_path);
    const next = await sharedOriginalBasis({ projectRoot, pluginRoot, task: latest, snapshot: latestSnapshot,
      materials: await (reviewerFactory.materialManifest ?? materialManifest)(runtimeV2.dynamicGroundTruth.materialRoots), runtimeV2, skill, reviewerIdentity: reviewerIdentity(), readOriginalMaterial: reviewerFactory.readOriginalMaterial });
    if (next.digest !== basis.digest || latestTruth.version !== committedTruth.version || latestTruth.digest !== committedTruth.digest)
      throw Object.assign(new Error('Original basis or baseline changed before publication'), { code: 'BASELINE_INPUT_CHANGED' });
  };
  guardSharedBasis(assertBasis);
  const legacyScope = `legacy:${groundTruthScope(input, skill, artifact)}`;
  if (!readonlyCandidate && await sharedBasisMatches(committedRecord, basis, current, task)) {
    try { await refreshLocalSkillGraphs({ projectRoot, pluginRoot, sessionCwd, task, skill, basis, current, input, snapshot, runtimeV2, reviewerFactory, materials }); }
    catch (error) { return { task, current, changed: false, unverified: true, publicationFailed: true, error }; }
    return { task, changed: false, current };
  }
  const pendingUserRefs = pendingUserSourceRefs(current, sourceCatalog);
  const request = {
    schemaVersion: "runtime-corrector.ground-truth-request.v2",
    instructions: [
      ...VERIFICATION_ROUTING_INSTRUCTIONS,
      ...SOURCE_INSTRUCTIONS,
      "Extract outcome-sized task Ground Truth claims from real user messages, explicitly supplied materials, and verifiable project constraints. Keep internal application validation, negative branches, conditions, exceptions and prohibitions with the operation they constrain. Split any independently required agent verification action from the delivered result under the shared compound-rule instructions. Keep clauses identifiable for precise feedback.",
      "Assistant messages, hook feedback, internal reviewer output, and agent-authored artifacts are never USER_EXPLICIT.",
      "Real user process, tooling, agent lifecycle, recovery and UI requirements are MAIN_TASK obligations even when they describe extraction/correction. Do not discard those user clauses as internal role instructions.",
      "Do not invent a positive requirement from ambiguous negative feedback; use BASIS_PENDING.",
      "AGENT_INFERRED claims must be SOFT.",
      "Use only the category enum exposed by the output schema; map functional or atomic requirements to requirements and workflow procedures to workflowSteps.",
      "Use ADD for new claims. SUPERSEDE, RETRACT, CONFLICT, and RESOLVE require an exact claimId already present in currentGroundTruth; never invent or omit that reference.",
      "When currentGroundTruth.version is 0, normally emit only ADD operations. Ignore internal role prompts and correction-control messages as task claims.",
      "The project Session keeps a stable task identity across user turns. NEW_TASK describes the user's new request, not permission to delete prior requirements. Add supported new obligations; SUPERSEDE/RETRACT old ones only when a new real user message explicitly changes their scope. Preserve unchanged obligations and do not duplicate them.",
      `New unprocessed user source refs: ${JSON.stringify(pendingUserRefs)}. Post-freeze changes must cite one of these exact refs; an earlier user message or generic user alias cannot authorize a new change.`,
      "When the task materials are ambiguous about a behavior (e.g. whether a capability is login-gated), record it as an OPEN_QUESTION constraint that asks the developer to resolve it against the task document — never as a directive that asserts one resolution. A confident-sounding wrong directive is worse than a question.",
      "Classify outcome claims using the supported categories. In particular, use traceabilityRelations for M07 denominator objects, developmentStandards for M09, milestoneTargets for M14, and criticalJourneys for M15.",
      ...(current.frozenAtVersion != null ? [
        `The Ground Truth ledger is FROZEN at version ${current.frozenAtVersion} (task onboarding complete). Post-freeze, only USER_EXPLICIT operations grounded in NEW real user messages are applied; agent-inferred or re-derived material claims are dropped. When nothing new came from the user, return an empty operations array.`,
      ] : []),
      ...(input.hook_event_name === "Stop" && !skill && !artifact ? [
        "If you cannot establish the complete necessary basis within this short session, return checkerError with a concise missing-basis reason and an empty operations array. Do not report successful alignment or infer no changes from deferred or unread sources.",
      ] : []),
    ],
    taskId: task.taskId,
    hookEventId: eventId(input),
    sourceRetentionPolicy: basis.policy,
    transcriptCursor: snapshot.lastEntryKey,
    lastUserCursor: snapshot.lastUserEntryKey,
    hook: sanitizedHookInput(input),
    currentGroundTruth: {
      path: path.join(taskDirectory(projectRoot, task.taskId), "ground-truth", "current.json").replaceAll("\\", "/"),
      version: current.version,
      digest: current.digest,
      frozenAtVersion: current.frozenAtVersion ?? null,
    },
    materials,
    sourceCatalog,
    skill: null,
    reviewScope: { kind: 'baseline', boundedBasis: true, objectIds: [], sourceIds: [] },
  };
  let handle, publicationStarted = false, readonlyRetry = null, diagnosticClaims = [];
  const graphInvocations = readonlyBaselineRetry ? [...(readonlyCandidate?.graphInvocations ?? [])] : null;
  const requestDigest = sha256(request);
  const extractionSchema = { ...GROUND_TRUTH_REVIEW_SCHEMA, properties: { ...GROUND_TRUTH_REVIEW_SCHEMA.properties,
    checkerError: { type: ["string", "null"], maxLength: 768 } } };
  // A task label describes the request; it cannot promote old user sources or
  // remove legitimate materials. Rejected candidates must not consume input.
  const validateAdmission = async candidate => {
    const failure = groundTruthAdmissionFailure(candidate, current, sourceCatalog);
    if (failure) {
      const { newTask, message: reason } = failure;
      if (newTask) await appendTaskJournal(projectRoot, task.taskId, {
        type: 'TASK_SWITCH_SUPPRESSED', hookEventName: input.hook_event_name ?? null,
        reason, quarantinedOperations: candidate.operations.length, quarantinedDelta: candidate,
      });
      throw Object.assign(new Error(reason), { code: 'GROUND_TRUTH_INPUT_UNVERIFIED' });
    }
  };
  try {
    if (readonlyCandidate && (readonlyCandidate.basisDigest !== digest || readonlyCandidate.requestDigest !== requestDigest
      || readonlyCandidate.expectedVersion !== current.version || readonlyCandidate.expectedDigest !== current.digest))
      throw Object.assign(new Error('Read-only original basis or accepted parent changed'), { code: 'BASELINE_INPUT_CHANGED' });
    handle = readonlyCandidate?.handle ?? await reviewerFactory({
      projectRoot,
      sessionCwd,
      taskId: task.taskId,
      parentSessionId: input.session_id,
      role: "ground-truth-extractor",
      reviewer: runtimeV2.reviewers.groundTruthExtractor,
      schema: extractionSchema,
      request,
      evidence: { snapshot, groundTruth: current },
    });
    let delta = readonlyCandidate ? structuredClone(readonlyCandidate.delta) : handle.result, applied, planned;
    let structuralRepairs = 0, externalRepairs = 0;
    const originalBudget = !readonlyCandidate ? handle.baselineTask?.budget.snapshot() : null;
    const structuralRepairLimit = originalBudget?.maxRepairs ?? runtimeV2.reviewers.groundTruthExtractor.formatRepairAttempts ?? 2;
    const externalRepairLimit = originalBudget?.maxExternalRepairs ?? 1;
    let baselineCommit = !readonlyCandidate && handle.baselineTask ? { ...handle.baselineTask,
      id: handle.baselineTask.requestId, scope, cursorDigest: digest, sharedBasis: basis } : null;
    // All encodings and NO_CHANGE converge here. Only zero-write validation is repairable.
    for (;;) {
      try {
        const issues = validateJsonSchema(delta, extractionSchema);
        if (issues.length) throw Object.assign(new Error(`Ground Truth result invalid: ${issues[0].pointer} ${issues[0].message}`),
          { code: 'GROUND_TRUTH_RESULT_INVALID' });
        if (delta.checkerError) throw Object.assign(new Error(`Stop baseline remains unverified: ${delta.checkerError}`), { code: 'GROUND_TRUTH_BASIS_UNVERIFIED' });
        if (!Array.isArray(delta.operations)) throw new Error('Ground Truth extractor omitted operations');
        await validateAdmission(delta);
        planned = planGroundTruthDelta({ current, taskId: task.taskId, delta, sourceCatalog,
          evidenceCapture: runtimeV2.dynamicGroundTruth.evidenceCapture });
        if (baselineCommit || readonlyCandidate) {
          const scopeDigest = sha256({ taskId: task.taskId, rootSessionId: task.rootSessionId, basis: digest,
            assessmentId: decisionScope.getStore()?.context.assessmentId ?? null, hookEventId: eventId(input) });
          if (readonlyCandidate) {
            const freshGuard = async () => {
              await assertBasis();
              const physicalTask = await outsideDecision(() => findTask({ projectRoot, sessionId: input.session_id, explicitTaskId: task.taskId }));
              if (!physicalTask || physicalTask.control?.cancelled || sha256(decisionGuard(physicalTask)) !== readonlyCandidate.guard)
                throw Object.assign(new Error('Read-only baseline owner or cancellation guard changed'), { code: 'BASELINE_INPUT_CHANGED' });
              await handle.baselineTask.verifyCompleted();
              await verifyGraphInvocations(graphInvocations, task.taskId);
            };
            const rebound = await handle.baselineTask.reuseCompleted({ plan: planned, scopeDigest, assertCurrent: freshGuard });
            baselineCommit = { ...rebound, id: rebound.requestId, scope, cursorDigest: digest, sharedBasis: basis };
            guardSharedBasis(() => rebound.coverageAudit.assertPlan(planned));
            break;
          }
          if (typeof handle.baselineTask.getAuditInput !== 'function') throw Object.assign(new Error('Baseline has no independent audit adapter'), { code: 'BASELINE_COVERAGE_UNVERIFIED' });
          const auditInput = await handle.baselineTask.getAuditInput(planned, scopeDigest);
          const extractorRunId = auditInput.extractorSettlement?.runIds?.at(-1);
          const auditDeadline = Math.min(handle.baselineTask.extractionDeadlineAt, handle.baselineTask.deadlineAt,
            reviewerFactory.reviewDeadlineAt ?? Infinity);
          const auditProgress = async (phase, reasonCode) => {
            if (!/^[a-z0-9-]{1,120}$/iu.test(extractorRunId ?? '')) return;
            // Navigation only: no status write can establish publication.
            const file = path.join(taskDirectory(projectRoot, task.taskId), 'baseline-audit-progress', `${extractorRunId}.json`);
            await outsideDecision(() => atomicWriteJson(file, { taskId: task.taskId, extractorRunId,
              requestId: handle.baselineTask.requestId, generation: auditInput.generation, phase,
              ...(reasonCode ? { reasonCode } : {}), updatedAt: Date.now(), deadlineAt: auditDeadline, navigationOnly: true })).catch(() => {});
          };
          let checker, verdict;
          await auditProgress('CHECKING');
          try {
            checker = await reviewerFactory({ projectRoot, sessionCwd, taskId: task.taskId, parentSessionId: input.session_id,
              role: 'ground-truth-extractor', reviewer: { ...runtimeV2.reviewers.groundTruthExtractor,
                session: 'detached', formatRepairAttempts: 0, maxOutputTokens: auditInput.maxTokens },
              deadlineAt: auditDeadline, abortSignal: handle.baselineTask.signal,
              schema: BASELINE_COVERAGE_SCHEMA, request: { taskId: task.taskId,
                reviewScope: { kind: 'baseline-coverage-audit' } },
              baselineAuditInput: auditInput, baselineAuditBudget: handle.baselineTask.budget });
            const audit = checker.coverageAudit;
            if (!audit) throw Object.assign(new Error('Independent original coverage remains unresolved'), { code: 'BASELINE_COVERAGE_UNVERIFIED' });
            diagnosticClaims = coveredImplementationClaims(audit, planned.current.claims);
            const auditBudget = handle.baselineTask.budget?.snapshot();
            const canAuditAgain = auditBudget && auditBudget.auditCalls < auditBudget.maxAuditCalls;
            const frozenWithoutAuthority = current.frozenAtVersion != null && pendingUserRefs.length === 0;
            // A mixed verdict can guide repair outside the disputed inventory.
            // The revised candidate still needs a complete independent PASS.
            const auditedSources = audit.anchoredSources ?? audit.report.sources;
            const disputedClaims = new Set(auditedSources.flatMap(row => row.issues
              .filter(issue => issue.issueKind === 'SOURCE_INVENTORY').flatMap(issue => issue.claimIds)));
            const repairSources = auditedSources.map(({ ref, kind, issues }) => {
              if (audit.report.verdict === 'REPAIR') return { ref, kind, issues };
              const uncertainUnits = new Set(issues.filter(issue => issue.issueKind === 'SOURCE_INVENTORY').map(issue => issue.unitId));
              return { ref, kind, issues: issues.filter(issue => issue.issueKind === 'CANDIDATE'
                && issue.obligationIds.length && issue.unitId && !uncertainUnits.has(undefined) && !uncertainUnits.has(issue.unitId)
                && !issue.claimIds.some(id => disputedClaims.has(id))) };
            }).filter(row => row.issues.length);
            const repairBeforeReaudit = audit.report.verdict === 'UNRESOLVED' && canAuditAgain && !frozenWithoutAuthority
              && repairSources.length > 0 && typeof handle.followUp === 'function' && externalRepairs < externalRepairLimit
              && auditBudget.repairs < auditBudget.maxRepairs && auditBudget.turns < auditBudget.maxTurns;
            if (audit.report.verdict === 'UNRESOLVED') {
              verdict = 'UNRESOLVED';
              await auditProgress(verdict, 'BASELINE_COVERAGE_UNVERIFIED');
              if (canAuditAgain) {
                await appendTaskJournal(projectRoot, task.taskId, { type: 'BASELINE_AUDIT_UNRESOLVED',
                  hookEventId: eventId(input), audit: audit.pointer,
                  reason: repairBeforeReaudit
                    ? 'Repair independently located candidate defects outside uncertain units before the next full audit.'
                    : 'Retain the uncertain inventory; retry an independent source-first audit within the same original budget.' });
              }
              if (!canAuditAgain) throw Object.assign(new Error('Independent original coverage remains unresolved'), { code: 'BASELINE_COVERAGE_UNVERIFIED' });
              if (!repairBeforeReaudit) continue;
            }
            if (audit.report.verdict === 'REPAIR' || repairBeforeReaudit) {
              verdict = 'REPAIR';
              const code = frozenWithoutAuthority ? 'BASELINE_FROZEN_AUTHORIZATION_REQUIRED'
                : auditBudget && !canAuditAgain ? 'BASELINE_COVERAGE_UNVERIFIED' : 'BASELINE_COVERAGE_REPAIR';
              await auditProgress(verdict, code);
              throw Object.assign(new Error(frozenWithoutAuthority
                ? 'The independent audit found omissions or mismatches in a frozen baseline, and no new real user source authorizes a change.'
                : auditBudget && !canAuditAgain ? 'Candidate repair requires a remaining independent audit.'
                  : 'Independent original audit found omitted/misowned/conditional duties'),
              { code, coverageFeedback: {
                audit: audit.pointer, inventoryDigest: audit.report.inventoryDigest,
                sources: repairSources,
              } });
            }
            const cap = await handle.baselineTask.acceptAudit(audit, auditInput, assertBasis);
            Object.assign(baselineCommit, handle.baselineTask);
            baselineCommit.coverageAudit = cap;
            guardSharedBasis(() => cap.assertPlan(planned));
            await auditProgress('PASSED');
          } catch (error) {
            if (error.coveredImplementationClaims?.length) {
              try { await assertBasis(); diagnosticClaims = error.coveredImplementationClaims; }
              catch { diagnosticClaims = []; }
            }
            if (!verdict) await auditProgress('FAILED', error.code ?? 'BASELINE_COVERAGE_UNVERIFIED');
            if (error.code === 'BASELINE_AUDIT_INCOMPLETE' && (originalBudget?.maxAuditCalls ?? 2) > 2) {
              await appendTaskJournal(projectRoot, task.taskId, { type: 'BASELINE_AUDIT_INCOMPLETE',
                hookEventId: eventId(input), reason: error.message,
                retry: 'Start a new source-first audit against the unchanged candidate within the original shared allowance.' });
              continue;
            }
            if (error.code !== 'BASELINE_COVERAGE_REPAIR') error.coverageAuditFailure = true;
            throw error;
          } finally {
            try { await checker?.close?.(); }
            catch (error) { await auditProgress('FAILED', error.code ?? 'BASELINE_COVERAGE_UNVERIFIED'); error.coverageAuditFailure = true; throw error; }
          }
        }
        break;
      } catch (error) {
        const structuralRepair = ['GROUND_TRUTH_EXPECTED_FILES_INVALID', 'GROUND_TRUTH_RESULT_INVALID'].includes(error.code);
        if (readonlyCandidate || (structuralRepair ? structuralRepairs >= structuralRepairLimit : externalRepairs >= externalRepairLimit)
          || error.coverageAuditFailure || typeof handle.followUp !== 'function' || ['BASELINE_COVERAGE_UNVERIFIED', 'OWNED_SETTLEMENT_UNVERIFIED',
          'JOURNAL_UNCERTAIN', 'BASELINE_BUDGET_UNVERIFIED', 'TURN_LIMIT', 'REVIEWER_DEADLINE', 'BASELINE_INPUT_CHANGED',
          'BASELINE_COMMIT_CONFLICT', 'GROUND_TRUTH_BASIS_UNVERIFIED'].includes(error.code) || reviewerFactory.reviewAbortSignal?.aborted) throw error;
        // All repairs debit the original shared allowance and absolute deadline.
        // Shape fixes do not consume the separately configured external feedback cap.
        if (structuralRepair) structuralRepairs++;
        else {
          handle.baselineTask?.budget.claimExternalRepair(); externalRepairs++;
          await appendTaskJournal(projectRoot, task.taskId, { type: 'BASELINE_AUDIT_REPAIR_STARTED', hookEventId: eventId(input),
            audit: error.coverageFeedback?.audit, reason: error.code });
        }
        const repairRequest = path.join(handle.requestDirectory, 'ground-truth-repair-request.json');
        await atomicWriteJson(repairRequest, { schemaVersion: 'runtime-corrector.ground-truth-repair-request.v2',
          validationError: error.message, rejectedDelta: delta, currentGroundTruth: current,
          instructions: ['Repair the source-grounded omissions/owner/conditions using the same originals and original allowance.',
            'Preserve every unchanged obligation and its authority. An empty delta does not waive original coverage.'],
          ...(error.coverageFeedback ? { coverageFeedback: error.coverageFeedback } : {}) });
        diagnosticClaims = [];
        delta = await handle.followUp({ prompt: `[runtime-corrector:internal] Repair the rejected candidate: ${error.message}`,
          nextSchema: extractionSchema, nextReviewer: runtimeV2.reviewers.groundTruthExtractor });
        if (baselineCommit) Object.assign(baselineCommit, handle.baselineTask);
        await appendTaskJournal(projectRoot, task.taskId, { type: 'GROUND_TRUTH_DELTA_REPAIRED', hookEventId: eventId(input), validationError: error.message });
      }
    }
    // After writes begin, every error discards the owning outer attempt; never repair staged truth.
    publicationStarted = true;
    applied = await applyGroundTruthDelta({ projectRoot, taskId: task.taskId, delta, sourceCatalog,
      evidenceCapture: runtimeV2.dynamicGroundTruth.evidenceCapture, hookEventId: eventId(input), baselineCommit });
    if (baselineCommit && applied.stale) throw Object.assign(new Error('Baseline publication rejected stale input'), { code: 'BASELINE_INPUT_CHANGED' });
    await baselineCommit?.coverageAudit?.assertApplied(applied);
    if (applied.droppedPostFreeze?.length) {
      // Loud fail-soft: the frozen ledger silently ignoring extractor output
      // would make the freeze indistinguishable from extractor failure.
      await appendTaskJournal(projectRoot, task.taskId, {
        type: "GROUND_TRUTH_POST_FREEZE_OPS_DROPPED",
        hookEventId: eventId(input),
        dropped: applied.droppedPostFreeze,
      });
    }
    if (applied.droppedUntrustedSources?.length && applied.current.claims.length === 0) {
      throw new Error("No valid task Ground Truth remains after source validation; rejected internal/unknown sources cannot establish an empty PASS baseline.");
    }
    if (baselineCommit?.readCoverage?.certifyAccepted) {
      const acceptedSourceCertificate = await baselineCommit.readCoverage.certifyAccepted({ projectRoot, task, basis, delta, applied, assertCurrent: assertBasis });
      if (acceptedSourceCertificate) await withTaskState({ projectRoot, taskId: task.taskId }, state => {
        if (state.groundTruth.sharedBasis?.proof?.requestId !== baselineCommit.id
          || state.groundTruth.sharedBasis.baselineDigest !== applied.current.digest)
          throw Object.assign(new Error('Source certificate lost its actual shared-basis commit'), { code: 'BASELINE_INPUT_CHANGED' });
        state.groundTruth.sharedBasis.acceptedSourceCertificate = acceptedSourceCertificate;
      });
    }
    // The delta is staged under the same task decision, not yet published.
    // Local overlays must read that actual new baseline; a graph failure
    // invalidates and rolls back the entire decision, including its proof.
    try {
      await refreshLocalSkillGraphs({ projectRoot, pluginRoot, sessionCwd, task, skill, basis, current: applied.current,
        input, snapshot, runtimeV2, reviewerFactory, materials, graphInvocations });
    } catch (error) {
      if (readonlyBaselineRetry && baselineCommit?.coverageAudit && typeof handle.baselineTask?.reuseCompleted === 'function'
        && retryableGraphTransport(error)) readonlyRetry = { handle, delta: structuredClone(delta), basisDigest: digest,
          requestDigest, expectedVersion: current.version, expectedDigest: current.digest, graphInvocations };
      throw error;
    }
    if (current.version > 0 && applied.hardChanged
      && decisionScope.getStore()?.context?.mode !== "verify_only") {
      const source = (delta.operations ?? []).some((operation) => operation.authority === "USER_EXPLICIT")
        ? "USER_EXPLICIT"
        : "AUTHORITATIVE_SOURCE";
      await startCorrectionEpoch({
        projectRoot,
        taskId: task.taskId,
        reason: "HARD_GROUND_TRUTH_CHANGED",
        source,
      });
    }
    if (!baselineCommit) await markSourceCursor(projectRoot, task.taskId, legacyScope, digest);
    return { task, changed: applied.changed, current: applied.current, handle, delta };
  } catch (error) {
    if (handle) await handle.close();
    await appendTaskJournal(projectRoot, task.taskId, {
      type: "GROUND_TRUTH_REFRESH_FAILED",
      hookEventId: eventId(input),
      error: error.message,
    });
    const fallbackCurrent = task.taskId === current.taskId
      ? current
      : await loadCurrentGroundTruth(projectRoot, task.taskId);
    return {
      task,
      changed: false,
      current: fallbackCurrent,
      error,
      unverified: true,
      publicationFailed: publicationStarted,
      readonlyRetry,
      diagnosticClaims: publicationStarted ? [] : diagnosticClaims,
    };
  }
}

async function persistWatcher(projectRoot, taskId, watcher) {
  const filePath = path.join(
    taskDirectory(projectRoot, taskId),
    "skills",
    safeId(watcher.skillId),
    "watcher.json",
  );
  await atomicWriteJson(filePath, watcher);
}

const selectionFailure = message => Object.assign(new Error(message), { code: 'SKILL_SELECTION_UNVERIFIED' });
async function retainSkillSelection({ projectRoot, task, skill, input, snapshot, runtimeV2, reviewerFactory }) {
  // The existing parent may already have staged a legitimate requirement revision.
  // Keep its current candidate and its original physical owner distinct.
  const currentTask = await findTask({ projectRoot, sessionId: input.session_id, explicitTaskId: task.taskId });
  const committedTask = await outsideDecision(() => findTask({ projectRoot, sessionId: input.session_id, explicitTaskId: task.taskId }));
  if (!currentTask || !committedTask || currentTask.rootSessionId !== task.rootSessionId
    || committedTask.rootSessionId !== task.rootSessionId || currentTask.control?.cancelled || committedTask.control?.cancelled)
    throw selectionFailure('Skill selection has no current original task owner');
  task = currentTask;
  const guard = decisionGuard(currentTask), committedGuard = decisionGuard(committedTask), invocationId = input.tool_use_id ?? eventId(input);
  const save = async () => {
    const originalDecision = scopedDecision(taskStatePath(projectRoot, task.taskId));
    const assertOwner = async () => {
      reviewerFactory.reviewAbortSignal?.throwIfAborted();
      if (Date.now() >= (reviewerFactory.reviewDeadlineAt ?? Infinity)) throw selectionFailure('Skill selection deadline expired');
      const latest = await findTask({ projectRoot, sessionId: input.session_id, explicitTaskId: task.taskId });
      const publishing = scopedDecision(taskStatePath(projectRoot, task.taskId)) !== originalDecision;
      if (!latest || latest.rootSessionId !== task.rootSessionId || latest.control?.cancelled
        || sha256(decisionGuard(latest)) !== sha256(publishing ? committedGuard : guard)) throw selectionFailure('Skill selection owner or cancellation changed');
      const current = await scanSkillDirectory(skill.directory, { cache: false });
      if (current.digest !== skill.source.digest || current.root !== skill.source.root || current.truncated !== skill.source.truncated)
        throw selectionFailure('Selected original changed before its invocation was retained');
    };
    await assertOwner(); guardSharedBasis(assertOwner);
    const original = { schemaVersion: 'runtime-corrector.skill-selection.v1', taskId: task.taskId, rootSessionId: task.rootSessionId,
      skillId: skill.skillId, directory: skill.directory, invocationId, hookEventId: eventId(input), sessionId: input.session_id,
      transcriptDigest: sha256(snapshot.entries), guard, source: { root: skill.source.root, digest: skill.source.digest,
        ...(skill.source.identity ? { identity: skill.source.identity } : {}),
        truncated: skill.source.truncated, totalBytes: skill.source.totalBytes, files: skill.source.files } };
    const digest = sha256(original), file = path.join(taskDirectory(projectRoot, task.taskId), 'skill-selections', `${digest}.json`);
    await atomicWriteJson(file, original);
    const pointer = { path: file, digest, bytesDigest: sha256(Buffer.from(`${JSON.stringify(original, null, 2)}\n`)) };
    let retained;
    await withTaskState({ projectRoot, taskId: task.taskId }, state => {
      if (state.control?.cancelled || state.rootSessionId !== task.rootSessionId || sha256(decisionGuard(state)) !== sha256(guard))
        throw selectionFailure('Skill selection lost its guarded owner');
      retained = Object.values(state.watchers).find(row => row.skillId === skill.skillId && (row.status === 'ACTIVE' || row.pendingSelection));
      if (!retained) {
        const startedTurn = state.turns.total;
        retained = { schemaVersion: 'runtime-corrector.skill-watcher.v2', watcherId: uniqueId('watcher'), taskId: task.taskId,
          skillId: skill.skillId, skillDigest: skill.source.digest, correctionEpochId: state.correctionEpoch.id,
          invocationIds: [], startedAt: new Date().toISOString(), startedTurn,
          nextCheckTurn: startedTurn + runtimeV2.skillCorrection.completionCheckIntervalTurns,
          maxTurn: startedTurn + runtimeV2.skillCorrection.maxWatchTurns, lastCheckTurn: null, evaluationCount: 0, lastEvidenceDigest: null };
        state.watchers[retained.watcherId] = retained;
      }
      if (!retained.invocationIds.includes(invocationId)) retained.invocationIds.push(invocationId);
      retained.selectionOrigins ??= [];
      if (!retained.selectionOrigins.some(row => row.digest === digest)) retained.selectionOrigins.push(pointer);
      retained.pendingSelection = { taskId: task.taskId, rootSessionId: task.rootSessionId, invocationId,
        sourceDigest: skill.source.digest, cancelEpoch: guard.cancelEpoch, pointer };
      retained.skillDigest = skill.source.digest; retained.status = 'UNVERIFIED_RECOVERY';
      if (skill.source.identity) retained.sourceIdentity = structuredClone(skill.source.identity);
      retained.sourceInterpretationChecked = false; retained.verificationIncomplete = true;
    });
    await persistWatcher(projectRoot, task.taskId, retained);
    return retained;
  };
  if (scopedDecision(taskStatePath(projectRoot, task.taskId))) return save();
  return withTaskDecision({ projectRoot, taskId: task.taskId, context: { assessmentId: `skill-selection:${sha256([eventId(input), invocationId])}`,
    kind: 'hook', guard, deadlineAt: reviewerFactory.reviewDeadlineAt, abortSignal: reviewerFactory.reviewAbortSignal } }, save);
}

async function verifyPendingSkillSelections({ projectRoot, pluginRoot, task, runtimeV2 }) {
  for (const watcher of Object.values(task.watchers ?? {})) {
    const pending = watcher.pendingSelection;
    if (!pending) continue;
    try {
      const pointer = pending.pointer, expected = path.join(taskDirectory(projectRoot, task.taskId), 'skill-selections', `${pointer?.digest}.json`);
      if (!/^[a-f0-9]{64}$/u.test(pointer?.digest ?? '') || pointer.path !== expected || pending.taskId !== task.taskId
        || pending.rootSessionId !== task.rootSessionId || task.control?.cancelled
        || pending.cancelEpoch !== decisionGuard(task).cancelEpoch || !watcher.invocationIds.includes(pending.invocationId)
        || !watcher.selectionOrigins?.some(origin => origin.path === pointer.path && origin.digest === pointer.digest && origin.bytesDigest === pointer.bytesDigest)
        || !selectedSkill(watcher.skillId, runtimeV2.skillCorrection.selection)) throw selectionFailure('Pending Skill selection has a foreign or cancelled owner');
      const scope = scopedDecision(expected), staged = scope?.files[path.relative(scope.directory, expected)];
      if (staged === undefined && (await hasLinkedPath(expected) || !await isSameFile(await fs.realpath(expected), expected))) throw selectionFailure('Linked pending Skill original');
      const bytes = staged === undefined ? await fs.readFile(expected) : Buffer.from(staged), original = JSON.parse(bytes.toString('utf8'));
      const directory = await resolveSkillDirectory({ skillId: watcher.skillId, projectRoot, pluginRoot,
        configuredRoots: runtimeV2.skillCorrection.skillRoots, sourceIdentity: watcher.sourceIdentity });
      if (sha256(bytes) !== pointer.bytesDigest || sha256(original) !== pointer.digest
        || original.schemaVersion !== 'runtime-corrector.skill-selection.v1' || original.taskId !== task.taskId
        || original.rootSessionId !== task.rootSessionId || original.skillId !== watcher.skillId || original.invocationId !== pending.invocationId
        || !(task.sessionIds ?? [task.rootSessionId]).includes(original.sessionId) || original.guard?.cancelEpoch !== pending.cancelEpoch
        || original.directory !== directory || sha256(original.source.identity ?? null) !== sha256(watcher.sourceIdentity ?? null)
        || original.source.truncated || original.source.digest !== pending.sourceDigest
        || sha256(original.source.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }))) !== pending.sourceDigest
        || original.source.files.some(file => typeof file.content !== 'string' || Buffer.byteLength(file.content) !== file.bytes || sha256(file.content) !== file.sha256))
        throw selectionFailure('Pending Skill original snapshot changed or is incomplete');
      if (!directory) throw selectionFailure('Pending Skill original is unavailable');
      const current = await scanSkillDirectory(directory, { cache: false, sourceIdentity: watcher.sourceIdentity });
      if (current.truncated || current.digest !== pending.sourceDigest || current.root !== original.source.root)
        throw selectionFailure('Pending Skill original changed; historical bytes cannot replace a current read');
    } catch (error) {
      if (error.code === 'SKILL_SELECTION_UNVERIFIED') throw error;
      throw selectionFailure(`Pending Skill original is unverifiable: ${error.code ?? error.message}`);
    }
  }
}

async function mutateWatcher(projectRoot, taskId, watcherId, updater, context = null) {
  let snapshot = null;
  await withTaskState({ projectRoot, taskId }, (state) => {
    if (context && (context.signal?.aborted || Date.now() >= context.deadlineAt || state.control?.cancelled
      || Object.entries(context.guard).some(([key, value]) => decisionGuard(state)[key] !== value))) return;
    const watcher = state.watchers[watcherId];
    if (!watcher) return;
    updater(watcher, state);
    snapshot = JSON.parse(JSON.stringify(watcher));
  });
  if (snapshot) await persistWatcher(projectRoot, taskId, snapshot);
  return snapshot;
}

async function startSkillWatcher({ projectRoot, task, skillId, source, input, runtimeV2 }) {
  let watcher;
  await withTaskState({ projectRoot, taskId: task.taskId }, (state) => {
    // Feedback delivery has its own cap below. Exhausting it must not skip
    // checking original units that do not project to any hard metric.
    const active = Object.values(state.watchers).find(
      (candidate) => candidate.skillId === skillId && (candidate.status === "ACTIVE" || candidate.pendingSelection),
    );
    if (active) {
      if (!active.invocationIds.includes(input.tool_use_id ?? eventId(input))) {
        active.invocationIds.push(input.tool_use_id ?? eventId(input));
      }
      active.skillDigest = source.digest;
      if (source.identity) active.sourceIdentity = structuredClone(source.identity);
      active.status = 'ACTIVE'; delete active.pendingSelection;
      watcher = active;
      return;
    }
    const startedTurn = state.turns.total;
    watcher = {
      schemaVersion: "runtime-corrector.skill-watcher.v2",
      watcherId: uniqueId("watcher"),
      taskId: task.taskId,
      skillId,
      skillDigest: source.digest,
      ...(source.identity ? { sourceIdentity: structuredClone(source.identity) } : {}),
      correctionEpochId: state.correctionEpoch.id,
      status: "ACTIVE",
      invocationIds: [input.tool_use_id ?? eventId(input)],
      startedAt: new Date().toISOString(),
      startedTurn,
      nextCheckTurn: startedTurn + runtimeV2.skillCorrection.completionCheckIntervalTurns,
      maxTurn: startedTurn + runtimeV2.skillCorrection.maxWatchTurns,
      lastCheckTurn: null,
      evaluationCount: 0,
      lastEvidenceDigest: null,
    };
    state.watchers[watcher.watcherId] = watcher;
  });
  if (watcher.watcherId) await persistWatcher(projectRoot, task.taskId, watcher);
  return watcher;
}

function skillFeedbackText(skillId, review, watcher) {
  const lines = [
    `[runtime-corrector] Skill execution correction: ${skillId}`,
    `Watcher: ${watcher.watcherId}`,
    `Assessment: ${review.summary}`,
    "Respond by correcting the execution or explaining with evidence why the finding does not apply.",
  ];
  for (const finding of review.findings) {
    lines.push(`- [${finding.severity}] ${finding.reason}`);
    lines.push(`  Expected: ${finding.expectedConstraint}`);
    if (finding.suggestedNextAction) lines.push(`  Next: ${finding.suggestedNextAction}`);
  }
  if (review.checkerError?.trim()) lines.push(`Unverified basis for other obligations: ${review.checkerError}`);
  return lines.join("\n");
}

// Same-graph navigation only: these counts/keys never certify the graph's
// semantics or change the submitted review. Share the existing care reader.
function skillReviewKeyNavigation(graph, field, expected, supplied, itemFields = [], prefix = '') {
  const preview = key => {
    const encoded = JSON.stringify(key) ?? 'null', bytes = Buffer.byteLength(encoded);
    return bytes <= 256 ? key : { sha256: sha256(key), encodedUtf8Bytes: bytes, truncated: true,
      notice: 'Not a submit-ready ID. Recover the exact original key through rc_skill_care.' };
  };
  const groups = { expected }, offendingFields = [];
  if (supplied !== undefined) {
    const expectedSet = new Set(expected), suppliedSet = new Set(supplied), seen = new Set(), duplicates = [];
    supplied.forEach((key, index) => {
      const duplicate = seen.has(key); if (duplicate) duplicates.push(key); seen.add(key);
      if (!expectedSet.has(key) || duplicate) offendingFields.push(itemFields[index] ?? field);
    });
    Object.assign(groups, { supplied, missing: expected.filter(key => !suppliedSet.has(key)),
      unknown: supplied.filter(key => !expectedSet.has(key)), duplicates });
  }
  const value = { field, basis: { skillId: preview(graph.skillId ?? null), graphVersion: preview(graph.version ?? null),
    graphDigest: sha256(graph), skillSourceDigest: preview(graph.sourceContract?.sourceDigest ?? null) },
    namespace: 'Skill graph keys only: constraintId or JSON.stringify([constraintId,conditionId]); baseline claim IDs are a different namespace.',
    ...Object.fromEntries(Object.entries(groups).map(([name, keys]) => [name, { count: keys.length, keys: [], omittedCount: keys.length }])),
    ...(supplied === undefined ? {} : { offendingFieldCount: offendingFields.length, offendingFields: offendingFields.slice(0, 16) }),
    navigationOnly: true, recoverWith: { tool: 'rc_skill_care', action: 'inventory', prefix: 'constraint/', offset: 0 },
    notice: 'Follow nextOffset and read complete original context. Zero targets do not certify source semantics; use CONFLICT/UNCERTAIN for an ungrounded graph.' };
  const blocked = new Set();
  const byteLimit = prefix ? 8192 - Buffer.byteLength('\n' + SKILL_REVIEW_REPAIR_INSTRUCTION) : 8192;
  // Round-robin previews retain a useful example from each set within the
  // whole-message UTF8 bound, even when IDs are long or heavily escaped.
  for (let i = 0; i < 16; i++) for (const [name, keys] of Object.entries(groups)) {
    if (i >= keys.length || blocked.has(name)) continue;
    const section = value[name]; section.keys.push(preview(keys[i])); section.omittedCount = keys.length - section.keys.length;
    if (Buffer.byteLength(prefix + JSON.stringify(value)) > byteLimit) {
      section.keys.pop(); section.omittedCount = keys.length - section.keys.length; blocked.add(name);
    }
  }
  return value;
}

export function validateSkillConditionalReview({ review, graph, citations = [], snapshot, processSource }) {
  const graphDigest = sha256(graph);
  const conditional = skillConditionalTargets(graph);
  const assessments = review.conditionalAssessments ?? [];
  let semanticUnresolved = false;
  if (graph.sourceContract?.version === SKILL_SOURCE_CONTRACT_VERSION) {
    const checked = review.sourceInterpretationReviews ?? [];
    if (new Set(checked.map(item => item.constraintId)).size !== checked.length
      || checked.length !== graph.constraints.length || checked.some(item => !graph.constraints.some(c => c.constraintId === item.constraintId))) {
      if (!review.checkerError) {
        const prefix = 'SKILL_SOURCE_INTERPRETATION_REQUIRED: check every original unit, including description, permission and advice. ';
        const navigation = skillReviewKeyNavigation(graph, '/sourceInterpretationReviews', graph.constraints.map(c => c.constraintId),
          checked.map(item => item.constraintId), checked.map((_, index) => `/sourceInterpretationReviews/${index}/constraintId`), prefix);
        throw Object.assign(new Error(prefix + JSON.stringify(navigation)), { code: 'SKILL_SOURCE_INTERPRETATION_REQUIRED' });
      }
      semanticUnresolved = true;
    }
    for (const item of checked) {
      if (!['CONFIRMED', 'CONFLICT', 'UNCERTAIN'].includes(item.disposition) || !item.reason?.trim())
        throw new Error('SKILL_SOURCE_INTERPRETATION_REQUIRED: explicit semantic disposition and reason are required.');
      const disclosed = citations.some(c => c.usedBy?.includes(`interpretation:${item.constraintId}`)
        && c.readProof?.protocol === 'native-skill-care-v1' && c.readProof.observed === true
        && c.readProof.policy === CONDITIONAL_REVIEW_POLICY_VERSION && c.readProof.basisComplete === true
        && c.readProof.owner === 'BASIS' && c.readProof.fullFile === true
        && c.readProof.skillGraphDigest === graphDigest && c.readProof.skillSourceDigest === graph.sourceContract.sourceDigest);
      if (!disclosed) throw Object.assign(new Error('SKILL_SOURCE_INTERPRETATION_EVIDENCE_UNAVAILABLE: semantic review requires actually disclosed complete original context.'), { code: 'SKILL_SOURCE_INTERPRETATION_EVIDENCE_UNAVAILABLE' });
      semanticUnresolved ||= item.disposition !== 'CONFIRMED';
    }
  }
  if (review.checkerError && !assessments.length) return { bindings: [], unresolved: true };
  if (new Set(assessments.map(skillConditionKey)).size !== assessments.length
    || assessments.length !== conditional.length || assessments.some(a => !conditional.some(c => skillConditionKey(c) === skillConditionKey(a)))) {
    const prefix = 'REVIEW_CONDITION_ASSESSMENT_REQUIRED: assess exactly the original conditional Skill nodes. ';
    const branchParents = new Set(conditional.filter(c => c.conditionId != null).map(c => c.constraintId));
    const parents = new Set((graph.constraints ?? []).map(c => c.constraintId));
    const fields = assessments.map((item, index) => `/conditionalAssessments/${index}/${branchParents.has(item.constraintId)
      || item.conditionId != null && parents.has(item.constraintId) ? 'conditionId' : 'constraintId'}`);
    const navigation = skillReviewKeyNavigation(graph, '/conditionalAssessments', conditional.map(skillConditionKey),
      assessments.map(skillConditionKey), fields, prefix);
    throw Object.assign(new Error(prefix + JSON.stringify(navigation)), { code: 'REVIEW_CONDITION_ASSESSMENT_REQUIRED' });
  }
  const entries = snapshot?.entries ?? [], cursor = sha256(entries), bindings = [];
  let unresolved = semanticUnresolved;
  for (const item of assessments) {
    const node = conditional.find(c => skillConditionKey(c) === skillConditionKey(item)), assessment = item.conditionAssessment;
    const refs = citations.filter(c => c.usedBy?.includes(`condition:${skillConditionKey(node)}`)
      && c.readProof?.protocol === 'native-skill-care-v1' && c.readProof.observed === true
      && c.readProof.policy === CONDITIONAL_REVIEW_POLICY_VERSION
      && (!graph.sourceContract || c.readProof.skillGraphDigest === graphDigest
        && c.readProof.skillSourceDigest === graph.sourceContract.sourceDigest));
    const state = assessment?.activation;
    if (state === 'PENDING_REQUIRED_TRIGGER' && review.completionStatus === 'COMPLETED')
      throw Object.assign(new Error('REVIEW_CONDITION_VERDICT_CONFLICT: a required pending trigger cannot be COMPLETED.'), { code: 'REVIEW_CONDITION_VERDICT_CONFLICT' });
    let verdict = item.judgement ?? (state === 'INACTIVE_AT_CURRENT_BOUNDARY' ? 'NOT_APPLICABLE' : state === 'PENDING_REQUIRED_TRIGGER'
      ? 'NOT_YET_APPLICABLE' : state === 'UNKNOWN' || review.checkerError || review.completionStatus !== 'COMPLETED' ? 'UNVERIFIED' : 'PASS');
    if (node.conditionId != null && !item.judgement)
      throw Object.assign(new Error('REVIEW_CONDITION_ASSESSMENT_REQUIRED: each original branch needs its own fulfillment judgement, separate from activation and other findings.'), { code: 'REVIEW_CONDITION_ASSESSMENT_REQUIRED' });
    const window = assessment?.evidenceKind === 'PROCESS_WINDOW' ? bindConditionProcessWindow({ entries, cursor,
      afterCallId: assessment.afterCallId, complete: processSource?.complete === true, source: processSource,
      readComplete: index => refs.some(c => c.readProof.owner === 'PROCESS' && c.readProof.fullFile === true
        && c.readProof.processCursor === cursor && c.readProof.processIndex === index) }) : undefined;
    const processPass = state === 'ACTIVE' && verdict === 'PASS' && assessment?.evidenceKind === 'PROCESS_EVENT'
      && (node.verificationTarget ?? 'PROCESS') === 'PROCESS'
      && !semanticUnresolved && !review.checkerError && !review.findings?.length;
    let disclosure;
    const processDisclosure = () => {
      if (disclosure) return disclosure;
      const basis = refs.find(c => c.readProof.owner === 'BASIS' && c.readProof.fullFile === true
        && c.readProof.basisComplete === true && c.readProof.skillGraphDigest === graphDigest
        && c.readProof.processCursor === cursor && typeof c.readProof.skillSourceDigest === 'string'
        && (!graph.sourceContract || c.readProof.skillSourceDigest === graph.sourceContract.sourceDigest));
      const current = new Set(refs.filter(c => c.readProof.owner === 'PROCESS' && c.readProof.fullFile === true
        && c.readProof.skillGraphDigest === graphDigest && c.readProof.processCursor === cursor
        && basis && c.readProof.skillSourceDigest === basis.readProof.skillSourceDigest
        && Number.isSafeInteger(c.readProof.processIndex)).map(c => c.readProof.processIndex));
      const calls = processToolEvidence(snapshot), counts = new Map();
      for (const call of calls) counts.set(call.toolUseId, (counts.get(call.toolUseId) ?? 0) + 1);
      const paired = call => counts.get(call.toolUseId) === 1 && ['RETURNED', 'ERROR'].includes(call.status)
        && Number.isSafeInteger(call.invocationIndex) && Number.isSafeInteger(call.resultIndex)
        && call.invocationIndex >= 0 && call.resultIndex > call.invocationIndex && call.resultIndex < entries.length;
      const selected = calls.filter(call => call.toolUseId === assessment.afterCallId
        || current.has(call.invocationIndex) || current.has(call.resultIndex));
      const anchor = assessment.afterCallId == null || calls.some(call => call.toolUseId === assessment.afterCallId && paired(call));
      const sameContext = Boolean(basis && processSource?.complete === true && processSource.cursor === cursor
        && refs.every(c => ['BASIS', 'PROCESS'].includes(c.readProof.owner) && c.readProof.fullFile === true
          && c.readProof.skillGraphDigest === graphDigest && c.readProof.processCursor === cursor
          && c.readProof.skillSourceDigest === basis.readProof.skillSourceDigest));
      const uniquePairs = Boolean(anchor && selected.length && selected.every(paired));
      const missing = sameContext && uniquePairs ? [...new Set(selected.flatMap(call => [call.invocationIndex, call.resultIndex]))]
        .sort((a, b) => a - b).filter(index => !current.has(index)).map(index => `execution/${index}`) : [];
      return disclosure = { recoverable: sameContext && uniquePairs && missing.length > 0,
        detail: { field: `/conditionalAssessments/${assessments.indexOf(item)}/${anchor ? 'actualEvidence' : 'conditionAssessment/afterCallId'}`,
          graphDigest, processCursor: cursor,
          problem: !sameContext ? 'Complete current original basis/cursor is unavailable; keep uncertainty.'
            : !uniquePairs ? 'No uniquely attributable current pair; use inventory rather than guessing.'
              : 'Read the missing original invocation/result pages completely; result-only disclosure cannot prove an action.',
          navigationOnly: true, recoverWith: { tool: 'rc_skill_care', action: 'inventory', prefix: 'execution/', offset: 0 },
          missingOriginalIds: missing.slice(0, 16), missingCount: missing.length, omittedCount: Math.max(0, missing.length - 16),
          notice: 'Only canonical execution/N IDs from current unique pairs are previewed. Follow inventory nextOffset and original-page nextOffset; navigation and cited-but-unread IDs grant no proof. Submit a complete fresh review or keep UNKNOWN/checkerError.' } };
    };
    const conditionFailure = error => {
      if (processPass && error.code === 'REVIEW_CONDITION_EVIDENCE_UNAVAILABLE') {
        error.message += ' ' + JSON.stringify(processDisclosure().detail);
        return error;
      }
      if (!window || window.complete) return error;
      const call = processToolEvidence(snapshot).find(call => call.toolUseId === assessment.afterCallId);
      const missing = call ? entries.slice(call.invocationIndex).flatMap((_, i) => {
        const index = call.invocationIndex + i;
        return refs.some(c => c.readProof.owner === 'PROCESS' && c.readProof.fullFile === true
          && c.readProof.processCursor === cursor && c.readProof.processIndex === index) ? [] : [`execution/${index}`];
      }) : [];
      error.message += ' ' + JSON.stringify({
        field: `/conditionalAssessments/${assessments.indexOf(item)}/conditionAssessment/afterCallId`,
        problem: !call ? 'Use an actual callId, not an execution document ID.' : ['PENDING', 'AMBIGUOUS'].includes(call.status)
          ? 'The actual invocation/result identity is pending or ambiguous.' : 'The complete current original window requires genuine persisted full-file reads.',
        navigationOnly: true, recoverWith: { tool: 'rc_skill_care', action: 'inventory', prefix: 'execution/', offset: 0 },
        missingOriginalIds: missing.slice(0, 16), missingCount: missing.length,
        notice: 'Follow nextOffset, read invocation and all records through captured boundary. Navigation never proves activation or fulfillment; otherwise report UNKNOWN/checkerError.',
      });
      return error;
    };
    const context = {
      policy: CONDITIONAL_REVIEW_POLICY_VERSION, objectId: skillConditionKey(node), currentCursor: cursor,
      basisComplete: refs.some(c => c.readProof.basisComplete === true && c.readProof.owner === 'BASIS'),
      targetEvidence: refs.some(c => c.readProof.fullFile && c.readProof.activationFact),
      processEvidence: refs.some(c => c.readProof.owner === 'PROCESS'), requiresProcessWindow: requiresConditionWindow(node), processWindow: window,
    };
    // First validate state/verdict consistency. Fulfillment is per branch;
    // an unrelated finding cannot make another condition a DEVIATION or hide
    // missing evidence. The semantic proof subject comes from the source
    // interpretation, never a run/verify word match.
    let binding;
    try { binding = validateConditionalAssessment({ assessment, verdict, context }); }
    catch (error) { throw conditionFailure(error); }
    if (state === 'ACTIVE' && ['PASS', 'DEVIATION'].includes(verdict)) {
      const subject = node.verificationTarget ?? 'PROCESS';
      const observed = subject === 'PROCESS' ? refs.some(c => c.readProof.owner === 'PROCESS'
        && (c.readProof.processActionEvidence || c.readProof.executionEvidence))
        : refs.some(c => c.readProof.owner === (subject === 'IMPLEMENTATION' ? 'SOURCE' : 'ARTIFACT') && c.readProof.fullFile);
      const attributable = verdict !== 'DEVIATION' || (item.findingKeys ?? []).some(key => review.findings.some(f => f.deviationKey === key
        && (f.violatedGroundTruthIds ?? []).some(id => [node.constraintId, `${graph.skillId}:${node.constraintId}`, skillConditionKey(node)].includes(id))));
      if (!observed || !attributable) {
        if (!observed && processPass && processDisclosure().recoverable)
          throw conditionFailure(Object.assign(new Error('REVIEW_CONDITION_EVIDENCE_UNAVAILABLE: Complete original basis and observed current target/process evidence are required.'),
            { code: 'REVIEW_CONDITION_EVIDENCE_UNAVAILABLE' }));
        verdict = 'UNVERIFIED'; unresolved = true;
        binding = validateConditionalAssessment({ assessment, verdict, context });
      }
    }
    if (binding) bindings.push({ ...binding, judgement: verdict });
    unresolved ||= verdict === 'UNVERIFIED' || ['UNKNOWN', 'PENDING_REQUIRED_TRIGGER'].includes(state);
  }
  return { bindings, unresolved };
}

const skillReviewEvidenceDigest = ({ snapshot, skillSource, groundTruth, graph }) => sha256({
  snapshot: snapshot?.digest, skill: skillSource?.digest, truth: groundTruth?.digest,
  graph: graph?.digest, graphVersion: graph?.version, conditionalPolicy: CONDITIONAL_REVIEW_POLICY_VERSION,
  skillSourceContract: SKILL_SOURCE_CONTRACT_VERSION });

async function assessWatcher({
  input,
  projectRoot,
  sessionCwd,
  task,
  watcher,
  runtimeV2,
  reviewerFactory,
  currentTurn,
  forcePartial,
  groundTruthRefresh = null,
  skillSource = null,
  snapshot,
}) {
  const skillRoot = path.join(taskDirectory(projectRoot, task.taskId), "skills", safeId(watcher.skillId));
  const currentTask = await findTask({ projectRoot, sessionId: input.session_id, explicitTaskId: task.taskId });
  const watcherContext = { guard: decisionGuard(currentTask ?? task), signal: reviewerFactory.reviewAbortSignal,
    deadlineAt: reviewerFactory.reviewDeadlineAt ?? Infinity };
  const mutateAssessment = async updater => {
    const updated = await mutateWatcher(projectRoot, task.taskId, watcher.watcherId, updater, watcherContext);
    if (!updated) throw Object.assign(new Error('The Skill assessment lost its original task, deadline or cancellation scope.'), { code: 'SKILL_REVIEW_STALE' });
    return updated;
  };
  if (groundTruthRefresh?.unverified) {
    await mutateAssessment((active) => {
      active.lastCheckTurn = currentTurn;
      active.evaluationCount += 1;
      if (forcePartial) active.status = "UNVERIFIED";
      else active.nextCheckTurn += runtimeV2.skillCorrection.completionCheckIntervalTurns;
    });
    return { feedback: null, status: forcePartial ? "UNVERIFIED" : "ACTIVE", error: groundTruthRefresh.error };
  }
  let handle = groundTruthRefresh?.handle ?? null;
  try {
    const skillGroundTruth = await readJson(path.join(skillRoot, "skill-ground-truth.json"));
    if (!skillGroundTruth) {
      await mutateWatcher(projectRoot, task.taskId, watcher.watcherId, (active) => {
        active.status = "UNVERIFIED_RECOVERY";
      });
      return { feedback: null, status: "UNVERIFIED" };
    }
    const request = {
      schemaVersion: "runtime-corrector.skill-review-request.v2",
      instructions: [
        ...PROCESS_REVIEW_INSTRUCTIONS,
        CONDITIONAL_REVIEW_INSTRUCTIONS,
        SKILL_WORKFLOW_SCOPE_INSTRUCTION,
        'For every original unit, including DESCRIPTION/PERMISSION/ADVISORY units that do not project to hard metrics, independently review sourceInterpretation against its complete original body, headings, exceptions and context. sourceOwnership is program-bound: HEADING_SCOPE owns that heading once with its full section as qualification/context; BODY owns its body text. A heading is not automatically mandatory or descriptive. Preserve exceptions in later paragraphs and check their effect on the original heading; never repeat the heading obligation under every body unit. In particular inspect ALL computed contextSpans and the explicit remainderDisposition/remainderReason: positions are a mechanical complement, never proof that an omitted mandatory duty is optional. Body duties in a heading scope context must remain in their own BODY unit. Return sourceInterpretationReviews with constraintId, disposition CONFIRMED/CONFLICT/UNCERTAIN, concise reason and actualEvidence. The graph interpretation is a fallible semantic proposal; its source hash proves identity, not normativity. A wrongly softened mandatory action, strengthened permission or mistaken internal/external scope is CONFLICT/UNCERTAIN and a checker problem, never empty-findings PASS. Do not invent a business deviation from the graph misinterpretation alone. MIXED does not require its permission/advice clauses to be executed.',
        'For every sourceInterpretation.externalConditions branch return conditionalAssessments with its parent constraintId, exact conditionId, conditionAssessment and actualEvidence using acknowledged rc_skill_care original IDs (skill/SKILL.md, execution/N). This includes COMPOUND parents whose applicabilityKind is CURRENT_TASK; one inactive branch never excludes their independent current duties. Internal implementation branches remain current implementation duties and cannot be exempted merely because no invalid input was supplied. Legacy conditional nodes without branch IDs retain their node assessment. Read the original Skill and relevant evidence pages completely; notes, source paths, quoted text and tag-only assertions cannot certify disclosure. A negative event window must include its invocation and every original record through completion. Derived graph labels/dependencies never add authority or ordering beyond the complete original source.',
        "First classify completion as COMPLETED or NOT_COMPLETED.",
        "When NOT_COMPLETED and forcePartial is false, return no findings.",
        "When completed, assess required steps, ordering constraints, conditions, inputs, outputs, and prohibited behavior using session evidence.",
        "When forcePartial is true, assess executed steps and activated constraints. A Stop event or completion/abandonment claim activates completion-dependent obligations for assessment, even when completionStatus is NOT_COMPLETED; it does not prove that a required action was omitted, failed, or performed in the wrong order.",
        "Report a finding only for an attributable observed contradiction of an original mandatory constraint, such as a matched command/result showing the required verification failed, or the same required actions/resources demonstrably executed in the prohibited order. Keep those concrete violations as findings even at Stop; future unactivated steps are not deviations.",
        "Findings drive the next correction and must describe currently unresolved obligations. When the original Skill permits repair or newest-result acceptance, distinguish a recorded historical failure from the current repaired execution. A previously reported false completion that was explicitly acknowledged or withdrawn, followed by the required repair and a fresh successful verification of the current files, is not a new unresolved completion-claim finding when the latest completion claim is accurate. Preserve the historical events and prior evaluations; do not demand undoing the past. This does not waive an irreversible original prohibition or ordering constraint, erase independent unresolved violations, or infer recovery from a claim or code edit alone. If original recovery authority or attributable fresh evidence is insufficient, retain checkerError/UNVERIFIED.",
        "An orphan tool_result, missing invocation, pending/ambiguous result, or missing attribution cannot establish either successful execution or nonexecution. If an activated mandatory obligation has insufficient evidence for a reliable compliance or concrete-deviation assessment, report the unresolved basis in checkerError instead of turning missing evidence alone into a business finding or an empty-findings PASS. Retain independently supported contradictions of other obligations in findings; keep uncertain or unreliable proposed findings out of findings. Do not request code changes or repeat actions merely to erase an unproved historical violation.",
        `Use only these rootCauseId values: ${[...ROOT_CAUSE_IDS].join(", ")}.`,
      ],
      taskId: task.taskId,
      watcher,
      currentTurn,
      forcePartial,
      terminationAttempt: input.hook_event_name === "Stop" ? {
        attempted: true,
        lastAssistantMessage: input.last_assistant_message ?? null,
      } : null,
      skillGroundTruthPath: path.join(skillRoot, "skill-ground-truth.json").replaceAll("\\", "/"),
      canonicalConditionalTargets: skillReviewKeyNavigation(skillGroundTruth, '/conditionalAssessments',
        skillConditionalTargets(skillGroundTruth).map(skillConditionKey)),
      processToolEvidence: processToolEvidence(snapshot),
    };
    const originHandle = handle;
    handle = null; // handoff consumes the source, including on failure.
    handle = await reviewerFactory.handoff({
      originHandle,
      projectRoot,
      sessionCwd,
      taskId: task.taskId,
      parentSessionId: input.session_id,
      role: "skill-reviewer",
      reviewer: runtimeV2.reviewers.skillReviewer,
      schema: SKILL_REVIEW_SCHEMA,
      request,
      evidence: { snapshot, groundTruth: groundTruthRefresh?.current, skillGroundTruth, skillSource },
    });
    let review = handle.result, conditionCheck;
    for (let attempt = 0; ; attempt++) {
      try {
        conditionCheck = validateSkillConditionalReview({ review, graph: skillGroundTruth,
          citations: await handle.getSourceCitations?.(review) ?? handle.sourceCitations ?? [], snapshot,
          processSource: await captureConditionSnapshot(snapshot, input.transcript_path) });
        break;
      } catch (error) {
        if (!handle.followUp || attempt >= (runtimeV2.reviewers.skillReviewer.formatRepairAttempts ?? 2)) throw error;
        review = await handle.followUp({ prompt: `${error.message}\n${SKILL_REVIEW_REPAIR_INSTRUCTION}`, nextSchema: SKILL_REVIEW_SCHEMA });
      }
    }
    const conditionBindings = conditionCheck.bindings;
    if (review.sourceInterpretationReviews?.some(item => item.disposition === 'CONFLICT'))
      await mutateAssessment(active => { active.sourceInterpretationDispute = skillGroundTruth.digest; });
    if (conditionCheck.unresolved && !review.checkerError) review = { ...review, checkerError: 'Original source interpretation or conditional activation remains unresolved.' };
    for (const binding of conditionBindings) if (binding.window && !await conditionWindowCurrent(binding.window))
      throw new Error('REVIEW_CONDITION_WINDOW_STALE');
    const scope = decisionScope.getStore();
    if (scope && conditionBindings.some(binding => binding.window)) {
      const previous = scope.context.evidenceMatches;
      scope.context.evidenceMatches = async (...args) => (!previous || await previous(...args))
        && (await Promise.all(conditionBindings.filter(b => b.window).map(b => conditionWindowCurrent(b.window)))).every(Boolean);
    }
    const verificationIncomplete = Boolean(review.checkerError?.trim());
    if (verificationIncomplete && review.findings.length === 0) {
      const evaluationId = uniqueId("evaluation");
      await atomicWriteJson(path.join(skillRoot, "evaluations", `${evaluationId}.json`),
        { evaluationId, watcherId: watcher.watcherId, currentTurn, forcePartial, status: "UNVERIFIED", review, conditionBindings });
      throw new Error(`Skill checker could not establish a reliable assessment: ${review.checkerError}`);
    }
    if (review.completionStatus === "NOT_COMPLETED" && !forcePartial) {
      await mutateAssessment((active) => {
        active.lastCheckTurn = currentTurn;
        active.nextCheckTurn += runtimeV2.skillCorrection.completionCheckIntervalTurns;
        active.evaluationCount += 1;
        active.lastEvidenceDigest = skillReviewEvidenceDigest({ snapshot, skillSource, groundTruth: groundTruthRefresh?.current, graph: skillGroundTruth });
        active.sourceInterpretationChecked = !verificationIncomplete;
        active.skillGraphDigest = skillGroundTruth.digest;
      });
      await recordObservation(projectRoot, task.taskId, { type: 'SKILL_REVIEW_RESULT', sessionId: input.session_id,
        hookEventId: eventId(input), turnId: currentTurn, skillId: watcher.skillId, watcherId: watcher.watcherId,
        status: 'ACTIVE', review, feedback: null, baselineVersion: task.groundTruth.version });
      return { feedback: null, status: "ACTIVE", review };
    }
    // Loop bound (see the ARTIFACT path): findings whose family has already
    // been delivered maxDeliveriesPerFamily times are parked and excluded from
    // the message. Computed before the mutation because the state read is async
    // and the mutation callback is not.
    const parkedFamilies = await loopBoundedFamilyIds({
      projectRoot,
      taskId: task.taskId,
      maxDeliveries: runtimeV2?.deviationLoop?.maxDeliveriesPerFamily ?? null,
    });
    const speakableReview = parkedFamilies.size === 0
      ? review
      : {
        ...review,
        findings: review.findings.filter((finding) => !parkedFamilies.has(
          familyIdForFinding({ taskId: task.taskId, finding }),
        )),
      };
    let feedback = null;
    await mutateAssessment((active, state) => {
      active.lastCheckTurn = currentTurn;
      active.evaluationCount += 1;
      active.status = review.findings.length > 0 ? "DEVIATION" : "PASS";
      active.conditionalReviewPolicy = CONDITIONAL_REVIEW_POLICY_VERSION;
      active.skillSourceContract = SKILL_SOURCE_CONTRACT_VERSION;
      active.sourceInterpretationChecked = !verificationIncomplete;
      active.verificationIncomplete = verificationIncomplete;
      active.skillGraphDigest = skillGroundTruth.digest;
      if (!verificationIncomplete) active.sourceInterpretationDispute = null;
      active.lastEvidenceDigest = skillReviewEvidenceDigest({ snapshot, skillSource, groundTruth: groundTruthRefresh?.current, graph: skillGroundTruth });
      active.completedAt = new Date().toISOString();
      if (speakableReview.findings.length > 0) {
        const budget = state.skillFeedbacks[watcher.skillId] ?? {
          epochId: state.correctionEpoch.id,
          count: 0,
        };
        if (budget.epochId !== state.correctionEpoch.id) {
          budget.epochId = state.correctionEpoch.id;
          budget.count = 0;
        }
        if (budget.count < runtimeV2.skillCorrection.maxFeedbacksPerSkill) {
          budget.count += 1;
          feedback = skillFeedbackText(watcher.skillId, speakableReview, active);
        }
        state.skillFeedbacks[watcher.skillId] = budget;
      }
    });
    const evaluationId = uniqueId("evaluation");
    await atomicWriteJson(
      path.join(skillRoot, "evaluations", `${evaluationId}.json`),
      { evaluationId, watcherId: watcher.watcherId, currentTurn, forcePartial, review, conditionBindings,
        ...(verificationIncomplete ? { status: 'DEVIATION', verificationIncomplete: true } : {}) },
    );
    if (review.findings.length > 0) {
      await recordDeviationFindings({
        projectRoot,
        taskId: task.taskId,
        pipeline: "SKILL",
        findings: review.findings,
        groundTruthVersion: groundTruthRefresh?.current?.version ?? null,
        targetSnapshotHash: skillGroundTruth.digest ?? skillGroundTruth.skillDigest ?? null,
        evaluationId,
        // delivered tracks ACTUAL emission, not mode: the per-skill feedback
        // budget can suppress the message even outside observe-only mode.
        delivered: runtimeV2.shadowMode !== true && feedback !== null,
        maxDeliveriesPerFamily: runtimeV2?.deviationLoop?.maxDeliveriesPerFamily ?? null,
      });
    }
    await recordObservation(projectRoot, task.taskId, { type: 'SKILL_REVIEW_RESULT', sessionId: input.session_id,
      hookEventId: eventId(input), turnId: currentTurn, skillId: watcher.skillId, watcherId: watcher.watcherId,
      status: review.findings.length > 0 ? 'DEVIATION' : 'PASS', review, feedback,
      conditionBindings,
      baselineVersion: task.groundTruth.version, shadowMode: runtimeV2.shadowMode === true,
      ...(verificationIncomplete ? { verificationIncomplete: true } : {}) });
    return { feedback, status: review.findings.length > 0 ? "DEVIATION" : "PASS", review,
      ...(verificationIncomplete ? { verificationIncomplete: true } : {}) };
  } catch (error) {
    await appendTaskJournal(projectRoot, task.taskId, {
      type: "SKILL_REVIEW_FAILED",
      watcherId: watcher.watcherId,
      error: error.message,
    });
    await mutateWatcher(projectRoot, task.taskId, watcher.watcherId, (active) => {
        if (forcePartial) active.status = "UNVERIFIED";
        active.sourceInterpretationChecked = false;
        active.verificationIncomplete = true;
        active.lastEvidenceDigest = null;
      }, watcherContext);
    return { feedback: null, status: "UNVERIFIED", error };
  } finally {
    if (handle) await handle.close();
  }
}

async function checkDueWatchers(context) {
  const due = [];
  let currentTurn;
  const stopping = context.input.hook_event_name === 'Stop';
  if (stopping) {
    const records = await skillDocuments(context.projectRoot, context.task.taskId).catch(error => {
      if (error instanceof SyntaxError) return []; throw error;
    });
    const known = new Map(records.map(graph => [graph.skillId, { digest: graph.skillDigest, identity: graph.sourceContract?.sourceIdentity }]));
    for (const adopted of context.task.groundTruth.sharedBasis?.adoptedSkills ?? []) known.set(adopted.skillId, { digest: adopted.digest, identity: adopted.sourceIdentity });
    let latest = await findTask({ projectRoot: context.projectRoot, sessionId: context.input.session_id, explicitTaskId: context.task.taskId });
    for (const [skillId, source] of known) if (!Object.values(latest?.watchers ?? {}).some(w => w.skillId === skillId)) {
      await startSkillWatcher({ ...context, task: latest ?? context.task, skillId, source });
      latest = await findTask({ projectRoot: context.projectRoot, sessionId: context.input.session_id, explicitTaskId: context.task.taskId });
    }
  }
  await withTaskState({ projectRoot: context.projectRoot, taskId: context.task.taskId }, (state) => {
    currentTurn = state.turns.total;
    due.push(...Object.values(state.watchers).filter((watcher) => (
      watcher.status === "ACTIVE" && (stopping || currentTurn >= watcher.nextCheckTurn)
        || stopping && (['UNVERIFIED', 'UNVERIFIED_RECOVERY'].includes(watcher.status)
          || ['PASS', 'DEVIATION'].includes(watcher.status))
    )));
  });
  const feedback = [];
  let error = null;
  let activeTask = context.task;
  for (const watcher of due) {
    let groundTruthRefresh = null;
    let skillSource = null;
    const directory = await resolveSkillDirectory({
      skillId: watcher.skillId,
      projectRoot: context.projectRoot,
      pluginRoot: context.pluginRoot,
      configuredRoots: context.runtimeV2.skillCorrection.skillRoots,
      sourceIdentity: watcher.sourceIdentity ?? retainedSkillSourceIdentity(context.task, watcher.skillId),
    });
    if (directory) {
      const source = await scanSkillDirectory(directory, { sourceIdentity: watcher.sourceIdentity ?? retainedSkillSourceIdentity(context.task, watcher.skillId) });
      skillSource = source;
      if (context.preparedGroundTruthRefresh) {
        // Stop already aligned every adopted graph in this same guarded
        // attempt. Rebind that graph against the current original instead of
        // launching another global extraction before its task head commits.
        groundTruthRefresh = await currentSkillGroundTruth(context.projectRoot, context.task.taskId, watcher.skillId, source)
          ? context.preparedGroundTruthRefresh : { ...context.preparedGroundTruthRefresh, unverified: true,
            error: new Error('The prepared original Skill graph changed before semantic review.') };
      } else groundTruthRefresh = await refreshGroundTruth({
        pluginRoot: context.pluginRoot,
        input: context.input,
        projectRoot: context.projectRoot,
        sessionCwd: context.sessionCwd,
        task: context.task,
        runtimeV2: context.runtimeV2,
        reviewerFactory: context.reviewerFactory,
        skill: { skillId: watcher.skillId, directory, source },
        snapshot: context.snapshot,
      });
    } else {
      groundTruthRefresh = {
        task: activeTask,
        unverified: true,
        error: new Error(`Skill source is no longer available: ${watcher.skillId}`),
      };
      await appendTaskJournal(context.projectRoot, activeTask.taskId, {
        type: "SKILL_SOURCE_UNRESOLVED_DURING_WATCH",
        watcherId: watcher.watcherId,
        skillId: watcher.skillId,
      });
    }
    if (groundTruthRefresh.task.taskId !== context.task.taskId) {
      activeTask = groundTruthRefresh.task;
      if (groundTruthRefresh.handle) await groundTruthRefresh.handle.close();
      break;
    }
    // Validate current sources and requirements before deduplicating a retry.
    // Stop and the watch deadline always assess completion prerequisites.
    const graph = await readJson(path.join(taskDirectory(context.projectRoot, context.task.taskId), 'skills', safeId(watcher.skillId), 'skill-ground-truth.json'));
    const basisDigest = skillReviewEvidenceDigest({ snapshot: context.snapshot, skillSource, groundTruth: groundTruthRefresh.current, graph });
    const checkedCurrent = watcher.sourceInterpretationChecked === true && watcher.conditionalReviewPolicy === CONDITIONAL_REVIEW_POLICY_VERSION
      && watcher.skillSourceContract === SKILL_SOURCE_CONTRACT_VERSION && watcher.skillGraphDigest === graph?.digest;
    if (!groundTruthRefresh.unverified && watcher.lastEvidenceDigest === basisDigest
      && (stopping ? checkedCurrent && watcher.status === 'PASS' : currentTurn < watcher.maxTurn)) {
      if (groundTruthRefresh.handle) await groundTruthRefresh.handle.close();
      await mutateWatcher(context.projectRoot, context.task.taskId, watcher.watcherId, active => {
        active.nextCheckTurn = currentTurn + context.runtimeV2.skillCorrection.completionCheckIntervalTurns;
      });
      continue;
    }
    const assessment = await assessWatcher({
      ...context,
      watcher,
      currentTurn,
      forcePartial: context.input.hook_event_name === "Stop" || currentTurn >= watcher.maxTurn,
      groundTruthRefresh,
      skillSource,
    });
    if (watcher.pendingSelection && !groundTruthRefresh.unverified && !assessment.verificationIncomplete
      && ['PASS', 'DEVIATION'].includes(assessment.status)) {
      const latest = await findTask({ projectRoot: context.projectRoot, sessionId: context.input.session_id, explicitTaskId: activeTask.taskId });
      await mutateWatcher(context.projectRoot, activeTask.taskId, watcher.watcherId, row => {
        if (row.sourceInterpretationChecked === true && !row.verificationIncomplete
          && row.pendingSelection?.pointer.digest === watcher.pendingSelection.pointer.digest) delete row.pendingSelection;
      }, { guard: decisionGuard(latest), signal: context.reviewerFactory.reviewAbortSignal,
        deadlineAt: context.reviewerFactory.reviewDeadlineAt ?? Infinity });
    }
    if (groundTruthRefresh.unverified || assessment.status === 'UNVERIFIED' || assessment.verificationIncomplete)
      error ??= groundTruthRefresh.error ?? assessment.error ?? new Error('Skill completion basis is unverified');
    if (assessment.feedback) feedback.push(assessment.feedback);
  }
  return { feedback, task: activeTask, error };
}

async function persistEvaluation(projectRoot, taskId, kind, value) {
  const evaluationId = uniqueId(kind);
  const filePath = path.join(taskDirectory(projectRoot, taskId), "evaluations", `${evaluationId}.json`);
  await atomicWriteJson(filePath, { evaluationId, ...value });
  return { evaluationId, filePath };
}

function metricDeviationFindings(report) {
  return report.blockingObjects.map((object) => ({
    deviationKey: `metric:${object.metricId}:${object.sourceId}`,
    rootCauseId: new Set(["UNVERIFIED", "EXTERNAL_BLOCKED"]).has(object.judgement)
      ? "STALE_OR_UNBOUND_EVIDENCE"
      : object.metricId === "M08"
        ? "SKILL_REQUIRED_STEP_OMITTED"
        : "REQUIREMENT_OMITTED",
    severity: "error",
    reason: object.reason,
    actualEvidence: object.evidence ?? [],
    expectedConstraint: object.description,
    violatedGroundTruthIds: [object.sourceId],
  }));
}

function semanticArtifactFindings(review) {
  return (review?.findings ?? []).map((finding) => ({
    deviationKey: `artifact:${finding.ruleId}:${finding.path}`,
    rootCauseId: ROOT_CAUSE_IDS.has(finding.rootCauseId) ? finding.rootCauseId : "OTHER",
    severity: finding.severity,
    reason: finding.message,
    actualEvidence: finding.evidence ?? [],
    expectedConstraint: "The artifact must satisfy the frozen Ground Truth and configured review criteria.",
    violatedGroundTruthIds: finding.violatedGroundTruthIds ?? [],
    suggestedNextAction: finding.suggestion ?? null,
  }));
}

function passedMetricSourceIds(report) {
  const objects = report.metrics.flatMap((metric) => metric.objects);
  const unresolved = new Set(objects.filter((object) => object.judgement !== "PASS")
    .map((object) => object.sourceId));
  return objects
    .filter((object) => object.judgement === "PASS" && !unresolved.has(object.sourceId))
    .map((object) => object.sourceId);
}

export function stopAssessmentBlocks(report, blockingFindings) {
  return report.status === "CHECKER_ERROR"
    || report.blockingObjects.length > 0
    || blockingFindings.length > 0;
}

export async function finalizeArtifactRuntimeV2({
  projectRoot,
  taskId,
  artifactReviewContext,
  semanticReview,
  // Compiled runtime config. Optional: this path is also driven directly by the
  // post-tool-use hook and by tests. Absent => no per-family loop bound.
  runtimeV2 = null,
  // Caller (post-tool-use hook) passes !shadowMode. This finalize path runs
  // OUTSIDE the handleRuntimeV2Event observe-only wrapper, so both the
  // delivered stamp and the feedback suppression must be handled here
  // explicitly.
  delivered = false,
}) {
  if (!artifactReviewContext) return { feedback: null, metricReport: null };
  try {
    if (!artifactReviewContext.population) {
      const findings = semanticArtifactFindings(semanticReview);
      const persisted = await persistEvaluation(projectRoot, taskId, "artifact", {
        artifact: artifactReviewContext.artifact,
        groundTruthVersion: artifactReviewContext.groundTruthVersion,
        transcriptDigest: artifactReviewContext.transcriptDigest,
        transcriptCursor: artifactReviewContext.transcriptCursor,
        semanticFindings: findings,
        metricReport: null,
      });
      await recordDeviationFindings({
        projectRoot,
        taskId,
        pipeline: "ARTIFACT",
        findings,
        groundTruthVersion: artifactReviewContext.groundTruthVersion,
        targetSnapshotHash: artifactReviewContext.artifact?.snapshotHash ?? null,
        evaluationId: persisted.evaluationId,
        delivered,
        maxDeliveriesPerFamily: runtimeV2?.deviationLoop?.maxDeliveriesPerFamily ?? null,
      });
      return { feedback: null, metricReport: null, persisted };
    }
    const metricReport = calculateMetricReport({
      population: artifactReviewContext.population,
      judgements: semanticReview?.metricObjectJudgements ?? [],
      metricIds: artifactReviewContext.metricIds,
    });
    const persisted = await persistEvaluation(projectRoot, taskId, "artifact", {
      artifact: artifactReviewContext.artifact,
      groundTruthVersion: artifactReviewContext.groundTruthVersion,
      transcriptDigest: artifactReviewContext.transcriptDigest,
      transcriptCursor: artifactReviewContext.transcriptCursor,
      metricReport,
    });
    // Closure before recording: see the STOP path — prevents same-assessment
    // delivered→fixed laundering into critic-attributed closures.
    await markMetricPassesFixed({
      projectRoot,
      taskId,
      passedObjectIds: passedMetricSourceIds(metricReport),
    });
    await recordDeviationFindings({
      projectRoot,
      taskId,
      pipeline: "ARTIFACT",
      findings: [
        ...semanticArtifactFindings(semanticReview),
        ...metricDeviationFindings(metricReport),
      ],
      groundTruthVersion: artifactReviewContext.groundTruthVersion,
      targetSnapshotHash: artifactReviewContext.artifact?.snapshotHash ?? null,
      evaluationId: persisted.evaluationId,
      delivered,
      maxDeliveriesPerFamily: runtimeV2?.deviationLoop?.maxDeliveriesPerFamily ?? null,
    });
    // Loop bound: a family already delivered maxDeliveriesPerFamily times is
    // parked. It stays OPEN and keeps being observed and journaled, but it is
    // no longer re-injected — otherwise flag -> deliver -> edit -> re-flag can
    // cycle indefinitely (flower T1 2.5.0: one family re-flagged 7 times).
    // Read AFTER recordDeviationFindings so this evaluation's own observation
    // is included in the count.
    const parkedFamilies = await loopBoundedFamilyIds({
      projectRoot,
      taskId,
      maxDeliveries: runtimeV2?.deviationLoop?.maxDeliveriesPerFamily ?? null,
    });
    const speakableObjects = parkedFamilies.size === 0
      ? metricReport.blockingObjects
      : metricReport.blockingObjects.filter((object) => !parkedFamilies.has(
        familyIdForFinding({
          taskId,
          finding: {
            deviationKey: `metric:${object.metricId}:${object.sourceId}`,
            rootCauseId: new Set(["UNVERIFIED", "EXTERNAL_BLOCKED"]).has(object.judgement)
              ? "STALE_OR_UNBOUND_EVIDENCE"
              : object.metricId === "M08"
                ? "SKILL_REQUIRED_STEP_OMITTED"
                : "REQUIREMENT_OMITTED",
            violatedGroundTruthIds: [object.sourceId],
          },
        }),
      ));
    // Observe-only mode: record everything above, but never speak to the
    // developer.
    const feedback = delivered && speakableObjects.length > 0
      ? [
          "[runtime-corrector] Stage checkpoint metric deviations:",
          ...speakableObjects.map((object) => `- ${object.objectId}: ${object.reason}`),
          `Full report: ${persisted.filePath.replaceAll("\\", "/")}`,
        ].join("\n")
      : null;
    return { feedback, metricReport, persisted };
  } catch (error) {
    await appendTaskJournal(projectRoot, taskId, {
      type: "ARTIFACT_METRIC_FINALIZATION_FAILED",
      error: error.message,
    });
    return { feedback: null, metricReport: null, error };
  }
}

async function closeStopReviewerSafely(handle, projectRoot, taskId) {
  if (typeof handle?.close !== 'function') return;
  let timer;
  try {
    await Promise.race([Promise.resolve().then(() => handle.close()), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Stop reviewer cleanup exceeded its bounded grace period.')), 250);
    })]);
  } catch (error) {
    await appendTaskJournal(projectRoot, taskId, { type: 'STOP_REVIEWER_CLOSE_FAILED', error: error.message }).catch(() => {});
  } finally { clearTimeout(timer); }
}

async function reviewPartialImplementation({ projectRoot, task, input, snapshot, refresh, factory, runtimeV2, excludedEvidencePaths }) {
  const baseline = refresh.current;
  const fromAudit = Boolean(refresh.diagnosticClaims?.length);
  const claims = fromAudit ? refresh.diagnosticClaims : baseline.version > 0
    ? baseline.claims.filter(claim => claim.status === 'ACTIVE' && claim.verificationTarget === 'IMPLEMENTATION'
      && claim.applicabilityKind === 'CURRENT_TASK') : [];
  if (!claims.length) return null;
  const groundTruth = { ...baseline, claims };
  const reviewPolicy = resolveStopReviewPolicy(runtimeV2.stopCorrection);
  const full = await buildMetricPopulation({ projectRoot, taskId: task.taskId, groundTruth, reviewPolicy, persist: false });
  const owned = implementationPopulation(full, { groundTruth, projectRoot }).population;
  const population = { ...owned, metrics: { M12: owned.metrics.M12, M16: owned.metrics.M16 } };
  const objects = Object.values(population.metrics).flat();
  if (!objects.length) return null;
  let handle;
  try {
    handle = await factory({ projectRoot, taskId: task.taskId, parentSessionId: input.session_id,
      role: 'stop-reviewer', reviewer: runtimeV2.reviewers.stopReviewer, schema: STOP_REVIEW_SCHEMA,
      excludedEvidencePaths, evidence: { snapshot, groundTruth },
      request: { schemaVersion: 'runtime-corrector.workspace-stop.v1', hook: sanitizedHookInput(input), population,
        processSnapshotPath: input.transcript_path, workflowStages: [], workflowArtifacts: [],
        fixedStopClassification: { stopClassification: 'TASK_COMPLETE', stage: null },
        classificationContract: 2, fileQualityReviewEnabled: false, reviewScope: { kind: 'workspace-stop' },
        instructions: ['This is a read-only diagnostic of the assigned implementation items. The overall baseline is unverified. Review only the supplied items against current production source, and draw no conclusion about the full delivery.'] } });
    if (validateJsonSchema(handle.result, STOP_REVIEW_SCHEMA).length)
      throw Object.assign(new Error('Invalid partial implementation result'), { code: 'STOP_REVIEW_INVALID' });
    const result = structuredClone(handle.result);
    const citations = await handle.getSourceCitations?.(handle.result) ?? handle.sourceCitations ?? [];
    validateStructuredReviewEvidence(result, objects, citations, projectRoot, {
      mechanicalEvidence: handle.citationPolicy === 'mechanical-v1',
      roleForObject: id => handle.rowRoles?.[id] ?? 'stop-reviewer',
    });
    return { basis: fromAudit ? 'INDEPENDENTLY_COVERED_SUBSET' : 'PREVIOUS_PUBLISHED_BASELINE', baselineVersion: baseline.version,
      items: objects.map(object => {
        const row = result.metricObjectJudgements.find(entry => entry.objectId === object.objectId);
        let judgement = row?.judgement ?? 'UNVERIFIED', reason = row?.reason ?? 'No verified judgement for this item.';
        if (handle.citationPolicy !== 'mechanical-v1' && object.metricId === 'M16' && judgement === 'PASS') {
          try { validateProductionTrace(row.productionTrace ?? handle.proofs?.[object.objectId]?.productionTrace,
            handle.proofs?.[object.objectId]?.sourceCiteIds ?? row.evidence); }
          catch (error) { judgement = 'UNVERIFIED'; reason = error.message; }
        }
        return { objectId: object.objectId, metricId: object.metricId, claimId: object.sourceId, judgement, reason };
      }) };
  } finally { await closeStopReviewerSafely(handle, projectRoot, task.taskId); }
}

async function stopGateArmedForTask({ projectRoot, task, runtimeV2, snapshot }) {
  const configured = runtimeV2.stopCorrection.enabled === true;
  let armedAtStart = null;
  await withTaskState({ projectRoot, taskId: task.taskId }, (state) => {
    if (state.stop.armedAtStart === undefined) state.stop.armedAtStart = configured;
    armedAtStart = state.stop.armedAtStart;
  });
  if (!armedAtStart || configured) return configured;
  // The gate was armed when this task began and is now off. Honour it only if
  // a real user asked; otherwise keep enforcing.
  const userAsked = (snapshot?.entries ?? []).some((entry) => {
    if (entry?.type !== "user" || entry.isMeta === true) return false;
    const content = entry.message?.content;
    const blocks = typeof content === "string" ? [{ type: "text", text: content }] : (content ?? []);
    return (Array.isArray(blocks) ? blocks : []).some((block) => block?.type === "text"
      && /stopcorrection|runtime[- ]?corrector/iu.test(String(block.text ?? ""))
      && /disable|turn off|关闭|停用|disarm/iu.test(String(block.text ?? "")));
  });
  if (userAsked) return false;
  await appendTaskJournal(projectRoot, task.taskId, {
    type: "STOP_GATE_DISARM_IGNORED",
    reason: "stopCorrection was disabled mid-task without a user request; the gate stays armed.",
  });
  return true;
}

async function freezeStopReviewPolicy({ projectRoot, taskId, runtimeV2 }) {
  const requested = resolveStopReviewPolicy(runtimeV2.stopCorrection);
  let policy, deferred = false;
  await withTaskState({ projectRoot, taskId }, state => {
    state.stop.reviewPolicy ??= structuredClone(requested);
    policy = resolveStopReviewPolicy(state.stop.reviewPolicy);
    const requestedDigest = sha256(requested);
    if (sha256(policy) !== requestedDigest && state.stop.deferredReviewPolicyDigest !== requestedDigest) {
      state.stop.deferredReviewPolicyDigest = requestedDigest;
      deferred = true;
    }
  });
  if (deferred) await appendTaskJournal(projectRoot, taskId, { type: "STOP_REVIEW_POLICY_CHANGE_DEFERRED",
    reason: "The task retains its frozen Stop review selection. Configuration changes apply to a new task.", requested, frozen: policy });
  return policy;
}

/**
 * Journal one DERIVED_CONFIG event per task listing exactly what the
 * derivation tier decided (see derive.mjs): the zero-config baseline flag,
 * discovered material roots, and/or the fingerprinted platform. Runs that
 * use only explicit configuration journal nothing. Idempotence is recorded
 * on task state so session resumes do not repeat the event.
 */
async function maybeJournalDerivedConfig({ projectRoot, task, runtimeV2 }) {
  const derivation = runtimeV2.derivation;
  if (!derivation
    || (!derivation.zeroConfig && !derivation.materialRootsDerived && !derivation.platformDerived)) {
    return;
  }
  let alreadyJournaled = false;
  await withTaskState({ projectRoot, taskId: task.taskId }, (state) => {
    alreadyJournaled = state.derivedConfigJournaled === true;
    state.derivedConfigJournaled = true;
  });
  if (alreadyJournaled) return;
  await appendTaskJournal(projectRoot, task.taskId, {
    type: "DERIVED_CONFIG",
    zeroConfig: derivation.zeroConfig,
    ...(derivation.materialRootsDerived
      ? { materialRoots: [...derivation.materialRoots] }
      : {}),
    ...(derivation.platformDerived
      ? { platform: derivation.platform, platformMarker: derivation.platformMarker }
      : {}),
    ...(derivation.localeDerived
      ? { locale: derivation.locale }
      : {}),
  });
}

function explicitTaskId(env) {
  return env.RUNTIME_CORRECTOR_TASK_ID ?? null;
}

function hasUnsettledSkillWatcher(task, includeCompleted = false) {
  return Object.values(task?.watchers ?? {}).some((watcher) => ['ACTIVE', 'UNVERIFIED', 'UNVERIFIED_RECOVERY'].includes(watcher?.status)
    || watcher?.verificationIncomplete || includeCompleted && ['PASS', 'DEVIATION'].includes(watcher?.status)
    || watcher?.status === 'PASS' && (watcher.conditionalReviewPolicy !== CONDITIONAL_REVIEW_POLICY_VERSION
      || watcher.skillSourceContract !== SKILL_SOURCE_CONTRACT_VERSION || watcher.sourceInterpretationChecked !== true));
}

function claimsCompletion(input) {
  const message = String(input.last_assistant_message ?? "");
  if (INCOMPLETE_CLAIM_PATTERN.test(message) || RESIDUAL_COMPLETION_WORK_PATTERN.test(message)) return false;
  return COMPLETION_CLAIM_PATTERN.test(message);
}

function isRuntimeCorrectorStopRetry(input, task) {
  return input.stop_hook_active === true
    && Boolean(task?.stop?.lastAssessmentId || (task?.stop?.correctionAttempts ?? 0) > 0);
}

export { handleRuntimeV2SessionEnd };

async function crossCorrectionBarrier({
  input,
  projectRoot,
  pluginRoot,
  runtimeV2,
  reviewerFactory,
  task = null,
  snapshot = null,
  env = process.env,
}) {
  const activeTask = task ?? await ensureTask({
    projectRoot,
    sessionId: input.session_id,
    explicitTaskId: explicitTaskId(env),
  });
  if (!task && input.hook_event_name === "PreToolUse") await captureTaskStart({ projectRoot, taskId: activeTask.taskId });
  const activeSnapshot = snapshot ?? await readTranscriptSnapshot(input.transcript_path);
  await withTaskState({ projectRoot, taskId: activeTask.taskId }, (state) => {
    const alreadyActivated = state.correctionBarrier?.turnActivated === true;
    state.correctionBarrier = {
      ...(state.correctionBarrier ?? {}),
      turnActivated: alreadyActivated,
      lastHookEventId: eventId(input),
      lastTriggerEvent: input.hook_event_name,
      lastToolName: input.tool_name ?? null,
      activatedAt: state.correctionBarrier?.activatedAt ?? null,
    };
    if (state.stop.armedAtStart === undefined) {
      state.stop.armedAtStart = runtimeV2.stopCorrection.enabled === true;
    }
    state.stop.reviewPolicy ??= structuredClone(resolveStopReviewPolicy(runtimeV2.stopCorrection));
  });
  await maybeJournalDerivedConfig({ projectRoot, task: activeTask, runtimeV2 });
  if (input.hook_event_name !== 'Stop' || runtimeV2.stopCorrection.originalRequirementsBasis !== true) await maybeRunTaskOnboarding({
    input,
    projectRoot,
    sessionCwd: path.resolve(input.cwd ?? projectRoot),
    task: activeTask,
    runtimeV2,
    reviewerFactory,
    snapshot: activeSnapshot,
  });
  if (runtimeV2.dynamicGroundTruth.enabled && input.hook_event_name !== "Stop") {
    const current = await loadCurrentGroundTruth(projectRoot, activeTask.taskId);
    const catalog = await groundTruthSourceCatalog({ snapshot: activeSnapshot, projectRoot });
    if (current.version > 0 && pendingUserSourceRefs(current, catalog).length) {
      const refresh = await refreshGroundTruth({ pluginRoot, input, projectRoot, sessionCwd: path.resolve(input.cwd ?? projectRoot),
        task: activeTask, runtimeV2, reviewerFactory, snapshot: activeSnapshot });
      try { if (refresh.unverified) throw refresh.error; }
      finally { await refresh.handle?.close?.(); }
    }
  }
  await withTaskState({ projectRoot, taskId: activeTask.taskId }, (state) => {
    state.correctionBarrier = {
      ...(state.correctionBarrier ?? {}),
      turnActivated: true,
      lastHookEventId: eventId(input),
      lastTriggerEvent: input.hook_event_name,
      lastToolName: input.tool_name ?? null,
      activatedAt: new Date().toISOString(),
    };
  });
  return { task: activeTask, snapshot: activeSnapshot };
}

/**
 * Observe-only mode wrapper (config key: shadowMode).
 *
 * Detection, classification, deviation-family bookkeeping and journaling all
 * happen before any return, so suppressing the outbound decision is sufficient
 * and leaves the recorded evidence identical to a live run. Everything the
 * agent would have seen is stripped; everything the metrics read is kept.
 */
export async function handleRuntimeV2Event(options) {
  const mode = options.assessmentContext?.mode ?? "execute_and_correct";
  if (!["execute_and_correct", "verify_only"].includes(mode)) throw new Error("Invalid assessment mode.");
  let result;
  if (options.assessmentContext && options.input.hook_event_name === "Stop") {
    let task = await findTask({ projectRoot: options.projectRoot, sessionId: options.input.session_id });
    if (!task && claimsCompletion(options.input)) {
      task = await ensureTask({ projectRoot: options.projectRoot, sessionId: options.input.session_id });
      await options.assessmentContext.onTaskCreated?.(task);
      task = await findTask({ projectRoot: options.projectRoot, sessionId: options.input.session_id });
      options = { ...options, assessmentContext: { ...options.assessmentContext, guard: decisionGuard(task) } };
    }
    result = task ? await withTaskDecision({ projectRoot: options.projectRoot, taskId: task.taskId,
      context: { ...options.assessmentContext, mode } }, () => handleRuntimeV2EventInternal(options))
      : await handleRuntimeV2EventInternal(options);
    result = { ...result, assessmentMode: mode,
      ...(result.stop ? { stop: { ...result.stop, assessmentMode: mode } } : {}) };
  } else result = await handleRuntimeV2EventInternal(options);
  // Observability must not turn a completed correction into a failed hook.
  try { await recordRuntimeResponse(options, result); }
  catch (error) { console.warn('[runtime-corrector] Response record unavailable:', error.code ?? error.name); }
  if (!options.plan?.runtimeV2?.shadowMode) return result;
  return {
    ...result,
    decision: undefined,
    feedback: null,
    shadowMode: true,
    // Preserved so an analysis can report what the corrector WOULD have said,
    // and so a reviewer can verify the agent was never actually spoken to.
    suppressedDecision: result.decision ?? null,
    suppressedFeedback: result.feedback ?? null
  };
}

export async function refreshRuntimeRequirements({ projectRoot, pluginRoot, input, plan, reviewerFactory = startRoleReviewer, assessmentContext }) {
  const parentFactory = reviewerFactory;
  const signals = [...new Set([assessmentContext?.abortSignal, parentFactory.reviewAbortSignal].filter(Boolean))];
  const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
  const deadlineAt = Math.min(assessmentContext?.deadlineAt ?? Infinity, parentFactory.reviewDeadlineAt ?? Infinity);
  if (signal || Number.isFinite(deadlineAt)) {
    const bound = call => options => call({ ...options,
      deadlineAt: Math.min(deadlineAt, options.deadlineAt ?? Infinity),
      abortSignal: signal && options.abortSignal && signal !== options.abortSignal
        ? AbortSignal.any([signal, options.abortSignal]) : signal ?? options.abortSignal });
    reviewerFactory = Object.assign(bound(parentFactory), parentFactory,
      { reviewAbortSignal: signal, reviewDeadlineAt: deadlineAt });
    if (parentFactory.handoff) reviewerFactory.handoff = bound(parentFactory.handoff);
  }
  const task = await findTask({ projectRoot, sessionId: input.session_id });
  if (!task) throw new Error("No existing task for requirement update.");
  // This command permits callers without an assessment context. Give each
  // such request its own identity instead of sharing an undefined cache key.
  return withTaskDecision({ projectRoot, taskId: task.taskId, context: { ...assessmentContext,
    assessmentId: assessmentContext?.assessmentId ?? uniqueId("requirements"), kind: "requirements" } }, async () => {
    const snapshot = await readTranscriptSnapshot(input.transcript_path);
    const refresh = await refreshGroundTruth({ pluginRoot, input: { ...input, hook_event_name: "Stop" }, projectRoot, sessionCwd: input.cwd, task,
      runtimeV2: plan.runtimeV2, reviewerFactory, snapshot });
    await refresh.handle?.close();
    if (refresh.unverified) throw Object.assign(new Error("Requirement baseline extraction failed; requirement remains pending.",
      { cause: refresh.error }), { code: refresh.error?.code ?? 'BASELINE_EXTRACTION_FAILED' });
    await withTaskState({ projectRoot, taskId: task.taskId }, (state) => {
      state.control ??= {};
      state.control.pendingRequirement = null;
      state.status = "ACTIVE";
      state.verification = { ...state.verification, status: "STALE", reason: "REQUIREMENTS_UPDATED" };
      state.pendingCorrection = null;
    });
    return { handled: true, taskId: task.taskId, requirementVersion: refresh.current.version, baselineCommitted: true };
  });
}

async function handleRuntimeV2EventInternal({
  input,
  projectRoot,
  pluginRoot,
  plan,
  reviewerFactory = startRoleReviewer,
  env = process.env,
  artifact = null,
  // Injectable so tests exercise the gate without depending on whether this
  // machine has a device or a toolchain (the ladder has its own tests).
  deviceVerifier = null,
  stopFeedbackDeferred = false,
  stopHost = null,
}) {
  env = { ...env };
  const internal = await inspectInternalRun(env);
  if (internal.internal) return { handled: true, internal: true, skipped: "SKIPPED_INTERNAL" };
  if (input.hook_event_name === "SessionEnd") {
    return handleRuntimeV2SessionEnd({ input, projectRoot, env });
  }
  const runtimeV2 = plan.runtimeV2;
  if (!runtimeV2?.enabled) return { handled: false, reason: "V2_DISABLED" };
  if (!input.session_id) return { handled: false, reason: "MISSING_SESSION_ID" };
  const canonicalReviewerFactory = (options) => reviewerFactory({
    reviewerRuntime: plan.reviewerRuntime,
    resolvedSessionPlan:options.resolvedSessionPlan??resolveReviewerSession({reviewer:options.reviewer??{},env:options.env??env}),
    ...options,
    env: options.env ?? { ...env },
    pluginRoot: options.pluginRoot ?? pluginRoot,
  });
  canonicalReviewerFactory.materialManifest = reviewerFactory.materialManifest;
  canonicalReviewerFactory.readOriginalMaterial = reviewerFactory.readOriginalMaterial;
  canonicalReviewerFactory.referenceMaterials = reviewerFactory.referenceMaterials;
  canonicalReviewerFactory.supportsReviewCollection = reviewerFactory.supportsReviewCollection === true;
  canonicalReviewerFactory.supportsStopTasks = reviewerFactory.supportsStopTasks === true;
  canonicalReviewerFactory.reviewItemSize = reviewerFactory.reviewItemSize;
  canonicalReviewerFactory.singleReviewMetrics = reviewerFactory.singleReviewMetrics;
  canonicalReviewerFactory.supportsSupplementalFileAssessment = reviewerFactory.supportsSupplementalFileAssessment;
  if (typeof reviewerFactory.reviewCacheIdentity === "function")
    canonicalReviewerFactory.reviewCacheIdentity = reviewer => reviewerFactory.reviewCacheIdentity(reviewer);
  canonicalReviewerFactory.reviewDeadlineAt = Math.min(reviewerFactory.reviewDeadlineAt ?? Infinity,
    decisionScope.getStore()?.context?.deadlineAt ?? Infinity);
  const factorySignal = reviewerFactory.reviewAbortSignal, assessmentSignal = decisionScope.getStore()?.context?.abortSignal;
  canonicalReviewerFactory.reviewAbortSignal = factorySignal && assessmentSignal && factorySignal !== assessmentSignal
    ? AbortSignal.any([factorySignal, assessmentSignal]) : factorySignal ?? assessmentSignal ?? null;
  if (reviewerFactory.nativeSourceDelivery === true) {
    canonicalReviewerFactory.nativeSourceDelivery = true;
    canonicalReviewerFactory.validatesSourceBindings = reviewerFactory.validatesSourceBindings;
    canonicalReviewerFactory.validateSourceBindings = (...args) => reviewerFactory.validateSourceBindings(...args);
  }
  // Keep ambient execution state in this closure, never in persisted evidence.
  canonicalReviewerFactory.handoff = (options) => (reviewerFactory.handoff ?? handoffRoleReviewer)({
    reviewerRuntime: plan.reviewerRuntime,
    ...options,
    env: options.env ?? { ...env },
    pluginRoot: options.pluginRoot ?? pluginRoot,
    reviewerFactory: canonicalReviewerFactory,
  });

  if (input.hook_event_name === "SessionStart") {
    await Promise.allSettled([
      cleanupExpiredInternalRuns(projectRoot),
      cleanupStaleAtomicWrites(path.join(projectRoot, OUTPUT_TREE_DIRECTORY)),
    ]);
    const directory = stopSessionDirectory({ input, host: stopHost, env });
    if (directory && input.source === "startup") await createStopCorrectionStore({ directory }).initializeSession({
      sessionId: input.session_id, initialize: { kind: "NEW_SESSION", evidence: { hook: "SessionStart", source: "startup", sessionId: input.session_id } } });
    return { handled: true, taskId: null, reason: "SESSION_START_RECOVERED" };
  }

  let task = await findTask({
    projectRoot,
    sessionId: input.session_id,
    explicitTaskId: explicitTaskId(env),
  });

  let snapshot = null;
  let stopReviewPolicy = null;
  // Recorded before any task exists: a compaction may precede the first document write or Stop.
  if (archivesUserMessages(runtimeV2) && ["UserPromptSubmit", "PreCompact"].includes(input.hook_event_name)) {
    snapshot = await readTranscriptSnapshot(input.transcript_path);
    await recordUserMessages({ projectRoot, sessionId: input.session_id, snapshot });
  }
  if (input.hook_event_name === "Stop") {
    const adoptedSkillReview = runtimeV2.skillCorrection.enabled && (hasUnsettledSkillWatcher(task, true)
      || (task?.groundTruth.sharedBasis?.adoptedSkills ?? []).length > 0
      || task && (await fs.readdir(path.join(taskDirectory(projectRoot, task.taskId), 'skills'), { withFileTypes: true })
        .catch(error => { if (error.code === 'ENOENT') return []; throw error; })).some(entry => entry.isDirectory()));
    if (!String(input.last_assistant_message ?? "").trim()) {
      snapshot = await readTranscriptSnapshot(input.transcript_path);
      const transcriptMessage = latestAssistantText(snapshot);
      if (transcriptMessage) input = { ...input, last_assistant_message: transcriptMessage };
    }
    const shouldRunFullStop = decisionScope.getStore()?.context?.mode === "verify_only"
      || task?.correctionBarrier?.turnActivated === true
      || adoptedSkillReview
      || isRuntimeCorrectorStopRetry(input, task)
      || claimsCompletion(input);
    if (!shouldRunFullStop) {
      return { handled: true, taskId: task?.taskId ?? null, reason: "STOP_BARRIER_NOT_REQUIRED" };
    }
    // No classifier, extractor, source collection or implementation review is
    // needed when the user disabled every Stop duty. Independent live Skill
    // watchers retain their own pipeline and are handled below.
    task ??= await ensureTask({ projectRoot, sessionId: input.session_id, explicitTaskId: explicitTaskId(env) });
    snapshot ??= await readTranscriptSnapshot(input.transcript_path);
    await withTaskState({projectRoot,taskId:task.taskId}, state=>reconcileTurnState(state.turns,snapshot,input));
    await appendTaskJournal(projectRoot,task.taskId,{type:'HOOK_EVENT',hookEventId:eventId(input),hookEventName:input.hook_event_name,toolName:null});
    const reconcileStopSkills = (factory, activeTask = task, preparedGroundTruthRefresh = null) => withTaskResourceLock({ projectRoot, taskId: activeTask.taskId, resource: "skill-watchers",
        timeoutMs: WATCHER_RECONCILE_LOCK_TIMEOUT_MS, staleMs: WATCHER_RECONCILE_LOCK_TIMEOUT_MS, reclaimDeadOwner: true },
      () => checkDueWatchers({ input, projectRoot, pluginRoot, sessionCwd: path.resolve(input.cwd ?? projectRoot),
        task: activeTask, runtimeV2, reviewerFactory: factory, snapshot, preparedGroundTruthRefresh }));
    // Independent Skill-only configurations still run their own pipeline.
    // Otherwise perform this work within the existing Stop prepare deadline
    // and retry boundary, after original graph alignment has recovered.
    const armed = await stopGateArmedForTask({ projectRoot, task, runtimeV2, snapshot });
    let watcherOutcome = adoptedSkillReview && (!armed || !hasStopReviews(resolveStopReviewPolicy(runtimeV2.stopCorrection)))
      ? await reconcileStopSkills(canonicalReviewerFactory) : null;
    task = watcherOutcome?.task ?? task;
    // Stop owns everything outside configured workflow documents. A task that
    // has changed only those documents is left to document correction, unless
    // the frozen Stop policy itself reviews document quality.
    const documentOnly = armed && !adoptedSkillReview && decisionScope.getStore()?.context?.mode !== "verify_only"
      && !resolveStopReviewPolicy(task.stop?.reviewPolicy ?? runtimeV2.stopCorrection).fileQualityReviewEnabled
      && task.verification?.status !== "DEVIATION" && !isRuntimeCorrectorStopRetry(input, task)
      ? await documentOnlyChanges({ projectRoot, taskId: task.taskId, plan, deadlineAt: canonicalReviewerFactory.reviewDeadlineAt }) : null;
    if (documentOnly) {
      const stop = await recordDocumentOnlyStop({ input, projectRoot, task, host: stopHost, snapshot, changes: documentOnly });
      return { handled: true, taskId: task.taskId, decision: stop.decision, feedback: stop.feedback, stop };
    }
    const frozenPolicy=await freezeStopReviewPolicy({projectRoot,taskId:task.taskId,runtimeV2});
    const frozenRuntime = { ...runtimeV2, stopCorrection: { ...runtimeV2.stopCorrection,...frozenPolicy, enabled: armed } };
    const originalRequirementsBasis = frozenRuntime.stopCorrection.originalRequirementsBasis === true;
    const frameEnabled = stopHost?.openClaw && requirementFrameEnabled(runtimeV2);
    const readonlyBaselineRetry = { candidate: null };
    let partialImplementation;
    let stop = await runProductionStop({ input, projectRoot, task, runtimeV2: frozenRuntime,
      reviewerFactory: canonicalReviewerFactory, host: stopHost, env, snapshot,
      ...(originalRequirementsBasis ? { readOriginalRequirements: () => loadStopOriginalRequirements({ projectRoot, sessionId: input.session_id, snapshot, plan,
        materialRoots: runtimeV2.dynamicGroundTruth.materialRoots, loadMaterials: canonicalReviewerFactory.materialManifest,
        referenceTier: runtimeV2.dynamicGroundTruth.enabled !== true, readReferenceMaterials: canonicalReviewerFactory.referenceMaterials }) } : {}),
      stopFeedbackDeferred,
      verificationOnly: decisionScope.getStore()?.context?.mode === "verify_only",
      verificationId: decisionScope.getStore()?.context?.assessmentId,
      isCurrent: async () => {
        if (canonicalReviewerFactory.reviewAbortSignal?.aborted || stopHost?.isCurrent && !await stopHost.isCurrent()) return false;
        const current = await readTranscriptSnapshot(input.transcript_path);
        return current.lastUserEntryKey === snapshot.lastUserEntryKey && current.groundTruthDigest === snapshot.groundTruthDigest;
      },
      prepare: async ({ signal, deadlineAt, originalRequirements }) => {
        const progressPath = path.join(taskDirectory(projectRoot, task.taskId), 'stop-review-progress', `${sha256(input.session_id)}.json`);
        const implementationProgress = async (phase, reasonCode, diagnostic) => {
          if (signal.aborted || Date.now() >= deadlineAt) return;
          await outsideDecision(() => atomicWriteJson(progressPath, {
            taskId: task.taskId, sessionId: input.session_id, hookEventId: eventId(input),
            phase, reasonCode, ...(diagnostic ? { diagnostic } : {}), updatedAt: Date.now(), deadlineAt, navigationOnly: true,
          })).catch(() => {});
        };
        await implementationProgress(originalRequirements ? 'READING_ORIGINAL_REQUIREMENTS' : 'WAITING_FOR_BASELINE');
        const factory = Object.assign(options => canonicalReviewerFactory({ ...options,
          deadlineAt: Math.min(options.deadlineAt ?? Infinity, deadlineAt), abortSignal: signal }), canonicalReviewerFactory);
        factory.reviewDeadlineAt = deadlineAt; factory.reviewAbortSignal = signal;
        await crossCorrectionBarrier({ input, projectRoot, pluginRoot, runtimeV2: frozenRuntime, reviewerFactory: factory, task, snapshot, env });
        const refresh = originalRequirements ? { task, current: { taskId: task.taskId, version: task.groundTruth.version,
          digest: task.groundTruth.digest, claims: [] } } : runtimeV2.dynamicGroundTruth.enabled ? await refreshGroundTruth({ pluginRoot, input, projectRoot,
          sessionCwd: path.resolve(input.cwd ?? projectRoot), task, runtimeV2: frozenRuntime, reviewerFactory: factory, snapshot, readonlyBaselineRetry })
          : { task, current: await loadCurrentGroundTruth(projectRoot, task.taskId) };
        if (refresh.unverified) {
          const failure = refresh.error ?? new Error("Ground Truth preparation is unverified.");
          const reasonCode = failure.code ?? 'BASELINE_UNVERIFIED';
          if (!partialImplementation && !readonlyBaselineRetry.candidate && !signal.aborted
            && (refresh.diagnosticClaims?.length || refresh.current?.version > 0
              && ['BASELINE_COVERAGE_UNVERIFIED', 'BASELINE_REPAIR_LIMIT', 'BASELINE_AUDIT_INCOMPLETE',
                'BASELINE_FROZEN_AUTHORIZATION_REQUIRED'].includes(reasonCode))) {
            await implementationProgress('PARTIAL_REVIEWING', reasonCode);
            try {
              partialImplementation = await reviewPartialImplementation({ projectRoot, task: refresh.task ?? task, input, snapshot,
                refresh, factory, runtimeV2: frozenRuntime,
                excludedEvidencePaths: [stopSessionDirectory({ input, host: stopHost, env })].filter(Boolean) });
            } catch (error) {
              partialImplementation = { status: 'UNVERIFIED', reasonCode: error.code ?? 'PARTIAL_IMPLEMENTATION_FAILED' };
            }
          }
          await implementationProgress(partialImplementation?.items ? 'PARTIAL_COMPLETED' : 'BLOCKED', reasonCode, partialImplementation);
          throw failure;
        }
        void refresh.handle?.close?.();
        const preparedTask = refresh.task ?? task;
        if (adoptedSkillReview) watcherOutcome = await reconcileStopSkills(factory, preparedTask, originalRequirements ? null : refresh);
        if (watcherOutcome?.error) throw Object.assign(new Error(`Skill basis is unverified: ${watcherOutcome.error.message}`), {
          code: 'SKILL_BASIS_UNVERIFIED', ...(watcherOutcome.error.reviewerRuntimeFailure ? { reviewerRuntimeFailure: true } : {}) });
        const groundTruth = refresh.current;
        const policy = await freezeStopReviewPolicy({projectRoot,taskId:preparedTask.taskId,runtimeV2:frozenRuntime});
        const population = await buildMetricPopulation({ projectRoot, taskId: preparedTask.taskId, groundTruth,
          skillDocuments: await skillDocuments(projectRoot, preparedTask.taskId), reviewPolicy: policy,
          artifactMetricIds: [...new Set((plan.configuredArtifacts ?? plan.artifacts ?? []).flatMap(artifact => artifact.metrics ?? []))],
          sourceOnlyDelivery: isSourceOnlyDelivery(plan.configuredArtifacts ?? plan.artifacts),
          ...(originalRequirements ? { persist: false } : {}) });
        let deterministicReview;
        const artifacts = plan.configuredArtifacts ?? plan.artifacts ?? [];
        const changeSet = originalRequirements || frameEnabled && runtimeV2.requirementFrame.review
          ? await taskChanges({ projectRoot, taskId: preparedTask.taskId, plan, deadlineAt }) : null;
        const requirementFrame = frameEnabled ? await readStopFrame({ projectRoot, sessionId: input.session_id,
          startHead: changeSet?.startHead, review: runtimeV2.requirementFrame.review }) : null;
        const request = { schemaVersion: 'runtime-corrector.workspace-stop.v1', hook: sanitizedHookInput(input), population,
          ...(requirementFrame ? { requirementFrame } : {}),
          ...(originalRequirements && changeSet ? { taskChanges: { startHead: changeSet.startHead, changes: changeSet.changes.filter(change => change.owner === 'STOP')
            .map(({ path: file, status }) => ({ path: file, status })) } } : {}),
          processSnapshotPath: input.transcript_path,
          ...(!originalRequirements ? { groundTruthPath: path.join(taskDirectory(projectRoot, preparedTask.taskId), 'ground-truth/current.json') } : {}),
          instructions: [...PROCESS_REVIEW_INSTRUCTIONS, 'Plan one review across all assigned metrics; use original files, diffs and host edits as entry points.'],
          classificationContract: 2,
          workflowStages: eligibleStopStages(groundTruth, [...new Set(artifacts.map(artifact => artifact.stage).filter(Boolean))]), workflowArtifacts: artifacts,
          fileQualityReviewEnabled: policy.fileQualityReviewEnabled,
          reviewScope: { kind: 'workspace-stop' },
          ...(decisionScope.getStore()?.context?.mode === 'verify_only' ? { fixedStopClassification: { stopClassification: 'TASK_COMPLETE', stage: null } } : {}) };
        await implementationProgress('REVIEWING');
        let unifiedReview = await factory({ projectRoot, taskId: preparedTask.taskId, parentSessionId: input.session_id,
          role: 'stop-reviewer', reviewer: runtimeV2.reviewers.stopReviewer, schema: STOP_REVIEW_SCHEMA, request,
          effectiveToolPolicy: stopHost?.effectiveToolPolicy,
          deferScopeVerification: frozenRuntime.stopCorrection.regressionCheck?.enabled === true || runtimeV2.implementationCorrection.enabled,
          skillRoots: runtimeV2.skillCorrection.skillRoots,
          excludedEvidencePaths: [stopSessionDirectory({ input, host: stopHost, env })].filter(Boolean),
          evidence: { snapshot, groundTruth, ...(originalRequirements ? { originalRequirements } : {}) },
          onRegressionDisposition: value => confirmCollateralRegressionFailures({...value,projectRoot,deadlineAt,signal,
            excluded:[stopSessionDirectory({input,host:stopHost,env})].filter(Boolean),
            outputDirectory:path.join(taskDirectory(projectRoot,preparedTask.taskId),'regression-check','collateral')}),
          onScope: async (classification, reviewBasis) => {
            const currentSnapshot = await readTranscriptSnapshot(input.transcript_path);
            if (signal.aborted || stopHost?.isCurrent && !await stopHost.isCurrent()
              || currentSnapshot.lastUserEntryKey !== snapshot.lastUserEntryKey || currentSnapshot.groundTruthDigest !== snapshot.groundTruthDigest)
              throw Object.assign(new Error('The original user input changed during scope selection'), { code: 'STOP_TASK_INPUT_CHANGED' });
            classification = { ...classification, stage: classification.stopClassification === 'STAGE_COMPLETE' ? classification.stage : null };
            const artifactCandidates = ['TASK_COMPLETE', 'STAGE_COMPLETE'].includes(classification.stopClassification)
              ? await collectArtifactCandidates({ projectRoot, plan: classification.stopClassification === 'STAGE_COMPLETE' ? { ...plan,
                artifacts: artifacts.filter(artifact => artifact.stage === classification.stage),
                configuredArtifacts: artifacts.filter(artifact => artifact.stage === classification.stage) } : plan,
                enabledMetricIds: enabledStopMetricIds(policy), includeUnmetered: policy.fileQualityReviewEnabled, deadlineAt, abortSignal: signal }) : [];
            request.artifactCandidates = artifactCandidates;
            const selected = selectStopPopulation(originalRequirements ? reviewBasis?.population ?? population : population, classification, artifacts);
            const regressionCheck = await runStopRegressionCheck({ projectRoot, config: frozenRuntime.stopCorrection.regressionCheck,
              // Isolated passes cannot authorize whole-suite failures. In the
              // original-basis path, retain all failures for review and use the
              // bound full-survivor rerun after authorized cases are known.
              deferIsolation: Boolean(originalRequirements && frozenRuntime.stopCorrection.regressionCheck?.baselineFile),
              population: selected, deadlineAt, signal, cacheDirectory: path.join(taskDirectory(projectRoot, preparedTask.taskId), 'regression-check'),
              excluded: [stopSessionDirectory({ input, host: stopHost, env })].filter(Boolean) });
            const scoped = { artifactCandidates, ...(regressionCheck ? { regressionCheck } : {}) };
            if (!runtimeV2.implementationCorrection.enabled) return scoped;
            const currentBasis = originalRequirements ? reviewBasis?.groundTruth ?? groundTruth : groundTruth;
            const owned = implementationPopulation(selected, { groundTruth: currentBasis, projectRoot, stage: classification.stopClassification === 'TASK_COMPLETE' ? null : classification.stage }).population;
            if (Object.values(owned.metrics).some(objects => objects.length)) deterministicReview = await runDeterministicImplementationChecks({
              projectRoot, runtimeV2, groundTruth: currentBasis, enabled: policy.metrics.M09 === true });
            if (!['M12', 'M13', 'M15'].some(id => selected.metrics[id]?.some(object => object.verificationTarget === 'IMPLEMENTATION'))) return { ...scoped, deterministicReview };
            const adapter = await loadPlatformAdapter(runtimeV2.implementationCorrection.platform);
            const startedAt = Date.now();
            try {
              const verification = await beforeStopDeadline(() => (deviceVerifier ?? deviceVerification)({ projectRoot, adapter,
                deviceConfig: runtimeV2.implementationCorrection.device,
                budgetMs: Math.min(runtimeV2.implementationCorrection.deviceBudgetMs, deadlineAt - Date.now()),
                outputDir: path.join(taskDirectory(projectRoot, preparedTask.taskId), 'device'), signal, deadlineAt,
                execFn: (command, args, options) => runDeviceCommand(command, args, { ...options, signal,
                  timeoutMs: Math.max(1, Math.min(options?.timeoutMs ?? 60000, deadlineAt - Date.now())) }) }),
              { deadlineAt, signal, code: 'STOP_REVIEW_DEADLINE' });
              return { ...scoped, deterministicReview, deviceEvidence: { origin: 'PROGRAM_VERIFICATION', startedAt, endedAt: Date.now(), verification } };
            } catch (cause) { return { ...scoped, deterministicReview, deviceEvidence: { origin: 'PROGRAM_VERIFICATION', status: 'UNVERIFIED', reason: cause.message } }; }
          } }).catch(async error => {
          await implementationProgress('FAILED', error.code ?? 'STOP_REVIEW_FAILED');
          throw error;
        });
        try {
          const resultSchema = requirementFrame ? { ...STOP_REVIEW_SCHEMA,
            properties: { ...STOP_REVIEW_SCHEMA.properties, frameCoverage: { type: 'object' } } } : STOP_REVIEW_SCHEMA;
          const issues = validateJsonSchema(unifiedReview.result, resultSchema);
          if (issues.length) throw Object.assign(new Error('The workspace reviewer returned an invalid Stop result'), { code: 'STOP_REVIEW_INVALID' });
          const basis = originalRequirements ? unifiedReview.reviewBasis : { groundTruth, population };
          if (!basis?.population || !basis.groundTruth) throw Object.assign(new Error('The workspace reviewer did not construct the original requirements checklist'), { code: 'STOP_ORIGINAL_CHECKLIST_REQUIRED' });
          unifiedReview = { ...unifiedReview, sourceCitations: await unifiedReview.getSourceCitations?.(unifiedReview.result) ?? unifiedReview.sourceCitations ?? [] };
          const classification = { stopClassification: unifiedReview.result.stopClassification, stage: unifiedReview.result.stage ?? null };
          await implementationProgress('COMPLETED');
          return { taskId: preparedTask.taskId, groundTruth: basis.groundTruth, classification, population: selectStopPopulation(basis.population, classification, artifacts),
            fullPopulation: basis.population, recheckObjectIds: Object.values(basis.population.metrics).flat().map(object => object.objectId), request, unifiedReview, deterministicReview };
        } catch (error) {
          await implementationProgress('FAILED', error.code ?? 'STOP_REVIEW_FAILED');
          throw error;
        } finally { await closeStopReviewerSafely(unifiedReview, projectRoot, preparedTask.taskId); }
      } });
    if (partialImplementation) stop = { ...stop, partialImplementation };
    // A closed/capacity-gated Stop never calls prepare. Keep the pre-existing
    // independent Skill pipeline available under its own existing parent
    // deadline and feedback cap; it cannot turn that Stop into acceptance.
    const verificationBeforeFallback = await findTask({ projectRoot, sessionId: input.session_id, explicitTaskId: task.taskId });
    if (!watcherOutcome && adoptedSkillReview
      && (stop.reused || ['CORRECTION_FLOW_CLOSED', 'SESSION_CORRECTION_LIMIT', 'FLOW_CORRECTION_LIMIT'].includes(stop.reasonCode))
      && !canonicalReviewerFactory.reviewAbortSignal?.aborted)
      watcherOutcome = await reconcileStopSkills(canonicalReviewerFactory);
    const watcherFeedback = watcherOutcome?.feedback ?? [];
    if (stop.status === 'PASS' && (watcherOutcome?.error || watcherFeedback.length)) {
      await invalidateCurrentStopVerification({ projectRoot, taskId: task.taskId, sessionId: input.session_id,
        expectedTask: verificationBeforeFallback, evaluationId: stop.evaluationId, reasonCode: 'SKILL_BASIS_UNVERIFIED',
        signal: canonicalReviewerFactory.reviewAbortSignal, deadlineAt: canonicalReviewerFactory.reviewDeadlineAt });
      stop = { ...stop, status: 'UNVERIFIED', decision: 'allow', admission: null, report: null,
        verificationIncomplete: true, reasonCode: 'SKILL_BASIS_UNVERIFIED' };
    }
    // An unresolved original basis does not skip the review; it caps the
    // conclusion below PASS and is reported separately.
    const settled = await findTask({ projectRoot, sessionId: input.session_id, explicitTaskId: task.taskId });
    const pendingOnboarding = originalRequirementsBasis && armed ? [] : settled?.groundTruth.onboardingPending ?? [];
    const basisNotices = [
      ...(pendingOnboarding.length ? [{ reasonCode: 'ONBOARDING_OPERATIONS_UNVERIFIED',
        text: `[runtime-corrector:status] UNVERIFIED (ONBOARDING_OPERATIONS_UNVERIFIED)：以下原始义务尚未核实，本次结论不能据此确认任务通过：\n${pendingOnboarding.slice(0, 20)
          .map(pending => `- ${pending.operationId} [${pending.reasonCode ?? 'UNVERIFIED'}]: ${String(pending.operation?.text ?? '').slice(0, 300)}`).join('\n')}` }] : []),
      ...(settled?.documentCoverage?.status === 'UNVERIFIED' ? [{ reasonCode: 'DOCUMENT_EXECUTION_UNVERIFIED',
        text: '[runtime-corrector:status] UNVERIFIED (DOCUMENT_EXECUTION_UNVERIFIED)：脚本写入的文档范围尚未核实，不能据此确认任务通过。请补全精确声明并重新核对全部声明文档。' }] : [])];
    if (basisNotices.length) {
      if (['PASS', 'NO_DEVIATION_FOUND', 'COMPLETED_WITH_HISTORICAL_DEVIATIONS'].includes(stop.status)) {
        await invalidateCurrentStopVerification({ projectRoot, taskId: task.taskId, sessionId: input.session_id,
          expectedTask: settled, evaluationId: stop.evaluationId, reasonCode: basisNotices[0].reasonCode,
          signal: canonicalReviewerFactory.reviewAbortSignal, deadlineAt: canonicalReviewerFactory.reviewDeadlineAt });
        stop = { ...stop, status: 'UNVERIFIED', decision: 'allow', admission: null, report: null,
          verificationIncomplete: true, reasonCode: basisNotices[0].reasonCode };
      }
      stop = { ...stop, unverifiedBasis: basisNotices.map(notice => notice.reasonCode),
        ...(pendingOnboarding.length ? { unverifiedObligations: pendingOnboarding.map(pending => ({ operationId: pending.operationId,
          status: 'UNVERIFIED', reasonCode: pending.reasonCode ?? null, text: pending.operation?.text ?? null })) } : {}),
        feedback: [stop.feedback, ...basisNotices.map(notice => notice.text)].filter(Boolean).join('\n\n') };
    }
    const reproduction = frameEnabled && frameReproduction(runtimeV2);
    if (reproduction && stop.feedback?.includes('[runtime-corrector:stop-feedback]'))
      stop = { ...stop, feedback: appendFrameReproduction(stop.feedback, reproduction) };
    return { handled: true, taskId: stop.taskId, decision: watcherFeedback.length ? "block" : stop.decision,
      feedback: [watcherFeedback.join("\n\n"), stop.feedback].filter(Boolean).join("\n\n") || null, stop };
  }

  const shouldCrossBarrier = (
    input.hook_event_name === "PreToolUse" && CORRECTION_BARRIER_TOOLS.has(input.tool_name)
  ) || (
    input.hook_event_name === "PostToolUse"
      && CORRECTION_BARRIER_TOOLS.has(input.tool_name)
      && task?.correctionBarrier?.turnActivated !== true
  ) || input.hook_event_name === "Stop";
  if (shouldCrossBarrier) {
    ({ task, snapshot } = await crossCorrectionBarrier({
      input,
      projectRoot,
      pluginRoot,
      runtimeV2,
      reviewerFactory: canonicalReviewerFactory,
      task,
      snapshot,
      env,
    }));
  }

  // Prompt submission, compaction and observation-only PostToolUse events never mint a task.
  // They only update state that a previous correction-relevant action created.
  if (!task) {
    return { handled: true, taskId: null, reason: "NO_ACTIVE_TASK" };
  }

  if (input.hook_event_name === "PreCompact") {
    snapshot = await readTranscriptSnapshot(input.transcript_path);
    await withTaskState({ projectRoot, taskId: task.taskId }, (state) => {
      reconcileTurnState(state.turns, snapshot, input);
    });
    return { handled: true, taskId: task.taskId, reason: "PRECOMPACT_CURSOR_PERSISTED" };
  }

  await dismissInformationalFamilies({ projectRoot, taskId: task.taskId });
  snapshot ??= await readTranscriptSnapshot(input.transcript_path);
  if (TURN_RECONCILE_EVENTS.has(input.hook_event_name)) {
    await withTaskState({ projectRoot, taskId: task.taskId }, (state) => {
      reconcileTurnState(state.turns, snapshot, input);
      if (input.hook_event_name === "UserPromptSubmit") {
        state.groundTruth.pendingUserCursor = snapshot.lastUserEntryKey;
        state.correctionBarrier = {
          ...(state.correctionBarrier ?? {}),
          turnActivated: false,
        };
      }
    });
  }

  await appendTaskJournal(projectRoot, task.taskId, {
    type: "HOOK_EVENT",
    hookEventId: eventId(input),
    hookEventName: input.hook_event_name,
    toolName: input.tool_name ?? null,
  });

  let skill = null;
  if (input.hook_event_name === "PreToolUse" && input.tool_name === "Skill") {
    const skillId = skillIdFromInput(input);
    if (!runtimeV2.skillCorrection.enabled
      || !skillId
      || !selectedSkill(skillId, runtimeV2.skillCorrection.selection)) {
      return { handled: true, taskId: task.taskId, reason: "SKILL_NOT_SELECTED" };
    }
    const directory = await resolveSkillDirectory({
      skillId,
      projectRoot,
      pluginRoot,
      configuredRoots: runtimeV2.skillCorrection.skillRoots,
      sourceIdentity: input.tool_input?.sourceIdentity,
    });
    if (!directory) {
      await appendTaskJournal(projectRoot, task.taskId, { type: "SKILL_SOURCE_UNRESOLVED", skillId });
      return { handled: true, taskId: task.taskId, reason: "SKILL_SOURCE_UNRESOLVED" };
    }
    skill = { skillId, directory, source: await scanSkillDirectory(directory, { sourceIdentity: input.tool_input?.sourceIdentity }) };
    try {
      const retained = await retainSkillSelection({ projectRoot, task, skill, input, snapshot, runtimeV2, reviewerFactory: canonicalReviewerFactory });
      if (!retained?.watcherId) throw selectionFailure('Skill selection publication was rejected');
      task = await findTask({ projectRoot, sessionId: input.session_id, explicitTaskId: task.taskId });
    } catch (error) {
      return { handled: true, taskId: task.taskId, reason: 'SKILL_WATCH_NOT_ESTABLISHED', reasonCode: error.code ?? 'SKILL_SELECTION_UNVERIFIED',
        watcher: { skillId, status: 'UNVERIFIED' }, feedback: null };
    }
  }

  let refresh = { task, changed: false, current: await loadCurrentGroundTruth(projectRoot, task.taskId) };
  const artifactUsesGroundTruth = Boolean(artifact) && (runtimeV2.artifactCorrection.groundTruthReviewEnabled
    || (artifact.metricCheckpoint && runtimeV2.artifactCorrection.stageMetricsEnabled));
  // Without the original-requirements review, every artifact write keeps the
  // baseline warm for the Stop and Skill reviews that read it later.
  const artifactRefreshesGroundTruth = runtimeV2.artifactCorrection.originalRequirementsEnabled
    ? artifactUsesGroundTruth : Boolean(artifact);
  const shouldRefresh = Boolean(skill && runtimeV2.skillCorrection.enabled) || runtimeV2.dynamicGroundTruth.enabled && (
    (input.hook_event_name === "PostToolUse" && artifactRefreshesGroundTruth)
    || input.hook_event_name === "Stop" && hasStopReviews(stopReviewPolicy)
    || (input.hook_event_name === "PreToolUse" && input.tool_name === "Skill")
  );
  if (shouldRefresh) {
    refresh = await refreshGroundTruth({
        pluginRoot,
      input,
      projectRoot,
      sessionCwd: path.resolve(input.cwd ?? projectRoot),
      task,
      runtimeV2,
      reviewerFactory: canonicalReviewerFactory,
      skill,
      artifact,
      snapshot,
    });
    task = refresh.task;
  }

  const feedback = [];
  if (skill) {
    if (refresh.unverified || !await currentSkillGroundTruth(projectRoot, task.taskId, skill.skillId, skill.source)) {
      if (refresh.handle) await refresh.handle.close();
      await appendTaskJournal(projectRoot, task.taskId, { type: "SKILL_WATCH_NOT_ESTABLISHED", skillId: skill.skillId,
        skillDigest: skill.source.digest, reason: refresh.error?.message ?? "Current Skill Ground Truth is unavailable." });
      return { handled: true, taskId: task.taskId, reason: "SKILL_WATCH_NOT_ESTABLISHED",
        ...(refresh.error?.code ? { reasonCode: refresh.error.code } : {}),
        watcher: { skillId: skill.skillId, status: "UNVERIFIED" }, feedback: null };
    }
    const watcher = await startSkillWatcher({
      projectRoot,
      task,
      skillId: skill.skillId,
      source: skill.source,
      input,
      runtimeV2,
    });
    if (refresh.handle) await refresh.handle.close();
    return { handled: true, taskId: task.taskId, watcher, feedback: null };
  }

  const watcherBatchIncomplete = input.hook_event_name === "PostToolUse"
    && unresolvedSiblingToolUseIds(snapshot, input.tool_use_id).length > 0;
  if (SKILL_CHECK_EVENTS.has(input.hook_event_name)
    && runtimeV2.skillCorrection.enabled
    && !watcherBatchIncomplete) {
    // PostToolUse runs once per completed tool. Parallel tool calls can therefore
    // arrive together; serialize the due-check and re-read watcher state inside
    // the lock so one assistant turn produces at most one evaluation.
    const watcherOutcome = await withTaskResourceLock({
      projectRoot,
      taskId: task.taskId,
      resource: "skill-watchers",
      timeoutMs: WATCHER_RECONCILE_LOCK_TIMEOUT_MS,
      staleMs: WATCHER_RECONCILE_LOCK_TIMEOUT_MS,
      reclaimDeadOwner: true,
    }, () => checkDueWatchers({
      input,
      projectRoot,
      pluginRoot,
      sessionCwd: path.resolve(input.cwd ?? projectRoot),
      task,
      runtimeV2,
      reviewerFactory: canonicalReviewerFactory,
      snapshot,
    }));
    task = watcherOutcome.task;
    feedback.push(...watcherOutcome.feedback);
  }

  if (input.hook_event_name === "Stop" && feedback.length > 0) {
    if (refresh.handle) await refresh.handle.close();
    return {
      handled: true,
      taskId: task.taskId,
      decision: "block",
      feedback: await prepareHostFeedback({ projectRoot, taskId: task.taskId,
        text: feedback.join("\n\n"), locale: runtimeV2.locale }),
    };
  }
  if (artifact && input.hook_event_name === "PostToolUse") {
    if (!artifactUsesGroundTruth) {
      if (refresh.handle) await refresh.handle.close();
      const originalRequirements = runtimeV2.artifactCorrection.originalRequirementsEnabled
        ? await buildOriginalRequirements({ projectRoot, sessionId: input.session_id, snapshot, plan,
          materials: await (canonicalReviewerFactory.materialManifest ?? materialManifest)(runtimeV2.dynamicGroundTruth.materialRoots),
          referenceTier: runtimeV2.dynamicGroundTruth.enabled !== true, readReferenceMaterials: canonicalReviewerFactory.referenceMaterials })
        : null;
      return {
        handled: true,
        taskId: task.taskId,
        feedback: feedback.join("\n\n") || null,
        groundTruthChanged: refresh.changed,
        artifactReviewContext: null,
        reviewerHandle: null,
        originalRequirements,
      };
    }
    let population = null;
    const metricIds = artifact.metrics?.length ? artifact.metrics : null;
    if (artifact.metricCheckpoint && runtimeV2.artifactCorrection.stageMetricsEnabled) {
      try {
        population = await buildMetricPopulation({
          projectRoot,
          taskId: task.taskId,
          groundTruth: refresh.current,
          skillDocuments: await skillDocuments(projectRoot, task.taskId),
        });
      } catch (error) {
        // Ownership has not yet passed to semantic review. Preserve the
        // preparation error while attempting to release the source resources.
        await Promise.allSettled([Promise.resolve().then(() => refresh.handle?.close())]);
        throw error;
      }
    }
    return {
      handled: true,
      taskId: task.taskId,
      feedback: feedback.join("\n\n") || null,
      reviewerHandle: refresh.handle ?? null,
      reviewerEvidence: { snapshot, groundTruth: refresh.current, population },
      // Execution-only state must never enter the serialized artifact evidence.
      reviewerExecutionContext: {
        projectRoot,
        sessionCwd: path.resolve(input.cwd ?? projectRoot),
        taskId: task.taskId,
        parentSessionId: input.session_id,
        pluginRoot,
        reviewerRuntime: plan.reviewerRuntime,
        env: { ...env },
      },
      artifactReviewContext: {
        schemaVersion: "runtime-corrector.artifact-review-context.v2",
        taskId: task.taskId,
        artifact,
        groundTruthPath: currentGroundTruthPathForContext(projectRoot, task.taskId),
        groundTruthVersion: refresh.current.version,
        groundTruthDigest: refresh.current.digest,
        transcriptDigest: snapshot.digest,
        transcriptCursor: snapshot.lastEntryKey,
        rootCauseIds: [...ROOT_CAUSE_IDS],
        reviewerExecution: runtimeV2.reviewers.artifactReviewer,
        population,
        metricIds,
      },
    };
  }
  if (refresh.handle) await refresh.handle.close();
  return {
    handled: true,
    taskId: task.taskId,
    feedback: feedback.join("\n\n") || null,
    groundTruthChanged: refresh.changed,
    groundTruthError: refresh.error?.message ?? null,
  };
}

function currentGroundTruthPathForContext(projectRoot, taskId) {
  return path.join(taskDirectory(projectRoot, taskId), "ground-truth", "current.json")
    .replaceAll("\\", "/");
}
