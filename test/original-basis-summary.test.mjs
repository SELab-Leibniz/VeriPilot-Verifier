import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { renderMarkdown, summarizeRun } from '../scripts/summarize-original-basis-release.mjs';

const write = async (file, value) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value)); };
async function attempt(root, phase, slot, number, observation, { leak = 0, projectRoot } = {}) {
  const directory = path.join(root, phase, `${slot}-attempt-${number}`);
  await write(path.join(directory, 'observation.json'), { slot, attempt: number, frameworkError: false, ...observation });
  if (leak !== null) await write(path.join(directory, 'leak-scan.json'), { matches: leak });
  if (projectRoot) await write(path.join(directory, 'evaluation/manifest.json'), { projectRoot });
}
const ledger = (id, deviations) => ({ id, reviewStatus: deviations ? 'DEVIATION' : 'NO_DEVIATION_FOUND', releaseReason: deviations ? 'REPAIR_REQUESTED' : 'NO_CURRENT_DEVIATION',
  currentDeviations: Array.from({ length: deviations }, (_, index) => ({ id: `d${index}` })), progress: { complete: true }, startedAt: 1000, assessmentFinishedAt: 4000 });

test('the summary judges quick objects, keeps the retained attempt and recomputes e2e verdicts from persisted records', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-summary-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const quick = { state: 'completed', reason: 'NO_CURRENT_DEVIATION', modelRequests: 9 };
  await attempt(root, 'quick', 'st1-ceiling-1', 1, { ...quick, result: { repairFeedback: true, firstStop: ledger('r:check-1', 2), totalUsage: { tokens: 100 } } });
  await attempt(root, 'quick', 'st1-ceiling-2', 1, { ...quick, result: { repairFeedback: false, firstStop: ledger('r:check-1', 0), totalUsage: { tokens: 50 } } });
  await attempt(root, 'quick', 'st1-correct-1', 1, { state: 'rate-limited', reason: 'PROFILE_RATE_LIMIT', modelRequests: 1, result: null });
  await attempt(root, 'quick', 'st1-correct-1', 2, { ...quick, result: { repairFeedback: true, firstStop: ledger('r:check-1', 1), totalUsage: { tokens: 70 } } }, { leak: null });

  const projectRoot = path.join(root, 'b/biz-1'), rc = path.join(projectRoot, '.runtime-correction');
  await write(path.join(rc, 'tasks/t/task.json'), { rootSessionId: 's' });
  await write(path.join(rc, 'tasks/t/journal/events.jsonl'), JSON.stringify({ type: 'OPENCLAW_ARTIFACT_REVIEW', recordedAt: new Date(5000).toISOString(),
    file: path.join(projectRoot, 'openspec/changes/c/proposal.md'), result: { status: 'passed', metadata: { stage: 'proposal', semanticReview: { status: 'completed', findingCount: 0 } } } }) + '\n');
  await write(path.join(rc, 'tasks/t/evaluations/stop-1.json'), { evaluationId: 'e1', core: { stop: { id: 'final', startedAt: 6000, assessmentFinishedAt: 9000 }, summary: { deviations: [] } },
    outcome: { status: 'NO_DEVIATION_FOUND', reasonCode: 'NO_DEVIATION_FOUND' }, review: { scopeSelection: { classification: 'WAITING_FOR_USER', fullObjectCount: 2, selectedObjectCount: 0 }, collection: { complete: true } } });
  await attempt(root, 'e2e', 'security_tool_1', 1, { state: 'finished', reason: 'closed', modelRequests: 20,
    hidden: { executed: true, score: { f2p_passed: 1, f2p_total: 1, p2p_passed: 611, p2p_total: 611, f2p_not_passed: [], p2p_not_passed: [] } },
    result: { businessNatural: true, sessionId: 's', turns: [{ stage: 'coding', runId: 'final' }], frozen: { mutationPaths: ['entry/src/a.ets'] },
      documentCost: { usage: { observedCalls: 3, tokens: 300 } }, stopCost: { usage: { observedCalls: 4, tokens: 400 } }, businessUsage: { observedCalls: 13, tokens: 1300 } } }, { projectRoot });

  const summary = await summarizeRun(root);
  assert.deepEqual(summary.quick.map(row => [row.slot, row.judgement, row.attempts, row.firstStop.deviations]),
    [['st1-ceiling-1', 'DETECTED', 1, 2], ['st1-ceiling-2', 'MISSED', 1, 0], ['st1-correct-1', 'FALSE_POSITIVE', 2, 1]]);
  assert.deepEqual(summary.totals.quick, { requests: 27, tokens: 220, judgements: { DETECTED: 1, MISSED: 1, FALSE_POSITIVE: 1 } });
  const [e2e] = summary.e2e;
  assert.equal(e2e.evidenceSource, 'persisted');
  assert.equal(e2e.runThrough, false);
  assert.deepEqual(e2e.reasons, ['FINAL_STOP_NO_COVERAGE:WAITING_FOR_USER:0/2']);
  assert.deepEqual(e2e.hidden, { executed: true, f2p: '1/1', p2p: '611/611', resolved: true });
  assert.deepEqual(e2e.tokens, { rc: { requests: 7, tokens: 700, document: { requests: 3, tokens: 300 }, stop: { requests: 4, tokens: 400 } }, business: { requests: 13, tokens: 1300 } });
  assert.deepEqual(e2e.reviews.map(row => [row.kind, row.stage, row.status]), [['document', 'proposal', 'passed'], ['stop', 'coding', 'NO_DEVIATION_FOUND']]);
  assert.equal(JSON.stringify(summary).includes('not_passed'), false);
  assert.deepEqual([summary.leakScan.status, summary.leakScan.matches, summary.leakScan.unscanned], ['INCOMPLETE', 0, 1]);
  const markdown = renderMarkdown(summary);
  for (const text of ['| st1-ceiling-1 | ceiling | 1 | completed |', '检出', '漏检', '误报', 'FINAL_STOP_NO_COVERAGE:WAITING_FOR_USER:0/2', '端到端跑通　0/1', 'INCOMPLETE'])
    assert.ok(markdown.includes(text), text);
});
