import test from "node:test";
import assert from "node:assert/strict";
import { createNativeReviewerRunner } from "../lib/openclaw/compat-2026.10.3.mjs";

function fixture() {
  const entries = new Map(), calls = [], writes = [], removals = [];
  const api = { runtime: { agent: { session: {
    resolveStorePath: () => "/host/agents/main/sessions/sessions.json",
    getSessionEntry: ({ sessionKey }) => entries.get(sessionKey),
    async upsertSessionEntry(params) { writes.push(params); entries.set(params.sessionKey, params.entry); },
  }, runEmbeddedAgent: async params => { calls.push(params); return { payloads: [{ text: '{"ok":true}' }] }; } } } };
  const load = async () => ({ formatSessionMarker: value => `sqlite:${value.agentId}:${value.sessionId}:${value.storePath}`,
    async deleteSessionEntry(params) {
      removals.push(params);
      if (entries.get(params.sessionKey)?.sessionId === params.expectedSessionId) entries.delete(params.sessionKey);
    } });
  const runner = createNativeReviewerRunner(api, load);
  const params = { sessionId: "private-reviewer", sessionKey: "agent:main:runtime-corrector:private-reviewer", agentId: "main",
    sessionFile: "/project/.runtime-correction/request/session.jsonl", workspaceDir: "/project", cwd: "/project", config: {},
    provider: "test", model: "test", timeoutMs: 10000, toolsAllow: ["read"], abortSignal: new AbortController().signal };
  return { entries, calls, writes, removals, runner, params };
}

test("new host reviewers use registered exact SQLite identities and retain the same session for repairs", async () => {
  const f = fixture();
  await f.runner(f.params); await f.runner({ ...f.params, prompt: "Repair only the schema" });
  assert.equal(f.writes.length, 1); assert.equal(f.calls.length, 2);
  for (const call of f.calls) {
    assert.equal(call.sessionFile, "sqlite:main:private-reviewer:/host/agents/main/sessions/sessions.json");
    assert.deepEqual(call.sessionTarget, { agentId: "main", sessionId: "private-reviewer", sessionKey: f.params.sessionKey,
      storePath: "/host/agents/main/sessions/sessions.json" });
    assert.equal(call.timeoutMs, f.params.timeoutMs); assert.deepEqual(call.toolsAllow, ["read"]);
    assert.equal(call.cwd, "/project");
  }
  await f.runner.close(f.params.sessionKey, f.params.sessionId);
  assert.equal(f.entries.size, 0); assert.equal(f.removals[0].expectedSessionId, f.params.sessionId);
});

test("native transport cannot target business sessions, borrow another reviewer or run after cancellation", async () => {
  const f = fixture();
  await assert.rejects(f.runner({ ...f.params, sessionKey: "agent:main:business" }), /IDENTITY_REQUIRED/);
  f.entries.set(f.params.sessionKey, { sessionId: f.params.sessionId });
  await assert.rejects(f.runner(f.params), /SESSION_CONFLICT/);
  f.entries.clear();
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.runner({ ...f.params, abortSignal: controller.signal }));
  assert.equal(f.writes.length, 0); assert.equal(f.calls.length, 0);
});

test("cleanup is conditional on the exact private incarnation and preserves a replaced entry", async () => {
  const f = fixture(); await f.runner(f.params);
  f.entries.set(f.params.sessionKey, { sessionId: "replacement" });
  await f.runner.close(f.params.sessionKey, f.params.sessionId);
  assert.equal(f.entries.get(f.params.sessionKey).sessionId, "replacement");
});
