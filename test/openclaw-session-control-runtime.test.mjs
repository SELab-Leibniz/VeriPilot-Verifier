import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { buildPlugin } from "../lib/plugin-builder.mjs";
import { withTestReviewProof } from "./helpers/review-proof.mjs";
import { sha256 } from "../lib/runtime-v2/utils.mjs";

let build, pluginRoot, createRuntime, findTask, withTaskState;
before(async () => {
  build = await fs.mkdtemp(path.join(os.tmpdir(), "rc-control-runtime-build-"));
  pluginRoot = await buildPlugin({ host: "openclaw", sourceRoot: path.resolve("."), outputRoot: build });
  ({ createOpenClawRuntime: createRuntime } = await import(pathToFileURL(path.join(pluginRoot, "lib/openclaw/runtime.mjs"))));
  ({ findTask, withTaskState } = await import(pathToFileURL(path.join(pluginRoot, "lib/runtime-v2/task-store.mjs"))));
});
after(() => fs.rm(build, { recursive: true, force: true }));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function fixture(t, { stop = false, waitMode = "assessment", review, reviewClosed } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rc-control-runtime-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, ".runtime-corrector"));
  await fs.writeFile(path.join(root, ".runtime-corrector/config.yaml"), `version: 2
artifacts:
  - name: draft
    stage: proposal
    patterns: [draft.md]
    rules:
      enabled: false
    review:
      enabled: false
dynamicGroundTruth:
  enabled: true
  materialRoots: []
  panel:
    size: 0
stopCorrection:
  enabled: ${stop}
  waitMode: ${waitMode}
  waitTimeoutMs: 20000
  assessmentTimeoutMs: 15000
implementationCorrection:
  enabled: false
`);
  await fs.writeFile(path.join(root, "draft.md"), "A delivered draft.\n");
  const selections = new Map(), tasks = new Map(), entries = new Map(), sharedState = {}, warnings = [], deactivated = [];
  const hostAbort = new AbortController();
  let calls = 0;
  const factory = async params => {
    calls++;
    let result;
    if (params.schema.properties.operations) result = { summary: "No change", taskClassification: "CONTINUATION", operations: [] };
    else {
      await review?.(params);
      result = { summary: "Done", stopClassification: "TASK_COMPLETE", findings: [],
        metricObjectJudgements: Object.values(params.request.population?.metrics ?? {}).flat().map(object => ({
          objectId: object.objectId, judgement: "PASS", reason: "Current source", evidence: ["draft.md:1"] })) };
    }
    return withTestReviewProof(params, { result, sessionId: "review", close: async () => {
      if (params.schema.properties.metricObjectJudgements) await reviewClosed?.();
    } });
  };
  factory.handoff = async ({ originHandle, ...input }) => { await originHandle?.close(); return factory(input); };
  const projects = {
    async resolve(event = {}, ctx = {}) {
      const identity = { agentId: ctx.agentId ?? "main", sessionId: ctx.sessionId ?? event.sessionId, sessionKey: ctx.sessionKey ?? event.sessionKey };
      const enabled = selections.get(identity.sessionId) !== false;
      return { identity, projectRoot: root, executionDirectory: root, fingerprint: root, enabled,
        configValid: true, projectEnabled: true, sessionEnabled: enabled, controlDisabled: !enabled,
        reason: enabled ? null : "RC_SESSION_DISABLED" };
    },
    async ensure(scope) { return scope; },
    async activate(scope) {
      const id = scope.identity.sessionId;
      if (!tasks.has(id)) tasks.set(id, `oc-scope-${id}`);
      return { taskId: tasks.get(id) };
    },
    async deactivate(scope) { deactivated.push(scope); tasks.delete(scope.identity.sessionId); },
  };
  const api = { id: "runtime-corrector", pluginConfig: {}, config: {}, logger: { warn: m => warnings.push(m) },
    runtime: { version: "2026.7.1-2", agent: { runEmbeddedAgent() { assert.fail("Business execution must stay native."); },
      session: { getSessionEntry: async ({ sessionKey }) => entries.get(sessionKey), resolveStorePath: () => path.join(root, "sessions.json"),
        resolveSessionFilePath: (_id, entry) => entry.sessionFile, runWithWorkAdmission: async (params, callback) => callback(params.signal) } } } };
  const options = { pluginRoot, projectScopes: projects, sharedState, reviewerFactory: factory, nativeHooks: true };
  const runtime = createRuntime(api, options);
  async function session(id) {
    const ctx = { agentId: "main", sessionId: id, sessionKey: `agent:main:${id}`, runId: `${id}-run`, workspaceDir: root, abortSignal: hostAbort.signal };
    const sessionFile = path.join(root, `${id}.jsonl`);
    await fs.writeFile(sessionFile, [{ type: "session", id }, { type: "message", id: `${id}-u`, parentId: null,
      message: { role: "user", content: "Write a draft." } }].map(JSON.stringify).join("\n"));
    entries.set(ctx.sessionKey, { sessionId: id, sessionFile });
    await runtime.prompt({ prompt: "Write a draft." }, ctx);
    await runtime.beforeTool({ toolName: "write", toolCallId: `${id}-initial`, params: { path: "draft.md" } }, ctx);
    return ctx;
  }
  const task = ctx => findTask({ projectRoot: root, sessionId: ctx.sessionId, explicitTaskId: tasks.get(ctx.sessionId) });
  async function set(ctx, enabled) { selections.set(ctx.sessionId, enabled); return runtime.reconcileSessionControl(ctx); }
  const restartState = {};
  return { root, api, runtime, projects, sharedState, restartState, warnings, deactivated, hostAbort, session, task, set, selections,
    calls: () => calls, restart: () => createRuntime(api, { ...options, sharedState: restartState }) };
}

test("Session off/on restores its task and budget, admits its first new tool, and leaves peers alone", async t => {
  const f = await fixture(t), a = await f.session("a"), b = await f.session("b");
  const before = await f.task(a), peer = f.sharedState.states.get("main:b");
  await withTaskState({ projectRoot: f.root, taskId: before.taskId }, task => {
    task.stop.correctionAttempts = 2;
    task.correctionEpoch.id = 3;
  });
  await f.runtime.beforeTool({ toolName: "write", toolCallId: "old", params: { path: "draft.md" } }, a);
  const old = f.sharedState.states.get("main:a");
  await f.set(a, false);
  assert.equal(old.abortSignal.aborted, true);
  assert.equal(f.sharedState.states.has("main:a"), false);
  assert.equal(peer.abortSignal.aborted, false);
  assert.equal(f.hostAbort.signal.aborted, false);
  await f.runtime.beforeTool({ toolName: "write", toolCallId: "while-off", params: { path: "draft.md" } }, a);
  await f.set(a, true);
  await f.runtime.beforeTool({ toolName: "write", toolCallId: "fresh", params: { path: "draft.md" } }, a);
  const current = f.sharedState.states.get("main:a");
  assert.equal(current.scopeTaskId, old.scopeTaskId);
  assert.notEqual(current, old);
  const result = id => f.runtime.toolResult({ toolName: "write", toolCallId: id, args: { path: "draft.md" }, result: { content: [] } }, { runtime: "openclaw" });
  await result("old"); await result("while-off"); await result("fresh");
  assert.equal(current.seen.has("post:old"), false);
  assert.equal(current.seen.has("post:while-off"), false);
  assert.equal(current.seen.has("post:fresh"), true);
  const after = await f.task(a);
  assert.equal(after.taskId, before.taskId);
  assert.equal(after.stop.correctionAttempts, 2);
  assert.equal(after.correctionEpoch.id, 3);
  assert.equal(f.deactivated.length, 0);
  assert.equal(f.sharedState.states.get("main:b"), peer);
  const restarted = f.restart();
  await restarted.beforeTool({ toolName: "write", toolCallId: "restart-first", params: { path: "draft.md" } }, a);
  await restarted.toolResult({ toolName: "write", toolCallId: "restart-first", args: { path: "draft.md" }, result: { content: [] } }, { runtime: "openclaw" });
  assert.equal(f.restartState.states.get("main:a").seen.has("post:restart-first"), true);
  assert.equal((await f.task(a)).taskId, before.taskId);
});

for (const waitMode of ["assessment", "until_pass"]) test(`${waitMode}: disabling in-flight Stop cannot terminalize its task or publish late PASS`, async t => {
  const started = deferred(), finish = deferred();
  const f = await fixture(t, { stop: true, waitMode, review: async () => { started.resolve(); await finish.promise; } });
  const ctx = await f.session("late");
  const payload = { text: "Delivered." };
  await f.runtime.reply({ kind: "final", runId: ctx.runId, sessionKey: ctx.sessionKey, payload }, ctx);
  await started.promise;
  const before = await f.task(ctx);
  await f.set(ctx, false);
  const stopped = await f.task(ctx);
  assert.equal(stopped.status, before.status);
  assert.deepEqual(stopped.verification, before.verification);
  assert.equal(stopped.stop.correctionAttempts, before.stop.correctionAttempts);
  finish.resolve();
  const records = await f.runtime.waitForNativeReviews({ drain: true, settle: true });
  assert(records.every(record => record.reviewStatus === "CANCELLED"));
  const after = await f.task(ctx);
  assert.equal(after.status, before.status);
  assert.deepEqual(after.verification, before.verification);
  assert(!f.warnings.some(message => /本次纠偏检查未完成|RC_REVIEW_UNVERIFIED/.test(message)));
  assert.equal(f.hostAbort.signal.aborted, false);
});

test("same-run off/on starts a fresh Stop review without reusing its cancelled checkpoint", async t => {
  let reviews = 0;
  const started = deferred(), finish = deferred();
  const f = await fixture(t, { stop: true, waitMode: "until_pass", review: async () => {
    if (++reviews === 1) { started.resolve(); await finish.promise; }
  } });
  const ctx = await f.session("same-run");
  await f.runtime.reply({ kind: "final", runId: ctx.runId, sessionKey: ctx.sessionKey, payload: { text: "First delivery." } }, ctx);
  await started.promise;
  await f.set(ctx, false);
  await f.set(ctx, true);
  await f.runtime.beforeTool({ toolName: "write", toolCallId: "new-write", params: { path: "draft.md" } }, ctx);
  const current = f.sharedState.states.get("main:same-run");
  await f.runtime.reply({ kind: "final", runId: ctx.runId, sessionKey: ctx.sessionKey, payload: { text: "New delivery." } }, ctx);
  finish.resolve();
  const records = await f.runtime.waitForNativeReviews({ drain: true, settle: true });
  assert.equal(records.length, 2);
  assert.equal(records[0].reviewStatus, "CANCELLED");
  assert.equal(records[1].reviewStatus, "PASS", JSON.stringify(records));
  assert.equal(current.abortSignal.aborted, false, "late cancellation cannot abort the reopened controller");
});

test("manual control changes are rechecked before a completed review can commit", async t => {
  let changed = false;
  const f = await fixture(t, { stop: true, reviewClosed: async () => {
    changed = true;
    f.selections.set("manual", false);
  } });
  const ctx = await f.session("manual"), before = await f.task(ctx);
  await f.runtime.reply({ kind: "final", runId: ctx.runId, sessionKey: ctx.sessionKey, payload: { text: "Delivered." } }, ctx);
  await f.runtime.waitForNativeReviews({ drain: true, settle: true });
  assert.equal(changed, true, "the file-equivalent change occurs after the reviewer returned");
  const after = await f.task(ctx);
  assert.deepEqual(after.verification, before.verification);
  assert.equal(after.stop.correctionAttempts, before.stop.correctionAttempts);
  assert.equal(after.status, before.status);
});

test("cleanup failure still cancels RC and allows later recovery without a new task or budget", async t => {
  const f = await fixture(t), ctx = await f.session("cleanup-error"), before = await f.task(ctx);
  await withTaskState({ projectRoot: f.root, taskId: before.taskId }, task => { task.stop.correctionAttempts = 2; });
  const old = f.sharedState.states.get("main:cleanup-error");
  const receiptDirectory = path.join(f.root, ".runtime-correction/openclaw/native-followups", sha256([ctx.sessionKey, ctx.sessionId]));
  await fs.mkdir(receiptDirectory, { recursive: true });
  const brokenReceipt = path.join(receiptDirectory, "broken.json");
  await fs.writeFile(brokenReceipt, "{invalid JSON");

  const locked = deferred(), release = deferred();
  const holding = withTaskState({ projectRoot: f.root, taskId: before.taskId }, async () => {
    locked.resolve(); await release.promise;
  });
  await locked.promise;
  const rejected = assert.rejects(f.set(ctx, false), SyntaxError);
  try {
    // Keep the independent metadata write pending while retire encounters the
    // corrupt receipt first. The test runner reports any unhandled rejection.
    const deadline = Date.now() + 1000;
    while (f.sharedState.states.has(old.key) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(old.scopeClosed, true);
    assert.equal(old.abortSignal.aborted, true);
    assert.equal(f.sharedState.states.has(old.key), false);
    await new Promise(resolve => setTimeout(resolve, 25));
  } finally {
    release.resolve(); await holding;
  }
  await rejected;
  await fs.rm(brokenReceipt);

  await f.set(ctx, true);
  await f.runtime.beforeTool({ toolName: "write", toolCallId: "after-cleanup-error", params: { path: "draft.md" } }, ctx);
  const after = await f.task(ctx);
  assert.equal(after.taskId, before.taskId);
  assert.equal(after.stop.correctionAttempts, 2);
  assert.equal(f.sharedState.states.get(old.key).abortSignal.aborted, false);
  assert.equal(f.deactivated.length, 0);

  // A later real reset must finish lifecycle cleanup even when a previous
  // control request reported a receipt error.
  await fs.writeFile(brokenReceipt, "{invalid JSON");
  await assert.rejects(f.set(ctx, false), SyntaxError);
  assert.equal(f.sharedState.pausedScopes.has(old.key), true);
  await f.runtime.reset({}, ctx);
  assert.equal(f.sharedState.pausedScopes.has(old.key), false);
  assert.equal(f.deactivated.length, 1);
});
