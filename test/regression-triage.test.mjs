import assert from 'node:assert/strict';
import test from 'node:test';
import { isolatedRegressionResult, triageRegressionFailures } from '../lib/runtime-v2/regression-triage.mjs';
import { regressionCaseScope } from '../scripts/bench/arkts-regression-check.mjs';
import { normalizeRegressionCheck } from '../lib/runtime-v2/stop-correction-config.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runStopRegressionCheck, regressionFailureInventory, STANDING_REGRESSION } from '../lib/runtime-v2/regression-evidence.mjs';

const passed = id => ({ exitCode: 0, outputTail: `RC_REGRESSION_CASE ${JSON.stringify({ id, status: 'PASS', complete: true, observed: [id] })}\n` });

test('program triage removes baseline failures and fresh isolated passes while retaining real or unproven failures', async () => {
  const called = [];
  const result = await triageRegressionFailures({ failures: ['existing', 'leaked', 'regressed', 'unknown'].map(id => ({ id })),
    baseline: { completeRuntime: true, statuses: { existing: 'FAIL', leaked: 'PASS', regressed: 'PASS', unknown: 'PASS' } },
    isolate: async id => { called.push(id); return id === 'leaked' ? passed(id) : { exitCode: id === 'regressed' ? 1 : 2, reason: id === 'unknown' ? 'RUNNER_UNAVAILABLE' : null }; } });
  assert.deepEqual(called, ['leaked', 'regressed', 'unknown']);
  assert.deepEqual(result.cases.map(item => item.type), ['PRE_EXISTING_FAILURE', 'TEST_ISOLATION', 'REVIEW_REQUIRED', 'REVIEW_REQUIRED']);
  assert.equal(result.cases[3].reason, 'RUNNER_UNAVAILABLE');
  assert.equal((await triageRegressionFailures({ failures: [{ id: 'existing' }], baseline: { completeRuntime: false, statuses: { existing: 'FAIL' } } })).cases[0].type, 'REVIEW_REQUIRED');
});

test('isolated-pass evidence rejects wrong identities, multiple cases, missing completion and process failure', () => {
  assert(isolatedRegressionResult(passed('one'), 'one'));
  for (const result of [passed('two'), { ...passed('one'), exitCode: 2 }, { ...passed('one'), reason: 'TIMEOUT' },
    { ...passed('one'), outputTail: passed('one').outputTail + passed('one').outputTail },
    { exitCode: 0, outputTail: 'RC_REGRESSION_CASE {"id":"one","status":"PASS","complete":false,"observed":["one"]}' },
    { exitCode: 0, outputTail: 'RC_REGRESSION_CASE {"id":"one","status":"PASS","complete":true,"observed":["one","two"]}' }])
    assert.equal(isolatedRegressionResult(result, 'one'), null);
});

test('the native filter preserves exact test names and rejects unrepresentable scopes', () => {
  assert.deepEqual(regressionCaseScope('entry::DeviceConsumer::keeps empty input stable'),
    { module: 'entry', suite: 'DeviceConsumer', itName: 'keeps empty input stable' });
  assert.equal(regressionCaseScope('entry::Suite::quoted"case & input').itName, 'quoted"case & input');
  for (const id of ['incomplete', 'entry::Suite::one,two', 'entry::Suite::a\nb'])
    assert.throws(() => regressionCaseScope(id));
  const config = normalizeRegressionCheck({ enabled: true, command: ['runner'], baselineFile: 'original-result.json',
    isolationCommand: ['runner', '--test={testId}'] });
  assert.equal(config.baselineFile, 'original-result.json');
  assert.deepEqual(config.isolationCommand, ['runner', '--test={testId}']);
  assert.throws(() => normalizeRegressionCheck({ isolationCommand: ['runner'] }), /testId/u);
});

test('the normal regression entry runs isolation before review, retains evidence and reuses unchanged triage', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-triage-command-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'baseline.json'), JSON.stringify({ completeRuntime: true,
    statuses: { existing: 'FAIL', leaked: 'PASS', regressed: 'PASS' } }));
  const runner = path.join(root, 'runner.mjs');
  await fs.writeFile(runner, `
    const id = process.argv[2];
    if (!id) {
      console.log('not ok 1 - existing\\nnot ok 2 - leaked\\nnot ok 3 - regressed\\n# fail 3');
      process.exitCode = 1;
    } else {
      console.log('RC_REGRESSION_CASE ' + JSON.stringify({ id, status: id === 'leaked' ? 'PASS' : 'FAIL', complete: true, observed: [id] }));
      process.exitCode = id === 'leaked' ? 0 : 1;
    }
  `);
  const config = normalizeRegressionCheck({ enabled: true, command: [process.execPath, runner], baselineFile: 'baseline.json',
    isolationCommand: [process.execPath, runner, '{testId}'], timeoutMs: 10000 });
  const population = { metrics: { M16: [{ programStanding: STANDING_REGRESSION }] } };
  const run = await runStopRegressionCheck({ projectRoot: root, config, population, deadlineAt: Date.now() + 30000 });
  assert.equal(run.status, 'FAILED');
  assert.deepEqual(run.triage.cases.map(item => [item.id, item.type]),
    [['existing', 'PRE_EXISTING_FAILURE'], ['leaked', 'TEST_ISOLATION'], ['regressed', 'REVIEW_REQUIRED']]);
  assert.deepEqual(regressionFailureInventory(run), { complete: true,
    failures: [{ id: 'regressed', title: 'regressed' }], excluded: ['existing', 'leaked'] });
});
