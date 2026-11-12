import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createNativeStopFixture, deferred, pause, until, within } from "./support/openclaw-native-stop-fixture.mjs";

const { lifecycle, findTask, taskDirectory } = createNativeStopFixture();

function releases(f) {
  const reasons = [], release = f.runtime.postRuns.release.bind(f.runtime.postRuns);
  f.runtime.postRuns.release = (identity, reason) => { reasons.push(reason); return release(identity, reason); };
  return reasons;
}

// Holds the next work admission past a one second hot hook budget.
function slowAdmission(t, f) {
  const admission = f.api.runtime.agent.session.runWithWorkAdmission, gate = deferred(t);
  let settle;
  const settled = new Promise(resolve => { settle = resolve; });
  f.api.runtime.agent.session.runWithWorkAdmission = async (params, run) => {
    f.api.runtime.agent.session.runWithWorkAdmission = admission;
    await gate.promise;
    try { return await admission(params, run); } finally { settle(); }
  };
  f.api.pluginConfig.hookTimeoutMs = 2000;
  return { release() { f.api.pluginConfig.hookTimeoutMs = 5000; gate.resolve(); }, settled };
}

// Each admission waits until the test releases it, in arrival order.
function heldAdmissions(t, f) {
  const admission = f.api.runtime.agent.session.runWithWorkAdmission, held = [];
  f.api.runtime.agent.session.runWithWorkAdmission = async (params, run) => {
    const gate = deferred(t);
    held.push(gate);
    await gate.promise;
    return admission(params, run);
  };
  return held;
}

async function preToolEvents(f) {
  const task = await findTask({ projectRoot: f.root, sessionId: "host" });
  const lines = (await fs.readFile(path.join(taskDirectory(f.root, task.taskId), "journal", "events.jsonl"), "utf8")).split("\n");
  return lines.filter(Boolean).map(line => JSON.parse(line))
    .filter(event => event.type === "HOOK_EVENT" && event.hookEventName === "PreToolUse").length;
}

const grep = id => ({ toolName: "bench_nav", toolCallId: `grep-${id}`, params: { action: "grep", pattern: id } });

test("an observation-only pre-check past the hot hook budget misses only that call", async t => {
  const f = await lifecycle(t);
  const reasons = releases(f), controller = f.state.reviewController, slow = slowAdmission(t, f);
  const started = Date.now();
  assert.equal(await f.runtime.beforeTool(grep("slow"), f.ctx), undefined);
  assert(Date.now() - started < 1900, "the hook returns at its own budget");
  assert(f.warnings.some(message => message.includes("beforeTool: The pre-tool check for bench_nav exceeded the hot hook budget")),
    JSON.stringify(f.warnings));
  slow.release();
  await within(slow.settled, "late pre-check");
  await within(f.runtime.waitForBackgroundReviews(), "background review");
  assert.equal(controller.signal.aborted, false);
  assert.equal(f.state.reviewController, controller);
  assert(!f.state.nativeInvalidated);
  assert.equal(f.state.finalNotice ?? null, null);
  assert(!reasons.includes("RC_HOOK_UNAVAILABLE"), JSON.stringify(reasons));
  await f.runtime.reply({ kind: "final", runId: f.ctx.runId, sessionKey: f.ctx.sessionKey, payload: { text: "Delivered." } }, f.ctx);
  const [review] = await within(f.runtime.waitForNativeReviews(), "native review settlement");
  assert.equal(review.reviewStatus, "NO_DEVIATION_FOUND", JSON.stringify(review));
  assert(f.calls() > 0, "the run review still reached the reviewer");
});

for (const [label, call] of [
  ["a write", { toolName: "write", toolCallId: "slow-write", params: { path: "draft.md" } }],
  ["a skill read", { toolName: "read", toolCallId: "slow-skill", params: { path: "skills/demo/SKILL.md" } }],
]) test(`${label} pre-check past the hot hook budget still leaves the run unverified`, async t => {
  const f = await lifecycle(t);
  const reasons = releases(f), controller = f.state.reviewController, slow = slowAdmission(t, f);
  await f.runtime.beforeTool(call, f.ctx);
  assert(reasons.includes("RC_HOOK_UNAVAILABLE"), JSON.stringify(reasons));
  assert.equal(controller.signal.aborted, true);
  assert.equal(f.state.nativeInvalidated, true);
  slow.release();
  await within(slow.settled, "late pre-check");
  await within(f.runtime.waitForNativeReviews({ drain: true }), "native review settlement");
});

test("a deferred hot review waits for pending pre-checks and covers observation-only calls once", async t => {
  const f = await lifecycle(t);
  const before = await preToolEvents(f), held = heldAdmissions(t, f);
  const calls = ["a", "b", "c", "d"].map(id => f.runtime.beforeTool(grep(id), f.ctx));
  await until(() => held.length === calls.length, "all pre-checks to request admission");
  held[0].resolve();
  await within(Promise.race(calls), "the first pre-check");
  await pause(300);
  assert.equal(await preToolEvents(f), before, "the review yields while sibling pre-checks are pending");
  for (const gate of held) gate.resolve();
  await within(Promise.all(calls), "sibling pre-checks");
  await within(f.runtime.waitForBackgroundReviews(), "background review");
  assert.equal(await preToolEvents(f), before + 1, "one pending review covers every observation-only call");
  assert.equal(f.state.reviewController.signal.aborted, false);
});

test("a tool result that waits for the hot review is not blocked by a pre-check queued behind it", async t => {
  const f = await lifecycle(t);
  const held = heldAdmissions(t, f);
  const queued = f.runtime.beforeTool(grep("queued"), f.ctx);
  await until(() => held.length === 1, "the queued pre-check to request admission");
  const first = f.runtime.beforeTool(grep("first"), f.ctx);
  await until(() => held.length === 2, "the first pre-check to request admission");
  held[1].resolve();
  await within(first, "the first pre-check");
  const result = f.runtime.toolResult({ ...grep("first"), args: grep("first").params,
    result: { content: [{ type: "text", text: "draft.md:1" }] } }, f.ctx);
  await until(() => held.length === 3, "the tool result to request admission");
  held[2].resolve();
  await pause(50);
  held[0].resolve();
  await within(result, "the tool result", 5000);
  await within(queued, "the queued pre-check", 5000);
  await within(f.runtime.waitForBackgroundReviews(), "background review");
  assert.equal(f.state.reviewController.signal.aborted, false);
  assert(!f.state.nativeInvalidated);
});
