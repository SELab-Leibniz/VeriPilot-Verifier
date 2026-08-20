import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  checkArtifact,
  diagnoseArtifacts,
} from "../lib/runtime-corrector.mjs";
import {
  loadSimpleProjectConfig,
  loadSimpleRules,
} from "../lib/simple-mode.mjs";
import { parseSimpleYaml } from "../lib/simple-yaml.mjs";


const TEST_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.dirname(TEST_ROOT);
const EXAMPLE_ROOT = path.join(
  PLUGIN_ROOT,
  "examples",
  "veripilot-guarded-delivery",
  "guarded-delivery-workflow",
);
const POLICY_ROOT = path.join(EXAMPLE_ROOT, ".runtime-corrector");
const PUBLISH_SCRIPT = path.join(
  EXAMPLE_ROOT,
  "scripts",
  "publish-planning-projection.mjs",
);

const SIX_STAGE_FILES = [
  ".workflow/current/stages/10-requirement-analysis/requirement-analysis.md",
  ".workflow/current/stages/20-requirement-breakdown/requirement-breakdown.md",
  ".workflow/current/stages/30-code-understanding/code-understanding.md",
  ".workflow/current/stages/40-solution-design/solution-design.md",
  ".workflow/current/stages/50-manual-test-cases/manual-test-cases.md",
  ".workflow/current/stages/60-dt-design/dt-design.md",
];
const PLANNING_FILES = [
  "VeriPilotWorkspace/guarded-current/delivery/planning-projection/SR.md",
  "VeriPilotWorkspace/guarded-current/delivery/planning-projection/PilotPlan.md",
  "VeriPilotWorkspace/guarded-current/delivery/planning-projection/relations.json",
  "VeriPilotWorkspace/guarded-current/delivery/planning-projection/granularity-choice.json",
];
const PRD_FILES = [
  "VeriPilotWorkspace/guarded-current/stages/40-prd-contract/deliverables/PRD.md",
  "VeriPilotWorkspace/guarded-current/stages/40-prd-contract/deliverables/acceptance-contract.json",
];
const PLANNING_MANIFEST =
  "VeriPilotWorkspace/guarded-current/delivery/planning-projection/manifest.json";
const PRD_PROTOCOL_FILES = [
  "VeriPilotWorkspace/guarded-current/stages/40-prd-contract/output/manifest.json",
  "VeriPilotWorkspace/guarded-current/stages/40-prd-contract/output/handoff.json",
];


async function temporaryProject(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "guarded-delivery-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}


async function writeProjectFile(root, relativePath, contents) {
  const target = path.join(root, ...relativePath.split("/"));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents, "utf8");
  return target;
}


function gateMarkdown() {
  return `# Gate

## 审查对象

Declared files only.

## 输入与哈希证据

All current byte hashes recorded.

## 覆盖与一致性

No drift found.

## Corrector 结果

deterministic=passed; agentReview=completed.

## 诊断与兼容例外

None.

## Bundle 边界声明

- max_related_files=120
- collector_candidate_cap=480
- expected_related_files=5
- observed_related_files=5
- collector_truncated=false

## 门禁结论

passed

## 下一动作

next-stage
`;
}


async function writeSixStages(root) {
  for (const relativePath of SIX_STAGE_FILES) {
    await writeProjectFile(root, relativePath, `# ${path.basename(relativePath)}\n`);
  }
}


async function writePlanningBundle(root) {
  await writeProjectFile(root, PLANNING_FILES[0], "# SR\n\n## SR-1\n\nOne capability.\n");
  await writeProjectFile(root, PLANNING_FILES[1], `# Pilot Plan

## Granularity

- Recommended: normal
- Selected: normal
- Milestone count: 1
- Confirmation: auto
- Reason: one independently verifiable increment

## M1: First milestone

- Contains SR: SR-1
- Goal: deliver SR-1
- Review focus: observable acceptance
- Risks: none

## Cross-Milestone Notes

No cross-milestone dependency.
`);
  await writeProjectFile(root, PLANNING_FILES[2], `${JSON.stringify({
    schema_version: "planning.relations.v1",
    nodes: [
      { id: "SR-1", type: "sr", title: "First SR" },
      { id: "M1", type: "milestone", title: "First milestone" },
    ],
    edges: [{ from: "M1", to: "SR-1", type: "contains" }],
  }, null, 2)}\n`);
  await writeProjectFile(root, PLANNING_FILES[3], `${JSON.stringify({
    schema_version: "planning.granularity_choice.v1",
    mode: "auto",
    selected: "normal",
    recommended: "normal",
    milestone_count: 1,
    groups: [{ milestone: "M1", sr_ids: ["SR-1"] }],
    source: "auto_selected_recommended",
    reason: "one independently verifiable increment",
  }, null, 2)}\n`);
}


async function installPolicy(root) {
  await fs.cp(POLICY_ROOT, path.join(root, ".runtime-corrector"), { recursive: true });
}


test("prompt defines one reported pipeline without Planning or IR invocation", async () => {
  const workflowText = await fs.readFile(
    path.join(EXAMPLE_ROOT, "guarded_delivery_workflow.yaml"),
    "utf8",
  );
  const workflow = parseSimpleYaml(workflowText, {
    source: "examples/veripilot-guarded-delivery/guarded-delivery-workflow/guarded_delivery_workflow.yaml",
  });

  assert.equal(workflow.name, "guarded-delivery");
  assert.equal(workflow.version, "2.0.0");
  assert.equal(workflow.components.buildQaLoop.version, "3.6.0");
  assert.equal(workflow.stages.length, 18);
  assert.deepEqual(workflow.forbiddenComponents, ["ir", "planning"]);
  const orders = workflow.stages.map((stage) => stage.order);
  assert.deepEqual(orders, [...orders].sort((left, right) => left - right));
  assert.equal(new Set(orders).size, orders.length);
  assert.ok(workflow.stages.every((stage) => stage.report.endsWith(".completion.json")));
  assert.equal(
    new Set(workflow.stages.map((stage) => stage.report)).size,
    workflow.stages.length,
  );

  const byName = Object.fromEntries(workflow.stages.map((stage) => [stage.name, stage]));
  const preflight = byName["workflow-preflight"].action;
  assert.equal(preflight.harmonyEnvironmentAdmissionOwner, "build-qa-loop");
  assert.deepEqual(preflight.doNotInferHarmonyUnavailableFrom, [
    "project-local-hvigorw-absence",
    "empty-local-properties",
    "unset-sdk-environment-variables",
  ]);
  const invocations = workflow.stages
    .map((stage) => stage.action?.invoke)
    .filter(Boolean)
    .join("\n");
  assert.doesNotMatch(invocations, /\/planning:/);
  assert.doesNotMatch(invocations, /\/ir:/);
  assert.match(byName["prd-contract-auto"].action.invoke, /prd-contract:workflow auto/);
  assert.match(byName["prd-contract-auto"].action.invoke, /--mode auto/);
  assert.match(
    byName["prd-contract-auto"].action.invoke,
    /--source-manifest "delivery\/planning-projection\/manifest\.json"/,
  );
  assert.match(byName["build-qa-loop-auto"].action.invoke, /build-qa-loop:workflow auto/);
  assert.match(byName["build-qa-loop-auto"].action.invoke, /--scope all --mode auto/);
  assert.equal(
    [...byName["build-qa-loop-auto"].action.invoke.matchAll(/--source-manifest/g)].length,
    1,
  );
  assert.match(
    byName["build-qa-loop-auto"].action.invoke,
    /--source-manifest "stages\/40-prd-contract\/output\/manifest\.json"/,
  );
});


test("Corrector config fixes semantic evidence at six-to-four and four-to-two", async () => {
  const config = await loadSimpleProjectConfig(EXAMPLE_ROOT);
  const nodes = new Map(
    config.configuredArtifacts.map((artifact) => [artifact.nodeId, artifact]),
  );
  const incomingFiles = (nodeId) => config.reviewGraph
    .incomingEdges(nodeId)
    .filter((edge) => edge.reviewEnabled)
    .flatMap((edge) => nodes.get(edge.from).patterns);
  const uniqueSorted = (items) => [...new Set(items)].sort();

  assert.ok(!nodes.has("ir-contract"));
  assert.ok(!nodes.has("planning-bundle"));
  assert.deepEqual(nodes.get("planning-projection").patterns, PLANNING_FILES);
  assert.equal(nodes.get("planning-projection").editable, true);
  assert.deepEqual(nodes.get("prd-deliverables").patterns, PRD_FILES);
  assert.equal(nodes.get("prd-deliverables").editable, false);
  assert.deepEqual(nodes.get("planning-publication").patterns, [PLANNING_MANIFEST]);
  assert.equal(nodes.get("planning-publication").reviewEnabled, false);
  assert.equal(nodes.get("prd-publication").reviewEnabled, false);

  assert.deepEqual(
    uniqueSorted([
      ...nodes.get("planning-fidelity-gate").relatedPatterns,
      ...incomingFiles("planning-fidelity-gate"),
    ]),
    uniqueSorted([...SIX_STAGE_FILES, ...PLANNING_FILES]),
  );
  assert.deepEqual(
    uniqueSorted([
      ...nodes.get("prd-deliverables-gate").relatedPatterns,
      ...incomingFiles("prd-deliverables-gate"),
    ]),
    uniqueSorted([...PLANNING_FILES, ...PRD_FILES]),
  );

  for (const nodeId of [
    "planning-projection",
    "planning-fidelity-gate",
    "prd-deliverables",
    "prd-deliverables-gate",
    "build-qa-handoff-gate",
  ]) {
    const artifact = nodes.get(nodeId);
    for (const configuredPath of [...artifact.patterns, ...artifact.relatedPatterns]) {
      assert.doesNotMatch(
        configuredPath,
        /[*?[\]{}]/,
        `${nodeId} must enumerate pre-build evidence exactly`,
      );
    }
  }
});


test("all configured rules load and no unused IR policy remains", async () => {
  const config = await loadSimpleProjectConfig(EXAMPLE_ROOT);
  for (const artifact of config.configuredArtifacts) {
    if (!artifact.simpleRulesFile) continue;
    const rules = await loadSimpleRules(artifact.simpleRulesFile);
    assert.ok(rules.ruleSummaries.length > 0, artifact.nodeId);
  }
  const policyFiles = await fs.readdir(POLICY_ROOT);
  assert.ok(policyFiles.every((name) => !name.startsWith("ir-")));
  assert.ok(policyFiles.includes("planning-publication.rules.yaml"));
  await fs.access(path.join(
    POLICY_ROOT,
    "schemas",
    "planning-projection-manifest.schema.json",
  ));
});


test("publication helper emits and revalidates a PRD-compatible delivery envelope", async (t) => {
  const root = await temporaryProject(t);
  await writeProjectFile(root, "workspace.json", `${JSON.stringify({
    schema_version: "veripilot.workspace.v2",
    schema_revision: 1,
    request_id: "req-test",
    workspace_id: "ws-test",
    required_capabilities: [
      "workspace-v2",
      "protocol-v2-conformance-r1",
      "semantic-input-v1",
    ],
  }, null, 2)}\n`);
  const sourceRoot = path.join(root, "delivery", "planning-projection");
  await fs.mkdir(sourceRoot, { recursive: true });
  for (const name of ["SR.md", "PilotPlan.md", "relations.json", "granularity-choice.json"]) {
    await fs.writeFile(path.join(sourceRoot, name), `${name}\n`, "utf8");
  }

  const published = JSON.parse(execFileSync(
    process.execPath,
    [
      PUBLISH_SCRIPT,
      "--workspace-root",
      root,
      "--source-root",
      "delivery/planning-projection",
    ],
    { encoding: "utf8" },
  ));
  assert.equal(published.status, "verified");

  const manifest = JSON.parse(await fs.readFile(path.join(sourceRoot, "manifest.json"), "utf8"));
  assert.equal(manifest.schema_version, "veripilot.delivery_manifest.v2");
  assert.equal(manifest.scope, "planning-projection");
  assert.equal(manifest.producer.component_id, "guarded-delivery");
  assert.equal(manifest.producer.version, "3.1.0");
  assert.equal(manifest.artifacts.length, 4);
  assert.ok(manifest.artifacts.every((artifact) => (
    artifact.path.startsWith("delivery/planning-projection/")
    && /^sha256:[a-f0-9]{64}$/.test(artifact.sha256)
  )));
  assert.ok(manifest.producer_capabilities.includes("semantic-input-v1"));
  assert.match(manifest.manifest_hash, /^sha256:[a-f0-9]{64}$/);

  execFileSync(
    process.execPath,
    [
      PUBLISH_SCRIPT,
      "--workspace-root",
      root,
      "--source-root",
      "delivery/planning-projection",
    ],
    { encoding: "utf8" },
  );
  const checked = JSON.parse(execFileSync(
    process.execPath,
    [
      PUBLISH_SCRIPT,
      "--workspace-root",
      root,
      "--source-root",
      "delivery/planning-projection",
      "--check",
    ],
    { encoding: "utf8" },
  ));
  assert.match(checked.manifest_hash, /^sha256:[a-f0-9]{64}$/);

  await fs.writeFile(path.join(sourceRoot, "SR.md"), "changed\n", "utf8");
  const stale = spawnSync(
    process.execPath,
    [
      PUBLISH_SCRIPT,
      "--workspace-root",
      root,
      "--source-root",
      "delivery/planning-projection",
      "--check",
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /stale or invalid/);
});


test("Planning runtime reads exactly six sources plus four Agent-owned targets", async (t) => {
  const root = await temporaryProject(t);
  await installPolicy(root);
  await writeSixStages(root);
  await writePlanningBundle(root);
  await writeProjectFile(root, PLANNING_MANIFEST, "{}\n");

  const result = await checkArtifact({
    cwd: root,
    pluginRoot: PLUGIN_ROOT,
    filePath: PLANNING_FILES[0],
    deferPersistence: true,
  });
  assert.equal(result.result.status, "passed", JSON.stringify(result.result.diagnostics));
  assert.deepEqual(
    [...result.result.metadata.artifactFiles].sort(),
    [...SIX_STAGE_FILES, ...PLANNING_FILES].sort(),
  );
  assert.deepEqual(
    result.result.metadata.workflow.editableArtifactFiles.sort(),
    [...PLANNING_FILES].sort(),
  );
  assert.ok(!result.result.metadata.artifactFiles.includes(PLANNING_MANIFEST));
});


test("PRD runtime reads exactly Planning four plus PRD two and stays read-only", async (t) => {
  const root = await temporaryProject(t);
  await installPolicy(root);
  await writePlanningBundle(root);
  await writeProjectFile(root, PRD_FILES[0], "# PRD\n");
  await writeProjectFile(root, PRD_FILES[1], `${JSON.stringify({
    schema_version: "prd_contract.acceptance.v1",
    stage_id: "40-prd-contract",
    status: "verified",
    prd_hash: `sha256:${"0".repeat(64)}`,
    items: [{ sr_id: "SR-1", acceptance_refs: ["AC_ONE_OK"] }],
  }, null, 2)}\n`);
  await writeProjectFile(
    root,
    "VeriPilotWorkspace/guarded-current/stages/40-prd-contract/deliverables/traceability.json",
    "{}\n",
  );
  await writeProjectFile(root, PRD_PROTOCOL_FILES[0], "{}\n");
  await writeProjectFile(root, PRD_PROTOCOL_FILES[1], "{}\n");

  const result = await checkArtifact({
    cwd: root,
    pluginRoot: PLUGIN_ROOT,
    filePath: PRD_FILES[0],
    deferPersistence: true,
  });
  assert.deepEqual(
    [...result.result.metadata.artifactFiles].sort(),
    [...PLANNING_FILES, ...PRD_FILES].sort(),
  );
  assert.deepEqual(result.result.metadata.workflow.editableArtifactFiles, []);
});


test("Build QA protocol gate distinguishes every full-path envelope", async (t) => {
  const root = await temporaryProject(t);
  await installPolicy(root);
  const controls = [
    ".workflow/current/gates/85-planning-fidelity-gate.md",
    ".workflow/current/gates/95-prd-deliverables-gate.md",
  ];
  for (const relativePath of controls) {
    await writeProjectFile(root, relativePath, gateMarkdown());
  }
  for (const relativePath of [PLANNING_MANIFEST, ...PRD_PROTOCOL_FILES]) {
    await writeProjectFile(root, relativePath, "{}\n");
  }
  const gatePath = ".workflow/current/gates/100-build-qa-handoff-gate.md";
  await writeProjectFile(root, gatePath, gateMarkdown());

  const complete = await checkArtifact({
    cwd: root,
    pluginRoot: PLUGIN_ROOT,
    filePath: gatePath,
    deferPersistence: true,
  });
  assert.equal(complete.result.status, "passed", JSON.stringify(complete.result.diagnostics));

  for (const relativePath of [PLANNING_MANIFEST, ...PRD_PROTOCOL_FILES]) {
    await fs.unlink(path.join(root, ...relativePath.split("/")));
    const incomplete = await checkArtifact({
      cwd: root,
      pluginRoot: PLUGIN_ROOT,
      filePath: gatePath,
      deferPersistence: true,
    });
    assert.equal(incomplete.result.status, "pending", relativePath);
    assert.ok(incomplete.result.diagnostics.some((diagnostic) => (
      diagnostic.ruleId === "BUILD-HANDOFF-GATE-REQUIRED-BUNDLE"
      && diagnostic.message.includes(relativePath)
    )));
    await writeProjectFile(root, relativePath, "{}\n");
  }
});


test("lossless carrier keeps indented source headings out of its own outline", async () => {
  const knowledge = await loadSimpleRules(path.join(POLICY_ROOT, "planning-source.rules.yaml"));
  const snapshots = Array.from({ length: 6 }, (_, index) => [
    `<!-- snapshot:begin source-${index + 1} snapshot-encoding=indent4-v1 newline=lf terminal-newline=true -->`,
    `    # Source ${index + 1}`,
    "",
    "    ## 文档目标",
    `    目标 ${index + 1}`,
    `<!-- snapshot:end source-${index + 1} -->`,
  ].join("\n")).join("\n\n");
  const content = `# Planning source

## 文档目标

无损承载六阶段来源。

## 来源索引

六个来源均记录路径、字节数、换行状态和 SHA-256。

## 功能意图与范围

保持原始意图和范围。

## 约束与非目标

保持约束和非目标。

## 验收与证据

保持验收和证据。

## 代码事实

代码事实来自 code-understanding。

## 里程碑投影约束

每个 SR 只属于一个里程碑。

## 风险与开放问题

无。

## 原文快照

snapshot-encoding=indent4-v1

${snapshots}
`;
  const result = diagnoseArtifacts({
    artifacts: [{
      path: path.join(EXAMPLE_ROOT, "planning-source.md"),
      relativePath: "planning-source.md",
      content,
      isTrigger: true,
    }],
    knowledge,
    stage: "planning-source",
    artifactType: "planning-source",
    triggerFile: "planning-source.md",
  });
  assert.equal(result.status, "passed");
});


test("documentation and Skill state the no-Planning/no-IR boundary", async () => {
  const [doc, sixStageDoc, skill, openai] = await Promise.all([
    fs.readFile(path.join(PLUGIN_ROOT, "docs", "guarded-delivery-workflow-from-zero.md"), "utf8"),
    fs.readFile(path.join(PLUGIN_ROOT, "docs", "six-stage-workflow-from-zero.md"), "utf8"),
    fs.readFile(
      path.join(PLUGIN_ROOT, "examples", "veripilot-guarded-delivery", "run-guarded-delivery", "SKILL.md"),
      "utf8",
    ),
    fs.readFile(
      path.join(PLUGIN_ROOT, "examples", "veripilot-guarded-delivery", "run-guarded-delivery", "agents", "openai.yaml"),
      "utf8",
    ),
  ]);
  assert.match(doc, /不调用 Planning 插件，也不调用 IR 插件/);
  assert.match(doc, /veripilot\.delivery_manifest\.v2/);
  assert.match(doc, /Workflow 共 18 个 Stage/);
  assert.match(sixStageDoc, /guarded-delivery-workflow-from-zero\.md/);
  assert.match(skill, /Never invoke `\/planning:\*`/);
  assert.match(skill, /Do not write anything under `stages\/20-planning`/);
  assert.match(skill, /Run PRD Contract in auto mode/);
  assert.match(skill, /run Build QA in auto mode/);
  assert.match(openai, /\$run-guarded-delivery/);
});
