import test from "node:test";
import assert from "node:assert/strict";
import { createStopWaitStatus, stopWaitText } from "../lib/openclaw/stop-wait-status.mjs";

test("Stop status distinguishes verified acceptance, dispatch refusal and incomplete reviews", () => {
  assert.match(stopWaitText({ reviewStatus: "PASS" }), /验收通过/u);
  assert.match(stopWaitText({ reviewStatus: "DEVIATION", followupStatus: "ADMITTED" }), /反馈已交给宿主/u);
  assert.match(stopWaitText({ reviewStatus: "DEVIATION", followupStatus: "REJECTED" }), /宿主拒绝/u);
  for (const record of [{ reviewStatus: "UNVERIFIED" }, { reviewStatus: "CANCELLED" },
    { reviewStatus: "DEVIATION", followupStatus: "UNVERIFIED" }, { reasonCode: "REVIEW_DEADLINE_EXPIRED" }]) {
    assert.doesNotMatch(stopWaitText(record), /验收通过/u);
    assert.match(stopWaitText(record), /解除等待/u);
  }
});

test("UI replacement retains the complete business delivery and fences retired runs", async () => {
  const events = [], status = createStopWaitStatus({}, async () => ({ emitAgentEvent: event => events.push(event) }));
  const state = { sessionId: "session", sessionKey: "agent:main:session", agentId: "main" };
  await status({ state, runId: "old", text: "Waiting", baseText: "Original delivery.", phase: "waiting" });
  assert.equal(events.length, 2);
  assert.equal(events[1].data.text, "Original delivery.\n\n[runtime-corrector] Waiting");
  assert.equal(events[1].runId, "old");
  await status({ state, runId: "old", text: "Late PASS", phase: "settled", isCurrent: () => false });
  assert.equal(events.length, 2);
});

test("a stalled status channel has a bounded wait and cannot emit a late snapshot", async () => {
  let release;
  const events = [], status = createStopWaitStatus({}, () => new Promise(resolve => { release = resolve; }));
  await status({ state: {}, runId: "run", text: "Waiting", phase: "waiting" });
  release({ emitAgentEvent: event => events.push(event) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.length, 0);
  const broken = createStopWaitStatus({}, async () => { throw new Error("UI unavailable"); });
  await broken({ state: {}, text: "Unavailable", phase: "settled" });
});
