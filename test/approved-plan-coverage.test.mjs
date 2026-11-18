import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { currentApprovedPlanCoverage, recordProposalCoverage as recordCoverage, selectApprovedPlanCoverage } from '../lib/openclaw/approved-plan-coverage.mjs';
import { approvedCoverageForApply, beginOpenSpecRun, hasApprovedApplyInventory, hasArmedOpenSpecApply, inspectArmedOpenSpecApply, registerOpenSpecPlanControl } from '../lib/openclaw/openspec-plan-control.mjs';
import { readOpenSpecPlan } from '../lib/openspec-plan.mjs';
import { createOriginalSourceAnchor } from '../lib/runtime-v2/original-source-anchor.mjs';
import { sha256 } from '../lib/runtime-v2/utils.mjs';
import { publishProposalCoverage } from './support/proposal-coverage.mjs';

const recordProposalCoverage = (...args) => publishProposalCoverage(recordCoverage, ...args);

const changeName = 'preserve-preferences';
const change = `openspec/changes/${changeName}`;
const proposal = `${change}/proposal.md`;
const spec = `${change}/specs/preferences/spec.md`;
const tasks = `${change}/tasks.md`;
const taskText = '# Tasks\n- [ ] Preserve user preferences.\n';
const proposalRunId = 'proposal-run';
const applyRunId = 'apply-run';
const original = Buffer.from('Preserve the saved preference, show it after reopening, and report invalid values.');
const source = createOriginalSourceAnchor({ ref: 'transcript:requirement', sha256: sha256(original), bytes: original, start: 1, end: 1 });

function atom(row) {
  return { source: { ref: row.source.ref, sha256: row.source.sha256, start: 1, end: 1 }, requirement: row.requirement };
}

function hostResult(f, { status = 'passed', semanticStatus = 'completed', diagnostics = [], inputs = f.snapshot.documents,
  classification } = {}) {
  return { status, diagnostics, ...(classification ? { classification } : {}),
    metadata: { inputs, semanticReview: { status: semanticStatus } } };
}

const blockingError = { ruleId: 'AGENT-PLAN-CONSISTENCY', severity: 'error', path: spec,
  message: 'The design resets the preference but the approved spec requires retaining it.' };

async function fixture(t) {
  const projectRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-approved-plan-coverage-')));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  const write = (file, text) => fs.writeFile(path.join(projectRoot, file), text);
  await fs.mkdir(path.join(projectRoot, path.dirname(spec)), { recursive: true });
  await Promise.all([write(proposal, '# Proposal\nPreserve the sorting preference.\n'),
    write(spec, '# Preferences\nA saved preference survives reopening.\n'), write(tasks, taskText)]);

  const state = { projectRoot, scopeTaskId: 'task-one', sessionId: 'session-one', nativeRunId: proposalRunId };
  const snapshot = await readOpenSpecPlan(projectRoot, changeName);
  const target = (file) => ({ path: file, start: 2, end: 2, sha256: snapshot.documents.find(doc => doc.path === file).sha256 });
  const receipt = { schemaVersion: 1, taskId: state.scopeTaskId, sessionId: state.sessionId, runId: proposalRunId,
    scope: snapshot.documents.map(doc => ({ ...doc, lines: 3 })), rows: [
      { source, requirement: 'Keep the saved preference.', disposition: 'COVERED', reason: 'The spec preserves the saved value.', targets: [target(spec)] },
      { source, requirement: 'Implement preference preservation.', disposition: 'COVERED', reason: 'The task names the work.', targets: [target(tasks)] },
      { source, requirement: 'Report invalid preference values.', disposition: 'GAP', reason: 'The reviewed plan omits invalid values.', targets: [] },
      { source, requirement: 'Show the correct value after reopening.', disposition: 'COVERED', reason: 'The spec and tasks describe the change.',
        targets: [target(spec), target(tasks)] },
    ] };
  const verdict = { status: 'PRESERVED', changeName, proposalRunId, applyRunId,
    approvedRevision: snapshot.revision, currentRevision: snapshot.revision };
  return { state, snapshot, receipt, verdict, write };
}

function gatewayFixture(f, policy = () => ({})) {
  const methods = new Map();
  const sessionKey = 'agent:main:preferences';
  const operator = { connect: { role: 'operator', scopes: ['operator.read', 'operator.write'] } };
  registerOpenSpecPlanControl({ registerGatewayMethod(name, callback) { methods.set(name, callback); } }, {
    async openSpecPlanTarget(query) {
      if (query.sessionKey !== sessionKey || query.sessionId !== f.state.sessionId || query.runId !== f.state.nativeRunId) return null;
      return { ...policy(), state: f.state, projectRoot: f.state.projectRoot,
        async current() { return query.runId === f.state.nativeRunId; } };
    },
  });
  async function request(method, extra = {}) {
    let response;
    const params = { sessionKey, sessionId: f.state.sessionId, runId: f.state.nativeRunId, changeName, ...extra };
    await methods.get(`runtime-corrector.openspec.${method}`)({ params, client: operator, respond: (...args) => { response = args; } });
    assert(response);
    const [ok, value, error] = response;
    return { ok, value, error };
  }
  return {
    async rpc(method, extra) {
      const { ok, value, error } = await request(method, extra);
      assert.equal(ok, true, error?.message);
      return value;
    },
    async reject(method, extra) {
      const { ok, value, error } = await request(method, extra);
      assert.equal(ok, false, `Expected ${method} to fail`);
      assert.equal(value, undefined);
      assert(['CONFLICT', 'INVALID_REQUEST'].includes(error?.code), error?.message);
      return error;
    },
  };
}

test('only the exact task, session, and Proposal run can supply coverage for the approved snapshot', async t => {
  const f = await fixture(t);
  for (const mismatch of [{ taskId: 'other-task' }, { sessionId: 'other-session' }, { runId: 'other-run' }]) {
    recordProposalCoverage(f.state, proposal, { ...f.receipt, ...mismatch });
    assert.equal(selectApprovedPlanCoverage(f.state, proposalRunId, f.snapshot), null);
  }
  recordProposalCoverage(f.state, proposal, f.receipt);
  assert.equal(selectApprovedPlanCoverage(f.state, 'other-run', f.snapshot), null);
  assert.equal(selectApprovedPlanCoverage({ ...f.state }, proposalRunId, f.snapshot), null);
  assert.deepEqual(selectApprovedPlanCoverage(f.state, proposalRunId, f.snapshot), {
    taskId: f.state.scopeTaskId, sessionId: f.state.sessionId, proposalRunId, changeName,
    approvedRevision: f.snapshot.revision, reviewStatus: 'PASSED', rows: f.receipt.rows,
  });
});

test('partial, stale, duplicate, or foreign plan scope cannot pin Proposal coverage', async t => {
  const f = await fixture(t);
  const [first, ...rest] = f.receipt.scope;
  const provisionalScopes = [
    rest,
    [{ ...first, sha256: sha256('old proposal bytes') }, ...rest],
    [{ ...first, path: 'openspec/changes/other-change/proposal.md' }, ...rest],
    [rest[0], ...rest],
  ];
  for (const scope of provisionalScopes) {
    recordProposalCoverage(f.state, proposal, { ...f.receipt, scope });
    assert.equal(selectApprovedPlanCoverage(f.state, proposalRunId, f.snapshot), null);
  }
  for (const target of [{ ...f.receipt.rows[0].targets[0], path: 'outside-plan.md' },
    { ...f.receipt.rows[0].targets[0], sha256: sha256('different spec bytes') }]) {
    recordProposalCoverage(f.state, proposal, { ...f.receipt, rows: [{ ...f.receipt.rows[0], targets: [target] }] });
    assert.equal(selectApprovedPlanCoverage(f.state, proposalRunId, f.snapshot)?.reviewStatus, 'UNVERIFIED');
  }
});

test('a newer full-plan unavailable result invalidates the earlier review while partial uncertainty does not', async t => {
  const f = await fixture(t);
  recordProposalCoverage(f.state, proposal, f.receipt);
  assert(selectApprovedPlanCoverage(f.state, proposalRunId, f.snapshot));
  recordProposalCoverage(f.state, proposal, { ...f.receipt, scope: f.receipt.scope.slice(1) });
  assert.equal(selectApprovedPlanCoverage(f.state, proposalRunId, f.snapshot)?.reviewStatus, 'PASSED');

  recordProposalCoverage(f.state, proposal, f.receipt);
  recordProposalCoverage(f.state, proposal, null, { result: hostResult(f, { semanticStatus: 'failed', status: 'failed' }) });
  assert.equal(selectApprovedPlanCoverage(f.state, proposalRunId, f.snapshot)?.reviewStatus, 'UNVERIFIED');
  recordProposalCoverage(f.state, proposal, f.receipt);
  f.state.nativeRunId = 'new-proposal';
  recordProposalCoverage(f.state, proposal, null);
  assert.equal(selectApprovedPlanCoverage(f.state, proposalRunId, f.snapshot), null);
});

test('coverage metadata alone cannot attest that the host review completed successfully', async t => {
  const f = await fixture(t);
  recordCoverage(f.state, proposal, { ...f.receipt, reviewStatus: 'PASSED', status: 'passed' });
  assert.equal(selectApprovedPlanCoverage(f.state, proposalRunId, f.snapshot), null);
});

test('strict approval rejects all-COVERED atoms when the completed host review has a blocking cross-document error', async t => {
  const f = await fixture(t);
  const covered = [f.receipt.rows[0], f.receipt.rows[3]];
  const { rpc, reject } = gatewayFixture(f, () => ({ requireProposalCoverage: true,
    readProposalSources: async () => [{ ref: source.ref, text: original.toString() }] }));
  const receipt = { ...f.receipt, rows: covered, reviewStatus: 'PASSED' };
  recordProposalCoverage(f.state, proposal, receipt,
    { result: hostResult(f, { status: 'failed', diagnostics: [blockingError] }) });
  assert.equal(selectApprovedPlanCoverage(f.state, proposalRunId, f.snapshot)?.reviewStatus, 'BLOCKED');
  const approve = { expectedRevision: (await rpc('preview')).revision, requiredAtoms: covered.map(atom) };
  assert.match((await reject('approve', approve)).message, /blocking errors/u);
  await reject('arm', { expectedRevision: approve.expectedRevision, expectedInventorySha256: sha256('not approved'), applyRunId });
  beginOpenSpecRun(f.state, applyRunId);
  assert.equal(hasArmedOpenSpecApply(f.state, applyRunId), false);

  recordProposalCoverage(f.state, tasks, receipt);
  const approved = await rpc('approve', approve);
  assert.equal(approved.status, 'APPROVED');
  assert.equal((await rpc('arm', { expectedRevision: approve.expectedRevision,
    expectedInventorySha256: approved.inventorySha256, applyRunId })).status, 'ARMED');
});

test('a newer full-plan failure without coverage rows blocks an older PASS under another trigger until a clean re-review', async t => {
  const f = await fixture(t);
  const covered = [f.receipt.rows[0], f.receipt.rows[3]];
  const receipt = { ...f.receipt, rows: covered };
  const { rpc, reject } = gatewayFixture(f, () => ({ requireProposalCoverage: true,
    readProposalSources: async () => [{ ref: source.ref, text: original.toString() }] }));
  recordProposalCoverage(f.state, proposal, receipt);
  const approve = { expectedRevision: (await rpc('preview')).revision, requiredAtoms: covered.map(atom) };
  const approved = await rpc('approve', approve);
  const arm = { expectedRevision: approve.expectedRevision, expectedInventorySha256: approved.inventorySha256, applyRunId };
  recordProposalCoverage(f.state, tasks, null,
    { result: hostResult(f, { status: 'failed', diagnostics: [blockingError] }) });
  const selected = selectApprovedPlanCoverage(f.state, proposalRunId, f.snapshot);
  assert.equal(selected.reviewStatus, 'BLOCKED');
  assert.deepEqual(selected.rows, []);
  assert.equal(currentApprovedPlanCoverage(selected, f.verdict), null);
  assert.match((await reject('approve', approve)).message, /blocking errors/u);
  assert.match((await reject('arm', arm)).message, /blocking errors/u);
  beginOpenSpecRun(f.state, applyRunId);
  assert.equal(hasArmedOpenSpecApply(f.state, applyRunId), false);

  // Advisory diagnostics do not turn a successful semantic review into a block.
  recordProposalCoverage(f.state, spec, receipt, { result: hostResult(f, { status: 'warning', classification: 'DEVIATION',
    diagnostics: [{ ...blockingError, severity: 'warning', message: 'Clarify the verification instructions.' }] }) });
  assert.equal((await rpc('approve', approve)).inventorySha256, approved.inventorySha256);
  assert.equal((await rpc('arm', arm)).status, 'ARMED');
});

test('checker failure and pending evidence keep strict approval UNVERIFIED without inventing a requirement contradiction', async t => {
  for (const scenario of [
    { status: 'failed', semanticStatus: 'failed', classification: 'CHECKER_FAILURE',
      diagnostics: [{ ...blockingError, ruleId: 'AGENT-SEMANTIC-REVIEW-FAILED' }] },
    { status: 'failed', classification: 'CHECKER_FAILURE',
      diagnostics: [{ ...blockingError, ruleId: 'RUNTIME-PATCH-VALIDATION-FAILED' }] },
    { status: 'pending', diagnostics: [{ ...blockingError, severity: 'pending' }] },
  ]) await t.test(scenario.diagnostics[0].ruleId + scenario.status, async t => {
    const f = await fixture(t);
    const receipt = { ...f.receipt, rows: [f.receipt.rows[0], f.receipt.rows[3]] };
    const { rpc, reject } = gatewayFixture(f, () => ({ requireProposalCoverage: true,
      readProposalSources: async () => [{ ref: source.ref, text: original.toString() }] }));
    recordProposalCoverage(f.state, proposal, receipt);
    recordProposalCoverage(f.state, tasks, null, { result: hostResult(f, scenario) });
    assert.equal(selectApprovedPlanCoverage(f.state, proposalRunId, f.snapshot).reviewStatus, 'UNVERIFIED');
    const error = await reject('approve', { expectedRevision: (await rpc('preview')).revision, requiredAtoms: receipt.rows.map(atom) });
    assert.match(error.message, /unavailable or incomplete/u);
    assert.doesNotMatch(error.message, /blocking errors/u);
  });
});

test('a current subset contradiction holds strict approval until a later clean full-plan review', async t => {
  const f = await fixture(t);
  const receipt = { ...f.receipt, rows: [f.receipt.rows[0], f.receipt.rows[3]] };
  const { rpc, reject } = gatewayFixture(f, () => ({ requireProposalCoverage: true,
    readProposalSources: async () => [{ ref: source.ref, text: original.toString() }] }));
  recordProposalCoverage(f.state, proposal, receipt);
  const approve = { expectedRevision: f.snapshot.revision, requiredAtoms: receipt.rows.map(atom) };
  const approved = await rpc('approve', approve);
  const arm = { expectedRevision: f.snapshot.revision, expectedInventorySha256: approved.inventorySha256, applyRunId };
  const inputs = f.snapshot.documents.filter(file => file.path === spec);
  recordProposalCoverage(f.state, spec, null, { result: hostResult(f, { inputs, status: 'failed', diagnostics: [blockingError] }) });
  assert.equal(selectApprovedPlanCoverage(f.state, proposalRunId, f.snapshot).reviewStatus, 'BLOCKED');
  assert.match((await reject('approve', approve)).message, /current Proposal plan review has blocking errors/u);
  assert.match((await reject('arm', arm)).message, /blocking errors/u);

  // A partial clean/uncertain check cannot resolve a known cross-plan error.
  for (const result of [hostResult(f, { inputs }), hostResult(f, { inputs, semanticStatus: 'failed', status: 'failed' })]) {
    recordProposalCoverage(f.state, spec, null, { result });
    assert.equal(selectApprovedPlanCoverage(f.state, proposalRunId, f.snapshot).reviewStatus, 'BLOCKED');
    await reject('arm', arm);
  }
  recordProposalCoverage(f.state, proposal, receipt);
  assert.equal((await rpc('approve', approve)).inventorySha256, approved.inventorySha256);
  assert.equal((await rpc('arm', arm)).status, 'ARMED');
});

test('strict arm is idempotent for a current clean review but every repeat rechecks the latest full-plan outcome', async t => {
  const f = await fixture(t);
  const receipt = { ...f.receipt, rows: [f.receipt.rows[0], f.receipt.rows[3]] };
  const { rpc, reject } = gatewayFixture(f, () => ({ requireProposalCoverage: true,
    readProposalSources: async () => [{ ref: source.ref, text: original.toString() }] }));
  recordProposalCoverage(f.state, proposal, receipt);
  const approved = await rpc('approve', { expectedRevision: f.snapshot.revision, requiredAtoms: receipt.rows.map(atom) });
  const arm = { expectedRevision: f.snapshot.revision, expectedInventorySha256: approved.inventorySha256, applyRunId };
  const armed = await rpc('arm', arm);
  assert.deepEqual(await rpc('arm', arm), armed);
  await reject('arm', { ...arm, applyRunId: 'different-apply' });
  recordProposalCoverage(f.state, tasks, null, { result: hostResult(f, { status: 'failed', diagnostics: [blockingError] }) });
  assert.match((await reject('arm', arm)).message, /blocking errors/u);
  recordProposalCoverage(f.state, tasks, null, { result: hostResult(f, { semanticStatus: 'failed', status: 'failed' }) });
  assert.match((await reject('arm', arm)).message, /unavailable or incomplete/u);
  recordProposalCoverage(f.state, spec, receipt);
  assert.deepEqual(await rpc('arm', arm), armed);
});

test('a pending strict arm cannot inherit authority after a newer current blocking or full-unverified review', async t => {
  for (const scenario of ['full-blocked', 'subset-blocked', 'checker-unavailable', 'missing-rows']) await t.test(scenario, async t => {
    const f = await fixture(t);
    const receipt = { ...f.receipt, rows: [f.receipt.rows[0], f.receipt.rows[3]] };
    const { rpc } = gatewayFixture(f, () => ({ requireProposalCoverage: true,
      readProposalSources: async () => [{ ref: source.ref, text: original.toString() }] }));
    recordProposalCoverage(f.state, proposal, receipt);
    const approved = await rpc('approve', { expectedRevision: f.snapshot.revision, requiredAtoms: receipt.rows.map(atom) });
    await rpc('arm', { expectedRevision: f.snapshot.revision, expectedInventorySha256: approved.inventorySha256, applyRunId });
    const result = hostResult(f, scenario === 'missing-rows' ? {} : scenario === 'checker-unavailable'
      ? { semanticStatus: 'failed', status: 'failed' }
      : { status: 'failed', diagnostics: [blockingError], ...(scenario === 'subset-blocked'
        ? { inputs: f.snapshot.documents.filter(file => file.path === spec) } : {}) });
    recordProposalCoverage(f.state, tasks, null, { result });
    // No repeated arm RPC is needed for the host to reject its stale authority.
    beginOpenSpecRun(f.state, applyRunId);
    f.state.nativeRunId = applyRunId;
    assert.equal(hasArmedOpenSpecApply(f.state, applyRunId), false);
    assert.equal(hasApprovedApplyInventory(f.state, applyRunId), false);
    assert.equal(await inspectArmedOpenSpecApply(f.state, applyRunId), null);
    assert.equal(approvedCoverageForApply(f.state, applyRunId, f.verdict), null);
  });
});

test('a clean full recheck and explicit rearm recover pending strict authority before Apply starts', async t => {
  const f = await fixture(t);
  const receipt = { ...f.receipt, rows: [f.receipt.rows[0], f.receipt.rows[3]] };
  const { rpc } = gatewayFixture(f, () => ({ requireProposalCoverage: true,
    readProposalSources: async () => [{ ref: source.ref, text: original.toString() }] }));
  recordProposalCoverage(f.state, proposal, receipt);
  const approved = await rpc('approve', { expectedRevision: f.snapshot.revision, requiredAtoms: receipt.rows.map(atom) });
  const arm = { expectedRevision: f.snapshot.revision, expectedInventorySha256: approved.inventorySha256, applyRunId };
  const armed = await rpc('arm', arm);
  recordProposalCoverage(f.state, tasks, null, { result: hostResult(f, { status: 'failed', diagnostics: [blockingError] }) });
  recordProposalCoverage(f.state, spec, receipt);
  assert.deepEqual(await rpc('arm', arm), armed);
  beginOpenSpecRun(f.state, applyRunId);
  f.state.nativeRunId = applyRunId;
  assert.equal(hasArmedOpenSpecApply(f.state, applyRunId), true);
  assert.equal(hasApprovedApplyInventory(f.state, applyRunId), true);
});

test('later Apply reviews do not revoke started strict authority and legacy pending arms keep their behavior', async t => {
  for (const strict of [true, false]) await t.test(strict ? 'started strict Apply' : 'legacy pending Apply', async t => {
    const f = await fixture(t);
    const receipt = { ...f.receipt, rows: [f.receipt.rows[0], f.receipt.rows[3]] };
    const { rpc } = gatewayFixture(f, () => ({ requireProposalCoverage: strict,
      readProposalSources: async () => [{ ref: source.ref, text: original.toString() }] }));
    recordProposalCoverage(f.state, proposal, receipt);
    const approved = await rpc('approve', { expectedRevision: f.snapshot.revision,
      ...(strict ? { requiredAtoms: receipt.rows.map(atom) } : {}) });
    await rpc('arm', { expectedRevision: f.snapshot.revision, applyRunId,
      ...(strict ? { expectedInventorySha256: approved.inventorySha256 } : {}) });
    if (strict) {
      beginOpenSpecRun(f.state, applyRunId);
      f.state.nativeRunId = applyRunId;
    }
    recordProposalCoverage(f.state, tasks, null, { result: hostResult(f, { status: 'failed', diagnostics: [blockingError] }) });
    if (!strict) {
      beginOpenSpecRun(f.state, applyRunId);
      f.state.nativeRunId = applyRunId;
    }
    assert.equal(hasArmedOpenSpecApply(f.state, applyRunId), true);
    assert.equal(hasApprovedApplyInventory(f.state, applyRunId), strict);
    assert.equal((await inspectArmedOpenSpecApply(f.state, applyRunId)).status, 'PRESERVED');
  });
});

test('stale bytes, other changes, partial scopes and foreign invocations do not poison a current clean review', async t => {
  const f = await fixture(t);
  const covered = [f.receipt.rows[0], f.receipt.rows[3]], receipt = { ...f.receipt, rows: covered };
  recordProposalCoverage(f.state, proposal, receipt);
  const inputs = f.snapshot.documents;
  const failures = [
    { result: hostResult(f, { status: 'failed', diagnostics: [blockingError],
      inputs: inputs.map((file, i) => i ? file : { ...file, sha256: sha256('stale bytes') }) }) },
    { result: hostResult(f, { status: 'failed', diagnostics: [blockingError],
      inputs: inputs.map(file => ({ ...file, path: file.path.replace(changeName, 'another-change') })) }) },
    { result: hostResult(f, { status: 'failed', semanticStatus: 'failed', inputs: inputs.slice(1),
      diagnostics: [{ ...blockingError, ruleId: 'AGENT-SEMANTIC-REVIEW-FAILED' }] }) },
    ...[{ runId: 'other-run' }, { taskId: 'other-task' }, { sessionId: 'other-session' }].map(owner => ({ ...owner,
      result: hostResult(f, { status: 'failed', diagnostics: [blockingError] }) })),
  ];
  for (const publication of failures) {
    recordProposalCoverage(f.state, tasks, null, publication);
    assert.equal(selectApprovedPlanCoverage(f.state, proposalRunId, f.snapshot).reviewStatus, 'PASSED');
  }
  const { rpc } = gatewayFixture(f, () => ({ requireProposalCoverage: true,
    readProposalSources: async () => [{ ref: source.ref, text: original.toString() }] }));
  assert.equal((await rpc('approve', { expectedRevision: f.snapshot.revision, requiredAtoms: covered.map(atom) })).status, 'APPROVED');
});

test('legacy explicit approval and arm do not acquire the strict semantic review gate', async t => {
  const f = await fixture(t);
  const { rpc } = gatewayFixture(f);
  recordProposalCoverage(f.state, tasks, null, { result: hostResult(f, { status: 'failed', diagnostics: [blockingError] }) });
  const expectedRevision = (await rpc('preview')).revision;
  assert.equal((await rpc('approve', { expectedRevision })).status, 'APPROVED');
  assert.equal((await rpc('arm', { expectedRevision, applyRunId })).status, 'ARMED');
  beginOpenSpecRun(f.state, applyRunId);
  f.state.nativeRunId = applyRunId;
  assert.equal(approvedCoverageForApply(f.state, applyRunId, f.verdict), null);
});

test('publication and Apply filtering leave the selected Proposal coverage unchanged', async t => {
  const f = await fixture(t);
  const originalRows = structuredClone(f.receipt.rows);
  recordProposalCoverage(f.state, proposal, f.receipt);
  const approved = selectApprovedPlanCoverage(f.state, proposalRunId, f.snapshot);
  f.receipt.rows[0].targets[0].path = 'outside-plan.md';
  f.receipt.rows[0].reason = 'Later caller mutation.';
  assert.deepEqual(approved.rows, originalRows);

  const preserved = currentApprovedPlanCoverage(approved, f.verdict);
  assert.deepEqual(preserved, { ...approved, applyRunId });
  await f.write(tasks, taskText.replace('[ ]', '[x]'));
  const ticked = await readOpenSpecPlan(f.state.projectRoot, changeName);
  assert.notEqual(ticked.revision, f.snapshot.revision);
  const current = currentApprovedPlanCoverage(approved, { ...f.verdict, currentRevision: ticked.revision });
  assert.deepEqual(current.rows, [originalRows[0]], 'a changed checklist suppresses checklist targets, mixed targets, and scope-only gaps');
  assert.deepEqual(approved.rows, originalRows);
});

test('Apply coverage requires the approved plan identity and a preserved verdict', async t => {
  const f = await fixture(t);
  recordProposalCoverage(f.state, proposal, f.receipt);
  const approved = selectApprovedPlanCoverage(f.state, proposalRunId, f.snapshot);
  for (const mismatch of [{ approvedRevision: sha256('different approval') }, { proposalRunId: 'different-proposal' },
    { changeName: 'other-change' }, { status: 'CHANGED' }, { status: 'UNVERIFIED' }]) {
    assert.equal(currentApprovedPlanCoverage(approved, { ...f.verdict, ...mismatch }), null);
  }
});

test('the native approval RPC pins coverage for the exact armed Apply', async t => {
  const f = await fixture(t);
  const { rpc } = gatewayFixture(f);
  recordProposalCoverage(f.state, proposal, f.receipt);
  const { revision } = await rpc('preview');
  const approved = await rpc('approve', { expectedRevision: revision });
  assert.equal(approved.status, 'APPROVED');
  assert(!Object.hasOwn(approved, 'inventorySha256'));
  recordProposalCoverage(f.state, proposal, { ...f.receipt, rows: [{ ...f.receipt.rows[0], reason: 'Later Proposal review after approval.' }] });
  assert.equal((await rpc('approve', { expectedRevision: revision })).status, 'APPROVED');
  assert.equal((await rpc('arm', { expectedRevision: revision, applyRunId })).status, 'ARMED');
  assert.equal(approvedCoverageForApply(f.state, applyRunId, f.verdict), null);
  beginOpenSpecRun(f.state, applyRunId);
  f.state.nativeRunId = applyRunId;

  await f.write(tasks, taskText.replace('[ ]', '[x]'));
  const verdict = await inspectArmedOpenSpecApply(f.state, applyRunId);
  assert.equal(verdict.status, 'PRESERVED');
  assert(!Object.hasOwn(verdict, 'rows'));
  assert.equal(approvedCoverageForApply(f.state, applyRunId, { ...verdict, applyRunId: 'other-apply' }), null);
  const coverage = approvedCoverageForApply(f.state, applyRunId, verdict);
  assert.equal(coverage.approvedRevision, revision);
  assert.deepEqual(coverage.rows, [f.receipt.rows[0]]);

  await f.write(spec, '# Preferences\nReset the saved value.\n');
  const changed = await inspectArmedOpenSpecApply(f.state, applyRunId);
  assert.equal(changed.status, 'CHANGED');
  assert.equal(approvedCoverageForApply(f.state, applyRunId, changed), null);
});

test('strict approval binds two different obligations at the same original source anchor', async t => {
  const f = await fixture(t);
  const covered = [f.receipt.rows[0], f.receipt.rows[3]];
  const requiredAtoms = covered.map(atom);
  requiredAtoms[1].requirement = `  ${requiredAtoms[1].requirement}  `;
  assert.deepEqual(requiredAtoms[0].source, requiredAtoms[1].source);
  const { rpc, reject } = gatewayFixture(f, () => ({
    requireProposalCoverage: true,
    async readProposalSources() { return [{ ref: source.ref, text: original.toString() }]; },
  }));
  recordProposalCoverage(f.state, proposal, { ...f.receipt, rows: covered });
  const { revision: expectedRevision } = await rpc('preview');
  await reject('approve', { expectedRevision });
  await reject('approve', { expectedRevision, requiredAtoms: [] });
  const approved = await rpc('approve', { expectedRevision, requiredAtoms });
  assert.equal(approved.status, 'APPROVED');
  assert.match(approved.inventorySha256, /^[a-f0-9]{64}$/u);
  assert.equal((await rpc('approve', { expectedRevision, requiredAtoms })).inventorySha256, approved.inventorySha256);
  await reject('approve', { expectedRevision, requiredAtoms: requiredAtoms.slice(0, 1) });
  const arm = { expectedRevision, applyRunId };
  await reject('arm', arm);
  await reject('arm', { ...arm, expectedInventorySha256: sha256('different inventory') });
  beginOpenSpecRun(f.state, applyRunId);
  assert.equal(hasArmedOpenSpecApply(f.state, applyRunId), false);
  assert.equal((await rpc('arm', { ...arm, expectedInventorySha256: approved.inventorySha256 })).status, 'ARMED');
  beginOpenSpecRun(f.state, applyRunId);
  assert.equal(hasArmedOpenSpecApply(f.state, applyRunId), true);
});

test('strict approval rejects a GAP, omitted or unverified atom, partial plan scope, and missing receipt', async t => {
  const options = [
    ['explicit gap', f => ({ required: [f.receipt.rows[0], f.receipt.rows[2]], receipt: f.receipt })],
    ['omitted atom sharing the covered anchor', f => ({ required: [f.receipt.rows[0], f.receipt.rows[3]],
      receipt: { ...f.receipt, rows: [f.receipt.rows[0]] } })],
    ['explicitly unverified atom', f => ({ required: [f.receipt.rows[0], f.receipt.rows[3]],
      receipt: { ...f.receipt, rows: [f.receipt.rows[0], { ...f.receipt.rows[3], disposition: 'UNVERIFIED', targets: [] }] } })],
    ['partial scope', f => ({ required: [f.receipt.rows[0], f.receipt.rows[3]], receipt: { ...f.receipt,
      scope: f.receipt.scope.filter(file => file.path !== proposal), rows: [f.receipt.rows[0], f.receipt.rows[3]] } })],
    ['no published receipt', f => ({ required: [f.receipt.rows[0], f.receipt.rows[3]], receipt: null })],
  ];
  for (const [name, scenario] of options) {
    await t.test(name, async t => {
      const f = await fixture(t);
      const { required, receipt } = scenario(f);
      const { rpc, reject } = gatewayFixture(f, () => ({
        requireProposalCoverage: true,
        async readProposalSources() { return [{ ref: source.ref, text: original.toString() }]; },
      }));
      recordProposalCoverage(f.state, proposal, receipt);
      const { revision: expectedRevision } = await rpc('preview');
      await reject('approve', { expectedRevision, requiredAtoms: required.map(atom) });
      await reject('arm', { expectedRevision, expectedInventorySha256: sha256('unapproved inventory'), applyRunId });
      beginOpenSpecRun(f.state, applyRunId);
      assert.equal(hasArmedOpenSpecApply(f.state, applyRunId), false);
      const current = await rpc('preview');
      assert.equal(current.revision, expectedRevision);
    });
  }
});

test('strict approval and arm require the same current original source bytes', async t => {
  const f = await fixture(t);
  const covered = [f.receipt.rows[0], f.receipt.rows[3]];
  const requiredAtoms = covered.map(atom);
  const sourceText = original.toString();
  const changedText = `${sourceText}\nDifferent original follow-up text.`;
  let liveSources = [{ ref: source.ref, text: changedText }];
  const { rpc, reject } = gatewayFixture(f, () => ({
    requireProposalCoverage: true,
    async readProposalSources() { return liveSources; },
  }));
  recordProposalCoverage(f.state, proposal, { ...f.receipt, rows: covered });
  const approve = { expectedRevision: (await rpc('preview')).revision, requiredAtoms };
  await reject('approve', approve);
  liveSources = [{ ref: source.ref, text: sourceText }];
  const { inventorySha256: expectedInventorySha256 } = await rpc('approve', approve);
  const arm = { expectedRevision: approve.expectedRevision, expectedInventorySha256, applyRunId };
  liveSources = [{ ref: source.ref, text: changedText }];
  await reject('arm', arm);
  liveSources = null;
  await reject('arm', arm);
  beginOpenSpecRun(f.state, applyRunId);
  assert.equal(hasArmedOpenSpecApply(f.state, applyRunId), false);
  liveSources = [{ ref: source.ref, text: sourceText }];
  assert.equal((await rpc('arm', arm)).status, 'ARMED');
});

test('an approval cannot switch coverage policy on the same Proposal run', async t => {
  for (const strictAtApproval of [true, false]) {
    await t.test(strictAtApproval ? 'strict approval cannot downgrade' : 'legacy approval cannot become strict', async t => {
      const f = await fixture(t);
      const covered = [f.receipt.rows[0], f.receipt.rows[3]];
      let strict = strictAtApproval;
      const { rpc, reject } = gatewayFixture(f, () => ({
        requireProposalCoverage: strict,
        async readProposalSources() { return [{ ref: source.ref, text: original.toString() }]; },
      }));
      recordProposalCoverage(f.state, proposal, { ...f.receipt, rows: covered });
      const { revision: expectedRevision } = await rpc('preview');
      const requiredAtoms = covered.map(atom);
      const approved = await rpc('approve', { expectedRevision, ...(strictAtApproval ? { requiredAtoms } : {}) });
      assert.equal(approved.status, 'APPROVED');
      strict = !strictAtApproval;
      await reject('approve', { expectedRevision, ...(strict ? { requiredAtoms } : {}) });
      await reject('arm', { expectedRevision, applyRunId });
      beginOpenSpecRun(f.state, applyRunId);
      assert.equal(hasArmedOpenSpecApply(f.state, applyRunId), false);
    });
  }
});
