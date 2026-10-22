import test from "node:test";
import assert from "node:assert/strict";
import { createUiProgress } from "../lib/openclaw/ui-progress.mjs";
import { createStopWaitStatus } from "../lib/openclaw/stop-wait-status.mjs";

function fixture() {
  const events = [], listeners = new Set(), controller = new AbortController();
  const parent = { runId: "business", sessionId: "session", sessionKey: "agent:main:session" };
  const sdk = { emitAgentEvent: event => events.push(event),
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
  await call;
  finish(f.sdk); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.events.length, 0);
  const broken = createUiProgress({ sdk: { emitAgentEvent() { throw new Error("offline"); } }, parent: f.parent,
    id: "review", label: "RC", deadlineAt: Date.now() + 10000 });
  assert.doesNotThrow(() => { broken.update(); broken.close(); });
});
