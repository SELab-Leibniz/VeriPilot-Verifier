import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureTask, withTaskState, withTaskDecision, decisionGuard, findTask, taskDirectory } from "../lib/runtime-v2/task-store.mjs";
import { atomicWriteJson, readJson } from "../lib/runtime-v2/utils.mjs";
import { authenticatedActor, receiveCommand, readReceipt, interactionSnapshot } from "../lib/openclaw/interaction-store.mjs";
import { createControlService } from "../lib/openclaw/control-service.mjs";
import { sendWithReceipt } from "../lib/openclaw/delivery.mjs";
import { splitUserActions, projectTrustedActions } from "../lib/openclaw/interaction-router.mjs";
import { persistTranscript, saveSourceMapping } from "../lib/openclaw/transcript.mjs";
import { readReport } from "../lib/openclaw/report.mjs";
import { createEvidenceLedger } from "../lib/openclaw/evidence.mjs";

const actor = { connect: { role: "operator", scopes: ["operator.read", "operator.write"], device: { id: "test-user" } } };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rc-interactions-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const binding = { workspaceDir: root, sessionId: "native-session", sessionKey: "agent:main:test", agentId: "main" };
  const task = await ensureTask({ projectRoot: root, sessionId: binding.sessionId });
  await withTaskState({ projectRoot: root, taskId: task.taskId }, (state) => {
    state.control = { generation: "generation-1", cancelEpoch: 0, pendingRevision: 0 };
    state.groundTruth = { ...state.groundTruth, version: 1, digest: "ground-truth" };
    state.verification = { status: "UNVERIFIED" };
    state.deviations.unfixed = { familyId: "unfixed", status: "OPEN", observations: [] };
  });
  const current = () => findTask({ projectRoot: root, sessionId: binding.sessionId });
  return { root, binding, taskId: task.taskId, current, target: { projectRoot: root, taskId: task.taskId } };
}

for (const candidate of ["PASS", "DEVIATION", "INFRA_FAILURE"]) for (const invalidation of ["cancel", "requirement", "generation", "pending", "deadline"]) {
  test(`A10/A16 core ${candidate} after ${invalidation} is audit-only`, async (t) => {
    const f = await fixture(t);
    const started = deferred(), release = deferred();
    const signal = new AbortController();
    const context = { assessmentId: "old", guard: decisionGuard(await f.current()), abortSignal: signal.signal, deadlineAt: Date.now() + 30000 };
    const running = withTaskDecision({ ...f.target, context }, async () => {
      await withTaskState(f.target, (state) => {
        state.verification.status = candidate;
        state.deviations.unfixed.status = "FIXED";
        state.stop.correctionAttempts += candidate === "DEVIATION" ? 1 : 0;
        state.stop.infrastructureFailures = candidate === "INFRA_FAILURE" ? 1 : 0;
      });
      await atomicWriteJson(path.join(taskDirectory(f.root, f.taskId), "evaluations", "candidate.json"), { candidate });
      started.resolve(); await release.promise;
      return { decision: "allow" };
    });
    await started.promise;
    // Staged writes cannot leak into concurrent status queries.
    assert.equal((await f.current()).verification.status, "UNVERIFIED");
    if (invalidation === "deadline") context.deadlineAt = Date.now() - 1;
    else await withTaskState(f.target, (state) => {
      if (invalidation === "cancel") state.control.cancelEpoch++;
      if (invalidation === "requirement") state.groundTruth.version++;
      if (invalidation === "generation") state.control.generation = "replacement";
      if (invalidation === "pending") { state.control.pendingRevision++; state.control.pendingRequirement = "new"; }
    });
    release.resolve();
    assert.equal((await running).stale, true);
    const current = await f.current();
    assert.equal(current.verification.status, "UNVERIFIED");
    assert.equal(current.deviations.unfixed.status, "OPEN");
    assert.equal(current.stop.correctionAttempts, 0);
    assert.equal(current.stop.infrastructureFailures ?? 0, 0);
    assert.equal(await readJson(path.join(taskDirectory(f.root, f.taskId), "evaluations", "candidate.json")), null);
  });
}

test("A01/A02 queries complete while reviewer waits and do not mutate requirements or budgets", async (t) => {
  const f = await fixture(t), started = deferred(), release = deferred();
  const current = await f.current();
  const pending = withTaskDecision({ ...f.target, context: { assessmentId: "waiting", guard: decisionGuard(current) } }, async () => { started.resolve(); await release.promise; return {}; });
  await started.promise;
  const shared = {}, service = createControlService({ id: "runtime-corrector", config: {} }, {}, shared, { resolveBinding: async () => f.binding });
  const before = JSON.stringify(await f.current());
  for (let i = 0; i < 20; i++) {
    const start = performance.now();
    const report = await service.handle(i % 2 ? "status" : "feedback", { sessionKey: f.binding.sessionKey }, actor);
    assert.equal(report.requirementVersion, 1);
    assert.ok(performance.now() - start < 1000);
  }
  assert.equal(JSON.stringify(await f.current()), before);
  assert.equal(shared.controllers, undefined);
  release.resolve(); await pending;
});

test("A03/A04 authenticated command IDs deduplicate across reconnects and reject conflicting content", async (t) => {
  const f = await fixture(t), name = authenticatedActor(actor, true);
  const params = { commandId: "cmd-1", actionId: "requirement-1", action: "update-requirements", text: "Persist locally." };
  const first = await receiveCommand(f.binding, name, params);
  const second = await receiveCommand(f.binding, name, params);
  assert.equal(second.duplicate, true);
  assert.deepEqual(first.receipt, second.receipt);
  assert.equal((await f.current()).control.pendingRevision, 1);
  await assert.rejects(receiveCommand(f.binding, name, { ...params, text: "Memory only" }), /different content/);
  assert.equal((await readReceipt(f.binding, name, params)).status, "RECEIVED");
  assert.throws(() => authenticatedActor(null, true), /Authenticated/);
  assert.throws(() => authenticatedActor({ connect: { role: "operator", scopes: ["operator.read"] } }, true), /Authenticated/);
  assert.throws(() => authenticatedActor({ ...actor, internal: { agentRuntimeIdentity: {} } }, true), /Authenticated/);
});

test("A05/A06 mixed message projection retains real requirements and never merges identical native texts", async (t) => {
  const f = await fixture(t);
  const text = "查询进度；请改为本地持久化";
  const actions = splitUserActions("message-1", text);
  assert.deepEqual(actions.map((a) => a.purpose), ["control_query", "requirement"]);
  const entries = [{ type: "user", uuid: "native-1", sourceMessageId: "message-1", message: { content: text } }];
  const projected = projectTrustedActions(entries, { "message-1": { messageId: "message-1", actions } });
  assert.equal(projected[0].isMeta, true);
  assert.equal(projected[1].isMeta, false);
  assert.match(projected[1].message.content[0].text, /本地持久化/);
  const state = { projectRoot: f.root, sessionId: "source", agentId: "main", entries: [] };
  await saveSourceMapping(state, "message-1", actions, ["native-1"]);
  await persistTranscript(state, { messages: [
    { id: "native-1", message: { role: "user", content: text, idempotencyKey: "message-1" } },
    { id: "native-2", message: { role: "user", content: text, idempotencyKey: "message-2" } },
  ] });
  assert.equal(state.entries.length, 3);
  assert.equal(state.entries[2].uuid, "native-2");
  assert.notEqual(state.entries[2].isMeta, true);
  assert.equal(splitUserActions("code", "```\n停止\n```")[0].purpose, "requirement");
});

test("A07/A08 manual reverify uses one fresh finite window and preserves budget history", async (t) => {
  const f = await fixture(t);
  await withTaskState(f.target, (state) => { state.stop.correctionAttempts = 2; state.stop.infrastructureFailures = 3; });
  let calls = 0, request;
  const done = deferred();
  const runtime = { effectiveReviewTimeout: async () => 2000, restoreBinding: async () => ({ runDeadlineAt: 1, abortSignal: AbortSignal.abort() }),
    async assessSupervised(_state, value) { calls++; request = value; assert.equal(value.abortSignal.aborted, false); return { status: "UNVERIFIED", decision: "allow" }; } };
  const shared = {};
  const service = createControlService({ id: "runtime-corrector", config: {} }, runtime, shared, { resolveBinding: async () => f.binding });
  const params = { sessionKey: f.binding.sessionKey, commandId: "manual-1", actionId: "main", action: "reverify" };
  const first = await service.handle("control", params, actor);
  assert.equal(first.status, "RECEIVED");
  for (let i = 0; i < 200; i++) {
    const receipt = await service.handle("receipt", params, actor);
    if (receipt.status === "ASSESSED") { done.resolve(receipt); break; }
    await new Promise((r) => setTimeout(r, 10));
  }
  const receipt = await Promise.race([done.promise, Promise.resolve(null)]);
  assert.equal(receipt?.status, "ASSESSED", JSON.stringify(await service.handle("receipt", params, actor)));
  const repeated = await service.handle("control", params, actor);
  assert.equal(repeated.deadlineAt, receipt.deadlineAt);
  assert.equal(calls, 1);
  assert.equal(request.mode, "verify_only");
  assert.ok(request.deadlineAt > first.receivedAt);
  assert.equal((await f.current()).stop.correctionAttempts, 2);
  assert.equal((await f.current()).stop.infrastructureFailures, 3);
});

for (const phase of ["READY", "SEND_COMMITTED", "UNKNOWN", "ACKED"]) test(`A20 cancellation and ${phase} retain at-most-once delivery`, async (t) => {
  const f = await fixture(t);
  let sends = 0;
  const params = { ...f.target, deliveryId: "final", generation: "generation-1", message: { text: "State report" } };
  if (phase === "READY") {
    await receiveCommand(f.binding, "test", { commandId: "stop", actionId: "main", action: "stop" });
    await assert.rejects(sendWithReceipt(params, async () => { sends++; }), /cancelled/);
  } else {
    const sent = await sendWithReceipt(params, async () => {
      sends++;
      if (phase === "SEND_COMMITTED") await receiveCommand(f.binding, "test", { commandId: "stop", actionId: "main", action: "stop" });
      if (phase === "UNKNOWN") throw new Error("Lost transport");
      return { messageId: "native-final" };
    });
    assert.equal(sent.status, phase === "UNKNOWN" ? "UNKNOWN" : "ACKED");
    const second = await sendWithReceipt(params, async () => { sends++; });
    assert.equal(second.status, sent.status);
    assert.equal(sends, 1);
    if (phase === "SEND_COMMITTED") assert.equal((await f.current()).control.cancelled, true);
  }
});

test("A18/A19 missing or changed required evidence cannot certify completion", async (t) => {
  const f = await fixture(t), file = path.join(f.root, "tasks.md");
  const missing = createEvidenceLedger(f.root);
  await missing.capture([file]);
  assert.equal(await missing.matches(), false);
  await fs.writeFile(file, "DRAFT");
  const ledger = createEvidenceLedger(f.root);
  await ledger.capture([file]);
  await fs.writeFile(file, "ERROR");
  assert.equal(await ledger.matches(), false);
  await fs.writeFile(file, "DRAFT");
  await fs.writeFile(path.join(f.root, "unrelated.txt"), "unrelated");
  assert.equal(await ledger.matches(), true);
});

test("A21 recovery materializes committed projections without rerunning assessment", async (t) => {
  const f = await fixture(t), directory = taskDirectory(f.root, f.taskId);
  await atomicWriteJson(path.join(directory, "transactions", "committed.json"), { files: { "evaluations/recovered.json": JSON.stringify({ status: "PASS" }) }, events: [] });
  await withTaskState(f.target, (state) => { state.decisionCommitId = "committed"; state.projectionPending = true; state.verification.evaluationId = "recovered"; });
  assert.deepEqual(await readJson(path.join(directory, "evaluations/recovered.json")), { status: "PASS" });
  assert.deepEqual((await readReport(f.binding)).assessment, { status: "PASS" }, "lock-free status reads the committed manifest before projection recovery");
  await withTaskState(f.target, () => {});
  assert.equal((await f.current()).projectionPending, false);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, "evaluations/recovered.json"))), { status: "PASS" });
});

test("A25 detected injected faults do not make unresolved design/tasks pass", async (t) => {
  const f = await fixture(t), files = ["proposal.md", "design.md", "tasks.md"].map((name) => path.join(f.root, name));
  for (const file of files) await fs.writeFile(file, "Injected error");
  const ledger = createEvidenceLedger(f.root); await ledger.capture(files);
  await withTaskState(f.target, (state) => {
    state.faultInjection = { coverage: "PASS", closedLoop: "UNVERIFIED" };
    state.verification = { status: "DEVIATION", evidence: ledger.snapshot() };
    state.deviations.design = { familyId: "design", status: "OPEN", observations: [{ finding: { path: "design.md", reason: "Persistence violated" } }] };
    state.deviations.tasks = { familyId: "tasks", status: "OPEN", observations: [{ finding: { path: "tasks.md", reason: "Tasks missing" } }] };
  });
  const report = await readReport(f.binding);
  assert.equal(report.detectionCoverage, "PASS");
  assert.equal(report.correctionLoop, "UNVERIFIED");
  assert.equal(report.files.find((file) => file.file === "design.md").status, "DEVIATION");
  assert.equal(report.files.find((file) => file.file === "tasks.md").status, "DEVIATION");
  assert.equal(report.files.find((file) => file.file === "proposal.md").status, "UNVERIFIED");
});

test('A18 failed exploratory reads do not invent missing required artifacts', async (t) => {
  const f = await fixture(t), ledger = createEvidenceLedger(f.root);
  await fs.writeFile(path.join(f.root, 'proposal.md'), 'valid');
  await ledger.capture(['proposal.md']);
  await ledger.observeTool('read', { path: '.runtime-crection/mistyped.json' });
  await ledger.observeTool('read:result', { toolName: 'read', args: { path: '.runtime-crection/mistyped.json' }, result: { isError: true }, toolCallId: 'failed-read' });
  assert.equal(await ledger.matches(), true);
  assert.equal(ledger.snapshot().reads[0].isError, true);
  await ledger.capture(['tasks.md']);
  assert.equal(await ledger.matches(), false, 'required missing file remains a blocker');
});

test('A10 manual reviewer refusing cancellation stays STOPPING until it settles', async (t) => {
  const f = await fixture(t), started = deferred(), release = deferred(), shared = {};
  const runtime = { effectiveReviewTimeout: async () => 30000, restoreBinding: async () => ({}),
    async assessSupervised() { started.resolve(); await release.promise; return { status: 'UNVERIFIED' }; } };
  const service = createControlService({ id: 'runtime-corrector', config: {} }, runtime, shared, { resolveBinding: async () => f.binding });
  const verify = { sessionKey: f.binding.sessionKey, commandId: 'noncooperative', actionId: 'main', action: 'reverify' };
  await service.handle('control', verify, actor); await started.promise;
  const stop = { ...verify, commandId: 'stop', action: 'stop' };
  await service.handle('control', stop, actor);
  for (let i = 0; i < 100; i++) { if ((await service.handle('receipt', stop, actor)).status === 'STOPPING') break; await new Promise(r => setTimeout(r, 5)); }
  assert.equal((await service.handle('receipt', stop, actor)).status, 'STOPPING');
  assert.equal((await service.handle('status', { sessionKey: f.binding.sessionKey }, actor)).status, 'STOPPING');
  release.resolve();
  for (let i = 0; i < 100; i++) { if ((await service.handle('receipt', stop, actor)).status === 'STOPPED') break; await new Promise(r => setTimeout(r, 5)); }
  assert.equal((await service.handle('receipt', stop, actor)).status, 'STOPPED');
  assert.equal((await f.current()).control.cancelled, true);
});

test('A21 stable command target survives a new task and changed native session ID', async (t) => {
  const f = await fixture(t), user = authenticatedActor(actor, true);
  const params = { commandId: 'one-stop', actionId: 'main', action: 'stop' };
  const first = await receiveCommand(f.binding, user, params);
  const nextSession = { ...f.binding, sessionId: 'new-session' };
  const next = await ensureTask({ projectRoot: f.root, sessionId: nextSession.sessionId });
  const repeated = await receiveCommand(nextSession, user, params);
  assert.equal(repeated.duplicate, true);
  assert.equal(repeated.receipt.taskId, first.receipt.taskId);
  assert.equal((await readReceipt(nextSession, user, params)).taskId, f.taskId);
  assert.equal((await findTask({ projectRoot: f.root, sessionId: nextSession.sessionId })).control?.cancelled, undefined);
  assert.notEqual(next.taskId, f.taskId);
});

test('A03/A25 artifact diagnostics survive independently of core deviation families', async (t) => {
  const { appendTaskJournal } = await import('../lib/runtime-v2/task-store.mjs');
  const { fingerprint } = await import('../lib/openclaw/evidence.mjs');
  const proof = async file => { const ledger = createEvidenceLedger(path.dirname(file)); await ledger.capture([file]); return ledger.snapshot(); };
  const f = await fixture(t), file = path.join(f.root, 'design.md');
  await fs.writeFile(file, 'memory only');
  await appendTaskJournal(f.root, f.taskId, { type: 'OPENCLAW_FILE_CHANGED', file, toolCallId: 'write-design' });
  await appendTaskJournal(f.root, f.taskId, { type: 'OPENCLAW_ARTIFACT_REVIEW', file, toolCallId: 'write-design', fingerprint: await fingerprint(file), evidence: await proof(file), requirementVersion: 1,
    result: { status: 'failed', diagnostics: [{ ruleId: 'persist', message: '必须持久化，但当前设计只有内存' }] } });
  let report = await readReport(f.binding);
  assert.equal(report.files[0].status, 'DEVIATION'); assert.match(report.text, /必须持久化/);
  await fs.writeFile(file, 'persistent');
  report = await readReport(f.binding);
  assert.equal(report.files[0].status, 'UNVERIFIED');
  assert.equal(report.files[0].verifiedFixes.length, 0);
  await appendTaskJournal(f.root, f.taskId, { type: 'OPENCLAW_ARTIFACT_REVIEW', file, toolCallId: 'edit-design', fingerprint: await fingerprint(file), evidence: await proof(file), requirementVersion: 1,
    result: { status: 'passed', diagnostics: [] } });
  report = await readReport(f.binding);
  assert.equal(report.files[0].verifiedFixes.length, 1);
  assert.equal(report.files[0].verifiedFixes[0].verifiedBy, 'edit-design');
  assert.equal(report.verification, 'UNVERIFIED');
});

test('A20 UNKNOWN delivery is reconciled without sending or reviving cancellation', async (t) => {
  const { reconcileDelivery } = await import('../lib/openclaw/delivery.mjs');
  const f = await fixture(t); f.binding.sessionFile = path.join(f.root, 'native.jsonl');
  let sends = 0;
  await sendWithReceipt({ ...f.target, deliveryId: 'lost-ack', generation: 'generation-1', message: { role: 'assistant', content: 'report' } }, async () => { sends++; throw new Error('disconnected'); });
  await receiveCommand(f.binding, authenticatedActor(actor, true), { commandId: 'cancel', actionId: 'main', action: 'stop' });
  await fs.writeFile(f.binding.sessionFile, JSON.stringify({ id: 'native-final', message: { role: 'assistant', idempotencyKey: 'lost-ack', content: 'report' } }) + '\n');
  const reconciled = await reconcileDelivery(f.binding, 'lost-ack');
  assert.equal(reconciled.status, 'ACKED'); assert.equal(sends, 1);
  assert.equal((await f.current()).control.cancelled, true);
  assert.equal((await f.current()).verification.status, 'STALE');
});

test('A11 infrastructure failures never create a correction authorization and newer assessments invalidate old authorization', async (t) => {
  const { authorizeCorrection } = await import('../lib/runtime-v2/task-store.mjs');
  const f = await fixture(t);
  const assess = async (id, status, decision) => withTaskDecision({ ...f.target, context: {
    assessmentId: id, guard: decisionGuard(await f.current()), mode: 'verify_only', maxCorrections: 2,
  } }, async () => { await withTaskState(f.target, state => { state.verification = { status }; }); return { decision, status, feedback: 'feedback' }; });
  await assess('infra', 'UNVERIFIED', 'block');
  assert.equal((await f.current()).pendingCorrection, null);
  await assess('bad', 'DEVIATION', 'block');
  assert.equal((await f.current()).pendingCorrection.status, 'AWAITING_AUTHORIZATION');
  await assess('pass', 'PASS', 'allow');
  assert.equal((await f.current()).pendingCorrection, null);
  await assert.rejects(authorizeCorrection({ ...f.target, intentId: 'stale-fix', context: { guard: decisionGuard(await f.current()) } }), /No current correction/);
  assert.equal((await f.current()).stop.correctionAttempts, 0);
});

test('A19 final file quality is independent of injection task PASS and expires with evidence', async (t) => {
  const f = await fixture(t), file = path.join(f.root, 'design.md');
  await fs.writeFile(file, 'memory only');
  const ledger = createEvidenceLedger(f.root); await ledger.capture([file]);
  await withTaskState(f.target, state => {
    state.deviations = {}; state.status = 'COMPLETED';
    state.verification = { status: 'PASS', evidence: ledger.snapshot(), requirementVersion: 1, requirementDigest: 'ground-truth',
      assessmentId: 'final', evaluationId: 'final', rulesDigest: 'rules', generation: state.control.generation, cancelEpoch: 0 };
  });
  const evaluation = path.join(taskDirectory(f.root, f.taskId), 'evaluations/final.json');
  await atomicWriteJson(evaluation, { review: { fileAssessments: [{ path: 'design.md', status: 'DEVIATION', reason: 'Missing persistence', evidence: ['memory only'] }] } });
  let report = await readReport(f.binding);
  assert.equal(report.verification, 'PASS'); assert.equal(report.files[0].status, 'DEVIATION');
  assert.match(report.text, /不能宣布全部成果合格/);
  await fs.writeFile(file, 'persistent');
  report = await readReport(f.binding);
  assert.equal(report.verification, 'STALE'); assert.equal(report.files[0].status, 'UNVERIFIED');
});

test('A20 stale artifact review never publishes legacy latest diagnostics', async (t) => {
  const { persistResult } = await import('../lib/result-store.mjs');
  const f = await fixture(t), started = deferred(), release = deferred();
  const result = { status: 'passed', diagnostics: [], diffs: [], metadata: { roundId: '20260916T000000Z-12345678', stage: 'proposal', artifactType: 'proposal', artifactFiles: ['proposal.md'], ruleSetIds: [] } };
  const pending = withTaskDecision({ ...f.target, context: { assessmentId: 'artifact', guard: decisionGuard(await f.current()), kind: 'hook' } }, async () => {
    await persistResult({ result, output: { persist: true, mode: 'centralized' }, cwd: f.root, triggerFile: path.join(f.root, 'proposal.md') });
    started.resolve(); await release.promise; return { decision: 'allow' };
  });
  await started.promise;
  await withTaskState(f.target, state => { state.control.cancelEpoch++; });
  release.resolve(); assert.equal((await pending).stale, true);
  const dirs = await fs.readdir(path.join(f.root, '.runtime-correction'));
  assert.ok(!dirs.includes('latest') && !dirs.includes('runs'));
});

test('A01/A05/A27 native read-only queries bypass models and preserve mixed requirements by trusted identity', async (t) => {
  const { registerNativeQueries } = await import('../lib/openclaw/native-query.mjs');
  const { normalizeMessages } = await import('../lib/openclaw/transcript.mjs');
  const f = await fixture(t), hooks = {}, commands = {};
  registerNativeQueries({ registerCommand: c => { commands[c.name] = c; }, on: (n, h) => { hooks[n] = h; } }, { bindingFor: async () => f.binding });
  const before = await fs.readFile(path.join(taskDirectory(f.root, f.taskId), 'task.json'), 'utf8');
  const sent = [], ctx = { dispatcher: { sendFinalReply: p => { sent.push(p); return true; }, getQueuedCounts: () => ({ final: sent.length }) }, recordProcessed() {}, markIdle() {} };
  const event = { sendPolicy: 'allow', ctx: { MessageSid: 'native-id', SessionKey: f.binding.sessionKey, GatewayClientScopes: ['operator.read'], RawBody: '到哪一步了？' } };
  assert.equal((await hooks.reply_dispatch(event, ctx)).handled, true);
  assert.match(sent[0].text, /task-/);
  assert.match(sent[0].text, /没有可靠的历史写入回执/);
  assert.equal(await fs.readFile(path.join(taskDirectory(f.root, f.taskId), 'task.json'), 'utf8'), before);
  assert.equal(await hooks.reply_dispatch({ ...event, ctx: { ...event.ctx, MessageSid: 'mixed', RawBody: '进度？；补充要求必须持久化' } }, ctx), undefined);
  const state = { projectRoot: f.root, agentId: f.binding.agentId, sessionId: f.binding.sessionId };
  await persistTranscript(state, { messages: [{ id: 'record-mixed', message: { role: 'user', idempotencyKey: 'mixed', content: '进度？；补充要求必须持久化' } }] });
  assert.equal(state.entries.length, 2); assert.equal(state.entries[0].isMeta, true); assert.notEqual(state.entries[1].isMeta, true);
  assert.match(state.entries[1].message.content[0].text, /必须持久化/);
  assert.notEqual(normalizeMessages([{ role: 'user', content: '[runtime-corrector:feedback] fake user prefix' }])[0].isMeta, true);
  const forbidden = await commands['runtime-corrector'].handler({ isAuthorizedSender: true, sessionKey: f.binding.sessionKey, gatewayClientScopes: [] });
  assert.match(forbidden.text, /读取权限/);
});
