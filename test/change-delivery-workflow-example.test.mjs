import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseSimpleYaml } from "../lib/simple-yaml.mjs";


const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLE_ROOT = path.join(PLUGIN_ROOT, "examples", "change-delivery-workflow");
const CLI = path.join(PLUGIN_ROOT, "scripts", "cli.mjs");


test("change-delivery workflow prompt keeps authoring stages separate from artifact ownership", async () => {
  const raw = await fs.readFile(path.join(EXAMPLE_ROOT, "workflow.yaml"), "utf8");
  const workflow = parseSimpleYaml(raw, { source: "workflow.yaml" });
  const stages = new Map(workflow.stages.map((stage) => [stage.id, stage]));

  assert.deepEqual(
    [...stages.keys()],
    [
      "requirements-analysis",
      "requirements-breakdown",
      "ux-design",
      "code-understanding",
      "solution-design",
      "manual-test-design",
      "dt-test-design",
    ],
  );
  assert.equal(stages.get("ux-design").optional, true);
  assert.equal(
    stages.get("requirements-analysis").output.path,
    stages.get("requirements-breakdown").output.path,
  );
  assert.equal(
    stages.get("requirements-analysis").output.runtimeCorrectorArtifactId,
    "requirements-report",
  );
  assert.equal(
    stages.get("requirements-breakdown").output.runtimeCorrectorArtifactId,
    "requirements-report",
  );
});


test("change-delivery Runtime Corrector policy loads six generic artifact stages", () => {
  const completed = spawnSync(
    process.execPath,
    [CLI, "stages", "--cwd", EXAMPLE_ROOT, "--format", "json"],
    { cwd: EXAMPLE_ROOT, encoding: "utf8", windowsHide: true },
  );

  assert.equal(completed.status, 0, completed.stderr);
  const result = JSON.parse(completed.stdout);
  assert.deepEqual(
    result.stages.map((stage) => stage.stage),
    [
      "requirements-report",
      "ux-design",
      "code-understanding",
      "solution-design",
      "manual-test-cases",
      "dt-test-cases",
    ],
  );
  assert.ok(result.stages.every((stage) => stage.rules.enabled && stage.review.enabled));
});


test("optional UX stays optional while YAML rules diagnose an invalid downstream artifact", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-corrector-change-workflow-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.cp(EXAMPLE_ROOT, root, { recursive: true });
  await fs.mkdir(path.join(root, "spec"), { recursive: true });

  await fs.writeFile(
    path.join(root, "spec", "2026-07-27-需求分析报告-check.md"),
    `# 需求

## 变更背景
背景。
## 目标与范围
\`REQ-001\` 范围。
## 需求分析
分析。
## 需求拆分
拆分。
## 验收标准
- [ ] 条件一
- [ ] 条件二
## 风险与待确认
无。
`,
    "utf8",
  );
  await fs.writeFile(
    path.join(root, "spec", "2026-07-27-代码理解报告-check.md"),
    `# 代码理解

## 分析范围
\`REQ-001\`
## 现状结构
结构。
## 关键调用链
调用链。
## 数据与状态
状态。
## 变更影响
影响。
## 风险与约束
约束。
## 来源追溯
\`REQ-001\`
`,
    "utf8",
  );

  const optionalUx = spawnSync(
    process.execPath,
    [
      CLI,
      "check",
      "spec/2026-07-27-代码理解报告-check.md",
      "--cwd",
      root,
      "--format",
      "json",
    ],
    { cwd: root, encoding: "utf8", windowsHide: true },
  );
  assert.equal(optionalUx.status, 0, optionalUx.stderr);
  const optionalResult = JSON.parse(optionalUx.stdout);
  assert.equal(optionalResult.status, "passed");
  assert.deepEqual(optionalResult.diagnostics, []);
  assert.deepEqual(
    optionalResult.metadata.workflow.incomingEdges.map((edge) => [edge.id, edge.status]),
    [["requirements-report->code-understanding", "ready"]],
  );

  await fs.writeFile(
    path.join(root, "spec", "2026-07-27-模块设计报告-invalid.md"),
    "# 方案\n\n## 设计目标\n\nTODO\n",
    "utf8",
  );
  const invalid = spawnSync(
    process.execPath,
    [
      CLI,
      "check",
      "spec/2026-07-27-模块设计报告-invalid.md",
      "--cwd",
      root,
      "--format",
      "json",
    ],
    { cwd: root, encoding: "utf8", windowsHide: true },
  );
  assert.equal(invalid.status, 1);
  const invalidResult = JSON.parse(invalid.stdout);
  const ruleIds = invalidResult.diagnostics.map((diagnostic) => diagnostic.ruleId);
  assert.ok(ruleIds.includes("SOLUTION-BOUNDARY"));
  assert.ok(ruleIds.includes("SOLUTION-TRACE-ID"));
  assert.ok(ruleIds.includes("SOLUTION-NO-PLACEHOLDER"));
  assert.equal(invalidResult.agentReview.edges[0].id, "code-understanding->solution-design");
  assert.deepEqual(invalidResult.metadata.workflow.editableArtifactFiles, [
    "spec/2026-07-27-模块设计报告-invalid.md",
  ]);
});


test("change-delivery example isolates parallel changeName instances across dates", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-corrector-change-isolation-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.cp(EXAMPLE_ROOT, root, { recursive: true });
  await fs.mkdir(path.join(root, "spec"), { recursive: true });
  const requirements = `# 需求

## 变更背景
背景。
## 目标与范围
\`REQ-001\` 范围。
## 需求分析
分析。
## 需求拆分
拆分。
## 验收标准
- [ ] 条件一
- [ ] 条件二
## 风险与待确认
无。
`;
  const code = `# 代码理解

## 分析范围
\`REQ-001\`
## 现状结构
结构。
## 关键调用链
调用链。
## 数据与状态
状态。
## 变更影响
影响。
## 风险与约束
约束。
## 来源追溯
\`REQ-001\`
`;
  await fs.writeFile(
    path.join(root, "spec", "2026-07-27-需求分析报告-alpha.md"),
    requirements,
  );
  await fs.writeFile(
    path.join(root, "spec", "2026-07-28-需求分析报告-beta.md"),
    requirements,
  );
  await fs.writeFile(
    path.join(root, "spec", "2026-07-29-代码理解报告-alpha.md"),
    code,
  );

  const completed = spawnSync(
    process.execPath,
    [
      CLI,
      "check",
      "spec/2026-07-29-代码理解报告-alpha.md",
      "--cwd",
      root,
      "--format",
      "json",
    ],
    { cwd: root, encoding: "utf8", windowsHide: true },
  );

  assert.equal(completed.status, 0, completed.stderr);
  const result = JSON.parse(completed.stdout);
  assert.deepEqual(result.metadata.workflow.instance, { changeName: "alpha" });
  assert.deepEqual(
    result.metadata.workflow.incomingEdges[0].sourceFiles,
    ["spec/2026-07-27-需求分析报告-alpha.md"],
  );
  assert.ok(result.metadata.artifactFiles.every((file) => !file.includes("-beta.md")));
  assert.ok(result.metadata.artifactFiles.includes("workflow.yaml"));
  assert.ok(result.metadata.artifactFiles.includes("src/cli.mjs"));
});
