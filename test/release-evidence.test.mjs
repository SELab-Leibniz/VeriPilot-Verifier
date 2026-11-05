import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { codeChanged, collectReleaseEvidence, computeReleaseVerdict, documentCorrectionEnabled, finalStopOf, hiddenScore, tokenSplit } from '../scripts/bench/release-evidence.mjs';

const sessionId = 'session-1', taskId = 'task-1';
const iso = ms => new Date(ms).toISOString();
async function workspace(t, records) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-release-evidence-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const rc = path.join(root, '.runtime-correction');
  const files = { [`tasks/${taskId}/task.json`]: { rootSessionId: sessionId, sessionIds: [sessionId] },
    'tasks/other/task.json': { rootSessionId: 'unrelated' }, ...records };
  for (const [name, value] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(rc, name)), { recursive: true });
    await fs.writeFile(path.join(rc, name), Array.isArray(value) ? value.map(row => JSON.stringify(row)).join('\n') + '\n' : JSON.stringify(value));
  }
  return root;
}
const documentReview = (root, at, stage, status, extra = {}) => ({ type: 'OPENCLAW_ARTIFACT_REVIEW', recordedAt: iso(at), toolCallId: `call-${stage}-${at}`,
  file: path.join(root, `openspec/changes/demo/${stage}.md`), result: { status, diagnostics: [],
    metadata: { stage, roundId: `round-${at}`, semanticReview: { status: 'completed', findingCount: status === 'failed' ? 2 : 0, editTargetCount: 0 }, ...extra } } });
const envelope = (at, tokens) => ({ type: 'REVIEWER_ENVELOPE', role: 'artifact-reviewer', recordedAt: iso(at),
  reviewerEnvelope: { duration_ms: 1000, usage: { input_tokens: tokens, output_tokens: 10, cache_read_input_tokens: 5 } } });
const evaluation = (runId, startedAt, { status = 'NO_DEVIATION_FOUND', classification, full, selected, complete = true, coverage, deviations = [] }) => ({
  evaluationId: `stop-${runId}`, core: { stop: { id: runId, startedAt, assessmentFinishedAt: startedAt + 5000, reviewStatus: status }, summary: { deviations } },
  outcome: { status, reasonCode: status, verificationIncomplete: false },
  review: { stopClassification: classification, scopeSelection: { classification, fullObjectCount: full, selectedObjectCount: selected }, collection: { complete } },
  ...(coverage ? { coverage } : {}) });
const nativeStop = (runId, startedAt, reviewStatus, reasonCode = reviewStatus) => ({ sessionId, runId, status: 'SETTLED', reviewStatus, reasonCode,
  evaluationId: `stop-${runId}`, startedAt, assessmentCompletedAt: startedAt + 5000, settledAt: startedAt + 6000 });
const turns = [{ stage: 'proposal', runId: 'run-proposal' }, { stage: 'coding', runId: 'run-final' }];
const natural = { businessNatural: true, hidden: { executed: true, score: { f2p_passed: 1, f2p_total: 1, p2p_passed: 611, p2p_total: 611 } }, turns,
  mutationPaths: ['openspec/changes/demo/tasks.md', 'entry/src/main/ets/Index.ets'] };

async function st1Like(t, final) {
  const root = await workspace(t, {});
  const journal = [envelope(1000, 100), documentReview(root, 2000, 'proposal', 'passed'), { type: 'OPENCLAW_FEEDBACK_DELIVERED', toolCallId: 'call-proposal-2000', recordedAt: iso(2100) },
    envelope(3000, 200), envelope(3500, 300), documentReview(root, 4000, 'tasks', 'passed')];
  return { root, records: { [`tasks/${taskId}/journal/events.jsonl`]: journal,
    [`tasks/${taskId}/evaluations/stop-proposal.json`]: evaluation('run-proposal', 10_000, { classification: 'STAGE_COMPLETE', full: 4, selected: 0 }),
    [`tasks/${taskId}/evaluations/stop-final.json`]: evaluation('run-final', 20_000, final),
    [`openclaw/native-stop-reviews/${sessionId}/a.json`]: nativeStop('run-proposal', 10_000, 'NO_DEVIATION_FOUND'),
    [`openclaw/native-stop-reviews/${sessionId}/b.json`]: nativeStop('run-final', 20_000, final.status ?? 'NO_DEVIATION_FOUND') } };
}
async function collect(t, build) {
  const { root, records } = await build;
  for (const [name, value] of Object.entries(records)) {
    const file = path.join(root, '.runtime-correction', name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, Array.isArray(value) ? value.map(row => JSON.stringify(row)).join('\n') + '\n' : JSON.stringify(value));
  }
  return { root, evidence: await collectReleaseEvidence({ projectRoot: root, sessionId, turns }) };
}

test('st1-like run: settled reviews but a WAITING_FOR_USER final Stop with no selected object is not run-through', async t => {
  const { evidence } = await collect(t, st1Like(t, { classification: 'WAITING_FOR_USER', full: 2, selected: 0 }));
  assert.deepEqual(evidence.taskIds, [taskId]);
  assert.deepEqual(evidence.documentReviews.map(row => [row.stage, row.status, row.settled, row.tokens, row.tokenSource, row.feedbackDelivered]),
    [['proposal', 'passed', true, 115, 'envelope', true], ['tasks', 'passed', true, 530, 'envelope', false]]);
  assert.equal(evidence.documentReviews[0].file, 'openspec/changes/demo/proposal.md');
  assert.deepEqual(evidence.stopReviews.map(row => [row.runId, row.stage, row.status, row.classification, row.fullObjectCount, row.selectedObjectCount, row.coverageSource]),
    [['run-proposal', 'proposal', 'NO_DEVIATION_FOUND', 'STAGE_COMPLETE', 4, 0, 'scopeSelection'],
      ['run-final', 'coding', 'NO_DEVIATION_FOUND', 'WAITING_FOR_USER', 2, 0, 'scopeSelection']]);
  const verdict = computeReleaseVerdict({ ...natural, ...evidence });
  assert.equal(verdict.runThrough, false);
  assert.deepEqual(verdict.reasons, ['FINAL_STOP_NO_COVERAGE:WAITING_FOR_USER:0/2']);
  assert.equal(finalStopOf(evidence.stopReviews, turns).runId, 'run-final');
});

test('a covered, fully scanned final Stop with every review settled runs through; hidden or business gaps still block it', async t => {
  const { evidence } = await collect(t, st1Like(t, { classification: 'TASK_COMPLETE', full: 2, selected: 2 }));
  assert.deepEqual(computeReleaseVerdict({ ...natural, ...evidence }), { runThrough: true, reasons: [], finalCoverage: 'COVERED',
    finalStop: finalStopOf(evidence.stopReviews, turns), codeChanged: true });
  assert.deepEqual(computeReleaseVerdict({ ...natural, ...evidence, hidden: { executed: false }, businessNatural: false, frameworkError: true }).reasons,
    ['FRAMEWORK_ERROR', 'BUSINESS_NOT_NATURAL', 'HIDDEN_NOT_EXECUTED']);
  assert.deepEqual(computeReleaseVerdict({ ...natural, ...evidence, documentReviews: [] }).reasons, ['NO_DOCUMENT_REVIEW']);
  const unscanned = evidence.stopReviews.map(row => row.runId === 'run-final' ? { ...row, scanCompleted: false } : row);
  assert.equal(computeReleaseVerdict({ ...natural, ...evidence, stopReviews: unscanned }).finalCoverage, 'NO_COVERAGE:TASK_COMPLETE:2/2');
});

test('with document correction off a run needs no document review, and any document review blocks it', async t => {
  const { root, evidence } = await collect(t, st1Like(t, { classification: 'TASK_COMPLETE', full: 2, selected: 2 }));
  assert.equal(await documentCorrectionEnabled(root), true);
  const config = path.join(root, '.runtime-corrector/config.yaml');
  await fs.mkdir(path.dirname(config), { recursive: true });
  await fs.writeFile(config, 'enabledStages:\n  - proposal\n');
  assert.equal(await documentCorrectionEnabled(root), true);
  await fs.writeFile(config, 'enabledStages: []\n');
  assert.equal(await documentCorrectionEnabled(root), false);
  assert.deepEqual(computeReleaseVerdict({ ...natural, ...evidence, documentReviews: [], documentCorrection: false }).reasons, []);
  assert.deepEqual(computeReleaseVerdict({ ...natural, ...evidence, documentCorrection: false }).reasons, ['DOCUMENT_REVIEW_WHILE_DISABLED']);
});

test('st2-like run: a MATERIAL_BASIS_CHANGED final Stop and its unverified basis record block the verdict', async t => {
  const build = (async () => {
    const root = await workspace(t, {});
    return { root, records: { [`tasks/${taskId}/journal/events.jsonl`]: [documentReview(root, 2000, 'design', 'failed'), documentReview(root, 3000, 'design', 'passed')],
      [`tasks/${taskId}/evaluations/stop-proposal.json`]: evaluation('run-proposal', 10_000, { classification: 'TASK_COMPLETE', full: 4, selected: 4 }),
      [`tasks/${taskId}/evaluations/stop-terminal-1.json`]: { runId: 'run-final', status: 'UNVERIFIED', reasonCode: 'MATERIAL_BASIS_CHANGED' },
      [`openclaw/native-stop-reviews/${sessionId}/b.json`]: { ...nativeStop('run-final', 20_000, 'UNVERIFIED', 'MATERIAL_BASIS_CHANGED'), evaluationId: null },
      'openclaw/material-basis/basis-1.unverified.json': { status: 'UNVERIFIED', reason: 'MATERIAL_BASIS_CHANGED', recordedAt: iso(20_050) },
      'openclaw/material-basis/basis-0.json': { status: 'VERIFIED' } } };
  })();
  const { evidence } = await collect(t, build);
  assert.deepEqual(evidence.documentReviews.map(row => [row.status, row.deviations, row.settled]), [['failed', 2, true], ['passed', 0, true]]);
  assert.deepEqual(evidence.materialBasis.map(row => row.reason), ['MATERIAL_BASIS_CHANGED']);
  const verdict = computeReleaseVerdict({ ...natural, ...evidence });
  assert.equal(verdict.runThrough, false);
  assert.deepEqual(verdict.reasons, ['STOP_MATERIAL_BASIS_CHANGED:run-final', 'MATERIAL_BASIS_UNVERIFIED:MATERIAL_BASIS_CHANGED', 'FINAL_STOP_UNSETTLED:UNVERIFIED']);
});

test('future coverage, SKIPPED document-only and STOP_NO_REVIEW_SCOPE fields are read without a product upgrade', async t => {
  const coverage = { fullObjectCount: 3, selectedObjectCount: 2, scanCompleted: true, classification: 'TASK_COMPLETE', basisBudget: { usedTokens: 10, limitTokens: 20 } };
  const { evidence } = await collect(t, st1Like(t, { classification: 'WAITING_FOR_USER', full: 9, selected: 0, complete: false, coverage }));
  const final = finalStopOf(evidence.stopReviews, turns);
  assert.deepEqual([final.coverageSource, final.fullObjectCount, final.selectedObjectCount, final.scanCompleted, final.classification, final.basisBudget],
    ['coverage', 3, 2, true, 'TASK_COMPLETE', coverage.basisBudget]);
  assert.equal(computeReleaseVerdict({ ...natural, ...evidence }).runThrough, true);

  const skipped = evidence.stopReviews.map(row => row.runId === 'run-final' ? { ...row, status: 'SKIPPED', reasonCode: 'STOP_DOCUMENT_ONLY_CHANGES', selectedObjectCount: 0 } : row);
  assert.deepEqual(computeReleaseVerdict({ ...natural, ...evidence, stopReviews: skipped, mutationPaths: ['openspec/changes/demo/tasks.md', '.runtime-corrector/config.yaml'] }),
    { runThrough: true, reasons: [], finalCoverage: 'DOCUMENT_ONLY', finalStop: skipped[1], codeChanged: false });
  assert.deepEqual(computeReleaseVerdict({ ...natural, ...evidence, stopReviews: skipped }).reasons, ['FINAL_STOP_SKIPPED_WITH_CODE_CHANGES']);
  const noScope = evidence.stopReviews.map(row => row.runId === 'run-final' ? { ...row, status: 'UNVERIFIED', reasonCode: 'STOP_NO_REVIEW_SCOPE' } : row);
  assert.deepEqual(computeReleaseVerdict({ ...natural, ...evidence, stopReviews: noScope }).reasons,
    ['STOP_UNVERIFIED:STOP_NO_REVIEW_SCOPE:run-final', 'FINAL_STOP_UNSETTLED:UNVERIFIED']);
  const pending = evidence.stopReviews.map(row => row.runId === 'run-proposal' ? { ...row, status: 'PENDING' } : row);
  assert.deepEqual(computeReleaseVerdict({ ...natural, ...evidence, stopReviews: pending }).reasons, ['STOP_UNSETTLED:PENDING:run-proposal']);
});

test('a completed warning-only document review is settled; a pending one is not', async t => {
  const build = (async () => {
    const root = await workspace(t, {});
    return { root, records: { [`tasks/${taskId}/journal/events.jsonl`]: [documentReview(root, 2000, 'tasks', 'warning'), documentReview(root, 3000, 'tasks', 'pending')] } };
  })();
  const { evidence } = await collect(t, build);
  assert.deepEqual(evidence.documentReviews.map(row => [row.status, row.settled]), [['warning', true], ['pending', false]]);
  assert.deepEqual(computeReleaseVerdict({ ...natural, ...evidence }).reasons.filter(reason => reason.startsWith('DOCUMENT_')), ['DOCUMENT_UNSETTLED:tasks:pending']);
});

test('a document review that ends on a material-basis reason is unsettled', async t => {
  const build = (async () => {
    const root = await workspace(t, {});
    return { root, records: { [`tasks/${taskId}/journal/events.jsonl`]: [documentReview(root, 2000, 'proposal', 'passed', { reasonCode: 'MATERIAL_BASIS_UNREADABLE' })] } };
  })();
  const { evidence } = await collect(t, build);
  assert.equal(evidence.documentReviews[0].settled, false);
  assert.ok(computeReleaseVerdict({ ...natural, ...evidence }).reasons.includes('DOCUMENT_UNSETTLED:proposal:MATERIAL_BASIS_UNREADABLE'));
});

test('a frozen replay ledger check replaces the cancelled native record of the same run', async t => {
  const build = (async () => {
    const root = await workspace(t, {});
    return { root, records: { [`tasks/${taskId}/evaluations/stop-check.json`]: evaluation('run-final:check-1', 20_000, { classification: 'TASK_COMPLETE', full: 2, selected: 2 }),
      [`tasks/${taskId}/evaluations/stop-terminal-x.json`]: { runId: 'run-final', status: 'UNVERIFIED', reasonCode: 'RC_NATIVE_CANCELLED' },
      [`openclaw/native-stop-reviews/${sessionId}/b.json`]: { ...nativeStop('run-final', 19_000, 'CANCELLED', 'RC_NATIVE_CANCELLED'), evaluationId: null } } };
  })();
  const { evidence } = await collect(t, build);
  assert.deepEqual(evidence.stopReviews.map(row => [row.runId, row.stage, row.status, row.reasonCode, row.selectedObjectCount, row.durationMs]),
    [['run-final:check-1', 'coding', 'NO_DEVIATION_FOUND', 'NO_DEVIATION_FOUND', 2, 5000]]);
  assert.equal(finalStopOf(evidence.stopReviews, turns).runId, 'run-final:check-1');
});

test('token split, hidden score and code-change classification', () => {
  const documentReviews = [{ requests: 2, tokens: 100 }, { requests: 1, tokens: 50 }], stopReviews = [{ requests: 3, tokens: 400 }];
  assert.deepEqual(tokenSplit({ businessUsage: { observedCalls: 7, tokens: 900 }, documentReviews, stopReviews }),
    { rc: { requests: 6, tokens: 550, document: { requests: 3, tokens: 150 }, stop: { requests: 3, tokens: 400 } }, business: { requests: 7, tokens: 900 } });
  assert.equal(tokenSplit({ documentReviews: [{ requests: 1, tokens: null }], stopReviews }).rc.tokens, null);
  assert.deepEqual(tokenSplit({ documentCost: { usage: { observedCalls: 4, tokens: 10 } }, stopCost: { usage: { observedCalls: 5, tokens: 20 } } }).rc,
    { requests: 9, tokens: 30, document: { requests: 4, tokens: 10 }, stop: { requests: 5, tokens: 20 } });
  assert.deepEqual(hiddenScore({ executed: true, score: { f2p_passed: 1, f2p_total: 2, p2p_passed: 739, p2p_total: 746 } }),
    { executed: true, f2p: '1/2', p2p: '739/746', resolved: false });
  assert.deepEqual(hiddenScore(null), { executed: false, f2p: null, p2p: null, resolved: null });
  assert.equal(codeChanged(['openspec\\changes\\a.md', '.opencode/x']), false);
  assert.equal(codeChanged(['entry/src/main/ets/a.ets']), true);
  assert.equal(codeChanged(undefined), null);
});
