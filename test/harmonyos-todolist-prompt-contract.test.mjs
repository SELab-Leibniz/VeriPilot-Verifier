import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { checkArtifact } from "../lib/runtime-corrector.mjs";
import { validateProjectPolicy } from "../lib/policy/validator.mjs";
import { validateJsonSchema } from "../lib/json-schema-validator.mjs";


const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLE_ROOT = path.join(
  PLUGIN_ROOT,
  "examples",
  "harmonyos-todolist-prompt-contract",
);


async function createFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-corrector-todolist-"));
  await fs.cp(EXAMPLE_ROOT, root, { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}


async function write(root, relative, contents) {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents, "utf8");
  return target;
}


async function writeCompleteDocuments(root) {
  await write(root, "spec/todolist/requirements.md", [
    "# TodoList 需求",
    "",
    "## 目标与范围",
    "本地新增、完成和取消完成；不做账号和云同步。",
    "",
    "## 系统需求",
    "REQ-TODO-001：终止进程并重新启动后保留待办内容和完成状态。",
    "",
    "## 事实、假设与待确认",
    "事实：单设备本地应用。待确认：无。",
    "",
  ].join("\n"));
  await write(root, "spec/todolist/code-understanding.md", [
    "# 代码理解",
    "",
    "## 工程现状",
    "ArkTS 页面与本地数据服务。",
    "",
    "## 影响范围",
    "TodoStore、列表页面和应用冷启动恢复。",
    "",
  ].join("\n"));
  await write(root, "spec/todolist/solution.md", [
    "# 方案",
    "",
    "## 架构设计",
    "页面只通过 TodoStore 读写状态。",
    "",
    "## 持久化设计",
    "每次变更原子保存；应用启动时恢复内容和完成状态。",
    "",
    "## 失败与恢复",
    "保存失败保留内存状态并提示重试。",
    "",
  ].join("\n"));
  await write(root, "spec/todolist/manual-tests.md", [
    "# 手工测试",
    "",
    "## 测试环境",
    "当前 HAP 和目标设备。",
    "",
    "## 手工测试用例",
    "MTC-TODO-001：新增并完成待办，终止进程，重新启动，断言内容与完成状态恢复。",
    "",
  ].join("\n"));
  await write(root, "spec/todolist/dt-tests.md", [
    "# DT",
    "",
    "## DT 范围",
    "TodoStore 序列化、恢复和失败分支。",
    "",
    "## DT 用例",
    "DT-TODO-001：写入、重建服务、读取并断言内容与完成状态。",
    "",
  ].join("\n"));
  await write(root, "evidence/todolist/checkpoint.json", `${JSON.stringify({
    schemaVersion: 1,
    changeName: "todolist",
    milestone: "M2-persistence",
    revision: "rev-004",
    status: "ready",
    evidence: {
      tests: ["evidence/todolist/dt-rev-004.log"],
      build: ["evidence/todolist/build-rev-004.log"],
      device: ["evidence/todolist/restart-rev-004.json"],
    },
  }, null, 2)}\n`);
}


test("HarmonyOS TodoList Prompt Contract policy validates independently", async (t) => {
  const root = await createFixture(t);
  const validation = await validateProjectPolicy({ cwd: root, pluginRoot: PLUGIN_ROOT });
  assert.equal(validation.valid, true, JSON.stringify(validation.issues));
  assert.equal(validation.artifacts.length, 7);
  assert.deepEqual(validation.groundTruth.map((source) => source.id), [
    "user-request",
    "workflow-baseline",
  ]);
  assert.match(validation.policyDigest, /^[a-f0-9]{64}$/);
});


test("TodoList checkpoint receives direct upstream and named Ground Truth inputs", async (t) => {
  const root = await createFixture(t);
  await writeCompleteDocuments(root);
  const outcome = await checkArtifact({
    cwd: root,
    pluginRoot: PLUGIN_ROOT,
    filePath: "evidence/todolist/checkpoint.json",
  });
  assert.equal(outcome.result.status, "passed", JSON.stringify(outcome.result.diagnostics));
  assert.equal(outcome.result.classification, "PASSED");
  assert.equal(outcome.result.schemaVersion, "runtime-corrector.result.v1");
  assert.match(outcome.result.metadata.inputDigest, /^[a-f0-9]{64}$/);
  assert.match(outcome.result.metadata.policyDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    outcome.result.metadata.workflow.incomingEdges.map((edge) => edge.status),
    ["ready", "ready", "ready"],
  );
  assert.deepEqual(
    outcome.result.metadata.groundTruth.sources.map((source) => source.status),
    ["ready", "ready"],
  );
  assert.ok(outcome.result.metadata.inputs.some((file) => (
    file.path === "prompt/user-request.md" && file.role === "ground-truth"
  )));
  const resultPath = outcome.result.roundOutputFiles.find((file) => file.endsWith("/result.json"));
  assert.ok(resultPath);
  const persisted = JSON.parse(await fs.readFile(path.join(root, resultPath), "utf8"));
  assert.equal(persisted.resultDigest, outcome.result.resultDigest);
  assert.equal(persisted.classification, "PASSED");
  const resultSchema = JSON.parse(await fs.readFile(
    path.join(PLUGIN_ROOT, "config", "schemas", "correction-result.schema.json"),
    "utf8",
  ));
  assert.deepEqual(validateJsonSchema(persisted, resultSchema), []);
});


test("missing required Ground Truth is unresolved instead of an artifact deviation", async (t) => {
  const root = await createFixture(t);
  await writeCompleteDocuments(root);
  await fs.rm(path.join(root, "prompt", "user-request.md"));
  const outcome = await checkArtifact({
    cwd: root,
    pluginRoot: PLUGIN_ROOT,
    filePath: "spec/todolist/requirements.md",
  });
  assert.equal(outcome.result.status, "pending");
  assert.equal(outcome.result.classification, "GROUND_TRUTH_UNRESOLVED");
  assert.ok(outcome.result.assessments.some((assessment) => (
    assessment.ruleId === "GROUND-TRUTH-SOURCE-MISSING"
    && assessment.classification === "GROUND_TRUTH_UNRESOLVED"
  )));
  assert.equal(outcome.result.findings.some((finding) => (
    finding.classification === "DEVIATION"
  )), false);
});


test("checkpoint schema failures become stable deviation findings", async (t) => {
  const root = await createFixture(t);
  await writeCompleteDocuments(root);
  await write(root, "evidence/todolist/checkpoint.json", `${JSON.stringify({
    schemaVersion: 1,
    changeName: "todolist",
    milestone: "M2-persistence",
    revision: "rev-005",
    status: "ready",
    evidence: {
      tests: ["evidence/todolist/dt-rev-005.log"],
      build: [],
      device: [],
    },
  }, null, 2)}\n`);
  const outcome = await checkArtifact({
    cwd: root,
    pluginRoot: PLUGIN_ROOT,
    filePath: "evidence/todolist/checkpoint.json",
  });
  assert.equal(outcome.result.status, "failed");
  assert.equal(outcome.result.classification, "DEVIATION");
  const finding = outcome.result.findings.find(
    (item) => item.ruleId === "TODOLIST-CHECKPOINT-SCHEMA",
  );
  assert.ok(finding);
  assert.match(finding.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(finding.suggestedAction, "FIX_CURRENT");
});
