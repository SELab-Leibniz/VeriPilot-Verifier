import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import plugin from "../lib/openclaw/entry.mjs";
import { createOpenClawRuntime } from "../lib/openclaw/runtime.mjs";
import { createStopCorrectionStore } from "../lib/runtime-v2/stop-correction-store.mjs";
import { sha256 } from "../lib/runtime-v2/utils.mjs";
import { runInternalExecution, runManagedExecution } from "../lib/openclaw/internal-context.mjs";

const header = { type: "session", id: "host", version: 3 };
const message = (id, parentId, role, content, extra = {}) => ({ type: "message", id, parentId,
  message: { role, content, ...extra } });
const first = [header, message("one", null, "user", "/rc-setup"), message("reply", "one", "assistant", "Configured.")];

async function fixture(t, { records = [header], entryRegistration = false } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rc-command-history-")));
  const project = path.join(root, "project"), stateDir = path.join(root, "state");
  await fs.mkdir(project); await fs.mkdir(stateDir);
  const transcript = path.join(stateDir, "host.jsonl");
  const entries = new Map([["agent:main:conversation", { sessionId: "host", sessionFile: transcript }]]);
  let config = { agents: { defaults: { workspace: project, model: "local/model" } } }, reads = 0, models = 0, writes = 0;
  const commands = new Map(), hooks = new Map(), warnings = [], sharedState = {};
  const api = { id: "runtime-corrector", rootDir: process.cwd(), config, pluginConfig: {},
    logger: { info() {}, debug() {}, warn(value) { warnings.push(value); } },
    runtime: { version: "2026.7.1-2", state: { resolveStateDir: () => stateDir },
      sandbox: { resolveSandboxRuntimeStatus: () => ({ sandboxed: false }) },
      config: { current: () => config, async mutateConfigFile(options) {
        const draft = structuredClone(config);
        const result = await options.mutate(draft, { snapshot: { path: path.join(stateDir, "openclaw.json") } });
        config = draft; writes++; return { result };
      } }, agent: { defaults: { provider: "local", model: "model" }, resolveAgentWorkspaceDir: () => project,
        runEmbeddedAgent() { models++; throw new Error("No model dispatch is allowed in this control."); },
        session: { async getSessionEntry(params) {
          reads++;
          if (params.storePath !== path.join(stateDir, "main.json")) return undefined;
          return entries.get(params.sessionKey);
        }, resolveStorePath: (_store, { agentId }) => path.join(stateDir, `${agentId}.json`),
        resolveSessionFilePath: (_id, entry) => entry.sessionFile } } },
    registerCommand(value) { commands.set(value.name, value); }, registerTool() {}, registerGatewayMethod() {},
    registerAgentToolResultMiddleware() {}, on(name, callback) {
      if (!hooks.has(name)) hooks.set(name, []);
      hooks.get(name).push(callback);
    } };
  const setRecords = rows => fs.writeFile(transcript, rows.map(JSON.stringify).join("\n") + "\n");
  await setRecords(records);
  const runtime = entryRegistration ? null : createOpenClawRuntime(api, { pluginRoot: process.cwd(), sharedState, nativeHooks: true,
    reviewerFactory() { models++; throw new Error("No reviewer is allowed in this control."); } });
  if (entryRegistration) plugin.register(api);
  t.after(async () => {
    if (runtime) await runtime.dispose();
    else for (const callback of hooks.get("gateway_stop") ?? []) await callback();
    await fs.rm(root, { recursive: true, force: true });
  });
  const ctx = { agentId: "main", sessionId: "host", sessionKey: "agent:main:conversation", workspaceDir: project,
    isAuthorizedSender: true, gatewayClientScopes: ["operator.admin"] };
  const store = createStopCorrectionStore({ directory: path.join(stateDir, "runtime-corrector-stop-sessions") });
  return { root, project, stateDir, transcript, entries, api, runtime, commands, store, ctx, setRecords, warnings,
    ledger: path.join(stateDir, "runtime-corrector-stop-sessions/sessions", sha256("host") + ".json"),
    get reads() { return reads; }, get models() { return models; }, get writes() { return writes; } };
}

test("actual plugin registration captures first rc-setup history globally before project binding", async t => {
  const f = await fixture(t, { entryRegistration: true });
  const result = await f.commands.get("rc-setup").handler(f.ctx);
  const initial = await f.store.inspect("host");
  assert.equal(initial?.initialization.kind, "VERIFIED_HISTORY");
  assert.match(result.text, /续作历史：VERIFIED/u);
  assert.equal(initial.initialization.evidence.kind, "EMPTY_HOST_EXECUTION_HISTORY");
  assert.equal(initial.used, 0);
  await assert.rejects(fs.access(path.join(f.project, ".runtime-corrector")), { code: "ENOENT" });
  const before = await fs.readFile(f.ledger);
  await f.setRecords([...first, message("two", "reply", "user", "/rc-project status"), message("three", "two", "assistant", "Unbound.")]);
  const status = JSON.parse((await f.commands.get("rc-project").handler({ ...f.ctx, args: "status" })).text);
  assert.equal(status.enabled, false);
  assert.equal(status.correctionHistory.status, "VERIFIED");
  assert.deepEqual(await fs.readFile(f.ledger), before);
  assert.equal(f.models, 0);
});

test("first authenticated project and session commands capture the existing first-turn proof while remaining off", async t => {
  for (const name of ["rc-project", "rc-session"]) await t.test(name, async t => {
    const f = await fixture(t, { records: first, entryRegistration: true });
    const result = JSON.parse((await f.commands.get(name).handler({ ...f.ctx, args: "status" })).text);
    assert.equal(result.correctionHistory.status, "VERIFIED");
    if (name === "rc-session") assert.equal(result.effectiveEnabled, false);
    else assert.equal(result.enabled, false);
    assert.equal((await f.store.inspect("host")).initialization.evidence.kind, "VERIFIED_FIRST_NATIVE_TURN");
    assert.equal(f.models, 0);
  });
});

test("unauthorized, internal and managed command contexts perform no history read or initialization", async t => {
  const f = await fixture(t);
  for (const ctx of [{ ...f.ctx, isAuthorizedSender: false }, { ...f.ctx, gatewayClientScopes: [] },
    { ...f.ctx, runtimeCorrectorInternal: true }, { ...f.ctx, sessionKey: "agent:main:runtime-corrector:worker" }])
    assert.equal((await f.runtime.observeCommandHistory(ctx)).status, "UNAVAILABLE");
  await runInternalExecution("worker", async () => assert.equal((await f.runtime.observeCommandHistory(f.ctx)).status, "UNAVAILABLE"));
  await runManagedExecution("worker", async () => assert.equal((await f.runtime.observeCommandHistory(f.ctx)).status, "UNAVAILABLE"));
  assert.equal(f.reads, 0);
  await assert.rejects(fs.access(f.ledger), { code: "ENOENT" });
  assert.equal(f.models, 0);
});

test("first setup retains authorization and argument checks before any history capture", async t => {
  const f = await fixture(t, { entryRegistration: true });
  for (const ctx of [{ ...f.ctx, isAuthorizedSender: false }, { ...f.ctx, gatewayClientScopes: ["operator.read"] },
    { ...f.ctx, args: "unexpected" }]) {
    assert.match((await f.commands.get("rc-setup").handler(ctx)).text, /初始化失败/u);
  }
  assert.equal(f.reads, 0);
  assert.equal(f.writes, 0);
  await assert.rejects(fs.access(f.ledger), { code: "ENOENT" });
});

test("missing, foreign and replaced current identity never initialize another session", async t => {
  const f = await fixture(t);
  for (const ctx of [{ ...f.ctx, sessionId: undefined }, { ...f.ctx, sessionId: "foreign" },
    { ...f.ctx, sessionKey: "agent:main:foreign" }, { ...f.ctx, agentId: "foreign" }])
    assert.equal((await f.runtime.observeCommandHistory(ctx)).status, "UNVERIFIED");
  const get = f.api.runtime.agent.session.getSessionEntry;
  let calls = 0;
  f.api.runtime.agent.session.getSessionEntry = params => ++calls === 3 ? { sessionId: "replacement", sessionFile: f.transcript } : get(params);
  assert.equal((await f.runtime.observeCommandHistory(f.ctx)).status, "UNVERIFIED");
  await assert.rejects(fs.access(f.ledger), { code: "ENOENT" });
});

test("multiple users, branches, imported or compacted input remain unverified without text filtering", async t => {
  const rows = [
    [...first, message("two", "reply", "user", "/rc-project status")],
    [header, message("one", null, "user", "/rc-setup"), message("abandoned", "one", "assistant", "Old branch"), message("new", "one", "assistant", "New branch")],
    [header, message("one", null, "user", "/rc-setup", { provenance: { kind: "inter_session" } })],
    [...first, { type: "compaction", id: "compact", parentId: "reply", summary: "Prior input" }],
    [header, message("one", null, "user", "[runtime-corrector:stop-reference] prior continuation")],
  ];
  for (const records of rows) await t.test(records.at(-1).id, async t => {
    const f = await fixture(t, { records });
    assert.equal((await f.runtime.observeCommandHistory(f.ctx)).status, "UNVERIFIED");
    await assert.rejects(fs.access(f.ledger), { code: "ENOENT" });
    assert.equal(f.models, 0);
  });
});

test("existing USED and RESERVED history is byte-preserved across repeated observations and scope toggles", async t => {
  const f = await fixture(t);
  await f.store.initializeSession({ sessionId: "host", initialize: { kind: "VERIFIED_HISTORY", evidence: { sessionId: "host", kind: "fixture" },
    starts: [{ executionId: "prior-start", flowId: "prior-flow", startedAt: Date.now() - 1000 }] } });
  await f.store.beginStop({ sessionId: "host", flowId: "current-flow", stopId: "current-stop", sourceInput: { origin: "HUMAN", id: "user-current" }, config: { enabled: true } });
  await f.store.settleReview({ sessionId: "host", stopId: "current-stop", status: "DEVIATION", currentDeviations: [{ objectId: "M16:R1", reason: "Required result missing", basisKey: "source" }] });
  const admission = await f.store.reserveFeedback({ sessionId: "host", stopId: "current-stop", packageId: "feedback", basisCurrent: async () => true });
  assert.equal(admission.accounting, "RESERVED");
  const before = await fs.readFile(f.ledger);
  await f.setRecords([...first, message("two", "reply", "user", "Further original requirement")]);
  assert.equal((await f.runtime.observeCommandHistory(f.ctx)).status, "VERIFIED");
  await fs.mkdir(path.join(f.project, ".runtime-corrector"));
  await fs.writeFile(path.join(f.project, ".runtime-corrector/config.yaml"), "version: 2\nartifacts:\n  - name: draft\n    stage: proposal\n    patterns: [draft.md]\n    rules:\n      enabled: false\n    review:\n      enabled: false\nstopCorrection:\n  enabled: false\n");
  await f.runtime.projects.command({ ...f.ctx, args: "bind " + f.project });
  for (const action of ["off", "on", "off", "on"])
    await f.runtime.projects.command({ ...f.ctx, args: action });
  for (let index = 0; index < 3; index++) await f.runtime.reconcileSessionControl(f.ctx);
  assert.deepEqual(await fs.readFile(f.ledger), before);
  const final = await f.store.inspect("host");
  assert.equal(final.used, 1);
  assert.equal(Object.values(final.admissions).filter(row => row.accounting === "RESERVED").length, 1);
  assert.equal(f.models, 0);
});

test("an existing foreign or unverified ledger is not replaced by a fresh empty transcript", async t => {
  for (const invalid of ["foreign", "unverified"]) await t.test(invalid, async t => {
    const f = await fixture(t);
    await f.store.initializeSession({ sessionId: "host", initialize: { kind: "NEW_SESSION", evidence: { sessionId: "host", hook: "session_start" } } });
    const state = JSON.parse(await fs.readFile(f.ledger, "utf8"));
    if (invalid === "foreign") state.sessionId = "foreign";
    else state.initialization = null;
    await fs.writeFile(f.ledger, JSON.stringify(state));
    const before = await fs.readFile(f.ledger);
    assert.equal((await f.runtime.observeCommandHistory(f.ctx)).status, "UNVERIFIED");
    assert.deepEqual(await fs.readFile(f.ledger), before);
  });
});

test("setup reports unverified history independently of the ordinary chat switch", async t => {
  const f = await fixture(t, { entryRegistration: true, records: [...first, message("two", "reply", "user", "/rc-project status")] });
  const result = await f.commands.get("rc-setup").handler(f.ctx);
  assert.match(result.text, /续作历史：UNVERIFIED/u);
  assert.match(result.text, /普通聊天开关独立/u);
  assert.match(result.text, /不会按零次计数/u);
  await assert.rejects(fs.access(f.ledger), { code: "ENOENT" });
  assert.equal(f.models, 0);
});

test("global disable performs no command-history capture", async t => {
  const f = await fixture(t);
  f.api.pluginConfig.enabled = false;
  assert.equal((await f.runtime.observeCommandHistory(f.ctx)).reasonCode, "RC_PLUGIN_DISABLED");
  assert.equal(f.reads, 0);
  await assert.rejects(fs.access(f.ledger), { code: "ENOENT" });
});

test("newer-host readiness reads existing lifecycle history without applying the older fallback", async t => {
  const f = await fixture(t);
  f.api.runtime.version = "2026.10.3";
  assert.equal((await f.runtime.observeCommandHistory(f.ctx)).status, "UNVERIFIED");
  await assert.rejects(fs.access(f.ledger), { code: "ENOENT" });
  await f.store.initializeSession({ sessionId: "host", initialize: { kind: "NEW_SESSION", evidence: { sessionId: "host", hook: "session_start" } } });
  const before = await fs.readFile(f.ledger);
  assert.equal((await f.runtime.observeCommandHistory(f.ctx)).status, "VERIFIED");
  assert.deepEqual(await fs.readFile(f.ledger), before);
  assert.equal(f.models, 0);
});

test("malformed retained initialization stays unverified and byte-identical", async t => {
  const cases = [
    ["new-with-starts", state => { state.initialization.starts = []; }],
    ["new-with-null-starts", state => { state.initialization.starts = null; }],
    ["empty-history-row", state => { state.initialization.kind = "VERIFIED_HISTORY"; state.initialization.starts = [{}]; }],
    ["empty-execution-id", state => { state.initialization.kind = "VERIFIED_HISTORY"; state.initialization.starts = [{ executionId: "", flowId: "flow", startedAt: 1 }]; }],
    ["missing-flow-id", state => { state.initialization.kind = "VERIFIED_HISTORY"; state.initialization.starts = [{ executionId: "execution", startedAt: 1 }]; }],
    ["non-finite-start", state => { state.initialization.kind = "VERIFIED_HISTORY"; state.initialization.starts = [{ executionId: "execution", flowId: "flow", startedAt: null }]; }],
    ["ambiguous-execution-id", state => { state.initialization.kind = "VERIFIED_HISTORY"; state.initialization.starts = [{ executionId: "toString", flowId: "flow", startedAt: 1 }]; }],
    ["opaque-evidence", state => { state.initialization.evidence = "not an evidence object"; }],
    ["array-evidence", state => { state.initialization.evidence = []; }],
  ];
  for (const [name, corrupt] of cases) await t.test(name, async t => {
    const f = await fixture(t);
    await f.store.initializeSession({ sessionId: "host", initialize: { kind: "NEW_SESSION", evidence: { sessionId: "host", hook: "session_start" } } });
    const state = JSON.parse(await fs.readFile(f.ledger, "utf8"));
    corrupt(state);
    await fs.writeFile(f.ledger, JSON.stringify(state));
    const before = await fs.readFile(f.ledger);
    const readiness = await f.runtime.observeCommandHistory(f.ctx);
    assert.equal(readiness.status, "UNVERIFIED");
    assert.equal(readiness.reasonCode, "SESSION_HISTORY_STORE_UNVERIFIED");
    assert.deepEqual(await fs.readFile(f.ledger), before);
    assert.equal(f.models, 0);
  });
});

test("future or conflicting historical starts do not claim current readiness or rewrite counters", async t => {
  const cases = [
    ["future-start", [{ executionId: "execution", flowId: "flow", startedAt: Date.now() + 60000 }], "SESSION_HISTORY_TIME_UNVERIFIED"],
    ["conflicting-flow", [{ executionId: "execution", flowId: "one", startedAt: 1 }, { executionId: "execution", flowId: "two", startedAt: 1 }], "SESSION_HISTORY_STORE_UNVERIFIED"],
    ["conflicting-time", [{ executionId: "execution", flowId: "flow", startedAt: 1 }, { executionId: "execution", flowId: "flow", startedAt: 2 }], "SESSION_HISTORY_STORE_UNVERIFIED"],
  ];
  for (const [name, starts, reason] of cases) await t.test(name, async t => {
    const f = await fixture(t);
    await f.store.initializeSession({ sessionId: "host", initialize: { kind: "NEW_SESSION", evidence: { sessionId: "host", hook: "session_start" } } });
    const state = JSON.parse(await fs.readFile(f.ledger, "utf8"));
    state.initialization.kind = "VERIFIED_HISTORY";
    state.initialization.starts = starts;
    await fs.writeFile(f.ledger, JSON.stringify(state));
    const before = await fs.readFile(f.ledger);
    const result = await f.runtime.observeCommandHistory(f.ctx);
    assert.equal(result.status, "UNVERIFIED");
    assert.equal(result.reasonCode, reason);
    assert.deepEqual(await fs.readFile(f.ledger), before);
  });
});

test("exact duplicate migration starts retain verified one-used history and unchanged bytes", async t => {
  const f = await fixture(t), start = { executionId: "execution", flowId: "flow", startedAt: Date.now() - 1000 };
  await f.store.initializeSession({ sessionId: "host", initialize: { kind: "VERIFIED_HISTORY", evidence: { sessionId: "host", kind: "fixture" }, starts: [{ ...start }, { ...start }] } });
  const initial = await f.store.inspect("host");
  assert.equal(initial.used, 1);
  assert.equal(Object.keys(initial.admissions).length, 1);
  const before = await fs.readFile(f.ledger);
  assert.equal((await f.runtime.observeCommandHistory(f.ctx)).status, "VERIFIED");
  assert.deepEqual(await fs.readFile(f.ledger), before);
});
