import { promises as fs } from "node:fs";
import path from "node:path";

import { DEFAULT_LOCALE, formatMessage } from "../messages.mjs";
import { loadCurrentGroundTruth, applyGroundTruthDelta, persistSkillGroundTruth } from "./ground-truth-ledger.mjs";
import {
  dismissInformationalFamilies,
  familyIdForFinding,
  loopBoundedFamilyIds,
  markMetricPassesFixed,
  recordDeviationFindings,
  ROOT_CAUSE_IDS,
} from "./deviations.mjs";
import { eventId } from "./event-identity.mjs";
import { mergeJudgementsByObjectId, runImplementationReview } from "./impl-review.mjs";
import { cleanupExpiredInternalRuns, inspectInternalRun } from "./internal-run.mjs";
import { buildMetricPopulation, calculateMetricReport } from "./metrics.mjs";
import { materialManifest, maybeRunTaskOnboarding } from "./onboarding.mjs";
import { OUTPUT_TREE_DIRECTORY } from "./paths.mjs";
import {
  GROUND_TRUTH_REVIEW_SCHEMA,
  SKILL_REVIEW_SCHEMA,
  STOP_REVIEW_SCHEMA,
  startRoleReviewer,
} from "./reviewer.mjs";
import {
  resolveSkillDirectory,
  scanSkillDirectory,
  selectedSkill,
  skillIdFromInput,
} from "./skill-source.mjs";
import { handleRuntimeV2SessionEnd } from "./session-end.mjs";
import {
  appendTaskJournal,
  ensureTask,
  findTask,
  startCorrectionEpoch,
  startNewTask,
  taskDirectory,
  withTaskResourceLock,
  withTaskState,
} from "./task-store.mjs";
import { readTranscriptSnapshot, reconcileTurnState } from "./transcript.mjs";
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
const COMPLETION_CLAIM_PATTERN = /(?:(?:已|已经|现已|全部|均已|成功)(?:完成|实现|修复|修好|解决|交付|做好|做完)|(?:完成|实现|修复|修好|解决|交付|做好|做完)(?:了|完毕|并(?:验证|测试)?|[,，。！!]|$)|(?:所有|全部)(?:要求|需求|任务|工作)(?:均|都|全部)?(?:已)?(?:满足|完成|实现|解决)|开发完毕|(?:无需|无须|不需要)(?:再)?(?:做)?(?:修改|改动|变更)|\b(?:all|every)\s+(?:requirements?|requested\s+changes?|tasks?|work\s+items?)\s+(?:(?:are|were)\s+|(?:have|has)\s+been\s+)?(?:satisfied|fulfilled|complete(?:d)?|implemented|addressed)\b|\bno\s+(?:further\s+)?changes?\s+(?:(?:are|were)\s+)?(?:required|needed)\b|\b(?:everything|(?:the\s+)?(?:task|stage|implementation|project|work))\s+(?:(?:(?:is|was)\s+|(?:has|have)\s+been\s+)(?:complete(?:d)?|finished|implemented|fixed|resolved|delivered)\b|(?:complete(?:d)?|finished|implemented|fixed|resolved|delivered)(?:\s+(?:and\s+)?(?:tested|verified))?(?=\s*(?:[.!]|$)))|(?:^|\n)\s*(?:done|complete(?:d)?|finished|implemented|fixed|resolved|delivered)(?:\s+(?:and\s+)?(?:tested|verified))?[.!]?\s*(?:$|\n))/imu;


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
  const materials = await materialManifest(runtimeV2.dynamicGroundTruth.materialRoots);
  const scope = groundTruthScope(input, skill, artifact);
  const digest = sha256({
    userEvidence: snapshot.groundTruthDigest,
    prompt: input.hook_event_name === "UserPromptSubmit" ? input.prompt : null,
    scope,
    skillDigest: skill?.source.digest ?? null,
    materials: materials.digest,
  });
  if (await sourceCursor(projectRoot, task.taskId, scope) === digest) {
    return { task, changed: false, current: await loadCurrentGroundTruth(projectRoot, task.taskId) };
  }
  const current = await loadCurrentGroundTruth(projectRoot, task.taskId);
  const request = {
    schemaVersion: "runtime-corrector.ground-truth-request.v2",
    instructions: [
      "Extract atomic task Ground Truth claims from real user messages, explicitly supplied materials, and verifiable project constraints.",
      "Assistant messages, hook feedback, internal reviewer output, and agent-authored artifacts are never USER_EXPLICIT.",
      "Do not invent a positive requirement from ambiguous negative feedback; use BASIS_PENDING.",
      "AGENT_INFERRED claims must be SOFT.",
      "Use only the category enum exposed by the output schema; map functional or atomic requirements to requirements and workflow procedures to workflowSteps.",
      "Use ADD for new claims. SUPERSEDE, RETRACT, CONFLICT, and RESOLVE require an exact claimId already present in currentGroundTruth; never invent or omit that reference.",
      "When currentGroundTruth.version is 0, normally emit only ADD operations. Ignore internal role prompts and correction-control messages as task claims.",
      "When the task materials are ambiguous about a behavior (e.g. whether a capability is login-gated), record it as an OPEN_QUESTION constraint that asks the developer to resolve it against the task document — never as a directive that asserts one resolution. A confident-sounding wrong directive is worse than a question.",
      "Atomize claims using the supported categories. In particular, use traceabilityRelations for M07 denominator objects, developmentStandards for M09, milestoneTargets for M14, and criticalJourneys for M15.",
      ...(current.frozenAtVersion != null ? [
        `The Ground Truth ledger is FROZEN at version ${current.frozenAtVersion} (task onboarding complete). Post-freeze, only USER_EXPLICIT operations grounded in NEW real user messages are applied; agent-inferred or re-derived material claims are dropped. When nothing new came from the user, return an empty operations array.`,
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
    skill: skill ? {
      skillId: skill.skillId,
      directory: skill.directory.replaceAll("\\", "/"),
      digest: skill.source.digest,
      truncated: skill.source.truncated,
      files: skill.source.files,
    } : null,
  };
  let handle;
  try {
    handle = await reviewerFactory({
      projectRoot,
      sessionCwd,
      taskId: task.taskId,
      parentSessionId: input.session_id,
      role: "ground-truth-extractor",
      reviewer: runtimeV2.reviewers.groundTruthExtractor,
      schema: GROUND_TRUTH_REVIEW_SCHEMA,
      request,
    });
    let delta = handle.result;
    if (!Array.isArray(delta?.operations)) throw new Error("Ground Truth extractor omitted operations.");
    if (delta.taskClassification === "NEW_TASK" && current.version > 0) {
      // Only a NEW USER REQUEST is a legitimate task boundary. A NEW_TASK
      // reclassification on a mid-turn event (PreToolUse/PostToolUse/Stop)
      // is classification drift, and honoring it aborts the active task —
      // orphaning its OPEN deviation families and killing its watchers,
      // severing the correction loop mid-run. NOTE: the extractor currently
      // runs only on PreToolUse/PostToolUse/Stop, so this guard effectively
      // pins one task per session — correct when a session works exactly one
      // frozen task. If interactive multi-task sessions are needed later,
      // gate the switch on a new user transcript entry
      // (snapshot.lastUserEntryKey) instead of the hook event name.
      if (input.hook_event_name === "UserPromptSubmit") {
        const nextTask = await startNewTask({
          projectRoot,
          sessionId: input.session_id,
          previousTaskId: task.taskId,
          reason: "EXTRACTOR_NEW_TASK",
        });
        task = nextTask;
      } else {
        await appendTaskJournal(projectRoot, task.taskId, {
          type: "TASK_SWITCH_SUPPRESSED",
          hookEventName: input.hook_event_name ?? null,
          reason: "NEW_TASK classification outside UserPromptSubmit is treated as drift, not a task boundary.",
          // QUARANTINE the delta too: it was extracted for a task the
          // extractor believes is NEW. Applying it to the pinned task would
          // replace or duplicate claims (revision resets, duplicate HARD
          // claims) and silently corrupt the frozen population mid-run.
          quarantinedOperations: Array.isArray(delta.operations) ? delta.operations.length : 0,
          quarantinedDelta: delta,
        });
        delta = { ...delta, operations: [] };
      }
    }
    let applied;
    try {
      applied = await applyGroundTruthDelta({
        projectRoot,
        taskId: task.taskId,
        delta,
        evidenceCapture: runtimeV2.dynamicGroundTruth.evidenceCapture,
        hookEventId: eventId(input),
      });
    } catch (validationError) {
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
        nextSchema: GROUND_TRUTH_REVIEW_SCHEMA,
        nextReviewer: runtimeV2.reviewers.groundTruthExtractor,
      });
      applied = await applyGroundTruthDelta({
        projectRoot,
        taskId: task.taskId,
        delta,
        evidenceCapture: runtimeV2.dynamicGroundTruth.evidenceCapture,
        hookEventId: eventId(input),
      });
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
    if (current.version > 0 && applied.hardChanged && delta.taskClassification !== "NEW_TASK") {
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
    await markSourceCursor(projectRoot, task.taskId, scope, digest);
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
  };
  let handle = groundTruthRefresh?.handle ?? null;
  try {
    let review;
    if (handle) {
      const secondRequest = path.join(handle.requestDirectory, "skill-assessment-request.json");
      await atomicWriteJson(secondRequest, request);
      review = await handle.followUp({
        prompt: `[runtime-corrector:internal] Ground Truth is now frozen. Read ${secondRequest.replaceAll("\\", "/")} and assess this Skill invocation. Return only structured output.`,
        nextSchema: SKILL_REVIEW_SCHEMA,
        nextReviewer: runtimeV2.reviewers.skillReviewer,
      });
    } else {
      handle = await reviewerFactory({
        projectRoot,
        sessionCwd,
        taskId: task.taskId,
        parentSessionId: input.session_id,
        role: "skill-reviewer",
        reviewer: runtimeV2.reviewers.skillReviewer,
        schema: SKILL_REVIEW_SCHEMA,
        request,
      });
      review = handle.result;
    }
    if (review.completionStatus === "NOT_COMPLETED" && !forcePartial) {
      await mutateWatcher(projectRoot, task.taskId, watcher.watcherId, (active) => {
        active.lastCheckTurn = currentTurn;
        active.nextCheckTurn += runtimeV2.skillCorrection.completionCheckIntervalTurns;
        active.evaluationCount += 1;
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
    const directory = await resolveSkillDirectory({
      skillId: watcher.skillId,
      projectRoot: context.projectRoot,
      pluginRoot: context.pluginRoot,
      configuredRoots: context.runtimeV2.skillCorrection.skillRoots,
    });
    if (directory) {
      const source = await scanSkillDirectory(directory);
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
    const assessment = await assessWatcher({
      ...context,
      watcher,
      currentTurn,
      forcePartial: context.input.hook_event_name === "Stop" || currentTurn >= watcher.maxTurn,
      groundTruthRefresh,
    });
    if (assessment.feedback) feedback.push(assessment.feedback);
  }
  return { feedback, task: activeTask };
}


function hardClaimIds(groundTruth) {
  return new Set((groundTruth.claims ?? []).filter((claim) => (
    claim.status === "ACTIVE" && claim.severity === "HARD"
  )).map((claim) => claim.claimId));
}


function findingIsBlocking(finding, hardIds) {
  if (!new Set(["blocker", "error"]).has(finding.severity)) return false;
  // Deterministic findings carry no ground-truth claim ids (their authority
  // is the materials manifest, the toolchain, or the connected target — not a
  // frozen claim), so they block on their deviationKey namespace instead of
  // the HARD-claim set: kit integration, the build gate, and device smoke
  // failures were all objectively verifiable and objectively failed.
  const deviationKey = String(finding.deviationKey ?? "");
  if (deviationKey.startsWith("impl:kit:") || deviationKey.startsWith("impl:build:") || deviationKey.startsWith("impl:device:")) return true;
  return (finding.violatedGroundTruthIds ?? []).some((claimId) => hardIds.has(claimId));
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
  const blocked = new Set(report.blockingObjects.map((object) => object.sourceId));
  return report.metrics.flatMap((metric) => metric.objects)
    .filter((object) => object.judgement === "PASS" && !blocked.has(object.sourceId))
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


function stopFeedback(review, report, attempt, maximum, exhausted, locale = DEFAULT_LOCALE) {
  const lines = [
    formatMessage(locale, "stop.header", { attempt, maximum }),
    review.summary,
  ];
  const assurance = review.deviceAssurance;
  if (assurance) {
    // A missing device changes verifiability, not correctness: always name
    // the level that actually verified this Stop so a static-only green is
    // never mistaken for a device-verified one.
    lines.push(assurance.level === "device"
      ? formatMessage(locale, "stop.assuranceDevice", { build: assurance.build, smoke: assurance.smoke })
      : formatMessage(locale, "stop.assuranceDegraded", { level: assurance.level, reason: assurance.reason }));
  }
  for (const object of report.blockingObjects) {
    lines.push(`- ${object.objectId}: ${object.reason}`);
  }
  const checkerErrorObjects = (report.metrics ?? [])
    .flatMap((metric) => metric.objects)
    .filter((object) => object.judgement === "CHECKER_ERROR")
    .slice(0, 5);
  for (const object of checkerErrorObjects) {
    lines.push(formatMessage(locale, "stop.checkerError", {
      objectId: object.objectId,
      reason: object.reason,
    }));
  }
  for (const finding of review.findings.slice(0, 5)) lines.push(`- ${finding.reason}`);
  lines.push(formatMessage(locale, exhausted ? "stop.exhausted" : "stop.continue"));
  return lines.join("\n");
}


// Retry ceiling for Stop-gate INFRASTRUCTURE failures (the gate could not run
// at all). Kept separate from stopCorrection.maxCorrectionsPerEpoch, which
// counts real deviations: an outage must not consume the developer's
// correction budget, and a correction budget must not be spent by an outage.
const MAX_STOP_INFRASTRUCTURE_RETRIES = 2;


/**
 * Feedback for a Stop whose own verification could not run. While retries
 * remain the gate blocks (a transient fault must not be laundered into a
 * verified completion); once they are exhausted it RELEASES with an explicit
 * unverified disclosure — the plugin's own faults may delay a completion, but
 * they must never trap a session. Mirrors the device ladder's discipline: an
 * unavailable check lowers the assurance level, it never flips a judgement.
 */
function unverifiedStopFeedback(reason, error = null, {
  attempt = 1,
  maximum = MAX_STOP_INFRASTRUCTURE_RETRIES,
  released = false,
  locale = DEFAULT_LOCALE,
} = {}) {
  return [
    released
      ? formatMessage(locale, "stop.unverifiedReleased", { maximum })
      : formatMessage(locale, "stop.unverifiedBlocked", { attempt, maximum }),
    formatMessage(locale, "stop.unverifiedReason", { reason }),
    ...(error?.message ? [formatMessage(locale, "stop.unverifiedError", { error: error.message })] : []),
    formatMessage(locale, released ? "stop.unverifiedDisclosure" : "stop.unverifiedRetry"),
    // The disarm remedy is addressed to the HUMAN and only travels on the
    // release path, which the host surfaces as a systemMessage. Putting it in
    // a block reason hands the policed agent its own escape hatch — a real
    // build read that hint and switched the gate off to finish.
    ...(released ? [formatMessage(locale, "stop.disarmHint")] : []),
  ].join("\n");
}


/**
 * Count one Stop-gate infrastructure failure and decide whether to keep
 * blocking. Returns { decision, feedback, ... } ready to return from
 * assessStop.
 */
async function stopInfrastructureFailure({ projectRoot, taskId, reason, error = null, persisted = null, locale = DEFAULT_LOCALE }) {
  let attempt = 0;
  await withTaskState({ projectRoot, taskId }, (state) => {
    state.stop.infrastructureFailures = (state.stop.infrastructureFailures ?? 0) + 1;
    attempt = state.stop.infrastructureFailures;
  });
  const released = attempt > MAX_STOP_INFRASTRUCTURE_RETRIES;
  await appendStopJournalSafely(projectRoot, taskId, {
    type: released ? "STOP_VERIFICATION_UNAVAILABLE" : "STOP_ASSESSMENT_RETRY",
    reason,
    attempt,
    maximum: MAX_STOP_INFRASTRUCTURE_RETRIES,
    error: error?.message ?? null,
  });
  return {
    decision: released ? "allow" : "block",
    feedback: unverifiedStopFeedback(reason, error, { attempt, maximum: MAX_STOP_INFRASTRUCTURE_RETRIES, released, locale }),
    // The disclosure must reach the user on a channel the Stop hook actually
    // consumes; additionalContext is not part of the Stop output contract.
    ...(released ? { verificationUnavailable: true } : {}),
    status: "UNVERIFIED",
    error: error ?? null,
    persisted,
  };
}


async function appendStopJournalSafely(projectRoot, taskId, event) {
  try {
    await appendTaskJournal(projectRoot, taskId, event);
  } catch {
    // The Stop decision is the safety boundary. A secondary journal failure
    // must never turn a fail-closed decision into an uncaught hook failure.
  }
}


async function closeStopReviewerSafely(handle, projectRoot, taskId) {
  if (!handle) return;
  try {
    await handle.close();
  } catch (error) {
    await appendStopJournalSafely(projectRoot, taskId, {
      type: "STOP_REVIEWER_CLOSE_FAILED",
      error: error.message,
    });
  }
}



/**
 * The Stop gate's armed state is captured when the task first crosses the
 * correction barrier and enforced for the task's lifetime.
 *
 * The gate lives in a config file inside the workspace the coding agent can
 * write to, so "is the gate on?" cannot be re-read from disk every event: an
 * agent that finds blocking inconvenient can simply turn it off. That is not
 * hypothetical — a full build did exactly that, disabling stopCorrection after
 * two blocks and then declaring completion.
 *
 * Disarming therefore requires the same authority as amending frozen Ground
 * Truth: a real user message. Mid-task edits from any other source are ignored
 * and journaled, so the attempt is visible rather than silently effective.
 */
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


async function assessStop({ input, projectRoot, sessionCwd, task, runtimeV2, reviewerFactory, groundTruthRefresh, snapshot, deviceVerifier = null }) {
  if (groundTruthRefresh.unverified) {
    const reason = "Ground Truth refresh failed; terminal review cannot verify this completion.";
    let persisted = null;
    try {
      persisted = await persistEvaluation(projectRoot, task.taskId, "stop", {
        status: "UNVERIFIED",
        reason,
        error: groundTruthRefresh.error?.message ?? null,
        transcriptDigest: snapshot.digest,
        transcriptCursor: snapshot.lastEntryKey,
      });
    } catch (error) {
      await appendStopJournalSafely(projectRoot, task.taskId, {
        type: "STOP_FAILURE_PERSIST_FAILED",
        reason: "GROUND_TRUTH_REFRESH_UNVERIFIED",
        error: error.message,
      });
    }
    await appendStopJournalSafely(projectRoot, task.taskId, {
      type: "STOP_ASSESSMENT_FAILED",
      reason: "GROUND_TRUTH_REFRESH_UNVERIFIED",
      error: groundTruthRefresh.error?.message ?? null,
      evaluationId: persisted?.evaluationId ?? null,
    });
    return stopInfrastructureFailure({
      projectRoot,
      taskId: task.taskId,
      reason,
      error: groundTruthRefresh.error ?? null,
      persisted,
      locale: runtimeV2.locale,
    });
  }
  const current = groundTruthRefresh.current ?? await loadCurrentGroundTruth(projectRoot, task.taskId);
  const population = await buildMetricPopulation({
    projectRoot,
    taskId: task.taskId,
    groundTruth: current,
    skillDocuments: await skillDocuments(projectRoot, task.taskId),
  });
  const request = {
    schemaVersion: "runtime-corrector.stop-review-request.v2",
    instructions: [
      "Classify this Stop before evaluating metrics.",
      "Only STAGE_COMPLETE and TASK_COMPLETE receive metric judgements.",
      "Judge every object in the supplied frozen population for the applicable stage; do not invent or omit objects.",
      "Use NOT_YET_APPLICABLE, NOT_APPLICABLE, UNVERIFIED, and BASIS_PENDING distinctly.",
      `Use only these rootCauseId values: ${[...ROOT_CAUSE_IDS].join(", ")}.`,
    ],
    taskId: task.taskId,
    hook: sanitizedHookInput(input),
    transcript: {
      digest: snapshot.digest,
      cursor: snapshot.lastEntryKey,
    },
    groundTruthPath: path.join(taskDirectory(projectRoot, task.taskId), "ground-truth", "current.json").replaceAll("\\", "/"),
    population,
  };
  let handle = groundTruthRefresh.handle ?? null;
  let review;
  try {
    if (handle) {
      const secondRequest = path.join(handle.requestDirectory, "assessment-request.json");
      await atomicWriteJson(secondRequest, request);
      review = await handle.followUp({
        prompt: `[runtime-corrector:internal] Ground Truth is now frozen. Read ${secondRequest.replaceAll("\\", "/")} and perform the Stop assessment. Return only structured output.`,
        nextSchema: STOP_REVIEW_SCHEMA,
        nextReviewer: runtimeV2.reviewers.stopReviewer,
      });
    } else {
      handle = await reviewerFactory({
        projectRoot,
        sessionCwd,
        taskId: task.taskId,
        parentSessionId: input.session_id,
        role: "stop-reviewer",
        reviewer: runtimeV2.reviewers.stopReviewer,
        schema: STOP_REVIEW_SCHEMA,
        request,
      });
      review = handle.result;
    }
    const hardIds = hardClaimIds(current);
    let blockingFindings = review.findings.filter((finding) => findingIsBlocking(finding, hardIds));
    if (!new Set(["STAGE_COMPLETE", "TASK_COMPLETE"]).has(review.stopClassification)) {
      const hasBlocking = blockingFindings.length > 0;
      let attempt = 0;
      let exhausted = false;
      await withTaskState({ projectRoot, taskId: task.taskId }, (state) => {
        if (state.stop.epochId !== state.correctionEpoch.id) {
          state.stop = { epochId: state.correctionEpoch.id, correctionAttempts: 0, lastAssessmentId: null };
        }
        if (hasBlocking) {
          if (state.stop.correctionAttempts < runtimeV2.stopCorrection.maxCorrectionsPerEpoch) {
            state.stop.correctionAttempts += 1;
          } else {
            exhausted = true;
          }
        }
        attempt = state.stop.correctionAttempts;
      });
      const persisted = await persistEvaluation(projectRoot, task.taskId, "stop", {
        review,
        metricReport: null,
        correctionAttempt: attempt,
        correctionBudgetExhausted: exhausted,
        transcriptDigest: snapshot.digest,
        transcriptCursor: snapshot.lastEntryKey,
      });
      if (hasBlocking) {
        await recordDeviationFindings({
          projectRoot,
          taskId: task.taskId,
          pipeline: "STOP",
          findings: blockingFindings,
          groundTruthVersion: current.version,
          evaluationId: persisted.evaluationId,
          // ACTUAL emission: the exhausted path returns feedback:null, so its
          // findings were never spoken even outside observe-only mode.
          delivered: runtimeV2.shadowMode !== true && !exhausted,
        });
      }
      await withTaskState({ projectRoot, taskId: task.taskId }, (state) => {
        state.stop.lastAssessmentId = persisted.evaluationId;
        // The ceiling counts CONSECUTIVE infrastructure failures: a real
        // assessment means the gate works again, so it must not stay one
        // blip away from permanently failing open.
        state.stop.infrastructureFailures = 0;
      });
      if (hasBlocking && !exhausted) {
        return {
          decision: "block",
          review,
          report: null,
          correctionAttempt: attempt,
          correctionBudgetExhausted: false,
          feedback: stopFeedback(
            review,
            { blockingObjects: [] },
            attempt,
            runtimeV2.stopCorrection.maxCorrectionsPerEpoch,
            false,
            runtimeV2.locale,
          ),
        };
      }
      return {
        decision: "allow",
        review,
        report: null,
        correctionAttempt: attempt,
        correctionBudgetExhausted: exhausted,
        feedback: null,
      };
    }
    // Implementation review (STAGE_COMPLETE / TASK_COMPLETE only): first-party
    // judgements of the built source against the frozen population, merged over
    // the stop reviewer's per objectId (impl wins — a duplicate objectId would
    // force CHECKER_ERROR). Runs identically in observe-only mode; observe-only
    // suppression applies only to outbound feedback, inherited from the Stop
    // path. Fails OPEN: an implementation-review fault must never take the run
    // down.
    let implementationReview = null;
    if (runtimeV2.implementationCorrection?.enabled) {
      try {
        const implReview = await runImplementationReview({
          ...(deviceVerifier ? { deviceVerifier } : {}),
          projectRoot,
          sessionCwd,
          taskId: task.taskId,
          parentSessionId: input.session_id,
          runtimeV2,
          reviewerFactory,
          population,
          groundTruth: current,
          groundTruthPath: request.groundTruthPath,
          rootCauseIds: [...ROOT_CAUSE_IDS],
        });
        review.findings = [...review.findings, ...implReview.findings];
        review.metricObjectJudgements = mergeJudgementsByObjectId(
          review.metricObjectJudgements,
          implReview.metricObjectJudgements,
        );
        blockingFindings = review.findings.filter((finding) => findingIsBlocking(finding, hardIds));
        // Kept whole for the persisted evaluation: after the merge the impl
        // reviewer's contribution is otherwise indistinguishable from the
        // stop reviewer's, making the run unauditable post-hoc.
        implementationReview = implReview;
        // Surfaced in stop feedback and persisted with the evaluation: the
        // reader must always know WHICH assurance level actually verified
        // this Stop (device / build / static), and why.
        review.deviceAssurance = implReview.deviceAssurance ?? null;
        await appendTaskJournal(projectRoot, task.taskId, {
          type: "IMPLEMENTATION_REVIEW_COMPLETED",
          judgements: implReview.metricObjectJudgements.length,
          findings: implReview.findings.length,
          sourceManifestCount: implReview.sourceManifestCount,
          deviceAssurance: implReview.deviceAssurance ?? null,
        });
      } catch (error) {
        await appendTaskJournal(projectRoot, task.taskId, {
          type: "IMPLEMENTATION_REVIEW_FAILED",
          error: error.message,
        });
      }
    }
    const report = calculateMetricReport({
      population,
      judgements: review.metricObjectJudgements,
    });
    const hasBlocking = stopAssessmentBlocks(report, blockingFindings);
    let attempt = 0;
    let exhausted = false;
    await withTaskState({ projectRoot, taskId: task.taskId }, (state) => {
      if (state.stop.epochId !== state.correctionEpoch.id) {
        state.stop = { epochId: state.correctionEpoch.id, correctionAttempts: 0, lastAssessmentId: null };
      }
      if (hasBlocking) {
        if (state.stop.correctionAttempts < runtimeV2.stopCorrection.maxCorrectionsPerEpoch) {
          state.stop.correctionAttempts += 1;
        } else {
          exhausted = true;
        }
      }
      attempt = state.stop.correctionAttempts;
    });
    const persisted = await persistEvaluation(projectRoot, task.taskId, "stop", {
      review,
      implementationReview,
      metricReport: report,
      correctionAttempt: attempt,
      correctionBudgetExhausted: exhausted,
      transcriptDigest: snapshot.digest,
      transcriptCursor: snapshot.lastEntryKey,
    });
    // Closure BEFORE recording this assessment's findings: a family recorded
    // and closed inside one assessment would otherwise get delivered+fixedAt
    // stamps milliseconds apart and launder into a critic-attributed closure
    // with zero developer action in between.
    await markMetricPassesFixed({
      projectRoot,
      taskId: task.taskId,
      passedObjectIds: passedMetricSourceIds(report),
    });
    await recordDeviationFindings({
      projectRoot,
      taskId: task.taskId,
      pipeline: "STOP",
      findings: [...blockingFindings, ...metricDeviationFindings(report)],
      groundTruthVersion: current.version,
      evaluationId: persisted.evaluationId,
      // ACTUAL emission: feedback goes out only on the block path
      // (hasBlocking && !exhausted); exhausted and clean stops emit nothing.
      delivered: runtimeV2.shadowMode !== true && hasBlocking && !exhausted,
    });
    await withTaskState({ projectRoot, taskId: task.taskId }, (state) => {
      state.stop.lastAssessmentId = persisted.evaluationId;
      state.stop.infrastructureFailures = 0;
      // COMPLETED only after the evaluation is durably persisted: a hook kill
      // between the two writes must never leave a COMPLETED task without its
      // final assessment on disk.
      if (!hasBlocking || exhausted) state.status = review.stopClassification === "TASK_COMPLETE" ? "COMPLETED" : state.status;
    });
    if (hasBlocking && !exhausted) {
      return {
        decision: "block",
        review,
        report,
        correctionAttempt: attempt,
        correctionBudgetExhausted: false,
        feedback: stopFeedback(review, report, attempt, runtimeV2.stopCorrection.maxCorrectionsPerEpoch, false, runtimeV2.locale),
      };
    }
    return {
      decision: "allow",
      review,
      report,
      correctionAttempt: attempt,
      correctionBudgetExhausted: exhausted,
      feedback: null,
    };
  } catch (error) {
    await appendStopJournalSafely(projectRoot, task.taskId, { type: "STOP_REVIEW_FAILED", error: error.message });
    await appendStopJournalSafely(projectRoot, task.taskId, {
      type: "STOP_ASSESSMENT_FAILED",
      reason: "STOP_REVIEW_EXCEPTION",
      error: error.message,
    });
    return stopInfrastructureFailure({
      projectRoot,
      taskId: task.taskId,
      reason: "The final Stop reviewer failed before producing a valid assessment.",
      error,
      locale: runtimeV2.locale,
    });
  } finally {
    await closeStopReviewerSafely(handle, projectRoot, task.taskId);
  }
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
  if (INCOMPLETE_CLAIM_PATTERN.test(message)) return false;
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
  const activatedAt = new Date().toISOString();
  await withTaskState({ projectRoot, taskId: activeTask.taskId }, (state) => {
    state.correctionBarrier = {
      ...(state.correctionBarrier ?? {}),
      turnActivated: true,
      lastHookEventId: eventId(input),
      lastTriggerEvent: input.hook_event_name,
      lastToolName: input.tool_name ?? null,
      activatedAt,
    };
    if (state.stop.armedAtStart === undefined) {
      state.stop.armedAtStart = runtimeV2.stopCorrection.enabled === true;
    }
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
  const result = await handleRuntimeV2EventInternal(options);
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
}) {
  const internal = await inspectInternalRun(env);
  if (internal.internal) return { handled: true, internal: true, skipped: "SKIPPED_INTERNAL" };
  if (input.hook_event_name === "SessionEnd") {
    return handleRuntimeV2SessionEnd({ input, projectRoot, env });
  }
  const runtimeV2 = plan.runtimeV2;
  if (!runtimeV2?.enabled) return { handled: false, reason: "V2_DISABLED" };
  if (!input.session_id) return { handled: false, reason: "MISSING_SESSION_ID" };

  if (input.hook_event_name === "SessionStart") {
    await Promise.allSettled([
      cleanupExpiredInternalRuns(projectRoot),
      cleanupStaleAtomicWrites(path.join(projectRoot, OUTPUT_TREE_DIRECTORY)),
    ]);
    return { handled: true, taskId: null, reason: "SESSION_START_RECOVERED" };
  }

  let task = await findTask({
    projectRoot,
    sessionId: input.session_id,
    explicitTaskId: explicitTaskId(env),
  });

  if (input.hook_event_name === "Stop") {
    const shouldRunFullStop = task?.correctionBarrier?.turnActivated === true
      || hasActiveSkillWatcher(task)
      || isRuntimeCorrectorStopRetry(input, task)
      || claimsCompletion(input);
    if (!shouldRunFullStop) {
      return { handled: true, taskId: task?.taskId ?? null, reason: "STOP_BARRIER_NOT_REQUIRED" };
    }
  }

  let snapshot = null;
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
      reviewerFactory,
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
    || input.hook_event_name === "Stop"
    || (input.hook_event_name === "PreToolUse" && input.tool_name === "Skill")
  );
  if (shouldRefresh) {
    refresh = await refreshGroundTruth({
      input,
      projectRoot,
      sessionCwd: path.resolve(input.cwd ?? projectRoot),
      task,
      runtimeV2,
      reviewerFactory,
      skill,
      artifact,
      snapshot,
    });
    task = refresh.task;
  }

  const feedback = [];
  if (skill) {
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

  if (SKILL_CHECK_EVENTS.has(input.hook_event_name) && runtimeV2.skillCorrection.enabled) {
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
      reviewerFactory,
      snapshot,
    }));
    task = watcherOutcome.task;
    feedback.push(...watcherOutcome.feedback);
  }

  if (input.hook_event_name === "Stop"
    && await stopGateArmedForTask({ projectRoot, task, runtimeV2, snapshot })) {
    const stop = await assessStop({
      deviceVerifier,
      input,
      projectRoot,
      sessionCwd: path.resolve(input.cwd ?? projectRoot),
      task,
      runtimeV2,
      reviewerFactory,
      groundTruthRefresh: refresh,
      snapshot,
    });
    return {
      handled: true,
      taskId: task.taskId,
      decision: feedback.length > 0 ? "block" : stop.decision,
      feedback: [feedback.join("\n\n"), stop.feedback].filter(Boolean).join("\n\n") || null,
      stop,
    };
  }
  if (input.hook_event_name === "Stop" && feedback.length > 0) {
    if (refresh.handle) await refresh.handle.close();
    return {
      handled: true,
      taskId: task.taskId,
      decision: "block",
      feedback: feedback.join("\n\n"),
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
      population = await buildMetricPopulation({
        projectRoot,
        taskId: task.taskId,
        groundTruth: refresh.current,
        skillDocuments: await skillDocuments(projectRoot, task.taskId),
      });
    }
    return {
      handled: true,
      taskId: task.taskId,
      feedback: feedback.join("\n\n") || null,
      reviewerHandle: refresh.handle ?? null,
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
