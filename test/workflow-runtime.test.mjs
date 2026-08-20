import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  checkArtifact,
  finalizeArtifactCheck,
} from "../lib/runtime-corrector.mjs";
import { validateResultDiffs } from "../lib/result-processing.mjs";
import { createUnifiedDiff } from "../lib/unified-diff.mjs";


const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");


async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-corrector-workflow-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}


async function writeFile(root, relativePath, content) {
  const filePath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
  return filePath;
}


async function createProject(t, {
  edges = `
    - from: source-a
      to: target
      review:
        enabled: true
        criteria: a-to-target.reviewer.md
    - from: source-b
      to: target
      review:
        enabled: true
`,
  enabledStages = ["source-a", "source-b", "target"],
  targetRules = "empty.rules.yaml",
  persist = false,
} = {}) {
  const cwd = await workspace(t);
  await writeFile(cwd, ".runtime-corrector/config.yaml", `version: 1
enabledStages:
${enabledStages.map((stage) => `  - ${stage}`).join("\n")}
artifacts:
  - name: source-a
    stage: source-a
    patterns:
      - docs/a.md
    rules:
      enabled: true
      file: empty.rules.yaml
  - name: source-b
    stage: source-b
    patterns:
      - docs/b.md
    rules:
      enabled: true
      file: empty.rules.yaml
  - name: target
    stage: target
    patterns:
      - docs/target.md
    rules:
      enabled: true
      file: ${targetRules}
    review:
      enabled: true
workflow:
  edges:
${edges}
output:
  persist: ${persist}
  mode: centralized
  directory: .runtime-correction
`);
  await writeFile(cwd, ".runtime-corrector/empty.rules.yaml", "version: 1\nrules: []\n");
  await writeFile(
    cwd,
    ".runtime-corrector/a-to-target.reviewer.md",
    "# A to target\n\nKeep every A decision traceable.\n",
  );
  return cwd;
}


test("explicitly disabled node and edge checks load no policy files and request no semantic fork", async (t) => {
  const cwd = await workspace(t);
  await writeFile(cwd, ".runtime-corrector/config.yaml", `version: 1
artifacts:
  - name: source
    stage: source
    patterns:
      - docs/source.md
  - name: target
    stage: target
    patterns:
      - docs/target.md
    rules:
      enabled: false
      file: missing.rules.yaml
    review:
      enabled: false
      criteria: missing.reviewer.md
workflow:
  edges:
    - from: source
      to: target
      review:
        enabled: false
        criteria: missing-edge.reviewer.md
output:
  persist: false
`);
  await writeFile(cwd, "docs/target.md", "# Target\n\nbad\n");

  const prepared = await checkArtifact({
    cwd,
    pluginRoot: PLUGIN_ROOT,
    filePath: "docs/target.md",
    deferPersistence: true,
  });

  assert.equal(prepared.result.status, "passed");
  assert.deepEqual(prepared.result.diagnostics, []);
  assert.equal(Object.hasOwn(prepared.result, "agentReview"), false);
  assert.equal(Object.hasOwn(prepared.result.metadata, "workflow"), false);
  assert.equal(prepared.reviewContext.enabled, false);
  assert.equal(prepared.reviewContext.nodeReviewEnabled, false);
});


test("current node combines direct incoming edges in YAML order and keeps sources read-only", async (t) => {
  const cwd = await createProject(t, { persist: true });
  await writeFile(cwd, "docs/a.md", "# Source A\n\nDecision A.\n");
  await writeFile(cwd, "docs/b.md", "# Source B\n\nConstraint B.\n");
  await writeFile(cwd, "docs/target.md", "# Target\n\nUses A and B.\n");

  const outcome = await checkArtifact({
    cwd,
    pluginRoot: PLUGIN_ROOT,
    filePath: "docs/target.md",
  });

  assert.equal(outcome.result.status, "passed");
  assert.deepEqual(outcome.result.metadata.artifactFiles, [
    "docs/target.md",
    "docs/a.md",
    "docs/b.md",
  ]);
  assert.deepEqual(outcome.result.metadata.workflow, {
    nodeId: "target",
    editableArtifactFiles: ["docs/target.md"],
    incomingEdges: [
      {
        id: "source-a->target",
        from: "source-a",
        to: "target",
        status: "ready",
        sourceFiles: ["docs/a.md"],
      },
      {
        id: "source-b->target",
        from: "source-b",
        to: "target",
        status: "ready",
        sourceFiles: ["docs/b.md"],
      },
    ],
  });
  assert.equal(outcome.result.agentReview.status, "requested");
  assert.match(outcome.feedback, /Workflow 入边内置一致性基线/);
  assert.deepEqual(
    outcome.result.agentReview.edges.map(({ from, to, status, reviewer }) => ({
      from,
      to,
      status,
      reviewer: reviewer?.path ?? null,
    })),
    [
      {
        from: "source-a",
        to: "target",
        status: "ready",
        reviewer: ".runtime-corrector/a-to-target.reviewer.md",
      },
      {
        from: "source-b",
        to: "target",
        status: "ready",
        reviewer: null,
      },
    ],
  );
  const diagnosticPath = outcome.writtenFiles.find(
    (filePath) => filePath.endsWith("diagnostic.md"),
  );
  const diagnostic = await fs.readFile(
    diagnosticPath,
    "utf8",
  );
  assert.ok(diagnosticPath);
  assert.match(diagnostic, /Workflow node: `target`/);
  assert.match(diagnostic, /`source-a -> target \(ready\)`/);
});


test("missing sources append pending diagnostics after node diagnostics and errors keep priority", async (t) => {
  const cwd = await createProject(t, { targetRules: "target.rules.yaml" });
  await writeFile(cwd, ".runtime-corrector/target.rules.yaml", `version: 1
rules:
  - id: TARGET-BAD
    type: forbid-text
    text: bad
`);
  await writeFile(cwd, "docs/a.md", "# Source A\n");
  await writeFile(cwd, "docs/target.md", "# Target\n\nbad\n");

  const outcome = await checkArtifact({
    cwd,
    pluginRoot: PLUGIN_ROOT,
    filePath: "docs/target.md",
  });

  assert.equal(outcome.result.status, "failed");
  assert.equal(outcome.result.metadata.bundleComplete, false);
  assert.deepEqual(
    outcome.result.diagnostics.map((diagnostic) => diagnostic.ruleId),
    ["TARGET-BAD", "WORKFLOW-EDGE-SOURCE-MISSING"],
  );
  assert.equal(outcome.result.metadata.workflow.incomingEdges[1].status, "pending");
  assert.deepEqual(outcome.result.metadata.workflow.incomingEdges[1].sourceFiles, []);
});


test("workflow-only sources cannot become target deterministic correction paths", async (t) => {
  const cwd = await createProject(t, { targetRules: "target.rules.yaml" });
  await writeFile(cwd, ".runtime-corrector/target.rules.yaml", `version: 1
rules:
  - id: TARGET-BAD
    type: forbid-text
    text: bad
`);
  await writeFile(cwd, "docs/a.md", "# Source A\n\nbad\n");
  await writeFile(cwd, "docs/b.md", "# Source B\n");
  await writeFile(cwd, "docs/target.md", "# Target\n\nclean\n");

  const outcome = await checkArtifact({
    cwd,
    pluginRoot: PLUGIN_ROOT,
    filePath: "docs/target.md",
  });

  assert.equal(outcome.result.status, "passed");
  assert.deepEqual(outcome.result.diagnostics, []);
  assert.deepEqual(outcome.result.metadata.artifactFiles, [
    "docs/target.md",
    "docs/a.md",
    "docs/b.md",
  ]);
});


test("overlapping source patterns cannot turn the target into source evidence", async (t) => {
  const cwd = await workspace(t);
  await writeFile(cwd, ".runtime-corrector/config.yaml", `version: 1
artifacts:
  - name: target
    stage: target
    patterns:
      - docs/target.md
    rules:
      enabled: true
      file: empty.rules.yaml
  - name: source
    stage: source
    patterns:
      - docs/*.md
    rules:
      enabled: true
      file: empty.rules.yaml
workflow:
  edges:
    - from: source
      to: target
      review:
        enabled: true
output:
  persist: false
`);
  await writeFile(cwd, ".runtime-corrector/empty.rules.yaml", "version: 1\nrules: []\n");
  await writeFile(cwd, "docs/target.md", "# Target\n");

  const outcome = await checkArtifact({
    cwd,
    pluginRoot: PLUGIN_ROOT,
    filePath: "docs/target.md",
  });

  assert.equal(outcome.result.status, "pending");
  assert.deepEqual(outcome.result.metadata.workflow.editableArtifactFiles, ["docs/target.md"]);
  assert.deepEqual(outcome.result.metadata.workflow.incomingEdges[0].sourceFiles, []);
  assert.equal(outcome.result.diagnostics[0].ruleId, "WORKFLOW-EDGE-SOURCE-MISSING");
});


test("first-match ownership keeps related source files read-only", async (t) => {
  const cwd = await workspace(t);
  await writeFile(cwd, ".runtime-corrector/config.yaml", `version: 1
artifacts:
  - name: source
    stage: source
    patterns:
      - docs/source.md
    rules:
      enabled: true
      file: empty.rules.yaml
  - name: target
    stage: target
    patterns:
      - docs/*.md
    relatedPatterns:
      - docs/source.md
    relatedRoot: project
    rules:
      enabled: true
      file: target.rules.yaml
workflow:
  edges:
    - from: source
      to: target
      review:
        enabled: true
output:
  persist: false
`);
  await writeFile(cwd, ".runtime-corrector/empty.rules.yaml", "version: 1\nrules: []\n");
  await writeFile(cwd, ".runtime-corrector/target.rules.yaml", `version: 1
rules:
  - id: TARGET-BUNDLE
    type: require-artifacts
    artifacts:
      - target.md
      - source.md
  - id: TARGET-BAD
    type: forbid-text
    text: bad
`);
  await writeFile(cwd, "docs/source.md", "# Source\n\nbad\n");
  await writeFile(cwd, "docs/target.md", "# Target\n\nclean\n");

  const outcome = await checkArtifact({
    cwd,
    pluginRoot: PLUGIN_ROOT,
    filePath: "docs/target.md",
  });

  assert.equal(outcome.result.status, "passed");
  assert.deepEqual(outcome.result.diagnostics, []);
  assert.deepEqual(outcome.result.metadata.workflow.editableArtifactFiles, ["docs/target.md"]);
  assert.deepEqual(
    outcome.result.metadata.workflow.incomingEdges[0].sourceFiles,
    ["docs/source.md"],
  );
});


test("exact related paths are collected even after unrelated files exceed the scan budget", async (t) => {
  const cwd = await workspace(t);
  await writeFile(cwd, ".runtime-corrector/config.yaml", `version: 1
enabledStages:
  - exact-bundle
artifacts:
  - name: exact-bundle
    stage: exact-bundle
    patterns:
      - z-target/target.md
    relatedPatterns:
      - z-source/source.md
    relatedRoot: project
    rules:
      enabled: true
      file: empty.rules.yaml
    review:
      enabled: false
limits:
  maxRelatedFiles: 2
output:
  persist: false
`);
  await writeFile(cwd, ".runtime-corrector/empty.rules.yaml", "version: 1\nrules: []\n");
  for (let index = 0; index < 16; index += 1) {
    await writeFile(cwd, `a-noise/noise-${String(index).padStart(2, "0")}.md`, "noise\n");
  }
  await writeFile(cwd, "z-source/source.md", "# Source\n");
  await writeFile(cwd, "z-target/target.md", "# Target\n");

  const prepared = await checkArtifact({
    cwd,
    pluginRoot: PLUGIN_ROOT,
    filePath: "z-target/target.md",
    deferPersistence: true,
  });
  assert.deepEqual(prepared.result.metadata.artifactFiles, [
    "z-target/target.md",
    "z-source/source.md",
  ]);
});


test("workflow checks only direct incoming edges and disabled sources remain readable", async (t) => {
  const cwd = await createProject(t, {
    enabledStages: ["target"],
    edges: `
    - from: source-a
      to: source-b
      review:
        enabled: true
    - from: source-b
      to: target
      review:
        enabled: true
`,
  });
  await writeFile(cwd, "docs/a.md", "# Source A\n");
  await writeFile(cwd, "docs/b.md", "# Source B\n");
  await writeFile(cwd, "docs/target.md", "# Target\n");

  const target = await checkArtifact({
    cwd,
    pluginRoot: PLUGIN_ROOT,
    filePath: "docs/target.md",
  });
  assert.equal(target.matched, true);
  assert.deepEqual(target.result.metadata.artifactFiles, ["docs/target.md", "docs/b.md"]);
  assert.deepEqual(
    target.result.metadata.workflow.incomingEdges.map((edge) => edge.id),
    ["source-b->target"],
  );

  const disabledSource = await checkArtifact({
    cwd,
    pluginRoot: PLUGIN_ROOT,
    filePath: "docs/b.md",
  });
  assert.deepEqual(disabledSource, { matched: false, reason: "unmatched-artifact" });
});


test("a disabled target does not trigger its node or incoming edges", async (t) => {
  const cwd = await createProject(t, {
    enabledStages: ["source-a", "source-b"],
  });
  await writeFile(cwd, "docs/a.md", "# Source A\n");
  await writeFile(cwd, "docs/b.md", "# Source B\n");
  await writeFile(cwd, "docs/target.md", "# Target\n");

  assert.deepEqual(
    await checkArtifact({
      cwd,
      pluginRoot: PLUGIN_ROOT,
      filePath: "docs/target.md",
    }),
    { matched: false, reason: "unmatched-artifact" },
  );
});


test("spec and explain expose configured incoming edges without a new command", async (t) => {
  const cwd = await createProject(t);
  const cli = path.join(PLUGIN_ROOT, "scripts", "cli.mjs");
  const specification = JSON.parse(execFileSync(
    process.execPath,
    [cli, "spec", "target", "--cwd", cwd, "--format", "json"],
    { encoding: "utf8" },
  ));
  assert.equal(specification.criteria[0].workflow.nodeId, "target");
  assert.deepEqual(
    specification.criteria[0].workflow.incomingEdges.map((edge) => edge.from),
    ["source-a", "source-b"],
  );
  assert.equal(specification.criteria[0].workflow.incomingEdges[1].reviewer, null);
  assert.match(specification.criteria[0].workflow.baseline, /无依据扩张/);

  const explanation = JSON.parse(execFileSync(
    process.execPath,
    [cli, "explain", "target", "--cwd", cwd, "--format", "json"],
    { encoding: "utf8" },
  ));
  assert.equal(explanation.artifacts[0].workflow.nodeId, "target");
  assert.deepEqual(
    explanation.artifacts[0].workflow.incomingEdges.map((edge) => edge.to),
    ["target", "target"],
  );
  assert.ok(explanation.mechanism.includes("review configured direct incoming workflow edges"));
});


test("the final patch gate rejects deterministic patches outside the target whitelist", async (t) => {
  const cwd = await workspace(t);
  await writeFile(cwd, "docs/source.md", "before\n");
  await writeFile(cwd, "docs/target.md", "target\n");
  const result = {
    status: "passed",
    diagnostics: [],
    diffs: [{ path: "docs/source.md" }],
    metadata: {
      triggerFile: "docs/target.md",
    },
  };
  validateResultDiffs(result, cwd, ["docs/target.md"]);
  assert.equal(result.status, "failed");
  assert.deepEqual(result.diffs, []);
  assert.equal(result.diagnostics[0].ruleId, "RUNTIME-PATCH-VALIDATION-FAILED");
  assert.match(result.diagnostics[0].evidence[0], /不在当前节点可编辑文件/);

  const disguisedSourcePatch = createUnifiedDiff({
    relativePath: "docs/source.md",
    original: "before\n",
    proposed: "after\n",
  });
  disguisedSourcePatch.path = "docs/target.md";
  const disguised = {
    status: "passed",
    diagnostics: [],
    diffs: [disguisedSourcePatch],
    metadata: {
      triggerFile: "docs/target.md",
    },
  };
  validateResultDiffs(disguised, cwd, ["docs/target.md"]);
  assert.equal(disguised.status, "failed");
  assert.deepEqual(disguised.diffs, []);
  assert.match(disguised.diagnostics[0].evidence[0], /实际目标不一致/);

  const targetPatch = createUnifiedDiff({
    relativePath: "docs/target.md",
    original: "target\n",
    proposed: "changed target\n",
  });
  const sourcePatch = createUnifiedDiff({
    relativePath: "docs/source.md",
    original: "before\n",
    proposed: "changed source\n",
  });
  targetPatch.unifiedDiff = [
    targetPatch.unifiedDiff,
    sourcePatch.unifiedDiff.split("\n").slice(1).join("\n"),
  ].join("\n");
  const appended = {
    status: "passed",
    diagnostics: [],
    diffs: [targetPatch],
    metadata: {
      triggerFile: "docs/target.md",
    },
  };
  validateResultDiffs(appended, cwd, ["docs/target.md"]);
  assert.equal(appended.status, "failed");
  assert.deepEqual(appended.diffs, []);
  assert.match(appended.diagnostics[0].evidence[0], /实际目标不在当前节点可编辑文件/);
});


test("finalization fails closed when workflow editability metadata is missing", async (t) => {
  const cwd = await createProject(t);
  await writeFile(cwd, "docs/a.md", "# Source A\n");
  await writeFile(cwd, "docs/b.md", "# Source B\n");
  await writeFile(cwd, "docs/target.md", "# Target\n");
  const prepared = await checkArtifact({
    cwd,
    pluginRoot: PLUGIN_ROOT,
    filePath: "docs/target.md",
    deferPersistence: true,
  });
  prepared.result.diffs = [createUnifiedDiff({
    relativePath: "docs/target.md",
    original: "# Target\n",
    proposed: "# Changed Target\n",
  })];
  delete prepared.finalizeContext.editableArtifactFiles;

  const outcome = await finalizeArtifactCheck(prepared);

  assert.equal(outcome.result.status, "failed");
  assert.deepEqual(outcome.result.diffs, []);
  assert.equal(
    outcome.result.diagnostics.at(-1).ruleId,
    "RUNTIME-PATCH-VALIDATION-FAILED",
  );
});
