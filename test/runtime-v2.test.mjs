import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { validateProjectConfig } from "../lib/policy/config-loader.mjs";
import { runSemanticReview } from "../lib/semantic-review.mjs";
import { compileRuntimeV2Config } from "../lib/runtime-v2/config.mjs";
import { recordFailOpenWarning } from "../lib/runtime-v2/fail-open.mjs";
import { recordDeviationFindings, ROOT_CAUSE_IDS } from "../lib/runtime-v2/deviations.mjs";
import {
  applyGroundTruthDelta,
  loadCurrentGroundTruth,
} from "../lib/runtime-v2/ground-truth-ledger.mjs";
import {
  createInternalRunLease,
  cleanupExpiredInternalRuns,
  inspectInternalRun,
  internalRunEnvironment,
  releaseInternalRunLease,
} from "../lib/runtime-v2/internal-run.mjs";
import { buildMetricPopulation, calculateMetricReport } from "../lib/runtime-v2/metrics.mjs";
import {
  finalizeArtifactRuntimeV2,
  handleRuntimeV2Event,
} from "../lib/runtime-v2/orchestrator.mjs";
import {
  atomicWrite,
  cleanupStaleAtomicWrites,
  readJson,
} from "../lib/runtime-v2/utils.mjs";
import {
  GROUND_TRUTH_REVIEW_SCHEMA,
  SKILL_REVIEW_SCHEMA,
  STOP_REVIEW_SCHEMA,
} from "../lib/runtime-v2/reviewer.mjs";
import { ensureTask, taskStatePath, withTaskState } from "../lib/runtime-v2/task-store.mjs";
import { readTranscriptSnapshot, reconcileTurnState } from "../lib/runtime-v2/transcript.mjs";


async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-corrector-v2-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}


async function write(root, relative, contents) {
  const filePath = path.join(root, relative);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, "utf8");
  return filePath;
}


test("frozen Root Cause catalog is the ordered runtime source of truth", async () => {
  const catalog = JSON.parse(await fs.readFile(
    new URL("../config/root-cause-catalog.v1.json", import.meta.url),
    "utf8",
  ));
  assert.equal(catalog.schemaVersion, "runtime-corrector.root-cause-catalog.v1");
  assert.equal(catalog.status, "FROZEN");
  assert.ok(Array.isArray(catalog.rootCauses));
  const ids = catalog.rootCauses.map((rootCause) => rootCause.id);
  assert.ok(ids.every((id) => typeof id === "string" && id.trim().length > 0));
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes("OTHER"));
  assert.deepEqual([...ROOT_CAUSE_IDS], ids);
});


function v2Plan(projectRoot, overrides = {}) {
  const config = {
    version: 2,
    dynamicGroundTruth: { enabled: true },
    skillCorrection: {
      enabled: true,
      selection: { mode: "include", include: ["demo"] },
      completionCheckIntervalTurns: 10,
      maxWatchTurns: 30,
      maxFeedbacksPerSkill: 1,
    },
    artifactCorrection: { groundTruthReviewEnabled: true, stageMetricsEnabled: true },
    stopCorrection: { enabled: true, maxCorrectionsPerEpoch: 3 },
    ...overrides,
  };
  return {
    runtimeV2: compileRuntimeV2Config(config, {
      policyRoot: path.join(projectRoot, ".runtime-corrector"),
    }),
  };
}


function transcriptEntries(turns) {
  const entries = [];
  for (let index = 1; index <= turns; index += 1) {
    entries.push({
      type: "user",
      uuid: `user-${index}`,
      message: { id: `user-message-${index}`, content: `request ${index}` },
    });
    entries.push({
      type: "assistant",
      uuid: `assistant-${index}`,
      message: { id: `assistant-message-${index}`, content: `work ${index}` },
    });
  }
  return entries.map((entry) => JSON.stringify(entry)).join("\n");
}


function skillReview() {
  return {
    summary: "The Skill completed but skipped a required verification step.",
    completionStatus: "COMPLETED",
    findings: [{
      deviationKey: "demo:verify",
      rootCauseId: "SKILL_REQUIRED_STEP_OMITTED",
      severity: "error",
      reason: "Verification was not performed.",
      actualEvidence: ["The session claims completion without verification evidence."],
      expectedConstraint: "Verify the result before completion.",
      violatedGroundTruthIds: ["demo-verify"],
      suggestedNextAction: "Run the verification step.",
    }],
  };
}


function stopReview(request) {
  const objects = Object.values(request.population.metrics).flat();
  return {
    summary: "The task is complete but one required object still deviates.",
    stopClassification: "TASK_COMPLETE",
    stage: "implementation",
    findings: [],
    metricObjectJudgements: objects.map((object) => ({
      objectId: object.objectId,
      judgement: object.metricId === "M01" ? "DEVIATION" : "PASS",
      reason: object.metricId === "M01" ? "The requirement was not decomposed." : "Satisfied.",
      evidence: object.metricId === "M01" ? [] : ["session evidence"],
    })),
  };
}


function fakeReviewerFactory({ stopAssessment = stopReview } = {}) {
  let serial = 0;
  const calls = [];
  const factory = async ({ projectRoot, role, request, schema }) => {
    serial += 1;
    const requestDirectory = path.join(projectRoot, ".runtime-correction", "fake-review", String(serial));
    await fs.mkdir(requestDirectory, { recursive: true });
    calls.push({ role, request, schema });
    let result;
    if (schema === GROUND_TRUTH_REVIEW_SCHEMA) {
      result = {
        summary: "Ground Truth refreshed.",
        taskClassification: "CONTINUATION",
        operations: request.currentGroundTruth.version === 0 ? [{
          operation: "ADD",
          category: "requirements",
          text: "Implement the confirmed Runtime Corrector v2 behavior.",
          authority: "USER_EXPLICIT",
          severity: "HARD",
          source: { ref: "transcript:user-1" },
        }] : [],
        skillGroundTruth: request.skill ? {
          constraints: [{
            constraintId: "demo-verify",
            kind: "STEP",
            modality: "MUST",
            statement: "Verify the result before completion.",
          }],
          taskOverlays: [],
        } : null,
      };
    } else if (schema === SKILL_REVIEW_SCHEMA) {
      result = skillReview();
    } else if (schema === STOP_REVIEW_SCHEMA) {
      result = await stopAssessment(request, { projectRoot });
    } else {
      throw new Error(`Unexpected fake reviewer role: ${role}`);
    }
    return {
      result,
      requestDirectory,
      async followUp({ nextSchema }) {
        if (nextSchema === SKILL_REVIEW_SCHEMA) return skillReview();
        if (nextSchema === STOP_REVIEW_SCHEMA) {
          const assessment = JSON.parse(await fs.readFile(
            path.join(requestDirectory, "assessment-request.json"),
            "utf8",
          ));
          return stopAssessment(assessment, { projectRoot });
        }
        throw new Error("Unexpected fake follow-up schema.");
      },
      async close() {},
    };
  };
  factory.calls = calls;
  return factory;
}


test("version 2 permits a correction-only project and preserves opt-in defaults", () => {
  const document = {
    version: 2,
    artifacts: [],
    dynamicGroundTruth: { enabled: true },
    skillCorrection: {
      enabled: true,
      selection: { mode: "include", include: ["demo"] },
    },
  };
  assert.equal(validateProjectConfig(document, "config.yaml"), document);
  const compiled = compileRuntimeV2Config(document);
  assert.equal(compiled.enabled, true);
  assert.equal(compiled.skillCorrection.completionCheckIntervalTurns, 10);
  assert.equal(compiled.skillCorrection.maxWatchTurns, 30);
  assert.equal(compiled.skillCorrection.maxFeedbacksPerSkill, 1);
  assert.throws(
    () => validateProjectConfig({ version: 1, artifacts: [] }, "config.yaml"),
    /at least one artifact/,
  );
  assert.throws(
    () => validateProjectConfig({
      version: 2,
      artifacts: [{ name: "result", patterns: ["result.md"] }],
      dynamicGroundTruth: { enabled: false },
      artifactCorrection: { groundTruthReviewEnabled: true },
    }, "config.yaml"),
    /groundTruthReviewEnabled requires dynamicGroundTruth/,
  );
});


test("atomic v2 state writes replace Windows files without leaving temporary artifacts", async (t) => {
  const root = await workspace(t);
  const target = path.join(root, "state.json");
  for (let index = 0; index < 25; index += 1) {
    await atomicWrite(target, `${JSON.stringify({ index })}\n`);
  }
  assert.deepEqual(await readJson(target), { index: 24 });
  assert.deepEqual((await fs.readdir(root)).filter((name) => name.endsWith(".tmp")), []);
});


test("lifecycle recovery removes only stale Runtime Corrector atomic temporaries", async (t) => {
  const root = await workspace(t);
  const stale = await write(root, ".task.json.1234.abcdef12.tmp", "stale");
  const recent = await write(root, ".task.json.1234.1234abcd.tmp", "recent");
  const unrelated = await write(root, "customer.tmp", "keep");
  const old = new Date(Date.now() - 60_000);
  await fs.utimes(stale, old, old);
  const removed = await cleanupStaleAtomicWrites(root, { staleMs: 30_000 });
  assert.deepEqual(removed, [stale]);
  await assert.rejects(fs.access(stale));
  await fs.access(recent);
  await fs.access(unrelated);
});


test("Ground Truth is append-only, versioned, and inferred claims cannot become hard", async (t) => {
  const root = await workspace(t);
  const task = await ensureTask({ projectRoot: root, sessionId: "session-gt" });
  const applied = await applyGroundTruthDelta({
    projectRoot: root,
    taskId: task.taskId,
    delta: {
      operations: [{
        operation: "ADD",
        category: "requirements",
        text: "An inferred implementation detail.",
        authority: "AGENT_INFERRED",
        severity: "HARD",
        source: { ref: "agent" },
      }, {
        operation: "ADD",
        category: "constraints",
        text: "A user-confirmed constraint.",
        authority: "USER_EXPLICIT",
        severity: "HARD",
        source: { ref: "user" },
      }],
    },
  });
  assert.equal(applied.current.version, 1);
  assert.equal(applied.current.claims.find((claim) => claim.authority === "AGENT_INFERRED").severity, "SOFT");
  assert.equal(applied.current.claims.find((claim) => claim.authority === "USER_EXPLICIT").severity, "HARD");
  const userClaim = applied.current.claims.find((claim) => claim.authority === "USER_EXPLICIT");
  await assert.rejects(
    applyGroundTruthDelta({
      projectRoot: root,
      taskId: task.taskId,
      delta: { operations: [{
        operation: "SUPERSEDE",
        claimId: userClaim.claimId,
        category: userClaim.category,
        text: "Agent inference tries to weaken the user constraint.",
        authority: "AGENT_INFERRED",
        severity: "SOFT",
        source: { ref: "agent" },
      }] },
    }),
    /cannot supersede higher-authority Ground Truth/,
  );
  assert.equal((await fs.readFile(path.join(root, ".runtime-correction", "tasks", task.taskId, "ground-truth", "history.jsonl"), "utf8")).trim().split("\n").length, 2);
});


test("internal reviewer leases bypass hooks and reject forged markers", async (t) => {
  const root = await workspace(t);
  const lease = await createInternalRunLease({
    projectRoot: root,
    taskId: "task-internal",
    role: "skill-reviewer",
  });
  const env = internalRunEnvironment(lease, {});
  assert.equal((await inspectInternalRun(env)).internal, true);
  assert.equal((await inspectInternalRun({ ...env, RUNTIME_CORRECTOR_INTERNAL_TOKEN: "forged" })).internal, false);
  const outcome = await handleRuntimeV2Event({
    input: { hook_event_name: "Stop", session_id: "internal-session", cwd: root },
    projectRoot: root,
    plan: v2Plan(root),
    env,
  });
  assert.equal(outcome.skipped, "SKIPPED_INTERNAL");
  assert.deepEqual(await cleanupExpiredInternalRuns(root, Date.parse(lease.expiresAt) + 1), [lease.runId]);
  assert.equal((await inspectInternalRun(env)).internal, false);
  await releaseInternalRunLease(lease);
});


test("identical v2 fail-open warnings are injected only once", async (t) => {
  const root = await workspace(t);
  const first = await recordFailOpenWarning({
    projectRoot: root,
    category: "TEST_FAILURE",
    message: "same failure",
  });
  const repeated = await recordFailOpenWarning({
    projectRoot: root,
    category: "TEST_FAILURE",
    message: "same failure",
  });
  assert.equal(first.shouldNotify, true);
  assert.equal(repeated.shouldNotify, false);
});


test("turn reconciliation counts real users and unique assistant messages", async (t) => {
  const root = await workspace(t);
  const transcript = await write(root, "transcript.jsonl", `${transcriptEntries(2)}\n${JSON.stringify({
    type: "user",
    uuid: "tool-result",
    message: { content: [{ type: "tool_result", content: "ignored" }] },
  })}\n${JSON.stringify({ type: "assistant", message: { id: "assistant-message-2", content: "duplicate" } })}\n`);
  const snapshot = await readTranscriptSnapshot(transcript);
  const turns = { userKeys: [], promptKeys: [], assistantKeys: [], total: 0 };
  reconcileTurnState(turns, snapshot);
  assert.equal(turns.total, 4);
  const initialGroundTruthDigest = snapshot.groundTruthDigest;
  await fs.appendFile(transcript, `${JSON.stringify({
    type: "assistant",
    message: { id: "assistant-message-3", content: "new assistant work" },
  })}\n`, "utf8");
  assert.equal((await readTranscriptSnapshot(transcript)).groundTruthDigest, initialGroundTruthDigest);
});


test("metric population is frozen and aggregation blocks only hard deviations", async (t) => {
  const root = await workspace(t);
  const task = await ensureTask({ projectRoot: root, sessionId: "session-metrics" });
  await applyGroundTruthDelta({
    projectRoot: root,
    taskId: task.taskId,
    delta: { operations: [{
      operation: "ADD",
      category: "requirements",
      text: "Required behavior.",
      authority: "USER_EXPLICIT",
      severity: "HARD",
      source: { ref: "user" },
    }] },
  });
  const groundTruth = await loadCurrentGroundTruth(root, task.taskId);
  const population = await buildMetricPopulation({ projectRoot: root, taskId: task.taskId, groundTruth });
  const object = population.metrics.M01[0];
  const report = calculateMetricReport({
    population,
    metricIds: ["M01"],
    judgements: [{ objectId: object.objectId, judgement: "DEVIATION", reason: "Missing.", evidence: [] }],
  });
  assert.equal(report.status, "DEVIATION");
  assert.deepEqual(report.blockingObjects.map((item) => item.objectId), [object.objectId]);
});


test("metric aggregation quarantines reviewer objects outside the frozen population", async (t) => {
  const root = await workspace(t);
  const task = await ensureTask({ projectRoot: root, sessionId: "session-metric-extra" });
  await applyGroundTruthDelta({
    projectRoot: root,
    taskId: task.taskId,
    delta: { operations: [{
      operation: "ADD",
      category: "acceptanceCriteria",
      text: "The current test contract must be satisfied.",
      authority: "USER_EXPLICIT",
      severity: "HARD",
      source: { ref: "user" },
    }] },
  });
  const groundTruth = await loadCurrentGroundTruth(root, task.taskId);
  const population = await buildMetricPopulation({ projectRoot: root, taskId: task.taskId, groundTruth });
  const expected = population.metrics.M03[0];
  const report = calculateMetricReport({
    population,
    metricIds: ["M03"],
    judgements: [{
      objectId: expected.objectId,
      judgement: "PASS",
      reason: "Satisfied.",
      evidence: ["current evidence"],
    }, {
      objectId: "M03:testContracts-invented",
      judgement: "PASS",
      reason: "This object was invented by the reviewer.",
      evidence: [],
    }],
  });
  assert.equal(report.status, "CHECKER_ERROR");
  assert.equal(report.metrics[0].objects[0].judgement, "PASS");
  assert.equal(report.checkerIssues.length, 1);
  assert.equal(report.checkerIssues[0].type, "UNKNOWN_OBJECT");
  assert.deepEqual(report.blockingObjects, []);
});


test("deviation ledger ignores informational resolution notes and dismisses legacy info-only families", async (t) => {
  const root = await workspace(t);
  const task = await ensureTask({ projectRoot: root, sessionId: "session-info-ledger" });
  const infoFinding = {
    deviationKey: "artifact:resolved",
    rootCauseId: "OTHER",
    severity: "info",
    reason: "A previous deviation is resolved.",
    actualEvidence: ["current evidence"],
    expectedConstraint: "The current artifact is valid.",
    violatedGroundTruthIds: [],
  };
  assert.deepEqual(await recordDeviationFindings({
    projectRoot: root,
    taskId: task.taskId,
    pipeline: "ARTIFACT",
    findings: [infoFinding],
    groundTruthVersion: 1,
  }), []);
  const afterInfo = JSON.parse(await fs.readFile(taskStatePath(root, task.taskId), "utf8"));
  assert.deepEqual(afterInfo.deviations, {});

  await withTaskState({ projectRoot: root, taskId: task.taskId }, (state) => {
    state.deviations.legacy = {
      familyId: "legacy",
      status: "OPEN",
      observations: [{ finding: infoFinding }],
    };
  });
  await recordDeviationFindings({
    projectRoot: root,
    taskId: task.taskId,
    pipeline: "STOP",
    findings: [],
    groundTruthVersion: 1,
  });
  const recovered = JSON.parse(await fs.readFile(taskStatePath(root, task.taskId), "utf8"));
  assert.equal(recovered.deviations.legacy.status, "DISMISSED");
});


test("Skill watcher refreshes Ground Truth at the due turn and emits one correction per epoch", async (t) => {
  const root = await workspace(t);
  await write(root, ".claude/skills/demo/SKILL.md", "# Demo\n\nVerify the result before completion.\n");
  const transcript = await write(root, "transcript.jsonl", transcriptEntries(1));
  const plan = v2Plan(root);
  const reviewerFactory = fakeReviewerFactory();
  const base = { cwd: root, session_id: "session-skill", transcript_path: transcript };
  const started = await handleRuntimeV2Event({
    input: {
      ...base,
      hook_event_name: "PreToolUse",
      tool_name: "Skill",
      tool_use_id: "skill-call-1",
      tool_input: { skill: "demo" },
    },
    projectRoot: root,
    plan,
    reviewerFactory,
  });
  assert.equal(started.watcher.status, "ACTIVE");
  await fs.writeFile(transcript, transcriptEntries(6), "utf8");
  const checked = await handleRuntimeV2Event({
    input: { ...base, hook_event_name: "PostToolBatch", hook_event_id: "batch-1" },
    projectRoot: root,
    plan,
    reviewerFactory,
  });
  assert.match(checked.feedback, /Skill execution correction: demo/);
  const retriggered = await handleRuntimeV2Event({
    input: {
      ...base,
      hook_event_name: "PreToolUse",
      tool_name: "Skill",
      tool_use_id: "skill-call-2",
      tool_input: { skill: "demo" },
    },
    projectRoot: root,
    plan,
    reviewerFactory,
  });
  assert.equal(retriggered.watcher.status, "SKIPPED_FEEDBACK_BUDGET");
  const state = JSON.parse(await fs.readFile(taskStatePath(root, started.taskId), "utf8"));
  assert.equal(Object.values(state.deviations).length, 1);
  assert.ok(reviewerFactory.calls.filter((call) => call.role === "ground-truth-extractor").length >= 2);
});


test("Stop checks an active Skill watcher even before its first interval", async (t) => {
  const root = await workspace(t);
  await write(root, ".claude/skills/demo/SKILL.md", "# Demo\n\nVerify the result before completion.\n");
  const transcript = await write(root, "transcript.jsonl", transcriptEntries(1));
  const plan = v2Plan(root, {
    skillCorrection: {
      enabled: true,
      selection: { mode: "include", include: ["demo"] },
      completionCheckIntervalTurns: 10,
      maxWatchTurns: 30,
      maxFeedbacksPerSkill: 1,
    },
    stopCorrection: { enabled: false },
  });
  const reviewerFactory = fakeReviewerFactory();
  const base = { cwd: root, session_id: "session-short-skill", transcript_path: transcript };
  await handleRuntimeV2Event({
    input: {
      ...base,
      hook_event_name: "PreToolUse",
      tool_name: "Skill",
      tool_use_id: "skill-call-short",
      tool_input: { skill: "demo" },
    },
    projectRoot: root,
    plan,
    reviewerFactory,
  });
  const stopped = await handleRuntimeV2Event({
    input: { ...base, hook_event_name: "Stop", hook_event_id: "stop-before-interval" },
    projectRoot: root,
    plan,
    reviewerFactory,
  });
  assert.match(stopped.feedback, /Skill execution correction: demo/);
  assert.equal(stopped.decision, "block");
  const state = JSON.parse(await fs.readFile(taskStatePath(root, stopped.taskId), "utf8"));
  assert.equal(Object.values(state.watchers)[0].status, "DEVIATION");
  const skillEvaluationDirectory = path.join(
    root,
    ".runtime-correction",
    "tasks",
    stopped.taskId,
    "skills",
    "demo",
    "evaluations",
  );
  const [skillEvaluationName] = await fs.readdir(skillEvaluationDirectory);
  const skillEvaluation = JSON.parse(await fs.readFile(
    path.join(skillEvaluationDirectory, skillEvaluationName),
    "utf8",
  ));
  assert.equal(skillEvaluation.forcePartial, true);
});


test("Stop reviewer failure blocks an unverified completion without consuming correction budget", async (t) => {
  const root = await workspace(t);
  const transcript = await write(root, "transcript.jsonl", transcriptEntries(1));
  const plan = v2Plan(root, {
    dynamicGroundTruth: { enabled: false },
    skillCorrection: { enabled: false },
  });
  const outcome = await handleRuntimeV2Event({
    input: {
      cwd: root,
      session_id: "session-stop-reviewer-timeout",
      transcript_path: transcript,
      hook_event_name: "Stop",
      hook_event_id: "stop-reviewer-timeout",
      last_assistant_message: "Everything is complete and fully verified.",
    },
    projectRoot: root,
    plan,
    reviewerFactory: async () => {
      throw new Error("Internal reviewer timed out after 5ms.");
    },
  });

  assert.equal(outcome.decision, "block");
  assert.equal(outcome.stop.status, "UNVERIFIED");
  assert.match(outcome.feedback, /Final Stop review is UNVERIFIED/u);
  assert.match(outcome.feedback, /Do not report the task as fully verified or fully complete/u);
  const state = JSON.parse(await fs.readFile(taskStatePath(root, outcome.taskId), "utf8"));
  assert.equal(state.status, "ACTIVE");
  assert.equal(state.stop.correctionAttempts, 0, "reviewer infrastructure failures use no deviation budget");
  const journal = await fs.readFile(path.join(
    root,
    ".runtime-correction",
    "tasks",
    outcome.taskId,
    "journal",
    "events.jsonl",
  ), "utf8");
  assert.match(journal, /"type":"STOP_REVIEW_FAILED"/u);
  assert.match(journal, /"reason":"STOP_REVIEW_EXCEPTION"/u);
});


test("Ground Truth refresh failure blocks Stop as unverified", async (t) => {
  const root = await workspace(t);
  const transcript = await write(root, "transcript.jsonl", transcriptEntries(1));
  const plan = v2Plan(root, {
    dynamicGroundTruth: { enabled: true, panel: { size: 0 } },
    skillCorrection: { enabled: false },
  });
  const outcome = await handleRuntimeV2Event({
    input: {
      cwd: root,
      session_id: "session-stop-ground-truth-failure",
      transcript_path: transcript,
      hook_event_name: "Stop",
      hook_event_id: "stop-ground-truth-failure",
      last_assistant_message: "Everything is complete and fully verified.",
    },
    projectRoot: root,
    plan,
    reviewerFactory: async () => {
      throw new Error("Ground Truth reviewer unavailable.");
    },
  });

  assert.equal(outcome.decision, "block");
  assert.equal(outcome.stop.status, "UNVERIFIED");
  assert.match(outcome.feedback, /Ground Truth refresh failed/u);
  const state = JSON.parse(await fs.readFile(taskStatePath(root, outcome.taskId), "utf8"));
  assert.equal(state.status, "ACTIVE");
  assert.equal(state.stop.correctionAttempts, 0);
});


test("reviewer close failure cannot override a fail-closed Stop decision", async (t) => {
  const root = await workspace(t);
  const transcript = await write(root, "transcript.jsonl", transcriptEntries(1));
  const plan = v2Plan(root, {
    dynamicGroundTruth: { enabled: false },
    skillCorrection: { enabled: false },
  });
  const outcome = await handleRuntimeV2Event({
    input: {
      cwd: root,
      session_id: "session-stop-close-failure",
      transcript_path: transcript,
      hook_event_name: "Stop",
      hook_event_id: "stop-close-failure",
      last_assistant_message: "Everything is complete and fully verified.",
    },
    projectRoot: root,
    plan,
    reviewerFactory: async ({ projectRoot }) => {
      const requestDirectory = path.join(projectRoot, ".runtime-correction", "close-failure-review");
      await fs.mkdir(requestDirectory, { recursive: true });
      return {
        result: { stopClassification: "TASK_COMPLETE", findings: null },
        requestDirectory,
        async close() {
          throw new Error("reviewer close failed");
        },
      };
    },
  });

  assert.equal(outcome.decision, "block");
  assert.equal(outcome.stop.status, "UNVERIFIED");
  const journal = await fs.readFile(path.join(
    root,
    ".runtime-correction",
    "tasks",
    outcome.taskId,
    "journal",
    "events.jsonl",
  ), "utf8");
  assert.match(journal, /"type":"STOP_REVIEWER_CLOSE_FAILED"/u);
});


test("Stop blocks three terminal deviations, then records and allows the fourth", async (t) => {
  const root = await workspace(t);
  const transcript = await write(root, "transcript.jsonl", transcriptEntries(1));
  const plan = v2Plan(root, { skillCorrection: { enabled: false } });
  const reviewerFactory = fakeReviewerFactory();
  const input = {
    cwd: root,
    session_id: "session-stop",
    transcript_path: transcript,
    hook_event_name: "Stop",
    last_assistant_message: "Implementation is complete.",
  };
  const decisions = [];
  const outcomes = [];
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const outcome = await handleRuntimeV2Event({
      input: { ...input, hook_event_id: `stop-${attempt}` },
      projectRoot: root,
      plan,
      reviewerFactory,
    });
    outcomes.push(outcome);
    decisions.push(outcome.decision);
  }
  assert.deepEqual(decisions, ["block", "block", "block", "allow"]);
  assert.equal(outcomes.at(-1).feedback, null);
  assert.equal(outcomes.at(-1).stop.correctionBudgetExhausted, true);
});


test("Stop blocks hard findings even when the reviewer classifies the attempted completion as intermediate", async (t) => {
  const root = await workspace(t);
  const transcript = await write(root, "transcript.jsonl", transcriptEntries(1));
  const plan = v2Plan(root, { skillCorrection: { enabled: false } });
  const reviewerFactory = fakeReviewerFactory({
    stopAssessment: async (request, { projectRoot }) => {
      const groundTruth = await loadCurrentGroundTruth(projectRoot, request.taskId);
      const hardClaim = groundTruth.claims.find((claim) => claim.severity === "HARD");
      return {
        summary: "The completion claim is premature and must be blocked.",
        stopClassification: "INTERMEDIATE",
        stage: "implementation",
        findings: [{
          deviationKey: "premature-completion",
          rootCauseId: "MILESTONE_EVIDENCE_GATE_BYPASSED",
          severity: "blocker",
          reason: "The agent claimed completion before satisfying the evidence gate.",
          actualEvidence: ["The final answer claims the task is complete."],
          expectedConstraint: hardClaim.text,
          violatedGroundTruthIds: [hardClaim.claimId],
          suggestedNextAction: "Continue the task and produce current evidence.",
        }],
        metricObjectJudgements: [],
      };
    },
  });
  const outcome = await handleRuntimeV2Event({
    input: {
      cwd: root,
      session_id: "session-intermediate-stop",
      transcript_path: transcript,
      hook_event_name: "Stop",
      hook_event_id: "stop-intermediate-blocker",
      last_assistant_message: "Implementation is complete.",
    },
    projectRoot: root,
    plan,
    reviewerFactory,
  });
  assert.equal(outcome.decision, "block");
  assert.equal(outcome.stop.report, null);
  assert.equal(outcome.stop.correctionAttempt, 1);
  assert.match(outcome.feedback, /premature and must be blocked/);
  const state = JSON.parse(await fs.readFile(taskStatePath(root, outcome.taskId), "utf8"));
  assert.equal(state.stop.correctionAttempts, 1);
  assert.equal(Object.values(state.deviations).length, 1);
});


test("artifact checkpoints persist metric deviations in the shared deviation ledger", async (t) => {
  const root = await workspace(t);
  const task = await ensureTask({ projectRoot: root, sessionId: "session-artifact" });
  await applyGroundTruthDelta({
    projectRoot: root,
    taskId: task.taskId,
    delta: { operations: [{
      operation: "ADD",
      category: "requirements",
      text: "Artifact requirement.",
      authority: "USER_EXPLICIT",
      severity: "HARD",
      source: { ref: "user" },
    }] },
  });
  const groundTruth = await loadCurrentGroundTruth(root, task.taskId);
  const population = await buildMetricPopulation({ projectRoot: root, taskId: task.taskId, groundTruth });
  const object = population.metrics.M01[0];
  const reviewContext = {
    artifact: { nodeId: "implementation", snapshotHash: "snapshot" },
    groundTruthVersion: groundTruth.version,
    population,
    metricIds: ["M01"],
  };
  const semanticReview = {
    metricObjectJudgements: [{
      objectId: object.objectId,
      judgement: "DEVIATION",
      reason: "Artifact omitted the requirement.",
      evidence: [],
    }],
  };
  // Active arm: feedback is produced and the observation is stamped delivered.
  const finalized = await finalizeArtifactRuntimeV2({
    projectRoot: root,
    taskId: task.taskId,
    artifactReviewContext: reviewContext,
    semanticReview,
    delivered: true,
  });
  assert.match(finalized.feedback, /Stage checkpoint metric deviations/);
  const state = JSON.parse(await fs.readFile(taskStatePath(root, task.taskId), "utf8"));
  const family = Object.values(state.deviations)[0];
  assert.equal(family.pipelines[0], "ARTIFACT");
  assert.equal(family.observations[0].delivered, true);
  assert.equal(typeof family.observations[0].deliveredAt, "string");
  // Shadow arm (delivered omitted -> fail-safe default false): everything is
  // still recorded, but no feedback may reach the developer and the
  // observation is stamped undelivered — the stamp closure attribution keys on.
  const shadowFinalized = await finalizeArtifactRuntimeV2({
    projectRoot: root,
    taskId: task.taskId,
    artifactReviewContext: reviewContext,
    semanticReview,
  });
  assert.equal(shadowFinalized.feedback, null);
  const shadowState = JSON.parse(await fs.readFile(taskStatePath(root, task.taskId), "utf8"));
  const shadowObservations = Object.values(shadowState.deviations)[0].observations;
  const lastObservation = shadowObservations[shadowObservations.length - 1];
  assert.equal(lastObservation.delivered, false);
  assert.equal(lastObservation.deliveredAt, null);
});


test("v2 artifact review uses its configured role reviewer even when Ground Truth is unchanged", async (t) => {
  const root = await workspace(t);
  await write(root, "result.md", "# Result\n");
  let roleCall = null;
  const outcome = await runSemanticReview({
    input: { cwd: root, session_id: "session-artifact-role" },
    prepared: {
      projectRoot: root,
      result: {
        status: "passed",
        diagnostics: [],
        metadata: {
          roundId: "round-artifact-role",
          stage: "result",
          artifactType: "result",
          triggerFile: "result.md",
          artifactFiles: ["result.md"],
          bundleComplete: true,
        },
      },
      reviewContext: {
        semanticReviewTimeoutMs: 1000,
        nodeReviewEnabled: false,
        reviewer: null,
        specification: null,
        workflow: null,
      },
    },
    runtimeV2Context: {
      taskId: "task-artifact-role",
      reviewerExecution: { model: "configured-model", effort: "medium", timeoutMs: 1234, maxBudgetUsd: null },
      groundTruthPath: "ground-truth/current.json",
      population: null,
      metricIds: null,
    },
    runtimeV2ReviewerFactory: async (options) => {
      roleCall = options;
      return {
        sessionId: "artifact-fork",
        result: { summary: "No deviation.", findings: [], edits: [], metricObjectJudgements: [] },
        async close() {},
      };
    },
  });
  assert.equal(outcome.status, "completed");
  assert.equal(roleCall.role, "artifact-reviewer");
  assert.equal(roleCall.reviewer.model, "configured-model");
});
