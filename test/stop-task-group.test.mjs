import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { ensureTask, taskDirectory } from "../lib/runtime-v2/task-store.mjs";
import { runStopTaskGroup } from "../lib/runtime-v2/stop-task-group.mjs";
import { observedTaskResult } from "./helpers/observed-review.mjs";
import { sha256 } from "../lib/runtime-v2/utils.mjs";

async function fixture(t) {
  const parent = path.resolve(".runtime-correction/test-temp");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, "task-group-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const task = await ensureTask({ projectRoot: root, sessionId: "group-session" });
  const bytes = Buffer.from("def convert(value): return int(value)\n");
  await fs.writeFile(path.join(root, "app.py"), bytes);
  const objects = ["A", "B"].map(id => ({ objectId: `M16:${id}`, sourceId: id, sourceRevisionId: `${id}@1`, metricId: "M16",
    description: `Original implementation obligation ${id}`, applicabilityKind: "CURRENT_TASK", applicability: "CURRENT_TASK", authority: "USER_EXPLICIT", verificationTarget: "IMPLEMENTATION" }));
  const truth = { taskId: task.taskId, version: 1, claims: objects.map(object => ({ claimId: object.sourceId, revisionId: object.sourceRevisionId,
    text: object.description, status: "ACTIVE", authority: "USER_EXPLICIT", severity: "HARD", verificationTarget: "IMPLEMENTATION" })) };
  const groundTruthPath = path.join(taskDirectory(root, task.taskId), "ground-truth/current.json");
  await fs.mkdir(path.dirname(groundTruthPath), { recursive: true });
  await fs.writeFile(groundTruthPath, JSON.stringify(truth));
  return { root, objects, input: { projectRoot: root, taskId: task.taskId, role: "stop-reviewer", deadlineAt: Date.now() + 10000,
    reviewer: { timeoutMs: 10000 }, evidence: { groundTruth: truth, snapshot: { entries: [] } }, request: {
      groundTruthPath, population: { metrics: { M16: objects } }, sourceManifest: [{ path: "app.py", sha256: sha256(bytes) }],
      fixedStopClassification: { stopClassification: "TASK_COMPLETE", stage: null }, reviewScope: { kind: "stop-group", objectIds: objects.map(object => object.objectId) } } } };
}

test("Stop SDK group shares source once and maps each original member's independent proof and receipt", async t => {
  const f = await fixture(t), receipts = [];
  f.input.reviewer.maxOutputTokens = 49152;
  let launches = 0;
  const result = await runStopTaskGroup({ ...f.input, onItemResult: async handle => {
    receipts.push(handle.result.metricObjectJudgements[0].objectId);
    for (const citation of handle.sourceCitations) await fs.access(citation.snapshotPath);
    return { saved: true, id: receipts.at(-1) };
  } }, { runTask: async options => {
    launches++;
    assert.equal(options.maxTokens, 49152);
    assert.equal(options.tasks.length, 2);
    const projectFiles = await fs.readdir(path.join(options.root, "project"));
    assert.deepEqual(projectFiles, ["app.py"]);
    for (const task of [...options.tasks].reverse()) {
      const result = await observedTaskResult({ ...options, task }, { file: "project/app.py", verdict: task.id.endsWith("A") ? "DEVIATION" : "PASS" });
      await options.onItemResult(result);
    }
    return { completed: true };
  } });
  assert.equal(launches, 1);
  assert.deepEqual(receipts, ["M16:B", "M16:A"]);
  assert.equal(result.result.metricObjectJudgements.length, 2);
  assert.equal(result.result.metricObjectJudgements.find(row => row.objectId === "M16:A").judgement, "DEVIATION");
  assert.equal(result.result.metricObjectJudgements.find(row => row.objectId === "M16:B").judgement, "PASS");
});

test("a group backend failure after the first plugin receipt retains that item and launches no replacement agent", async t => {
  const f = await fixture(t), receipts = [];
  let launches = 0;
  await assert.rejects(runStopTaskGroup({ ...f.input, onItemResult: async handle => { receipts.push(handle); return { saved: true }; } },
    { runTask: async options => {
      launches++;
      await options.onItemResult(await observedTaskResult({ ...options, task: options.tasks[0] }, { file: "project/app.py", verdict: "DEVIATION" }));
      throw new Error("Controlled backend crash");
    } }), /Controlled backend crash/);
  assert.equal(launches, 1);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].result.metricObjectJudgements[0].judgement, "DEVIATION");
});
