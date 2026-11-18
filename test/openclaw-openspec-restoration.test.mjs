import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assessOpenSpecPlanRestoration, approvedApplyRepairCurrent, approvedInventoryForApply,
  beginOpenSpecRun, hasApprovedApplyInventory, inspectArmedOpenSpecApply, observeApprovedApplyRepairStart, openSpecApplyFinding,
  openSpecRestorationFeedbackCurrent, PLAN_RESTORATION_PURPOSE, readApprovedOpenSpecRestoration,
  registerOpenSpecPlanControl, reserveApprovedApplyRepair } from '../lib/openclaw/openspec-plan-control.mjs';
import { recordProposalCoverage } from '../lib/openclaw/approved-plan-coverage.mjs';
import { nativeTranscriptObservation } from '../lib/openclaw/native-transcript.mjs';
import { createOriginalSourceAnchor } from '../lib/runtime-v2/original-source-anchor.mjs';
import { transcriptUserMessages } from '../lib/runtime-v2/original-requirements.mjs';
import { createStopCorrectionStore } from '../lib/runtime-v2/stop-correction-store.mjs';
import { sha256 } from '../lib/runtime-v2/utils.mjs';

const changeName = 'retain-display-options', prefix = `openspec/changes/${changeName}`;
const taskText = '# Tasks\n\n- [ ] Retain the saved order.\n- [ ] Retain the saved filter.\n';
const completedTasks = taskText.replaceAll('[ ]', '[x]');
const originalText = 'Retain the saved order.\nRetain the saved filter.';
const applyText = 'Implement the approved display change.';
const record = (id, runId, content) => ({ type: 'message', id, parentId: null,
  message: { role: 'user', content, idempotencyKey: `${runId}:user` } });
const config = { enabled: true, waitMode: 'until_pass', maxCorrectionsPerSession: 2,
  maxCorrectionsPerFlow: 2, assessmentTimeoutMs: 20_000, feedbackReserveMs: 1_000 };

async function fixture(t, { strict = true, priorStart = false } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-plan-restoration-')));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const projectRoot = path.join(root, 'project'), directory = path.join(root, 'host');
  const contents = {
    [`${prefix}/proposal.md`]: '# Proposal\n\nRetain saved display options.\n',
    [`${prefix}/design.md`]: '# Design\n\nRestore both saved display options on start.\n',
    [`${prefix}/tasks.md`]: taskText,
    [`${prefix}/specs/display/spec.md`]: '## ADDED Requirements\n\n### Requirement: Display options\nThe application SHALL retain the saved order and filter.\n',
  };
  for (const [file, text] of Object.entries(contents)) {
    await fs.mkdir(path.dirname(path.join(projectRoot, file)), { recursive: true });
    await fs.writeFile(path.join(projectRoot, file), text);
  }
  const state = { projectRoot, projectScope: { fingerprint: 'display-project-scope' }, scopeTaskId: 'display-task',
    sessionId: 'display-session', sessionKey: 'agent:main:display', agentId: 'main' };
  const original = record('original-input', 'proposal', originalText);
  const input = record('apply-input', 'apply', applyText);
  const observed = nativeTranscriptObservation([original, input]);
  const [source] = transcriptUserMessages(nativeTranscriptObservation([original]));
  const methods = new Map();
  const api = { registerGatewayMethod(name, handler) { methods.set(name, handler); } };
  registerOpenSpecPlanControl(api, { async openSpecPlanTarget(query) {
    return query.sessionId === state.sessionId && query.sessionKey === state.sessionKey && query.runId === state.nativeRunId
      ? { state, projectRoot, requireProposalCoverage: strict, readProposalSources: async () => [source], current: async () => true } : null;
  } });
  const address = runId => ({ sessionKey: state.sessionKey, sessionId: state.sessionId, runId, changeName });
  const run = runId => { if (state.nativeRunId !== runId) beginOpenSpecRun(state, runId); state.nativeRunId = runId; return address(runId); };
  const rpc = async (action, params) => {
    let response;
    await methods.get(`runtime-corrector.openspec.${action}`)({ params,
      client: { connect: { role: 'operator', scopes: ['operator.read', 'operator.write'] } },
      respond(...args) { assert.equal(response, undefined); response = args; } });
    assert.equal(response?.[0], true, response?.[2]?.message);
    return response[1];
  };
  const proposal = run('proposal'), snapshot = await rpc('preview', proposal);
  const requiredAtoms = ['Retain the saved order.', 'Retain the saved filter.'].map(requirement => ({
    source: { ref: source.ref, sha256: sha256(source.text), start: 1, end: 2 }, requirement,
  }));
  if (strict) {
    const target = snapshot.documents.find(row => row.path.endsWith('/spec.md'));
    recordProposalCoverage(state, target.path, { runId: 'proposal', taskId: state.scopeTaskId, sessionId: state.sessionId,
      scope: snapshot.documents, rows: requiredAtoms.map(atom => ({
        ...atom, source: createOriginalSourceAnchor({ ...atom.source, bytes: Buffer.from(source.text) }),
        disposition: 'COVERED', targets: [{ ...target, start: 3, end: 4 }],
      })) });
  }
  const approved = await rpc('approve', { ...proposal, expectedRevision: snapshot.revision,
    ...(strict ? { requiredAtoms } : {}) });
  await rpc('arm', { ...proposal, expectedRevision: snapshot.revision, applyRunId: 'apply',
    ...(strict ? { expectedInventorySha256: approved.inventorySha256 } : {}) });
  run('apply');
  await fs.writeFile(path.join(projectRoot, prefix, 'tasks.md'), completedTasks);
  const store = createStopCorrectionStore({ directory, now: () => Date.now() });
  await store.initializeSession({ sessionId: state.sessionId,
    initialize: priorStart
      ? { kind: 'VERIFIED_HISTORY', evidence: 'Trusted native start history.',
        starts: [{ executionId: 'earlier-native-correction', flowId: 'earlier-user-flow', startedAt: Date.now() - 1000 }] }
      : { kind: 'NEW_SESSION', evidence: 'An actual host session-created observation.' } });
  const write = (file, text) => fs.writeFile(path.join(projectRoot, prefix, file), text);
  const assess = async (overrides = {}) => assessOpenSpecPlanRestoration({ state, runId: state.nativeRunId,
    openSpecPlan: await inspectArmedOpenSpecApply(state, state.nativeRunId), observed,
    sourceInputId: input.id, sourceSha256: sha256(applyText), sourceCurrent: async digest => digest === sha256(applyText),
    directory, stopId: 'apply-stop', config, hostDeadlineAt: Date.now() + 15_000,
    signal: new AbortController().signal, isCurrent: async () => true, admissionSupported: true, ...overrides });
  async function bind(result) {
    assert(result?.core.admission);
    const id = result.core.admission.id;
    const request = { runId: `rc-stop-${id}`, taskId: state.scopeTaskId, sessionId: state.sessionId,
      sessionKey: state.sessionKey, agentId: state.agentId, projectRoot, source: result.source, message: 'An opaque native restoration reference.' };
    await store.bindHostRequest({ sessionId: state.sessionId, admissionId: id, request });
    const receipt = await readReceipt(id);
    assert.equal(reserveApprovedApplyRepair(state, receipt), true);
    return { request, receipt, id };
  }
  async function readReceipt(id) {
    const admission = (await store.inspect(state.sessionId)).admissions[id];
    return { ...admission.hostRequest, admissionId: id, gate: admission.hostRequest?.gate,
      status: admission.accounting === 'USED' ? 'STARTED' : admission.deliveryStatus,
      admission };
  }
  async function start(bound) {
    run(bound.request.runId);
    await store.delivery({ sessionId: state.sessionId, admissionId: bound.id, status: 'DELIVERED' });
    assert.equal((await store.recordHostGate({ sessionId: state.sessionId, admissionId: bound.id,
      runId: bound.request.runId, feedbackRevision: bound.receipt.admission.feedbackRevision, messageHash: sha256('checked restoration feedback') })).allowed, true);
    const startedAt = Date.now();
    await store.observeStart({ sessionId: state.sessionId, admissionId: bound.id, executionId: bound.request.runId,
      startedAt, observationId: 'trusted-start-'+bound.id });
    const receipt = await readReceipt(bound.id);
    assert.equal(observeApprovedApplyRepairStart(state, receipt), true);
    return receipt;
  }
  return { root, projectRoot, directory, state, store, contents, snapshot, approved, original, input, observed,
    requiredAtoms, write, run, assess, bind, start, readReceipt };
}

const read = (f, receipt, file) => readApprovedOpenSpecRestoration(f.state,
  { runId: f.state.nativeRunId, observed: f.observed, receipt, ...(file ? { path: file } : {}) });

test('restoration binds distinct target/current revisions and carries strict inventory only on the exact started successor', async t => {
  const f = await fixture(t);
  await f.write('design.md', '# Design\n\nA different design.\n');
  const result = await f.assess();
  assert.equal(result.core.stop.reviewStatus, 'DEVIATION', JSON.stringify(result.core));
  assert.equal(result.source.purpose, PLAN_RESTORATION_PURPOSE);
  assert.equal(result.source.openSpecRestoration.approvedRevision, f.snapshot.revision);
  assert.notEqual(result.source.openSpecRestoration.changedRevision, f.snapshot.revision);
  assert.equal(result.source.openSpecRestoration.inventorySha256, f.approved.inventorySha256);
  assert.equal(result.source.openSpecRestoration.sourceSha256, sha256(applyText));
  const bound = await f.bind(result);
  assert.equal(await approvedApplyRepairCurrent(f.state, bound.request), true);
  assert.equal((await f.store.inspect(f.state.sessionId)).used, 0);
  assert.throws(() => read(f, bound.receipt), /No current admitted/u);
  f.run(bound.request.runId);
  assert.equal(hasApprovedApplyInventory(f.state, bound.request.runId), true);
  assert.equal(approvedInventoryForApply(f.state, bound.request.runId, f.observed, bound.receipt), null);
  assert.throws(() => read(f, bound.receipt), /No current admitted/u);
  const started = await f.start(bound);
  const inventory = approvedInventoryForApply(f.state, bound.request.runId, f.observed, started);
  assert.equal(inventory.inventorySha256, f.approved.inventorySha256);
  assert.equal(inventory.requiredAtoms.length, 2);
  assert.deepEqual(inventory.requiredAtoms.map(atom => atom.requirement), f.requiredAtoms.map(atom => atom.requirement));
  const list = read(f, started);
  assert.equal(list.approvedRevision, f.snapshot.revision);
  assert.equal(list.documents.length, 4);
  for (const row of list.documents) {
    const page = read(f, started, row.path);
    const expected = row.path.endsWith('/tasks.md') ? completedTasks : f.contents[row.path];
    assert.equal(page.text, expected);
    assert.equal(page.sha256, sha256(expected));
  }
  assert.equal((await f.store.inspect(f.state.sessionId)).used, 1);
});

test('wrong-purpose and tampered restoration proofs cannot reserve or pass admission', async t => {
  const f = await fixture(t);
  await f.write('design.md', '# Changed\n');
  const result = await f.assess(), id = result.core.admission.id;
  const receipt = { runId: `rc-stop-${id}`, taskId: f.state.scopeTaskId, admissionId: id,
    source: { ...result.source, purpose: 'unrelated-purpose' } };
  assert.equal(reserveApprovedApplyRepair(f.state, receipt), false);
  assert.equal(reserveApprovedApplyRepair(f.state, { ...receipt, source: { ...result.source,
    openSpecRestoration: { ...result.source.openSpecRestoration, approvedRevision: 'a'.repeat(64) } } }), false);
  const bound = await f.bind(result);
  for (const source of [{ ...bound.request.source, purpose: undefined },
    { ...bound.request.source, purpose: 'unrelated-purpose' },
    { ...bound.request.source, usersDigest: 'b'.repeat(64) },
    { ...bound.request.source, openSpecRestoration: { ...bound.request.source.openSpecRestoration, sourceSha256: 'c'.repeat(64) } }]) {
    const request = { ...bound.request, source };
    assert.equal(await approvedApplyRepairCurrent(f.state, request), false);
    assert.deepEqual(await openSpecRestorationFeedbackCurrent(f.state, request, result.core.stop.currentDeviations), []);
  }
});

test('queued or mismatched native receipts cannot expose sealed documents or strict atoms', async t => {
  const f = await fixture(t);
  await f.write('design.md', '# Changed\n');
  const bound = await f.bind(await f.assess()), started = await f.start(bound);
  for (const receipt of [
    { ...started, status: 'ADMITTED' },
    { ...started, admissionId: 'a'.repeat(64) },
    { ...started, source: { ...started.source, purpose: 'unrelated-purpose' } },
    { ...started, admission: { ...started.admission, accounting: 'RESERVED' } },
    { ...started, admission: { ...started.admission, deliveryStatus: 'QUEUED' } },
    { ...started, admission: { ...started.admission, executionId: 'another-run' } },
    { ...started, admission: { ...started.admission, lateConfirmation: true } },
    { ...started, admission: { ...started.admission, invalidatedAt: Date.now() } },
  ]) {
    assert.equal(approvedInventoryForApply(f.state, f.state.nativeRunId, f.observed, receipt), null);
    assert.throws(() => read(f, receipt), /No current admitted/u);
  }
  assert.throws(() => read(f, started, '../proposal.md'), /Invalid approved document page/u);
  assert.throws(() => readApprovedOpenSpecRestoration(f.state, { runId: f.state.nativeRunId, observed: f.observed,
    receipt: started, path: `${prefix}/design.md`, startLine: 1, endLine: 201 }), /Invalid approved document page/u);
});

test('changed source, project scope, queued revision and expired admission remain closed', async t => {
  for (const kind of ['original-source', 'source-digest', 'scope', 'revision', 'deadline']) await t.test(kind, async t => {
    const f = await fixture(t);
    await f.write('design.md', '# Changed\n');
    if (kind === 'original-source') {
      const altered = nativeTranscriptObservation([{ ...f.original, message: { ...f.original.message, content: 'A new original requirement.' } }, f.input]);
      assert.equal(await f.assess({ observed: altered }), null);
      assert.equal((await f.store.inspect(f.state.sessionId)).used, 0);
      assert.equal(Object.keys((await f.store.inspect(f.state.sessionId)).admissions).length, 0);
      return;
    }
    if (kind === 'source-digest') {
      const result = await f.assess({ sourceCurrent: async () => false });
      assert.equal(result.core.admission, null);
      assert.equal(result.outcome, null);
      assert.equal(Object.keys((await f.store.inspect(f.state.sessionId)).admissions).length, 0);
      return;
    }
    const result = await f.assess(), bound = await f.bind(result);
    if (kind === 'scope') f.state.projectScope.fingerprint = 'a-replaced-scope';
    if (kind === 'revision') await f.write('design.md', '# A later queued change\n');
    if (kind === 'deadline') {
      const afterDeadline = result.core.stop.deadlineAt + 1;
      t.mock.method(Date, 'now', () => afterDeadline);
    }
    const checked = await f.store.checkAdmission({ sessionId: f.state.sessionId, admissionId: bound.id,
      basisCurrent: deviations => openSpecRestorationFeedbackCurrent(f.state, bound.request, deviations) });
    assert.equal(checked.allowed, false);
    assert.equal((await f.store.inspect(f.state.sessionId)).used, 0);
  });
});

test('preserved plans and unsupported native admission do not reserve restoration work', async t => {
  const f = await fixture(t);
  assert.equal(await f.assess(), null);
  await f.write('design.md', '# Changed\n');
  const result = await f.assess({ admissionSupported: false });
  assert.equal(result.outcome, null);
  assert.equal(result.core.admission, null);
  assert.equal(result.core.stop.releaseReason, 'HOST_START_PROTOCOL_UNSUPPORTED');
  const ledger = await f.store.inspect(f.state.sessionId);
  assert.equal(ledger.used, 0);
  assert.equal(Object.keys(ledger.admissions).length, 0);
});

test('same Stop deduplicates and an unsuccessful restoration cannot mint a new slot', async t => {
  const f = await fixture(t);
  await f.write('design.md', '# Changed\n');
  const options = { config: { ...config, maxCorrectionsPerSession: 2 } };
  const first = await f.assess(options), duplicate = await f.assess(options);
  assert.equal(first.core.admission.id, duplicate.core.admission.id);
  assert.equal(duplicate.core.reused, true);
  assert.equal(Object.keys((await f.store.inspect(f.state.sessionId)).admissions).length, 1);
  const bound = await f.bind(first), started = await f.start(bound);
  const next = await f.assess({ ...options, stopId: 'restoration-next-stop', nativeReceipt: started });
  assert.equal(next, null, 'The same unchanged deviation cannot spend another available correction slot.');
  const ledger = await f.store.inspect(f.state.sessionId);
  assert.equal(ledger.used, 1);
  assert.equal(Object.keys(ledger.admissions).length, 1);
});

test('a changed evidence proof may restore again under the same flow and shared quota', async t => {
  for (const kind of ['revision', 'source']) await t.test(kind, async t => {
    const f = await fixture(t);
    await f.write('design.md', '# Changed\n');
    const first = await f.assess(), bound = await f.bind(first), started = await f.start(bound);
    let overrides = {};
    if (kind === 'revision') await f.write('design.md', '# A new observed revision\n');
    else {
      const file = path.join(f.projectRoot, 'display.mjs');
      await fs.writeFile(file, 'export const savedOrder = "ascending";\n');
      const sourceSha256 = sha256(await fs.readFile(file));
      overrides = { sourceSha256, sourceCurrent: async expected => sha256(await fs.readFile(file)) === expected };
    }
    const next = await f.assess({ ...overrides, stopId: 'new-evidence-stop', nativeReceipt: started });
    assert(next?.outcome?.admission);
    assert.notEqual(next.core.admission.id, first.core.admission.id);
    assert.equal(next.core.admission.flowId, first.core.admission.flowId);
    assert.equal(next.source.openSpecRestoration.approvedRevision, first.source.openSpecRestoration.approvedRevision);
    assert.equal(next.source.openSpecRestoration.inventorySha256, first.source.openSpecRestoration.inventorySha256);
    const field = kind === 'revision' ? 'changedRevision' : 'sourceSha256';
    assert.notEqual(next.source.openSpecRestoration[field], first.source.openSpecRestoration[field]);
    const nextBound = await f.bind(next), nextStarted = await f.start(nextBound);
    assert.equal(approvedInventoryForApply(f.state, f.state.nativeRunId, f.observed, nextStarted).inventorySha256,
      f.approved.inventorySha256);
    const ledger = await f.store.inspect(f.state.sessionId);
    assert.equal(ledger.used, 2);
    assert.equal(ledger.flows[first.core.admission.flowId].used, 2);
  });
});

test('queued or cancelled native admission does not consume an evidence proof or charge usage', async t => {
  const f = await fixture(t);
  await f.write('design.md', '# Changed\n');
  const first = await f.assess(), bound = await f.bind(first);
  assert.equal(observeApprovedApplyRepairStart(f.state, bound.receipt), false);
  const duplicate = await f.assess();
  assert.equal(duplicate.core.admission.id, first.core.admission.id);
  assert.equal((await f.store.inspect(f.state.sessionId)).used, 0);
  await f.store.expireStop({ sessionId: f.state.sessionId, stopId: 'apply-stop', force: true,
    cannotStart: true, scopeInvalidated: true, reasonCode: 'HOST_CANCELLED_BEFORE_START' });
  const cancelled = await f.readReceipt(bound.id);
  assert.equal(observeApprovedApplyRepairStart(f.state, cancelled), false);
  const ledger = await f.store.inspect(f.state.sessionId);
  assert.equal(ledger.used, 0);
  assert.equal(ledger.admissions[bound.id].accounting, 'RELEASED');
  assert.equal(ledger.admissions[bound.id].startedAt, undefined);
});

test('restoration respects native session usage consumed by a different correction flow', async t => {
  const f = await fixture(t, { priorStart: true });
  await f.write('design.md', '# Changed\n');
  const result = await f.assess({ config: { ...config, maxCorrectionsPerSession: 1 } });
  assert.equal(result.outcome, null);
  assert.equal(result.core.admission, null);
  assert.equal(result.core.stop.releaseReason, 'SESSION_CORRECTION_LIMIT');
  const ledger = await f.store.inspect(f.state.sessionId);
  assert.equal(ledger.used, 1);
  assert.equal(Object.keys(ledger.admissions).length, 1, 'Only the prior trusted native start remains.');
});

test('legacy approval may restore its plan without manufacturing a strict requirement inventory', async t => {
  const f = await fixture(t, { strict: false });
  await f.write('design.md', '# Changed\n');
  const result = await f.assess();
  assert.equal(result.source.openSpecRestoration.inventorySha256, null);
  const bound = await f.bind(result), started = await f.start(bound);
  assert.equal(hasApprovedApplyInventory(f.state, f.state.nativeRunId), false);
  assert.equal(approvedInventoryForApply(f.state, f.state.nativeRunId, f.observed, started), null);
  assert.equal(read(f, started).approvedRevision, f.snapshot.revision);
});

test('restoring added notes does not infer completed task markers from changed checklist text', async t => {
  const f = await fixture(t);
  await f.write('tasks.md', completedTasks + '\n## Verification notes\n\n- The check completed.\n');
  const result = await f.assess(), bound = await f.bind(result), started = await f.start(bound);
  const restored = read(f, started, `${prefix}/tasks.md`);
  assert.equal(restored.text, taskText);
  await f.write('tasks.md', restored.text);
  const plan = await inspectArmedOpenSpecApply(f.state, f.state.nativeRunId);
  assert.equal(plan.status, 'PRESERVED');
  assert.equal(plan.completedTaskCount, 0);
  assert.equal(openSpecApplyFinding(plan).reasonCode, 'OPENSPEC_APPLY_PLAN_INCOMPLETE');
  const inventory = approvedInventoryForApply(f.state, f.state.nativeRunId, f.observed, started);
  assert.equal(inventory.inventorySha256, f.approved.inventorySha256);
  assert.equal(inventory.requiredAtoms.length, 2);
});
