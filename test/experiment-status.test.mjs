import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { json, writeJson } from '../lib/files.mjs';
import { queryExperimentStatus, publishExperimentStatus, saveRunRecord, startStatusHeartbeat } from '../lib/experiment-status.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture() {
  const runDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'RC 实验状态 ')));
  const at = Date.now();
  const record = { id: 'sample-attempt', runDir, createdAt: new Date(at).toISOString(), updatedAt: at,
    experimentStartedAt: at, experimentDeadlineAt: at + 600000, phase: 'OBSERVING', gatewayPid: 123,
    input: { id: 'sample', execution: { maxRuntimeMs: 600000 }, environment: { API_KEY: 'private-secret' } },
    identity: { agentId: 'main', sessionKey: 'agent:main:s', sessionId: 's', projectRoot: path.join(runDir, 'project') },
    firstRunId: 'original', terminals: {},
    processScope: { jobName: 'Local\\RCExperiment-test', root: { pid: 123, startedAt: '2026-01-01T00:00:00.0000000Z' } } };
  await writeJson(path.join(runDir, 'run.json'), record);
  const rc = { ...record.identity, status: 'RUNNING', phase: 'REVIEWING', stage: 'stop-reviewer', active: true, ended: false,
    health: 'FRESH', pendingUserTasks: 0, owner: { pid: 123, token: 'private-owner-token' } };
  return { record, rc, readRcStatus: async () => structuredClone(rc) };
}
function receipt(record, reason = 'NORMAL_CLEANUP') {
  return { ...record.processScope, deadlineAt: record.experimentDeadlineAt,
    reason, activeProcesses: 0, requestedAt: Date.now(), confirmedAt: Date.now() };
}
async function finished(f, hostStatus = 'ok') {
  f.record.phase = 'ARCHIVED'; f.record.gatewayStoppedAt = Date.now();
  await writeJson(path.join(f.record.runDir, 'rc-status/sample-stop-receipt.json'), receipt(f.record));
  await writeJson(path.join(f.record.runDir, 'result.json'), { id: f.record.id, identity: f.record.identity,
    status: 'ARCHIVED', rc: { ...f.rc, status: 'ENDED', active: false, ended: true, outcome: 'NO_DEVIATION_FOUND' },
    host: { original: { runId: 'original', status: hostStatus } } });
  await writeJson(path.join(f.record.runDir, 'run.json'), f.record);
}

test('a live experiment exposes identity, deadline and RC stage without releasing the slot or leaking secrets', async () => {
  const f = await fixture();
  const state = await queryExperimentStatus(f.record.runDir, f);
  assert.equal(state.schemaVersion, 'rc-experiment.status.v1'); assert.equal(state.status, 'RUNNING');
  assert.equal(state.terminal, false); assert.equal(state.canScheduleNext, false);
  assert.equal(state.identity.sessionId, 's'); assert.equal(state.rc.stage, 'stop-reviewer');
  assert.equal(state.deadlineAt, f.record.experimentDeadlineAt);
  assert.doesNotMatch(JSON.stringify(state), /private-secret|private-owner-token/);
});
test('RC ended/current-round terminated, or a stopped observer, cannot mark the experiment complete', async () => {
  for (const status of ['ENDED', 'TERMINATED']) {
    const f = await fixture(); Object.assign(f.rc, { status, active: false, ended: true, pendingUserTasks: 1 });
    f.record.phase = 'NEEDS_ATTENTION';
    await writeJson(path.join(f.record.runDir, 'run.json'), f.record);
    await writeJson(path.join(f.record.runDir, 'result.json'), { status: 'NEEDS_ATTENTION', reason: 'OBSERVER_DEADLINE_EXPIRED' });
    await writeJson(path.join(f.record.runDir, 'rc-status/controller-heartbeat.json'), { active: false, pid: 456, at: Date.now() });
    const state = await queryExperimentStatus(f.record.runDir, f);
    assert.equal(state.status, 'NEEDS_ATTENTION'); assert.equal(state.observer.state, 'STOPPED');
    assert.equal(state.terminal, false); assert.equal(state.canScheduleNext, false);
  }
});
test('stale/dead observers and unavailable RC are unknown, never silently completed', async () => {
  const f = await fixture(); f.record.updatedAt = Date.now() - 60000;
  await writeJson(path.join(f.record.runDir, 'run.json'), f.record);
  const state = await queryExperimentStatus(f.record.runDir, { readRcStatus: async () => { throw new Error('unavailable'); } });
  assert.equal(state.status, 'UNKNOWN'); assert.equal(state.rc.active, null);
  assert.equal(state.terminal, false); assert.equal(state.canScheduleNext, false); assert.equal(state.attentionRequired, true);
});
test('only matching zero-process cleanup permits scheduling a finalized experiment; host errors stay separate from RC outcome', async () => {
  for (const hostStatus of ['ok', 'error']) {
    const f = await fixture(); await finished(f, hostStatus);
    const state = await queryExperimentStatus(f.record.runDir);
    assert.equal(state.status, hostStatus === 'ok' ? 'COMPLETED' : 'FAILED');
    assert.equal(state.executionExitCode, hostStatus === 'ok' ? 0 : 3);
    assert.equal(state.rc.outcome, 'NO_DEVIATION_FOUND');
    assert.equal(state.terminal, true); assert.equal(state.resourcesReleased, true); assert.equal(state.canScheduleNext, true);
    await writeJson(path.join(f.record.runDir, 'rc-status/sample-stop-receipt.json'), { ...receipt(f.record), jobName: 'wrong-job' });
    assert.equal((await queryExperimentStatus(f.record.runDir)).canScheduleNext, false);
  }
});
test('a failed preparation without a Gateway is terminal and releases the slot', async () => {
  const f = await fixture();
  for (const key of ['gatewayPid', 'processScope', 'identity', 'firstRunId']) delete f.record[key];
  f.record.phase = 'FAILED';
  await writeJson(path.join(f.record.runDir, 'run.json'), f.record);
  await writeJson(path.join(f.record.runDir, 'result.json'), { status: 'FAILED', reason: 'PREPARATION_FAILED' });
  const state = await queryExperimentStatus(f.record.runDir);
  assert.equal(state.status, 'FAILED'); assert.equal(state.resourcesReleased, true);
  assert.equal(state.canScheduleNext, true); assert.equal(state.executionExitCode, 1);
  assert.equal(state.deadlineGuard.state, 'UNKNOWN');
});
test('querying an already completed attempt after its former deadline does not turn completion into a timeout', async () => {
  const f = await fixture(); f.record.finishedAt = new Date().toISOString(); await finished(f);
  const state = await queryExperimentStatus(f.record.runDir, { now: f.record.experimentDeadlineAt + 60000 });
  assert.equal(state.status, 'COMPLETED'); assert.equal(state.timeoutExpired, false);
  assert.equal(state.remainingMs, 0); assert.ok(state.elapsedMs < 1000);
});
test('a hard-stop receipt resolves an exited observer before result finalization, without rewriting any history', async () => {
  const f = await fixture(); f.record.experimentDeadlineAt = Date.now() - 1000;
  f.record.phase = 'NEEDS_ATTENTION';
  await writeJson(path.join(f.record.runDir, 'run.json'), f.record);
  await writeJson(path.join(f.record.runDir, 'result.json'), { status: 'NEEDS_ATTENTION', reason: 'OBSERVER_DEADLINE_EXPIRED' });
  await writeJson(path.join(f.record.runDir, 'rc-status/sample-stop-receipt.json'), receipt(f.record, 'EXPERIMENT_DEADLINE_EXPIRED'));
  const before = await fs.readFile(path.join(f.record.runDir, 'run.json'));
  const state = await queryExperimentStatus(f.record.runDir, f);
  assert.equal(state.status, 'TIMED_OUT'); assert.equal(state.terminal, true); assert.equal(state.canScheduleNext, true);
  assert.equal(state.resultFinalized, false); assert.equal(state.executionExitCode, 4);
  assert.deepEqual(await fs.readFile(path.join(f.record.runDir, 'run.json')), before);
  assert.equal((await json(path.join(f.record.runDir, 'result.json'))).status, 'NEEDS_ATTENTION');
});
test('expiration alone is not proof of cleanup; missing cleanup exceeds a finite grace into attention', async () => {
  const f = await fixture(); f.record.experimentDeadlineAt = Date.now() - 1000;
  await writeJson(path.join(f.record.runDir, 'run.json'), f.record);
  let state = await queryExperimentStatus(f.record.runDir, f);
  assert.equal(state.status, 'FINALIZING'); assert.equal(state.canScheduleNext, false);
  state = await queryExperimentStatus(f.record.runDir, { ...f, now: Date.now() + 61000 });
  assert.equal(state.status, 'TIMEOUT_CLEANUP_FAILED'); assert.equal(state.terminal, false); assert.equal(state.attentionRequired, true);
  assert.equal(state.canScheduleNext, false);
});
test('foreign RC identity and mismatched result documents are not trusted', async () => {
  const f = await fixture(); f.rc.sessionId = 'foreign';
  await writeJson(path.join(f.record.runDir, 'result.json'), { id: 'different-attempt', status: 'ARCHIVED' });
  const state = await queryExperimentStatus(f.record.runDir, f);
  assert.equal(state.rc.status, 'UNKNOWN'); assert.equal(state.canScheduleNext, false);
  assert.ok(state.issues.some(issue => issue.code === 'RC_IDENTITY_MISMATCH'));
  assert.ok(state.issues.some(issue => issue.code === 'RESULT_IDENTITY_MISMATCH'));
});
test('a hanging status reader is bounded and cannot publish late results or mutate the experiment', async () => {
  const f = await fixture(); const before = await fs.readFile(path.join(f.record.runDir, 'run.json'));
  await assert.rejects(() => queryExperimentStatus(f.record.runDir,
    { timeoutMs: 20, readRcStatus: () => new Promise(resolve => setTimeout(() => resolve(f.rc), 80)) }), { code: 'STATUS_QUERY_TIMEOUT' });
  await pause(120);
  assert.deepEqual(await fs.readFile(path.join(f.record.runDir, 'run.json')), before);
  await assert.rejects(() => fs.stat(path.join(f.record.runDir, 'experiment-status.json')), /ENOENT/);
});
test('publication always reloads final records instead of a previous active snapshot', async () => {
  const f = await fixture(); await publishExperimentStatus(f.record.runDir);
  await finished(f);
  await Promise.all([publishExperimentStatus(f.record.runDir), publishExperimentStatus(f.record.runDir)]);
  const stored = await json(path.join(f.record.runDir, 'experiment-status.json'));
  assert.equal(stored.status, 'COMPLETED'); assert.equal(stored.canScheduleNext, true);
  assert.equal(stored.stale, false); assert.ok(stored.heartbeatAt);
});
test('heartbeat keeps preparation status fresh and reports a stopped observer on handoff', async () => {
  const f = await fixture(); f.record.phase = 'PREPARING'; delete f.record.identity;
  await saveRunRecord(f.record);
  const stop = startStatusHeartbeat(f.record, { intervalMs: 10 });
  try {
    await pause(60);
    const state = await queryExperimentStatus(f.record.runDir);
    assert.equal(state.observer.state, 'ACTIVE'); assert.equal(state.status, 'PREPARING'); assert.equal(state.stale, false);
  } finally { await stop(); }
  assert.equal((await queryExperimentStatus(f.record.runDir)).observer.state, 'STOPPED');
});
test('public CLI emits JSON only; querying a failed experiment succeeds, missing run fails safely', async () => {
  const f = await fixture(); await finished(f, 'error');
  const execute = promisify(execFile), cli = path.join(root, 'scripts/experiment-status.mjs');
  const { stdout, stderr } = await execute(process.execPath, [cli, f.record.runDir], { windowsHide: true, timeout: 10000 });
  assert.equal(stderr, ''); assert.equal(JSON.parse(stdout).status, 'FAILED');
  try { await execute(process.execPath, [cli, path.join(f.record.runDir, 'missing')], { windowsHide: true, timeout: 10000 }); assert.fail('expected query failure'); }
  catch (error) { assert.equal(error.code, 1); assert.equal(JSON.parse(error.stdout).canScheduleNext, false); }
});
