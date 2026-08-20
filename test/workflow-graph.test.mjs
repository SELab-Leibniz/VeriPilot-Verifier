import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  compileReviewGraph,
  EDGE_REVIEW_BASELINE,
  ReviewGraph,
} from "../lib/review-graph.mjs";
import { loadSimpleProjectConfig } from "../lib/simple-mode.mjs";


async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-corrector-workflow-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, ".runtime-corrector"), { recursive: true });
  return root;
}


async function writeConfig(root, contents) {
  const configPath = path.join(root, ".runtime-corrector", "config.yaml");
  await fs.writeFile(configPath, contents, "utf8");
  return configPath;
}


function artifacts(...nodeIds) {
  return nodeIds.map((nodeId) => ({ nodeId }));
}


test("empty workflow forms preserve the no-graph path and artifact name as nodeId", async (t) => {
  for (const [label, workflow] of [
    ["omitted", ""],
    ["null", "workflow: null\n"],
    ["empty edges", "workflow:\n  edges: []\n"],
  ]) {
    await t.test(label, async (t) => {
      const root = await workspace(t);
      await writeConfig(root, `version: 1
artifacts:
  - name: plan-node
    stage: planning
    type: planning-bundle
    patterns:
      - plan.md
${workflow}`);
      const config = await loadSimpleProjectConfig(root);
      assert.equal(config.artifacts[0].nodeId, "plan-node");
      assert.equal(config.artifacts[0].type, "planning-bundle");
      assert.equal(config.configuredArtifacts[0].nodeId, "plan-node");
      assert.equal(config.reviewGraph, null);
    });
  }
});


test("review graph keeps YAML edge order and returns only direct incoming edges", async (t) => {
  const root = await workspace(t);
  const policyRoot = path.join(root, ".runtime-corrector");
  await writeConfig(root, `version: 1
enabledStages:
  - selection
artifacts:
  - name: requirements
    stage: requirements
    patterns:
      - requirements.md
  - name: research
    stage: research
    patterns:
      - research.md
  - name: planning
    stage: planning
    patterns:
      - planning.md
  - name: selection
    stage: selection
    patterns:
      - selection.md
workflow:
  edges:
    - from: requirements
      to: planning
      review:
        enabled: true
    - from: research
      to: planning
      review:
        enabled: false
    - from: planning
      to: selection
      review:
        enabled: true
        criteria: planning-to-selection.md
    - from: requirements
      to: selection
      review:
        enabled: true
`);

  const config = await loadSimpleProjectConfig(root);
  const graph = config.reviewGraph;
  assert.ok(graph instanceof ReviewGraph);
  assert.deepEqual(config.artifacts.map(({ nodeId }) => nodeId), ["selection"]);
  assert.deepEqual(
    config.configuredArtifacts.map(({ nodeId }) => nodeId),
    ["requirements", "research", "planning", "selection"],
  );
  assert.deepEqual(
    graph.edges.map(({ from, to }) => [from, to]),
    [
      ["requirements", "planning"],
      ["research", "planning"],
      ["planning", "selection"],
      ["requirements", "selection"],
    ],
  );
  assert.deepEqual(
    graph.incomingEdges("planning").map(({ from }) => from),
    ["requirements", "research"],
  );
  assert.deepEqual(
    graph.incomingEdges("selection").map(({ from }) => from),
    ["planning", "requirements"],
  );
  assert.deepEqual(graph.incomingEdges("requirements"), []);
  assert.equal(graph.edges[0].reviewerFile, null);
  assert.equal(graph.edges[1].reviewerFile, null);
  assert.equal(
    graph.edges[2].reviewerFile,
    path.join(policyRoot, "planning-to-selection.md"),
  );
  assert.equal(graph.edges[3].reviewerFile, null);
});


test("artifact names need to be unique only when a non-empty graph is enabled", () => {
  const options = {
    artifacts: artifacts("same", "same"),
    policyRoot: path.resolve(".runtime-corrector"),
    configPath: path.resolve(".runtime-corrector/config.yaml"),
  };
  assert.equal(compileReviewGraph({ ...options, workflow: null }), null);
  assert.equal(compileReviewGraph({ ...options, workflow: { edges: [] } }), null);
  assert.throws(
    () => compileReviewGraph({
      ...options,
      workflow: { edges: [{ from: "same", to: "other" }] },
    }),
    /artifacts\[\]\.name.*不能重复/,
  );
});


test("workflow and edge objects reject unknown fields", () => {
  const options = {
    artifacts: artifacts("source", "target"),
    policyRoot: path.resolve(".runtime-corrector"),
    configPath: path.resolve(".runtime-corrector/config.yaml"),
  };
  assert.throws(
    () => compileReviewGraph({
      ...options,
      workflow: { edges: [], mode: "cascade" },
    }),
    /workflow 包含未知字段：mode/,
  );
  assert.throws(
    () => compileReviewGraph({
      ...options,
      workflow: {
        edges: [{
          from: "source",
          to: "target",
          review: { enabled: true },
          rules: "edge.rules.yaml",
        }],
      },
    }),
    /edges\[0\] 包含未知字段：rules/,
  );
});


test("workflow validates edge shape, endpoints, self-loops, and duplicates", () => {
  const options = {
    artifacts: artifacts("source", "target"),
    policyRoot: path.resolve(".runtime-corrector"),
    configPath: path.resolve(".runtime-corrector/config.yaml"),
  };
  const cases = [
    {
      workflow: {},
      error: /workflow\.edges 必须是列表/,
    },
    {
      workflow: { edges: null },
      error: /workflow\.edges 必须是列表/,
    },
    {
      workflow: { edges: ["source-to-target"] },
      error: /edges\[0\] 必须是对象/,
    },
    {
      workflow: { edges: [{ to: "target" }] },
      error: /edges\[0\]\.from 必须是非空字符串/,
    },
    {
      workflow: { edges: [{ from: "source" }] },
      error: /edges\[0\]\.to 必须是非空字符串/,
    },
    {
      workflow: { edges: [{ from: "unknown", to: "target" }] },
      error: /\.from 引用了未知 artifact/,
    },
    {
      workflow: { edges: [{ from: "source", to: "unknown" }] },
      error: /\.to 引用了未知 artifact/,
    },
    {
      workflow: { edges: [{ from: "source", to: "source" }] },
      error: /不能连接 artifact 自身/,
    },
    {
      workflow: {
        edges: [
          { from: "source", to: "target", review: { enabled: true } },
          { from: "source", to: "target", review: { enabled: false } },
        ],
      },
      error: /不能包含重复边/,
    },
  ];

  for (const { workflow, error } of cases) {
    assert.throws(() => compileReviewGraph({ ...options, workflow }), error);
  }
});


test("workflow rejects cycles across multiple nodes", () => {
  assert.throws(
    () => compileReviewGraph({
      workflow: {
        edges: [
          { from: "a", to: "b", review: { enabled: true } },
          { from: "b", to: "c", review: { enabled: true } },
          { from: "c", to: "a", review: { enabled: true } },
        ],
      },
      artifacts: artifacts("a", "b", "c", "unconnected"),
      policyRoot: path.resolve(".runtime-corrector"),
      configPath: path.resolve(".runtime-corrector/config.yaml"),
    }),
    /必须是有向无环图，不能包含环/,
  );
});


test("edge review uses an explicit switch and keeps criteria paths inside policy root", async (t) => {
  const root = await workspace(t);
  const policyRoot = path.join(root, ".runtime-corrector");
  const options = {
    artifacts: artifacts("source", "target"),
    policyRoot,
    configPath: path.join(policyRoot, "config.yaml"),
  };
  const enabled = compileReviewGraph({
    ...options,
    workflow: {
      edges: [{ from: "source", to: "target", review: { enabled: true } }],
    },
  });
  assert.equal(enabled.edges[0].reviewEnabled, true);
  assert.equal(enabled.edges[0].reviewerFile, null);
  const disabled = compileReviewGraph({
    ...options,
    workflow: {
      edges: [{ from: "source", to: "target", review: { enabled: false } }],
    },
  });
  assert.equal(disabled.edges[0].reviewEnabled, false);
  assert.throws(
    () => compileReviewGraph({
      ...options,
      workflow: {
        edges: [{
          from: "source",
          to: "target",
          review: { enabled: true, criteria: "../outside.md" },
        }],
      },
    }),
    /不能指向 \.runtime-corrector 目录之外/,
  );
  assert.throws(
    () => compileReviewGraph({
      ...options,
      workflow: {
        edges: [{
          from: "source",
          to: "target",
          review: { enabled: true, criteria: path.resolve("outside.md") },
        }],
      },
    }),
    /必须使用相对于 \.runtime-corrector 的路径/,
  );
  assert.throws(
    () => compileReviewGraph({
      ...options,
      workflow: {
        edges: [{
          from: "source",
          to: "target",
          review: { enabled: true, criteria: 42 },
        }],
      },
    }),
    /criteria 必须是相对路径或 null/,
  );
  assert.throws(
    () => compileReviewGraph({
      ...options,
      workflow: { edges: [{ from: "source", to: "target" }] },
    }),
    /review 必须是包含 enabled 的对象/,
  );
});


test("the reusable edge baseline states the complete consistency contract", () => {
  assert.match(
    EDGE_REVIEW_BASELINE,
    /不得违背、遗漏或无依据扩张上游产物的意图、范围、约束、决策与可追溯标识/,
  );
});
