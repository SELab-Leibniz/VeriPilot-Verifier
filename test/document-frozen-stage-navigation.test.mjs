import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDocumentTools, bindDocumentTools, registerDocumentTools } from '../lib/document-tools.mjs';
import { readOpenSpecPlan } from '../lib/openspec-plan.mjs';
import { createOriginalSourceAnchor } from '../lib/runtime-v2/original-source-anchor.mjs';
import { knownOriginalOwner } from '../lib/runtime-v2/known-original-capacity.mjs';
import { sha256 } from '../lib/runtime-v2/utils.mjs';

async function fixture(t, { count = 3, long = false } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-frozen-stage-')));
  const proposal = 'openspec/changes/navigation/proposal.md', tasks = 'openspec/changes/navigation/tasks.md';
  const requirements = Array.from({ length: count }, (_, i) => long
    ? '保留完整条件🧪'.repeat(40) + i : `Preserve the distinct diagnostic for input ${i}.`);
  const extra = 'When a separate validation error occurs, retain its complete diagnostic.';
  const source = { ref: long ? 'original:' + '原'.repeat(1200) : 'original:request',
    text: '# Request\r\n' + [...requirements, extra].join('\r\n') + '\r\n' };
  source.sha256 = sha256(source.text);
  await fs.mkdir(path.dirname(path.join(root, proposal)), { recursive: true });
  await fs.writeFile(path.join(root, proposal), '# Plan\nRepresent the complete original duties.\n');
  await fs.writeFile(path.join(root, tasks), '- [ ] Implement and verify the original duties.\n');
  const plan = await readOpenSpecPlan(root, 'navigation'), controller = new AbortController();
  const sessionId = path.basename(root), state = { projectRoot: root, sessionId, sessionKey: 'agent:owner',
    scopeTaskId: 'task', projectScope: { fingerprint: 'scope' }, nativeRunId: 'current-run', reviewController: controller };
  let now = 0, ownerCurrent = true;
  const tools = await createDocumentTools({ projectRoot: root, signal: controller.signal,
    semantic: { artifactFiles: plan.documents.map(file => file.path), originalRequirements: { digest: source.sha256, userMessages: [source] } },
    originalDutyCohortContext: { owner: knownOriginalOwner(state), sourceRunId: state.nativeRunId },
    active() { if (now >= 100) throw Object.assign(new Error('Original deadline expired'), { code: 'ORIGINAL_DEADLINE' }); } });
  let factory;
  registerDocumentTools({ registerTool(value) { factory = value; } });
  const release = bindDocumentTools({ sessionId, runId: 'current-run', tools, active() {} });
  const native = factory({ sessionId, runId: 'current-run', assertInvocationCurrent() {
    if (!ownerCurrent) throw Object.assign(new Error('Original owner expired'), { code: 'OWNER_CHANGED' });
  } });
  const call = async args => JSON.parse((await native.execute('current-call', args)).content[0].text);
  t.after(async () => { release(); await fs.rm(root, { recursive: true, force: true }); });
  const duties = [];
  for (const [i, requirement] of requirements.entries()) {
    const read = await call({ action: 'read_original', ref: source.ref, start: i + 2, count: 1 });
    duties.push({ originalSourceAnchorId: read.anchor.anchorId, requirement });
  }
  return { root, proposal, tools, call, controller, source, requirements, extra, duties,
    expireOwner() { ownerCurrent = false; }, expireDeadline() { now = 100; } };
}

async function frozenError(f) {
  const before = await f.call({ action: 'stage_original_duties', duties: f.duties });
  let error;
  await assert.rejects(f.call({ action: 'stage_original_duties', duties: f.duties.slice(0, -1) }), value => {
    error = value;
    assert.equal(value.code, 'DOCUMENT_ORIGINAL_DUTIES_FROZEN');
    assert.match(value.message, /^DOCUMENT_ORIGINAL_DUTIES_FROZEN:/u);
    return true;
  });
  const diagnostic = JSON.parse(error.message.slice(error.message.indexOf('{')));
  assert.deepEqual(diagnostic, { readWith: { action: 'stage_original_duties', start: 1, count: 8 },
    navigationOnly: true, readProofGranted: false, stageProofGranted: false, assessmentGranted: false });
  assert.match(error.message, /Omit duties/u); assert.match(error.message, /nextStart/u);
  assert.match(error.message, /historical knownCandidateId/u); assert.match(error.message, /fresh current read_original/u);
  assert(Buffer.byteLength(error.message) < 1400);
  assert(!error.message.includes(f.source.ref));
  assert(f.requirements.every(requirement => !error.message.includes(requirement)));
  return { before, error, diagnostic };
}

test('native frozen-table error gives bounded executable navigation without changing complete Unicode duties', async t => {
  const f = await fixture(t, { count: 48, long: true }), { before, diagnostic } = await frozenError(f);
  const items = []; let page = await f.call(diagnostic.readWith), pages = 0;
  while (true) {
    assert(Buffer.byteLength(JSON.stringify(page)) <= 8192);
    assert.equal(page.stagedCount, 48); assert.equal(page.readProofGranted, false); assert.equal(page.semanticsVerified, false);
    assert(page.items.length > 0); items.push(...page.items); pages++;
    if (page.nextStart === null) break;
    page = await f.call({ ...diagnostic.readWith, start: page.nextStart });
  }
  assert(pages > 1); assert.equal(items.length, 48);
  assert.equal(new Set(items.map(item => item.originalDutyId)).size, 48);
  assert.deepEqual(new Set(items.map(item => item.requirement)), new Set(f.requirements));
  assert.deepEqual(await f.call({ action: 'stage_original_duties' }), before);
  assert.deepEqual(await f.call({ action: 'stage_original_duties', duties: [...f.duties].reverse() }), before);
});

test('frozen-stage navigation grants neither a fresh original receipt nor undisclosed artifact coverage', async t => {
  const f = await fixture(t), { diagnostic } = await frozenError(f);
  const page = await f.call(diagnostic.readWith), item = page.items[0];
  const extraAnchor = createOriginalSourceAnchor({ ref: f.source.ref, sha256: f.source.sha256,
    bytes: Buffer.from(f.source.text), start: f.requirements.length + 2, end: f.requirements.length + 2 });
  const extra = { originalSourceAnchorId: extraAnchor.anchorId, requirement: f.extra,
    disposition: 'UNVERIFIED', reason: 'No current read has acknowledged this distinct original span.', targets: [] };
  await assert.rejects(f.tools.verifyRequirementCoverage([extra]), /issued by read_original in this review/u);
  await assert.rejects(f.tools.verifyRequirementCoverage([{ ...item, disposition: 'COVERED',
    reason: 'Navigation alone does not disclose artifact evidence.', targets: [{ path: f.proposal, start: 2, end: 2 }] }]),
  /not a plan range read by rc_document/u);
  assert.equal(f.tools.originalDutyAccounting().stagedCount, 3);
  const current = await f.call({ action: 'read_original', ref: f.source.ref, start: f.requirements.length + 2, count: 1 });
  assert.deepEqual(current.anchor, extraAnchor);
  const receipt = await f.tools.verifyRequirementCoverage([{ ...extra, reason: 'The additional current duty remains unverified.' }]);
  assert.equal(receipt.rows.length, 4);
  assert(receipt.rows.every(row => row.disposition === 'UNVERIFIED'));
  assert.equal(receipt.rows.find(row => row.requirement === f.extra).originalDutyId, undefined);
  assert.equal(f.tools.originalDutyAccounting().stagedCount, 3);
});

test('historical candidate IDs cannot substitute for current staged IDs or current source anchors', async t => {
  const f = await fixture(t), { diagnostic } = await frozenError(f);
  const item = (await f.call(diagnostic.readWith)).items[0], knownCandidateId = 'known-original-' + item.originalDutyId;
  const row = { ...item, disposition: 'UNVERIFIED', reason: 'The complete duty remains unverified.', targets: [] };
  await assert.rejects(f.tools.verifyRequirementCoverage([{ ...row, originalDutyId: knownCandidateId }]), /Use a current stage_original_duties ID/u);
  await assert.rejects(f.tools.verifyRequirementCoverage([{ ...row, originalSourceAnchorId: knownCandidateId }]), /issued by read_original in this review/u);
  const receipt = await f.tools.verifyRequirementCoverage([row]);
  assert.equal(receipt.rows.length, 3); assert(receipt.rows.every(value => value.disposition === 'UNVERIFIED'));
  assert.equal(receipt.rows.find(value => value.originalDutyId === item.originalDutyId).requirement, item.requirement);
});

for (const changed of ['source', 'plan', 'owner', 'abort', 'deadline']) test(`frozen-stage guidance preserves ${changed} rejection before navigation`, async t => {
  const f = await fixture(t); await f.call({ action: 'stage_original_duties', duties: f.duties });
  if (changed === 'source') f.source.text += 'Changed original.';
  if (changed === 'plan') await fs.appendFile(path.join(f.root, f.proposal), '\nChanged plan.');
  if (changed === 'owner') f.expireOwner();
  if (changed === 'abort') f.controller.abort(new Error('Original review cancelled'));
  if (changed === 'deadline') f.expireDeadline();
  const expected = { source: /DOCUMENT_ORIGINAL_SOURCE_CHANGED/u, plan: /DOCUMENT_EVIDENCE_CHANGED/u,
    owner: /Original owner expired/u, abort: /Original review cancelled/u, deadline: /Original deadline expired/u };
  for (const args of [{ action: 'stage_original_duties', duties: f.duties.slice(0, -1) },
    { action: 'stage_original_duties', start: 1, count: 8 }])
    await assert.rejects(f.call(args), error => {
      assert.match(error.message, expected[changed]); assert.doesNotMatch(error.message, /DOCUMENT_ORIGINAL_DUTIES_FROZEN/u);
      return true;
    });
});
