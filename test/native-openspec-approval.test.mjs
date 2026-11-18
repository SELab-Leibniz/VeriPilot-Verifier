import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { compareOpenSpecPlans, readOpenSpecPlan } from '../lib/openspec-plan.mjs';
import { armNativeOpenSpecApply, observeNativeOpenSpecApply, prepareNativeOpenSpecProposal } from '../scripts/bench/native-openspec-approval.mjs';

const sessionKey = 'agent:main:openspec-approval';
const sessionId = 'session';
const proposalRunId = 'proposal';
const applyRunId = 'apply';
const changeName = 'retain-display-order';
const address = { sessionKey, sessionId, runId: proposalRunId, changeName };
const prefix = `openspec/changes/${changeName}`;
const checklistPath = `${prefix}/tasks.md`;
const designPath = `${prefix}/design.md`;
const specPath = `${prefix}/specs/display/spec.md`;
const checklist = '# Tasks\n\n- [ ] Restore the order.\n- [ ] Check the default order.\n';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const revision = documents => digest(JSON.stringify({ changeName, documents }));

test('prepares the independent inventory through the operator RPC and retains only its acknowledgement', async () => {
  const staged = { ...address, sourceRunId: 'original-proposal', sourceSha256: digest('original'),
    requirements: [{ start: 2, end: 3, requirement: 'Keep the saved order.' }] };
  const admitted = { status: 'PREPARED', runId: proposalRunId, sourceRunId: staged.sourceRunId, requirementCount: 1 };
  const request = async (method, body) => {
    assert.equal(method, 'runtime-corrector.openspec.prepare');
    assert.deepEqual(body, staged);
    return { ...admitted, changeName, privateData: staged.requirements };
  };
  assert.deepEqual(await prepareNativeOpenSpecProposal({ ...staged, request, deadlineAt: Date.now() + 2000 }), admitted);
  assert.deepEqual(await prepareNativeOpenSpecProposal({ ...staged, request: async () => ({ ...admitted, changeName, requirementCount: 0 }),
    deadlineAt: Date.now() + 2000 }), { status: 'UNVERIFIED', runId: proposalRunId, sourceRunId: staged.sourceRunId });
});

async function fixture(t) {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-native-openspec-approval-'));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  const contents = {
    [designPath]: '# Design\n\nRead preferences on start.\n',
    [`${prefix}/proposal.md`]: '# Proposal\n\nRetain the display order.\n',
    [specPath]: '## ADDED Requirements\n\n### Requirement: Display order\n\nThe app SHALL retain the saved order.\n',
    [checklistPath]: checklist,
  };
  const write = (relative, text) => fs.writeFile(path.join(project, relative), text);
  await fs.mkdir(path.join(project, path.dirname(specPath)), { recursive: true });
  await Promise.all(Object.entries(contents).map(([relative, text]) => write(relative, text)));

  const documents = Object.entries(contents).map(([relative, text]) => ({ path: relative, sha256: digest(text) }));
  const drafts = documents.filter(doc => doc.path !== checklistPath);
  const capture = () => readOpenSpecPlan(project, changeName);
  const snapshot = await capture();
  assert.deepEqual(snapshot.documents, documents);
  assert.equal(snapshot.revision, revision(documents));
  const proposalCheckpoint = { success: true, sessionId, runId: proposalRunId, proposalRepairScope: {
    changeName, complete: true, tasksMdSha256: digest(checklist), taskTextSha256: digest(checklist),
    draftFiles: drafts.map(({ path: relative }) => ({ path: relative })),
    approvedDocumentsSha256: digest(JSON.stringify(drafts.map(doc => [doc.path, doc.sha256]))),
  } };
  return { snapshot, capture, write, proposalCheckpoint };
}

function stageGateway(f, { replies = {}, proposalCheckpoint = f.proposalCheckpoint,
  taskCount = f.snapshot.taskCount, deadlineAt = Date.now() + 60_000, requiredAtoms } = {}) {
  const approvedRevision = f.snapshot.revision;
  const approval = { status: 'APPROVED', changeName, runId: proposalRunId, revision: approvedRevision };
  const response = {
    preview: { ...f.snapshot, runId: proposalRunId }, approve: approval, arm: { ...approval, status: 'ARMED', applyRunId },
  };
  const calls = [];
  const arm = () => armNativeOpenSpecApply({ sessionKey, sessionId, proposalRunId, applyRunId, changeName,
    proposalCheckpoint, taskCount, deadlineAt, requiredAtoms,
    async request(method, params, options) {
      calls.push({ method, params, options });
      assert(method.startsWith('runtime-corrector.openspec.'));
      const action = method.split('.').at(-1);
      assert(Object.hasOwn(response, action));
      const value = structuredClone(response[action]);
      return replies[action] ? replies[action](value) : value;
    },
  });
  return { calls, arm };
}

const failed = step => ({ status: 'UNVERIFIED', step, sessionId, sessionKey, changeName, proposalRunId, applyRunId });
const methods = calls => calls.map(({ method }) => method);
const expectedMethods = ['preview', 'approve', 'arm'].map(action => `runtime-corrector.openspec.${action}`);

const requiredAtoms = [
  { source: { ref: 'transcript:original-user', sha256: digest('task'), start: 2, end: 3 }, requirement: 'Retain the display order.' },
  { source: { ref: 'transcript:original-user', sha256: digest('task'), start: 2, end: 3 }, requirement: 'Use the saved order after restarting.' },
];
const inventorySha256 = digest('approved-inventory');
const strictReplies = {
  preview: value => ({ ...value, requireProposalCoverage: true }),
  approve: value => ({ ...value, inventorySha256, requiredAtomCount: requiredAtoms.length }),
  arm: value => ({ ...value, inventorySha256 }),
};

test('native OpenSpec approval pins the exact preview inventory and arm identity', async t => {
  const f = await fixture(t);
  const gateway = stageGateway(f, { replies: { preview: value => ({ ...value, documents: value.documents.reverse() }) } });
  const approvedRevision = f.snapshot.revision;
  assert.deepEqual(await gateway.arm(), {
    status: 'ARMED', sessionId, sessionKey, changeName, proposalRunId, applyRunId, approvedRevision, taskCount: 2,
  });
  const approval = { ...address, expectedRevision: approvedRevision };
  assert.deepEqual(gateway.calls, [address, approval, { ...approval, applyRunId }].map((params, index) => ({
    method: expectedMethods[index], params, options: { timeoutMs: 10_000 },
  })));
});

test('strict approval sends native-bound atoms only to approve and seals the returned inventory on arm', async t => {
  const f = await fixture(t);
  const gateway = stageGateway(f, { requiredAtoms, replies: strictReplies });
  const approvedRevision = f.snapshot.revision;
  const approval = { ...address, expectedRevision: approvedRevision };
  assert.deepEqual(await gateway.arm(), {
    status: 'ARMED', sessionId, sessionKey, changeName, proposalRunId, applyRunId, approvedRevision, taskCount: 2,
    inventorySha256, requiredAtomCount: 2,
  });
  assert.deepEqual(gateway.calls.map(call => call.params), [address,
    { ...approval, requiredAtoms }, { ...approval, applyRunId, expectedInventorySha256: inventorySha256 }]);
});

test('strict approval fails closed on missing, rejected, or mismatched inventory evidence', async t => {
  const f = await fixture(t);
  const options = { requiredAtoms };
  for (const [name, gatewayOptions, step, attempted] of [
    ['empty inventory', { requiredAtoms: [] }, 'preview', 0],
    ['legacy preview', options, 'preview', 1],
    ['strict preview without required inventory', { replies: strictReplies }, 'preview', 1],
    ['approval is rejected', { ...options, replies: { ...strictReplies, approve() { throw new Error(requiredAtoms[0].requirement); } } }, 'approve', 2],
    ['approval omits digest', { ...options, replies: { ...strictReplies, approve: value => value } }, 'approve', 2],
    ['approval count differs', { ...options, replies: { ...strictReplies, approve: value => ({ ...value, inventorySha256, requiredAtomCount: 1 }) } }, 'approve', 2],
    ['arming echoes a different inventory', { ...options, replies: { ...strictReplies, arm: value => ({ ...value, inventorySha256: digest('foreign') }) } }, 'arm', 3],
  ]) await t.test(name, async () => {
    const gateway = stageGateway(f, gatewayOptions);
    assert.deepEqual(await gateway.arm(), failed(step));
    assert.deepEqual(methods(gateway.calls), expectedMethods.slice(0, attempted));
  });
});

test('native approval stops at preview when raw bytes, task text, inventory, or revision differ', async t => {
  const f = await fixture(t);
  function replaceDocument(value, relative, changes) {
    const documents = value.documents.map(doc => doc.path === relative ? { ...doc, ...changes } : doc);
    return { ...value, documents, revision: revision(documents) };
  }
  for (const [name, reply] of Object.entries({
    'foreign Proposal run': value => ({ ...value, runId: 'old-proposal' }),
    'wrong change': value => ({ ...value, changeName: 'different-change' }),
    'more checklist items': value => ({ ...value, taskCount: 3 }),
    'already marked progress': value => ({ ...value, completedTaskCount: 1 }),
    'changed normalized checklist': value => ({ ...value, taskTextSha256: digest('different task text') }),
    'changed raw checklist with the same task text digest': value => replaceDocument(value, checklistPath, { sha256: digest('different checklist') }),
    'changed approved design with a self-consistent revision': value => replaceDocument(value, designPath, { sha256: digest('different design') }),
    'wrong draft path with the same inventory size': value => replaceDocument(value, specPath, { path: `${prefix}/specs/other/spec.md` }),
    'duplicate document': value => ({ ...value, documents: [...value.documents, value.documents[0]] }),
    'reconstructed revision differs': value => ({ ...value, revision: digest('some other revision') }),
    'malformed revision': value => ({ ...value, revision: 'old' }),
  })) {
    await t.test(name, async () => {
      const gateway = stageGateway(f, { replies: { preview: reply } });
      assert.deepEqual(await gateway.arm(), failed('preview'));
      assert.deepEqual(methods(gateway.calls), expectedMethods.slice(0, 1));
    });
  }
});

test('native approval requires the exact settled checkpoint and stops on stale or mismatched RPC replies', async t => {
  const f = await fixture(t);
  const scopeWith = changes => ({ ...f.proposalCheckpoint, proposalRepairScope: { ...f.proposalCheckpoint.proposalRepairScope, ...changes } });
  const conflict = () => { throw Object.assign(new Error('The named run is no longer current.'), { code: 'CONFLICT' }); };
  const approved = value => ({ ...value, runId: 'wrong-proposal' });
  const armed = value => ({ ...value, applyRunId: 'different-apply' });
  const cases = [
    ['foreign checkpoint', { proposalCheckpoint: { ...f.proposalCheckpoint, sessionId: 'old-session' } }, 'preview', 0],
    ['incomplete checkpoint', { proposalCheckpoint: { ...f.proposalCheckpoint, success: false } }, 'preview', 0],
    ['missing raw checklist digest', { proposalCheckpoint: scopeWith({ tasksMdSha256: undefined }) }, 'preview', 0],
    ['missing normalized checklist digest', { proposalCheckpoint: scopeWith({ taskTextSha256: undefined }) }, 'preview', 0],
    ['malformed draft digest', { proposalCheckpoint: scopeWith({ approvedDocumentsSha256: 'invalid' }) }, 'preview', 0],
    ['empty approved checklist', { taskCount: 0 }, 'preview', 0],
    ['noninteger approved item count', { taskCount: 1.5 }, 'preview', 0],
    ['expired deadline', { deadlineAt: 0 }, 'preview', 0],
    ['stale preview', { replies: { preview: conflict } }, 'preview', 1],
    ['stale approval', { replies: { approve: conflict } }, 'approve', 2],
    ['mismatched approval run', { replies: { approve: approved } }, 'approve', 2],
    ['mismatched approval revision', { replies: { approve: value => ({ ...value, revision: digest('new plan') }) } }, 'approve', 2],
    ['stale arming request', { replies: { arm: conflict } }, 'arm', 3],
    ['mismatched Apply run', { replies: { arm: armed } }, 'arm', 3],
    ['mismatched armed change', { replies: { arm: value => ({ ...value, changeName: 'new-change' }) } }, 'arm', 3],
  ];
  for (const [name, options, step, count] of cases) {
    await t.test(name, async () => {
      const gateway = stageGateway(f, options);
      assert.deepEqual(await gateway.arm(), failed(step));
      assert.deepEqual(methods(gateway.calls), expectedMethods.slice(0, count));
    });
  }
});

function stopRecord(approval, candidate, baseline, reviewStatus) {
  return { sessionId, sessionKey, runId: applyRunId, occurrenceId: `${applyRunId}:check-1`, status: 'SETTLED', reviewStatus,
    openSpecPlan: { changeName, proposalRunId, applyRunId, approvedRevision: approval.approvedRevision,
      ...compareOpenSpecPlans(baseline, candidate), currentRevision: candidate.revision,
      taskCount: candidate.taskCount, completedTaskCount: candidate.completedTaskCount } };
}

test('the exact settled Apply joins its observed plan verdict and preserves incomplete progress', async t => {
  const f = await fixture(t);
  const approval = await stageGateway(f).arm();
  await f.write(checklistPath, checklist.replace('- [ ] Restore', '- [x] Restore'));
  const completedOne = await f.capture();
  const preserved = stopRecord(approval, completedOne, f.snapshot, 'UNVERIFIED');
  assert.equal(preserved.openSpecPlan.status, 'PRESERVED');
  assert.equal(preserved.openSpecPlan.completedTaskCount, 1);
  assert.equal(preserved.openSpecPlan.taskCount, 2);
  assert.notEqual(preserved.openSpecPlan.currentRevision, approval.approvedRevision);
  assert.deepEqual(observeNativeOpenSpecApply(approval, [
    { ...preserved, status: 'RUNNING' }, { ...preserved, runId: 'later-apply' },
    { ...preserved, sessionKey: 'agent:main:elsewhere' }, { ...preserved, sessionId: 'foreign-session' }, preserved,
  ]), { status: 'OBSERVED', occurrenceId: preserved.occurrenceId, reviewStatus: 'UNVERIFIED', plan: preserved.openSpecPlan });

  await f.write(specPath, 'Different behavior.\n');
  const changed = stopRecord(approval, await f.capture(), f.snapshot, 'DEVIATION');
  assert.deepEqual(changed.openSpecPlan.differences, [specPath]);
  assert.deepEqual(observeNativeOpenSpecApply(approval, [changed]), {
    status: 'OBSERVED', occurrenceId: changed.occurrenceId, reviewStatus: 'DEVIATION', plan: changed.openSpecPlan,
  });
  const unavailable = { ...preserved, openSpecPlan: { changeName, proposalRunId, applyRunId,
    approvedRevision: approval.approvedRevision, status: 'UNVERIFIED', differences: [], reason: 'CURRENT_PLAN_UNAVAILABLE' } };
  assert.deepEqual(observeNativeOpenSpecApply(approval, [unavailable]), {
    status: 'OBSERVED', occurrenceId: unavailable.occurrenceId, reviewStatus: 'UNVERIFIED', plan: unavailable.openSpecPlan,
  });
});

test('foreign or unfinished Stop records do not join, and ambiguous or invalid Apply plans are unverified', async t => {
  const f = await fixture(t);
  const approval = await stageGateway(f).arm();
  const record = stopRecord(approval, f.snapshot, f.snapshot, 'UNVERIFIED');
  assert.equal(observeNativeOpenSpecApply(null, [record]), null);
  assert.equal(observeNativeOpenSpecApply(failed('arm'), [record]), null);
  assert.deepEqual(observeNativeOpenSpecApply(approval, [
    { ...record, status: 'RUNNING' }, { ...record, sessionId: 'wrong-session' },
    { ...record, sessionKey: 'agent:main:wrong-session' }, { ...record, runId: proposalRunId },
    { ...record, openSpecPlan: undefined },
  ]), { status: 'NOT_OBSERVED' });
  assert.deepEqual(observeNativeOpenSpecApply(approval, [record, { ...record, occurrenceId: `${applyRunId}:check-2` }]),
    { status: 'UNVERIFIED' });
  assert.deepEqual(observeNativeOpenSpecApply(approval, [{ ...record, occurrenceId: '' }]), { status: 'UNVERIFIED' });

  for (const mismatch of [
    { changeName: 'other-change' }, { proposalRunId: 'older-proposal' }, { applyRunId: 'different-apply' },
    { approvedRevision: digest('different approval') }, { currentRevision: 'bad revision' },
    { status: 'APPROVED' }, { differences: null }, { taskCount: 1 }, { taskCount: 1.5 },
    { completedTaskCount: -1 }, { completedTaskCount: 3 }, { differences: [specPath] }, { status: 'CHANGED' },
    { status: 'CHANGED', differences: [`openspec/changes/other-change/tasks.md`] },
    { status: 'UNVERIFIED', differences: [specPath] },
  ]) {
    const candidate = { ...record, openSpecPlan: { ...record.openSpecPlan, ...mismatch } };
    assert.deepEqual(observeNativeOpenSpecApply(approval, [candidate]), { status: 'UNVERIFIED' }, JSON.stringify(mismatch));
  }
});

test('strict Stop evidence binds the armed and exact final corrective run without exposing atom contents', async t => {
  const f = await fixture(t);
  const approval = await stageGateway(f, { requiredAtoms, replies: strictReplies }).arm();
  const continuationRunId = 'rc-stop-authorized-repair';
  const atomRows = requiredAtoms.map(({ requirement }, index) => ({ id: digest(requirement), objectId: `M16-verified-${index}` }));
  await f.write(checklistPath, checklist.replaceAll('[ ]', '[x]'));
  const candidate = await f.capture();
  function withInventory(record, evaluationId) {
    return { ...record, evaluationId, reviewSummary: { evaluationId, status: record.reviewStatus,
      approvedProposalInventory: { inventorySha256, requiredAtoms: atomRows } } };
  }
  const initial = withInventory(stopRecord(approval, candidate, f.snapshot, 'DEVIATION'), 'initial-evaluation');
  const final = withInventory({ ...initial, runId: continuationRunId, occurrenceId: 'repair-occurrence', reviewStatus: 'NO_DEVIATION_FOUND',
    openSpecPlan: { ...initial.openSpecPlan, continuationRunId } }, 'repair-evaluation');
  const finalRun = { finalRunId: continuationRunId };
  const inventory = (records, options) => observeNativeOpenSpecApply(approval, records, options).inventory;
  assert.deepEqual(inventory([initial]), { status: 'OBSERVED', finalRunId: applyRunId, occurrenceId: initial.occurrenceId,
    evaluationId: 'initial-evaluation', inventorySha256, requiredAtomCount: 2, reviewStatus: 'DEVIATION' });
  assert.deepEqual(observeNativeOpenSpecApply(approval, [initial, final], finalRun), {
    status: 'OBSERVED', occurrenceId: initial.occurrenceId, reviewStatus: 'DEVIATION', plan: initial.openSpecPlan,
    inventory: { status: 'OBSERVED', finalRunId: continuationRunId, occurrenceId: final.occurrenceId,
      evaluationId: final.evaluationId, inventorySha256, requiredAtomCount: 2, reviewStatus: 'NO_DEVIATION_FOUND' },
  });
  assert.deepEqual(inventory([initial, final], { finalRunId: 'unarmed-retry' }), { status: 'NOT_OBSERVED' });
  assert.deepEqual(inventory([final], finalRun), { status: 'NOT_OBSERVED' });
  assert.deepEqual(inventory([initial, final, final], finalRun), { status: 'UNVERIFIED' });
  for (const invalid of [
    { ...final, reviewSummary: undefined },
    { ...final, reviewSummary: { ...final.reviewSummary, evaluationId: 'older-evaluation' } },
    { ...final, openSpecPlan: { ...final.openSpecPlan, completedTaskCount: 1 } },
    { ...final, openSpecPlan: { ...final.openSpecPlan, continuationRunId: 'foreign-repair' } },
    ...[
      { inventorySha256: digest('foreign-inventory') },
      { requiredAtoms: [{ ...atomRows[0], id: digest('foreign-atom') }, atomRows[1]] },
      { requiredAtoms: [atomRows[0], atomRows[0]] },
      { requiredAtoms: atomRows.slice(0, 1) },
    ].map(fields => ({ ...final, reviewSummary: { ...final.reviewSummary,
      approvedProposalInventory: { ...final.reviewSummary.approvedProposalInventory, ...fields } } })),
  ]) assert.deepEqual(inventory([initial, invalid], finalRun), { status: 'UNVERIFIED' });
});

async function restorationEvidence(t, { codeRepair = false, verificationOnly = false, closed = false } = {}) {
  const f = await fixture(t);
  const approval = await stageGateway(f, { requiredAtoms, replies: strictReplies }).arm();
  await f.write(checklistPath, checklist.replaceAll('[ ]', '[x]'));
  const preserved = await f.capture();
  await f.write(designPath, '# Changed design after approval\n');
  const changed = await f.capture();
  const projectRoot = '/isolated/native-project', taskId = 'native-task', flowId = digest('original-flow');
  const sourceScope = `${projectRoot}:${taskId}`, purpose = 'openspec-plan-restoration';
  const ids = [digest('restoration-admission'), digest('code-admission')];
  const rows = requiredAtoms.map(({ requirement }, index) => ({ id: digest(requirement), objectId: `M16-exact-${index}` }));
  const initial = { ...stopRecord(approval, changed, f.snapshot, 'DEVIATION'), occurrenceId: applyRunId,
    evaluationId: 'native-plan-assessment', reasonCode: 'OPENSPEC_APPLY_PLAN_CHANGED', assessmentCompletedAt: 30, settledAt: 35,
    reviewSummary: { purpose, approvedRevision: approval.approvedRevision, changedRevision: changed.revision } };
  const inventoryRecord = (id, judgement, assessmentCompletedAt, settledAt) => {
    const runId = `rc-stop-${id}`, evaluationId = `assessment-${id}`;
    return { ...stopRecord(approval, preserved, f.snapshot, judgement), runId, occurrenceId: runId, evaluationId,
      assessmentCompletedAt, settledAt, openSpecPlan: { ...stopRecord(approval, preserved, f.snapshot, judgement).openSpecPlan, continuationRunId: runId },
      reviewSummary: { status: judgement, evaluationId, approvedProposalInventory: { inventorySha256, requiredAtoms: rows } } };
  };
  const repairedPlan = inventoryRecord(ids[0], codeRepair ? 'DEVIATION' : 'NO_DEVIATION_FOUND', 90, 95);
  const final = codeRepair ? inventoryRecord(ids[1], 'NO_DEVIATION_FOUND', 140, 145) : repairedPlan;
  const records = codeRepair ? [initial, repairedPlan, final] : [initial, final];
  const ledger = { schemaVersion: 'runtime-corrector.stop-correction-session.v1', sessionId, used: codeRepair ? 2 : 1,
    flows: { [flowId]: { id: flowId, used: codeRepair ? 2 : 1 } }, stops: {}, admissions: {}, events: [] };
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (verificationOnly && record === final) continue;
    ledger.stops[record.occurrenceId] = { id: record.occurrenceId, scope: projectRoot, flowId, reviewStatus: record.reviewStatus,
      reviewScopeId: sourceScope + (record === initial ? `:${purpose}` : ''), ...(record === final ? {} : { admissionId: ids[i] }) };
  }
  for (let i = 0; i < records.length - 1; i++) {
    const record = records[i], target = records[i + 1], id = ids[i], first = i === 0;
    const request = { runId: target.runId, taskId, sessionKey, projectRoot, agentId: 'main', assessmentId: record.evaluationId,
      createdAt: first ? 31 : 91, gate: { at: first ? 40 : 100, feedbackRevision: 0, messageHash: digest('checked-feedback') },
      source: { runId: record.runId, leafId: `native-source-leaf-${i}`, usersDigest: digest('original-users'), evidenceDigest: digest(`evidence-${i}`),
        openSpecPlanRevision: record.openSpecPlan.currentRevision,
        ...(first ? { purpose, openSpecRestoration: { purpose, approvedRevision: approval.approvedRevision,
          changedRevision: changed.revision, differences: initial.openSpecPlan.differences, initialApplyRunId: applyRunId,
          sourceSha256: digest('actual-source'), scopeFingerprint: digest('native-project-scope'), inventorySha256 } } : {}) } };
    const admission = ledger.admissions[id] = { id, flowId, stopId: record.occurrenceId, accounting: 'USED', startStatus: 'STARTED',
      deliveryStatus: 'DELIVERED', executionId: target.runId, lateConfirmation: false, createdAt: first ? 25 : 85,
      startedAt: first ? 45 : 105, observedAt: first ? 46 : 106, endedAt: first ? 60 : 120,
      deadlineAt: 1000, feedbackRevision: 0, hostRequest: request };
    ledger.events.push({ type: 'STOP_REVIEW_SETTLED', stopId: record.occurrenceId, status: 'DEVIATION', observedAt: first ? 20 : 80 },
      { type: 'CONTINUATION_STARTED', admissionId: id, executionId: target.runId, valid: true, lateConfirmation: false,
        startedAt: admission.startedAt, observedAt: admission.observedAt });
    if (target === final) {
      if (verificationOnly) {
        admission.finalReview = { status: target.reviewStatus, evaluationId: target.evaluationId, at: target.settledAt - 2 };
        ledger.events.push({ type: 'FINAL_REPAIR_REVIEW', admissionId: id, ...admission.finalReview, observedAt: admission.finalReview.at });
      } else ledger.events.push({ type: 'STOP_REVIEW_SETTLED', stopId: target.occurrenceId,
        status: target.reviewStatus, observedAt: target.assessmentCompletedAt - 5 });
    }
  }
  if (closed) {
    const admission = ledger.admissions[ids[0]], stop = ledger.stops[initial.occurrenceId];
    admission.invalidatedAt = 200; admission.invalidationReason = 'RC_NATIVE_CANCELLED';
    stop.reviewStatus = 'UNVERIFIED'; stop.invalidatedReview = { status: 'DEVIATION', at: 200 };
    ledger.events.push({ type: 'STOP_RELEASED', stopId: initial.occurrenceId, reasonCode: 'RC_NATIVE_CANCELLED', accounting: 'USED', observedAt: 200 });
  }
  const options = { finalRunId: final.runId, projectRoot, ledger };
  const observe = (selected = records, pins = options) => observeNativeOpenSpecApply(approval, selected, pins);
  return { approval, records, initial, final, ledger, options, observe, ids };
}

test('native restoration accepts a final strict proof only with exact host-owned admission ancestry', async t => {
  for (const codeRepair of [false, true]) for (const verificationOnly of [false, true]) await t.test(`${codeRepair ? 'with code repair' : 'plan only'} / ${verificationOnly ? 'final verification' : 'regular final Stop'}`, async t => {
    const f = await restorationEvidence(t, { codeRepair, verificationOnly, closed: true });
    const observed = f.observe();
    assert.equal(observed.plan.status, 'CHANGED', 'the historical drift remains visible');
    assert.equal(observed.inventory.status, 'OBSERVED');
    assert.equal(observed.inventory.finalRunId, f.final.runId);
    assert.equal(observed.inventory.inventorySha256, inventorySha256);
    assert.equal(observed.inventory.requiredAtomCount, 2);
    assert.equal(observed.continuations.planRestorations, 1);
    assert.equal(observed.continuations.codeRepairs, codeRepair ? 1 : 0);
    assert.equal(observed.continuations.steps.at(-1).runId, f.final.runId);
    assert(!JSON.stringify(observed).includes(requiredAtoms[0].requirement));
  });
});

test('external controller retries, claimed summaries and broken or queued restoration ancestry stay unverified', async t => {
  const f = await restorationEvidence(t, { codeRepair: true, verificationOnly: true });
  assert.equal(f.observe(f.records, { finalRunId: f.final.runId }).inventory.status, 'UNVERIFIED');
  assert.equal(f.observe(f.records, { ...f.options, projectRoot: '/another-project' }).inventory.status, 'UNVERIFIED');
  const mutations = {
    'wrong original Apply': ({ ledger }) => { ledger.admissions[f.ids[0]].hostRequest.source.openSpecRestoration.initialApplyRunId = 'external-retry'; },
    'stale approved revision': ({ ledger }) => { ledger.admissions[f.ids[0]].hostRequest.source.openSpecRestoration.approvedRevision = digest('other'); },
    'foreign inventory': ({ ledger }) => { ledger.admissions[f.ids[0]].hostRequest.source.openSpecRestoration.inventorySha256 = digest('other'); },
    'stale changed revision': ({ ledger }) => { ledger.admissions[f.ids[0]].hostRequest.source.openSpecRestoration.changedRevision = digest('other'); },
    'different exact differences': ({ ledger }) => { ledger.admissions[f.ids[0]].hostRequest.source.openSpecRestoration.differences = [specPath]; },
    'wrong purpose': ({ ledger }) => { ledger.admissions[f.ids[0]].hostRequest.source.purpose = 'controller-restoration'; },
    'merely queued': ({ ledger }) => { ledger.admissions[f.ids[0]].accounting = 'RESERVED'; },
    'undelivered': ({ ledger }) => { ledger.admissions[f.ids[0]].deliveryStatus = 'QUEUED'; },
    'missing gate': ({ ledger }) => { delete ledger.admissions[f.ids[0]].hostRequest.gate; },
    'late confirmation': ({ ledger }) => { ledger.admissions[f.ids[0]].lateConfirmation = true; },
    'expired start': ({ ledger }) => { ledger.admissions[f.ids[0]].deadlineAt = 44; },
    'missing start event': ({ ledger }) => { ledger.events = ledger.events.filter(e => e.type !== 'CONTINUATION_STARTED'); },
    'duplicated start event': ({ ledger }) => { ledger.events.push({ ...ledger.events.find(e => e.type === 'CONTINUATION_STARTED') }); },
    'forged start': ({ ledger }) => { ledger.events.find(e => e.type === 'CONTINUATION_STARTED').valid = false; },
    'other source users': ({ ledger }) => { ledger.admissions[f.ids[1]].hostRequest.source.usersDigest = digest('foreign'); },
    'other task': ({ ledger }) => { ledger.admissions[f.ids[1]].hostRequest.taskId = 'foreign-task'; },
    'other host agent': ({ ledger }) => { ledger.admissions[f.ids[1]].hostRequest.agentId = 'foreign-agent'; },
    'missing source leaf': ({ ledger }) => { delete ledger.admissions[f.ids[0]].hostRequest.source.leafId; },
    'missing source evaluation': ({ records, ledger }) => { delete records[0].evaluationId; delete ledger.admissions[f.ids[0]].hostRequest.assessmentId; },
    'other flow': ({ ledger }) => { ledger.admissions[f.ids[1]].flowId = digest('foreign'); },
    'unbound final verification': ({ ledger }) => { ledger.admissions[f.ids[1]].finalReview.evaluationId = 'older-final'; },
    'no final host review': ({ ledger }) => { ledger.events = ledger.events.filter(e => e.type !== 'FINAL_REPAIR_REVIEW'); },
    'cancelled before settlement': ({ ledger }) => { const a = ledger.admissions[f.ids[0]]; a.invalidatedAt = 46; a.invalidationReason = 'RC_NATIVE_CANCELLED'; },
    'unarmed final': ({ records }) => { delete records.at(-1).openSpecPlan; },
    'claimed initial semantic pass': ({ records }) => { records[0].reviewStatus = 'NO_DEVIATION_FOUND'; },
  };
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, () => {
    const pins = structuredClone(f.options), records = structuredClone(f.records);
    mutate({ ...pins, records });
    const result = f.observe(records, pins);
    assert.notEqual(result.inventory.status, 'OBSERVED');
    assert.equal(result.continuations, undefined);
  });
});
