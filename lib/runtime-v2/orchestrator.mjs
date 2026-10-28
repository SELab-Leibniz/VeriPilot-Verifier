import { selectStopPopulation, eligibleStopStages } from './review-routing.mjs';
import { decisionScope } from "./decision-scope.mjs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { validateJsonSchema } from "../json-schema-validator.mjs";

import { loadCurrentGroundTruth, applyGroundTruthDelta, persistSkillGroundTruth } from "./ground-truth-ledger.mjs";
import { dismissInformationalFamilies, familyIdForFinding, loopBoundedFamilyIds, markMetricPassesFixed, recordDeviationFindings, ROOT_CAUSE_IDS } from "./deviations.mjs";
import { eventId } from "./event-identity.mjs";
import { runDeterministicImplementationChecks } from "./impl-review.mjs";
import { loadPlatformAdapter } from "./platform-adapter.mjs";
import { implementationPopulation, VERIFICATION_ROUTING_INSTRUCTIONS } from "./review-routing.mjs";
import { groundTruthSourceCatalog, rejectedGroundTruthSource, SOURCE_INSTRUCTIONS, pendingUserSourceRefs, userSourceRef } from "./ground-truth-provenance.mjs";
import { cleanupExpiredInternalRuns, inspectInternalRun } from "./internal-run.mjs";
import { buildMetricPopulation, calculateMetricReport, isSourceOnlyDelivery } from "./metrics.mjs";
import { resolveStopReviewPolicy, enabledStopMetricIds, hasStopReviews } from "./metric-policy.mjs";
import { collectArtifactCandidates } from "./artifact-candidates.mjs";
import { materialManifest, maybeRunTaskOnboarding } from "./onboarding.mjs";
import { OUTPUT_TREE_DIRECTORY } from "./paths.mjs";
import { PROCESS_REVIEW_INSTRUCTIONS } from "./process-checks.mjs";

import { prepareHostFeedback } from "./feedback-delivery.mjs";
import { runProductionStop, stopSessionDirectory } from "./production-stop.mjs";
import { createStopCorrectionStore } from "./stop-correction-store.mjs";
import { deviceVerification, runCommand as runDeviceCommand } from "./device-verify.mjs";
import { beforeStopDeadline } from "./stop-deadline.mjs";
import { GROUND_TRUTH_REVIEW_SCHEMA, SKILL_GROUND_TRUTH_REVIEW_SCHEMA, SKILL_REVIEW_SCHEMA, STOP_REVIEW_SCHEMA, handoffRoleReviewer, startRoleReviewer, resolveReviewerSession } from "./reviewer.mjs";
import { resolveSkillDirectory, scanSkillDirectory, selectedSkill, skillIdFromInput } from "./skill-source.mjs";
import { handleRuntimeV2SessionEnd } from "./session-end.mjs";
import {
  appendTaskJournal,
  ensureTask,
  findTask,
  startCorrectionEpoch,
  taskDirectory,
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

async function currentSkillGroundTruth(projectRoot, taskId, skillId, skillDigest) {
  let document;
  try {
    document = await readJson(path.join(taskDirectory(projectRoot, taskId), "skills", safeId(skillId), "skill-ground-truth.json"));
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  if (!document || document.taskId !== taskId || document.skillId !== skillId || document.skillDigest !== skillDigest) return null;
  const payload = { constraints: document.constraints, taskOverlays: document.taskOverlays };
  if (validateJsonSchema(payload, SKILL_GROUND_TRUTH_REVIEW_SCHEMA.properties.skillGroundTruth).length) return null;
  return document.digest === sha256({ skillId, skillDigest, ...payload }) ? document : null;
}

async function refreshGroundTruth({
  input,
  projectRoot,
  sessionCwd,
  task,
  runtimeV2,
  reviewerFactory,
  skill = null,
  artifact = null,
  snapshot,
}) {
  if (!runtimeV2.dynamicGroundTruth.enabled) {
    return { task, changed: false, current: await loadCurrentGroundTruth(projectRoot, task.taskId) };
  }
  if (skill?.source.truncated) {
    return { task, changed: false, current: await loadCurrentGroundTruth(projectRoot, task.taskId), unverified: true,
      error: new Error("The original Skill source exceeds the capture budget; incomplete instructions cannot establish a watcher.") };
  }
  const materials = await materialManifest(runtimeV2.dynamicGroundTruth.materialRoots);
  const sourceCatalog = await groundTruthSourceCatalog({ snapshot, materials, projectRoot, skill });
  const scope = groundTruthScope(input, skill, artifact);
  const digest = sha256({
    userEvidence: snapshot.groundTruthDigest,
    prompt: input.hook_event_name === "UserPromptSubmit" ? input.prompt : null,
    scope,
    skillDigest: skill?.source.digest ?? null,
    materials: materials.digest,
  });
  if (await sourceCursor(projectRoot, task.taskId, scope) === digest
    && (!skill || await currentSkillGroundTruth(projectRoot, task.taskId, skill.skillId, skill.source.digest))) {
    return { task, changed: false, current: await loadCurrentGroundTruth(projectRoot, task.taskId) };
  }
  const current = await loadCurrentGroundTruth(projectRoot, task.taskId);
  const pendingUserRefs = pendingUserSourceRefs(current, sourceCatalog);
  const request = {
    schemaVersion: "runtime-corrector.ground-truth-request.v2",
    instructions: [
      ...VERIFICATION_ROUTING_INSTRUCTIONS,
      ...SOURCE_INSTRUCTIONS,
      "Extract outcome-sized task Ground Truth claims from real user messages, explicitly supplied materials, and verifiable project constraints. Keep each user operation/result together with its validation, negative branches, conditions, exceptions and prohibitions; separate distinct workflows, not individual sentences. Keep clauses identifiable for precise feedback.",
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
      ...(skill ? ["Also return a natural-language Skill constraint graph covering required steps, prerequisites, conditions, inputs, outputs, and prohibited behavior."] : []),
    ],
    taskId: task.taskId,
    hookEventId: eventId(input),
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
    skill: skill ? {
      skillId: skill.skillId,
      directory: skill.directory.replaceAll("\\", "/"),
      digest: skill.source.digest,
      truncated: skill.source.truncated,
      files: skill.source.files,
    } : null,
    // Task baseline alignment shares the bounded, read-only source transport.
    // Keep the original request/catalog for delta validation; only its private
    // disclosure view is paged. Skill/artifact extraction retains its protocol.
    ...(!skill && !artifact ? {
      reviewScope: { kind: "baseline", boundedBasis: true, objectIds: [], sourceIds: [] },
    } : {}),
  };
  let handle;
  const extractionSchema = skill ? SKILL_GROUND_TRUTH_REVIEW_SCHEMA : request.reviewScope?.kind === "baseline"
    ? { ...GROUND_TRUTH_REVIEW_SCHEMA, properties: { ...GROUND_TRUTH_REVIEW_SCHEMA.properties,
      checkerError: { type: ["string", "null"], maxLength: 768 } } } : GROUND_TRUTH_REVIEW_SCHEMA;
  try {
    handle = await reviewerFactory({
      projectRoot,
      sessionCwd,
      taskId: task.taskId,
      parentSessionId: input.session_id,
      role: "ground-truth-extractor",
      reviewer: runtimeV2.reviewers.groundTruthExtractor,
      schema: extractionSchema,
      request,
      evidence: { snapshot, groundTruth: current, ...(skill ? { skillSource: skill.source } : {}) },
    });
    let delta = handle.result;
    const issues = validateJsonSchema(delta, extractionSchema);
    if (issues.length) throw new Error(`Ground Truth result invalid: ${issues[0].pointer} ${issues[0].message}`);
    if (delta.checkerError) throw Object.assign(new Error(`Stop baseline remains unverified: ${delta.checkerError}`),
      { code: "GROUND_TRUTH_BASIS_UNVERIFIED" });
    if (!Array.isArray(delta?.operations)) throw new Error("Ground Truth extractor omitted operations.");
    if (current.version > 0 && (current.frozenAtVersion != null || delta.taskClassification === "NEW_TASK")) {
      const operations = delta.operations.filter(operation => operation.authority === "USER_EXPLICIT"
        && !rejectedGroundTruthSource(operation, sourceCatalog)
        && pendingUserRefs.includes(userSourceRef(operation.source, sourceCatalog)));
      if (current.frozenAtVersion != null && delta.operations.some(operation => operation.authority !== 'USER_EXPLICIT'))
        await appendTaskJournal(projectRoot, task.taskId, { type: 'GROUND_TRUTH_POST_FREEZE_OPS_DROPPED', hookEventId: eventId(input),
          dropped: delta.operations.filter(operation => operation.authority !== 'USER_EXPLICIT').map(operation => ({ operation: operation.operation, authority: operation.authority })) });
      if (delta.taskClassification === "NEW_TASK" && !operations.length) {
        await appendTaskJournal(projectRoot, task.taskId, {
          type: "TASK_SWITCH_SUPPRESSED",
          hookEventName: input.hook_event_name ?? null,
          reason: "No unprocessed real user source authorizes this task change.",
          quarantinedOperations: Array.isArray(delta.operations) ? delta.operations.length : 0,
          quarantinedDelta: delta,
        });
      }
      if (pendingUserRefs.length && delta.operations.length && !operations.length)
        throw Object.assign(new Error("New user input has no valid grounded delta; baseline remains pending."), { code: "GROUND_TRUTH_INPUT_UNVERIFIED" });
      delta = { ...delta, operations };
    }
    let applied;
    const baselineCommit = handle.baselineTask ? { ...handle.baselineTask,
      id: handle.baselineTask.requestId, scope, cursorDigest: digest } : null;
    try {
      applied = await applyGroundTruthDelta({
        projectRoot,
        taskId: task.taskId,
        delta,
        sourceCatalog,
        evidenceCapture: runtimeV2.dynamicGroundTruth.evidenceCapture,
        hookEventId: eventId(input),
        baselineCommit,
      });
      if (baselineCommit && applied.stale) throw Object.assign(new Error('Baseline publication rejected stale input'), { code: 'BASELINE_INPUT_CHANGED' });
    } catch (validationError) {
      if (baselineCommit && (baselineCommit.signal?.aborted || ['BASELINE_INPUT_CHANGED', 'BASELINE_COMMIT_CONFLICT', 'REVIEWER_DEADLINE'].includes(validationError.code))) throw validationError;
      const repairRequest = path.join(handle.requestDirectory, "ground-truth-repair-request.json");
      const repairContext = {
        schemaVersion: "runtime-corrector.ground-truth-repair-request.v2",
        validationError: validationError.message,
        rejectedDelta: delta,
        currentGroundTruth: await loadCurrentGroundTruth(projectRoot, task.taskId),
        instructions: [
          "Repair the Ground Truth delta without changing the evidence-based assessment.",
          "Use only canonical schema categories.",
          "Use non-ADD operations only with an exact claimId from currentGroundTruth.claims.",
          "If no safe operation is justified, return an empty operations array.",
        ],
      };
      await atomicWriteJson(repairRequest, repairContext);
      delta = await handle.followUp({
        prompt: `[runtime-corrector:internal] The Ground Truth delta failed domain validation: ${validationError.message}. Read ${repairRequest.replaceAll("\\", "/")} and repair it. Return only structured output.`,
        nextSchema: extractionSchema,
        nextReviewer: runtimeV2.reviewers.groundTruthExtractor,
      });
      const repairedIssues = validateJsonSchema(delta, extractionSchema);
      if (repairedIssues.length) throw new Error(`Ground Truth repair invalid: ${repairedIssues[0].pointer} ${repairedIssues[0].message}`);
      if (current.version > 0 && (current.frozenAtVersion != null || delta.taskClassification === "NEW_TASK")) {
        if (delta.operations.some(operation => operation.authority !== "USER_EXPLICIT"
          || rejectedGroundTruthSource(operation, sourceCatalog)
          || !pendingUserRefs.includes(userSourceRef(operation.source, sourceCatalog))))
          throw Object.assign(new Error("Repair cannot introduce changes without a new real user source."), { code: "GROUND_TRUTH_INPUT_UNVERIFIED" });
      }
      applied = await applyGroundTruthDelta({
        projectRoot,
        taskId: task.taskId,
        delta,
        sourceCatalog,
        evidenceCapture: runtimeV2.dynamicGroundTruth.evidenceCapture,
        hookEventId: eventId(input),
        baselineCommit,
      });
      if (baselineCommit && applied.stale) throw Object.assign(new Error('Baseline repair publication rejected stale input'), { code: 'BASELINE_INPUT_CHANGED' });
      await appendTaskJournal(projectRoot, task.taskId, {
        type: "GROUND_TRUTH_DELTA_REPAIRED",
        hookEventId: eventId(input),
        validationError: validationError.message,
      });
    }
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
    if (skill && delta.skillGroundTruth) {
      await persistSkillGroundTruth({
        projectRoot,
        taskId: task.taskId,
        skillId: skill.skillId,
        skillDigest: skill.source.digest,
        constraints: delta.skillGroundTruth.constraints ?? [],
        taskOverlays: delta.skillGroundTruth.taskOverlays ?? [],
      });
    }
    if (skill && !await currentSkillGroundTruth(projectRoot, task.taskId, skill.skillId, skill.source.digest)) {
      throw new Error("Skill Ground Truth was not durably established for the current source.");
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
    if (!baselineCommit) await markSourceCursor(projectRoot, task.taskId, scope, digest);
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

async function mutateWatcher(projectRoot, taskId, watcherId, updater) {
  let snapshot = null;
  await withTaskState({ projectRoot, taskId }, (state) => {
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
    const feedback = state.skillFeedbacks[skillId];
    if (feedback?.epochId === state.correctionEpoch.id
      && feedback.count >= runtimeV2.skillCorrection.maxFeedbacksPerSkill) {
      watcher = { status: "SKIPPED_FEEDBACK_BUDGET", skillId };
      return;
    }
    const active = Object.values(state.watchers).find(
      (candidate) => candidate.skillId === skillId && candidate.status === "ACTIVE",
    );
    if (active) {
      if (!active.invocationIds.includes(input.tool_use_id ?? eventId(input))) {
        active.invocationIds.push(input.tool_use_id ?? eventId(input));
      }
      active.skillDigest = source.digest;
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
  return lines.join("\n");
}

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
  if (groundTruthRefresh?.unverified) {
    await mutateWatcher(projectRoot, task.taskId, watcher.watcherId, (active) => {
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
        "First classify completion as COMPLETED or NOT_COMPLETED.",
        "When NOT_COMPLETED and forcePartial is false, return no findings.",
        "When completed, assess required steps, ordering constraints, conditions, inputs, outputs, and prohibited behavior using session evidence.",
        "When forcePartial is true, assess only executed steps and activated constraints; future unexecuted steps are not deviations unless the agent claimed completion or abandonment.",
        "A Stop event with forcePartial=true is itself a completion or abandonment claim. Report a finding when a mandatory prerequisite of that claimed completion is absent, even if completionStatus is NOT_COMPLETED.",
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
    const review = handle.result;
    if (review.checkerError?.trim()) {
      const evaluationId = uniqueId("evaluation");
      await atomicWriteJson(path.join(skillRoot, "evaluations", `${evaluationId}.json`),
        { evaluationId, watcherId: watcher.watcherId, currentTurn, forcePartial, status: "UNVERIFIED", review });
      throw new Error(`Skill checker could not establish a reliable assessment: ${review.checkerError}`);
    }
    if (review.completionStatus === "NOT_COMPLETED" && !forcePartial) {
      await mutateWatcher(projectRoot, task.taskId, watcher.watcherId, (active) => {
        active.lastCheckTurn = currentTurn;
        active.nextCheckTurn += runtimeV2.skillCorrection.completionCheckIntervalTurns;
        active.evaluationCount += 1;
        active.lastEvidenceDigest = sha256({ snapshot: snapshot.digest, skill: skillSource?.digest,
          truth: groundTruthRefresh?.current?.digest });
      });
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
    await mutateWatcher(projectRoot, task.taskId, watcher.watcherId, (active, state) => {
      active.lastCheckTurn = currentTurn;
      active.evaluationCount += 1;
      active.status = review.findings.length > 0 ? "DEVIATION" : "PASS";
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
      { evaluationId, watcherId: watcher.watcherId, currentTurn, forcePartial, review },
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
    return { feedback, status: review.findings.length > 0 ? "DEVIATION" : "PASS", review };
  } catch (error) {
    await appendTaskJournal(projectRoot, task.taskId, {
      type: "SKILL_REVIEW_FAILED",
      watcherId: watcher.watcherId,
      error: error.message,
    });
    if (forcePartial) {
      await mutateWatcher(projectRoot, task.taskId, watcher.watcherId, (active) => {
        active.status = "UNVERIFIED";
      });
    }
    return { feedback: null, status: "UNVERIFIED", error };
  } finally {
    if (handle) await handle.close();
  }
}

async function checkDueWatchers(context) {
  const due = [];
  let currentTurn;
  await withTaskState({ projectRoot: context.projectRoot, taskId: context.task.taskId }, (state) => {
    currentTurn = state.turns.total;
    const stopping = context.input.hook_event_name === "Stop";
    due.push(...Object.values(state.watchers).filter((watcher) => (
      watcher.status === "ACTIVE" && (stopping || currentTurn >= watcher.nextCheckTurn)
    )));
  });
  const feedback = [];
  let activeTask = context.task;
  for (const watcher of due) {
    let groundTruthRefresh = null;
    let skillSource = null;
    const directory = await resolveSkillDirectory({
      skillId: watcher.skillId,
      projectRoot: context.projectRoot,
      pluginRoot: context.pluginRoot,
      configuredRoots: context.runtimeV2.skillCorrection.skillRoots,
    });
    if (directory) {
      const source = await scanSkillDirectory(directory);
      skillSource = source;
      groundTruthRefresh = await refreshGroundTruth({
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
    const basisDigest = sha256({ snapshot: context.snapshot.digest, skill: skillSource?.digest,
      truth: groundTruthRefresh.current?.digest });
    if (!groundTruthRefresh.unverified && context.input.hook_event_name !== "Stop" && currentTurn < watcher.maxTurn
      && watcher.lastEvidenceDigest === basisDigest) {
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
    if (assessment.feedback) feedback.push(assessment.feedback);
  }
  return { feedback, task: activeTask };
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

function hasActiveSkillWatcher(task) {
  return Object.values(task?.watchers ?? {}).some((watcher) => watcher?.status === "ACTIVE");
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
  await maybeRunTaskOnboarding({
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
      const refresh = await refreshGroundTruth({ input, projectRoot, sessionCwd: path.resolve(input.cwd ?? projectRoot),
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

export async function refreshRuntimeRequirements({ projectRoot, input, plan, reviewerFactory, assessmentContext }) {
  const task = await findTask({ projectRoot, sessionId: input.session_id });
  if (!task) throw new Error("No existing task for requirement update.");
  // This command permits callers without an assessment context. Give each
  // such request its own identity instead of sharing an undefined cache key.
  return withTaskDecision({ projectRoot, taskId: task.taskId, context: { ...assessmentContext,
    assessmentId: assessmentContext?.assessmentId ?? uniqueId("requirements"), kind: "requirements" } }, async () => {
    const snapshot = await readTranscriptSnapshot(input.transcript_path);
    const refresh = await refreshGroundTruth({ input: { ...input, hook_event_name: "Stop" }, projectRoot, sessionCwd: input.cwd, task,
      runtimeV2: plan.runtimeV2, reviewerFactory, snapshot });
    await refresh.handle?.close();
    if (refresh.unverified) throw new Error("Requirement baseline extraction failed; requirement remains pending.");
    await withTaskState({ projectRoot, taskId: task.taskId }, (state) => {
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
  if (input.hook_event_name === "Stop") {
    if (!String(input.last_assistant_message ?? "").trim()) {
      snapshot = await readTranscriptSnapshot(input.transcript_path);
      const transcriptMessage = latestAssistantText(snapshot);
      if (transcriptMessage) input = { ...input, last_assistant_message: transcriptMessage };
    }
    const shouldRunFullStop = decisionScope.getStore()?.context?.mode === "verify_only"
      || task?.correctionBarrier?.turnActivated === true
      || hasActiveSkillWatcher(task)
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
    const watcherOutcome = runtimeV2.skillCorrection.enabled && hasActiveSkillWatcher(task)
      ? await withTaskResourceLock({ projectRoot, taskId: task.taskId, resource: "skill-watchers",
        timeoutMs: WATCHER_RECONCILE_LOCK_TIMEOUT_MS, staleMs: WATCHER_RECONCILE_LOCK_TIMEOUT_MS, reclaimDeadOwner: true },
      () => checkDueWatchers({ input, projectRoot, pluginRoot, sessionCwd: path.resolve(input.cwd ?? projectRoot),
        task, runtimeV2, reviewerFactory: canonicalReviewerFactory, snapshot })) : null;
    task = watcherOutcome?.task ?? task;
    const armed = await stopGateArmedForTask({ projectRoot, task, runtimeV2, snapshot });
    const frozenPolicy=await freezeStopReviewPolicy({projectRoot,taskId:task.taskId,runtimeV2});
    const frozenRuntime = { ...runtimeV2, stopCorrection: { ...runtimeV2.stopCorrection,...frozenPolicy, enabled: armed } };
    const stop = await runProductionStop({ input, projectRoot, task, runtimeV2: frozenRuntime,
      reviewerFactory: canonicalReviewerFactory, host: stopHost, env, snapshot,
      stopFeedbackDeferred,
      verificationOnly: decisionScope.getStore()?.context?.mode === "verify_only",
      verificationId: decisionScope.getStore()?.context?.assessmentId,
      isCurrent: async () => {
        if (canonicalReviewerFactory.reviewAbortSignal?.aborted || stopHost?.isCurrent && !await stopHost.isCurrent()) return false;
        const current = await readTranscriptSnapshot(input.transcript_path);
        return current.lastUserEntryKey === snapshot.lastUserEntryKey && current.groundTruthDigest === snapshot.groundTruthDigest;
      },
      prepare: async ({ signal, deadlineAt }) => {
        const factory = Object.assign(options => canonicalReviewerFactory({ ...options,
          deadlineAt: Math.min(options.deadlineAt ?? Infinity, deadlineAt), abortSignal: signal }), canonicalReviewerFactory);
        factory.reviewDeadlineAt = deadlineAt; factory.reviewAbortSignal = signal;
        await crossCorrectionBarrier({ input, projectRoot, runtimeV2: frozenRuntime, reviewerFactory: factory, task, snapshot, env });
        const refresh = runtimeV2.dynamicGroundTruth.enabled ? await refreshGroundTruth({ input, projectRoot,
          sessionCwd: path.resolve(input.cwd ?? projectRoot), task, runtimeV2: frozenRuntime, reviewerFactory: factory, snapshot })
          : { current: await loadCurrentGroundTruth(projectRoot, task.taskId) };
        if (refresh.unverified) throw refresh.error ?? new Error("Ground Truth preparation is unverified.");
        void refresh.handle?.close?.();
        const preparedTask = refresh.task ?? task;
        const groundTruth = refresh.current;
        const policy = await freezeStopReviewPolicy({projectRoot,taskId:preparedTask.taskId,runtimeV2:frozenRuntime});
        const population = await buildMetricPopulation({ projectRoot, taskId: preparedTask.taskId, groundTruth,
          skillDocuments: await skillDocuments(projectRoot, preparedTask.taskId), reviewPolicy: policy,
          artifactMetricIds: [...new Set((plan.configuredArtifacts ?? plan.artifacts ?? []).flatMap(artifact => artifact.metrics ?? []))],
          sourceOnlyDelivery: isSourceOnlyDelivery(plan.configuredArtifacts ?? plan.artifacts) });
        let deterministicReview;
        const artifacts = plan.configuredArtifacts ?? plan.artifacts ?? [];
        const request = { schemaVersion: 'runtime-corrector.workspace-stop.v1', hook: sanitizedHookInput(input), population,
          groundTruthPath: path.join(taskDirectory(projectRoot, preparedTask.taskId), 'ground-truth/current.json'),
          instructions: [...PROCESS_REVIEW_INSTRUCTIONS, 'Plan one review across all assigned metrics; use original files, diffs and host edits as entry points.'],
          classificationContract: 2,
          workflowStages: eligibleStopStages(groundTruth, [...new Set(artifacts.map(artifact => artifact.stage).filter(Boolean))]), workflowArtifacts: artifacts,
          fileQualityReviewEnabled: policy.fileQualityReviewEnabled,
          reviewScope: { kind: 'workspace-stop' },
          ...(decisionScope.getStore()?.context?.mode === 'verify_only' ? { fixedStopClassification: { stopClassification: 'TASK_COMPLETE', stage: null } } : {}) };
        let unifiedReview = await factory({ projectRoot, taskId: preparedTask.taskId, parentSessionId: input.session_id,
          role: 'stop-reviewer', reviewer: runtimeV2.reviewers.stopReviewer, schema: STOP_REVIEW_SCHEMA, request,
          skillRoots: runtimeV2.skillCorrection.skillRoots,
          excludedEvidencePaths: [stopSessionDirectory({ input, host: stopHost, env })].filter(Boolean),
          evidence: { snapshot, groundTruth }, onScope: async classification => {
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
            const selected = selectStopPopulation(population, classification, artifacts);
            if (!runtimeV2.implementationCorrection.enabled) return { artifactCandidates };
            const owned = implementationPopulation(selected, { groundTruth, stage: classification.stopClassification === 'TASK_COMPLETE' ? null : classification.stage }).population;
            if (Object.values(owned.metrics).some(objects => objects.length)) deterministicReview = await runDeterministicImplementationChecks({
              projectRoot, runtimeV2, groundTruth, enabled: policy.metrics.M09 === true });
            if (!['M12', 'M13', 'M15'].some(id => selected.metrics[id]?.some(object => object.verificationTarget === 'IMPLEMENTATION'))) return { artifactCandidates, deterministicReview };
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
              return { artifactCandidates, deterministicReview, deviceEvidence: { origin: 'PROGRAM_VERIFICATION', startedAt, endedAt: Date.now(), verification } };
            } catch (cause) { return { artifactCandidates, deterministicReview, deviceEvidence: { origin: 'PROGRAM_VERIFICATION', status: 'UNVERIFIED', reason: cause.message } }; }
          } });
        try {
          const issues = validateJsonSchema(unifiedReview.result, STOP_REVIEW_SCHEMA);
          if (issues.length) throw Object.assign(new Error('The workspace reviewer returned an invalid Stop result'), { code: 'STOP_REVIEW_INVALID' });
          unifiedReview = { ...unifiedReview, sourceCitations: await unifiedReview.getSourceCitations?.(unifiedReview.result) ?? unifiedReview.sourceCitations ?? [] };
          const classification = { stopClassification: unifiedReview.result.stopClassification, stage: unifiedReview.result.stage ?? null };
          return { taskId: preparedTask.taskId, groundTruth, classification, population: selectStopPopulation(population, classification, artifacts),
            fullPopulation: population, recheckObjectIds: Object.values(population.metrics).flat().map(object => object.objectId), request, unifiedReview, deterministicReview };
        } finally { await closeStopReviewerSafely(unifiedReview, projectRoot, preparedTask.taskId); }
      } });
    const watcherFeedback = watcherOutcome?.feedback ?? [];
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
    });
    if (!directory) {
      await appendTaskJournal(projectRoot, task.taskId, { type: "SKILL_SOURCE_UNRESOLVED", skillId });
      return { handled: true, taskId: task.taskId, reason: "SKILL_SOURCE_UNRESOLVED" };
    }
    skill = { skillId, directory, source: await scanSkillDirectory(directory) };
  }

  let refresh = { task, changed: false, current: await loadCurrentGroundTruth(projectRoot, task.taskId) };
  const shouldRefresh = runtimeV2.dynamicGroundTruth.enabled && (
    (input.hook_event_name === "PostToolUse" && artifact)
    || input.hook_event_name === "Stop" && hasStopReviews(stopReviewPolicy)
    || (input.hook_event_name === "PreToolUse" && input.tool_name === "Skill")
  );
  if (shouldRefresh) {
    refresh = await refreshGroundTruth({
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
    if (refresh.unverified || !await currentSkillGroundTruth(projectRoot, task.taskId, skill.skillId, skill.source.digest)) {
      if (refresh.handle) await refresh.handle.close();
      await appendTaskJournal(projectRoot, task.taskId, { type: "SKILL_WATCH_NOT_ESTABLISHED", skillId: skill.skillId,
        skillDigest: skill.source.digest, reason: refresh.error?.message ?? "Current Skill Ground Truth is unavailable." });
      return { handled: true, taskId: task.taskId, reason: "SKILL_WATCH_NOT_ESTABLISHED",
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
    const artifactReviewEnabled = runtimeV2.artifactCorrection.groundTruthReviewEnabled
      || (artifact.metricCheckpoint && runtimeV2.artifactCorrection.stageMetricsEnabled);
    if (!artifactReviewEnabled) {
      if (refresh.handle) await refresh.handle.close();
      return {
        handled: true,
        taskId: task.taskId,
        feedback: feedback.join("\n\n") || null,
        groundTruthChanged: refresh.changed,
        artifactReviewContext: null,
        reviewerHandle: null,
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
