import test from "node:test";
import assert from "node:assert/strict";
import { createNativeStopChains } from "../lib/openclaw/native-stop-chain.mjs";

const state = () => ({ projectRoot: "/fixture", sessionId: "session", sessionKey: "agent:main:fixture", nativeRunId: "first" });
const start = (manager, scope, options = {}) => manager.begin({ state: scope, runId: "first", taskId: "task", budgetMs: 1000, ...options });

test("a correction chain stays closed to outsiders across admission, correction and recheck, then releases on current PASS", async () => {
  const manager = createNativeStopChains(), scope = state(), chain = start(manager, scope);
  manager.link(scope, { runId: "correction", taskId: "task" });
  chain.assessed({ runId: "first", reviewStatus: "DEVIATION", followupStatus: "ADMITTED" });
  assert.equal(chain.pending, true);
  chain.enter("correction");
  assert.equal(chain.record.phase, "CORRECTING");
  assert.equal(manager.begin({ state: scope, runId: "correction", taskId: "task", budgetMs: 1000 }), chain);
  assert.equal(chain.record.phase, "REVIEWING");
  chain.enter("first");
  assert.equal(chain.record.runId, "correction", "late prior-run activity cannot rewind the chain");
  chain.assessed({ runId: "first", reviewStatus: "PASS" });
  assert.equal(chain.pending, true, "a prior assessment cannot pass the current correction");
  chain.assessed({ runId: "correction", reviewStatus: "PASS", evaluationId: "new-evaluation" });
  assert.equal((await chain.released).reviewStatus, "PASS");
});

test("a reentrant correction can pass before its parent admission callback unwinds", async () => {
  const manager = createNativeStopChains(), scope = state(), chain = start(manager, scope);
  manager.link(scope, { runId: "correction", taskId: "task" });
  chain.enter("correction");
  chain.assessed({ runId: "correction", reviewStatus: "PASS" });
  chain.assessed({ runId: "first", reviewStatus: "DEVIATION", followupStatus: "ADMITTED" });
  assert.equal((await chain.released).reviewStatus, "PASS");
  assert.equal(chain.pending, false);
});

test("budget exhaustion, refusal and infrastructure faults release without becoming PASS", async () => {
  for (const result of [{ reviewStatus: "DEVIATION", reasonCode: "CORRECTION_BUDGET_EXHAUSTED" },
    { reviewStatus: "DEVIATION", followupStatus: "REJECTED" }, { reviewStatus: "UNVERIFIED", reasonCode: "CHECKER_DOWN" }]) {
    const manager = createNativeStopChains(), chain = start(manager, state());
    chain.assessed({ runId: "first", ...result });
    assert.equal((await chain.released).reviewStatus, result.reviewStatus);
    assert.equal(chain.pending, false);
  }
});

test("chain cancellation and deadline release are independent of unresponsive cleanup and fence late children", async () => {
  const manager = createNativeStopChains(), scope = state(), chain = start(manager, scope, { onCancel: () => new Promise(() => {}) });
  manager.link(scope, { runId: "correction", taskId: "task" });
  chain.expire();
  const record = await chain.released;
  assert.equal(record.reasonCode, "STOP_WAIT_DEADLINE_EXPIRED");
  assert.equal(record.reviewStatus, "UNVERIFIED");
  chain.enter("correction");
  chain.assessed({ runId: "correction", reviewStatus: "PASS" });
  assert.equal(chain.record.reviewStatus, "UNVERIFIED");
  assert.equal(manager.begin({ state: scope, runId: "correction", taskId: "task", budgetMs: 1000 }), chain);
  const next = manager.begin({ state: scope, runId: "new-business", taskId: "task", budgetMs: 1000 });
  assert.equal(manager.owner(scope, "correction"), chain, "new chains retain the identity of retired correction runs");
  assert.equal(manager.owner(scope, "correction").isStale("correction"), true);
  manager.cancel(scope, "USER_RESET");
  assert.equal((await next.released).reviewStatus, "CANCELLED");
});

test("unrelated sessions and foreign task receipts cannot enter or complete a chain", async () => {
  const manager = createNativeStopChains(), scope = state(), chain = start(manager, scope);
  manager.link(scope, { runId: "forged", taskId: "other-task" });
  chain.enter("forged"); chain.assessed({ runId: "forged", reviewStatus: "PASS" });
  assert.equal(chain.record.runId, "first");
  assert.equal(manager.get({ ...scope, sessionId: "another" }), undefined);
  manager.cancel(scope, "USER_RESET");
});

test("the total deadline expires while an admitted correction has no Stop reviewer", async () => {
  const manager = createNativeStopChains(), scope = state(), chain = start(manager, scope, { budgetMs: 20 });
  manager.link(scope, { runId: "correction", taskId: "task" });
  chain.enter("correction");
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal((await chain.released).reasonCode, "STOP_WAIT_DEADLINE_EXPIRED");
  assert.equal(chain.record.reviewStatus, "UNVERIFIED");
});
