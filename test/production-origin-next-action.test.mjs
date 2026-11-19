import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildSemanticGraph } from '../lib/semantic-graph.mjs';
import { createProductionOriginCoverage } from '../lib/runtime-v2/production-origin-coverage.mjs';
import { sha256 } from '../lib/runtime-v2/utils.mjs';
import { stopProtocolFixture } from './helpers/stop-protocol.mjs';
import { loadStopOriginalRequirements } from '../lib/runtime-v2/production-stop.mjs';
import { resolveStopReviewPolicy } from '../lib/runtime-v2/metric-policy.mjs';

const unsupported = ['export const store = {', '  persist(input) {', '    const value = input + 1;', '    return value;', '  }', '};', ''].join('\n');
async function fixture(t, body, overrides = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-origin-next-action-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'app.mjs');
  await fs.writeFile(file, body);
  const graph = { ...await buildSemanticGraph(root, { snapshotPaths: ['app.mjs'] }), ...overrides };
  const origin = createProductionOriginCoverage({ projectRoot: root, graph, contextId: 'owned-review' });
  const entry = (start, end = start) => ({ path: file, start, end, sha256: sha256(body) });
  return { file, graph, origin, entry };
}

test('structural callable guidance stays tied to the current source/frame and never blocks or upgrades repeated navigation', async t => {
  const f = await fixture(t, unsupported);
  let frame;
  for (const [start, end] of [[2, 5], [3, 4], [4, 4]]) {
    const entry = f.entry(start, end);
    const receipt = await f.origin.discover({ objectId: 'required-operation', entry });
    assert.equal(receipt.status, 'UNKNOWN');
    assert.equal(receipt.reason, 'ENTRY_CALLABLE_UNSUPPORTED');
    assert.equal(receipt.entryResolution.callableReason, 'UNSUPPORTED_METHOD_BINDING');
    assert.equal(receipt.nextAction, 'KEEP_UNVERIFIED_FOR_CURRENT_CALLABLE');
    assert.equal(receipt.entry.sha256, sha256(unsupported));
    assert.equal(receipt.entryResolution.frames.length, 1);
    frame ??= receipt.entryResolution.frames[0];
    assert.deepEqual(receipt.entryResolution.frames[0], frame, 'overlapping ranges still select the same unsupported callable');
    assert.equal(receipt.sourceReadAcknowledged, false);
    assert.equal(receipt.navigationOnly, true);
    assert.deepEqual(receipt.candidates, []);
    const lookup = await f.origin.lookup(receipt.receiptId, { objectId: 'required-operation', entry });
    assert.equal(lookup.status, 'UNKNOWN');
    assert.equal(lookup.reason, 'ENTRY_CALLABLE_UNSUPPORTED');
  }
});

test('a crossing range remains correctable and a genuinely acknowledged callable boundary can become READY', async t => {
  const body = ['export function transform(values) {', '  const result = values.map(value => {', '    return value + 1;', '  });', '  return result;', '}', ''].join('\n');
  const f = await fixture(t, body);
  const crossing = await f.origin.discover({ objectId: 'required-operation', entry: f.entry(3, 5) });
  assert.equal(crossing.status, 'UNKNOWN');
  assert.equal(crossing.reason, 'ENTRY_RANGE_CROSSES_CALLABLE');
  assert.equal(crossing.nextAction, undefined, 'a range correction must not be labelled structural unsupported');
  const correctedEntry = f.entry(2, 4);
  const corrected = await f.origin.discover({ objectId: 'required-operation', entry: correctedEntry });
  assert.equal(corrected.status, 'READY', corrected.reason);
  assert.equal(corrected.nextAction, undefined);
  assert.equal((await f.origin.lookup(corrected.receiptId, { objectId: 'required-operation', entry: correctedEntry })).status, 'READY');
});

test('guidance metadata cannot repair stale, foreign or misbound origin authority', async t => {
  const f = await fixture(t, 'export function transform(input) {\n  return input + 1;\n}\n');
  const entry = f.entry(1);
  const receipt = await f.origin.discover({ objectId: 'required-operation', entry });
  assert.equal(receipt.status, 'READY');
  assert.equal(receipt.nextAction, undefined);
  receipt.nextAction = 'KEEP_UNVERIFIED_FOR_CURRENT_CALLABLE';
  receipt.status = 'UNKNOWN';
  assert.equal((await f.origin.lookup(receipt.receiptId, { objectId: 'required-operation', entry })).status, 'READY', 'caller projection edits cannot change private receipt authority');
  assert.equal((await f.origin.lookup(receipt.receiptId, { objectId: 'other-operation', entry })).status, 'UNKNOWN');
  assert.equal((await f.origin.lookup(receipt.receiptId, { objectId: 'required-operation', entry: f.entry(2) })).status, 'UNKNOWN');
  await fs.appendFile(f.file, '\n');
  const stale = await f.origin.lookup(receipt.receiptId, { objectId: 'required-operation', entry });
  assert.equal(stale.status, 'UNKNOWN');
  assert.equal(stale.reason, 'ORIGIN_INDEX_CHANGED');
  const staleNavigation = await f.origin.discover({ objectId: 'required-operation', entry });
  assert.equal(staleNavigation.status, 'UNKNOWN');
  assert.equal(staleNavigation.reason, 'INDEX_CHANGED');
  assert.equal(staleNavigation.nextAction, undefined, 'stale source needs fresh review rather than a structural-callable instruction');
});

test('unresolved source navigation receives no unsupported-callable instruction', async t => {
  const f = await fixture(t, 'export function transform(input) { return input; }\n', {
    originEntry: () => ({ status: 'UNKNOWN', reason: 'ENTRY_SYMBOL_UNRESOLVED', navigationOnly: true }),
  });
  const receipt = await f.origin.discover({ objectId: 'required-operation', entry: f.entry(1) });
  assert.equal(receipt.status, 'UNKNOWN');
  assert.equal(receipt.reason, 'ENTRY_SYMBOL_UNRESOLVED');
  assert.equal(receipt.nextAction, undefined);
});

async function strictStopFixture(t, requirement = 'Deliver the required value.') {
  const f = await stopProtocolFixture(t, 'findings');
  f.input.request.reviewScope = { kind: 'workspace-stop' };
  f.input.request.classificationContract = 2;
  f.input.request.fixedStopClassification = { stopClassification: 'TASK_COMPLETE', stage: null };
  f.input.request.population.reviewPolicy = resolveStopReviewPolicy({ deviationOnly: true,
    requireCurrentProductionCoverage: true, requireProductionOriginCoverage: true });
  f.input.evidence.snapshot.entries[0].message.content = requirement;
  f.input.evidence.originalRequirements = await loadStopOriginalRequirements({ projectRoot: f.root, snapshot: f.input.evidence.snapshot });
  const file = path.join(f.root, 'app.mjs');
  await fs.writeFile(file, unsupported);
  execFileSync('git', ['init', '--quiet', f.root]);
  execFileSync('git', ['-C', f.root, 'add', '--', 'app.mjs']);
  f.input.onScope = async () => ({ regressionCheck: { status: 'PASSED', command: ['node', '--test'], cwd: '.', exitCode: 0,
    outputTail: 'RC_REGRESSION_INVENTORY {"complete":true,"executedTests":1,"failures":[]}\n' } });
  return { ...f, source: file };
}

test('the actual Stop tool keeps missing reads recoverable and unsupported callable coverage UNVERIFIED', async t => {
  const f = await strictStopFixture(t), file = f.source;
  let failure, objectId;
  const handle = await f.run(async tools => {
    try {
      await tools.readAll();
      const original = tools.brief.task.basisFiles.find(file => path.basename(file).startsWith('user-original-'));
      const originalId = (await tools.read(original)).details.citation.citeId;
      const page = await tools.submit('set_original_checklist', { items: [{ metricId: 'M16', text: 'Deliver the required value.',
        verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION', citeId: originalId, lineStart: 1, lineEnd: 1 }],
      scope: { stopClassification: 'TASK_COMPLETE', completionClaim: true } });
      objectId = page.items.find(item => item.description === 'Deliver the required value.').objectId;
      await assert.rejects(tools.submit('review_production_origin', { objectId, entry: { citeId: 'unissued-current-read', start: 2, end: 5 } }),
        error => error.code === 'REVIEW_ORIGIN_EVIDENCE_REQUIRED');
      const citation = (await tools.read(file)).details.citation.citeId;
      const entry = { citeId: citation, start: 2, end: 5 };
      const receipt = await tools.submit('review_production_origin', { objectId, entry });
      assert.equal(receipt.nextAction, 'KEEP_UNVERIFIED_FOR_CURRENT_CALLABLE');
      assert.equal(receipt.status, 'UNKNOWN');
      assert.match(tools.params.extraSystemPrompt, /Changing only overlapping line ranges or rereading the same bytes/);
      assert.match(tools.params.extraSystemPrompt, /Do not choose a downstream helper to evade the original operation/);
      assert.match(tools.params.extraSystemPrompt, /Keep this origin proof UNVERIFIED/);
      assert.match(tools.params.extraSystemPrompt, /independently evidenced deviations may still be submitted/);
      const value = { summary: 'The current callable binding is unsupported.', productionCoverage: [{ objectId,
        citeIds: [citation], reason: 'Read the current value and return.', flow: { entry, consumer: { citeId: citation, start: 4, end: 4 },
          originReceiptId: receipt.receiptId, upstream: [] } }] };
      const pending = await tools.submit('finish_stop_review', value);
      assert.equal(pending.complete, false);
      assert.equal(pending.pendingOriginDiagnostics[0].code, 'ENTRY_CALLABLE_UNSUPPORTED');
      assert.equal((await tools.submit('finish_stop_review', { summary: 'The source remains unverified.' })).complete, true);
    } catch (error) { failure = error; throw error; }
  });
  try {
    if (failure) throw failure;
    assert.equal(handle.reviewCompleted, true);
    const row = handle.result.reviewCoverage.items.find(row => row.id === objectId);
    assert.equal(row.disposition, 'UNVERIFIED');
    assert.equal(row.originCoverage.reason, 'ENTRY_CALLABLE_UNSUPPORTED');
    assert.equal(handle.result.metricObjectJudgements.some(row => row.judgement === 'PASS'), false);
    assert.equal(await fs.readFile(file, 'utf8'), unsupported);
  } finally { await handle.close(); }
});

test('unsupported origin navigation does not suppress an independently source-evidenced deviation', async t => {
  const requirement = 'Return the input unchanged.';
  const f = await strictStopFixture(t, requirement);
  let failure, objectId, handle;
  try {
    handle = await f.run(async tools => {
      try {
        await tools.readAll();
        const original = tools.brief.task.basisFiles.find(file => path.basename(file).startsWith('user-original-'));
        const originalId = (await tools.read(original)).details.citation.citeId;
        const page = await tools.submit('set_original_checklist', { items: [{ metricId: 'M16', text: requirement,
          verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION', citeId: originalId, lineStart: 1, lineEnd: 1 }],
        scope: { stopClassification: 'TASK_COMPLETE', completionClaim: true } });
        objectId = page.items.find(item => item.description === requirement).objectId;
        const citation = (await tools.read(f.source)).details.citation.citeId;
        const origin = await tools.submit('review_production_origin', { objectId, entry: { citeId: citation, start: 2, end: 5 } });
        assert.equal(origin.status, 'UNKNOWN');
        assert.equal(origin.nextAction, 'KEEP_UNVERIFIED_FOR_CURRENT_CALLABLE');
        const saved = await tools.submit('submit_review', { taskId: objectId, verdict: 'DEVIATION',
          reason: 'The method adds one to the input and returns that changed value, contradicting the required unchanged return.',
          citeIds: [citation] });
        assert.equal(saved.saved, true);
        assert.equal((await tools.submit('finish_stop_review', { summary: 'Found the source-evidenced changed return.' })).complete, true);
      } catch (error) { failure = error; throw error; }
    });
  } catch (error) { throw failure ?? error; }
  try {
    if (failure) throw failure;
    assert.equal(handle.reviewCompleted, true);
    assert.equal(handle.result.metricObjectJudgements.find(row => row.objectId === objectId).judgement, 'DEVIATION');
    assert.equal(handle.result.reviewCoverage.items.find(row => row.id === objectId).disposition, 'DEVIATION');
    assert.equal(await fs.readFile(f.source, 'utf8'), unsupported);
  } finally { await handle.close(); }
});
