import test from "node:test";
import assert from "node:assert/strict";
import { relayNativeReviewActivity, reviewProgressText } from "../lib/openclaw/review-activity.mjs";

function fixture() {
  let activity, events;
  const reported = [], visible = [];
  const parent = { sessionId: "parent-session", sessionKey: "agent:main:parent", runId: "parent-run" };
  const controller = new AbortController();
  const sdk = {
    onRunActivity: (listener) => { activity = listener; return () => { activity = null; }; },
    onAgentEvent: (listener) => { events = listener; return () => { events = null; }; },
    reportProgress: (target, reason) => reported.push({ target, reason }),
    emitAgentEvent: (event) => visible.push(event),
  };
  const close = relayNativeReviewActivity({ sdk, parent, runId: "review-run", role: "onboarding-extractor", controller });
  return { parent, controller, reported, visible, close, activity: (event) => activity?.(event), events: (event) => events?.(event) };
}

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
  assert.equal(f.visible[0].data.text, "正在提取需求。");
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
