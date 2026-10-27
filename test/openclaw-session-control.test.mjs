import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildPlugin } from "../lib/plugin-builder.mjs";
import { withTestReviewProof } from "./helpers/review-proof.mjs";
import { createSessionProjects, registerProjectCommand } from "../lib/openclaw/session-projects.mjs";
import { createSessionControl, registerSessionControl } from "../lib/openclaw/session-control.mjs";

const config = defaults => `version: 2\n${defaults ?? ""}artifacts: []\ndynamicGroundTruth:\n  enabled: true\n  materialRoots: []\n  panel:\n    size: 0\nstopCorrection:\n  enabled: false\n`;

async function fixture(t, defaults, version = "2026.7.1-2") {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rc-session-control-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "project"), stateDir = path.join(root, "state");
  await fs.mkdir(path.join(projectRoot, ".runtime-corrector"), { recursive: true });
  await fs.mkdir(stateDir);
  const configPath = path.join(projectRoot, ".runtime-corrector/config.yaml");
  await fs.writeFile(configPath, config(defaults));
  const entries = new Map(), commands = new Map(), methods = new Map();
  const api = { id: "runtime-corrector", config: {}, pluginConfig: {}, logger: { info() {} }, runtime: {
    version, state: { resolveStateDir: () => stateDir },
    sandbox: { resolveSandboxRuntimeStatus: () => ({ sandboxed: false }) }, agent: {
      resolveAgentWorkspaceDir: () => projectRoot,
      session: { getSessionEntry: ({ sessionKey }) => entries.get(sessionKey), resolveStorePath: () => path.join(stateDir, "sessions.json") },
    },
  }, registerCommand(command) { commands.set(command.name, command); },
  registerGatewayMethod(name, callback, options) { methods.set(name, { callback, options }); } };
  const projects = createSessionProjects(api), reconciled = [];
  const runtime = { projects, async reconcileSessionControl(ctx) { reconciled.push(ctx.sessionId); return projects.resolve({}, ctx); } };
  const control = createSessionControl(runtime);
  const session = id => {
    entries.set(`agent:main:${id}`, { sessionId: id, spawnedCwd: projectRoot });
    return { agentId: "main", sessionId: id, sessionKey: `agent:main:${id}`, workspaceDir: projectRoot,
      isAuthorizedSender: true, gatewayClientScopes: ["operator.admin"] };
  };
  return { api, projects, runtime, control, root, projectRoot, configPath, session, entries, commands, methods, reconciled };
}

test("Session status is read-only and defaults are saved only on enrollment", async t => {
  const f = await fixture(t, "sessionDefaults:\n  enabled: false\n"), a = f.session("a");
  const before = await f.control.get(a);
  assert.equal(before.requestedEnabled, false);
  assert.equal(before.effectiveEnabled, false);
  assert.equal(before.registered, false);
  await assert.rejects(fs.access(before.settingsFile), { code: "ENOENT" });
  await f.projects.ensure(await f.projects.resolve({}, a));
  assert.equal((await f.control.get(a)).registered, true);
  await fs.writeFile(f.configPath, config("sessionDefaults:\n  enabled: true\n"));
  assert.equal((await f.control.get(a)).requestedEnabled, false);
  assert.equal((await f.control.get(f.session("b"))).requestedEnabled, true);
  await assert.rejects(fs.access(path.join(f.projectRoot, ".runtime-correction")), { code: "ENOENT" });
});

test("Session set is idempotent, reconciles immediately, and preserves other Sessions", async t => {
  const f = await fixture(t), a = f.session("a"), b = f.session("b");
  await Promise.all([f.control.set(a, false), f.control.set(b, true)]);
  const result = await f.control.set(a, false);
  assert.equal(result.effectiveEnabled, false);
  assert.equal(result.reason, "RC_SESSION_DISABLED");
  assert.equal((await f.control.get(b)).effectiveEnabled, true);
  assert.notEqual(result.recordKey, (await f.control.get(b)).recordKey);
  assert(f.reconciled.includes("a"));
  assert.equal((await f.control.set(a, true)).effectiveEnabled, true);
});

test("Project and plugin total switches override saved Session preferences", async t => {
  const f = await fixture(t), a = f.session("a");
  await f.control.set(a, true);
  await fs.writeFile(f.configPath, config("enabled: false\n"));
  const off = await f.control.get(a);
  assert.equal(off.requestedEnabled, true);
  assert.equal(off.effectiveEnabled, false);
  assert.equal(off.reason, "RC_PROJECT_DISABLED");
  await assert.rejects(f.control.set(a, true), /RC_PROJECT_DISABLED/);
  await fs.writeFile(f.configPath, config());
  assert.equal((await f.control.get(a)).effectiveEnabled, true);
  f.api.pluginConfig.enabled = false;
  assert.equal((await f.control.get(a)).reason, "RC_PLUGIN_DISABLED");
  await assert.rejects(f.control.set(a, true), /RC_PLUGIN_DISABLED/);
  assert.equal((await f.control.set(a, false)).requestedEnabled, false);
});

test("User writes require authority, booleans and the exact current Session incarnation", async t => {
  const f = await fixture(t), a = f.session("a");
  await assert.rejects(f.control.set({ ...a, gatewayClientScopes: ["operator.read"] }, false), /权限/);
  await assert.rejects(f.control.get({ ...a, isAuthorizedSender: false }), /权限/);
  await assert.rejects(f.control.set(a, "false"), /布尔值/);
  f.entries.get(a.sessionKey).sessionId = "replacement";
  await assert.rejects(f.control.set(a, false), /HOST_SESSION_REPLACED_OR_MISSING/);
  assert.equal((await f.control.get(a)).effectiveEnabled, false);
});

test("Malformed or missing configuration never causes a Session write to overwrite it", async t => {
  const f = await fixture(t), a = f.session("a");
  const saved = await f.control.set(a, true);
  const invalid = "version: 1\nsessions:\n  broken:\n    enabled: nope\n";
  await fs.writeFile(saved.settingsFile, invalid);
  assert.equal((await f.control.get(a)).effectiveEnabled, false);
  await assert.rejects(f.control.set(a, false));
  assert.equal(await fs.readFile(saved.settingsFile, "utf8"), invalid);
  await fs.rm(f.configPath);
  await assert.rejects(f.control.set(a, true), /RC_PROJECT_NOT_ENABLED/);
});

test("User command and scoped UI methods use the same current-Session control", async t => {
  const f = await fixture(t), a = f.session("a");
  registerSessionControl(f.api, f.runtime);
  const command = f.commands.get("rc-session");
  assert.equal(JSON.parse((await command.handler({ ...a, args: "off" })).text).effectiveEnabled, false);
  assert.match((await command.handler({ ...a, args: "apply" })).text, /用法/);
  const client = { connect: { role: "operator", scopes: ["operator.read", "operator.write"] } };
  const params = { sessionKey: a.sessionKey, sessionId: a.sessionId };
  async function call(name, value = params, actor = client) {
    let result;
    await f.methods.get(`runtime-corrector.session.${name}`).callback({ params: value, client: actor,
      respond: (...args) => { result = args; } });
    return result;
  }
  assert.equal(f.methods.get("runtime-corrector.session.set").options.scope, "operator.write");
  assert.equal((await call("set", { ...params, enabled: true }))[1].effectiveEnabled, true);
  assert.equal((await call("get"))[1].requestedEnabled, true);
  assert.equal((await call("set", { ...params, enabled: false, workspaceDir: f.root }))[0], false);
  assert.equal((await call("set", { ...params, enabled: false }, { connect: { role: "operator", scopes: ["operator.read"] } }))[0], false);
  assert.equal((await call("set", { ...params, sessionId: "stale", enabled: false }))[0], false);
  assert.equal((await f.control.get(a)).effectiveEnabled, true);
});

for (const version of ["2026.7.1-2", "2026.10.3"]) {
  test(`${version} resolves Session settings from the host-selected project`, async t => {
    const f = await fixture(t, "sessionDefaults:\n  enabled: false\n", version), a = f.session("a");
    assert.equal((await f.control.get(a)).reason, "RC_SESSION_DISABLED");
    const on = await f.control.set(a, true);
    assert.equal(on.projectRoot, f.projectRoot);
    assert.equal(on.source, "host");
    assert.equal(on.effectiveEnabled, true);
    assert.equal((await f.projects.command({ ...a, args: "status" })).sessionEnabled, true);
    assert.equal((await f.control.set(a, false)).effectiveEnabled, false);
  });
}

test("packaged runtime and UI control share actual files and resume the original task", async t => {
  const f = await fixture(t, "sessionDefaults:\n  enabled: false\n"), a = f.session("a");
  const pluginRoot = await buildPlugin({ host: "openclaw", sourceRoot: path.resolve("."), outputRoot: path.join(f.root, "build") });
  const { createOpenClawRuntime } = await import(pathToFileURL(path.join(pluginRoot, "lib/openclaw/runtime.mjs")));
  const { findTask, withTaskState } = await import(pathToFileURL(path.join(pluginRoot, "lib/runtime-v2/task-store.mjs")));
  const messages = [{ type: "session", id: a.sessionId }, { type: "message", id: "user", parentId: null,
    message: { role: "user", content: "Write a draft." } }];
  const transcripts = new Map([[a.sessionKey, messages]]);
  const sessionFile = path.join(f.root, "session.jsonl");
  await fs.writeFile(sessionFile, messages.map(JSON.stringify).join("\n"));
  f.entries.get(a.sessionKey).sessionFile = sessionFile;
  f.api.runtime.agent.session.resolveSessionFilePath = (_id, entry) => entry.sessionFile;
  f.api.runtime.agent.session.runWithWorkAdmission = async (params, callback) => callback(params.signal);
  f.api.runtime.agent.runEmbeddedAgent = () => assert.fail("Session control must not execute business work.");
  f.api.logger.warn = () => {};
  let modelCalls = 0;
  const sharedState = {};
  const runtime = createOpenClawRuntime(f.api, { pluginRoot, sharedState, nativeHooks: true,
    compatibility: async () => ({ loadTranscriptEvents: ({ sessionKey }) => transcripts.get(sessionKey) }), reviewerFactory: async params => {
      modelCalls++;
      return withTestReviewProof(params, { sessionId: "review", result: {
        summary: "No changes", taskClassification: "CONTINUATION", operations: [],
      }, close: async () => {} });
    } });
  const control = createSessionControl(runtime);
  await runtime.sessionStart({}, a);
  registerProjectCommand(f.api, runtime.projects, ctx => runtime.reconcileSessionControl(ctx));
  registerSessionControl(f.api, runtime);
  assert.equal((await control.get(a)).registered, true);
  assert.equal(sharedState.states.size, 0);
  assert.equal(modelCalls, 0);
  await control.set(a, true);
  const ctx = { ...a, runId: "one-run" };
  await runtime.prompt({ prompt: "Write a draft." }, ctx);
  await runtime.beforeTool({ toolName: "write", toolCallId: "first", params: { path: "draft.md" } }, ctx);
  const first = sharedState.states.get("main:a");
  assert(first);
  const target = { projectRoot: f.projectRoot, sessionId: a.sessionId, explicitTaskId: first.scopeTaskId };
  await withTaskState({ projectRoot: f.projectRoot, taskId: first.scopeTaskId }, task => { task.stop.correctionAttempts = 2; });
  const b = { ...f.session("b"), runId: "peer-run" };
  const peerMessages = [{ type: "session", id: b.sessionId }, { type: "message", id: "peer-user", parentId: null,
    message: { role: "user", content: "Write another draft." } }];
  const peerFile = path.join(f.root, "peer.jsonl");
  await fs.writeFile(peerFile, peerMessages.map(JSON.stringify).join("\n"));
  f.entries.get(b.sessionKey).sessionFile = peerFile;
  transcripts.set(b.sessionKey, peerMessages);
  await control.set(b, true);
  await runtime.prompt({ prompt: "Write another draft." }, b);
  await runtime.beforeTool({ toolName: "write", toolCallId: "peer-first", params: { path: "peer.md" } }, b);
  const peer = sharedState.states.get("main:b");
  assert(peer);
  await control.set(a, false);
  assert.equal(first.abortSignal.aborted, true);
  assert.equal(sharedState.states.has("main:a"), false);
  assert.equal(sharedState.states.get("main:b"), peer);
  assert.equal(peer.abortSignal.aborted, false);
  await control.set(a, true);
  await runtime.beforeTool({ toolName: "write", toolCallId: "resumed", params: { path: "draft.md" } }, ctx);
  assert.equal(sharedState.states.get("main:a").scopeTaskId, first.scopeTaskId);
  assert.equal((await findTask(target)).stop.correctionAttempts, 2);
  const liveBeforeDefault = sharedState.states.get("main:a");
  const defaultResult = await f.commands.get("rc-session-default").handler({ ...a, args: "off" });
  assert.equal(JSON.parse(defaultResult.text).sessionDefaultEnabled, false);
  assert.equal(sharedState.states.get("main:a"), liveBeforeDefault);
  assert.equal(sharedState.states.get("main:b"), peer);
  await fs.writeFile(f.configPath, config("enabled: false\n"));
  assert.equal((await control.get(a)).reason, "RC_PROJECT_DISABLED");
  assert.equal(sharedState.states.size, 0);
  assert.equal(peer.abortSignal.aborted, true, "project total off also stops the already-enabled peer");
  assert.equal((await findTask(target)).stop.correctionAttempts, 2);
  const projectCommand = f.commands.get("rc-project");
  assert.equal(JSON.parse((await projectCommand.handler({ ...a, args: "on" })).text).projectEnabled, true);
  await runtime.beforeTool({ toolName: "write", toolCallId: "project-resumed-a", params: { path: "draft.md" } }, ctx);
  await runtime.beforeTool({ toolName: "write", toolCallId: "project-resumed-b", params: { path: "peer.md" } }, b);
  const activeA = sharedState.states.get("main:a"), activeB = sharedState.states.get("main:b");
  assert(activeA && activeB);
  assert.equal(activeA.scopeTaskId, first.scopeTaskId);
  assert.equal(JSON.parse((await projectCommand.handler({ ...a, args: "off" })).text).projectEnabled, false);
  assert.equal(sharedState.states.size, 0, "the project command immediately pauses all live peer sessions");
  assert.equal(activeA.abortSignal.aborted, true);
  assert.equal(activeB.abortSignal.aborted, true);
  assert.equal((await findTask(target)).stop.correctionAttempts, 2);
});
