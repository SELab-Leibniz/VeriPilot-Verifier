import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { copyArktsPublicTestSnapshot } from './arkts-public-test-snapshot.mjs';
import { arktsToolchainCommand } from './arkts-toolchain-runner.mjs';
import { submitArktsWorkerJob } from './arkts-worker-exchange.mjs';
import { runBoundedProcess } from './bounded-process.mjs';
import { arktsInstrumentRuntime } from './arkts-instrument-results.mjs';

export const arktsLocalTestCoveragePath = 'entry/.test/default/intermediates/test/coverage_data/coverage.log';

export async function runArktsLocalTest({ projectRoot, toolRoot, javaHome, timeoutMs, signal, install = false, publicTestWorker, instrument }) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('A positive ArkTS local test timeout is required');
  const coverage = path.join(projectRoot, arktsLocalTestCoveragePath);
  if (instrument) {
    assert(!publicTestWorker, 'Choose one public test backend');
    await fs.rm(coverage, { force: true });
    let result;
    try {
      const { runArktsInstrumentTests } = await import('./arkts-instrument-runtime.mjs');
      result = await runArktsInstrumentTests({ projectRoot, toolRoot, javaHome, timeoutMs, signal, ...instrument });
    } catch (error) {
      signal?.throwIfAborted();
      return { execution: { exitCode: null, interrupted: true, outputComplete: false, reason: 'INSTRUMENT_TEST_UNAVAILABLE' },
        output: error.message, raw: '', freshReport: false };
    }
    if (result.freshReport) {
      await fs.mkdir(path.dirname(coverage), { recursive: true });
      await fs.writeFile(coverage, result.raw, { flag: 'wx' });
    }
    return result;
  }
  if (publicTestWorker) {
    const { exchange, toolchainSha256, releaseCommit, runtime, caseId, scope } = publicTestWorker;
    assert.match(toolchainSha256 ?? '', /^[a-f0-9]{64}$/u, 'The public test worker requires a pinned toolchain');
    assert.match(releaseCommit ?? '', /^[a-f0-9]{40}$/u, 'The public test worker requires a pinned release');
    assert(runtime === undefined || runtime === arktsInstrumentRuntime && /^[a-z0-9_-]+$/u.test(caseId ?? ''),
      'Instrument Test worker requires a benchmark case');
    const input = { toolchainSha256, releaseCommit, ...(runtime ? { runtime, caseId, ...(scope ? { scope } : {}) } : {}) };
    await fs.rm(coverage, { force: true });
    let result;
    try {
      const receipt = await submitArktsWorkerJob(exchange, 'test', input, { timeoutMs, signal,
        async prepare(directory) {
          input.snapshotSha256 = await copyArktsPublicTestSnapshot(projectRoot, path.join(directory, 'source'), { signal });
        },
      });
      assert.deepEqual(receipt?.input, input, 'Public test worker receipt differs from its snapshot');
      const { execution, output, raw, freshReport } = receipt;
      assert(typeof execution?.interrupted === 'boolean' && typeof execution?.outputComplete === 'boolean'
        && (execution.exitCode === null || Number.isInteger(execution.exitCode)) && typeof output === 'string'
        && typeof raw === 'string' && typeof freshReport === 'boolean' && (freshReport || raw === ''), 'Invalid public test worker receipt');
      assert((execution.snapshotSha256 === undefined || execution.snapshotSha256 === input.snapshotSha256)
        && (!freshReport || execution.runtime === runtime && (!runtime || execution.snapshotSha256 === input.snapshotSha256)),
      'Public test worker receipt differs from its measured snapshot or backend');
      result = { execution: { ...execution, snapshotSha256: input.snapshotSha256 }, output, raw, freshReport };
    } catch {
      signal?.throwIfAborted();
      return { execution: { exitCode: null, interrupted: true, outputComplete: false, reason: 'PUBLIC_TEST_WORKER_UNAVAILABLE', tail: '' },
        output: '', raw: '', freshReport: false };
    }
    const { raw, freshReport } = result;
    if (freshReport) {
      await fs.mkdir(path.dirname(coverage), { recursive: true });
      await fs.writeFile(coverage, raw, { flag: 'wx' });
    }
    return result;
  }
  const deadline = performance.now() + timeoutMs;
  let output = '';
  const run = phase => {
    const remaining = Math.ceil(deadline - performance.now());
    if (remaining <= 0) return { exitCode: null, interrupted: true, reason: 'deadline', outputComplete: false, tail: '' };
    const tool = arktsToolchainCommand({ toolRoot, javaHome, projectRoot, phase });
    return runBoundedProcess(tool.command, tool.args, { cwd: projectRoot, env: tool.env, processGroup: true,
      timeoutMs: remaining, signal, onOutput: value => { output += value; } });
  };
  if (install) {
    const execution = await run('install');
    if (execution.exitCode !== 0 || execution.interrupted || !execution.outputComplete)
      return { execution, output, raw: '', freshReport: false };
  }

  await fs.rm(coverage, { force: true });
  const checkedAt = Date.now();
  const execution = await run('test');
  const stat = await fs.stat(coverage).catch(() => null);
  const freshReport = Boolean(stat?.isFile() && stat.mtimeMs >= checkedAt - 2000);
  return { execution, output, raw: freshReport ? await fs.readFile(coverage, 'utf8') : '', freshReport };
}
