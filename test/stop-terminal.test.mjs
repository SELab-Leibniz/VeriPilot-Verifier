import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ensureTask, findTask, taskDirectory, withTaskState } from "../lib/runtime-v2/task-store.mjs";
import { settleIncompleteStop } from "../lib/openclaw/stop-terminal.mjs";

async function fixture(t) {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rc-stop-terminal-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  const task = await ensureTask({ projectRoot, sessionId: "terminal" });
  return { projectRoot, taskId: task.taskId, runId: "current-run", reasonCode: "REVIEW_DEADLINE_EXPIRED" };
}

test("deadline exposes saved progress and is idempotent while retaining the previous verdict", async t => {
  const f = await fixture(t), root = taskDirectory(f.projectRoot, f.taskId);
  const progressPath = path.join(root, "review-collections", "saved", "progress.json");
  await fs.mkdir(path.dirname(progressPath), { recursive: true });
  await fs.writeFile(progressPath, JSON.stringify({ startedAt: new Date().toISOString(), totalItems: 110, completedItems: 98, status: "CANCELLED" }));
  await withTaskState(f, task => { task.verification = { status: "DEVIATION", evaluationId: "prior" }; task.stop.correctionAttempts = 3; });
  const result = await settleIncompleteStop(f);
  assert.match(result.feedback, /98\/110/u); assert.match(result.feedback, /RC_DETAILS/u);
  const stopped = await findTask({ ...f, sessionId: "terminal" });
  assert.equal(stopped.status, "STOPPED_UNVERIFIED");
  assert.equal(stopped.verification.previousVerification.evaluationId, "prior");
  assert.equal(stopped.stop.correctionAttempts, 3);
  await settleIncompleteStop(f);
  const again = await findTask({ ...f, sessionId: "terminal" });
  assert.deepEqual(again.verification, stopped.verification);
  assert.equal(Object.keys(again.assessments).length, 1);
});

for (const state of ["newer run", "current PASS", "previous PASS"]) test(`${state} is handled without confusing old and current verification`, async t => {
  const f = await fixture(t);
  await withTaskState(f, task => {
    task.status = "COMPLETED";
    task.verification = { status: "PASS", assessmentId: state === "previous PASS" ? "old-run:stop" : "current-run:stop", evaluationId: "pass" };
  });
  await settleIncompleteStop({ ...f, isCurrent: () => state !== "newer run" });
  const task = await findTask({ ...f, sessionId: "terminal" });
  assert.equal(task.status, state === "previous PASS" ? "STOPPED_UNVERIFIED" : "COMPLETED");
  assert.equal(task.verification.status, state === "previous PASS" ? "UNVERIFIED" : "PASS");
});
