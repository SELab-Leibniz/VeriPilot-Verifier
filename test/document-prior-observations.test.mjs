import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDocumentTools } from '../lib/document-tools.mjs';
import { readOpenSpecPlan } from '../lib/openspec-plan.mjs';
import { createOriginalSourceAnchor } from '../lib/runtime-v2/original-source-anchor.mjs';
import { knownOriginalOwner } from '../lib/runtime-v2/known-original-capacity.mjs';
import { observeKnownOriginalObligations, knownOriginalObligations, knownOriginalObligationReader,
  forgetKnownOriginalObligations } from '../lib/runtime-v2/known-original-obligations.mjs';
import { sha256 } from '../lib/runtime-v2/utils.mjs';

async function fixture(t, { count = 2, long = false, observe = true, crlf = false } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-prior-navigation-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const proposal = 'openspec/changes/navigation/proposal.md', tasks = 'openspec/changes/navigation/tasks.md';
  await fs.mkdir(path.dirname(path.join(root, proposal)), { recursive: true });
  const duties = Array.from({ length: count }, (_, i) => long ? '条'.repeat(long === 'overflow' ? 580 : 260) + i
    : `Preserve complete diagnostic ${i} when its input is invalid. 验证 🔧 é`);
  await fs.writeFile(path.join(root, proposal), '# Plan\n' + duties.join('\n') + '\n');
  await fs.writeFile(path.join(root, tasks), '- [ ] Implement and verify the complete original duties.\n');
  const plan = await readOpenSpecPlan(root, 'navigation');
  const text = ('# Request\n' + duties.join('\n') + '\n').replaceAll('\n', crlf ? '\r\n' : '\n');
  const source = { ref: 'original:user', text, sha256: sha256(text) };
  const controller = new AbortController();
  const state = { projectRoot: root, sessionId: 'owner', sessionKey: 'agent:owner', scopeTaskId: 'task',
    projectScope: { fingerprint: 'scope' }, nativeRunId: 'document-run', reviewController: controller };
  const anchors = duties.map((_, i) => createOriginalSourceAnchor({ ref: source.ref, sha256: source.sha256,
    bytes: Buffer.from(text), start: i + 2, end: i + 2 }));
  const observation = { file: path.join(root, proposal), sources: [source],
    receipt: { schemaVersion: 1, runId: state.nativeRunId, taskId: 'task', sessionId: 'owner', scope: plan.documents,
      rows: duties.map((requirement, i) => ({ source: anchors[i], requirement, disposition: 'COVERED',
        reason: 'Prior reviewer interpretation of the original clause.', targets: [{ ...plan.documents.find(file => file.path === proposal), start: i + 2, end: i + 2 }] })) },
    publication: { runId: state.nativeRunId, taskId: 'task', sessionId: 'owner', result: { status: 'passed', metadata: {
      triggerFile: proposal, inputs: plan.documents, semanticReview: { status: 'completed' } } } } };
  if (observe) assert.equal(await observeKnownOriginalObligations(state, observation), true);
  const semantic = { artifactFiles: plan.documents.map(file => file.path), originalRequirements: { digest: source.sha256, userMessages: [source] } };
  const makeTools = async (extra = {}) => {
    const tools = await createDocumentTools({ projectRoot: root, semantic,
      signal: state.reviewController.signal,
      originalDutyCohortContext: { owner: knownOriginalOwner(state), sourceRunId: state.nativeRunId },
      originalObservationReader: knownOriginalObligationReader(state), ...extra });
    const call = async args => JSON.parse((await tools.tool.execute('navigation-test', args)).content[0].text);
    return { tools, call };
  };
  return { root, state, source, observation, anchors, duties, semantic, makeTools, ...await makeTools() };
}

test('prior navigation exposes whole clauses without issuing reads, staged identities or assessments', async t => {
  const f = await fixture(t), first = knownOriginalObligations(f.state);
  const opened = await f.call({ action: 'open' });
  assert.equal(opened.priorOriginalObservations.action, 'prior_original_observations');
  const page = await f.call({ action: 'prior_original_observations' });
  assert.equal(page.total, 2); assert.equal(page.exhaustive, false);
  assert.equal(page.readProofGranted, false); assert.equal(page.stageProofGranted, false); assert.equal(page.assessmentGranted, false);
  assert.deepEqual(page.items.map(item => item.requirement), f.duties);
  const item = page.items[0];
  assert.match(item.knownCandidateId, /^known-original-/u);
  assert.equal(Object.hasOwn(item, 'originalDutyId'), false);
  await assert.rejects(f.call({ action: 'stage_original_duties', duties: [{
    originalSourceAnchorId: item.sourceAnchor.anchorId, requirement: item.requirement }] }), /DOCUMENT_ORIGINAL_DUTY_READ_REQUIRED/u);
  assert.equal(f.tools.originalDutyAccounting().status, 'NOT_EXERCISED');
  await assert.rejects(f.tools.verifyRequirementCoverage([{ originalSourceAnchorId: item.sourceAnchor.anchorId,
    requirement: item.requirement, disposition: 'UNVERIFIED', reason: 'No current source read.', targets: [] }]), /read_original in this review/u);
  const currentRead = await f.call(item.readOriginal);
  await assert.rejects(f.call({ action: 'stage_original_duties', duties: [{
    originalSourceAnchorId: item.knownCandidateId, requirement: item.requirement }] }), /DOCUMENT_ORIGINAL_DUTY_READ_REQUIRED/u);
  const staged = await f.call({ action: 'stage_original_duties', duties: [{ originalSourceAnchorId: currentRead.anchor.anchorId,
    requirement: item.requirement }] });
  assert.equal('known-original-' + staged.items[0].originalDutyId, item.knownCandidateId);
  assert.deepEqual(knownOriginalObligations(f.state), first);
});

test('the first reviewer has bounded empty navigation and cannot hydrate a serialized cohort', async t => {
  const f = await fixture(t, { observe: false });
  const empty = await f.call({ action: 'prior_original_observations' });
  assert.equal(empty.status, 'NO_PRIOR_OBSERVATIONS'); assert.equal(empty.total, 0); assert.deepEqual(empty.items, []);
  assert.equal(empty.nextStart, null); assert(Buffer.byteLength(JSON.stringify(empty)) <= 8192);
  assert.equal(f.tools.priorOriginalObservationCount, 0);
  assert.equal(Object.hasOwn((await f.call({ action: 'open' })).priorOriginalObservations, 'action'), false);
  const forged = { id: 'a'.repeat(64), owner: knownOriginalOwner(f.state), items: [] };
  await assert.rejects(f.makeTools({ originalObservationReader: forged }), /DOCUMENT_PRIOR_OBSERVATION_READER_INVALID/u);
  f.semantic.priorOriginalObservations = forged;
  const noReader = await f.makeTools({ originalObservationReader: null });
  assert.equal(noReader.tools.tool.parameters.properties.action.enum.includes('prior_original_observations'), false);
  await assert.rejects(noReader.call({ action: 'prior_original_observations' }), /DOCUMENT_PRIOR_OBSERVATIONS_UNAVAILABLE/u);
  assert.equal(knownOriginalObligations(f.state), null);
});

test('navigation preserves full Unicode duties and all IDs over bounded continuation pages', async t => {
  const f = await fixture(t, { count: 48, long: true }), collected = [];
  assert.equal(knownOriginalObligations(f.state).unavailableReason, undefined);
  let start = 1, pages = 0;
  do {
    const page = await f.call({ action: 'prior_original_observations', start, count: 20 });
    assert(Buffer.byteLength(JSON.stringify(page)) <= 8192);
    assert(page.items.length > 0); collected.push(...page.items); pages++;
    assert(page.nextStart === null || page.nextStart > start); start = page.nextStart;
  } while (start !== null);
  assert(pages > 3); assert.equal(collected.length, 48);
  assert.equal(new Set(collected.map(item => item.knownCandidateId)).size, 48);
  assert.deepEqual(collected.map(item => item.requirement), f.duties);
  assert.equal(f.tools.originalDutyAccounting().status, 'NOT_EXERCISED');
});

test('an existing oversized cohort stays explicitly unavailable without exposing partial canonical rows', async t => {
  const f = await fixture(t, { count: 48, long: 'overflow' }), cohort = knownOriginalObligations(f.state);
  assert.equal(cohort.unavailableReason, 'OBSERVATION_COHORT_LIMIT');
  const page = await f.call({ action: 'prior_original_observations' });
  assert.equal(page.status, 'UNAVAILABLE'); assert.equal(page.reason, cohort.unavailableReason);
  assert.deepEqual(page.items, []); assert.equal(page.total, 0); assert.equal(page.readProofGranted, false);
  assert.equal((await f.call({ action: 'open' })).priorOriginalObservations.status, 'UNAVAILABLE');
  assert.deepEqual(knownOriginalObligations(f.state), cohort);
});

for (const changed of ['text-only', 'source-hash']) test(`prior navigation refuses ${changed} original drift`, async t => {
  const f = await fixture(t); f.source.text += 'Changed original.';
  if (changed === 'source-hash') f.source.sha256 = sha256(f.source.text);
  await assert.rejects(f.call({ action: 'prior_original_observations' }), /DOCUMENT_(?:ORIGINAL_SOURCE_CHANGED|PRIOR_OBSERVATION_SOURCE_CHANGED)/u);
  assert.equal(f.tools.originalDutyAccounting().status, 'NOT_EXERCISED');
});

for (const changed of ['owner', 'run', 'controller', 'abort', 'forget']) test(`prior navigation rejects changed ${changed}`, async t => {
  const f = await fixture(t);
  if (changed === 'owner') f.state.sessionKey = 'agent:foreign';
  if (changed === 'run') f.state.nativeRunId = 'different-run';
  if (changed === 'controller') f.state.reviewController = new AbortController();
  if (changed === 'abort') f.state.reviewController.abort(new Error('Current owner cancelled'));
  if (changed === 'forget') forgetKnownOriginalObligations(f.state);
  await assert.rejects(f.call({ action: 'prior_original_observations' }), error => changed === 'abort'
    ? /Current owner cancelled/u.test(error.message) : error.code === 'STOP_TASK_INPUT_CHANGED');
});

test('historical publication run may differ while the live reader validates the current owner and run', async t => {
  const f = await fixture(t), first = knownOriginalObligations(f.state);
  f.state.nativeRunId = 'later-document-run'; f.state.reviewController = new AbortController();
  const later = await f.makeTools(), page = await later.call({ action: 'prior_original_observations' });
  assert.equal(page.items.length, 2); assert.equal(page.snapshotId, first.id);
  f.state.nativeRunId = 'changed-after-binding';
  await assert.rejects(later.call({ action: 'prior_original_observations' }), { code: 'STOP_TASK_INPUT_CHANGED' });
});

test('a fresh different original span stays a distinct identity without implicit merging', async t => {
  const f = await fixture(t), page = await f.call({ action: 'prior_original_observations' });
  const read = await f.call({ action: 'read_original', ref: f.source.ref, start: 2, count: 2 });
  const staged = await f.call({ action: 'stage_original_duties', duties: [{
    originalSourceAnchorId: read.anchor.anchorId, requirement: page.items[0].requirement }] });
  assert.notEqual('known-original-' + staged.items[0].originalDutyId, page.items[0].knownCandidateId);
  assert.equal(knownOriginalObligations(f.state).items.length, 2);
});

test('CRLF and UTF-8 prior anchors round trip through genuine fresh original reads', async t => {
  const f = await fixture(t, { crlf: true }), page = await f.call({ action: 'prior_original_observations' });
  for (const item of page.items) {
    const current = await f.call(item.readOriginal);
    assert.deepEqual(current.anchor, item.sourceAnchor);
    assert(current.text.includes(item.requirement));
  }
});

test('a newly published cohort separates document notes and cache identity from the earlier empty view', async t => {
  const f = await fixture(t, { observe: false });
  const file = f.tools.manifest()[0].path;
  await f.call({ action: 'read', path: file, start: 1, count: 200 });
  await f.call({ action: 'remember', key: 'prior-view', note: 'This earlier review had no prior observations.', paths: [file] });
  assert.equal((await f.call({ action: 'recall' })).current.length, 1);
  assert.equal(f.tools.originalObservationIdentity, null);
  assert.equal(await observeKnownOriginalObligations(f.state, f.observation), true);
  const later = await f.makeTools();
  assert.equal(later.tools.originalObservationIdentity, knownOriginalObligations(f.state).id);
  assert.equal((await later.call({ action: 'recall' })).current.length, 0);
  await assert.rejects(f.call({ action: 'prior_original_observations' }), { code: 'STOP_TASK_INPUT_CHANGED' });
});
