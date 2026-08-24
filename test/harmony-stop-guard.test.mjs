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
  assert.equal(detectHarmonyEnvironmentMisconception({
    environment: ENVIRONMENT,
    snapshot: transcript([assistantText("模拟器最初不可用，因此没有进行 UI 测试；随后已找到并启动模拟器，可以使用。")]),
  }), null, "a later correction in the same message wins");
});


test("a successful but irrelevant HDC probe does not suppress a false emulator-unavailable claim", () => {
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
  assert.equal(assessment.triggered, true);
  assert.equal(assessment.metricObjectJudgements[0].judgement, "UNVERIFIED");
});


test("a matching first-party emulator failure suppresses cognition accusation but not evidence obligations", () => {
  const snapshot = transcript([
    {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "emulator", name: "Bash", input: { command: "Emulator.exe --start runtime-corrector" } }] },
    },
    {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "emulator", is_error: true, content: "exit code 1: virtualization unavailable" }] },
    },
    assistantText("模拟器不可用，因此没有进行 UI 测试。"),
  ]);
  const assessment = assessHarmonyStopGuard({
    environment: ENVIRONMENT,
    population: POPULATION,
    snapshot,
    lastAssistantMessage: "模拟器不可用，因此没有进行 UI 测试。",
  });
  assert.equal(assessment.triggered, false);
  assert.equal(assessment.matchingFailureEvidence.topic, "emulator");
  assert.equal(assessment.metricObjectJudgements[0].judgement, "UNVERIFIED");
});


test("only the latest relevant environment attempt can justify an unavailable claim", () => {
  const snapshot = transcript([
    {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "emulator-failed", name: "Bash", input: { command: "Emulator.exe --start runtime-corrector" } }] },
    },
    {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "emulator-failed", is_error: true, content: "exit code 1: virtualization unavailable" }] },
    },
    {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "emulator-started", name: "Bash", input: { command: "Emulator.exe --start runtime-corrector" } }] },
    },
    {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "emulator-started", is_error: false, content: "started" }] },
    },
    assistantText("模拟器不可用，因此没有进行 UI 测试。"),
  ]);
  const assessment = assessHarmonyStopGuard({
    environment: ENVIRONMENT,
    population: POPULATION,
    snapshot,
    lastAssistantMessage: "模拟器不可用，因此没有进行 UI 测试。",
  });
  assert.equal(assessment.latestRelevantAttempt.successful, true);
  assert.equal(assessment.matchingFailureEvidence, null);
  assert.equal(assessment.triggered, true);
});


test("echoed command text and echoed failure text are not HarmonyOS execution evidence", () => {
  const calls = [
    ["build", "echo hvigorw.bat assembleHap"],
    ["install", "echo hdc install -r app.hap"],
    ["launch", "echo hdc shell aa start -b demo -a EntryAbility"],
    ["action", "echo hdc shell uitest uiInput click 100 200"],
    ["assertion", "echo hdc shell uitest find text 已收藏"],
    ["fake-failure", "echo Emulator.exe unavailable"],
  ];
  const snapshot = transcript([{
    type: "assistant",
    message: { content: calls.map(([id, command]) => ({ type: "tool_use", id, name: "Bash", input: { command } })) },
  }, {
    type: "user",
    message: { content: calls.map(([id]) => ({
      type: "tool_result",
      tool_use_id: id,
      is_error: id === "fake-failure",
      content: id === "fake-failure" ? "exit code 1" : "ok",
    })) },
  }, assistantText("模拟器不可用，因此没有进行 UI 测试。")]);
  const assessment = assessHarmonyStopGuard({
    environment: ENVIRONMENT,
    population: POPULATION,
    snapshot,
    lastAssistantMessage: "模拟器不可用，因此没有进行 UI 测试。",
  });
  assert.equal(assessment.executionEvidence.attemptedHarmonyEnvironment, false);
  assert.equal(assessment.executionEvidence.completeUiChain, false);
  assert.equal(assessment.matchingFailureEvidence, null);
  assert.equal(assessment.triggered, true);
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
    ["assertion", "hdc shell uitest find text 已收藏"],
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


test("real-device-only obligations participate only when a target is currently connected", () => {
  const population = structuredClone(POPULATION);
  population.metrics.M13[0].verification.realDeviceOnly = true;
  const message = "设备不可用，因此没有进行所需的鸿蒙 UI 测试。";
  const absent = assessHarmonyStopGuard({
    environment: ENVIRONMENT,
    population,
    snapshot: transcript([assistantText(message)]),
    lastAssistantMessage: message,
  });
  assert.equal(absent.triggered, false);

  const connectedEnvironment = structuredClone(ENVIRONMENT);
  connectedEnvironment.capabilities.target = { state: "CONNECTED", count: 1 };
  connectedEnvironment.capabilities.uiTestReadiness = "READY";
  const connected = assessHarmonyStopGuard({
    environment: connectedEnvironment,
    population,
    snapshot: transcript([assistantText(message)]),
    lastAssistantMessage: message,
  });
  assert.equal(connected.triggered, true);
  assert.deepEqual(connected.findings[0].violatedGroundTruthIds, ["favorite-ui"]);
});


test("unordered commands and a screenshot cannot substitute for an ordered UI assertion chain", () => {
  const calls = [
    ["capture", "hdc shell uitest screenCap -p /data/local/tmp/ui.png"],
    ["action", "hdc shell uitest uiInput click 100 200"],
    ["assertion", "hdc shell uitest find text 已收藏"],
    ["launch", "hdc shell aa start -b demo -a EntryAbility"],
    ["install", "hdc install -r app.hap"],
    ["build", "hvigorw.bat assembleHap"],
  ];
  const snapshot = transcript([{
    type: "assistant",
    message: { content: calls.map(([id, command]) => ({ type: "tool_use", id, name: "Bash", input: { command } })) },
  }, {
    type: "user",
    message: { content: calls.map(([id]) => ({ type: "tool_result", tool_use_id: id, is_error: false, content: "ok" })) },
  }]);
  const assessment = assessHarmonyStopGuard({
    environment: ENVIRONMENT,
    population: POPULATION,
    snapshot,
    lastAssistantMessage: "功能已完成。",
  });
  assert.equal(assessment.executionEvidence.completeUiChain, false);
  assert.equal(assessment.metricObjectJudgements[0].judgement, "UNVERIFIED");
});


test("one explicitly bound UI chain cannot satisfy a different acceptance object", () => {
  const population = structuredClone(POPULATION);
  population.metrics.M13.push({
    ...population.metrics.M13[0],
    objectId: "M13:checkout-ui",
    sourceId: "checkout-ui",
    description: "点击结算按钮后页面显示订单确认状态",
  });
  const calls = [
    ["build", "hvigorw.bat assembleHap"],
    ["install", "hdc install -r app.hap"],
    ["launch", "hdc shell aa start -b demo -a EntryAbility"],
    ["action", "hdc shell uitest uiInput click 100 200 # M13:favorite-ui"],
    ["assertion", "hdc shell uitest find text 已收藏 # M13:favorite-ui"],
    ["capture", "hdc shell uitest screenCap -p /data/local/tmp/ui.png # M13:favorite-ui"],
  ];
  const snapshot = transcript([{
    type: "assistant",
    message: { content: calls.map(([id, command]) => ({ type: "tool_use", id, name: "Bash", input: { command } })) },
  }, {
    type: "user",
    message: { content: calls.map(([id]) => ({ type: "tool_result", tool_use_id: id, is_error: false, content: "ok" })) },
  }]);
  const assessment = assessHarmonyStopGuard({
    environment: ENVIRONMENT,
    population,
    snapshot,
    lastAssistantMessage: "功能已完成。",
  });
  assert.equal(assessment.executionEvidence.completeUiChain, false);
  assert.deepEqual(
    assessment.executionEvidence.evidenceByObject.map(({ objectId, complete }) => ({ objectId, complete })),
    [
      { objectId: "M13:favorite-ui", complete: true },
      { objectId: "M13:checkout-ui", complete: false },
    ],
  );
  assert.deepEqual(assessment.metricObjectJudgements.map((item) => item.objectId), ["M13:checkout-ui"]);
});
