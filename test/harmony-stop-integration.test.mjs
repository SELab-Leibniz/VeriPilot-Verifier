import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { compileRuntimeV2Config } from "../lib/runtime-v2/config.mjs";
import { applyGroundTruthDelta } from "../lib/runtime-v2/ground-truth-ledger.mjs";
import { handleRuntimeV2Event } from "../lib/runtime-v2/orchestrator.mjs";


async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-corrector-harmony-stop-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}


async function write(root, relative, contents = "fixture") {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents, "utf8");
  return file;
}


test("BLOCKED_EXTERNAL Stop still receives HarmonyOS environment-awareness correction before the early return", async (t) => {
  const root = await workspace(t);
  await write(root, "oh-package.json5", "{ name: 'flower-shop' }");
  const deveco = path.join(root, "DevEco Studio");
  await write(deveco, "tools/hvigor/bin/hvigorw.bat");
  await write(deveco, "sdk/default/openharmony/toolchains/hdc.exe");
  await write(deveco, "tools/emulator/Emulator.exe");
  const message = "模拟器不可用，因此没有进行所需的鸿蒙 UI 测试。";
  const transcript = await write(root, "transcript.jsonl", [
    JSON.stringify({ type: "user", uuid: "user-1", message: { id: "user-1", content: "实现收藏按钮交互" } }),
    JSON.stringify({ type: "assistant", uuid: "assistant-1", message: { id: "assistant-1", content: message } }),
  ].join("\n"));
  const plan = {
    runtimeV2: compileRuntimeV2Config({
      version: 2,
      dynamicGroundTruth: { enabled: false },
      skillCorrection: { enabled: false },
      stopCorrection: { enabled: true, maxCorrectionsPerEpoch: 3 },
      implementationCorrection: {
        enabled: true,
        platform: "harmonyos",
        harmonyEnvironmentAwareness: { enabled: true },
      },
    }),
  };
  const commandCalls = [];
  let targetProbeCount = 0;
  const harmonyEnvironmentExecFn = async (_command, args) => {
    commandCalls.push(args.join(" "));
    if (args.join(" ") === "list targets") {
      targetProbeCount += 1;
      return { ok: true, exitCode: 0, stdout: targetProbeCount === 1 ? "[Empty]" : "device-42", stderr: "", error: null };
    }
    return { ok: true, exitCode: 0, stdout: "6.24.2", stderr: "", error: null };
  };
  const base = {
    cwd: root,
    session_id: "harmony-stop-session",
    transcript_path: transcript,
  };
  const started = await handleRuntimeV2Event({
    input: { ...base, hook_event_name: "SessionStart", hook_event_id: "harmony-session-start" },
    projectRoot: root,
    plan,
    env: { DEVECO_STUDIO: deveco, Path: "" },
    harmonyEnvironmentHostPlatform: "win32",
    harmonyEnvironmentExecFn,
  });
  await applyGroundTruthDelta({
    projectRoot: root,
    taskId: started.taskId,
    delta: {
      operations: [{
        operation: "ADD",
        category: "acceptanceCriteria",
        text: "点击收藏按钮后页面必须显示已收藏状态",
        authority: "USER_EXPLICIT",
        severity: "HARD",
        verification: {
          platform: "harmonyos",
          runtimeRequired: true,
          modalities: ["device", "ui"],
          evidenceKinds: ["build", "install", "launch", "ui-action", "ui-assertion", "screenshot"],
        },
        source: { ref: "transcript:user-1" },
      }],
    },
  });
  const outcome = await handleRuntimeV2Event({
    input: {
      ...base,
      hook_event_name: "Stop",
      hook_event_id: "harmony-stop",
      last_assistant_message: message,
    },
    projectRoot: root,
    plan,
    env: { DEVECO_STUDIO: deveco, Path: "" },
    harmonyEnvironmentHostPlatform: "win32",
    harmonyEnvironmentExecFn,
    reviewerFactory: async () => ({
      result: {
        summary: "The Agent reports an external emulator block.",
        stopClassification: "BLOCKED_EXTERNAL",
        stage: "verification",
        findings: [],
        metricObjectJudgements: [],
      },
      async close() {},
    }),
  });

  assert.equal(commandCalls.length, 4, "the Stop reused static facts and refreshed only the volatile target");
  assert.equal(commandCalls.at(-1), "list targets");
  assert.equal(outcome.decision, "block");
  assert.equal(outcome.stop.review.harmonyEnvironmentAssessment.status, "MISCONCEPTION");
  assert.equal(outcome.stop.review.harmonyEnvironmentAssessment.environment.capabilities.target.state, "CONNECTED");
  assert.match(outcome.feedback, /HarmonyOS environment awareness correction/u);
  assert.match(outcome.feedback, /M13:/u);
  assert.match(outcome.feedback, /developer\.huawei\.com/u);
});


test("completion Stop cannot turn a hard HarmonyOS UI claim into PASS without a current UI evidence chain", async (t) => {
  const root = await workspace(t);
  await write(root, "oh-package.json5", "{ name: 'flower-shop' }");
  const deveco = path.join(root, "DevEco Studio");
  await write(deveco, "tools/hvigor/bin/hvigorw.bat");
  await write(deveco, "sdk/default/openharmony/toolchains/hdc.exe");
  await write(deveco, "tools/emulator/Emulator.exe");
  const transcript = await write(root, "transcript.jsonl", [
    JSON.stringify({ type: "user", uuid: "user-1", message: { id: "user-1", content: "实现收藏按钮交互" } }),
    JSON.stringify({ type: "assistant", uuid: "assistant-1", message: { id: "assistant-1", content: "功能已完成。" } }),
  ].join("\n"));
  const plan = {
    runtimeV2: compileRuntimeV2Config({
      version: 2,
      dynamicGroundTruth: { enabled: false },
      skillCorrection: { enabled: false },
      stopCorrection: { enabled: true, maxCorrectionsPerEpoch: 3 },
      implementationCorrection: {
        enabled: true,
        platform: "harmonyos",
        device: { mode: "off" },
        harmonyEnvironmentAwareness: { enabled: true },
      },
    }),
  };
  const base = { cwd: root, session_id: "harmony-complete-session", transcript_path: transcript };
  const environmentOptions = {
    env: { DEVECO_STUDIO: deveco, Path: "" },
    harmonyEnvironmentHostPlatform: "win32",
    harmonyEnvironmentExecFn: async (_command, args) => ({
      ok: true,
      exitCode: 0,
      stdout: args.join(" ") === "list targets" ? "[Empty]" : "6.24.2",
      stderr: "",
      error: null,
    }),
  };
  const started = await handleRuntimeV2Event({
    input: { ...base, hook_event_name: "SessionStart", hook_event_id: "complete-session-start" },
    projectRoot: root,
    plan,
    ...environmentOptions,
  });
  await applyGroundTruthDelta({
    projectRoot: root,
    taskId: started.taskId,
    delta: {
      operations: [{
        operation: "ADD",
        category: "acceptanceCriteria",
        text: "点击收藏按钮后页面必须显示已收藏状态",
        authority: "USER_EXPLICIT",
        severity: "HARD",
        verification: {
          platform: "harmonyos",
          runtimeRequired: true,
          modalities: ["device", "ui"],
          evidenceKinds: ["build", "install", "launch", "ui-action", "ui-assertion"],
        },
        source: { ref: "transcript:user-1" },
      }],
    },
  });
  const reviewerFactory = async ({ role, request }) => ({
    result: role === "stop-reviewer" ? {
      summary: "The task is reported complete.",
      stopClassification: "TASK_COMPLETE",
      stage: "verification",
      findings: [],
      metricObjectJudgements: Object.values(request.population.metrics).flat().map((object) => ({
        objectId: object.objectId,
        judgement: "PASS",
        reason: "Reported complete.",
        evidence: ["Agent report"],
      })),
    } : {
      summary: "No source-owned objects are in scope.",
      findings: [],
      metricObjectJudgements: [],
    },
    async close() {},
  });
  const outcome = await handleRuntimeV2Event({
    input: {
      ...base,
      hook_event_name: "Stop",
      hook_event_id: "harmony-complete-stop",
      last_assistant_message: "功能已完成。",
    },
    projectRoot: root,
    plan,
    reviewerFactory,
    ...environmentOptions,
  });

  assert.equal(outcome.decision, "block");
  const object = outcome.stop.report.metrics
    .flatMap((metric) => metric.objects)
    .find((item) => item.objectId.startsWith("M13:"));
  assert.equal(object.judgement, "UNVERIFIED");
  assert.match(object.reason, /HarmonyOS runtime\/UI verification is missing/u);
  assert.doesNotMatch(outcome.feedback, /environment awareness correction/u, "missing evidence alone is not a cognition accusation");
});
