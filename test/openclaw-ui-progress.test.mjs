import test from "node:test";
import assert from "node:assert/strict";
import { createUiProgress } from "../lib/openclaw/ui-progress.mjs";
import { createStopWaitStatus } from "../lib/openclaw/stop-wait-status.mjs";

function fixture() {
  const events = [], listeners = new Set(), controller = new AbortController();
  const parent = { runId: "business", sessionId: "session", sessionKey: "agent:main:session" };
  const sdk = { emitAgentEvent: event => events.push(event),
    markDiagnosticSessionProgress() {},
    onAgentEvent: listener => { listeners.add(listener); return () => listeners.delete(listener); } };
  return { sdk, parent, events, listeners, controller,
    end: () => { for (const listener of [...listeners]) listener({ runId: parent.runId, stream: "lifecycle", data: { phase: "end" } }); } };
}

test("RC UI progress never emits a model tool invocation, result, or assistant message", () => {
  const f = fixture();
  const progress = createUiProgress({ ...f, id: "real-review", label: "正在审查", deadlineAt: Date.now() + 10000 });
  progress.update(); progress.close(); progress.update();
  assert.deepEqual(f.events.map(event => [event.stream, event.data.phase]), [["tool", "update"], ["tool", "end"]]);
  for (const event of f.events) {
    assert.equal(event.runId, f.parent.runId);
    assert.equal(event.data.name, "runtime-corrector.review");
    for (const key of ["text", "content", "message", "args", "result", "toolErrorSummary"]) assert(!(key in event.data));
  }
  assert.equal(f.listeners.size, 0);
});

test("cancellation, parent termination, stale scope and deadline cannot renew the UI lease", t => {
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  for (const reason of ["abort", "parent", "scope", "deadline"]) {
    now = 1000;
    const f = fixture(); let current = true;
    const live = createUiProgress({ ...f, id: "live-review", label: "审查", signal: f.controller.signal,
      deadlineAt: 2000, isCurrent: () => current });
    if (reason === "abort") f.controller.abort();
    if (reason === "parent") f.end();
    if (reason === "scope") current = false;
    if (reason === "deadline") now = 2000;
    live.update(); live.close();
    assert.equal(f.events.length, 0, reason);
    assert.equal(f.listeners.size, 0, reason);
  }
});

test("parallel review progress is isolated by parent and actual reviewer identity", () => {
  const f = fixture();
  for (const runId of ["one", "two"]) for (const id of ["panel-a", "panel-b"]) {
    const progress = createUiProgress({ sdk: f.sdk, parent: { ...f.parent, runId }, id, label: "RC", deadlineAt: Date.now() + 10000 });
    progress.update(); progress.close();
  }
  assert.equal(new Set(f.events.map(event => event.data.toolCallId)).size, 4);
});

test("a live waiting UI follows a new finite phase deadline but cannot reopen after termination", t => {
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  const f = fixture();
  const progress = createUiProgress({ ...f, id: "chain", label: "RC", deadlineAt: 1100 });
  progress.update();
  now = 1200;
  progress.update("repair", { deadlineAt: 2000 });
  assert.equal(f.events.length, 2);
  progress.close();
  progress.update("late", { deadlineAt: 3000 });
  assert.equal(f.events.length, 3);
});

test("Stop UI targets only a currently waiting run, and terminal callbacks cannot resurrect it", async () => {
  const f = fixture(), status = createStopWaitStatus({}, async () => f.sdk);
  const state = { sessionId: f.parent.sessionId, sessionKey: f.parent.sessionKey, agentId: "main" };
  const input = { state, runId: f.parent.runId, phase: "waiting", deadlineAt: Date.now() + 10000 };
  await status(input); // Background post-run review.
  await status({ ...input, waiting: true, runId: undefined }); // No admitted live run yet.
  assert.equal(f.events.length, 0);
  await status({ ...input, waiting: true, text: "等待复验", signal: f.controller.signal });
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].data.partialResult.views[0].text, "等待复验");
  f.end();
  await status({ ...input, waiting: true });
  await status({ ...input, waiting: true, phase: "settled", text: "PASS" });
  assert.equal(f.events.length, 1);
  assert.equal(f.listeners.size, 0);
});

test("slow or failed status loading never holds Stop release or emits a late update", async () => {
  const f = fixture(); let finish;
  const status = createStopWaitStatus({}, () => new Promise(resolve => { finish = resolve; }));
  const call = status({ state: f.parent, runId: "waiting", waiting: true, phase: "waiting", deadlineAt: Date.now() + 10000 });
  assert.equal(await call, false);
  finish(f.sdk); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.events.length, 0);
  const broken = createUiProgress({ sdk: { emitAgentEvent() { throw new Error("offline"); } }, parent: f.parent,
    id: "review", label: "RC", deadlineAt: Date.now() + 10000 });
  assert.doesNotThrow(() => { broken.update(); broken.close(); });
});

test("a bounded live Stop waiter renews MA activity, but background, expired and terminal work do not", async t => {
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  const f = fixture(), activity = [];
  const status = createStopWaitStatus({}, async () => ({ ...f.sdk,
    markDiagnosticSessionProgress: parent => activity.push(parent) }));
  const state = { sessionId: f.parent.sessionId, sessionKey: f.parent.sessionKey, agentId: "main" };
  const input = { state, runId: f.parent.runId, phase: "waiting", deadlineAt: 1000000 };
  await status(input);
  assert.equal(activity.length, 0);
  for (let tick = 0; tick < 22; tick++) {
    now += 30000;
    await status({ ...input, waiting: true });
  }
  assert.equal(activity.length, 22); // Cross the real host's 390-second recovery threshold.
  assert.deepEqual(activity.at(-1), { ...f.parent, agentId: "main" });
  await status({ ...input, waiting: true, phase: "settled" });
  await status({ ...input, waiting: true });
  assert.equal(activity.length, 22);
  await status({ ...input, runId: "expired", deadlineAt: now, waiting: true });
  assert.equal(activity.length, 22);
  const broken = createStopWaitStatus({}, async () => ({ ...f.sdk,
    markDiagnosticSessionProgress() { throw new Error("diagnostic unavailable"); } }));
  assert.equal(await broken({ ...input, waiting: true }), false);
});

test("Stop status reports unavailable host keepalive instead of silently accepting it", async () => {
  const f = fixture(), input = { state: f.parent, runId: f.parent.runId, waiting: true,
    phase: "waiting", deadlineAt: Date.now() + 10000 };
  for (const notify of [undefined, () => { throw new Error("offline"); },
    async () => { throw new Error("offline"); }, () => new Promise(() => {})]) {
    const status = createStopWaitStatus({}, async () => ({ ...f.sdk, markDiagnosticSessionProgress: notify }));
    assert.equal(await status(input), false);
    status.close(input.state, input.runId);
  }
  const healthy = createStopWaitStatus({}, async () => f.sdk);
  assert.equal(await healthy(input), true);
  healthy.close(input.state, input.runId);
});
