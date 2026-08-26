import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { compileRuntimeV2Config } from "../lib/runtime-v2/config.mjs";
import {
  familyIdForFinding,
  loopBoundedFamilyIds,
  recordDeviationFindings,
} from "../lib/runtime-v2/deviations.mjs";
import { ensureTask, taskStatePath } from "../lib/runtime-v2/task-store.mjs";


async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loop-bound-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

const FINDING = Object.freeze({
  deviationKey: "artifact:AGENT-TRACE-REF:spec/requirements.md",
  rootCauseId: "REQUIREMENT_OMITTED",
  severity: "error",
  reason: "Traceability reference missing.",
  expectedConstraint: "Every AR must cite a CR.",
  violatedGroundTruthIds: ["AR-001"],
});

async function record(root, taskId, { delivered, bound }) {
  return recordDeviationFindings({
    projectRoot: root,
    taskId,
    pipeline: "ARTIFACT",
    findings: [FINDING],
    groundTruthVersion: 1,
    delivered,
    maxDeliveriesPerFamily: bound,
  });
}

async function familyOf(root, taskId) {
  const state = JSON.parse(await fs.readFile(taskStatePath(root, taskId), "utf8"));
  return Object.values(state.deviations)[0];
}

test("the default loop bound is 5 and absent config means unbounded", () => {
  assert.equal(compileRuntimeV2Config({ version: 2 }).deviationLoop.maxDeliveriesPerFamily, 5);
  assert.equal(
    compileRuntimeV2Config({ version: 2, deviationLoop: { maxDeliveriesPerFamily: 2 } })
      .deviationLoop.maxDeliveriesPerFamily,
    2,
  );
  // 0 disables the bound entirely (loopBoundedFamilyIds treats <=0 as off).
  assert.equal(
    compileRuntimeV2Config({ version: 2, deviationLoop: { maxDeliveriesPerFamily: 0 } })
      .deviationLoop.maxDeliveriesPerFamily,
    0,
  );
});

test("a family stops being delivered after the bound, but keeps being observed", async (t) => {
  const root = await workspace(t);
  const { taskId } = await ensureTask({ projectRoot: root, sessionId: "loop-bound" });

  for (let round = 0; round < 5; round += 1) {
    await record(root, taskId, { delivered: true, bound: 5 });
  }
  let family = await familyOf(root, taskId);
  assert.equal(family.observations.length, 5, "five rounds recorded");
  assert.equal(family.observations.filter((o) => o.delivered).length, 5, "all five spoken");
  assert.notEqual(family.loopBounded, true, "not parked while still within budget");

  // Round six: recorded, but NOT delivered.
  await record(root, taskId, { delivered: true, bound: 5 });
  family = await familyOf(root, taskId);
  assert.equal(family.observations.length, 6, "observation still recorded");
  assert.equal(family.observations.filter((o) => o.delivered).length, 5, "no sixth delivery");
  assert.equal(family.observations.at(-1).suppressedBy, "LOOP_BOUND");
  assert.equal(family.loopBounded, true);
  assert.ok(family.loopBoundedAt, "park timestamp stamped");
  // Parking must NOT resolve the deviation: it is still open and still counts.
  assert.equal(family.status, "OPEN");

  const bounded = await loopBoundedFamilyIds({ projectRoot: root, taskId, maxDeliveries: 5 });
  assert.ok(bounded.has(familyIdForFinding({ taskId, finding: FINDING })));
});

test("undelivered observations do not consume the budget", async (t) => {
  const root = await workspace(t);
  const { taskId } = await ensureTask({ projectRoot: root, sessionId: "shadow-arm" });
  // Shadow mode: recorded but never spoken, ten times over.
  for (let round = 0; round < 10; round += 1) {
    await record(root, taskId, { delivered: false, bound: 5 });
  }
  const family = await familyOf(root, taskId);
  assert.equal(family.observations.length, 10);
  assert.notEqual(family.loopBounded, true, "a silent arm must never park");
  const bounded = await loopBoundedFamilyIds({ projectRoot: root, taskId, maxDeliveries: 5 });
  assert.equal(bounded.size, 0, "control arm is untouched by the bound");
});

test("bound of 0/null leaves delivery unbounded", async (t) => {
  const root = await workspace(t);
  const { taskId } = await ensureTask({ projectRoot: root, sessionId: "unbounded" });
  for (let round = 0; round < 8; round += 1) {
    await record(root, taskId, { delivered: true, bound: null });
  }
  const family = await familyOf(root, taskId);
  assert.equal(family.observations.filter((o) => o.delivered).length, 8);
  assert.notEqual(family.loopBounded, true);
  assert.equal((await loopBoundedFamilyIds({ projectRoot: root, taskId, maxDeliveries: 0 })).size, 0);
});

test("a FIXED family is never parked and never blocks re-delivery", async (t) => {
  const root = await workspace(t);
  const { taskId } = await ensureTask({ projectRoot: root, sessionId: "reopen" });
  for (let round = 0; round < 6; round += 1) {
    await record(root, taskId, { delivered: true, bound: 5 });
  }
  // Simulate closure, then a regression of the same family.
  const statePath = taskStatePath(root, taskId);
  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  Object.values(state.deviations)[0].status = "FIXED";
  await fs.writeFile(statePath, JSON.stringify(state));
  const bounded = await loopBoundedFamilyIds({ projectRoot: root, taskId, maxDeliveries: 5 });
  assert.equal(bounded.size, 0, "a closed deviation must be speakable again if it regresses");
});
