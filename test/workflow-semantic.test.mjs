import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { generateCandidateDiffs } from "../lib/candidate-diff.mjs";
import { runSemanticReview } from "../lib/semantic-review.mjs";


const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");


async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-corrector-workflow-semantic-"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}


async function writeFile(root, relativePath, content) {
  const filePath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
  return filePath;
}


test("semantic review contract treats disk files as fresh snapshot authority", async () => {
  const skill = await fs.readFile(
    path.join(PLUGIN_ROOT, "skills", "semantic-review", "SKILL.md"),
    "utf8",
  );
  assert.match(skill, /never for the current artifact contents/);
  assert.match(skill, /ignore prior copies, findings, and edit plans/);
  assert.match(skill, /Immediately before returning, re-read every file named by a finding or edit/);
  assert.match(skill, /already-corrected prior snapshot/);
  assert.match(skill, /This structured response describes only the current snapshot/);
  assert.match(skill, /it is not an execution history/);
  assert.match(skill, /The parent Agent can read persisted diagnostics for history/);
});


function preparedReview(cwd, workflow) {
  return {
    projectRoot: cwd,
    result: {
      status: "passed",
      diagnostics: [],
      metadata: {
        roundId: "20260726T101112Z-a1b2c3d4",
        stage: "target-stage",
        artifactType: "target-contract",
        triggerFile: "target.md",
        artifactFiles: ["target.md", "source.md"],
        bundleComplete: true,
      },
    },
    reviewContext: {
      reviewer: null,
      specification: null,
      ...(workflow === undefined ? {} : { workflow }),
    },
  };
}


function workflowContext(overrides = {}) {
  return {
    nodeId: "target",
    targetFiles: ["target.md"],
    editableArtifactFiles: ["target.md"],
    incomingEdges: [{
      from: "source",
      to: "target",
      status: "available",
      sourceFiles: ["source.md"],
      targetFiles: ["target.md"],
      reviewer: null,
    }],
    ...overrides,
  };
}


test("workflow review is appended to the legacy request and uses one fork", async (t) => {
  const cwd = await workspace(t);
  await writeFile(cwd, "source.md", "Scope: alpha\n");
  await writeFile(cwd, "target.md", "Scope: beta\n");
  const workflow = workflowContext({
    instance: { changeName: "alpha" },
  });
  let invocationCount = 0;

  const review = await runSemanticReview({
    input: { session_id: "parent-session" },
    prepared: preparedReview(cwd, workflow),
    pluginRoot: PLUGIN_ROOT,
    invokeFork: async ({ prompt }) => {
      invocationCount += 1;
      const requestPath = prompt.match(/--request "([^"]+)"/)?.[1];
      const request = JSON.parse(await fs.readFile(requestPath, "utf8"));
      assert.equal(request.version, 1);
      assert.equal(request.stage, "target-stage");
      assert.equal(request.artifactType, "target-contract");
      assert.equal(request.triggerFile, "target.md");
      assert.deepEqual(request.artifactFiles, ["target.md", "source.md"]);
      assert.equal(request.bundleComplete, true);
      assert.equal(request.deterministicStatus, "passed");
      assert.deepEqual(request.deterministicDiagnostics, []);
      assert.equal(request.reviewer, null);
      assert.equal(request.specification, null);
      assert.deepEqual(request.workflow, workflow);
      assert.deepEqual(request.workflow.instance, { changeName: "alpha" });
      return {
        sessionId: "workflow-fork",
        review: {
          summary: "Target scope must align with its source.",
          findings: [{
            ruleId: "AGENT-EDGE-SOURCE-TO-TARGET-SCOPE",
            severity: "error",
            path: "target.md",
            line: 1,
            message: "Target scope contradicts the source.",
            evidence: ["source.md: Scope: alpha"],
          }],
          edits: [{
            target: "target.md",
            operations: [{
              type: "replace-line",
              line: 1,
              expect: "Scope: beta",
              replacement: "Scope: alpha",
            }],
          }],
        },
      };
    },
  });

  assert.equal(invocationCount, 1);
  assert.equal(review.status, "completed");
  assert.equal(review.forkSessionId, "workflow-fork");
  assert.deepEqual(review.diffs.map((item) => item.path), ["target.md"]);
  assert.match(review.diffs[0].unifiedDiff, /^\+Scope: alpha$/m);
  assert.equal(await fs.readFile(path.join(cwd, "target.md"), "utf8"), "Scope: beta\n");
});


test("workflow findings naming a read-only source artifact degrade to info", async (t) => {
  const cwd = await workspace(t);
  await writeFile(cwd, "source.md", "Scope: alpha\n");
  await writeFile(cwd, "target.md", "Scope: alpha\n");

  const review = await runSemanticReview({
    input: { session_id: "parent-session" },
    prepared: preparedReview(cwd, workflowContext()),
    invokeFork: async () => ({
      sessionId: "invalid-finding-fork",
      review: {
        summary: "Invalid upstream finding.",
        findings: [{
          ruleId: "AGENT-EDGE-SOURCE-TO-TARGET-SCOPE",
          severity: "error",
          path: "source.md",
          line: 1,
          message: "The source should be changed.",
          evidence: ["source.md: Scope: alpha"],
        }],
        edits: [],
      },
    }),
  });

  // AMEND-005: an off-list path is a real cross-artifact subject, not a
  // review failure. One stray finding voided every post-requirements review
  // in the sealed round-3 T1 run under the old throw.
  assert.equal(review.status, "completed");
  assert.equal(review.findings.length, 1);
  const degraded = review.findings[0];
  assert.equal(degraded.severity, "info");
  assert.equal(degraded.path, "target.md");
  assert.ok(degraded.evidence.some((item) => item.includes("source.md")));
  assert.deepEqual(review.diffs, []);
});


test("workflow edits cannot target a read-only source artifact", async (t) => {
  const cwd = await workspace(t);
  await writeFile(cwd, "source.md", "Scope: alpha\n");
  await writeFile(cwd, "target.md", "Scope: beta\n");

  const review = await runSemanticReview({
    input: { session_id: "parent-session" },
    prepared: preparedReview(cwd, workflowContext()),
    invokeFork: async () => ({
      sessionId: "invalid-edit-fork",
      review: {
        summary: "Finding is valid, but its edit points upstream.",
        findings: [{
          ruleId: "AGENT-EDGE-SOURCE-TO-TARGET-SCOPE",
          severity: "error",
          path: "target.md",
          line: 1,
          message: "Target scope contradicts the source.",
          evidence: ["source.md: Scope: alpha"],
        }],
        edits: [{
          target: "source.md",
          operations: [{
            type: "replace-line",
            line: 1,
            expect: "Scope: alpha",
            replacement: "Scope: beta",
          }],
        }],
      },
    }),
  });

  assert.equal(review.status, "failed");
  assert.match(review.error, /edit\.target 不在本轮可编辑产物列表中：source\.md/);
  assert.equal(review.findings[0].path, "target.md");
  assert.deepEqual(review.diffs, []);
  assert.equal(await fs.readFile(path.join(cwd, "source.md"), "utf8"), "Scope: alpha\n");
});


test("candidate diff generation gives an explicit editable whitelist precedence", async (t) => {
  const cwd = await workspace(t);
  await writeFile(cwd, "source.md", "Scope: alpha\n");
  await writeFile(cwd, "target.md", "Scope: beta\n");

  await assert.rejects(
    generateCandidateDiffs({
      cwd,
      artifactFiles: ["target.md", "source.md"],
      editableArtifactFiles: ["target.md"],
      edits: [{
        target: "source.md",
        operations: [{
          type: "replace-line",
          line: 1,
          expect: "Scope: alpha",
          replacement: "Scope: beta",
        }],
      }],
    }),
    /edit\.target 不在本轮可编辑产物列表中：source\.md/,
  );

  await assert.rejects(
    generateCandidateDiffs({
      cwd,
      artifactFiles: ["source.md"],
      editableArtifactFiles: undefined,
      edits: [{
        target: "source.md",
        operations: [{
          type: "replace-line",
          line: 1,
          expect: "Scope: alpha",
          replacement: "Scope: beta",
        }],
      }],
    }),
    /edit\.target 不在本轮可编辑产物列表中：source\.md/,
  );
});


test("read-only workflow targets may carry findings but cannot produce edits", async (t) => {
  const cwd = await workspace(t);
  await writeFile(cwd, "source.md", "Scope: alpha\n");
  await writeFile(cwd, "target.md", "Scope: beta\n");
  const workflow = workflowContext({ editableArtifactFiles: [] });

  const findingOnly = await runSemanticReview({
    input: { session_id: "parent-session" },
    prepared: preparedReview(cwd, workflow),
    pluginRoot: PLUGIN_ROOT,
    invokeFork: async () => ({
      sessionId: "fork-session",
      review: {
        summary: "Published target is inconsistent.",
        findings: [{
          ruleId: "AGENT-READ_ONLY_FINDING",
          severity: "error",
          path: "target.md",
          message: "The generated target differs from its source.",
          evidence: ["source=alpha", "target=beta"],
        }],
        edits: [],
      },
    }),
  });
  assert.equal(findingOnly.status, "completed");
  assert.equal(findingOnly.findings[0].path, "target.md");
  assert.deepEqual(findingOnly.diffs, []);

  const attemptedEdit = await runSemanticReview({
    input: { session_id: "parent-session" },
    prepared: preparedReview(cwd, workflow),
    pluginRoot: PLUGIN_ROOT,
    invokeFork: async () => ({
      sessionId: "fork-session",
      review: {
        summary: "Attempted generated-file edit.",
        findings: [],
        edits: [{
          target: "target.md",
          operations: [{
            type: "replace-line",
            line: 1,
            expect: "Scope: beta",
            replacement: "Scope: alpha",
          }],
        }],
      },
    }),
  });
  assert.equal(attemptedEdit.status, "failed");
  assert.match(attemptedEdit.error, /可编辑产物列表/);
  assert.deepEqual(attemptedEdit.diffs, []);
});


test("malformed workflow context never falls back to the readable artifact list", async (t) => {
  for (const workflow of [false, 0, ""]) {
    await t.test(JSON.stringify(workflow), async (t) => {
      const cwd = await workspace(t);
      await writeFile(cwd, "source.md", "Scope: alpha\n");
      await writeFile(cwd, "target.md", "Scope: beta\n");

      const review = await runSemanticReview({
        input: { session_id: "parent-session" },
        prepared: preparedReview(cwd, workflow),
        invokeFork: async () => ({
          sessionId: "malformed-workflow-fork",
          review: {
            summary: "Malformed workflow context.",
            findings: [],
            edits: [{
              target: "source.md",
              operations: [{
                type: "replace-line",
                line: 1,
                expect: "Scope: alpha",
                replacement: "Scope: beta",
              }],
            }],
          },
        }),
      });

      assert.equal(review.status, "failed");
      assert.match(review.error, /edit\.target 不在本轮可编辑产物列表中：source\.md/);
      assert.deepEqual(review.diffs, []);
    });
  }
});


test("requests without workflow retain the previous artifact-wide behavior", async (t) => {
  const cwd = await workspace(t);
  await writeFile(cwd, "source.md", "Scope: alpha\n");
  await writeFile(cwd, "target.md", "Scope: beta\n");

  const review = await runSemanticReview({
    input: { session_id: "parent-session" },
    prepared: preparedReview(cwd, null),
    invokeFork: async ({ prompt }) => {
      const requestPath = prompt.match(/--request "([^"]+)"/)?.[1];
      const request = JSON.parse(await fs.readFile(requestPath, "utf8"));
      assert.equal(Object.hasOwn(request, "workflow"), false);
      return {
        sessionId: "legacy-fork",
        review: {
          summary: "Legacy bundle review.",
          findings: [{
            ruleId: "AGENT-SOURCE-SCOPE",
            severity: "warning",
            path: "source.md",
            line: 1,
            message: "Legacy bundle finding.",
            evidence: ["Scope: alpha"],
          }],
          edits: [{
            target: "source.md",
            operations: [{
              type: "replace-line",
              line: 1,
              expect: "Scope: alpha",
              replacement: "Scope: beta",
            }],
          }],
        },
      };
    },
  });

  assert.equal(review.status, "completed");
  assert.deepEqual(review.diffs.map((item) => item.path), ["source.md"]);
});
