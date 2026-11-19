import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { stopProtocolFixture } from './helpers/stop-protocol.mjs';
import { loadStopOriginalRequirements } from '../lib/runtime-v2/production-stop.mjs';
import { createOriginalSourceAnchor } from '../lib/runtime-v2/original-source-anchor.mjs';
import { resolveStopReviewPolicy } from '../lib/runtime-v2/metric-policy.mjs';
import { recordDeviationFindings } from '../lib/runtime-v2/deviations.mjs';
import { taskDirectory, withTaskState } from '../lib/runtime-v2/task-store.mjs';
import { atomicWriteJson, sha256 } from '../lib/runtime-v2/utils.mjs';

const requirements = ['Return the input plus one from increment.', 'Return twice the input from double.'];
const body = broken => `export function increment(value) { return ${broken ? 'value' : 'value + 1'}; }\nexport function double(value) { return ${broken ? 'value' : 'value * 2'}; }\n`;
async function checkedRun(f, script) {
  let scriptFailure;
  const handle = await f.run(async args => { try { await script(args); } catch (error) { scriptFailure = error; throw error; } });
  if (scriptFailure) { await handle.close(); throw scriptFailure; }
  return handle;
}
async function fixture(t, { carryBoth = false } = {}) {
  const f = await stopProtocolFixture(t, 'findings'), app = path.join(f.root, 'app.mjs');
  f.input.request.reviewScope = { kind: 'workspace-stop' };
  f.input.request.classificationContract = 2;
  f.input.request.fixedStopClassification = { stopClassification: 'TASK_COMPLETE', stage: null };
  f.input.request.population.reviewPolicy = resolveStopReviewPolicy({ deviationOnly: true,
    requireCurrentProductionCoverage: true, requireProductionOriginCoverage: true });
  f.input.evidence.snapshot.entries[0].message.content = requirements.join(' ');
  const original = await loadStopOriginalRequirements({ projectRoot: f.root, snapshot: f.input.evidence.snapshot });
  f.input.evidence.originalRequirements = original;
  const [message] = original.userMessages;
  const anchor = createOriginalSourceAnchor({ ref: message.ref, sha256: message.sha256, bytes: Buffer.from(message.text), start: 1, end: 1 });
  const requiredAtoms = requirements.map(requirement => ({ id: sha256([anchor.anchorId, requirement]), source: anchor, requirement }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const inventorySha256 = sha256(requiredAtoms);
  f.input.request.approvedProposalInventory = { inventorySha256, requiredAtoms };
  await fs.writeFile(app, body(true));
  execFileSync('git', ['init', '--quiet', f.root]);
  execFileSync('git', ['-C', f.root, '-c', 'core.autocrlf=false', 'add', '--', 'app.mjs']);
  let priorItems;
  const previous = await checkedRun(f, async ({ readAll, read, submit }) => {
    await readAll();
    const page = await submit('set_original_checklist', { items: [], scope: { stopClassification: 'TASK_COMPLETE', completionClaim: true } });
    priorItems = page.items;
    const current = (await read(app)).details.citation.citeId;
    for (const requirement of carryBoth ? requirements : requirements.slice(0, 1)) {
      const item = priorItems.find(item => item.description === requirement);
      await submit('submit_review', { taskId: item.objectId, verdict: 'DEVIATION',
        reason: 'The current operation returns the input unchanged.', citeIds: [current] });
    }
    assert.equal((await submit('finish_stop_review', { summary: 'A current source contradiction is recorded.' })).complete, true);
  });
  const deviations = previous.result.metricObjectJudgements.filter(row => row.judgement === 'DEVIATION');
  assert.equal(deviations.length, carryBoth ? 2 : 1);
  const carried = deviations.map(deviation => ({ ...priorItems.find(item => item.objectId === deviation.objectId), ...deviation }));
  const object = carried.find(item => item.description === requirements[0]);
  const evaluationId = 'stop-0123456789abcdef';
  await atomicWriteJson(path.join(taskDirectory(f.root, f.task.taskId), 'evaluations', `${evaluationId}.json`), {
    originalRequirementsDigest: original.digest, metricReport: { metrics: [{ objects: carried }] },
  });
  await recordDeviationFindings({ projectRoot: f.root, taskId: f.task.taskId, pipeline: 'STOP', evaluationId, delivered: true,
    findings: carried.map(item => ({ deviationKey: `metric:M16:${item.sourceId}`, rootCauseId: 'REQUIREMENT_OMITTED', severity: 'error',
      reason: item.reason, violatedGroundTruthIds: [item.sourceId], actualEvidence: item.evidence })) });
  await previous.close();
  await fs.writeFile(app, body(false));
  return { ...f, app, inventorySha256, requiredAtoms, originalItems: priorItems, carriedId: object.objectId };
}
async function prepare(f, args) {
  await args.readAll();
  const page = await args.submit('set_original_checklist', { items: [], scope: { stopClassification: 'TASK_COMPLETE', completionClaim: true } });
  assert.deepEqual(page.items.map(item => item.objectId).sort(), f.originalItems.map(item => item.objectId).sort());
  assert(page.items.find(item => item.objectId === f.carriedId).previousDeviation);
  const current = (await args.read(f.app)).details.citation.citeId;
  const range = line => ({ citeId: current, start: line, end: line });
  return { page, current, range };
}
const pass = (f, current, originReceiptId) => ({ taskId: f.carriedId, verdict: 'PASS', reason: 'Current source returns the input plus one.',
  citeIds: [current], flow: { entry: { citeId: current, start: 1, end: 1 }, consumer: { citeId: current, start: 1, end: 1 },
    ...(originReceiptId ? { originReceiptId, upstream: [] } : {}) } });
async function finish(f, args, current) {
  const sibling = f.originalItems.find(item => item.description === requirements[1]);
  const range = { citeId: current, start: 2, end: 2 };
  const origin = await args.submit('review_production_origin', { objectId: sibling.objectId, entry: range });
  return args.submit('finish_stop_review', { summary: 'The full approved inventory remains unchanged.',
    productionCoverage: [{ objectId: sibling.objectId, reason: 'The second operation doubles its input.', citeIds: [current],
      flow: { entry: range, consumer: range, originReceiptId: origin.receiptId, upstream: [] } }] });
}
const noOffer = handle => assert.rejects(fs.stat(path.join(handle.artifacts, 'evidence-repair-offer.json')), { code: 'ENOENT' });

test('a healthy carried review completes with zero evidence-repair offers', async t => {
  const f = await fixture(t);
  const handle = await checkedRun(f, async args => {
    const { current, range } = await prepare(f, args);
    const origin = await args.submit('review_production_origin', { objectId: f.carriedId, entry: range(1) });
    assert.equal(origin.status, 'READY');
    assert.equal((await args.submit('submit_review', pass(f, current, origin.receiptId))).saved, true);
    assert.equal((await finish(f, args, current)).complete, true);
  });
  await noOffer(handle);
  assert.equal(handle.result.approvedProposalInventory.inventorySha256, f.inventorySha256);
  assert.equal(handle.result.reviewCoverage.items.filter(item => item.disposition === 'SOURCE_REVIEWED').length, 2);
  await handle.close();
});

test('one missing origin receipt can be repaired with real fresh reads before a carried result is saved', async t => {
  const f = await fixture(t); let offered;
  const handle = await checkedRun(f, async args => {
    const { current } = await prepare(f, args);
    const before = (await args.submit('review_history', { mode: 'state' })).taskState;
    offered = await args.submit('submit_review', pass(f, current));
    assert.equal(offered.saved, false); assert.equal(offered.complete, false);
    assert.equal(offered.evidenceRepair.code, 'ORIGIN_RECEIPT_MISSING');
    assert.equal(offered.evidenceRepair.navigationOnly, true);
    assert.equal(offered.evidenceRepair.sourceReadAcknowledged, false);
    const after = (await args.submit('review_history', { mode: 'state' })).taskState;
    assert.equal(offered.evidenceRepair.deadlineAt, before.deadlineAt);
    assert.equal(after.deadlineAt, before.deadlineAt); assert.deepEqual(after.limits, before.limits);
    assert.equal(after.attempts, before.attempts); assert(after.turns > before.turns, 'the offer consumes the original turn allowance');
    const pending = await args.submit('review_checklist', {});
    assert.equal(pending.items.find(item => item.objectId === f.carriedId).savedResult, null);
    const fresh = (await args.read(f.app)).details.citation.citeId;
    assert.notEqual(fresh, current, 'the normal native persistence hook creates a fresh actual read receipt');
    const origin = await args.submit('review_production_origin', { objectId: f.carriedId, entry: { citeId: fresh, start: 1, end: 1 } });
    assert.equal(origin.status, 'READY');
    assert.equal((await args.submit('submit_review', pass(f, fresh, origin.receiptId))).saved, true);
    assert.equal((await finish(f, args, fresh)).complete, true);
  });
  const persisted = JSON.parse(await fs.readFile(path.join(handle.artifacts, 'evidence-repair-offer.json'), 'utf8'));
  assert.equal(persisted.taskId, f.task.taskId); assert.equal(persisted.attempt, 1);
  assert.equal(persisted.inventorySha256, f.inventorySha256);
  assert.equal(persisted.objectId, f.carriedId); assert.equal(persisted.code, offered.evidenceRepair.code);
  assert.equal(handle.result.reviewCoverage.items.filter(item => item.disposition === 'SOURCE_REVIEWED').length, 2);
  assert.equal(await fs.readFile(f.app, 'utf8'), body(false), 'evidence gathering makes no code edits');
  await handle.close();
});

test('the full unchanged inventory shares one offer rather than receiving one per carried row', async t => {
  const f = await fixture(t, { carryBoth: true });
  const handle = await checkedRun(f, async args => {
    const { current } = await prepare(f, args);
    const first = await args.submit('submit_review', pass(f, current)); assert.equal(first.saved, false);
    await args.submit('submit_review', { taskId: f.carriedId, verdict: 'UNVERIFIED', reason: 'The reviewer leaves this evidence unresolved.' });
    const sibling = f.originalItems.find(item => item.description === requirements[1]);
    const range = { citeId: current, start: 2, end: 2 };
    const second = await args.submit('submit_review', { taskId: sibling.objectId, verdict: 'PASS', reason: 'The second operation doubles its input.',
      citeIds: [current], flow: { entry: range, consumer: range } });
    assert.equal(second.saved, true); assert.equal(second.verdict, 'UNVERIFIED'); assert.equal(second.evidenceRepair, undefined);
    assert.equal((await args.submit('finish_stop_review', { summary: 'Both unresolved rows stay in the original inventory.' })).complete, true);
  });
  const persisted = JSON.parse(await fs.readFile(path.join(handle.artifacts, 'evidence-repair-offer.json'), 'utf8'));
  assert.equal(persisted.objectId, f.carriedId); assert.equal(persisted.attempt, 1);
  assert.equal(handle.result.reviewCoverage.items.filter(item => item.disposition === 'UNVERIFIED').length, 2);
  await handle.close();
});

test('a second invalid attempt saves U and a later valid submission cannot overwrite it', async t => {
  const f = await fixture(t);
  const handle = await checkedRun(f, async args => {
    const { current, range } = await prepare(f, args);
    assert.equal((await args.submit('submit_review', pass(f, current))).saved, false);
    const second = await args.submit('submit_review', pass(f, current));
    assert.equal(second.saved, true); assert.equal(second.verdict, 'UNVERIFIED');
    const origin = await args.submit('review_production_origin', { objectId: f.carriedId, entry: range(1) });
    await assert.rejects(args.submit('submit_review', pass(f, current, origin.receiptId)), { code: 'TASK_SUBMISSION_CONFLICT' });
    assert.equal((await finish(f, args, current)).complete, true);
  });
  assert.equal(handle.result.reviewCoverage.items.find(item => item.id === f.carriedId).disposition, 'UNVERIFIED');
  assert.equal(handle.result.reviewCoverage.items.filter(item => item.disposition === 'SOURCE_REVIEWED').length, 1);
  await handle.close();
});

for (const mode of ['unsupported', 'missing-id-unsupported', 'stale-index', 'unissued-read'])
  test(`${mode} proof failures do not receive a repair offer`, async t => {
    const f = await fixture(t);
    if (mode.endsWith('unsupported')) await fs.writeFile(path.join(f.root, 'caller.mjs'),
      'import { increment } from "./app.mjs";\nexport function invoke(value) { return increment.call(null, value); }\n');
    const handle = await checkedRun(f, async args => {
      const { current, range } = await prepare(f, args);
      let origin;
      if (mode !== 'missing-id-unsupported') origin = await args.submit('review_production_origin', { objectId: f.carriedId, entry: range(1) });
      if (mode === 'unsupported') assert.equal(origin.reason, 'UNPARSED_POTENTIAL_ORIGIN');
      if (mode === 'stale-index') await fs.writeFile(path.join(f.root, 'late-caller.mjs'),
        'import { increment } from "./app.mjs";\nexport function invoke(value) { return increment(value); }\n');
      const saved = await args.submit('submit_review', pass(f, mode === 'unissued-read' ? 'never-issued-read' : current, origin?.receiptId));
      assert.equal(saved.saved, true); assert.equal(saved.verdict, 'UNVERIFIED');
      assert.equal(saved.evidenceRepair, undefined);
      const finished = await finish(f, args, current);
      if (!finished.complete) assert.equal((await args.submit('finish_stop_review', { summary: 'Stale evidence remains unverified.' })).complete, true);
    });
    await noOffer(handle);
    assert.equal(handle.result.reviewCoverage.items.find(item => item.id === f.carriedId).disposition, 'UNVERIFIED');
    await handle.close();
  });

test('an owner generation change invalidates the review before any repair offer', async t => {
  const f = await fixture(t);
  await assert.rejects(checkedRun(f, async args => {
    const { current } = await prepare(f, args);
    await withTaskState({ projectRoot: f.root, taskId: f.task.taskId }, state => {
      state.control = { ...state.control, generation: 'new-owner-generation' };
    });
    await assert.rejects(args.submit('submit_review', pass(f, current)), { code: 'STOP_TASK_INPUT_CHANGED' });
  }), { code: 'STOP_TASK_INPUT_CHANGED' });
  const directory = path.join(taskDirectory(f.root, f.task.taskId), 'workspace-reviews');
  for (const entry of await fs.readdir(directory)) await assert.rejects(fs.stat(path.join(directory, entry, 'evidence-repair-offer.json')), { code: 'ENOENT' });
});

test('changed acknowledged source invalidates the review instead of buying a fresh proof attempt', async t => {
  const f = await fixture(t);
  await assert.rejects(checkedRun(f, async args => {
    const { current } = await prepare(f, args);
    await fs.appendFile(f.app, '// Concurrent business edit.\n');
    await assert.rejects(args.submit('submit_review', pass(f, current)), { code: 'BASELINE_INPUT_CHANGED' });
  }), { code: 'BASELINE_INPUT_CHANGED' });
  const directory = path.join(taskDirectory(f.root, f.task.taskId), 'workspace-reviews');
  for (const entry of await fs.readdir(directory)) await assert.rejects(fs.stat(path.join(directory, entry, 'evidence-repair-offer.json')), { code: 'ENOENT' });
});
