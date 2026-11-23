import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDocumentTools, ORIGINAL_DUTY_ACCOUNTING_VERSION, ORIGINAL_DUTY_ACCOUNTING_INSTRUCTION } from '../lib/document-tools.mjs';
import { readOpenSpecPlan } from '../lib/openspec-plan.mjs';
import { createOriginalSourceAnchor } from '../lib/runtime-v2/original-source-anchor.mjs';
import { observeKnownOriginalObligations, knownOriginalObligations } from '../lib/runtime-v2/known-original-obligations.mjs';
import { sha256 } from '../lib/runtime-v2/utils.mjs';
import { knownOriginalOwner, knownOriginalItems, projectKnownOriginalCohort,
  knownOriginalCapacity } from '../lib/runtime-v2/known-original-capacity.mjs';

const duties = ['When recording is enabled, preserve segment order.', 'Retain diagnostic labels on every retained segment.', 'Preserve the retained segment count.'];
async function fixture(t, { text = '# Request\n' + duties.join('\n') + '\n', partial = false, strict = false,
  sourceRef = 'transcript:original' } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-duty-accounting-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const proposal = 'openspec/changes/recording/proposal.md', tasks = 'openspec/changes/recording/tasks.md';
  await fs.mkdir(path.dirname(path.join(root, proposal)), { recursive: true });
  await fs.writeFile(path.join(root, proposal), '# Plan\nPreserve segment order and diagnostic labels.\nPreserve retained segment count.\n');
  await fs.writeFile(path.join(root, tasks), '- [ ] Implement the declared duties.\n');
  const snapshot = await readOpenSpecPlan(root, 'recording');
  const source = { ref: sourceRef, text, sha256: sha256(text) };
  let now = 0; const deadline = 100, controller = new AbortController();
  const state = { projectRoot: root, sessionId: 'owner', sessionKey: 'agent:owner', scopeTaskId: 'task',
    projectScope: { fingerprint: 'scope' }, nativeRunId: 'proposal-run', reviewController: controller };
  const semantic = { artifactFiles: partial ? [proposal] : snapshot.documents.map(file => file.path),
    originalRequirements: { digest: sha256(text), userMessages: [source] } };
  const strictAnchor = createOriginalSourceAnchor({ ref: source.ref, sha256: source.sha256, bytes: Buffer.from(text), start: 2, end: 2 });
  const tools = await createDocumentTools({ projectRoot: root, semantic, signal: controller.signal,
    originalDutyCohortContext: { owner: knownOriginalOwner(state), sourceRunId: state.nativeRunId },
    scopeIdentity: { taskId: 'task', sessionId: 'owner' },
    active: () => { if (now >= deadline) throw Object.assign(new Error('Original deadline expired'), { code: 'ORIGINAL_DEADLINE' }); },
    ...(strict ? { requiredProposalReview: { requiredAtoms: [{ source: strictAnchor, start: 2, end: 2, requirement: duties[0] }] } } : {}) });
  const call = async args => JSON.parse((await tools.tool.execute('owned-call', args)).content[0].text);
  const anchors = [];
  for (let start = 2; start <= Math.min(4, text.split('\n').length - 1); start++) anchors.push((await call({ action: 'read_original', ref: source.ref, start, count: 1 })).anchor);
  const stage = async values => call({ action: 'stage_original_duties', duties: values ?? duties.map((requirement, i) => ({ originalSourceAnchorId: anchors[i].anchorId, requirement })) });
  const readPlan = async () => { for (const file of tools.manifest()) await call({ action: 'read', path: file.path, start: 1, count: 200 }); };
  const row = (item, changes = {}) => ({ originalDutyId: item.originalDutyId, originalSourceAnchorId: item.originalSourceAnchorId,
    requirement: item.requirement, disposition: 'COVERED', reason: 'The current plan represents this complete duty.', targets: [{ path: proposal, start: 2, end: 3 }], ...changes });
  const observe = async receipt => {
    const state = { projectRoot: root, sessionId: 'owner', sessionKey: 'agent:owner', scopeTaskId: 'task',
      projectScope: { fingerprint: 'scope' }, nativeRunId: 'proposal-run', reviewController: controller };
    const observed = await observeKnownOriginalObligations(state, { file: path.join(root, proposal), sources: [source],
      receipt: { ...receipt, runId: 'proposal-run', taskId: 'task', sessionId: 'owner' },
      publication: { runId: 'proposal-run', taskId: 'task', sessionId: 'owner', result: { status: 'passed', metadata: {
        triggerFile: proposal, inputs: snapshot.documents, semanticReview: { status: 'completed' } } } } });
    return { observed, cohort: knownOriginalObligations(state) };
  };
  return { root, proposal, tools, source, snapshot, anchors, controller, state, stage, readPlan, row, observe, call,
    advance(value) { now = value; }, get now() { return now; }, deadline };
}

test('three staged duties survive a two-row final assessment through the actual known-cohort handoff', async t => {
  const f = await fixture(t), staged = await f.stage(); await f.readPlan();
  const receipt = await f.tools.verifyRequirementCoverage(staged.items.slice(0, 2).map(item => f.row(item)));
  assert.equal(receipt.rows.length, 3); const missing = receipt.rows.find(row => row.disposition === 'UNVERIFIED');
  assert.equal(missing.requirement, staged.items[2].requirement); assert.equal(missing.originalDutyAccountingIssue, 'FINAL_DUTY_ASSESSMENT_MISSING');
  assert.deepEqual(missing.targets, []); assert.equal(receipt.originalDutyAccounting.unverifiedStagedCount, 1);
  const result = await f.observe(receipt); assert.equal(result.observed, true); assert.equal(result.cohort.items.length, 3);
  assert.deepEqual(new Set(result.cohort.items.map(item => item.requirement)), new Set(duties));
  assert.equal(result.cohort.exhaustive, false); assert.equal(receipt.originalDutyAccounting.semanticsVerified, false);
});
test('corrected complete current mapping retains three separate duties without invented uncertainty', async t => {
  const f = await fixture(t), staged = await f.stage(); await f.readPlan();
  const receipt = await f.tools.verifyRequirementCoverage(staged.items.map(item => f.row(item)));
  assert.equal(receipt.originalDutyAccounting.unverifiedStagedCount, 0); assert(receipt.rows.every(row => row.disposition === 'COVERED'));
  assert.equal((await f.observe(receipt)).cohort.items.length, 3);
});
test('a narrowed final requirement cannot replace a staged full conditional duty', async t => {
  const f = await fixture(t), staged = await f.stage(); await f.readPlan();
  const target = staged.items.find(item => item.requirement === duties[0]);
  const receipt = await f.tools.verifyRequirementCoverage(staged.items.map(item => f.row(item,
    item.originalDutyId === target.originalDutyId ? { requirement: 'Preserve order.' } : {})));
  const retained = receipt.rows.find(row => row.originalDutyId === target.originalDutyId);
  assert.equal(retained.requirement, duties[0]); assert.equal(retained.disposition, 'UNVERIFIED');
  assert.equal(retained.originalDutyAccountingIssue, 'CANONICAL_DUTY_CHANGED');
  assert((await f.observe(receipt)).cohort.items.some(item => item.requirement === duties[0]));
});
test('two Chinese conditional duties at one original anchor keep distinct IDs and full canonical clauses', async t => {
  const clauses = ['启用记录时，保持所有片段的原始顺序。', '发生截断时，保留每个已保留片段的诊断标签。'];
  const f = await fixture(t, { text: '# 原始要求\n' + clauses.join('') + '\n' });
  const staged = await f.stage(clauses.map(requirement => ({ originalSourceAnchorId: f.anchors[0].anchorId, requirement })));
  assert.equal(new Set(staged.items.map(item => item.originalDutyId)).size, 2);
  assert.equal(new Set(staged.items.map(item => item.originalSourceAnchorId)).size, 1); await f.readPlan();
  const receipt = await f.tools.verifyRequirementCoverage(staged.items.map(item => f.row(item)));
  const { cohort } = await f.observe(receipt); assert.deepEqual(new Set(cohort.items.map(item => item.requirement)), new Set(clauses));
  assert.equal(new Set(cohort.items.map(item => item.id)).size, 2);
});
test('the first table is immutable and exact reordered idempotence does not renew its scope', async t => {
  const f = await fixture(t), staged = await f.stage();
  const original = duties.map((requirement, i) => ({ originalSourceAnchorId: f.anchors[i].anchorId, requirement }));
  assert.deepEqual((await f.stage([...original].reverse())).items, staged.items);
  await assert.rejects(f.stage(original.slice(0, 2)), /DOCUMENT_ORIGINAL_DUTIES_FROZEN/u);
  assert.equal((await f.call({ action: 'stage_original_duties' })).stagedCount, 3);
});
test('stale current plan bytes cannot acquire or publish the staged accounting', async t => {
  const f = await fixture(t); await f.stage(); await f.readPlan();
  await fs.appendFile(path.join(f.root, f.proposal), '\nChanged plan.\n');
  await assert.rejects(f.call({ action: 'stage_original_duties' }), /DOCUMENT_EVIDENCE_CHANGED/u);
  await assert.rejects(f.tools.verifyRequirementCoverage([]), /DOCUMENT_EVIDENCE_CHANGED/u);
});
test('stale original source bytes cannot stage or validate an old anchor', async t => {
  const f = await fixture(t); f.source.text += 'Changed original.';
  await assert.rejects(f.stage(), /DOCUMENT_ORIGINAL_SOURCE_CHANGED/u);
  assert.equal(f.tools.originalDutyAccounting().status, 'NOT_EXERCISED');
});
test('the same original deadline and cancellation remain authoritative after staging', async t => {
  const f = await fixture(t); await f.stage(); f.advance(99);
  assert.equal((await f.call({ action: 'stage_original_duties' })).stagedCount, 3); assert.equal(f.now, 99);
  f.advance(f.deadline); await assert.rejects(f.call({ action: 'stage_original_duties' }), { code: 'ORIGINAL_DEADLINE' });
  await assert.rejects(f.tools.verifyRequirementCoverage([]), { code: 'ORIGINAL_DEADLINE' });
  const g = await fixture(t); await g.stage(); g.controller.abort(new Error('Original owner cancelled'));
  await assert.rejects(g.tools.verifyRequirementCoverage([]), /Original owner cancelled/u);
});
test('limits and invalid navigation cannot partially freeze a table', async t => {
  const f = await fixture(t), one = { originalSourceAnchorId: f.anchors[0].anchorId, requirement: duties[0] };
  await assert.rejects(f.stage([one, one]), /DOCUMENT_ORIGINAL_DUTY_DUPLICATE/u);
  await assert.rejects(f.stage(Array.from({ length: 49 }, (_, i) => ({ ...one, requirement: 'Duty ' + i }))), /DOCUMENT_ORIGINAL_DUTY_LIMIT/u);
  await assert.rejects(f.stage(Array.from({ length: 48 }, (_, i) => ({ ...one, requirement: '条'.repeat(590) + i }))), /DOCUMENT_ORIGINAL_DUTY_LIMIT/u);
  await assert.rejects(f.call({ action: 'stage_original_duties', duties: [one], count: 0 }), /DOCUMENT_RANGE_INVALID/u);
  assert.equal(f.tools.originalDutyAccounting().status, 'NOT_EXERCISED');
});
test('UTF-8 frozen navigation pages retain every duty without granting reads or exceeding 8KiB', async t => {
  const f = await fixture(t), values = Array.from({ length: 24 }, (_, i) => ({ originalSourceAnchorId: f.anchors[0].anchorId,
    requirement: '保留完整条件和义务'.repeat(25) + i }));
  let page = await f.stage(values); const ids = [];
  while (true) {
    assert(Buffer.byteLength(JSON.stringify(page)) <= 8192); assert.equal(page.navigationOnly, true); assert.equal(page.readProofGranted, false);
    assert.equal(page.semanticsVerified, false); ids.push(...page.items.map(item => item.originalDutyId));
    if (page.nextStart === null) break; page = await f.call({ action: 'stage_original_duties', start: page.nextStart, count: 20 });
  }
  assert.equal(new Set(ids).size, values.length);
});
test('unopened accounting stays non-exercised and cannot discover an unstaged third duty', async t => {
  const f = await fixture(t); assert.equal(f.tools.originalDutyAccounting().version, ORIGINAL_DUTY_ACCOUNTING_VERSION);
  assert.equal(f.tools.originalDutyAccounting().status, 'NOT_EXERCISED'); assert.equal(await f.tools.verifyRequirementCoverage(), null);
  await f.readPlan(); const receipt = await f.tools.verifyRequirementCoverage(duties.slice(0, 2).map((requirement, i) => ({
    originalSourceAnchorId: f.anchors[i].anchorId, requirement, disposition: 'COVERED', reason: 'Current plan interpretation.',
    targets: [{ path: f.proposal, start: 2, end: 2 }] })));
  assert.equal(receipt.originalDutyAccounting.status, 'NOT_EXERCISED'); assert.equal(receipt.rows.length, 2);
  assert.equal((await f.observe(receipt)).cohort.items.length, 2, 'Discovery is not a host semantic oracle.');
});
test('partial plan review cannot open this whole-plan accounting action', async t => {
  const f = await fixture(t, { partial: true }); assert.equal(f.tools.originalDutyAccounting(), null);
  assert(!f.tools.tool.parameters.properties.action.enum.includes('stage_original_duties'));
  await assert.rejects(f.stage(), /DOCUMENT_ORIGINAL_DUTY_ACCOUNTING_UNAVAILABLE/u);
});
test('strict required-Proposal identity rules and foreign staged-ID rejection remain separate', async t => {
  const f = await fixture(t, { strict: true }); await assert.rejects(f.tools.verifyRequirementCoverage([]), { code: 'DOCUMENT_REQUIREMENT_COVERAGE_INVALID' });
  const staged = await f.stage(); await f.readPlan();
  await assert.rejects(f.tools.verifyRequirementCoverage([f.row(staged.items[0], { originalDutyId: 'f'.repeat(64) })]), { code: 'DOCUMENT_REQUIREMENT_COVERAGE_INVALID' });
  const strictDuty = staged.items.find(item => item.requirement === duties[0]);
  const receipt = await f.tools.verifyRequirementCoverage(staged.items.map(item => f.row(item,
    item === strictDuty ? { requiredProposalId: sha256([f.anchors[0].anchorId, duties[0]]) } : {})));
  assert.equal(receipt.rows.length, 3);
});

test('a new plan document cannot be omitted from the initially captured whole-plan accounting', async t => {
  const f = await fixture(t); await f.stage(); await f.readPlan();
  await fs.writeFile(path.join(f.root, 'openspec/changes/recording/design.md'), '# Added design\nPreserve all declared duties.\n');
  await assert.rejects(f.call({ action: 'stage_original_duties' }), /DOCUMENT_ORIGINAL_DUTY_PLAN_CHANGED/u);
  await assert.rejects(f.tools.verifyRequirementCoverage([]), /DOCUMENT_ORIGINAL_DUTY_PLAN_CHANGED/u);
});

test('later local staging cannot replace or expand an already frozen known-original cohort', async t => {
  const f = await fixture(t); await f.readPlan();
  const firstReceipt = await f.tools.verifyRequirementCoverage(duties.slice(0, 2).map((requirement, i) => ({
    originalSourceAnchorId: f.anchors[i].anchorId, requirement, disposition: 'COVERED',
    reason: 'The first review assessed these two discovered duties.', targets: [{ path: f.proposal, start: 2, end: 2 }] })));
  const state = { projectRoot: f.root, sessionId: 'owner', sessionKey: 'agent:owner', scopeTaskId: 'task',
    projectScope: { fingerprint: 'scope' }, nativeRunId: 'first-review', reviewController: f.controller };
  const publish = receipt => observeKnownOriginalObligations(state, { file: path.join(f.root, f.proposal), sources: [f.source],
    receipt: { ...receipt, runId: state.nativeRunId, taskId: 'task', sessionId: 'owner' },
    publication: { runId: state.nativeRunId, taskId: 'task', sessionId: 'owner', result: { status: 'passed', metadata: {
      triggerFile: f.proposal, inputs: f.snapshot.documents, semanticReview: { status: 'completed' } } } } });
  assert.equal(await publish(firstReceipt), true); const frozen = knownOriginalObligations(state);
  assert.equal(frozen.items.length, 2);
  state.nativeRunId = 'later-review'; state.reviewController = new AbortController();
  const later = await createDocumentTools({ projectRoot: f.root,
    semantic: { artifactFiles: f.snapshot.documents.map(file => file.path),
      originalRequirements: { digest: sha256(f.source.text), userMessages: [f.source] } },
    signal: state.reviewController.signal, scopeIdentity: { taskId: 'task', sessionId: 'owner', runId: 'later-review' },
    originalDutyCohortContext: { owner: knownOriginalOwner(state), sourceRunId: state.nativeRunId } });
  const rows = [];
  for (const [i, requirement] of duties.entries()) {
    const { anchor } = await later.execute({ action: 'read_original', ref: f.source.ref, start: i + 2, count: 1 });
    rows.push({ originalSourceAnchorId: anchor.anchorId, requirement });
  }
  const staged = await later.execute({ action: 'stage_original_duties', duties: rows });
  assert.equal(staged.status, 'STAGED'); assert.equal(staged.stagedCount, 3);
  for (const file of later.manifest()) await later.execute({ action: 'read', path: file.path, start: 1, count: 200 });
  const laterReceipt = await later.verifyRequirementCoverage(staged.items.slice(0, 2).map(item => f.row(item)));
  assert.equal(laterReceipt.rows.length, 3); assert.equal(laterReceipt.rows.filter(row => row.disposition === 'UNVERIFIED').length, 1);
  assert.equal(await publish(laterReceipt), false, 'A later local receipt is not successful downstream retention.');
  assert.deepEqual(knownOriginalObligations(state), frozen); assert.equal(knownOriginalObligations(state).items.length, 2);
  assert.match(ORIGINAL_DUTY_ACCOUNTING_INSTRUCTION, /Only before the first known-original cohort is frozen/u);
  assert.match(ORIGINAL_DUTY_ACCOUNTING_INSTRUCTION, /does not replace, expand or add protection to an already frozen cohort/u);
});

const extraDuty = 'When a configuration error occurs, preserve the distinct configuration diagnostic.';
const manyDuties = Array.from({ length: 48 }, (_, i) => `When event ${i} occurs, preserve output ${i} and its diagnostic label.`);
async function stageMany(f, requirements = manyDuties) {
  const count = f.source.text.trimEnd().split(/\r?\n/u).length - 1;
  const { anchor } = await f.call({ action: 'read_original', ref: f.source.ref, start: 2, count });
  const values = requirements.map(requirement => ({ originalSourceAnchorId: anchor.anchorId, requirement }));
  let page = await f.stage(values); const items = [];
  while (true) {
    items.push(...page.items);
    if (page.nextStart === null) break;
    page = await f.call({ action: 'stage_original_duties', start: page.nextStart, count: 20 });
  }
  return { values, items, anchor };
}
const uncertain = (f, item) => f.row(item, { disposition: 'UNVERIFIED', reason: 'Current plan support remains unverified.', targets: [] });
const publish = (f, receipt, status = 'completed') => observeKnownOriginalObligations(f.state, {
  file: path.join(f.root, f.proposal), sources: [f.source],
  receipt: { runId: f.state.nativeRunId, taskId: f.state.scopeTaskId, sessionId: f.state.sessionId, ...receipt },
  publication: { runId: f.state.nativeRunId, taskId: f.state.scopeTaskId, sessionId: f.state.sessionId,
    result: { status: status === 'failed' ? 'failed' : 'passed', metadata: { triggerFile: f.proposal,
      inputs: f.snapshot.documents, semanticReview: { status } } } },
});

test('48 staged plus a genuine distinct49th original duty rejects the union and keeps sticky aggregate U', async t => {
  const f = await fixture(t, { text: '# Request\n' + [...manyDuties, extraDuty].join('\n') + '\n' });
  const staged = await stageMany(f); await f.readPlan();
  const extra = { originalSourceAnchorId: staged.anchor.anchorId, requirement: extraDuty,
    disposition: 'UNVERIFIED', reason: 'This distinct49th original clause was read but not staged.', targets: [] };
  await assert.rejects(f.tools.verifyRequirementCoverage([extra]), { code: 'DOCUMENT_ORIGINAL_DUTY_CAPACITY_UNVERIFIED' });
  const rejected = f.tools.originalDutyCapacityFailure();
  assert.equal(rejected.rows.length, 49); assert.equal(rejected.originalDutyAccounting.capacity.count, 49);
  assert.equal(rejected.originalDutyAccounting.status, 'UNVERIFIED_CAPACITY');
  assert(rejected.rows.every(row => row.disposition === 'UNVERIFIED'));
  assert.deepEqual(new Set(rejected.rows.filter(row => row.originalDutyId).map(row => row.requirement)), new Set(manyDuties));
  assert.equal(await publish(f, rejected, 'failed'), false);
  const pending = knownOriginalObligations(f.state);
  assert.equal(pending.unavailableReason, 'OBSERVATION_COHORT_LIMIT');
  assert.equal(pending.capacityUnverified, true); assert.equal(pending.protectionLimitExceeded, true);
  assert.equal(pending.observedProtectedCandidateCount, 49); assert.equal(pending.protectedCanonicalCountWithinLimit, false);
  assert(pending.requiredCanonicalCandidateIds.length <= 48);
  const legacy = { ...rejected, rows: [rejected.rows.find(row => row.originalDutyId)],
    originalDutyAccounting: { version: ORIGINAL_DUTY_ACCOUNTING_VERSION, status: 'NOT_EXERCISED', stagedCount: 0 } };
  assert.equal(await publish(f, legacy), false, 'An unstaged subset cannot erase pending canonical duties.');
  assert.deepEqual(knownOriginalObligations(f.state), pending);
  await assert.rejects(f.tools.verifyRequirementCoverage(staged.items.map(item => uncertain(f, item))),
    { code: 'DOCUMENT_ORIGINAL_DUTY_CAPACITY_UNVERIFIED' });
  assert.equal(f.tools.originalDutyCapacityFailure().rows.length, 49);
  assert.deepEqual(knownOriginalObligations(f.state), pending);
});

test('48 staged plus48 distinct unkeyed final rows rejects96 without trimming either set', async t => {
  const additional = manyDuties.map((_, i) => `When configuration ${i} is rejected, retain its separate diagnostic.`);
  const f = await fixture(t, { text: '# Request\n' + [...manyDuties, ...additional].join('\n') + '\n' });
  const staged = await stageMany(f); await f.readPlan();
  const extras = staged.items.map((item, i) => ({ originalSourceAnchorId: item.originalSourceAnchorId,
    requirement: additional[i], disposition: 'UNVERIFIED', reason: 'A separate read original clause was not staged.', targets: [] }));
  await assert.rejects(f.tools.verifyRequirementCoverage(extras), { code: 'DOCUMENT_ORIGINAL_DUTY_CAPACITY_UNVERIFIED' });
  const rejected = f.tools.originalDutyCapacityFailure(); assert.equal(rejected.rows.length, 96);
  assert.equal(rejected.rows.filter(row => row.originalDutyId).length, 48);
  assert.equal(rejected.rows.filter(row => !row.originalDutyId).length, 48);
  assert.equal(await publish(f, rejected, 'failed'), false);
  assert.equal(knownOriginalObligations(f.state).observedCandidateCount, 96);
});

test('small valid staging input with large UTF8 source anchors rejects actual serialized cohort bytes', async t => {
  const f = await fixture(t, { text: '# Request\n' + manyDuties.join('\n') + '\n', sourceRef: 'transcript:' + '原'.repeat(400) });
  const staged = await stageMany(f); await f.readPlan();
  assert(Buffer.byteLength(JSON.stringify(staged.values)) < 65536);
  await assert.rejects(f.tools.verifyRequirementCoverage([]), { code: 'DOCUMENT_ORIGINAL_DUTY_CAPACITY_UNVERIFIED' });
  const rejected = f.tools.originalDutyCapacityFailure();
  assert.equal(rejected.rows.length, 48); assert(rejected.originalDutyAccounting.capacity.bytes > 65536);
  const projected = projectKnownOriginalCohort({ owner: knownOriginalOwner(f.state), sourceRunId: f.state.nativeRunId,
    changeName: 'recording', planRevision: f.snapshot.revision, items: knownOriginalItems(rejected.rows) });
  assert.equal(Buffer.byteLength(JSON.stringify(projected)), rejected.originalDutyAccounting.capacity.bytes);
  assert.equal(await publish(f, rejected, 'failed'), false);
  assert.equal(knownOriginalObligations(f.state).capacity.bytes, rejected.originalDutyAccounting.capacity.bytes);
  f.state.scopeTaskId = 'another-owner-task'; assert.equal(knownOriginalObligations(f.state), null);
  assert.equal(await publish(f, rejected, 'failed'), false, 'A different owner cannot inherit the old failed source binding.');
});

test('exact48 within count and UTF8 byte capacity retains every canonical missing assessment', async t => {
  const f = await fixture(t, { text: '# Request\n' + manyDuties.join('\n') + '\n' });
  const staged = await stageMany(f); await f.readPlan();
  const receipt = await f.tools.verifyRequirementCoverage(staged.items.slice(0, 47).map(item => uncertain(f, item)));
  assert.equal(receipt.rows.length, 48); assert.equal(receipt.rows.filter(row => row.originalDutyAccountingIssue === 'FINAL_DUTY_ASSESSMENT_MISSING').length, 1);
  assert.deepEqual(new Set(receipt.rows.map(row => row.requirement)), new Set(manyDuties));
  assert.equal(await publish(f, receipt), true); const frozen = knownOriginalObligations(f.state);
  assert.equal(frozen.items.length, 48); assert(Buffer.byteLength(JSON.stringify({ ...frozen, id: undefined })) <= 65536);
});

test('shared exact projection keeps65536bytes and rejects65537 without changing either limit', async t => {
  const f = await fixture(t); await f.readPlan();
  const receipt = await f.tools.verifyRequirementCoverage(duties.map((requirement, i) => ({
    originalSourceAnchorId: f.anchors[i].anchorId, requirement, disposition: 'UNVERIFIED', reason: 'No semantic claim.', targets: [] })));
  const make = owner => projectKnownOriginalCohort({ owner, sourceRunId: f.state.nativeRunId,
    changeName: 'recording', planRevision: f.snapshot.revision, items: knownOriginalItems(receipt.rows) });
  const owner = knownOriginalOwner(f.state), baseline = make(owner), bytes = Buffer.byteLength(JSON.stringify(baseline));
  const exact = make({ ...owner, scopeFingerprint: owner.scopeFingerprint + 'x'.repeat(65536 - bytes) });
  assert.equal(Buffer.byteLength(JSON.stringify(exact)), 65536); assert.equal(knownOriginalCapacity(exact).withinLimits, true);
  exact.owner.scopeFingerprint += 'x'; assert.equal(knownOriginalCapacity(exact).withinLimits, false);
  assert.equal(knownOriginalCapacity(exact).maximumCount, 48); assert.equal(knownOriginalCapacity(exact).maximumBytes, 65536);
});

test('later capacity failure cannot change an already valid first cohort or create an augmentation path', async t => {
  const f = await fixture(t, { text: '# Request\n' + manyDuties.join('\n') + '\n' }); await f.readPlan();
  const first = await f.tools.verifyRequirementCoverage(manyDuties.slice(0, 2).map((requirement, i) => ({
    originalSourceAnchorId: f.anchors[i].anchorId, requirement, disposition: 'UNVERIFIED', reason: 'First observations.', targets: [] })));
  assert.equal(await publish(f, first), true); const before = JSON.stringify(knownOriginalObligations(f.state));
  const staged = await stageMany(f);
  await assert.rejects(f.tools.verifyRequirementCoverage([{ originalSourceAnchorId: staged.anchor.anchorId,
    requirement: 'Narrowed extra.', disposition: 'UNVERIFIED', reason: 'Not canonical.', targets: [] }]),
  { code: 'DOCUMENT_ORIGINAL_DUTY_CAPACITY_UNVERIFIED' });
  assert.equal(await publish(f, f.tools.originalDutyCapacityFailure(), 'failed'), false);
  assert.equal(JSON.stringify(knownOriginalObligations(f.state)), before);
});

test('staging needs host publication ownership while unopened legacy document coverage remains available', async t => {
  const f = await fixture(t);
  const tools = await createDocumentTools({ projectRoot: f.root, signal: f.controller.signal,
    semantic: { artifactFiles: f.snapshot.documents.map(file => file.path),
      originalRequirements: { digest: sha256(f.source.text), userMessages: [f.source] } } });
  const read = await tools.execute({ action: 'read_original', ref: f.source.ref, start: 2, count: 1 });
  await assert.rejects(tools.execute({ action: 'stage_original_duties', duties: [
    { originalSourceAnchorId: read.anchor.anchorId, requirement: duties[0] }] }),
  /DOCUMENT_ORIGINAL_DUTY_PUBLICATION_CONTEXT_REQUIRED/u);
  assert.equal(tools.originalDutyAccounting().status, 'NOT_EXERCISED');
  assert.equal(await tools.verifyRequirementCoverage(), null);
});

async function pendingCapacityFixture(t) {
  const f = await fixture(t, { text: '# Request\n' + [...manyDuties, extraDuty].join('\n') + '\n', sourceRef: '原'.repeat(1000) });
  const staged = await stageMany(f); await f.readPlan();
  await assert.rejects(f.tools.verifyRequirementCoverage([]), { code: 'DOCUMENT_ORIGINAL_DUTY_CAPACITY_UNVERIFIED' });
  const rejected = f.tools.originalDutyCapacityFailure(); assert.equal(rejected.rows.length, 48);
  assert.equal(await publish(f, rejected, 'failed'), false);
  return { f, staged, rejected };
}

test('repeated capacity failure retains every validated identity independent of optional staging markers', async t => {
  const { f, rejected } = await pendingCapacityFixture(t);
  const before = knownOriginalObligations(f.state), withoutMarkers = structuredClone(rejected);
  for (const row of withoutMarkers.rows) delete row.originalDutyId;
  withoutMarkers.originalDutyAccounting.stagedCount = 1;
  assert.equal(await publish(f, withoutMarkers, 'failed'), false);
  assert.deepEqual(knownOriginalObligations(f.state).requiredCanonicalCandidateIds, before.requiredCanonicalCandidateIds);
  assert.equal(before.requiredCanonicalCandidateIds.length, 48);
  const subset = { ...withoutMarkers, rows: withoutMarkers.rows.slice(0, 1),
    originalDutyAccounting: { ...withoutMarkers.originalDutyAccounting, status: 'STAGED' } };
  assert.equal(await publish(f, subset), false); assert.equal(knownOriginalObligations(f.state).items.length, 0);
});

test('validated IDs from a repeated byte failure union with prior IDs even if earlier rows are omitted', async t => {
  const { f, rejected } = await pendingCapacityFixture(t);
  const before = knownOriginalObligations(f.state), another = structuredClone(rejected);
  // The source is the complete read span. This lower-level observer control
  // exercises identity retention; actual distinct-source producer cases are in
  // the native and exact-legacy integration controls.
  another.rows = [...another.rows.slice(0, 47), { ...another.rows[47], requirement: extraDuty }];
  delete another.rows[47].originalDutyId;
  another.originalDutyAccounting.stagedCount = 1;
  assert.equal(await publish(f, another, 'failed'), false);
  const blocked = knownOriginalObligations(f.state);
  assert.equal(blocked.protectionLimitExceeded, true); assert.equal(blocked.observedProtectedCandidateCount, 49);
  assert.deepEqual(blocked.requiredCanonicalCandidateIds, before.requiredCanonicalCandidateIds);
  assert.equal(blocked.protectedCanonicalCountWithinLimit, false); assert.equal(blocked.unavailableReason, 'OBSERVATION_COHORT_LIMIT');
  const oldSubset = { ...rejected, originalDutyAccounting: { ...rejected.originalDutyAccounting, status: 'STAGED' } };
  assert.equal(await publish(f, oldSubset), false);
  assert.deepEqual(knownOriginalObligations(f.state), blocked);
});


test('same-worker valid unkeyed duty stays U when later omitted and invalid later rows add no identity', async t => {
  const extra = 'Retain the separate configuration diagnostic.';
  const f = await fixture(t, { text: '# Request\n' + [...duties, extra].join('\n') + '\n' });
  const staged = await f.stage(); await f.readPlan();
  const read = await f.call({ action: 'read_original', ref: f.source.ref, start: 5, count: 1 });
  const final = staged.items.map(item => uncertain(f, item));
  const first = await f.tools.verifyRequirementCoverage([...final, { originalSourceAnchorId: read.anchor.anchorId,
    requirement: extra, disposition: 'UNVERIFIED', reason: 'A distinct current original clause.', targets: [] }]);
  assert.equal(first.rows.length, 4);
  await assert.rejects(f.tools.verifyRequirementCoverage([{ originalSourceAnchorId: read.anchor.anchorId,
    requirement: 'Invalid draft must not acquire retention.', disposition: 'UNVERIFIED', reason: 'Draft.', targets: [] },
    { originalSourceAnchorId: 'unread-anchor', requirement: 'Invalid later row.', disposition: 'UNVERIFIED', reason: 'Invalid.', targets: [] }]),
    { code: 'DOCUMENT_REQUIREMENT_COVERAGE_INVALID' });
  await assert.rejects(f.tools.verifyRequirementCoverage([{ originalSourceAnchorId: read.anchor.anchorId,
    requirement: 'Another partial draft must not acquire retention.', disposition: 'UNVERIFIED', reason: 'Draft.', targets: [] },
    { originalSourceAnchorId: read.anchor.anchorId, requirement: 'Invalid target row.', disposition: 'COVERED', reason: 'Invalid target.',
      targets: [{ path: f.proposal, start: 99999, end: 99999 }] }]), { code: 'DOCUMENT_REQUIREMENT_COVERAGE_INVALID' });
  await assert.rejects(f.tools.verifyRequirementCoverage(Array.from({ length: 49 }, (_, i) => ({
    originalSourceAnchorId: read.anchor.anchorId, requirement: 'Out-of-bounds draft' + i, disposition: 'UNVERIFIED', reason: 'Too many final rows.', targets: [] }))),
    { code: 'DOCUMENT_REQUIREMENT_COVERAGE_INVALID' });
  const later = await f.tools.verifyRequirementCoverage(final);
  assert.equal(later.rows.length, 4); assert.equal(later.rows.some(row => row.requirement === 'Invalid draft must not acquire retention.'), false);
  assert.equal(later.rows.some(row => row.requirement === 'Another partial draft must not acquire retention.'), false);
  const retained = later.rows.find(row => row.requirement === extra);
  assert.equal(retained.disposition, 'UNVERIFIED'); assert.deepEqual(retained.targets, []);
  assert.equal(retained.originalDutyAccountingIssue, 'PRIOR_WORKER_DUTY_ASSESSMENT_MISSING');
});

test('same-worker omitted prior unkeyed source is revalidated before any retained handoff', async t => {
  const f = await fixture(t), separate = { ref: 'separate-original', text: 'Retain the separate configuration diagnostic.\n' };
  separate.sha256 = sha256(separate.text);
  const tools = await createDocumentTools({ projectRoot: f.root, signal: f.controller.signal,
    semantic: { artifactFiles: f.snapshot.documents.map(file => file.path), originalRequirements: { digest: sha256('two-originals'), userMessages: [f.source, separate] } },
    originalDutyCohortContext: { owner: knownOriginalOwner(f.state), sourceRunId: f.state.nativeRunId } });
  const first = await tools.execute({ action: 'read_original', ref: f.source.ref, start: 2, count: 1 });
  await tools.execute({ action: 'stage_original_duties', duties: [{ originalSourceAnchorId: first.anchor.anchorId, requirement: duties[0] }] });
  const other = await tools.execute({ action: 'read_original', ref: separate.ref, start: 1, count: 1 });
  for (const file of tools.manifest()) await tools.execute({ action: 'read', path: file.path, start: 1, count: 200 });
  await tools.verifyRequirementCoverage([{ originalSourceAnchorId: other.anchor.anchorId, requirement: separate.text.trim(),
    disposition: 'UNVERIFIED', reason: 'Complete separate clause.', targets: [] }]);
  separate.text += 'CHANGED';
  await assert.rejects(tools.verifyRequirementCoverage([]), /DOCUMENT_ORIGINAL_SOURCE_CHANGED/u);
});
