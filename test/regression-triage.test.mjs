import assert from 'node:assert/strict';
import test from 'node:test';
import { isolatedRegressionResult, triageRegressionFailures } from '../lib/runtime-v2/regression-triage.mjs';
import { regressionCaseScope } from '../scripts/bench/arkts-regression-check.mjs';
import { normalizeRegressionCheck } from '../lib/runtime-v2/stop-correction-config.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runStopRegressionCheck, regressionFailureInventory, STANDING_REGRESSION } from '../lib/runtime-v2/regression-evidence.mjs';
import { validateProjectConfig } from '../lib/policy/config-loader.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const passed = id => ({ exitCode: 0, outputTail: `RC_REGRESSION_CASE ${JSON.stringify({ id, status: 'PASS', complete: true, observed: [id] })}\n` });

test('program triage exempts baseline failures but retains fresh isolated passes for review', async () => {
  const called = [];
  const result = await triageRegressionFailures({ failures: ['existing', 'leaked', 'regressed', 'unknown'].map(id => ({ id })),
    baseline: { completeRuntime: true, statuses: { existing: 'FAIL', leaked: 'PASS', regressed: 'PASS', unknown: 'PASS' } },
    isolate: async id => { called.push(id); return id === 'leaked' ? passed(id) : { exitCode: id === 'regressed' ? 1 : 2, reason: id === 'unknown' ? 'RUNNER_UNAVAILABLE' : null }; } });
  assert.deepEqual(called, ['leaked', 'regressed', 'unknown']);
  assert.deepEqual(result.cases.map(item => item.type), ['PRE_EXISTING_FAILURE', 'REVIEW_REQUIRED', 'REVIEW_REQUIRED', 'REVIEW_REQUIRED']);
  assert.equal(result.version, 2);
  assert.equal(result.cases[1].isolationObserved, true);
  assert.match(result.cases[1].reason, /task-start suite passed/u);
  assert.equal(result.cases[3].reason, 'RUNNER_UNAVAILABLE');
  assert.equal((await triageRegressionFailures({ failures: [{ id: 'existing' }], baseline: { completeRuntime: false, statuses: { existing: 'FAIL' } } })).cases[0].type, 'REVIEW_REQUIRED');
  const unknown = await triageRegressionFailures({ failures: [{ id: 'unknown' }], isolate: async id => passed(id) });
  assert.equal(unknown.cases[0].type, 'REVIEW_REQUIRED');
  assert.equal(unknown.cases[0].isolationObserved, true);
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
  validateProjectConfig({ version: 2, artifacts: [], dynamicGroundTruth: { enabled: false },
    stopCorrection: { enabled: true, originalRequirementsBasis: true, regressionCheck: config } }, 'config.yaml');
});

test('the normal regression entry runs isolation before review and retains per-case evidence', async t => {
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
    [['existing', 'PRE_EXISTING_FAILURE'], ['leaked', 'REVIEW_REQUIRED'], ['regressed', 'REVIEW_REQUIRED']]);
  assert.equal(run.triageVersion, 2);
  assert.deepEqual(regressionFailureInventory(run), { complete: true,
    failures: [{ id: 'leaked', title: 'leaked' }, { id: 'regressed', title: 'regressed' }], excluded: ['existing'] });
});

test('a real order-dependent failure stays reviewable after a passing single-test run', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-triage-order-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'shared.test.mjs');
  await fs.writeFile(file, [
    "import test from 'node:test'; import assert from 'node:assert/strict';",
    'let shared = 0;',
    "test('producer', () => { shared = 1; });",
    "test('consumer', () => assert.equal(shared, 0));",
  ].join('\n'));
  const execute = promisify(execFile);
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const full = await execute(process.execPath, ['--test', '--test-reporter=tap', file], { env, windowsHide: true }).then(() => null, error => error);
  assert.equal(full?.code, 1);
  assert.match(full.stdout, /not ok \d+ - consumer/u);
  const alone = await execute(process.execPath, ['--test', '--test-reporter=tap', '--test-name-pattern=^consumer$', file], { env, windowsHide: true });
  assert.match(alone.stdout, /ok \d+ - consumer/u);
  const result = await triageRegressionFailures({ failures: [{ id: 'consumer' }],
    baseline: { completeRuntime: true, statuses: { consumer: 'PASS' } }, isolate: async id => passed(id) });
  assert.equal(result.cases[0].type, 'REVIEW_REQUIRED');
  assert.equal(result.cases[0].isolationObserved, true);
});

test('legacy isolation labels cannot hide failures in machine or TAP inventories', () => {
  const failures = [{ id: 'existing', title: 'existing' }, { id: 'ordered', title: 'ordered' }];
  const triage = { version: 1, cases: [{ id: 'existing', type: 'PRE_EXISTING_FAILURE' }, { id: 'ordered', type: 'TEST_ISOLATION' }] };
  for (const outputTail of ['not ok 1 - existing\nnot ok 2 - ordered\n# fail 2\n',
    'RC_REGRESSION_INVENTORY ' + JSON.stringify({ complete: true, failures })]) {
    assert.deepEqual(regressionFailureInventory({ status: 'FAILED', outputTail, triage }),
      { complete: true, failures: [failures[1]], excluded: ['existing'] });
  }
});

test('a complete machine inventory retains failures beyond the bounded name list', () => {
  const failures = Array.from({ length: 30 }, (_, index) => ({ id: 'test-' + index, title: 'case ' + index }));
  const outputTail = 'RC_REGRESSION_CHECK FAIL tests=30 passed=0 failed=30\n- FAIL test-0\n- ... 29 more\n'
    + 'RC_REGRESSION_INVENTORY ' + JSON.stringify({ complete: true, failures });
  assert.deepEqual(regressionFailureInventory({ status: 'FAILED', outputTail }), { complete: true, failures });
  assert.equal(regressionFailureInventory({ status: 'FAILED', outputTail: outputTail + '\nRC_REGRESSION_INVENTORY {}' }).complete, false);
});

test('a baseline modified by an isolated run invalidates the entire regression result', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-triage-basis-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'baseline.json'), JSON.stringify({ completeRuntime: true, statuses: { one: 'PASS' } }));
  const runner = path.join(root, 'runner.mjs');
  await fs.writeFile(runner, [
    "import fs from 'node:fs/promises';",
    "if (!process.argv[2]) { console.log('not ok 1 - one\\n# fail 1'); process.exitCode = 1; }",
    "else { await fs.writeFile('baseline.json', '{}');",
    "console.log('RC_REGRESSION_CASE ' + JSON.stringify({ id:'one', status:'PASS', complete:true, observed:['one'] })); }",
  ].join('\n'));
  const config = normalizeRegressionCheck({ enabled: true, command: [process.execPath, runner], baselineFile: 'baseline.json',
    isolationCommand: [process.execPath, runner, '{testId}'], timeoutMs: 10000 });
  await assert.rejects(runStopRegressionCheck({ projectRoot: root, config,
    population: { metrics: { M16: [{ programStanding: STANDING_REGRESSION }] } }, deadlineAt: Date.now() + 30000 }),
  { code: 'BASELINE_INPUT_CHANGED' });
});
