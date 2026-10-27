import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { createStopWaitStatus } from "../lib/openclaw/stop-wait-status.mjs";

// Execute the installed host's queue and hook runner without a Gateway, model,
// user session, or writes to the installation. Opt in with the reference root.
const host = process.env.RC_OPENCLAW_HOST_ROOT;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const load = file => import(pathToFileURL(path.join(host, "dist", file)));

test("MA post-run contract: third-party denial precedes dispatch and the public authenticated client is available", { skip: !host }, async () => {
  const source = await fs.readFile(path.join(host, "dist/server-plugins-XoQmHCe9.js"), "utf8");
  const start = source.indexOf("async function dispatchTrustedPluginGatewayMethod");
  const end = source.indexOf("\nconst PLUGIN_SUBAGENT_SESSION_MESSAGES_MAX_LIMIT", start);
  assert(start > 0 && end > start);
  const handler = vm.runInNewContext(`(${source.slice(start, end)})`, {
    getPluginRuntimeGatewayRequestScope: () => ({ pluginId: "runtime-corrector" }),
    canTrustedOfficialPluginRequestScopes: () => false,
    dispatchGatewayMethod: () => assert.fail("The denial must happen before dispatch"),
  });
  await assert.rejects(handler("chat.send", {}), error =>
    error.message === "Gateway requests are only available to bundled or trusted official plugins.");
  const sdk = await load("plugin-sdk/gateway-runtime.js");
  assert.equal(typeof sdk.callGatewayFromCli, "function");
});

test("MA post-run contract: agent.wait ignores the early agent terminal while normal chat replies drain", { skip: !host }, async () => {
  const source = await fs.readFile(path.join(host, "dist/agent-D6kiZtPt.js"), "utf8");
  const start = source.lastIndexOf('"agent.wait": ') + '"agent.wait": '.length;
  assert(start > 20);
  const gate = deferred(), requests = [];
  const handler = vm.runInNewContext(`(${source.slice(start, source.lastIndexOf("\n};"))})`, {
    AbortController, validateAgentWaitParams: () => true,
    readTerminalSnapshotFromGatewayDedupe: args => { assert.equal(args.ignoreAgentTerminalSnapshot, true); return null; },
    waitForTerminalGatewayDedupe: args => { requests.push(args); return gate.promise; },
    waitForAgentJob: () => assert.fail("Early lifecycle completion must not release an active normal chat"),
  });
  let result;
  const waiting = handler({ params: { runId: "run", timeoutMs: 1000 },
    context: { chatAbortControllers: new Map([["run", { kind: "chat" }]]), dedupe: new Map() },
    respond: (ok, value) => { assert.equal(ok, true); result = value; } });
  await pause(20); assert.equal(result, undefined);
  assert.equal(requests[0].ignoreAgentTerminalSnapshot, true);
  gate.resolve({ status: "ok", endedAt: Date.now() }); await waiting;
  assert.equal(result.runId, "run"); assert.equal(result.status, "ok");
});

test("MA post-run contract: reply_dispatch claiming returns its receipt and bypasses normal resolution", { skip: !host }, async () => {
  const { i: initialize, t: current, a: reset } = await load("hook-runner-global-BmIrGlLG.js");
  const receipt = { handled: true, queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
  reset();
  try {
    initialize({ hooks: [], plugins: [{ id: "rc-post-run-contract", status: "loaded" }], typedHooks: [
      { pluginId: "rc-post-run-contract", hookName: "reply_dispatch", timeoutMs: 1000, handler: async () => receipt },
    ] });
    assert.deepEqual(await current().runReplyDispatch({ sessionKey: "session", ctx: {} }, {}), receipt);
    const source = await fs.readFile(path.join(host, "dist/dispatch-DnzGTpPs.js"), "utf8");
    const branch = source.slice(source.indexOf("if (replyDispatchResult?.handled)"), source.indexOf('const dispatchAcquisition = await ensureDispatchReplyOperation("dispatch")'));
    assert(branch.includes("completeDispatchReplyOperation()"));
    assert(branch.includes("return attachSourceReplyDeliveryMode"));
  } finally { reset(); }
});

test("MA queue: waiting inside a session lane excludes its own continuation; waiting outside does not", { skip: !host }, async () => {
  const { i: enqueue } = await load("command-queue-DqzpsN4m.js");
  const lane = `rc-contract-${Date.now()}`, gate = deferred(), trace = [];
  const normal = enqueue(lane, async () => { trace.push("normal-entered"); await gate.promise; });
  const repair = enqueue(lane, async () => { trace.push("repair-entered"); });
  try {
    await pause(30);
    assert.deepEqual(trace, ["normal-entered"]);
  } finally { gate.resolve(); await Promise.all([normal, repair]); }
  const outer = deferred();
  const next = outer.promise.then(() => enqueue(lane, async () => { trace.push("next-entered"); }));
  await enqueue(lane, async () => { trace.push("safe-repair-entered"); outer.resolve(); });
  await next;
  assert.deepEqual(trace.slice(-2), ["safe-repair-entered", "next-entered"]);
});

test("MA hooks: an RC input-gate exception blocks the host, while a finalize exception permits completion", { skip: !host }, async () => {
  const { i: initialize, t: current, a: reset } = await load("hook-runner-global-BmIrGlLG.js");
  const { i: finalize } = await load("lifecycle-hook-helpers-BwL6869q.js");
  const pluginId = "rc-liveness-contract";
  reset();
  try {
    initialize({ hooks: [], plugins: [{ id: pluginId, status: "loaded" }], typedHooks: [
      { pluginId, hookName: "before_agent_run", timeoutMs: 30, handler: async () => { throw new Error("injected RC read fault"); } },
      { pluginId, hookName: "before_agent_finalize", timeoutMs: 30, handler: async () => new Promise(() => {}) },
    ] });
    await assert.rejects(current().runBeforeAgentRun({ prompt: "ordinary task" }, { runId: "ordinary" }), /injected RC read fault/);
    assert.deepEqual(await finalize({ hookRunner: current(), event: { runId: "ordinary" }, ctx: { runId: "ordinary" } }), { action: "continue" });
  } finally { reset(); }
});

test("MA contract: finalize remains inside the hard runtime deadline and dispatch acknowledgement precedes execution", { skip: !host }, async () => {
  const [selection, command, dispatch] = await Promise.all([
    fs.readFile(path.join(host, "dist/selection-JInn13lc.js"), "utf8"),
    fs.readFile(path.join(host, "dist/agent-D6kiZtPt.js"), "utf8"),
    fs.readFile(path.join(host, "dist/dispatch-DnzGTpPs.js"), "utf8"),
  ]);
  const hook = selection.slice(selection.indexOf("const onBeforeTerminalDelivery"), selection.indexOf("let toolMetasForTerminal"));
  assert(hook.includes("await runAgentHarnessBeforeAgentFinalizeHook"));
  assert(!hook.includes("clearTimeout(abortTimer)"));
  assert(selection.includes('scheduleAbortTimer(params.timeoutMs, "initial")'));
  assert(selection.indexOf("clearTimeout(abortTimer)") > selection.indexOf("scheduleAbortTimer(params.timeoutMs"));
  const accepted = command.indexOf("await yieldAfterAgentAcceptedAck()");
  assert(accepted > 0 && command.indexOf("dispatchAgentRunFromGateway(", accepted) > accepted);
  const outside = dispatch.indexOf('hasHooks("reply_dispatch")');
  assert(outside > 0 && dispatch.indexOf("replyResolver(", outside) > outside);
});

test("MA diagnostics: bounded RC wait updates the real watchdog activity without a model or tool start", { skip: !host }, async t => {
  const [sdk, events, states] = await Promise.all([
    load("plugin-sdk/text-runtime.js"), load("diagnostic-events-JZsXee1S.js"), load("diagnostic-session-state-Gz0nXz2K.js"),
  ]);
  const wasEnabled = events.t();
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  const state = { sessionId: "rc-watchdog-contract", sessionKey: "agent:main:rc-watchdog-contract" };
  events.y(true);
  try {
    const actual = states.n(state);
    actual.state = "processing";
    actual.lastActivity = now;
    const status = createStopWaitStatus({}, async () => ({ emitAgentEvent() {},
      markDiagnosticSessionProgress: sdk.markDiagnosticSessionProgress }));
    for (let tick = 0; tick < 24; tick++) {
      now += 30000;
      await status({ state, runId: "waiting", waiting: true, phase: "waiting", deadlineAt: 1000000 });
      assert.equal(actual.lastActivity, now);
      assert(now - actual.lastActivity < sdk.resolveStuckSessionWarnMs());
    }
    await status({ state, runId: "waiting", waiting: true, phase: "settled", deadlineAt: 1000000 });
    const lastActivity = actual.lastActivity;
    now += 420000;
    await status({ state, runId: "waiting", waiting: true, phase: "waiting", deadlineAt: now + 100000 });
    assert.equal(actual.lastActivity, lastActivity);
  } finally {
    sdk.resetDiagnosticStateForTest();
    events.y(wasEnabled);
  }
});
