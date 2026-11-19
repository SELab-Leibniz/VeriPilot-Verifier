import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { stopProtocolFixture } from './helpers/stop-protocol.mjs';
import { loadStopOriginalRequirements } from '../lib/runtime-v2/production-stop.mjs';
import { resolveStopReviewPolicy } from '../lib/runtime-v2/metric-policy.mjs';

async function fixture(t, { two = false } = {}) {
  const f = await stopProtocolFixture(t, 'findings');
  f.two = two;
  f.input.request.reviewScope = { kind: 'workspace-stop' };
  f.input.request.classificationContract = 2;
  f.input.request.fixedStopClassification = { stopClassification: 'TASK_COMPLETE', stage: null };
  f.input.request.population.reviewPolicy = resolveStopReviewPolicy({ deviationOnly: true,
    requireCurrentProductionCoverage: true, requireProductionOriginCoverage: true });
  if (two) f.input.evidence.snapshot.entries[0].message.content = 'Deliver the required value.\nReturn the requested output.';
  f.input.evidence.originalRequirements = await loadStopOriginalRequirements({ projectRoot: f.root,
    snapshot: f.input.evidence.snapshot });
  f.source = path.join(f.root, 'app.mjs');
  await fs.writeFile(f.source, 'export function transform(input) {\n  return input + 1;\n}\n');
  execFileSync('git', ['init', '--quiet', f.root]);
  execFileSync('git', ['-C', f.root, 'add', '--', 'app.mjs']);
  f.input.onScope = async () => ({ regressionCheck: { status: 'PASSED', command: ['node', '--test'], cwd: '.', exitCode: 0,
    outputTail: 'RC_REGRESSION_INVENTORY {"complete":true,"executedTests":1,"failures":[]}\n' } });
  return f;
}

async function checkedRun(f, script) {
  let failure;
  try {
    const handle = await f.run(async tools => {
      try { await script(tools); } catch (error) { failure = error; throw error; }
    });
    if (failure) { await handle.close(); throw failure; }
    return handle;
  } catch (error) { throw failure ?? error; }
}

async function select(f, tools) {
  await tools.readAll();
  const original = tools.brief.task.basisFiles.find(file => path.basename(file).startsWith('user-original-'));
  const citeId = (await tools.read(original)).details.citation.citeId;
  const items = ['Deliver the required value.', ...(f.two ? ['Return the requested output.'] : [])]
    .map((text, index) => ({ metricId: 'M16', verificationTarget: 'IMPLEMENTATION',
      implementationRole: 'PRODUCTION', text, citeId, lineStart: index + 1, lineEnd: index + 1 }));
  const page = await tools.submit('set_original_checklist', { items,
  scope: { stopClassification: 'TASK_COMPLETE', completionClaim: true } });
  const item = page.items.find(item => item.description === 'Deliver the required value.');
  assert.equal(item.requiresProductionOriginCoverage, true);
  const source = (await tools.read(f.source)).details.citation.citeId;
  const entry = { citeId: source, start: 1, end: 1 };
  const receipt = await tools.submit('review_production_origin', { objectId: item.objectId, entry });
  assert.equal(receipt.status, 'READY', JSON.stringify(receipt));
  const coverage = (entryOverride = entry, receiptId = receipt.receiptId) => ({ objectId: item.objectId,
    reason: 'Read the current transform and its observable return value.', citeIds: [source],
    flow: { entry: entryOverride, consumer: { citeId: source, start: 2, end: 2 }, originReceiptId: receiptId, upstream: [] } });
  const finish = values => tools.submit('finish_stop_review', { summary: 'Reviewed the current source.',
    ...(values ? { productionCoverage: values } : {}) });
  const diagnosticsFile = path.join(tools.brief.task.processDirectory, '..', 'origin-lookup-diagnostics.json');
  return { item, items: page.items, entry, receipt, coverage, finish, diagnosticsFile };
}

test('failed exact origin binding survives a finish without resubmission in feedback, checklist and final rows', async t => {
  const f = await fixture(t);
  let objectId, initialDiagnostic;
  const handle = await checkedRun(f, async tools => {
    const c = await select(f, tools); objectId = c.item.objectId;
    const first = await c.finish([c.coverage({ ...c.entry, end: 2 })]);
    assert.equal(first.complete, false);
    const compact = first.pendingOriginDiagnostics.find(row => row.objectId === objectId);
    assert.equal(compact.code, 'ENTRY_BINDING_MISMATCH');
    assert.equal(compact.receiptId, c.receipt.receiptId);
    assert.deepEqual(compact.requestedEntry, { path: 'app.mjs', start: 1, end: 2 });
    assert.deepEqual(compact.issuedEntry, { path: 'app.mjs', start: 1, end: 1 });
    assert.equal(compact.next, 'USE_EXACT_ENTRY_OR_REDISCOVER');
    const checklist = await tools.submit('review_checklist', {});
    assert.equal(checklist.items.find(row => row.objectId === objectId).originDiagnostic.code, 'ENTRY_BINDING_MISMATCH');
    initialDiagnostic = JSON.parse(await fs.readFile(c.diagnosticsFile, 'utf8')).items[0].originDiagnostic;
    assert.equal(initialDiagnostic.requested.receiptId, c.receipt.receiptId);
    assert.equal(initialDiagnostic.authority, 'DIAGNOSTIC_ONLY');
    assert.equal((await c.finish()).complete, true);
    const retained = JSON.parse(await fs.readFile(c.diagnosticsFile, 'utf8'));
    assert.deepEqual(retained.items[0].originDiagnostic, initialDiagnostic);
  });
  assert.equal(handle.reviewCompleted, true);
  const row = handle.result.reviewCoverage.items.find(row => row.id === objectId);
  assert.equal(row.disposition, 'UNVERIFIED');
  assert.equal(row.originCoverage.reason, 'MISSING_OR_FOREIGN_ORIGIN_RECEIPT');
  assert.deepEqual(row.originCoverage.diagnostic, initialDiagnostic);
  assert.equal(handle.result.metricObjectJudgements.some(row => row.judgement === 'PASS'), false);
  await handle.close();
});

test('fresh valid accepted coverage clears earlier diagnostics rather than carrying a rejected lookup into success', async t => {
  const f = await fixture(t);
  let objectId;
  const handle = await checkedRun(f, async tools => {
    const c = await select(f, tools); objectId = c.item.objectId;
    const first = await c.finish([c.coverage(c.entry, 'not-issued-in-this-review')]);
    assert.equal(first.complete, false);
    assert.equal(first.pendingOriginDiagnostics[0].code, 'NOT_ISSUED_CURRENT_REVIEW');
    assert.equal((await c.finish([c.coverage()])).complete, true);
    assert.deepEqual(JSON.parse(await fs.readFile(c.diagnosticsFile, 'utf8')).items, []);
  });
  const row = handle.result.reviewCoverage.items.find(row => row.id === objectId);
  assert.equal(row.disposition, 'SOURCE_REVIEWED');
  assert.equal(row.originCoverage.status, 'OBSERVED_CANDIDATES_REVIEWED');
  assert.equal(row.originCoverage.diagnostic, undefined);
  await handle.close();
});

test('revalidation saves the latest stale context before discarding retained coverage', async t => {
  const f = await fixture(t, { two: true });
  let objectId, expectedReceiptId;
  const handle = await checkedRun(f, async tools => {
    const c = await select(f, tools); objectId = c.item.objectId; expectedReceiptId = c.receipt.receiptId;
    const first = await c.finish([c.coverage()]);
    assert.equal(first.complete, false);
    assert.equal(first.pendingProductionCoverageCount, 1, 'the other obligation keeps this review open');
    assert(first.pendingProductionCoverage.every(row => row.objectId !== objectId), 'valid coverage is retained');
    await fs.writeFile(path.join(f.root, 'new-caller.mjs'), 'import { transform } from "./app.mjs";\nexport const call = () => transform(1);\n');
    assert.equal((await c.finish()).complete, true);
    const snapshot = JSON.parse(await fs.readFile(c.diagnosticsFile, 'utf8'));
    const failure = snapshot.items.find(row => row.objectId === objectId);
    assert.equal(failure.originIssue, 'ORIGIN_INDEX_CHANGED');
    assert.equal(failure.originDiagnostic.category, 'STALE_INDEX');
    assert.equal(failure.originDiagnostic.requested.receiptId, expectedReceiptId);
    assert.equal(failure.originDiagnostic.requested.entryFingerprint, failure.originDiagnostic.issued.entryFingerprint);
  });
  const row = handle.result.reviewCoverage.items.find(row => row.id === objectId);
  assert.equal(row.disposition, 'UNVERIFIED');
  assert.equal(row.originCoverage.reason, 'ORIGIN_INDEX_CHANGED');
  assert.equal(row.originCoverage.diagnostic.requested.receiptId, expectedReceiptId);
  assert.equal(row.flow, undefined);
  await handle.close();
});
