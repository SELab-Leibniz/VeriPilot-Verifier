import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { compileRuntimeV2Config } from "../lib/runtime-v2/config.mjs";
import { loadCurrentGroundTruth } from "../lib/runtime-v2/ground-truth-ledger.mjs";
import { handleRuntimeV2Event } from "../lib/runtime-v2/orchestrator.mjs";
import { handleRuntimeV2SessionEnd } from "../lib/runtime-v2/session-end.mjs";
import {
  GROUND_TRUTH_REVIEW_SCHEMA,
  STOP_REVIEW_SCHEMA,
} from "../lib/runtime-v2/reviewer.mjs";
import {
  withTaskResourceLock,
  withTaskState,
} from "../lib/runtime-v2/task-store.mjs";


const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");


async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lazy-correction-barrier-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}


function plan(projectRoot, { stopEnabled = true } = {}) {
  return {
    runtimeV2: compileRuntimeV2Config({
      version: 2,
      dynamicGroundTruth: {
        enabled: true,
        materialRoots: [],
        panel: { size: 2, adjudicator: true },
      },
      skillCorrection: { enabled: false, selection: { mode: "include", include: [] } },
      artifactCorrection: { groundTruthReviewEnabled: false, stageMetricsEnabled: false },
      implementationCorrection: { enabled: false },
      stopCorrection: { enabled: stopEnabled, maxCorrectionsPerEpoch: 3 },
    }, { policyRoot: path.join(projectRoot, ".runtime-corrector") }),
  };
}


function runHookScript(script, { cwd, input }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(pluginRoot, "scripts", script)], {
      cwd,
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}


const REQUIREMENT = Object.freeze({
  operation: "ADD",
  category: "requirements",
  text: "The requested project change must be implemented and verified.",
  authority: "USER_EXPLICIT",
  severity: "HARD",
  source: { ref: "transcript:user-1" },
});


function reviewerFactory({ onboardingDelayMs = 0, failOnboarding = false } = {}) {
  const calls = [];
  const factory = async ({ projectRoot, role, request, schema }) => {
    calls.push({ role, request, schema });
    if (role.startsWith("onboarding-") && onboardingDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, onboardingDelayMs));
    }
    if (role.startsWith("onboarding-") && failOnboarding) {
      throw new Error("cancelled onboarding fixture");
    }
    let result;
    if (role === "onboarding-extractor") {
      result = {
        summary: "Onboarding extraction.",
        taskClassification: "CONTINUATION",
        operations: [REQUIREMENT],
      };
    } else if (role === "onboarding-adjudicator") {
      result = {
        summary: "Onboarding adjudication.",
        taskClassification: "CONTINUATION",
        operations: request.majorityOperations,
      };
    } else if (schema === GROUND_TRUTH_REVIEW_SCHEMA) {
      result = {
        summary: "No new Ground Truth.",
        taskClassification: "CONTINUATION",
        operations: [],
        skillGroundTruth: null,
      };
    } else if (schema === STOP_REVIEW_SCHEMA) {
      const objects = Object.values(request.population.metrics).flat();
      result = {
        summary: "Task complete.",
        stopClassification: "TASK_COMPLETE",
        stage: "implementation",
        findings: [],
        metricObjectJudgements: objects.map((object) => ({
          objectId: object.objectId,
          judgement: "PASS",
          reason: "Verified by the test fixture.",
          evidence: ["test fixture"],
        })),
      };
    } else {
      throw new Error(`Unexpected reviewer role: ${role}`);
    }
    const requestDirectory = path.join(
      projectRoot,
      ".runtime-correction",
      "fake-review",
      String(calls.length),
    );
    await fs.mkdir(requestDirectory, { recursive: true });
    return {
      result,
      requestDirectory,
      async followUp({ nextSchema }) {
        calls.push({ role: "reviewer-follow-up", request: null, schema: nextSchema });
        if (nextSchema !== STOP_REVIEW_SCHEMA) throw new Error("Unexpected reviewer follow-up.");
        const assessment = JSON.parse(await fs.readFile(
          path.join(requestDirectory, "assessment-request.json"),
          "utf8",
        ));
        const objects = Object.values(assessment.population.metrics).flat();
        return {
          summary: "Task complete.",
          stopClassification: "TASK_COMPLETE",
          stage: "implementation",
          findings: [],
          metricObjectJudgements: objects.map((object) => ({
            objectId: object.objectId,
            judgement: "PASS",
            reason: "Verified by the test fixture.",
            evidence: ["test fixture"],
          })),
        };
      },
      async close() {},
    };
  };
  factory.calls = calls;
  return factory;
}


async function writeTranscript(root, sessionId = "session-lazy") {
  const transcript = path.join(root, "transcript.jsonl");
  await fs.writeFile(transcript, `${JSON.stringify({
    type: "user",
    uuid: "user-1",
    sessionId,
    message: { id: "user-message-1", content: "Build the requested feature." },
  })}\n`, "utf8");
  return transcript;
}


async function taskDirectories(root) {
  try {
    return await fs.readdir(path.join(root, ".runtime-correction", "tasks"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}


test("SessionStart and taskless SessionEnd stay lifecycle-only", async (t) => {
  const root = await workspace(t);
  const factory = reviewerFactory();
  for (const hookEventName of ["SessionStart", "SessionEnd"]) {
    const options = {
      input: {
        cwd: root,
        session_id: `lifecycle-${hookEventName}`,
        hook_event_name: hookEventName,
        hook_event_id: `event-${hookEventName}`,
        transcript_path: path.join(root, "missing-transcript.jsonl"),
      },
      projectRoot: root,
      plan: plan(root),
      reviewerFactory: factory,
    };
    const outcome = hookEventName === "SessionEnd"
      ? await handleRuntimeV2SessionEnd(options)
      : await handleRuntimeV2Event(options);
    assert.equal(outcome.handled, true);
  }
  assert.deepEqual(await taskDirectories(root), []);
  assert.equal(factory.calls.length, 0);
});


test("a greeting turn remains taskless and never starts a reviewer", async (t) => {
  const root = await workspace(t);
  const transcript = await writeTranscript(root, "session-greeting");
  const factory = reviewerFactory();
  await handleRuntimeV2Event({
    input: {
      cwd: root,
      session_id: "session-greeting",
      hook_event_name: "UserPromptSubmit",
      hook_event_id: "prompt-greeting",
      prompt: "hi",
      transcript_path: transcript,
    },
    projectRoot: root,
    plan: plan(root),
    reviewerFactory: factory,
  });
  const stop = await handleRuntimeV2Event({
    input: {
      cwd: root,
      session_id: "session-greeting",
      hook_event_name: "Stop",
      hook_event_id: "stop-greeting",
      last_assistant_message: "Hi! I'm ready to help with your project. What would you like to do?",
      transcript_path: transcript,
    },
    projectRoot: root,
    plan: plan(root),
    reviewerFactory: factory,
  });
  assert.equal(stop.decision, undefined);
  assert.deepEqual(await taskDirectories(root), []);
  assert.equal(factory.calls.length, 0);
});


test("a Chinese greeting offer is not mistaken for a completion claim", async (t) => {
  const root = await workspace(t);
  const transcript = await writeTranscript(root, "session-chinese-greeting");
  const factory = reviewerFactory();
  const stop = await handleRuntimeV2Event({
    input: {
      cwd: root,
      session_id: "session-chinese-greeting",
      hook_event_name: "Stop",
      hook_event_id: "stop-chinese-greeting",
      last_assistant_message: "你好！我可以帮你完成什么？",
      transcript_path: transcript,
    },
    projectRoot: root,
    plan: plan(root),
    reviewerFactory: factory,
  });
  assert.equal(stop.decision, undefined);
  assert.deepEqual(await taskDirectories(root), []);
  assert.equal(factory.calls.length, 0);
});


test("the first project-changing tool completes onboarding before it is released", async (t) => {
  const root = await workspace(t);
  const transcript = await writeTranscript(root, "session-first-write");
  const factory = reviewerFactory();
  const outcome = await handleRuntimeV2Event({
    input: {
      cwd: root,
      session_id: "session-first-write",
      hook_event_name: "PreToolUse",
      hook_event_id: "pre-write",
      tool_name: "Write",
      tool_input: { file_path: path.join(root, "Index.ets") },
      transcript_path: transcript,
    },
    projectRoot: root,
    plan: plan(root),
    reviewerFactory: factory,
  });
  const [taskId] = await taskDirectories(root);
  const state = JSON.parse(await fs.readFile(
    path.join(root, ".runtime-correction", "tasks", taskId, "task.json"),
    "utf8",
  ));
  const groundTruth = await loadCurrentGroundTruth(root, taskId);
  assert.equal(outcome.taskId, taskId);
  assert.equal(state.onboarding.status, "COMPLETED");
  assert.equal(state.correctionBarrier.turnActivated, true);
  assert.equal(groundTruth.frozenAtVersion, groundTruth.version);
  assert.deepEqual(factory.calls.map((call) => call.role), [
    "onboarding-extractor",
    "onboarding-extractor",
    "onboarding-adjudicator",
  ]);

  await handleRuntimeV2Event({
    input: {
      cwd: root,
      session_id: "session-first-write",
      hook_event_name: "SessionStart",
      hook_event_id: "resume-session",
      transcript_path: transcript,
    },
    projectRoot: root,
    plan: plan(root),
    reviewerFactory: factory,
  });
  await handleRuntimeV2Event({
    input: {
      cwd: root,
      session_id: "session-first-write",
      hook_event_name: "PreToolUse",
      hook_event_id: "resume-edit",
      tool_name: "Edit",
      transcript_path: transcript,
    },
    projectRoot: root,
    plan: plan(root),
    reviewerFactory: factory,
  });
  assert.equal(factory.calls.length, 3, "resuming an onboarded task must reuse the frozen baseline");
});


test("external policy writes keep one cwd runtime task while artifact output stays policy-owned", async (t) => {
  const sessionRoot = await workspace(t);
  const artifactRoot = await workspace(t);
  await fs.mkdir(path.join(sessionRoot, ".runtime-corrector"), { recursive: true });
  await fs.writeFile(path.join(sessionRoot, ".runtime-corrector", "config.yaml"), `version: 2
artifacts: []
dynamicGroundTruth:
  enabled: true
  materialRoots: []
  panel:
    size: 2
    adjudicator: true
skillCorrection:
  enabled: false
stopCorrection:
  enabled: false
`, "utf8");
  await fs.mkdir(path.join(artifactRoot, ".runtime-corrector"), { recursive: true });
  await fs.writeFile(path.join(artifactRoot, ".runtime-corrector", "config.yaml"), `version: 2
artifacts:
  - name: external-owned
    stage: external
    type: external
    format: markdown
    outputKey: external-owned
    patterns:
      - artifact.md
    review:
      enabled: false
dynamicGroundTruth:
  enabled: true
  panel:
    size: 0
stopCorrection:
  enabled: false
output:
  persist: true
  mode: centralized
  directory: .runtime-correction
`, "utf8");
  const sessionId = "canonical-runtime-root-session";
  const transcript = await writeTranscript(sessionRoot, sessionId);
  const artifactPath = path.join(artifactRoot, "artifact.md");
  await fs.writeFile(artifactPath, "# External artifact\n", "utf8");
  const factory = reviewerFactory();

  const preTool = await handleRuntimeV2Event({
    input: {
      cwd: sessionRoot,
      session_id: sessionId,
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: artifactPath },
      tool_use_id: "toolu-canonical-pre",
      transcript_path: transcript,
    },
    projectRoot: sessionRoot,
    plan: plan(sessionRoot, { stopEnabled: false }),
    reviewerFactory: factory,
  });
  const [taskId] = await taskDirectories(sessionRoot);
  assert.equal(preTool.taskId, taskId);

  const postTool = await runHookScript("post-tool-use.mjs", {
    cwd: sessionRoot,
    input: {
      cwd: sessionRoot,
      session_id: sessionId,
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: artifactPath },
      tool_response: { filePath: artifactPath, success: true },
      tool_use_id: "toolu-canonical-post",
      transcript_path: transcript,
    },
  });
  const stop = await runHookScript("runtime-event.mjs", {
    cwd: sessionRoot,
    input: {
      cwd: sessionRoot,
      session_id: sessionId,
      hook_event_name: "Stop",
      stop_hook_active: false,
      last_assistant_message: "Progress update only; more work remains.",
      transcript_path: transcript,
    },
  });

  assert.equal(postTool.code, 0, postTool.stderr);
  assert.equal(stop.code, 0, stop.stderr);
  assert.deepEqual(await taskDirectories(sessionRoot), [taskId]);
  const state = JSON.parse(await fs.readFile(
    path.join(sessionRoot, ".runtime-correction", "tasks", taskId, "task.json"),
    "utf8",
  ));
  assert.equal(state.onboarding.status, "COMPLETED");
  const journal = (await fs.readFile(
    path.join(sessionRoot, ".runtime-correction", "tasks", taskId, "journal", "events.jsonl"),
    "utf8",
  )).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(
    journal.filter((event) => event.type === "HOOK_EVENT").map((event) => event.hookEventName),
    ["PreToolUse", "PostToolUse", "Stop"],
  );
  await assert.rejects(fs.access(path.join(artifactRoot, ".runtime-correction", "tasks")));
  const artifactResult = JSON.parse(await fs.readFile(
    path.join(artifactRoot, ".runtime-correction", "latest", "external", "external-owned", "result.json"),
    "utf8",
  ));
  assert.equal(artifactResult.metadata.projectRootSource, "artifact-policy-discovery");
  await assert.rejects(fs.access(path.join(sessionRoot, ".runtime-correction", "latest")));
});


test("parallel first tools share one task and one onboarding flight", async (t) => {
  const root = await workspace(t);
  const transcript = await writeTranscript(root, "session-parallel");
  const factory = reviewerFactory({ onboardingDelayMs: 30 });
  const event = (toolName, id) => handleRuntimeV2Event({
    input: {
      cwd: root,
      session_id: "session-parallel",
      hook_event_name: "PreToolUse",
      hook_event_id: id,
      tool_name: toolName,
      tool_input: { file_path: path.join(root, `${toolName}.ets`) },
      transcript_path: transcript,
    },
    projectRoot: root,
    plan: plan(root),
    reviewerFactory: factory,
  });
  const outcomes = await Promise.all([
    event("Write", "parallel-write"),
    event("Edit", "parallel-edit"),
  ]);
  const tasks = await taskDirectories(root);
  assert.equal(tasks.length, 1);
  assert.equal(new Set(outcomes.map((outcome) => outcome.taskId)).size, 1);
  assert.equal(factory.calls.filter((call) => call.role === "onboarding-extractor").length, 2);
  assert.equal(factory.calls.filter((call) => call.role === "onboarding-adjudicator").length, 1);
});


test("a live-age lock owned by a dead hook process is reclaimed", async (t) => {
  const root = await workspace(t);
  const taskId = "task-dead-owner";
  const lockDirectory = path.join(root, ".runtime-correction", "locks");
  await fs.mkdir(lockDirectory, { recursive: true });
  await fs.writeFile(
    path.join(lockDirectory, `${taskId}-onboarding.lock`),
    JSON.stringify({ pid: 2147483647, createdAt: new Date().toISOString() }),
    "utf8",
  );
  let entered = false;
  await withTaskResourceLock({
    projectRoot: root,
    taskId,
    resource: "onboarding",
    timeoutMs: 250,
    staleMs: 60_000,
    reclaimDeadOwner: true,
  }, async () => {
    entered = true;
  });
  assert.equal(entered, true);
});


test("an old onboarding lock is not reclaimed while its owner is alive", async (t) => {
  const root = await workspace(t);
  const taskId = "task-live-owner";
  const lockDirectory = path.join(root, ".runtime-correction", "locks");
  const lockPath = path.join(lockDirectory, `${taskId}-onboarding.lock`);
  await fs.mkdir(lockDirectory, { recursive: true });
  await fs.writeFile(
    lockPath,
    JSON.stringify({ pid: process.pid, createdAt: new Date(0).toISOString() }),
    "utf8",
  );
  await fs.utimes(lockPath, new Date(0), new Date(0));
  await assert.rejects(
    withTaskResourceLock({
      projectRoot: root,
      taskId,
      resource: "onboarding",
      timeoutMs: 80,
      staleMs: 1,
      reclaimDeadOwner: true,
    }, async () => {}),
    /Timed out waiting for Runtime Corrector state lock/,
  );
  await fs.access(lockPath);
});


test("SessionEnd never retries an interrupted onboarding", async (t) => {
  const root = await workspace(t);
  const transcript = await writeTranscript(root, "session-cancelled");
  const factory = reviewerFactory({ failOnboarding: true });
  await handleRuntimeV2Event({
    input: {
      cwd: root,
      session_id: "session-cancelled",
      hook_event_name: "PreToolUse",
      hook_event_id: "cancelled-write",
      tool_name: "Write",
      transcript_path: transcript,
    },
    projectRoot: root,
    plan: plan(root),
    reviewerFactory: factory,
  });
  const callsBeforeEnd = factory.calls.length;
  await handleRuntimeV2SessionEnd({
    input: {
      cwd: root,
      session_id: "session-cancelled",
      hook_event_name: "SessionEnd",
      hook_event_id: "cancelled-end",
      transcript_path: transcript,
    },
    projectRoot: root,
  });
  assert.equal(factory.calls.length, callsBeforeEnd);

  const recoveredFactory = reviewerFactory();
  await handleRuntimeV2Event({
    input: {
      cwd: root,
      session_id: "session-cancelled",
      hook_event_name: "PreToolUse",
      hook_event_id: "recovered-edit",
      tool_name: "Edit",
      transcript_path: transcript,
    },
    projectRoot: root,
    plan: plan(root),
    reviewerFactory: recoveredFactory,
  });
  const [taskId] = await taskDirectories(root);
  const state = JSON.parse(await fs.readFile(
    path.join(root, ".runtime-correction", "tasks", taskId, "task.json"),
    "utf8",
  ));
  assert.equal(state.onboarding.status, "COMPLETED");
  assert.equal(recoveredFactory.calls.filter((call) => call.role === "onboarding-extractor").length, 2);
});


test("an explicit completion claim crosses the barrier even without a tool call", async (t) => {
  const root = await workspace(t);
  const transcript = await writeTranscript(root, "session-completion-claim");
  const factory = reviewerFactory();
  const outcome = await handleRuntimeV2Event({
    input: {
      cwd: root,
      session_id: "session-completion-claim",
      hook_event_name: "Stop",
      hook_event_id: "stop-completion-claim",
      last_assistant_message: "鸿蒙应用已经完成并验证。",
      transcript_path: transcript,
    },
    projectRoot: root,
    plan: plan(root),
    reviewerFactory: factory,
  });
  const [taskId] = await taskDirectories(root);
  const state = JSON.parse(await fs.readFile(
    path.join(root, ".runtime-correction", "tasks", taskId, "task.json"),
    "utf8",
  ));
  assert.equal(outcome.decision, "allow");
  assert.equal(state.correctionBarrier.turnActivated, true);
  assert.ok(factory.calls.some((call) => call.schema === STOP_REVIEW_SCHEMA));
});


test("completed-subtask and direct-negated prose do not declare task completion", async (t) => {
  const messages = [
    "The implementation fixed the parser bug; tests are pending.",
    "并非所有要求均已满足。",
  ];

  for (const [index, lastAssistantMessage] of messages.entries()) {
    await t.test(lastAssistantMessage, async (t) => {
      const root = await workspace(t);
      const sessionId = `session-residual-negative-completion-${index}`;
      const transcript = await writeTranscript(root, sessionId);
      const factory = reviewerFactory();
      const outcome = await handleRuntimeV2Event({
        input: {
          cwd: root,
          session_id: sessionId,
          hook_event_name: "Stop",
          hook_event_id: `stop-residual-negative-completion-${index}`,
          last_assistant_message: lastAssistantMessage,
          transcript_path: transcript,
        },
        projectRoot: root,
        plan: plan(root),
        reviewerFactory: factory,
      });

      assert.equal(outcome.reason, "STOP_BARRIER_NOT_REQUIRED");
      assert.deepEqual(await taskDirectories(root), []);
      assert.equal(factory.calls.length, 0);
    });
  }
});


test("negated or incomplete completion language does not cross the taskless Stop barrier", async (t) => {
  const messages = [
    "The feature is not implemented yet; work remains.",
    "I haven't completed it.",
    "The requirements are not satisfied.",
    "The parser is implemented in lib/parser.mjs, but integration work remains.",
    "尚未完成，仍需修改。",
    "还没有实现。",
  ];

  for (const [index, lastAssistantMessage] of messages.entries()) {
    const root = await workspace(t);
    const sessionId = `session-negative-completion-${index}`;
    const transcript = await writeTranscript(root, sessionId);
    const factory = reviewerFactory();
    const outcome = await handleRuntimeV2Event({
      input: {
        cwd: root,
        session_id: sessionId,
        hook_event_name: "Stop",
        hook_event_id: `stop-negative-completion-${index}`,
        last_assistant_message: lastAssistantMessage,
        transcript_path: transcript,
      },
      projectRoot: root,
      plan: plan(root),
      reviewerFactory: factory,
    });

    assert.equal(outcome.reason, "STOP_BARRIER_NOT_REQUIRED", lastAssistantMessage);
    assert.deepEqual(await taskDirectories(root), [], lastAssistantMessage);
    assert.equal(factory.calls.length, 0, lastAssistantMessage);
  }
});


test("ordinary affirmative completion and no-change language crosses the taskless Stop barrier", async (t) => {
  const messages = [
    "All requirements are satisfied.",
    "No changes are required.",
    "所有要求均已满足。",
    "无需再做改动。",
  ];

  for (const [index, lastAssistantMessage] of messages.entries()) {
    const root = await workspace(t);
    const sessionId = `session-positive-completion-${index}`;
    const transcript = await writeTranscript(root, sessionId);
    const factory = reviewerFactory();
    const outcome = await handleRuntimeV2Event({
      input: {
        cwd: root,
        session_id: sessionId,
        hook_event_name: "Stop",
        hook_event_id: `stop-positive-completion-${index}`,
        last_assistant_message: lastAssistantMessage,
        transcript_path: transcript,
      },
      projectRoot: root,
      plan: plan(root),
      reviewerFactory: factory,
    });

    assert.equal(outcome.decision, "allow", lastAssistantMessage);
    assert.equal((await taskDirectories(root)).length, 1, lastAssistantMessage);
    assert.ok(factory.calls.some((call) => call.schema === STOP_REVIEW_SCHEMA), lastAssistantMessage);
  }
});


test("PreCompact persists the cursor without running unrelated state maintenance", async (t) => {
  const root = await workspace(t);
  const transcript = await writeTranscript(root, "session-precompact");
  const factory = reviewerFactory();
  const first = await handleRuntimeV2Event({
    input: {
      cwd: root,
      session_id: "session-precompact",
      hook_event_name: "PreToolUse",
      hook_event_id: "precompact-write",
      tool_name: "Write",
      transcript_path: transcript,
    },
    projectRoot: root,
    plan: plan(root),
    reviewerFactory: factory,
  });
  await withTaskState({ projectRoot: root, taskId: first.taskId }, (state) => {
    state.deviations.info = {
      familyId: "info",
      status: "OPEN",
      observations: [{ finding: { severity: "info" } }],
    };
  });
  const callsBeforeCompact = factory.calls.length;
  await handleRuntimeV2Event({
    input: {
      cwd: root,
      session_id: "session-precompact",
      hook_event_name: "PreCompact",
      hook_event_id: "precompact-event",
      transcript_path: transcript,
    },
    projectRoot: root,
    plan: plan(root),
    reviewerFactory: factory,
  });
  let state = null;
  await withTaskState({ projectRoot: root, taskId: first.taskId }, (current) => {
    state = structuredClone(current);
  });
  assert.equal(state.deviations.info.status, "OPEN");
  assert.equal(state.turns.userKeys.length, 1);
  assert.equal(factory.calls.length, callsBeforeCompact);
});
