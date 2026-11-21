import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPostRunDispatcher } from "../lib/openclaw/post-run-dispatch.mjs";
import { registerPostRunControls } from "../lib/openclaw/post-run-controls.mjs";
import { ensureTask, withTaskState } from '../lib/runtime-v2/task-store.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rc-dispatch-controls-"));
  const manager = createPostRunDispatcher({ directoryFor: () => root, validate: async () => true,
    waitTerminal: async () => ({ status: "ok" }), review: async () => ({ reviewStatus: "PASS" }), sendUser: async () => {} });
  t.after(async () => { await manager.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  const identity = { agentId: "main", sessionKey: "agent:main:a", sessionId: "a", projectRoot: root, scopeFingerprint: "scope" };
  await manager.started(identity, "run");
  const record = manager.snapshot(identity), methods = new Map(), routes = [];
  let current = true;
  registerPostRunControls({ config: {}, logger: { warn() {} }, registerGatewayMethod: (name, handler) => methods.set(name, handler),
    registerHttpRoute: route => routes.push(route) }, { postRuns: manager, postRunReady: Promise.resolve(), validatePostSession: async () => current },
    { compatibility: async () => ({ browserClient: "native-client.js", version: "fixture" }) });
  async function request(action, params = {}, scopes = ["operator.read", "operator.write"]) {
    const handler = methods.get(`runtime-corrector.dispatch.${action}`);
    if (!handler) return { ok: false, error: { code: "METHOD_NOT_FOUND" } };
    let response;
    await handler({ params, client: { connect: { role: "operator", scopes } },
      respond: (ok, value, error) => { response = { ok, value, error }; } });
    return response;
  }
  return { manager, record, routes, request, invalidate: () => { current = false; } };
}

test("control RPC requires authenticated scopes and exact identity, and has no user task writes", async t => {
  const f = await fixture(t);
  assert.equal((await f.request("list", {}, [])).error.code, "FORBIDDEN");
  assert.equal((await f.request("get", { ...f.record, sessionId: "foreign" })).error.code, "CONFLICT");
  assert.equal((await f.request("recheck", f.record, ["operator.read"])).error.code, "FORBIDDEN");
  for (const action of ["add", "edit", "remove"]) assert.equal((await f.request(action, f.record)).error.code, "METHOD_NOT_FOUND");
  f.invalidate();
  assert.equal((await f.request("cancel", f.record)).error.code, "CONFLICT");
});

test('selected-session requirements expose pending input separately from a previous review baseline', async t => {
  const f = await fixture(t), task = await ensureTask({ projectRoot: f.record.projectRoot, sessionId: f.record.sessionId });
  await withTaskState({ projectRoot: f.record.projectRoot, taskId: task.taskId }, state => {
    state.groundTruth.version = 2; state.groundTruth.pendingUserCursor = 'new-user';
  });
  const pending = await f.request('get', f.record);
  assert.deepEqual(pending.value.requirements, { version: 2, pending: true, pendingUserCursor: 'new-user' });
  await withTaskState({ projectRoot: f.record.projectRoot, taskId: task.taskId }, state => {
    state.groundTruth.version = 3; state.groundTruth.pendingUserCursor = null;
  });
  assert.deepEqual((await f.request('get', f.record)).value.requirements, { version: 3, pending: false, pendingUserCursor: null });
});

test("session search covers all records before pagination and isolates same project sessions", async t => {
  const f = await fixture(t);
  for (const name of ["a-2", "b-1", "b-2"]) await f.manager.started({ ...f.record, sessionId: name, sessionKey: `agent:main:${name}` }, name);
  const result = await f.request("list", { search: "b-", offset: 1, limit: 1 });
  assert.equal(result.value.total, 2); assert.equal(result.value.sessions.length, 1);
  assert.match(result.value.sessions[0].sessionKey, /b-/u);
  assert.equal((await f.request("list", { filter: "pending" })).value.total, 0);
  assert.equal((await f.request("list", { limit: 101 })).ok, false);
});

test('observation RPC preserves read scopes and exact session identity', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('observations', f.record, [])).error.code, 'FORBIDDEN');
  assert.equal((await f.request('observations', { ...f.record, sessionId: 'foreign' })).error.code, 'CONFLICT');
  assert.equal((await f.request('observations', { ...f.record, query: { limit: 101 } })).ok, false);
  const data = await f.request('observations', f.record, ['operator.read']);
  assert.equal(data.ok, true); assert.equal(data.value.total, 0);
});

test("control route serves only packaged assets and verified browser-client capabilities", async t => {
  const f = await fixture(t), route = f.routes[0];
  assert.equal(route.auth, "plugin");
  async function get(suffix, method = "GET") {
    const headers = {}, res = { statusCode: 200, setHeader: (k, v) => { headers[k] = v; }, end: text => { res.body = String(text ?? ""); } };
    assert.equal(await route.handler({ method, url: `/plugins/runtime-corrector${suffix}` }, res), true);
    return { ...res, headers };
  }
  const page = (await get("/")).body;
  assert.match(page, /MA 输入框状态栏预览/u);
  assert.match(page, /停止本轮纠偏/u);
  assert.doesNotMatch(page, /加入待办|安全解除/u);
  assert.match((await get("/post-run.mjs")).body, /runtime-corrector\.runtime\.terminate/u);
  assert.equal(JSON.parse((await get("/capabilities.json")).body).browserClient, "/assets/native-client.js");
  assert.equal((await get("/../runtime.mjs")).statusCode, 404);
  assert.equal((await get("/", "POST")).statusCode, 405);
  assert.equal((await get("/")).headers["Cache-Control"], "no-store");
});
