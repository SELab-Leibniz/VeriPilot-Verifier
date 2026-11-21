import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createPostRunDispatcher } from "../lib/openclaw/post-run-dispatch.mjs";
import { createSessionRuntimeStatus, SESSION_RUNTIME_SCHEMA, sessionRuntimeKey,
  readSessionRuntimeStatus, sessionRuntimeStatusPath } from "../lib/openclaw/session-runtime-status.mjs";
import { refreshSessionRuntimeStatus, terminateSessionCorrection } from "../lib/openclaw/session-runtime-client.mjs";
import { registerSessionRuntimeControls } from "../lib/openclaw/session-runtime-controls.mjs";

const execute = promisify(execFile);
const rootDir = fileURLToPath(new URL("../", import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, label) {
  const end = Date.now() + 8000;
  while (Date.now() < end) { const value = await read(); if (value) return value; await pause(10); }
  throw new Error(`Timed out: ${label}`);
}
async function fixture(t, { terminal = async () => ({ status: "ok" }), review } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rc-runtime-status-")));
  const states = new Map(), pausedScopes = new Map(), cancelled = [], dispatched = [], reviewing = [];
  let service;
  const manager = createPostRunDispatcher({ directoryFor: () => path.join(root, "host"), validate: async () => true,
    waitTerminal: terminal,
    review: review ?? (async (record, { signal }) => {
      reviewing.push(record.runId);
      return new Promise(resolve => {
        const finish = () => resolve({ reviewStatus: "CANCELLED" });
        if (signal.aborted) finish(); else signal.addEventListener("abort", finish, { once: true });
      });
    }),
    cancelRound: async (record, runId, reason) => {
      cancelled.push({ sessionId: record.sessionId, runId, reason, stopId: record.correctionStopId });
      const state = states.get(record.sessionId);
      state.reviewController.abort(Object.assign(new Error(reason), { code: reason }));
    },
    sendUser: async (record, task) => {
      dispatched.push({ sessionId: record.sessionId, text: task.text, runId: task.runId });
      const state = states.get(record.sessionId);
      state.nativeRunId = task.runId; state.reviewController = new AbortController();
      await manager.started(record, task.runId);
      return { runId: task.runId };
    },
    onChange: record => service?.onPostRun(record),
  });
  service = createSessionRuntimeStatus({ states, pausedScopes, dispatcher: () => manager, stopJobs: () => [],
    heartbeatMs: 60000, logger: { warn() {} },
    resolveScope: async identity => ({ identity, projectRoot: root, projectEnabled: true, sessionEnabled: true, enabled: true }),
    terminate: async ({ record, actor }) => manager.confirmCancel(record, { actor, runId: record.runId, version: record.version }),
  });
  t.after(async () => { await manager.dispose(); await service.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  async function session(id) {
    const identity = { projectRoot: root, agentId: "main", sessionId: id, sessionKey: `agent:main:${id}`,
      scopeFingerprint: `scope-${id}`, scopeTaskId: `task-${id}` };
    const state = { ...identity, nativeRunId: `run-${id}`, projectScope: { fingerprint: identity.scopeFingerprint,
      projectEnabled: true, sessionEnabled: true }, reviewController: new AbortController() };
    states.set(id, state);
    await manager.started(identity, state.nativeRunId);
    service.track(state); await service.flush();
    return { identity, state };
  }
  const refresh = async identity => service.refresh({ ...identity, actor: "test-owner" });
  return { root, manager, service, states, cancelled, dispatched, reviewing, session, refresh };
}

test("a project status file isolates Sessions and cancellation ends only its round before queued users continue", async t => {
  const f = await fixture(t), a = await f.session("a"), b = await f.session("b");
  for (const { identity, state } of [a, b]) await f.manager.candidate(identity, {
    runId: state.nativeRunId, text: "Done", reviewBudgetMs: 30000, terminalBudgetMs: 1000,
  });
  await until(() => f.reviewing.length === 2, "both reviews start");
  await f.manager.defer(a.identity, { sourceId: "first", text: "first user task" });
  await f.manager.defer(a.identity, { sourceId: "second", text: "second user task" });
  const before = await f.refresh(a.identity), other = await f.refresh(b.identity);
  assert.equal(before.status, "RUNNING"); assert.equal(before.phase, "REVIEWING");
  assert.equal(before.pendingUserTasks, 2); assert.equal(before.ended, false);
  const data = JSON.parse(await fs.readFile(sessionRuntimeStatusPath(f.root), "utf8"));
  assert.equal(data.schemaVersion, SESSION_RUNTIME_SCHEMA); assert.equal(Object.keys(data.sessions).length, 2);
  assert.equal(other.sessionId, "b");
  const stopped = await f.service.terminate({ ...a.identity, roundId: before.roundId, actor: "test-owner" });
  assert.equal(stopped.target.status, "TERMINATED"); assert.equal(stopped.target.ended, true);
  assert.equal(stopped.target.roundId, before.roundId);
  assert.deepEqual(f.dispatched.map(r => r.text), ["first user task"]);
  assert.equal(f.cancelled.length, 1); assert.equal(f.cancelled[0].sessionId, "a");
  assert.equal(b.state.reviewController.signal.aborted, false);
  assert.equal((await f.refresh(b.identity)).status, "RUNNING");
  assert.equal(stopped.current.sessionEnabled, true); assert.equal(stopped.current.effectiveEnabled, true);
  assert.notEqual(stopped.current.roundId, before.roundId);
  assert.equal(stopped.current.lastEndedRound.roundId, before.roundId);
  const repeated = await f.service.terminate({ ...a.identity, roundId: before.roundId, actor: "test-owner" });
  assert.equal(repeated.alreadyEnded, true); assert.equal(f.cancelled.length, 1);
  assert.equal(a.state.reviewController.signal.aborted, false, "the next user run must retain its live controller");
  await assert.rejects(f.service.terminate({ ...a.identity, roundId: "f".repeat(64), actor: "test-owner" }), { code: "CONFLICT" });
  await f.manager.candidate(a.identity, { runId: "run-a", text: "late old end", reviewBudgetMs: 5000 });
  assert.equal(f.reviewing.filter(id => id === "run-a").length, 1);
  const firstRun = a.state.nativeRunId;
  await f.manager.candidate(a.identity, { runId: firstRun, text: "first user done", needsReview: false, reviewBudgetMs: 5000 });
  await until(() => f.dispatched.length === 2, "second queued user starts");
  await f.manager.candidate(a.identity, { runId: a.state.nativeRunId, text: "second user done", reviewBudgetMs: 5000 });
  await until(() => f.reviewing.includes(a.state.nativeRunId), "the next user round still starts correction");
});

test("new rounds do not inherit previous outcomes and timeout settlement records an ended unverified round", async t => {
  let signalReviewStarted;
  const entered = new Promise(resolve => { signalReviewStarted = resolve; });
  let finishReview;
  const f = await fixture(t, { review: async () => {
    signalReviewStarted();
    return new Promise(resolve => { finishReview = resolve; });
  } });
  const a = await f.session("timeout");
  // First reproduce a real preceding STOP_NOT_REQUIRED round.
  await f.manager.candidate(a.identity, { runId: a.state.nativeRunId, text: "No changes", needsReview: false, reviewBudgetMs: 5000 });
  await f.manager.drain();
  assert.equal((await f.refresh(a.identity)).outcome, "DISABLED");
  const oldRun = a.state.nativeRunId;
  a.state.nativeRunId = "timeout-new-run";
  a.state.reviewController = new AbortController();
  await f.manager.started(a.identity, a.state.nativeRunId);
  const running = await f.refresh(a.identity);
  assert.notEqual(running.runId, oldRun);
  assert.equal(running.ended, false);
  assert.equal(running.outcome, null, "an old DISABLED result must not describe a new running round");
  await f.manager.candidate(a.identity, { runId: a.state.nativeRunId, text: "Delivered", reviewBudgetMs: 5000 });
  await entered;
  f.service.reviewStarted(a.state, "timeout-private-review", { role: "stop-reviewer" });
  const reviewing = await f.refresh(a.identity);
  assert.equal(reviewing.stage, "stop-reviewer");
  assert.equal(reviewing.outcome, null);
  assert.equal(reviewing.running, true);
  f.service.reviewEnded(a.state, "timeout-private-review");
  f.service.settled(a.state, a.state.nativeRunId, { reviewStatus: "UNVERIFIED", reasonCode: "STOP_REVIEW_DEADLINE" });
  const settling = await f.refresh(a.identity);
  assert.equal(settling.outcome, "UNVERIFIED");
  assert.equal(settling.ended, false, "settlement still has to drain before ending the round");
  finishReview({ reviewStatus: "UNVERIFIED", reasonCode: "STOP_DEADLINE_EXPIRED" });
  await f.manager.drain();
  const ended = await f.refresh(a.identity);
  assert.equal(ended.roundId, running.roundId);
  assert.equal(ended.status, "ENDED"); assert.equal(ended.ended, true);
  assert.equal(ended.active, false); assert.equal(ended.running, false); assert.equal(ended.canTerminate, false);
  assert.equal(ended.outcome, "UNVERIFIED"); assert.equal(ended.reasonCode, "STOP_DEADLINE_EXPIRED");
  assert.equal(ended.sessionEnabled, true); assert.equal(ended.effectiveEnabled, true);
  assert.ok(ended.endedAt); assert.equal(ended.lastEndedRound.roundId, ended.roundId);
});

test("status queries do not create files, reject mismatched Session targets, and expose explicit reviewer stages", async t => {
  const f = await fixture(t);
  const missing = await readSessionRuntimeStatus({ projectRoot: f.root, sessionKey: "agent:main:none", sessionId: "none" });
  assert.equal(missing.status, "NOT_REGISTERED"); assert.equal(missing.ended, null);
  await assert.rejects(fs.access(path.join(f.root, ".runtime-correction")), { code: "ENOENT" });
  const a = await f.session("a");
  f.service.reviewStarted(a.state, "private-review-1", { role: "onboarding-extractor" });
  const active = await f.refresh(a.identity);
  assert.equal(active.stage, "onboarding-extractor"); assert.equal(active.running, true);
  f.service.reviewEnded(a.state, "private-review-1");
  assert.equal((await f.refresh(a.identity)).running, false);
  await assert.rejects(f.service.get({ ...a.identity, projectRoot: path.join(f.root, "foreign") }), { code: "CONFLICT" });
});

test("stopping an owned correction stays STOPPING until its exact host terminal, then continues the queued user", async t => {
  let terminalKnown = false;
  const correctionRunId = `rc-stop-${"a".repeat(64)}`;
  const f = await fixture(t, { terminal: async (_record, runId) => ({ status: runId === correctionRunId && !terminalKnown ? "timeout" : "ok" }) });
  const a = await f.session("a");
  await f.manager.candidate(a.identity, { runId: a.state.nativeRunId, text: "Done", reviewBudgetMs: 30000 });
  await until(() => f.reviewing.length === 1, "review starts before its corrective continuation");
  await f.manager.correction(a.identity, correctionRunId, Date.now() + 30000, "exact-stop", a.state.nativeRunId);
  a.state.nativeRunId = correctionRunId; a.state.reviewController = new AbortController();
  await f.manager.started(a.identity, correctionRunId);
  await f.manager.defer(a.identity, { sourceId: "queued", text: "next user" });
  const before = await f.refresh(a.identity);
  const stopping = await f.service.terminate({ ...a.identity, roundId: before.roundId, actor: "test-owner" });
  assert.equal(stopping.target.ended, false); assert.equal(stopping.current.status, "STOPPING");
  assert.equal(f.dispatched.length, 0); assert.equal(f.cancelled[0].stopId, "exact-stop");
  const repeated = await f.service.terminate({ ...a.identity, roundId: before.roundId, actor: "test-owner" });
  assert.equal(repeated.alreadyRequested, true); assert.equal(f.cancelled.length, 1);
  terminalKnown = true;
  const record = f.manager.get(a.identity);
  await f.manager.recheck(a.identity, { actor: "test-owner", runId: record.runId, version: record.version });
  await until(() => f.dispatched.length === 1, "host terminal releases next queued task");
  const after = await f.refresh(a.identity);
  assert.equal(after.lastEndedRound.roundId, before.roundId);
  assert.equal(after.lastEndedRound.status, "TERMINATED");
});

test("RPC controls require authenticated scopes and exact identity; callers cannot supply an actor", async t => {
  const f = await fixture(t), a = await f.session("a"), methods = new Map();
  registerSessionRuntimeControls({ registerGatewayMethod: (name, handler) => methods.set(name, handler) },
    { sessionRuntime: f.service, postRunReady: Promise.resolve() });
  const call = async (action, params, scopes) => {
    let response;
    await methods.get(`runtime-corrector.runtime.${action}`)({ params, client: { connect: { role: "operator", scopes } },
      respond: (ok, result, error) => { response = { ok, result, error }; } });
    return response;
  };
  const identity = Object.fromEntries(["projectRoot", "sessionId", "sessionKey", "agentId"].map(k => [k, a.identity[k]]));
  await f.service.flush();
  assert.equal((await call("list", {}, [])).error.code, "FORBIDDEN");
  const listed = await call("list", {}, ["operator.read"]);
  assert.deepEqual(listed.result.sessions.map(row => row.sessionId), [identity.sessionId]);
  assert.equal(listed.result.sessions[0].owner, undefined);
  assert.equal((await call("list", identity, ["operator.read"])).ok, false);
  assert.equal((await call("get", identity, [])).error.code, "FORBIDDEN");
  assert.equal((await call("get", identity, ["operator.read"])).ok, true);
  assert.equal((await call("refresh", identity, ["operator.read"])).error.code, "FORBIDDEN");
  assert.equal((await call("terminate", { ...identity, roundId: "a".repeat(64), actor: "spoofed" }, ["operator.write"])).ok, false);
  assert.equal((await call("get", { ...identity, agentId: "foreign" }, ["operator.read"])).ok, false);
  assert.equal((await call("get", { ...identity, sessionKey: "agent:main:runtime-corrector:private" }, ["operator.read"])).ok, false);
});

async function deadPid() {
  const child = spawn(process.execPath, ["-e", ""], { windowsHide: true, stdio: "ignore" });
  const pid = child.pid; await new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
  return pid;
}
test("offline self-check recognizes an exited owner and persists interruption without claiming PASS", async t => {
  const f = await fixture(t), a = await f.session("a");
  await f.service.dispose();
  const file = sessionRuntimeStatusPath(f.root), data = JSON.parse(await fs.readFile(file, "utf8"));
  const row = data.sessions[sessionRuntimeKey(a.identity)];
  Object.assign(row, { status: "RUNNING", phase: "REVIEWING", active: true, running: true, ended: false,
    endedAt: null, heartbeatExpiresAt: Date.now() - 1000, owner: { pid: await deadPid(), token: "dead-owner" } });
  await fs.writeFile(file, JSON.stringify(data));
  assert.equal((await readSessionRuntimeStatus(a.identity)).status, "UNKNOWN");
  let networkCalls = 0;
  const refreshed = await refreshSessionRuntimeStatus(a.identity, { request: async () => { networkCalls++; throw new Error("Gateway closed"); } });
  assert.equal(networkCalls, 0, "an exited owner is settled immediately instead of waiting for a Gateway timeout");
  assert.equal(refreshed.status, "INTERRUPTED"); assert.equal(refreshed.ended, true);
  assert.equal(refreshed.outcome, "UNVERIFIED"); assert.equal(refreshed.reasonCode, "RC_OWNER_EXITED");
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).sessions[sessionRuntimeKey(a.identity)].status, "INTERRUPTED");
});

test("an unresponsive live PID remains UNKNOWN and termination never retries or retargets a lost request", async t => {
  const f = await fixture(t), a = await f.session("a");
  await f.service.flush();
  const file = sessionRuntimeStatusPath(f.root), data = JSON.parse(await fs.readFile(file, "utf8"));
  data.sessions[sessionRuntimeKey(a.identity)].heartbeatExpiresAt = Date.now() - 1;
  await fs.writeFile(file, JSON.stringify(data));
  const unknown = await refreshSessionRuntimeStatus(a.identity, { request: async () => { throw new Error("Gateway timeout"); } });
  assert.equal(unknown.status, "UNKNOWN"); assert.equal(unknown.ended, null);
  let calls = 0, target;
  await assert.rejects(terminateSessionCorrection({ ...a.identity, roundId: unknown.roundId }, { request: async (_method, params) => {
    calls++; target = params.roundId; throw new Error("Acknowledgement lost");
  } }), /Acknowledgement lost/u);
  assert.equal(calls, 1); assert.equal(target, unknown.roundId);
  const dataAfterUnknown = JSON.parse(await fs.readFile(file, "utf8"));
  dataAfterUnknown.sessions[sessionRuntimeKey(a.identity)].owner.pid = await deadPid();
  await fs.writeFile(file, JSON.stringify(dataAfterUnknown));
  const exitedLater = await refreshSessionRuntimeStatus(a.identity, { request: async () => { throw new Error("Gateway closed"); } });
  assert.equal(exitedLater.status, "INTERRUPTED", "UNKNOWN must remain recoverable when its process later exits");
  assert.equal(exitedLater.ended, true);
});

test("standalone scripts emit JSON, bind the queried round and reject corrupt status without repairing it", async t => {
  const f = await fixture(t), a = await f.session("a");
  const args = ["--project-root", f.root, "--session-key", a.identity.sessionKey, "--session-id", a.identity.sessionId];
  const response = await execute(process.execPath, [path.join(rootDir, "scripts/rc-status.mjs"), ...args], { windowsHide: true });
  assert.equal(JSON.parse(response.stdout).result.roundId, (await f.refresh(a.identity)).roundId);
  const host = path.join(f.root, "fake-host"), capture = path.join(f.root, "host-command.json");
  await fs.mkdir(host);
  await fs.writeFile(path.join(host, "package.json"), JSON.stringify({ name: "openclaw", version: "2026.7.1-2", type: "module" }));
  await fs.writeFile(path.join(host, "openclaw.mjs"), `import fs from "node:fs/promises";
const args = process.argv.slice(2), params = JSON.parse(args[args.indexOf("--params") + 1]);
await fs.writeFile(${JSON.stringify(capture)}, JSON.stringify({ args, params, config: process.env.OPENCLAW_CONFIG_PATH }));
console.log(JSON.stringify(args[2].endsWith("terminate") ? { accepted: true, target: { roundId: params.roundId, ended: true } } : { status: "WAITING", ...params }));
`);
  const roundId = (await f.refresh(a.identity)).roundId;
  const refreshed = await execute(process.execPath, [path.join(rootDir, "scripts/rc-refresh.mjs"), ...args,
    "--openclaw-root", host, "--config", path.join(f.root, "isolated-openclaw.json")], { windowsHide: true });
  assert.equal(JSON.parse(refreshed.stdout).result.status, "WAITING");
  const terminated = await execute(process.execPath, [path.join(rootDir, "scripts/rc-terminate.mjs"), ...args,
    "--round-id", roundId, "--openclaw-root", host], { windowsHide: true });
  assert.equal(JSON.parse(terminated.stdout).result.target.roundId, roundId);
  const invoked = JSON.parse(await fs.readFile(capture, "utf8"));
  assert.equal(invoked.params.roundId, roundId);
  assert.equal(invoked.args[2], "runtime-corrector.runtime.terminate");
  const file = sessionRuntimeStatusPath(f.root);
  await f.service.dispose(); await fs.writeFile(file, "{broken");
  try { await execute(process.execPath, [path.join(rootDir, "scripts/rc-status.mjs"), ...args], { windowsHide: true }); assert.fail("must reject corrupt JSON"); }
  catch (error) { assert.equal(error.code, 1); assert.equal(JSON.parse(error.stdout).ok, false); }
  assert.equal(await fs.readFile(file, "utf8"), "{broken");
});

test("a writable status snapshot cannot choose the executable or host configuration", async t => {
  const f = await fixture(t), a = await f.session("a");
  const file = sessionRuntimeStatusPath(f.root), data = JSON.parse(await fs.readFile(file, "utf8"));
  data.sessions[sessionRuntimeKey(a.identity)].gateway = { hostEntry: path.join(f.root, "malicious/openclaw.mjs"), configPath: "malicious-config" };
  await fs.writeFile(file, JSON.stringify(data));
  const host = path.join(f.root, "trusted-host"); await fs.mkdir(host);
  await fs.writeFile(path.join(host, "package.json"), JSON.stringify({ name: "openclaw", version: "2026.7.1-2" }));
  let invocation;
  await terminateSessionCorrection(a.identity, { openclawRoot: host, configPath: path.join(f.root, "trusted.json"),
    executeHost: async (binary, args, options) => { invocation = { binary, args, options }; return { stdout: '{"accepted":true}' }; } });
  assert.equal(invocation.args[0], path.join(host, "openclaw.mjs"));
  assert.equal(invocation.options.env.OPENCLAW_CONFIG_PATH, path.join(f.root, "trusted.json"));
  assert.equal(invocation.options.windowsHide, true);
});

test("live termination rechecks a forged ended snapshot instead of skipping an active correction", async t => {
  const f = await fixture(t), a = await f.session("a");
  const file = sessionRuntimeStatusPath(f.root), data = JSON.parse(await fs.readFile(file, "utf8"));
  const row = data.sessions[sessionRuntimeKey(a.identity)], roundId = row.roundId;
  Object.assign(row, { ended: true, status: "TERMINATED", active: false, reasonCode: "USER_CONFIRMED_CANCEL" });
  await fs.writeFile(file, JSON.stringify(data));
  const result = await f.service.terminate({ ...a.identity, roundId, actor: "test-owner" });
  assert.equal(f.cancelled.length, 1); assert.equal(result.target.ended, true);
});

test("a linked state directory is rejected without writing to another project", async t => {
  const f = await fixture(t), external = path.join(f.root, "external"), project = path.join(f.root, "linked-project");
  await fs.mkdir(external); await fs.mkdir(project);
  try { await fs.symlink(external, path.join(project, ".runtime-correction"), process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (error.code === "EPERM") { t.skip("Directory links are unavailable."); return; } throw error; }
  await assert.rejects(readSessionRuntimeStatus({ projectRoot: project, sessionKey: "agent:main:linked", sessionId: "linked" }), { code: "RC_STATUS_PATH_UNSAFE" });
  assert.deepEqual(await fs.readdir(external), []);
});
