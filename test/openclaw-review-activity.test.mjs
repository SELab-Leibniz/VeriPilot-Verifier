import test from "node:test";
import assert from "node:assert/strict";
import { relayNativeReviewActivity, reviewProgressText } from "../lib/openclaw/review-activity.mjs";

function fixture({ deadlineAt = Date.now() + 1200000, controller = new AbortController() } = {}) {
  let activity, events;
  const reported = [], visible = [];
  const parent = { sessionId: "parent-session", sessionKey: "agent:main:parent", runId: "parent-run" };
  const sdk = {
    onRunActivity: (listener) => { activity = listener; return () => { activity = null; }; },
    onAgentEvent: (listener) => { events = listener; return () => { events = null; }; },
    reportProgress: (target, reason) => reported.push({ target, reason }),
    emitAgentEvent: (event) => visible.push(event),
  };
  const close = relayNativeReviewActivity({ sdk, parent, runId: "review-run", role: "onboarding-extractor", controller, deadlineAt });
  return { parent, controller, reported, visible, close, activity: (event) => activity?.(event), events: (event) => events?.(event) };
}

function clock(t) {
  let now = 1000000, nextId = 0;
  const timers = new Map();
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "setTimeout", (callback, delay) => {
    const timer = { id: ++nextId, at: now + delay, callback, unref() {} };
    timers.set(timer.id, timer);
    return timer;
  });
  t.mock.method(globalThis, "clearTimeout", timer => timers.delete(timer?.id));
  return {
    advance(ms) {
      const end = now + ms;
      while (true) {
        const timer = [...timers.values()].sort((a, b) => a.at - b.at)[0];
        if (!timer || timer.at > end) break;
        now = timer.at; timers.delete(timer.id); timer.callback();
      }
      now = end;
    },
    get pending() { return timers.size; },
  };
}

test("a silent native review stays observable beyond the MA idle window without assistant text or fake diagnostic progress", t => {
  const c = clock(t), f = fixture();
  c.advance(360000);
  const status = f.visible.filter(event => event.stream === "tool" && event.data.phase === "update");
  assert(status.length >= 7, "a six-minute silent review must emit bounded runtime status updates");
  assert.equal(status[0].data.elapsedMs, 0);
  assert.equal(status.at(-1).data.elapsedMs, 360000);
  assert(status.every(event => event.runId === f.parent.runId && event.sessionKey === f.parent.sessionKey));
  assert(status.every(event => event.data.reviewRunId === "review-run" && event.data.lastActivityAt === null));
  assert(status.every(event => !["text", "content", "message", "role", "state"].some(key => key in event.data)));
  assert.equal(f.visible.filter(event => event.stream === "assistant").length, 0, "status must never touch the shared assistant buffer");
  assert(status.every(event => !["start", "result"].includes(event.data.phase)));
  assert.equal(f.reported.length, 1, "a timer is not evidence of reviewer progress");
  f.close();
  assert.equal(c.pending, 0);
});

test("runtime status reports real activity freshness without forwarding private reviewer output", t => {
  const c = clock(t), f = fixture();
  c.advance(17000);
  f.activity({ runId: "review-run", type: "model.call.started", secretCandidate: "DO_NOT_FORWARD" });
  c.advance(43000);
  const status = f.visible.filter(event => event.stream === "tool" && event.data.phase === "update").at(-1);
  assert.equal(status.data.lastActivityAt, 1017000);
  assert.equal(status.data.lastActivityType, "model.call.started");
  assert.equal(status.data.elapsedMs, 60000);
  assert(!JSON.stringify(f.visible).includes("DO_NOT_FORWARD"));
  f.close();
});

test("runtime keepalive stops at its existing absolute deadline without extending or cancelling the review budget", t => {
  const c = clock(t), f = fixture({ deadlineAt: Date.now() + 65000 });
  c.advance(65000);
  const before = f.visible.length;
  c.advance(360000);
  assert.equal(f.visible.length, before);
  assert.equal(c.pending, 0);
  assert.equal(f.controller.signal.aborted, false);
  assert(f.visible.filter(event => event.stream === "tool").length >= 2);
  f.close();
});

test("manual abort and parent termination immediately dispose keepalive and activity listeners", t => {
  const c = clock(t);
  for (const kind of ["abort", "parent", "recovery", "lifecycle", "close"]) {
    const f = fixture();
    if (kind === "abort") f.controller.abort(new Error("User stopped the run"));
    if (kind === "parent") f.activity({ runId: "parent-run", type: "run.completed" });
    if (kind === "recovery") f.activity({ sessionId: "parent-session", type: "session.recovery.requested" });
    if (kind === "lifecycle") f.events({ runId: "parent-run", stream: "lifecycle", data: { phase: "end" } });
    if (kind === "close") f.close();
    const before = [f.visible.length, f.reported.length];
    f.activity({ runId: "review-run", type: "run.progress" });
    c.advance(360000);
    assert.deepEqual([f.visible.length, f.reported.length], before, kind);
    assert.equal(c.pending, 0, kind);
    f.close();
  }
});

test("expired, already cancelled, and unbounded callers cannot start a periodic keepalive", t => {
  const c = clock(t), controller = new AbortController(); controller.abort();
  for (const options of [{ controller }, { deadlineAt: Date.now() }, { deadlineAt: Infinity }]) {
    const f = fixture(options);
    c.advance(360000);
    assert.equal(f.visible.filter(event => event.stream === "tool").length, 0);
    assert.equal(c.pending, 0);
    f.close();
  }
});

test("native hook relays only owned real reviewer activity and detaches after completion", () => {
  const f = fixture();
  f.activity({ runId: "unrelated", type: "run.progress" });
  f.activity({ runId: "parent-run", type: "run.progress" });
  f.activity({ runId: "review-run", type: "run.progress", reason: "runtime-corrector:review:run.progress" });
  assert.equal(f.reported.length, 1);
  for (const type of ["run.progress", "model.call.started", "model.call.completed", "tool.execution.completed"]) {
    f.activity({ runId: "review-run", type });
  }
  assert.equal(f.reported.length, 5);
  assert.ok(f.reported.every(({ target }) => target === f.parent));
  assert.equal(f.visible[0].data.partialResult.views[0].text, "正在提取需求。");
  f.close(); f.activity({ runId: "review-run", type: "run.progress" });
  assert.equal(f.reported.length, 5);
  assert.equal(f.controller.signal.aborted, false);
});

test("native parent terminal and watchdog recovery cancel its outstanding reviewer", () => {
  for (const signal of ["terminal", "recovery", "lifecycle"]) {
    const f = fixture();
    if (signal === "terminal") f.activity({ runId: "parent-run", type: "run.completed", outcome: "aborted" });
    if (signal === "recovery") f.activity({ sessionId: "parent-session", type: "session.recovery.requested" });
    if (signal === "lifecycle") f.events({ runId: "parent-run", stream: "lifecycle", data: { phase: "error" } });
    assert.equal(f.controller.signal.aborted, true);
    f.activity({ runId: "review-run", type: "run.progress" });
    assert.equal(f.reported.length, 1);
    f.close();
  }
});

test("review phase notices expose stage and filename without internal assessment text", () => {
  assert.equal(reviewProgressText({ role: "artifact-reviewer", file: "/private/work/proposal.md" }), "正在评审文档：proposal.md。");
  assert.equal(reviewProgressText({ phase: "WRITING", file: "/private/work/design.md" }), "正在修改文件：design.md。");
  assert.equal(reviewProgressText({ phase: "TOOL_EXECUTION" }), null);
});
