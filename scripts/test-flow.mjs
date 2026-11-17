#!/usr/bin/env node
// Explicit live tests: real host/model calls; never part of npm test.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadInputs } from '../lib/config.mjs';
import { run, resume, snapshot } from '../lib/runner.mjs';
import { connectHost } from '../lib/host.mjs';
import { boundedRead } from '../lib/observation.mjs';
import { validateStopReceipt } from '../lib/process-scope.mjs';
import { json, optionalJson, writeJson } from '../lib/files.mjs';
import { correctionFixture } from '../test/support/install-correction-fixture.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let stop = false, record;
process.on('SIGINT', () => { stop = true; }); process.on('SIGTERM', () => { stop = true; });
try {
  const args = process.argv.slice(2), hard = args.includes('--hard-timeout');
  const files = args.filter(arg => arg !== '--hard-timeout');
  if (files.length > 1 || files.some(arg => arg.startsWith('--'))) throw new Error('Usage: node scripts/test-flow.mjs [machine.yaml] [--hard-timeout]');
  const input = await loadInputs(path.join(root, 'examples/quicksort-correction', hard ? 'experiment-hard-timeout.yaml' : 'experiment-flow-check.yaml'), files[0] ?? path.join(root, 'machine.yaml'));
  let first, observerProcess;
  if (hard) {
    let output, code;
    try {
      const child = await promisify(execFile)(process.execPath, [path.join(root, 'scripts/run-experiment.mjs'), input.sampleFile, '--machine', input.machineFile],
        { windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024 });
      output = child.stdout; code = 0;
    } catch (error) {
      if (error.killed || typeof error.code !== 'number') throw error;
      output = error.stdout; code = error.code;
    }
    const directory = output.match(/^Run: (.+)\r?$/m)?.[1]?.trim();
    assert.ok(directory, 'Child observer must identify its run');
    record = await json(path.join(directory, 'run.json'));
    first = { record, result: await json(path.join(directory, 'result.json')) };
    observerProcess = { exitedAt: Date.now(), exitCode: code };
    assert.equal(code, 2); assert.ok(Date.now() < record.experimentDeadlineAt, 'Observer process must exit before the total limit');
  } else { first = await run(input, { ...correctionFixture, shouldStop: () => stop }); record = first.record; }
  const report = { kind: hard ? 'whole-sample hard timeout' : 'soft observer timeout and same-run recovery', runDir: record.runDir,
    firstResult: first.result.status, reason: first.result.reason, identity: record.identity, firstRunId: record.firstRunId,
    experimentDeadlineAt: record.experimentDeadlineAt, observerProcess, checkedAt: Date.now() };
  if (stop) { process.exitCode = 2; }
  else if (hard) {
    assert.equal(first.result.reason, 'OBSERVER_DEADLINE_EXPIRED');
    assert.equal(first.result.status, 'NEEDS_ATTENTION');
    // No explicit resume: the separate watchdog must finalize after observer exit.
    let final;
    while (Date.now() < record.experimentDeadlineAt + 90000 && !stop) {
      final = await optionalJson(path.join(record.runDir, 'result.json'));
      if (['TIMED_OUT', 'TIMEOUT_CLEANUP_FAILED'].includes(final?.status)) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (stop) throw new Error('Live test interrupted; sample deadline remains enforced');
    assert.equal(final?.status, 'TIMED_OUT'); assert.equal(final.cleanupConfirmed, true);
    const saved = await json(path.join(record.runDir, 'run.json'));
    const receipt = validateStopReceipt(saved, await json(path.join(record.runDir, 'rc-status/sample-stop-receipt.json')));
    assert.equal(receipt.reason, 'EXPERIMENT_DEADLINE_EXPIRED');
    assert.equal(saved.firstRunId, record.firstRunId); assert.equal(saved.identity.sessionId, record.identity.sessionId);
    assert.equal(saved.experimentDeadlineAt, record.experimentDeadlineAt);
    Object.assign(report, { verified: true, finalStatus: final.status, cleanup: receipt, host: final.host, rc: final.rc });
  } else {
    assert.equal(first.result.status, 'NEEDS_ATTENTION'); assert.equal(first.result.reason, 'OBSERVER_DEADLINE_EXPIRED');
    assert.equal(record.gatewayStoppedAt, undefined);
    assert.equal(await optionalJson(path.join(record.runDir, 'rc-status/normal-stop-request.json')), null);
    const rpc = await connectHost(record);
    const active = await boundedRead(signal => snapshot(record, rpc, { signal }), 60000);
    assert.equal(active.rc.active, true); assert.equal(active.rc.ended, false);
    assert.ok(['WAITING', 'RUNNING', 'STOPPING'].includes(active.rc.status));
    await writeJson(path.join(record.runDir, 'rc-status/soft-timeout-live-check.json'), active);
    const continued = await resume(record.runDir, { shouldStop: () => stop,
      observerOptions: { policy: { observerTimeoutMs: 1200000 } } });
    assert.equal(continued.result.status, 'ARCHIVED');
    assert.equal(continued.record.firstRunId, record.firstRunId);
    assert.equal(continued.record.experimentDeadlineAt, record.experimentDeadlineAt);
    assert.equal(continued.record.identity.sessionId, record.identity.sessionId);
    assert.ok(Object.keys(continued.result.host).length > 1, 'Must include a real automatic correction');
    assert.ok(Object.values(continued.result.host).every(r => r.status === 'ok'));
    const injection = await json(path.join(record.runDir, 'rc-status/fault-injection.json'));
    assert.equal(injection.runId, record.firstRunId);
    const { stdout } = await promisify(execFile)(input.paths.python, ['run_tests.py'],
      { cwd: continued.record.identity.projectRoot, windowsHide: true, timeout: 30000 });
    Object.assign(report, { verified: true, activeAtSoftTimeout: active.rc, finalStatus: continued.result.status,
      host: continued.result.host, rc: continued.result.rc, localTestOutput: stdout });
  }
  await writeJson(path.join(record.runDir, 'flow-test.json'), report);
  console.log(`Live flow test ${report.verified ? 'VERIFIED' : 'INTERRUPTED'}: ${record.runDir}`);
} catch (error) {
  if (record) await writeJson(path.join(record.runDir, 'flow-test.json'), { verified: false, at: Date.now(), message: error.message });
  console.error(error.message); process.exitCode = 1;
}
