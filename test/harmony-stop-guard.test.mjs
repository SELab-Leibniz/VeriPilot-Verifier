import assert from "node:assert/strict";
import test from "node:test";

import {
  assessHarmonyStopGuard,
  detectHarmonyEnvironmentMisconception,
  extractHarmonyExecutionEvidence,
  harmonyUiObligations,
} from "../lib/runtime-v2/harmony-stop-guard.mjs";


const ENVIRONMENT = {
  status: "AVAILABLE",
  checkedAt: "2026-08-21T00:00:00.000Z",
  capabilities: {
    installation: { state: "PRESENT" },
    build: { state: "READY" },
    deviceControl: { state: "READY" },
    emulator: { state: "INSTALLED_NOT_STARTED" },
    target: { state: "ABSENT_AT_PROBE", count: 0 },
    uiTestReadiness: "STARTABLE",
  },
  officialDocumentation: [{
    id: "emulator",
    topics: ["emulator", "ui"],
    url: "https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/ide-commandline-emulator",
  }],
};

const POPULATION = {
  metrics: {
    M12: [],
    M13: [{
      objectId: "M13:favorite-ui",
      metricId: "M13",
      sourceId: "favorite-ui",
      description: "点击收藏按钮后页面显示已收藏状态",
      hard: true,
      evidenceRequired: true,
      verification: {
        platform: "harmonyos",
        runtimeRequired: true,
        modalities: ["device", "ui"],
        evidenceKinds: ["build", "install", "launch", "ui-action", "ui-assertion", "screenshot"],
      },
    }],
    M15: [],
  },
};


function transcript(entries) {
  return { entries };
}


function assistantText(text) {
  return {
    type: "assistant",
    uuid: "assistant-final",
    message: { id: "assistant-final", content: [{ type: "text", text }] },
  };
}


test("strict conjunction identifies environment misconception and forces hard UI acceptance to UNVERIFIED", () => {
  const message = "模拟器不可用，因此没有进行所需的鸿蒙 UI 测试。";
  const assessment = assessHarmonyStopGuard({
    environment: ENVIRONMENT,
    population: POPULATION,
    snapshot: transcript([assistantText(message)]),
    lastAssistantMessage: message,
  });

  assert.equal(assessment.triggered, true);
  assert.equal(assessment.status, "MISCONCEPTION");
  assert.deepEqual(assessment.obligations.map((object) => object.objectId), ["M13:favorite-ui"]);
  assert.equal(assessment.metricObjectJudgements[0].judgement, "UNVERIFIED");
  assert.equal(assessment.findings[0].rootCauseId, "TEST_NOT_EXECUTED");
  assert.deepEqual(assessment.findings[0].violatedGroundTruthIds, ["favorite-ui"]);
});


test("truthful empty-target statement and later correction are not misclassified", () => {
  assert.equal(detectHarmonyEnvironmentMisconception({
    environment: ENVIRONMENT,
    snapshot: transcript([assistantText("hdc 当前没有连接中的 target，因此设备测试暂未执行。")]),
  }), null);
  assert.equal(detectHarmonyEnvironmentMisconception({
    environment: ENVIRONMENT,
    snapshot: transcript([
      assistantText("模拟器不可用，因此没有进行 UI 测试。"),
      { ...assistantText("随后已找到并启动模拟器，可以使用。"), uuid: "assistant-correction", message: { id: "assistant-correction", content: "随后已找到并启动模拟器，可以使用。" } },
    ]),
  }), null);
});


test("a first-party HDC attempt suppresses cognition accusation but not the missing UI evidence gate", () => {
  const snapshot = transcript([
    {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "targets", name: "Bash", input: { command: "hdc list targets" } }] },
    },
    {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "targets", is_error: false, content: "[Empty]" }] },
    },
    assistantText("模拟器不可用，因此没有进行 UI 测试。"),
  ]);
  const assessment = assessHarmonyStopGuard({
    environment: ENVIRONMENT,
    population: POPULATION,
    snapshot,
    lastAssistantMessage: "模拟器不可用，因此没有进行 UI 测试。",
  });
  assert.equal(assessment.executionEvidence.attemptedHarmonyEnvironment, true);
  assert.equal(assessment.triggered, false);
  assert.equal(assessment.metricObjectJudgements[0].judgement, "UNVERIFIED");
});


test("only hard HarmonyOS UI/runtime population objects become evidence obligations", () => {
  const population = structuredClone(POPULATION);
  population.metrics.M13.push({
    ...population.metrics.M13[0],
    objectId: "M13:source-only",
    sourceId: "source-only",
    description: "manifest 中声明 bundleName",
    verification: null,
  }, {
    ...population.metrics.M13[0],
    objectId: "M13:soft-ui",
    sourceId: "soft-ui",
    hard: false,
  });
  assert.deepEqual(harmonyUiObligations(population).map((object) => object.objectId), ["M13:favorite-ui"]);
});


test("a successful fresh HarmonyOS UI tool chain suppresses the missing-evidence correction", () => {
  const calls = [
    ["build", "hvigorw.bat assembleHap"],
    ["install", "hdc install -r app.hap"],
    ["launch", "hdc shell aa start -b demo -a EntryAbility"],
    ["action", "hdc shell uitest uiInput click 100 200"],
    ["capture", "hdc shell uitest screenCap -p /data/local/tmp/ui.png"],
  ];
  const blocks = calls.map(([id, command]) => ({ type: "tool_use", id, name: "Bash", input: { command } }));
  const results = calls.map(([id]) => ({ type: "tool_result", tool_use_id: id, is_error: false, content: "ok" }));
  const snapshot = transcript([
    { type: "assistant", message: { content: blocks } },
    { type: "user", message: { content: results } },
    assistantText("模拟器不可用，因此没有进行 UI 测试。"),
  ]);
  const evidence = extractHarmonyExecutionEvidence(snapshot);
  assert.equal(evidence.completeUiChain, true);
  const assessment = assessHarmonyStopGuard({
    environment: ENVIRONMENT,
    population: POPULATION,
    snapshot,
    lastAssistantMessage: "模拟器不可用，因此没有进行 UI 测试。",
  });
  assert.equal(assessment.triggered, false);
  assert.deepEqual(assessment.metricObjectJudgements, []);
});
