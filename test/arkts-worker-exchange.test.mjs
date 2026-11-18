import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { arktsInstrumentRuntime } from '../scripts/bench/arkts-instrument-results.mjs';
import { arktsLocalTestCoveragePath, runArktsLocalTest } from '../scripts/bench/arkts-local-test.mjs';
import { copyArktsPublicTestSnapshot } from '../scripts/bench/arkts-public-test-snapshot.mjs';
import { serveArktsWorkerJobs, submitArktsWorkerJob } from '../scripts/bench/arkts-worker-exchange.mjs';
import { runArktsWorkerPublicTest } from '../scripts/run-arkts-public-test-worker.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'arkts-exchange-'));
  const exchange = path.join(root, 'e'), projectRoot = path.join(root, 'project'), workspaceRoot = path.join(root, 'w');
  await Promise.all([exchange, projectRoot, workspaceRoot].map(dir => fs.mkdir(dir)));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { exchange, projectRoot, workspaceRoot };
}

function startWorker(exchange, handle, onError = assert.fail) {
  const controller = new AbortController();
  const finished = serveArktsWorkerJobs(exchange, handle, { signal: controller.signal, pollMs: 5, onError });
  return async () => { controller.abort(); await finished; };
}

test('runs the exact public snapshot privately and restores only a fresh worker report', async t => {
  const { exchange, projectRoot, workspaceRoot } = await fixture(t);
  const coverage = path.join(projectRoot, arktsLocalTestCoveragePath);
  await fs.mkdir(path.dirname(coverage), { recursive: true });
  await fs.writeFile(coverage, 'stale coverage');
  await fs.writeFile(path.join(projectRoot, '.env'), 'never copied');
  await fs.writeFile(path.join(projectRoot, '.git'), 'never copied');
  await fs.writeFile(path.join(projectRoot, 'main.ets'), 'public');
  const publicTestWorker = { exchange, toolchainSha256: 'a'.repeat(64), releaseCommit: 'b'.repeat(40) };
  const execution = { exitCode: 0, interrupted: false, outputComplete: true };
  const errors = [];
  let snapshotSha256;
  const stop = startWorker(exchange, async (action, input, job) => {
    assert.equal(action, 'test');
    assert.equal(input.toolchainSha256, publicTestWorker.toolchainSha256);
    assert.equal(input.releaseCommit, publicTestWorker.releaseCommit);
    snapshotSha256 = input.snapshotSha256;
    assert.match(snapshotSha256, /^[a-f0-9]{64}$/u);
    return runArktsWorkerPublicTest(input, job, {
      workspaceRoot,
      async measure({ projectRoot: workerProject, install, timeoutMs }) {
        assert.equal(install, true);
        assert(timeoutMs > 0);
        // Empty parents of excluded native generated directories may survive.
        assert.deepEqual((await fs.readdir(workerProject)).sort(), ['entry', 'main.ets']);
        assert.deepEqual(await fs.readdir(path.join(workerProject, 'entry')), []);
        assert.equal(await fs.readFile(path.join(workerProject, 'main.ets'), 'utf8'), 'public');
        return { execution, output: 'finished', raw: 'fresh coverage', freshReport: true };
      },
    });
  }, error => errors.push(error));
  try {
    const result = await runArktsLocalTest({ projectRoot, timeoutMs: 10_000, publicTestWorker });
    assert.deepEqual(result, { execution: { ...execution, snapshotSha256 }, output: 'finished', raw: 'fresh coverage', freshReport: true });
    assert.equal(await fs.readFile(coverage, 'utf8'), 'fresh coverage');
    assert.deepEqual(await fs.readdir(workspaceRoot), []);
    assert.deepEqual(errors, []);
  } finally {
    await stop();
  }
});

test('fails a modified public snapshot and stops a cancelled worker job', async t => {
  const { exchange, projectRoot, workspaceRoot } = await fixture(t);
  const filename = path.join(projectRoot, 'main.ets');
  await fs.writeFile(filename, 'public');
  const publicTestWorker = { exchange, toolchainSha256: 'a'.repeat(64), releaseCommit: 'b'.repeat(40) };
  const errors = [];
  let started, observedCancellation;
  const entered = new Promise(resolve => { started = resolve; });
  const cancelled = new Promise(resolve => { observedCancellation = resolve; });
  const stop = startWorker(exchange, async (action, input, job) => {
    if (action === 'test') {
      await fs.writeFile(path.join(job.directory, 'source', path.basename(filename)), 'changed');
      return runArktsWorkerPublicTest(input, job, { workspaceRoot, measure: () => assert.fail('must not invoke native test') });
    }
    started();
    try { await delay(10_000, undefined, { signal: job.signal }); }
    finally { observedCancellation(); }
    return {};
  }, error => errors.push(error));
  try {
    const unavailable = await runArktsLocalTest({ projectRoot, timeoutMs: 5000, publicTestWorker });
    assert.deepEqual(unavailable, { execution: { exitCode: null, interrupted: true, outputComplete: false,
      reason: 'PUBLIC_TEST_WORKER_UNAVAILABLE', tail: '' }, output: '', raw: '', freshReport: false });
    await assert.rejects(fs.stat(path.join(projectRoot, arktsLocalTestCoveragePath)), { code: 'ENOENT' });
    assert.match(errors[0], /changed after queuing/u);
    assert.deepEqual(await fs.readdir(workspaceRoot), []);
    const client = new AbortController();
    const pending = submitArktsWorkerJob(exchange, 'cancel-me', {}, { signal: client.signal, timeoutMs: 5000, pollMs: 5 });
    await entered;
    client.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    await cancelled;
  } finally {
    await stop();
  }
});

const instrumentCase = 'security_tool_1';
const instrumentScope = { module: 'entry', suite: 'Access', itName: 'keeps public order' };
const instrumentRoute = { hdc: path.resolve('fixture-hdc'), server: '127.0.0.1:8710', target: '127.0.0.1:12487', appBuildMode: 'test' };
const instrumentDevice = { server: instrumentRoute.server, target: instrumentRoute.target, api: 24, type: '2in1', image: 'HarmonyOS 6.1.0.126', bootReady: true };
const instrumentExecution = { runtime: arktsInstrumentRuntime, compileSucceeded: true, exitCode: 0,
  interrupted: false, outputComplete: true, device: instrumentDevice };

function instrumentWorker(exchange) {
  return { exchange, toolchainSha256: 'a'.repeat(64), releaseCommit: 'b'.repeat(40), runtime: arktsInstrumentRuntime,
    caseId: instrumentCase, scope: instrumentScope };
}

test('carries exact Instrument Test scope and returns the measured public snapshot through the exchange', async t => {
  const { exchange, projectRoot, workspaceRoot } = await fixture(t);
  const { exchange: _exchange, ...pins } = instrumentWorker(exchange);
  const json5Package = path.join(workspaceRoot, 'package.json');
  await fs.writeFile(path.join(projectRoot, 'main.ets'), 'public instrument source');
  const snapshotSha256 = await copyArktsPublicTestSnapshot(projectRoot);
  const measured = { execution: { ...instrumentExecution, snapshotSha256 }, output: 'instrument compile', raw: 'instrument report', freshReport: true };
  const errors = [];
  const stop = startWorker(exchange, async (action, input, job) => {
    assert.equal(action, 'test');
    assert.deepEqual(input, { ...pins, snapshotSha256 });
    const instrument = { route: instrumentRoute, expectedDevice: instrumentDevice, json5Package, scope: input.scope };
    return runArktsWorkerPublicTest(input, job, {
      workspaceRoot, instrument,
      async measure({ projectRoot: workerProject, instrument: options, install, timeoutMs, signal }) {
        assert.deepEqual(options, { route: instrumentRoute, expectedDevice: instrumentDevice, json5Package, scope: instrumentScope });
        assert.equal(install, true);
        assert(timeoutMs > 0);
        assert.equal(await fs.readFile(path.join(workerProject, 'main.ets'), 'utf8'), 'public instrument source');
        const testedSnapshot = await copyArktsPublicTestSnapshot(workerProject, undefined, { signal });
        return { ...measured, execution: { ...instrumentExecution, snapshotSha256: testedSnapshot } };
      },
    });
  }, error => errors.push(error));
  try {
    const observed = await runArktsLocalTest({ projectRoot, timeoutMs: 10_000, publicTestWorker: { exchange, ...pins } });
    assert.deepEqual(observed, measured);
    const coverage = path.join(projectRoot, arktsLocalTestCoveragePath);
    assert.equal(await fs.readFile(coverage, 'utf8'), measured.raw);
    assert.deepEqual(await fs.readdir(workspaceRoot), []);
    assert.deepEqual(errors, []);
  } finally {
    await stop();
  }
});

test('rejects invalid Instrument Test provenance at the worker and when receiving an exchange receipt', async t => {
  const { exchange, projectRoot, workspaceRoot } = await fixture(t);
  await fs.writeFile(path.join(projectRoot, 'main.ets'), 'public instrument source');
  const coverage = path.join(projectRoot, arktsLocalTestCoveragePath);
  await fs.mkdir(path.dirname(coverage), { recursive: true });
  const publicTestWorker = instrumentWorker(exchange);
  const staleSnapshot = '0'.repeat(64);
  const errors = [];
  // Later replies bypass the actual worker helper to check the receiver's own provenance validation.
  const variants = ['worker stale snapshot', 'receipt stale snapshot', 'receipt missing snapshot', 'receipt Local Test'];
  let variant;
  const stop = startWorker(exchange, async (action, input, job) => {
    assert.equal(action, 'test');
    assert.notEqual(input.snapshotSha256, staleSnapshot);
    const snapshotSha256 = variant.includes('stale') ? staleSnapshot
      : variant === 'receipt missing snapshot' ? undefined : input.snapshotSha256;
    const runtime = variant === 'receipt Local Test' ? undefined : arktsInstrumentRuntime;
    const measured = { execution: { ...instrumentExecution, runtime, snapshotSha256 }, output: 'compiled', raw: 'untrusted report', freshReport: true };
    if (variant === 'worker stale snapshot') {
      return runArktsWorkerPublicTest(input, job, { workspaceRoot,
        instrument: { route: instrumentRoute, expectedDevice: instrumentDevice, scope: input.scope }, measure: () => measured });
    }
    return { input, ...measured };
  }, error => errors.push(error));
  try {
    for (const defect of variants) {
      variant = defect;
      await fs.writeFile(coverage, 'stale coverage');
      const unavailable = await runArktsLocalTest({ projectRoot, timeoutMs: 10_000, publicTestWorker });
      assert.equal(unavailable.execution.reason, 'PUBLIC_TEST_WORKER_UNAVAILABLE', defect);
      assert.equal(unavailable.freshReport, false, defect);
      assert.equal(unavailable.raw, '', defect);
      await assert.rejects(fs.stat(coverage), { code: 'ENOENT' });
    }
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Instrument Test measured a different public snapshot/u);
    assert.deepEqual(await fs.readdir(workspaceRoot), []);
  } finally {
    await stop();
  }
});
