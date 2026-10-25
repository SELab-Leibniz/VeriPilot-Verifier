import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { readMaContract } from "./helpers/ma-transport.mjs";
import { relayNativeReviewActivity } from "../lib/openclaw/review-activity.mjs";
import { createStopWaitStatus } from "../lib/openclaw/stop-wait-status.mjs";

function fixture(t) {
  if (!process.env.RC_MA_ROOT) { t.skip("Set RC_MA_ROOT to verify the actual installed MA package."); return; }
  const contract = readMaContract(process.env.RC_MA_ROOT);
  let now = 1000000, sequence = 0, nextId = 0;
  const timers = new Map(), wire = [], errorSummaryWrites = [], diagnostic = [], parentEvents = new Set();
  const setTimer = (callback, delay) => {
    const timer = { id: ++nextId, at: now + delay, callback, unref() {} }; timers.set(timer.id, timer); return timer;
  };
  const clearTimer = timer => timers.delete(timer?.id);
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "setTimeout", setTimer); t.mock.method(globalThis, "clearTimeout", clearTimer);
  const client = contract.progressClient({ setTimeout: setTimer, clearTimeout: clearTimer, now: () => now });
  const source = fs.readFileSync(path.join(process.env.RC_MA_ROOT, "resources/openclaw/dist/server-chat-wgxNCdC3.js"), "utf8");
  const at = source.indexOf("function createAgentEventHandler("), end = source.indexOf("//#endregion", at);
  assert(at >= 0 && end > at, "installed host event-handler contract must be present");
  const make = vm.runInNewContext(`${source.slice(at, end)};createAgentEventHandler`, {
    Map, Set, Date, clearTimeout: clearTimer, loadGatewaySessionRow: () => null,
    AGENT_LIFECYCLE_ERROR_RETRY_GRACE_MS: 1000, normalizeVerboseLevel: value => value,
    getAgentRunContext: () => ({ isControlUiVisible: true, verboseLevel: "off" }),
    loadSessionEntry: () => ({ cfg: {}, entry: {} }), isSubagentSessionKey: () => false, isAcpSessionKey: () => false,
    isRestartRecoveryLifecycleEvent: () => false, isChatAbortMarkerCurrent: () => false,
    shouldSuppressHeartbeatToolEvents: () => false,
    excludeConnIds: (all, excluded) => new Set([...all].filter(id => !excluded?.has(id))),
  }, { timeout: 1000 });
  let delivered = Promise.resolve();
  const send = (event, payload) => { wire.push({ event, payload }); delivered = delivered.then(() => client.receive({ event, payload })); };
  const handler = make({ broadcast: send, broadcastToConnIds: (event, payload, recipients) => { if (recipients.has("ma")) send(event, payload); },
    nodeSendToSession() {}, agentRunSeq: new Map(), chatRunState: { registry: { peek: () => null }, abortedRuns: new Map() },
    resolveSessionKeyForRun: () => null, clearAgentRunContext() {}, toolEventRecipients: { get: () => undefined },
    sessionEventSubscribers: { getAll: () => new Set(["ma"]) }, sessionMessageSubscribers: { get: () => new Set() },
    updateRunToolErrorSummary: value => errorSummaryWrites.push(value) });
  const parent = { sessionId: "session", sessionKey: "agent:main:alignment", runId: "business" };
  const sdk = { emitAgentEvent: event => handler({ ...event, seq: ++sequence, ts: now }),
    reportProgress: (_parent, reason) => diagnostic.push(reason), onRunActivity: () => () => {},
    onAgentEvent: listener => { parentEvents.add(listener); return () => parentEvents.delete(listener); } };
  client.start(parent.sessionKey);
  return { sdk, parent, contract, client, wire, errorSummaryWrites, diagnostic,
    flush: () => delivered,
    async advance(ms) {
      const until = now + ms;
      while (true) {
        const timer = [...timers.values()].sort((a, b) => a.at - b.at)[0];
        if (!timer || timer.at > until) break;
        now = timer.at; timers.delete(timer.id); timer.callback(); await delivered;
      }
      now = until; await delivered;
    },
    terminal() { for (const listener of [...parentEvents]) listener({ runId: parent.runId, stream: "lifecycle", data: { phase: "end" } }); },
  };
}

test("real MA desktop filter reproduces the old heartbeat failure", async t => {
  const f = fixture(t); if (!f) return;
  for (let i = 0; i < 12; i++) {
    await f.client.receive({ event: "agent", payload: { ...f.parent, stream: "runtime-corrector.progress", data: { phase: "waiting" } } });
    await f.advance(30000);
  }
  assert.deepEqual(f.client.timeouts, [f.parent.sessionKey]);
  assert.equal(f.client.state.messages.length, 0);
});

test("actual Gateway, desktop main and renderer keep two real RC reviews alive beyond five minutes without transcript/tool-error changes", async t => {
  const f = fixture(t); if (!f) return;
  const controllers = [new AbortController(), new AbortController()];
  const closes = controllers.map((controller, index) => relayNativeReviewActivity({ sdk: f.sdk, parent: f.parent,
    runId: `panel-${index}`, role: "onboarding-extractor", controller, deadlineAt: Date.now() + 600000 }));
  await f.flush(); await f.advance(360000);
  assert.deepEqual(f.client.timeouts, []);
  assert(f.wire.filter(event => event.event === "session.tool").length >= 24);
  assert.equal(f.client.state.streamingTools.length, 2);
  assert.equal(f.client.state.messages.length, 0);
  assert.equal(f.client.state.streamingOrderedBlocks.length, 0);
  assert.equal(f.errorSummaryWrites.length, 0);
  assert.equal(f.diagnostic.length, 2, "clock ticks are not evidence of model progress");
  controllers[0].abort(); controllers[1].abort(); closes.forEach(close => close());
  const count = f.wire.length; await f.advance(60000);
  assert.equal(f.wire.length, count, "manual stop immediately disposes all review heartbeats");
});

test("Stop waiting uses the same desktop-compatible route and never renews an ended original run", async t => {
  const f = fixture(t); if (!f) return;
  const status = createStopWaitStatus({}, async () => f.sdk);
  const input = { state: f.parent, runId: f.parent.runId, phase: "waiting", deadlineAt: Date.now() + 400000 };
  await status(input); assert.equal(f.wire.length, 0, "background post-run work is not live business work");
  for (let i = 0; i < 12; i++) { await status({ ...input, waiting: true }); await f.flush(); await f.advance(30000); }
  assert.deepEqual(f.client.timeouts, []);
  f.terminal(); const count = f.wire.length;
  await status({ ...input, waiting: true }); await f.flush();
  assert.equal(f.wire.length, count);
  assert.equal(f.client.state.messages.length, 0);
  assert.equal(f.errorSummaryWrites.length, 0);
});
