import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  checkArtifact,
  matchArtifact,
} from "../lib/runtime-corrector.mjs";
import { loadSimpleProjectConfig } from "../lib/simple-mode.mjs";


const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(PLUGIN_ROOT, "scripts", "cli.mjs");


async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-corrector-correlation-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}


async function writeFile(root, relativePath, content = "# Document\n") {
  const filePath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
  return filePath;
}


async function writeCorrelatedProject(t) {
  const cwd = await workspace(t);
  await writeFile(cwd, ".runtime-corrector/config.yaml", `version: 1
artifacts:
  - name: source
    pathTemplates:
      - "spec/{YYYY-MM-DD}-source-{changeName}.md"
    rules:
      enabled: false
    review:
      enabled: false
  - name: ux
    pathTemplates:
      - "spec/{YYYY-MM-DD}-ux-{changeName}.md"
    rules:
      enabled: false
    review:
      enabled: false
  - name: target
    pathTemplates:
      - "spec/{YYYY-MM-DD}-target-{changeName}.md"
    relatedRoot: project
    relatedPatterns:
      - workflow.yaml
      - src/**/*
      - spec/*-source-*.md
      - spec/*-ux-*.md
    rules:
      enabled: false
    review:
      enabled: false
workflow:
  correlation:
    keys:
      - changeName
  edges:
    - from: source
      to: target
      review:
        enabled: true
output:
  persist: false
`);
  await writeFile(cwd, "workflow.yaml", "kind: example\n");
  await writeFile(cwd, "src/index.txt", "global source evidence\n");
  return cwd;
}


test("correlated workflow bundles include only the trigger instance and keep global evidence", async (t) => {
  const cwd = await writeCorrelatedProject(t);
  await writeFile(cwd, "spec/2026-07-27-source-alpha.md");
  await writeFile(cwd, "spec/2026-07-28-ux-alpha.md");
  await writeFile(cwd, "spec/2026-07-29-target-alpha.md");
  await writeFile(cwd, "spec/2026-07-29-source-beta.md");
  await writeFile(cwd, "spec/2026-07-29-ux-beta.md");
  await writeFile(cwd, "spec/2026-07-29-target-beta.md");

  const prepared = await checkArtifact({
    cwd,
    pluginRoot: PLUGIN_ROOT,
    filePath: "spec/2026-07-29-target-alpha.md",
    deferPersistence: true,
  });

  assert.deepEqual(prepared.result.metadata.workflow.instance, {
    changeName: "alpha",
  });
  assert.ok(prepared.result.metadata.artifactFiles.includes(
    "spec/2026-07-27-source-alpha.md",
  ));
  assert.ok(prepared.result.metadata.artifactFiles.includes(
    "spec/2026-07-28-ux-alpha.md",
  ));
  assert.ok(prepared.result.metadata.artifactFiles.includes("workflow.yaml"));
  assert.ok(prepared.result.metadata.artifactFiles.includes("src/index.txt"));
  assert.ok(prepared.result.metadata.artifactFiles.every(
    (file) => !file.includes("-beta.md"),
  ));
  assert.deepEqual(
    prepared.result.metadata.workflow.incomingEdges[0].sourceFiles,
    ["spec/2026-07-27-source-alpha.md"],
  );
  assert.deepEqual(
    prepared.result.metadata.workflow.editableArtifactFiles,
    ["spec/2026-07-29-target-alpha.md"],
  );
  assert.deepEqual(prepared.reviewContext.workflow.instance, {
    changeName: "alpha",
  });
});


test("another instance cannot satisfy a missing workflow source", async (t) => {
  const cwd = await writeCorrelatedProject(t);
  await writeFile(cwd, "spec/2026-07-28-source-beta.md");
  await writeFile(cwd, "spec/2026-07-29-target-alpha.md");

  const prepared = await checkArtifact({
    cwd,
    pluginRoot: PLUGIN_ROOT,
    filePath: "spec/2026-07-29-target-alpha.md",
    deferPersistence: true,
  });

  assert.equal(prepared.result.status, "pending");
  assert.deepEqual(
    prepared.result.metadata.workflow.incomingEdges[0].sourceFiles,
    [],
  );
  assert.equal(
    prepared.result.diagnostics.at(-1).ruleId,
    "WORKFLOW-EDGE-SOURCE-MISSING",
  );
  assert.ok(prepared.result.metadata.artifactFiles.every(
    (file) => file !== "spec/2026-07-28-source-beta.md",
  ));
});


test("multiple files owned by one node and instance remain one editable artifact bundle", async (t) => {
  const cwd = await workspace(t);
  await writeFile(cwd, ".runtime-corrector/config.yaml", `version: 1
artifacts:
  - name: source
    pathTemplates:
      - "docs/{date}-source-{changeName}.md"
    review:
      enabled: false
  - name: target
    pathTemplates:
      - "docs/{date}-target-a-{changeName}.md"
      - "docs/{date}-target-b-{changeName}.md"
    review:
      enabled: false
workflow:
  correlation:
    keys: [changeName]
  edges:
    - from: source
      to: target
      review:
        enabled: true
output:
  persist: false
`);
  await writeFile(cwd, "docs/2026-07-27-source-alpha.md");
  await writeFile(cwd, "docs/2026-07-28-target-a-alpha.md");
  await writeFile(cwd, "docs/2026-07-29-target-b-alpha.md");
  await writeFile(cwd, "docs/2026-07-29-target-b-beta.md");

  const prepared = await checkArtifact({
    cwd,
    pluginRoot: PLUGIN_ROOT,
    filePath: "docs/2026-07-28-target-a-alpha.md",
    deferPersistence: true,
  });

  assert.deepEqual(
    prepared.result.metadata.workflow.editableArtifactFiles,
    [
      "docs/2026-07-28-target-a-alpha.md",
      "docs/2026-07-29-target-b-alpha.md",
    ],
  );
  assert.ok(prepared.result.metadata.artifactFiles.every(
    (file) => file !== "docs/2026-07-29-target-b-beta.md",
  ));
});


test("project config enforces matcher exclusivity and workflow correlation coverage", async (t) => {
  const cwd = await workspace(t);
  const configPath = ".runtime-corrector/config.yaml";

  await writeFile(cwd, configPath, `version: 1
artifacts:
  - name: invalid
    patterns: [docs/*.md]
    pathTemplates: ["docs/{changeName}.md"]
`);
  await assert.rejects(
    loadSimpleProjectConfig(cwd),
    /必须且只能声明 patterns 或 pathTemplates 之一/,
  );

  await writeFile(cwd, configPath, `version: 1
artifacts:
  - name: source
    patterns: [source.md]
  - name: target
    pathTemplates: ["target-{changeName}.md"]
workflow:
  correlation:
    keys: [changeName]
  edges:
    - from: source
      to: target
      review:
        enabled: true
`);
  await assert.rejects(
    loadSimpleProjectConfig(cwd),
    /artifact“source”.*必须使用 pathTemplates/,
  );

  await writeFile(cwd, configPath, `version: 1
artifacts:
  - name: source
    pathTemplates: ["source-{date}.md"]
  - name: target
    pathTemplates: ["target-{changeName}.md"]
workflow:
  correlation:
    keys: [changeName]
  edges:
    - from: source
      to: target
      review:
        enabled: true
`);
  await assert.rejects(
    loadSimpleProjectConfig(cwd),
    /artifact“source”.*包含：changeName/,
  );
});


test("custom matchers must return a complete instance only in correlation mode", async (t) => {
  const cwd = await workspace(t);
  const matcherPath = await writeFile(cwd, "matcher.mjs", `export function matchArtifact() {
  return { stage: "custom", artifactType: "custom" };
}
`);
  const common = {
    ignorePatterns: [],
    artifacts: [],
    extensions: { matcherModule: matcherPath },
  };
  const legacy = await matchArtifact({
    filePath: path.join(cwd, "target.md"),
    cwd,
    config: common,
  });
  assert.equal(legacy.stage, "custom");

  await assert.rejects(
    matchArtifact({
      filePath: path.join(cwd, "target.md"),
      cwd,
      config: {
        ...common,
        workflowCorrelation: { keys: ["changeName"] },
      },
    }),
    /自定义 matcher 返回的 instance.*changeName/,
  );
});


test("explain and spec expose path templates and correlation selection rules", async (t) => {
  const cwd = await writeCorrelatedProject(t);
  for (const command of ["explain", "spec"]) {
    const output = JSON.parse(execFileSync(
      process.execPath,
      [CLI, command, "target", "--cwd", cwd, "--format", "json"],
      { encoding: "utf8" },
    ));
    const artifact = command === "explain"
      ? output.artifacts[0]
      : output.criteria[0].artifact;
    const workflow = command === "explain"
      ? output.artifacts[0].workflow
      : output.criteria[0].workflow;
    assert.deepEqual(
      artifact.pathTemplates,
      ["spec/{YYYY-MM-DD}-target-{changeName}.md"],
    );
    assert.deepEqual(workflow.correlation.keys, ["changeName"]);
    assert.match(workflow.correlation.selection, /trigger path/);
  }
});


test("workflow skill and README state the instance decision boundary", async () => {
  const skill = await fs.readFile(
    path.join(
      PLUGIN_ROOT,
      "skills",
      "runtime-corrector-workflow",
      "SKILL.md",
    ),
    "utf8",
  );
  const readme = await fs.readFile(path.join(PLUGIN_ROOT, "README.md"), "utf8");
  const readmeZh = await fs.readFile(path.join(PLUGIN_ROOT, "README.zh-CN.md"), "utf8");

  assert.match(skill, /continue an existing change/);
  assert.match(skill, /create a new change/);
  assert.match(skill, /read-only references/);
  assert.match(skill, /Do not set or expose an active key/);
  assert.match(skill, /Do not infer history, select the latest file/);
  assert.match(readme, /continuing an\s+existing change or creating a new one/);
  assert.match(readme, /never selects the "latest" document by modification\s+time/);
  assert.match(readmeZh, /不负责决定用户是在继续旧 change 还是创建新 change/);
  assert.match(readmeZh, /不会按修改时间\s*选择“最新”文件/);
  assert.match(readmeZh, /只配置 `patterns` 而不配置 correlation/);
});
