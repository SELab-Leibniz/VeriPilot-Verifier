import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readSessionRuntimeDetails } from "../lib/openclaw/session-runtime-details.mjs";
import { sessionRuntimeText } from "../lib/openclaw/session-runtime-text.mjs";
import { ensureTask, taskDirectory, withTaskState } from "../lib/runtime-v2/task-store.mjs";
import { sha256 } from "../lib/runtime-v2/utils.mjs";

test("console binds stored review, brief and repair input to the selected host session and run", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rc-runtime-details-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const task = await ensureTask({ projectRoot: root, sessionId: "session-one" });
  await withTaskState({ projectRoot: root, taskId: task.taskId }, state => {
    state.verification = { status: "UNVERIFIED", evaluationId: "stop-test", assessmentId: "repair-one:stop:infra-2" };
  });
  const evaluations = path.join(taskDirectory(root, task.taskId), "evaluations");
  const frame = path.join(root, ".runtime-correction", "requirement-frame", sha256("session-one").slice(0, 24));
  await fs.mkdir(evaluations, { recursive: true });
  await fs.mkdir(frame, { recursive: true });
  await fs.writeFile(path.join(evaluations, "stop-test.json"), JSON.stringify({
    evaluationId: "stop-test", outcome: { status: "UNVERIFIED" }, coverage: { selectedObjectCount: 2 },
    review: { metricObjectJudgements: [{ objectId: "export", judgement: "DEVIATION", reason: "Filter omitted", evidence: ["export.ts:3"] }],
      unverifiedItems: [{ objectId: "sorting", reason: "Missing evidence" }] },
  }));
  await fs.writeFile(path.join(frame, "deliveries.jsonl"), JSON.stringify({
    at: "2026-11-17T08:11:00.000Z", channel: "tool_result", runId: "original-run",
  }) + "\n{partial");
  const snapshot = { projectRoot: root, sessionId: "session-one", taskId: task.taskId, runId: "repair-one", roundId: "repair-round", outcome: "UNVERIFIED" };
  const message = "Apply the filter from the original requirement.";
  const receipt = { runId: snapshot.runId, source: { runId: "original-run" }, assessmentId: "old-stop",
    modelObservedAt: Date.now(), message, messageHash: sha256(message) };
  const details = await readSessionRuntimeDetails(snapshot, async () => receipt);
  assert.deepEqual(details.review.items.map(item => item.judgement), ["DEVIATION", "UNVERIFIED"]);
  assert.deepEqual(details.review.items[0].evidence, ["export.ts:3"]);
  assert.equal(details.brief.channel, "tool_result");
  assert.equal(details.repair.text, message);
  assert.equal((await readSessionRuntimeDetails({ ...snapshot, runId: "other-run" }, async () => receipt)).review, null);
  assert.equal((await readSessionRuntimeDetails({ ...snapshot, sessionId: "other-session" })).review, null);
  assert.equal((await readSessionRuntimeDetails({ ...snapshot, sessionId: "other-session" })).brief, null);
  assert.equal((await readSessionRuntimeDetails(snapshot, async () => ({ ...receipt, modelObservedAt: null }))).repair.text, null);
  const opaque = "[runtime-corrector:stop-reference] placeholder";
  assert.equal((await readSessionRuntimeDetails(snapshot, async () => ({ ...receipt, message: opaque, messageHash: sha256(opaque) }))).repair.text, null);
});

test("status line distinguishes passive work, protected review and unavailable live state", () => {
  const snapshot = { registered: true, phase: "RUNNING", status: "RUNNING", active: true, running: true, stage: "requirement-frame",
    activities: [{ role: "artifact-reviewer" }] };
  assert.equal(sessionRuntimeText(snapshot).line, "RC 提议 Agent 正在生成需求简报");
  assert.deepEqual(sessionRuntimeText(snapshot).activities, ["正在评审产物", "提议 Agent 正在生成需求简报"]);
  assert.match(sessionRuntimeText({ ...snapshot, phase: "REVIEWING" }).line, /本轮结束后再发送/u);
  assert.deepEqual(sessionRuntimeText({ ...snapshot, status: "UNKNOWN" }).activities, []);
  assert.equal(sessionRuntimeText({ ...snapshot, outcome: "NO_DEVIATION_FOUND" }).review, "无偏差");
  assert.match(sessionRuntimeText({ ...snapshot, phase: "ENDED", ended: true, inputMode: "WAIT" }).line, /暂缓接收新消息/u);
});
