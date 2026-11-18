import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { approvedApplyRepairCurrent, approvedInventoryForApply, beginOpenSpecRun, hasApprovedApplyInventory, hasPreparedOpenSpecProposalReview,
  inspectArmedOpenSpecApply, openSpecApplyFinding, openSpecProposalReviewRequirements, registerOpenSpecPlanControl, releaseOpenSpecProposalSession,
  reserveApprovedApplyRepair } from '../lib/openclaw/openspec-plan-control.mjs';
import { recordProposalCoverage as recordCoverage } from '../lib/openclaw/approved-plan-coverage.mjs';
import { publishProposalCoverage } from './support/proposal-coverage.mjs';
import { nativeTranscriptObservation } from '../lib/openclaw/native-transcript.mjs';
import { transcriptUserMessages } from '../lib/runtime-v2/original-requirements.mjs';
import { createOriginalSourceAnchor } from '../lib/runtime-v2/original-source-anchor.mjs';
import { sha256 } from '../lib/runtime-v2/utils.mjs';

const recordProposalCoverage = (...args) => publishProposalCoverage(recordCoverage, ...args);

const changeName = 'preserve-sort-order';
const otherChange = 'preserve-search-term';
const specPath = 'specs/preferences/spec.md';
const tasks = '# Tasks\n\n- [ ] Keep the saved order.\n- [ ] Verify the restored order.\n';
const actor = (...scopes) => ({ connect: { role: 'operator', scopes } });
const reader = actor('operator.read');
const operator = actor('operator.read', 'operator.write');

async function fixture(t, { verifyPreparation } = {}) {
  const projectRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-openspec-control-')));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  const planPath = (name, file) => path.join(projectRoot, 'openspec', 'changes', name, file);
  const write = (file, contents, name = changeName) => fs.writeFile(planPath(name, file), contents);
  for (const name of [changeName, otherChange]) {
    await fs.mkdir(path.dirname(planPath(name, specPath)), { recursive: true });
    await Promise.all([
      write('proposal.md', '# Proposal\n\nPreserve display preferences.\n', name),
      write('design.md', '# Design\n\nRestore the saved preference when the page loads.\n', name),
      write('tasks.md', tasks, name),
      write(specPath, '## ADDED Requirements\n\n### Requirement: Preferences\n\nThe application SHALL retain the saved order.\n', name),
    ]);
  }

  const methods = new Map(), live = new Map(), lookups = [], preparations = [];
  const address = (runId, sessionId = 'first') => ({ sessionKey: `agent:main:whatsapp:direct:+${sessionId}`, sessionId, runId, changeName });
  const sessions = new Map(['first', 'second'].map(sessionId => [sessionId,
    { projectRoot, projectScope: { fingerprint: `scope-${sessionId}` }, sessionId, agentId: 'main', scopeTaskId: `task-${sessionId}` }]));
  const api = {
    registerGatewayMethod(name, handler, options) {
      assert(!methods.has(name));
      methods.set(name, { handler, options });
    },
  };
  const runtime = {
    openSpecProposalOwner: api,
    async openSpecProposalSession(query) {
      preparations.push(query);
      const state = sessions.get(query.sessionId);
      if (verifyPreparation) return verifyPreparation(query, state);
      return state && query.sessionKey === address(query.runId, query.sessionId).sessionKey && state.nativeRunId !== query.runId
        ? state.projectScope.fingerprint : null;
    },
    async openSpecPlanTarget(query) {
      lookups.push(query);
      const target = live.get(query.sessionKey);
      if (!target?.settled || target.sessionId !== query.sessionId || target.runId !== query.runId) return null;
      return {
        state: target.state, projectRoot, requireProposalCoverage: target.requireProposalCoverage,
        readProposalSources: async () => target.sources,
        async current() {
          await target.beforeCurrent?.();
          return live.get(query.sessionKey) === target && target.settled;
        },
      };
    },
  };
  registerOpenSpecPlanControl(api, runtime);

  function run(runId, { sessionId = 'first', settled = true, beforeCurrent, requireProposalCoverage = false, sources } = {}) {
    const target = address(runId, sessionId);
    const { sessionKey } = target;
    const state = sessions.get(sessionId);
    assert(state);
    state.sessionKey = sessionKey;
    if (state.nativeRunId !== runId) beginOpenSpecRun(state, runId, { proposalOwner: api });
    state.nativeRunId = runId;
    live.set(sessionKey, { sessionId, runId, state, settled, beforeCurrent, requireProposalCoverage, sources });
    return target;
  }
  async function call(action, params, client = operator) {
    const { handler } = methods.get(`runtime-corrector.openspec.${action}`);
    const responses = [];
    await handler({ params, client, respond: (...args) => responses.push(args) });
    assert.equal(responses.length, 1, `${action} must settle exactly once`);
    return responses[0];
  }
  async function ok(action, params, client) {
    const [success, value, error] = await call(action, params, client);
    assert.equal(success, true, error?.message);
    return value;
  }
  async function rejected(action, params, code, client) {
    const [success, value, error] = await call(action, params, client);
    assert.equal(success, false);
    assert.equal(value, undefined);
    assert.equal(error?.code, code);
    assert.match(error.message, /\S/u);
  }
  async function approve(proposal) {
    const { revision } = await ok('preview', proposal, reader);
    return ok('approve', { ...proposal, expectedRevision: revision });
  }
  return { api, address, run, ok, rejected, approve, write, planPath, methods, lookups, preparations, state: sessionId => sessions.get(sessionId),
    refreshRegistration() {
      methods.clear();
      registerOpenSpecPlanControl({ ...api }, { ...runtime });
    },
    inspect: ({ sessionId, runId }) => inspectArmedOpenSpecApply(sessions.get(sessionId), runId) };
}

test('authenticated gateway scopes separate plan reads from approval and arming', async t => {
  const f = await fixture(t);
  const proposal = f.run('proposal');
  assert.deepEqual(Object.fromEntries([...f.methods].map(([name, { options }]) => [name, options.scope])), {
    'runtime-corrector.openspec.prepare': 'operator.write',
    'runtime-corrector.openspec.preview': 'operator.read',
    'runtime-corrector.openspec.approve': 'operator.write',
    'runtime-corrector.openspec.arm': 'operator.write',
    'runtime-corrector.openspec.verify': 'operator.read',
  });
  const snapshot = await f.ok('preview', proposal, reader);
  const approval = { ...proposal, expectedRevision: snapshot.revision };
  const arming = { ...approval, applyRunId: 'apply' };
  const agentRuntime = { ...operator, internal: { agentRuntimeIdentity: {} } };
  const attempts = f.lookups.length;
  for (const [action, params] of Object.entries({ preview: proposal, approve: approval, arm: arming, verify: proposal })) {
    await f.rejected(action, params, 'FORBIDDEN', null);
    await f.rejected(action, params, 'FORBIDDEN', agentRuntime);
  }
  await f.rejected('approve', approval, 'FORBIDDEN', reader);
  await f.rejected('arm', arming, 'FORBIDDEN', reader);
  await f.rejected('preview', { ...proposal, projectRoot: '/tmp' }, 'INVALID_REQUEST');
  await f.rejected('preview', { ...proposal, changeName: '../other-change' }, 'INVALID_REQUEST');
  assert.equal(f.lookups.length, attempts, 'unauthorized or invalid requests must not resolve a run');
  assert.deepEqual(f.lookups[0], {
    sessionKey: proposal.sessionKey, sessionId: proposal.sessionId, runId: proposal.runId,
  });
});

test('approved plan accepts checkbox progress and reports a changed spec path', async t => {
  const f = await fixture(t);
  const proposal = f.run('proposal');
  const preview = await f.ok('preview', proposal, reader);
  assert.equal(preview.runId, proposal.runId);
  assert.equal(preview.changeName, changeName);
  assert.match(preview.revision, /^[a-f0-9]{64}$/u);
  assert.equal(preview.taskCount, 2);
  assert.equal(preview.completedTaskCount, 0);
  const original = { ...proposal, expectedRevision: preview.revision };
  const approved = await f.ok('approve', original);
  assert.deepEqual(approved, { status: 'APPROVED', changeName, revision: preview.revision, runId: proposal.runId });
  assert.deepEqual(await f.ok('approve', original), approved);

  await f.write('tasks.md', tasks.replace('- [ ] Keep', '- [x] Keep'));
  const apply = f.run('apply');
  const preserved = await f.ok('verify', apply, reader);
  assert.equal(preserved.status, 'PRESERVED');
  assert.equal(preserved.proposalRunId, proposal.runId);
  assert.equal(preserved.applyRunId, apply.runId);
  assert.equal(preserved.approvedRevision, preview.revision);
  assert.notEqual(preserved.currentRevision, preview.revision);
  assert.equal(preserved.completedTaskCount, 1);
  assert.deepEqual(preserved.differences, []);

  await f.write(specPath, '## ADDED Requirements\n\n### Requirement: Preferences\n\nThe application SHALL omit saved order.\n');
  const changed = await f.ok('verify', f.run('apply-recheck'), reader);
  assert.equal(changed.status, 'CHANGED');
  assert.equal(changed.approvedRevision, preview.revision);
  assert.deepEqual(changed.differences, [`openspec/changes/${changeName}/${specPath}`]);
});

test('approval requires the previewed bytes and cannot be replaced on the same run', async t => {
  const f = await fixture(t);
  const proposal = f.run('proposal');
  const first = await f.ok('preview', proposal);
  const amended = tasks.replace('Verify the restored order.', 'Verify the restored order after reopening.');
  await f.write('tasks.md', amended);
  await f.rejected('approve', { ...proposal, expectedRevision: first.revision }, 'CONFLICT');
  const approved = await f.approve(proposal);
  assert.notEqual(approved.revision, first.revision);

  await f.write('tasks.md', tasks);
  const newest = await f.ok('preview', proposal);
  assert.equal(newest.revision, first.revision);
  await f.rejected('approve', { ...proposal, expectedRevision: newest.revision }, 'CONFLICT');
  const verdict = await f.ok('verify', f.run('apply'));
  assert.equal(verdict.status, 'CHANGED');
  assert.equal(verdict.approvedRevision, approved.revision);
  assert.deepEqual(verdict.differences, [`openspec/changes/${changeName}/tasks.md`]);
});

test('an approval is confined to a change and a distinct live run of its own session', async t => {
  const f = await fixture(t);
  const proposal = f.run('proposal');
  await f.approve(proposal);
  const unverified = { status: 'UNVERIFIED', differences: [], reason: 'DISTINCT_APPROVED_PROPOSAL_REQUIRED' };
  assert.deepEqual(await f.ok('verify', proposal), unverified);
  const otherSession = f.run('apply', { sessionId: 'second' });
  assert.deepEqual(await f.ok('verify', otherSession), unverified);
  const apply = f.run('apply');
  assert.deepEqual(await f.ok('verify', { ...apply, changeName: otherChange }), unverified);
  await f.rejected('verify', { ...apply, sessionId: otherSession.sessionId }, 'CONFLICT');
  await f.rejected('verify', proposal, 'CONFLICT');
  assert.equal((await f.ok('verify', apply)).status, 'PRESERVED');
  await f.rejected('verify', f.run('unfinished', { settled: false }), 'CONFLICT');
});

test('verification keeps missing current plan evidence unverified', async t => {
  const f = await fixture(t);
  await f.approve(f.run('proposal'));
  await fs.rm(f.planPath(changeName, 'proposal.md'));
  assert.deepEqual(await f.ok('verify', f.run('apply')), {
    status: 'UNVERIFIED', differences: [], reason: 'CURRENT_PLAN_UNAVAILABLE',
  });
});

test('verification rejects a run that becomes stale while its snapshot is being settled', async t => {
  const f = await fixture(t);
  const approved = await f.approve(f.run('proposal'));
  let signalReached, releaseRun;
  const reached = new Promise(resolve => { signalReached = resolve; });
  const release = new Promise(resolve => { releaseRun = resolve; });
  t.after(releaseRun);
  const pending = f.rejected('verify', f.run('apply', {
    async beforeCurrent() {
      signalReached();
      await release;
    },
  }), 'CONFLICT');
  await Promise.race([reached, pending.then(() => assert.fail('verify settled without checking current run'))]);
  const successor = f.run('next-apply');
  releaseRun();
  await pending;
  const verified = await f.ok('verify', successor);
  assert.equal(verified.status, 'PRESERVED');
  assert.equal(verified.approvedRevision, approved.revision);
});

test('arming requires the current approved revision and one distinct external Apply run', async t => {
  const f = await fixture(t);
  const proposal = f.run('proposal');
  const preview = await f.ok('preview', proposal);
  const params = { ...proposal, expectedRevision: preview.revision, applyRunId: 'apply' };
  await f.rejected('arm', params, 'CONFLICT');
  await f.approve(proposal);
  await f.rejected('arm', { ...params, applyRunId: undefined }, 'INVALID_REQUEST');
  await f.rejected('arm', { ...params, applyRunId: proposal.runId }, 'INVALID_REQUEST');
  await f.rejected('arm', { ...params, applyRunId: 'rc-stop-internal' }, 'INVALID_REQUEST');
  await f.rejected('arm', { ...params, changeName: otherChange }, 'CONFLICT');
  await f.rejected('arm', { ...params, expectedRevision: 'f'.repeat(64) }, 'CONFLICT');
  const otherProposal = f.run('proposal', { sessionId: 'second' });
  await f.rejected('arm', { ...params, ...otherProposal }, 'CONFLICT');

  await f.write('tasks.md', tasks.replace('Keep the saved order.', 'Keep all saved preferences.'));
  await f.rejected('arm', params, 'CONFLICT');
  await f.write('tasks.md', tasks);
  const armed = await f.ok('arm', params);
  assert.deepEqual(armed, { status: 'ARMED', changeName, runId: 'proposal', applyRunId: 'apply', revision: preview.revision });
  assert.deepEqual(await f.ok('arm', params), armed);
  await f.rejected('arm', { ...params, applyRunId: 'different-apply' }, 'CONFLICT');
  assert.equal(await f.inspect({ ...proposal, runId: 'apply' }), null);
});

test('an intervening native run invalidates the armed next Apply', async t => {
  const f = await fixture(t);
  const proposal = f.run('proposal');
  const approved = await f.approve(proposal);
  const params = { ...proposal, expectedRevision: approved.revision, applyRunId: 'apply' };
  await f.ok('arm', params);
  assert.equal(await f.inspect(f.run('unrelated')), null);
  await f.rejected('arm', params, 'CONFLICT');
  assert.equal(await f.inspect(f.run('apply')), null);
});

test('the admitted Apply rechecks the exact plan and distinguishes drift, incomplete progress, and unavailable evidence', async t => {
  const f = await fixture(t);
  const proposal = f.run('proposal');
  const approved = await f.approve(proposal);
  await f.ok('arm', { ...proposal, expectedRevision: approved.revision, applyRunId: 'apply' });
  const apply = f.run('apply');
  assert.equal(await f.inspect(f.run('apply', { sessionId: 'second' })), null);

  const openTasks = await f.inspect(apply);
  assert.equal(openTasks.status, 'PRESERVED');
  assert.equal(openTasks.completedTaskCount, 0);
  assert.equal(openSpecApplyFinding(openTasks).reasonCode, 'OPENSPEC_APPLY_PLAN_INCOMPLETE');
  await f.write('tasks.md', tasks.replace('- [ ] Keep', '- [x] Keep'));
  const partial = await f.inspect(apply);
  assert.equal(partial.status, 'PRESERVED');
  assert.equal(partial.completedTaskCount, 1);
  assert.equal(openSpecApplyFinding(partial).reviewStatus, 'UNVERIFIED');
  assert.match(openSpecApplyFinding(partial).verificationFeedback, /1\/2 approved tasks/u);

  const completed = tasks.replaceAll('[ ]', '[x]');
  await f.write('tasks.md', completed);
  const preserved = await f.inspect(apply);
  assert.deepEqual(await f.ok('verify', apply, reader), preserved);
  assert.equal(preserved.completedTaskCount, 2);
  assert.equal(openSpecApplyFinding(preserved), null);
  assert.notEqual(preserved.currentRevision, partial.currentRevision);

  const modifiedSpec = '## ADDED Requirements\n\n### Requirement: Preferences\n\nThe application SHALL discard the saved order.\n';
  await f.write(specPath, modifiedSpec);
  await f.write('tasks.md', '# Tasks\n');
  const drift = await f.inspect(apply);
  const prefix = `openspec/changes/${changeName}`;
  assert.equal(drift.status, 'CHANGED');
  assert.equal(drift.taskCount, 0);
  assert.equal(drift.approvedRevision, approved.revision);
  assert.deepEqual(drift.differences, [`${prefix}/${specPath}`, `${prefix}/tasks.md`]);
  const finding = openSpecApplyFinding(drift);
  assert.equal(finding.reviewStatus, 'DEVIATION');
  assert.equal(finding.reasonCode, 'OPENSPEC_APPLY_PLAN_CHANGED');
  assert(finding.verificationFeedback.includes(`${prefix}/${specPath}`));
  assert.equal(await fs.readFile(f.planPath(changeName, specPath), 'utf8'), modifiedSpec);
  assert.equal(await fs.readFile(f.planPath(changeName, 'tasks.md'), 'utf8'), '# Tasks\n');

  await fs.rm(f.planPath(changeName, 'tasks.md'));
  const unavailable = await f.inspect(apply);
  assert.equal(unavailable.status, 'UNVERIFIED');
  assert.equal(unavailable.reason, 'CURRENT_PLAN_UNAVAILABLE');
  assert.deepEqual(unavailable.differences, []);
  assert(!Object.hasOwn(unavailable, 'currentRevision'));
  assert.equal(openSpecApplyFinding(unavailable).reasonCode, 'OPENSPEC_APPLY_PLAN_UNVERIFIED');
});

test('an admitted Apply replaced during inspection cannot publish its old snapshot', async t => {
  const f = await fixture(t);
  const proposal = f.run('proposal');
  const approved = await f.approve(proposal);
  await f.ok('arm', { ...proposal, expectedRevision: approved.revision, applyRunId: 'apply' });
  const apply = f.run('apply');
  assert.equal((await f.inspect(apply)).status, 'PRESERVED');
  const pending = f.inspect(apply);
  const successor = f.run('unrelated');
  assert.equal(await pending, null);
  assert.equal(await f.inspect(apply), null);
  assert.equal(await f.inspect(successor), null);
});

const userRecord = (id, runId, content) => ({ id, type: 'message',
  message: { role: 'user', content, idempotencyKey: `${runId}:user` } });

const originalText = '配置 task\nKeep the saved order.\nUse the saved order after restart.';
const publicRequirement = { start: 2, end: 2, requirement: 'Keep the saved order.' };
const stageRequest = (f, runId = 'proposal', options = {}) => ({ ...f.address(runId),
  sourceRunId: runId, sourceSha256: sha256(originalText), requirements: [publicRequirement], ...options });

test('operator-only Proposal preparation is immutable and validates the intended host session', async t => {
  const f = await fixture(t);
  const request = stageRequest(f);
  await f.rejected('prepare', request, 'FORBIDDEN', reader);
  await f.rejected('prepare', request, 'FORBIDDEN', { ...operator, internal: { agentRuntimeIdentity: {} } });
  for (const changes of [
    { projectRoot: f.state('first').projectRoot }, { changeName: '../foreign' }, { sourceSha256: 'unverified' },
    { runId: 'rc-stop-fake' }, { requirements: [] }, { requirements: [publicRequirement, publicRequirement] },
    { requirements: [{ ...publicRequirement, start: 0 }] }, { requirements: [{ ...publicRequirement, end: 1 }] },
    { requirements: [{ ...publicRequirement, requirement: 'Padded text. ' }] },
    { requirements: [{ ...publicRequirement, requirement: 'a'.repeat(601) }] },
  ]) await f.rejected('prepare', { ...request, ...changes }, 'INVALID_REQUEST');
  assert.deepEqual(f.preparations, []);
  await f.rejected('prepare', { ...request, sessionId: 'missing' }, 'CONFLICT');
  const receipt = { status: 'PREPARED', runId: request.runId, sourceRunId: request.sourceRunId, changeName, requirementCount: 1 };
  assert.deepEqual(await f.ok('prepare', request), receipt);
  assert.deepEqual(await f.ok('prepare', request), receipt);
  await f.rejected('prepare', { ...request, requirements: [{ ...publicRequirement, requirement: 'Changed obligation.' }] }, 'CONFLICT');
  await f.rejected('prepare', stageRequest(f, 'unrelated'), 'CONFLICT');
  await f.rejected('prepare', { ...request, ...f.address(request.runId, 'second') }, 'CONFLICT');
  assert.deepEqual(f.preparations.at(-1), { sessionKey: request.sessionKey, sessionId: request.sessionId, runId: request.runId });
  assert.equal(hasPreparedOpenSpecProposalReview(f.api, f.state('first')), false, 'prepare never admits a future run');
});

test('only the exact native run, workspace, change and last user source can resolve prepared atoms', async t => {
  const f = await fixture(t);
  const original = userRecord('original', 'proposal', originalText);
  const observed = nativeTranscriptObservation([original]);
  await f.ok('prepare', stageRequest(f));
  f.refreshRegistration();
  f.run('proposal', { sessionId: 'second' });
  assert.equal(hasPreparedOpenSpecProposalReview(f.api, f.state('second')), false);
  f.run('proposal');
  const state = f.state('first');
  const read = (observation, name = changeName) => openSpecProposalReviewRequirements(f.api, state, { changeName: name, observed: observation });
  assert.equal(hasPreparedOpenSpecProposalReview(f.api, state), true);
  for (const records of [
    [userRecord('original', 'fake-proposal', originalText)],
    [userRecord('original', 'proposal', 'Similar task.')],
    [{ ...original, isMeta: true }],
    [original, userRecord('duplicate', 'proposal', originalText)],
    [original, userRecord('later', 'follow-up', 'Different current issue.')],
  ]) assert.equal(read(nativeTranscriptObservation(records)), null);
  assert.equal(read(observed, otherChange), null);
  assert.equal(read({ ...observed, status: 'STALE' }), null);
  const source = createOriginalSourceAnchor({ ...publicRequirement, ref: 'transcript:original', sha256: sha256(originalText), bytes: Buffer.from(originalText) });
  const review = read(observed);
  assert.deepEqual(review, { requiredAtoms: [{ ...publicRequirement, source }] });
  review.requiredAtoms[0].requirement = 'Changed from private requester.';
  assert.deepEqual(read(observed), { requiredAtoms: [{ ...publicRequirement, source }] });
  f.run('unrelated');
  assert.equal(hasPreparedOpenSpecProposalReview(f.api, state), false);
  assert.equal(read(observed), null);

  await f.ok('prepare', stageRequest(f, 'new-scope'));
  state.projectScope = { fingerprint: 'different-project' };
  f.run('new-scope');
  assert.equal(hasPreparedOpenSpecProposalReview(f.api, state), false);
});

test('a prepared Proposal retry can only bind the admitted predecessor and its exact original source', async t => {
  const f = await fixture(t);
  const original = userRecord('original', 'proposal', originalText);
  await f.ok('prepare', stageRequest(f));
  f.run('proposal');
  const retry = stageRequest(f, 'retry', { sourceRunId: 'proposal' });
  await f.rejected('prepare', { ...retry, changeName: otherChange }, 'CONFLICT');
  await f.ok('prepare', retry);
  f.run('retry');
  const internal = { ...userRecord('internal', 'retry', 'Resume strict validation.'), isMeta: true };
  const state = f.state('first');
  const resolve = records => openSpecProposalReviewRequirements(f.api, state, { changeName, observed: nativeTranscriptObservation(records) });
  assert.equal(resolve([original, userRecord('external', 'retry', originalText)]), null);
  assert.equal(resolve([original, internal]).requiredAtoms[0].source.ref, 'transcript:original');

  await f.ok('prepare', stageRequest(f, 'foreign-retry', { sourceRunId: 'proposal' }));
  f.run('foreign-retry');
  assert.equal(resolve([original, internal]), null, 'an earlier matching turn cannot replace the exact predecessor');
});

test('unclaimed stages expire, claimed stages stay bound, and a run cannot race a pending validation', async t => {
  let now = 1_000;
  t.mock.method(Date, 'now', () => now);
  let finishValidation;
  const f = await fixture(t, { verifyPreparation: (query, state) => query.runId === 'racing'
    ? new Promise(resolve => { finishValidation = () => resolve(state.projectScope.fingerprint); }) : state?.projectScope.fingerprint });
  await f.ok('prepare', stageRequest(f, 'expired'));
  now += 600_000;
  f.run('expired');
  assert.equal(hasPreparedOpenSpecProposalReview(f.api, f.state('first')), false);

  const racing = f.rejected('prepare', stageRequest(f, 'racing'), 'CONFLICT');
  assert.equal(typeof finishValidation, 'function');
  f.run('racing');
  finishValidation();
  await racing;
  assert.equal(hasPreparedOpenSpecProposalReview(f.api, f.state('first')), false);

  await f.ok('prepare', stageRequest(f, 'claimed'));
  f.run('claimed');
  now += 600_000;
  assert.equal(hasPreparedOpenSpecProposalReview(f.api, f.state('first')), true);
});

test('a full registry preserves claimed preparation and admits another session after expiry', async t => {
  let now = 1_000;
  t.mock.method(Date, 'now', () => now);
  const f = await fixture(t, { verifyPreparation: () => 'scope-first' });
  await f.ok('prepare', stageRequest(f));
  f.run('proposal');
  for (let index = 0; index < 127; index++) {
    const runId = `pending-${index}`;
    await f.ok('prepare', stageRequest(f, runId, f.address(runId, `pending-session-${index}`)));
  }
  const next = stageRequest(f, 'new-proposal', f.address('new-proposal', 'second'));
  await f.rejected('prepare', next, 'CONFLICT');
  assert.equal(hasPreparedOpenSpecProposalReview(f.api, f.state('first')), true);
  now += 600_000;
  assert.equal((await f.ok('prepare', next)).status, 'PREPARED');
  assert.equal(hasPreparedOpenSpecProposalReview(f.api, f.state('first')), true);
});

test('retiring a prepared session releases its slot and fences the claimed run against legacy approval', async t => {
  const f = await fixture(t);
  const request = stageRequest(f);
  await f.ok('prepare', request);
  const proposal = f.run(request.runId, { requireProposalCoverage: true });
  const state = f.state(proposal.sessionId);
  assert(hasPreparedOpenSpecProposalReview(f.api, state));
  releaseOpenSpecProposalSession(f.api, state);
  assert.equal(hasPreparedOpenSpecProposalReview(f.api, state), false);
  f.run(request.runId, { requireProposalCoverage: false });
  const preview = await f.ok('preview', proposal, reader);
  await f.rejected('approve', { ...proposal, expectedRevision: preview.revision }, 'CONFLICT');

  const replacement = stageRequest(f, 'proposal-future');
  assert.equal((await f.ok('prepare', replacement)).status, 'PREPARED');
  f.run(replacement.runId);
  assert(hasPreparedOpenSpecProposalReview(f.api, state));
});

test('strict approval enforces the private staged atom inventory without adding approval authority', async t => {
  const f = await fixture(t);
  const original = nativeTranscriptObservation([userRecord('original', 'proposal', originalText)]);
  const sources = transcriptUserMessages(original);
  const staged = stageRequest(f);
  await f.ok('prepare', staged);
  const proposal = f.run('proposal', { requireProposalCoverage: true, sources });
  const state = f.state(proposal.sessionId), preview = await f.ok('preview', proposal, reader);
  const atom = ({ start, end, requirement }) => ({ source: { ref: sources[0].ref, sha256: staged.sourceSha256, start, end }, requirement });
  const requiredAtoms = [atom(publicRequirement)];
  const otherAtom = atom({ start: 3, end: 3, requirement: 'Use the saved order after restart.' });
  const approve = { ...proposal, expectedRevision: preview.revision, requiredAtoms };
  await f.rejected('approve', approve, 'FORBIDDEN', reader);
  await f.rejected('approve', approve, 'CONFLICT');
  const target = preview.documents.find(file => file.path.endsWith('/spec.md'));
  recordProposalCoverage(state, target.path, { runId: proposal.runId, taskId: state.scopeTaskId, sessionId: proposal.sessionId,
    scope: preview.documents, rows: [...requiredAtoms, otherAtom].map(({ source, requirement }) => ({
      source: createOriginalSourceAnchor({ ...source, bytes: Buffer.from(originalText) }), requirement, disposition: 'COVERED',
      targets: [{ ...target, start: 3, end: 3 }],
    })) });
  await f.rejected('approve', approve, 'CONFLICT');
  assert(openSpecProposalReviewRequirements(f.api, state, { changeName, observed: original }));
  await f.rejected('approve', { ...approve, requiredAtoms: [otherAtom] }, 'CONFLICT');
  await f.rejected('approve', { ...approve, requiredAtoms: [...requiredAtoms, otherAtom] }, 'CONFLICT');
  const approval = await f.ok('approve', approve);
  assert.equal(approval.requiredAtomCount, 1);
  assert.equal(hasPreparedOpenSpecProposalReview(f.api, state), false);
  assert.deepEqual(await f.ok('approve', approve), approval);
});

test('sealed Proposal review navigation survives preparation release only for its exact native source, revision and scope', async t => {
  const f = await fixture(t);
  const observed = nativeTranscriptObservation([userRecord('original', 'proposal', originalText)]);
  const sources = transcriptUserMessages(observed);
  await f.ok('prepare', stageRequest(f));
  const proposal = f.run('proposal', { requireProposalCoverage: true, sources });
  const state = f.state(proposal.sessionId), snapshot = await f.ok('preview', proposal, reader);
  const requested = { source: { ref: sources[0].ref, sha256: sha256(originalText), start: 2, end: 2 },
    requirement: publicRequirement.requirement };
  assert(openSpecProposalReviewRequirements(f.api, state, { changeName, observed }));
  const source = createOriginalSourceAnchor({ ...requested.source, bytes: Buffer.from(originalText) });
  const target = snapshot.documents.find(file => file.path.endsWith('/spec.md'));
  recordProposalCoverage(state, target.path, { runId: proposal.runId, taskId: state.scopeTaskId, sessionId: state.sessionId,
    scope: snapshot.documents, rows: [{ source, requirement: requested.requirement, disposition: 'COVERED',
      targets: [{ ...target, start: 5, end: 5 }] }] });
  await f.ok('approve', { ...proposal, expectedRevision: snapshot.revision, requiredAtoms: [requested] });
  assert.equal(hasPreparedOpenSpecProposalReview(f.api, state), false);
  const read = overrides => openSpecProposalReviewRequirements(f.api, state, { changeName, observed, snapshot, ...overrides });
  const expected = { requiredAtoms: [{ start: 2, end: 2, source, requirement: requested.requirement }] };
  assert.deepEqual(read(), expected);
  const changed = read();
  changed.requiredAtoms[0].requirement = 'Caller mutation cannot replace sealed wording.';
  assert.deepEqual(read(), expected);
  assert.equal(read({ snapshot: { ...snapshot, revision: sha256('other revision') } }), null);
  assert.equal(read({ changeName: otherChange }), null);
  assert.equal(read({ snapshot: undefined }), null);
  assert.equal(read({ observed: nativeTranscriptObservation([userRecord('original', 'proposal', `${originalText}\nNew source.`)]) }), null);
  for (const [key, value] of [['nativeRunId', 'apply'], ['scopeTaskId', 'other-task'], ['sessionId', 'other-session'],
    ['sessionKey', 'agent:main:other'], ['scopeClosed', true], ['nativeInvalidated', true],
    ['projectScope', { fingerprint: 'changed-scope' }]]) {
    const prior = state[key];
    state[key] = value;
    assert.equal(read(), null, key);
    state[key] = prior;
  }
  assert.deepEqual(read(), expected);
});

async function strictApply(t) {
  const f = await fixture(t);
  const original = userRecord('native-original', 'proposal', 'Keep the saved order.');
  const [source] = transcriptUserMessages(nativeTranscriptObservation([original]));
  const proposal = f.run('proposal', { requireProposalCoverage: true, sources: [source] });
  const state = f.state(proposal.sessionId);
  const snapshot = await f.ok('preview', proposal, reader);
  const identity = { ref: source.ref, sha256: sha256(source.text), start: 1, end: 1 };
  const anchor = createOriginalSourceAnchor({ ...identity, bytes: Buffer.from(source.text) });
  const requirement = 'Keep the saved order.';
  const target = snapshot.documents.find(file => file.path.endsWith('/spec.md'));
  recordProposalCoverage(state, target.path, { runId: proposal.runId, taskId: state.scopeTaskId, sessionId: proposal.sessionId,
    scope: snapshot.documents, rows: [{ source: anchor, requirement, disposition: 'COVERED',
      targets: [{ ...target, start: 3, end: 3 }] }] });
  const approved = await f.ok('approve', { ...proposal, expectedRevision: snapshot.revision,
    requiredAtoms: [{ source: identity, requirement }] });
  const armed = await f.ok('arm', { ...proposal, expectedRevision: snapshot.revision, applyRunId: 'apply',
    expectedInventorySha256: approved.inventorySha256 });
  const apply = f.run(armed.applyRunId);
  await f.write('tasks.md', tasks.replaceAll('[ ]', '[x]'));
  const input = userRecord('native-apply', apply.runId, 'Apply the approved change.');
  return { f, state, proposal, approved, apply, original, input };
}

test('strict Apply inventory requires its exact original messages and native Apply input', async t => {
  const { f, state, proposal, approved, apply, original, input } = await strictApply(t);
  assert.equal(hasApprovedApplyInventory(state, proposal.runId), false);
  assert.equal(hasApprovedApplyInventory(state, apply.runId), true);
  const foreign = userRecord('foreign-user', 'unrelated', 'Apply the approved change.');
  const revised = { ...original, message: { ...original.message, content: 'Keep a different saved order.' } };
  for (const records of [[revised, input], [original, foreign], [original, input, foreign]])
    assert.equal(approvedInventoryForApply(state, apply.runId, nativeTranscriptObservation(records)), null);
  const observed = nativeTranscriptObservation([original, input]);
  const inventory = approvedInventoryForApply(state, apply.runId, observed);
  assert.equal(inventory.inventorySha256, approved.inventorySha256);
  assert.equal(inventory.taskId, state.scopeTaskId);
  assert.equal(inventory.sessionId, apply.sessionId);
  assert.equal(inventory.requiredAtoms.length, 1);
  assert.equal(inventory.requiredAtoms[0].requirement, 'Keep the saved order.');
  const inspected = await f.inspect(apply);
  assert.equal(inspected.applyRunId, apply.runId);
  assert.equal(inspected.status, 'PRESERVED');
  assert.equal(inspected.completedTaskCount, 2);
  const modifiedInput = { ...input, message: { ...input.message, content: 'Apply a changed instruction.' } };
  assert.equal(approvedInventoryForApply(state, apply.runId, nativeTranscriptObservation([original, modifiedInput])), null);

  const unrelated = f.run('unrelated');
  assert.equal(hasApprovedApplyInventory(state, unrelated.runId), false);
  assert.equal(approvedInventoryForApply(state, apply.runId, observed), null);
  assert.equal(approvedInventoryForApply(state, unrelated.runId, observed), null);
});

test('strict inventory follows only the reserved native corrective successor', async t => {
  const { f, state, approved, apply, original, input } = await strictApply(t);
  const observed = nativeTranscriptObservation([original, input]);
  assert(approvedInventoryForApply(state, apply.runId, observed));
  const admissionId = 'a'.repeat(64), runId = `rc-stop-${admissionId}`;
  const { currentRevision: openSpecPlanRevision } = await f.inspect(apply);
  const request = { runId, taskId: state.scopeTaskId, sessionKey: apply.sessionKey, agentId: state.agentId,
    projectRoot: state.projectRoot, source: { runId: apply.runId, usersDigest: observed.externalUsersDigest, openSpecPlanRevision } };
  const reservation = { ...request, admissionId, admission: { id: admissionId } };
  assert.equal(reserveApprovedApplyRepair(state, { ...reservation, source: { ...reservation.source, runId: 'other-run' } }), false);
  assert.equal(reserveApprovedApplyRepair(state, { ...reservation, taskId: 'other-task' }), false);
  assert.equal(reserveApprovedApplyRepair(state, { ...reservation, source: { ...reservation.source, usersDigest: 'b'.repeat(64) } }), false);
  assert.equal(reserveApprovedApplyRepair(state, reservation), true);
  assert.equal(await approvedApplyRepairCurrent(state, request), true);
  const design = await fs.readFile(f.planPath(changeName, 'design.md'), 'utf8');
  await f.write('design.md', `${design}\nChange the design after repair is queued.\n`);
  assert.equal(await approvedApplyRepairCurrent(state, request), false);
  await f.write('design.md', design);
  f.run(runId);
  assert.equal(hasApprovedApplyInventory(state, runId), true);
  assert.equal(await approvedApplyRepairCurrent(state, request), true);

  const control = { id: 'native-correction', type: 'message', message: { role: 'user', content: 'A native corrective reference.' } };
  const repairObserved = nativeTranscriptObservation([original, input, { ...control, isMeta: true }]);
  assert.equal(repairObserved.externalUsersDigest, observed.externalUsersDigest);
  const startedAt = 1200, gate = { at: startedAt - 1 };
  const receipt = { ...request, gate, admissionId, modelObservedAt: startedAt, status: 'STARTED',
    admission: { id: admissionId, accounting: 'USED', executionId: runId, startStatus: 'STARTED', deliveryStatus: 'DELIVERED',
      startedAt, deadlineAt: 2000, lateConfirmation: false, hostRequest: { ...request, gate } } };
  assert.equal(approvedInventoryForApply(state, runId, repairObserved), null);
  for (const untrusted of [
    { ...receipt, status: 'ADMITTED' },
    { ...receipt, admission: { ...receipt.admission, executionId: 'other-run' } },
    { ...receipt, admission: { ...receipt.admission, lateConfirmation: true } },
    { ...receipt, admission: { ...receipt.admission, invalidatedAt: startedAt + 1 } },
    { ...receipt, source: { ...request.source, usersDigest: 'b'.repeat(64) } },
  ]) assert.equal(approvedInventoryForApply(state, runId, repairObserved, untrusted), null);
  assert.equal(approvedInventoryForApply(state, runId, nativeTranscriptObservation([original, input, control]), receipt), null);
  const inventory = approvedInventoryForApply(state, runId, repairObserved, receipt);
  assert.equal(inventory.inventorySha256, approved.inventorySha256);
  assert.equal(inventory.taskId, state.scopeTaskId);
  assert.equal(inventory.sessionId, apply.sessionId);
  const inspected = await f.inspect({ runId, sessionId: apply.sessionId });
  assert.equal(inspected.applyRunId, apply.runId);
  assert.equal(inspected.continuationRunId, runId);
  assert.equal(inspected.status, 'PRESERVED');
});
