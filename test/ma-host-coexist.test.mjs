import test from "node:test";
import assert from "node:assert/strict";
import { readAutopilotStatus, createPostRunHostRequester } from "../lib/openclaw/post-run-host.mjs";
import { createOpenClawRuntime } from "../lib/openclaw/runtime.mjs";

const configured = { plugins: { entries: { autopilot: { enabled: true } } } };
const apiFor = request => ({ config: structuredClone(configured), runtime: { gateway: { request } } });

test("autopilot activity uses the exact session's public projection and never treats missing state as idle", async () => {
  for (const [hostStatus, expected] of [["running", "RUNNING"], ["done", "IDLE"], ["paused", "IDLE"], ["idle", "IDLE"], ["other", "UNKNOWN"]]) {
    const api = apiFor(async (method, params, options) => {
      assert.equal(method, "autopilot.status"); assert.deepEqual(params, { sessionKey: "agent:main:work" });
      assert.equal(options.timeoutMs, 1000);
      return { projection: { status: hostStatus } };
    });
    const result = await readAutopilotStatus(api, { sessionKey: "agent:main:work" });
    assert.equal(result.status, expected);
    if (expected === "UNKNOWN") assert.match(result.message, /不推断/u);
  }
  for (const request of [async () => ({}), async () => { throw new Error("unavailable"); }])
    assert.equal((await readAutopilotStatus(apiFor(request), { sessionKey: "agent:main:work" })).status, "UNKNOWN");
  assert.equal((await readAutopilotStatus({ config: {}, runtime: {} }, { sessionKey: "agent:main:work" })).status, "UNKNOWN");
});

test("explicitly disabled autopilot needs no status call and fallback status RPC requests read scope only", async () => {
  const api = apiFor(() => assert.fail("disabled plugin needs no RPC")); api.config.plugins.entries.autopilot.enabled = false;
  assert.equal((await readAutopilotStatus(api, { sessionKey: "agent:main:work" })).status, "IDLE");
  const calls = [], request = createPostRunHostRequester({ runtime: {} }, { compatibility: async () => ({
    callGatewayFromCli(...args) { calls.push(args); return { projection: { status: "running" } }; },
  }) });
  const result = await request("autopilot.status", { sessionKey: "exact" }, { timeoutMs: 1000 });
  assert.equal(result.projection.status, "running"); assert.deepEqual(calls[0][3].scopes, ["operator.read"]);
});

test("a bounded failed status probe remains UNKNOWN", async () => {
  const parent = new AbortController();
  const api = apiFor(async (_method, _params, { signal }) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  const result = await readAutopilotStatus(api, { sessionKey: "exact" }, { signal: parent.signal });
  assert.equal(result.status, "UNKNOWN"); assert.equal(parent.signal.aborted, false);
});

test("held confirmed terminals yield for final or unknown autopilot activity without releasing unknown host reservations", async () => {
  for (const { status, held = false, unknownTerminal = false, allowed } of [
    { status: "running", allowed: true }, { allowed: false },
    { status: "done", held: true, allowed: true }, { held: true, allowed: true },
    { held: true, unknownTerminal: true, allowed: false },
  ]) {
    const record = { runId: "old", phase: "COEXIST_WAIT", completedRuns: [],
      ...(held ? { candidate: { runId: "old", terminalConfirmedAt: Date.now() } } : {}),
      ...(unknownTerminal ? { reconciliation: { status: "UNKNOWN" } } : {}) }, notes = [];
    const state = { agentId: "main", sessionId: "s", sessionKey: "agent:main:s", projectRoot: "/unused",
      projectScope: { fingerprint: "scope" }, enabledRevision: 0 };
    const manager = { get: () => record, load: async () => {}, noteCoexistence: async (_id, value) => notes.push(value) };
    const api = { ...apiFor(async () => ({ projection: status ? { status } : undefined })),
      id: "runtime-corrector", pluginConfig: {}, logger: { warn() {} } };
    api.runtime.agent = {};
    const runtime = createOpenClawRuntime(api, { nativeHooks: true,
      sharedState: { states: new Map([["main:s", state]]), postRunDispatcher: manager },
      stopStartCompatibility: async () => ({ version: 1, onStart: () => () => {}, drain: async () => {}, diagnosticsEnabled: () => true }) });
    const decision = await runtime.beforeAgentRun({ sessionId: "s" }, { ...state, runId: "next" });
    if (allowed) assert.equal(decision, undefined);
    else assert.equal(decision?.reason, "RC_PENDING_TASK_NOT_ADMITTED");
    assert.equal(notes.at(-1).status, status === "running" ? "RUNNING" : status === "done" ? "IDLE" : "UNKNOWN");
    const owned = await runtime.beforeAgentRun({ sessionId: "s" }, { ...state, runId: "rc-stop-" + "a".repeat(64) });
    assert.equal(owned?.outcome, "block", "coexistence cannot grant an unverified RC continuation admission");
  }
});
