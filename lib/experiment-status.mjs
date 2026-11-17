import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { json, optionalJson, writeJson } from './files.mjs';
import { boundedRead } from './async.mjs';
import { validateStopReceipt } from './process-scope.mjs';

export const EXPERIMENT_STATUS_SCHEMA = 'rc-experiment.status.v1';
export const STATUS_STALE_AFTER_MS = 15000;
export const CLEANUP_STATUS_GRACE_MS = 60000;
const preparing = new Set(['PREPARING', 'STARTING', 'CREATING_SESSION', 'ENABLING_RC', 'READY', 'SUBMITTING']);
const finalizing = new Set(['STOPPING_GATEWAY', 'ARCHIVING']);
const finalPhases = new Set(['PREPARED', 'ARCHIVED', 'FAILED', 'TIMED_OUT']);
const clients = new Map(), publications = new Map();
const select = (object, keys) => Object.fromEntries(keys.map(key => [key, object?.[key] ?? null]));
const fresh = (at, now) => Number.isFinite(at) && now - at <= STATUS_STALE_AFTER_MS && at <= now + 1000;
export const experimentStatusPath = runDir => path.join(path.resolve(runDir), 'experiment-status.json');

async function readOptional(file, source, issues) {
  try { return await optionalJson(file); }
  catch (error) { issues.push({ source, code: error.code ?? 'INVALID_STATUS_DATA' }); return null; }
}
function matchesIdentity(identity, data) {
  return identity && ['projectRoot', 'sessionId', 'sessionKey', 'agentId'].every(key => data?.[key] === identity[key]);
}
function observerState(heartbeat, lock, record, now) {
  if (!heartbeat) return { state: 'UNKNOWN', pid: lock?.pid ?? null, heartbeatAt: null };
  let state = heartbeat.active === false ? 'STOPPED' : 'STALE';
  if (heartbeat.active && fresh(heartbeat.at, now)
    && (lock ? lock.pid === heartbeat.pid && lock.token === heartbeat.token : preparing.has(record.phase))) state = 'ACTIVE';
  if (lock && lock.token !== heartbeat.token) state = 'UNKNOWN';
  return { state, pid: heartbeat.pid, heartbeatAt: heartbeat.at };
}
async function readRc(record, observation, result, finalized, issues, now, readStatus) {
  if (!record.identity) return { status: 'NOT_REGISTERED', health: 'UNKNOWN', active: null, ended: null, source: 'none' };
  if (finalized && typeof result?.rc?.status === 'string') return { ...result.rc, source: 'final-result' };
  try {
    if (!readStatus) {
      const file = path.join(record.pluginDir, 'payload/runtime-corrector/lib/openclaw/session-runtime-client.mjs');
      if (!clients.has(file)) clients.set(file, import(pathToFileURL(file)).catch(error => { clients.delete(file); throw error; }));
      readStatus = (await clients.get(file)).readSessionRuntimeStatus;
    }
    const current = await readStatus(record.identity);
    if (!matchesIdentity(record.identity, current)) throw Object.assign(new Error('RC identity mismatch'), { code: 'RC_IDENTITY_MISMATCH' });
    if (current.owner?.pid && record.gatewayPid && current.owner.pid !== record.gatewayPid)
      throw Object.assign(new Error('RC owner mismatch'), { code: 'RC_OWNER_CHANGED' });
    return { ...current, source: 'rc-status-file' };
  } catch (error) {
    issues.push({ source: 'rc', code: error.code ?? 'RC_STATUS_UNAVAILABLE' });
    if (!['RC_IDENTITY_MISMATCH', 'RC_OWNER_CHANGED'].includes(error.code)
      && matchesIdentity(record.identity, observation?.rc) && fresh(observation.at, now)) return { ...observation.rc, source: 'recent-observation' };
    return { status: 'UNKNOWN', health: 'UNKNOWN', active: null, ended: null, source: 'unavailable' };
  }
}
async function collectStatus(runDir, { now, readRcStatus }) {
  const record = await json(path.join(runDir, 'run.json'));
  if (path.resolve(record.runDir) !== runDir) throw Object.assign(new Error('Run directory identity changed'), { code: 'RUN_IDENTITY_MISMATCH' });
  const id = record.id ?? path.basename(runDir), issues = [];
  let [result, observation, receipt, heartbeat, lock, published, guardHeartbeat] = await Promise.all([
    ['result.json', 'result'], ['rc-status/latest.json', 'observation'], ['rc-status/sample-stop-receipt.json', 'cleanup'],
    ['rc-status/controller-heartbeat.json', 'observer'], ['controller.lock', 'controller-lock'], ['experiment-status.json', 'publication'],
    ['rc-status/process-scope-heartbeat.json', 'deadline-guard']
  ].map(([file, source]) => readOptional(path.join(runDir, file), source, issues)));
  if (result && (result.id && result.id !== id || result.identity && !matchesIdentity(record.identity, result.identity))) {
    issues.push({ source: 'result', code: 'RESULT_IDENTITY_MISMATCH' }); result = null;
  }
  if (published?.runId !== id) published = null;
  let cleanup = null;
  if (receipt) {
    try { cleanup = validateStopReceipt(record, receipt); }
    catch { issues.push({ source: 'cleanup', code: 'PROCESS_SCOPE_PROOF_INVALID' }); }
  }
  const finalized = finalPhases.has(record.phase) && result?.status === record.phase;
  const rc = await readRc(record, observation, result, finalized, issues, now, readRcStatus);
  const observer = observerState(heartbeat, lock, record, now);
  const noGateway = !record.gatewayPid && !record.processScope && !record.firstRunId;
  const resourcesReleased = cleanup ? true : finalized && noGateway ? true : record.gatewayStoppedAt ? null : false;
  const deadlineAt = record.experimentDeadlineAt ?? null, timeoutExpired = Number.isFinite(deadlineAt) && now >= deadlineAt;
  const host = Object.values(result?.status === record.phase && result.host || record.terminals || {})
    .map(terminal => select(terminal, ['runId', 'status', 'endedAt']));
  let status, terminal = false, reason = result?.status === record.phase ? result.reason ?? null : null;
  if (cleanup?.reason === 'EXPERIMENT_DEADLINE_EXPIRED' && timeoutExpired) {
    status = 'TIMED_OUT'; terminal = true; reason = 'EXPERIMENT_DEADLINE_EXPIRED';
  } else if (finalized && record.phase === 'TIMED_OUT') {
    status = resourcesReleased === true ? 'TIMED_OUT' : 'TIMEOUT_CLEANUP_FAILED'; terminal = resourcesReleased === true;
    reason = terminal ? 'EXPERIMENT_DEADLINE_EXPIRED' : 'PROCESS_SCOPE_STOP_UNCONFIRMED';
  } else if (finalized) {
    status = record.phase === 'ARCHIVED' ? host.some(run => run.status === 'error') ? 'FAILED' : 'COMPLETED' : record.phase;
    terminal = true;
  } else if (record.phase === 'TIMEOUT_CLEANUP_FAILED') status = 'TIMEOUT_CLEANUP_FAILED';
  else if (timeoutExpired) {
    status = now - deadlineAt > CLEANUP_STATUS_GRACE_MS ? cleanup ? 'NEEDS_ATTENTION' : 'TIMEOUT_CLEANUP_FAILED' : 'FINALIZING';
    reason = status === 'FINALIZING' ? 'EXPERIMENT_DEADLINE_EXPIRED' : cleanup ? 'RESULT_NOT_FINALIZED' : 'PROCESS_SCOPE_STOP_UNCONFIRMED';
  }
  else if (record.phase === 'NEEDS_ATTENTION') status = 'NEEDS_ATTENTION';
  else if (finalizing.has(record.phase) || cleanup) status = 'FINALIZING';
  else if (observer.state === 'ACTIVE' || fresh(record.updatedAt ?? Date.parse(record.createdAt), now)
    || rc.active === true && rc.health === 'FRESH') status = preparing.has(record.phase) ? 'PREPARING'
      : ['OBSERVING', 'RECONNECTING'].includes(record.phase) ? 'RUNNING' : 'UNKNOWN';
  else { status = 'UNKNOWN'; reason ??= 'STATUS_UNCONFIRMED'; }
  const executionExitCode = status === 'TIMED_OUT' ? 4 : status === 'TIMEOUT_CLEANUP_FAILED' ? 5
    : terminal ? record.phase === 'ARCHIVED' ? status === 'FAILED' ? 3 : 0 : status === 'FAILED' ? 1 : 0 : null;
  return {
    schemaVersion: EXPERIMENT_STATUS_SCHEMA, runId: id, sampleId: record.input?.id ?? null,
    runDir, statusFile: experimentStatusPath(runDir), status, phase: record.phase ?? 'UNKNOWN', reason,
    terminal, resourcesReleased, canScheduleNext: terminal && resourcesReleased === true, resultFinalized: finalized,
    attentionRequired: ['FAILED', 'UNKNOWN', 'NEEDS_ATTENTION', 'TIMEOUT_CLEANUP_FAILED'].includes(status) || issues.length > 0,
    executionExitCode, resultStatus: result?.status ?? null,
    createdAt: record.createdAt ?? null, heartbeatAt: published?.heartbeatAt ?? null, queriedAt: now,
    staleAfterMs: STATUS_STALE_AFTER_MS, stale: !terminal && !fresh(published?.heartbeatAt, now),
    deadlineAt, elapsedMs: Number.isFinite(record.experimentStartedAt)
      ? Math.max(0, (record.finishedAt ? Date.parse(record.finishedAt) : terminal && cleanup ? cleanup.confirmedAt : now) - record.experimentStartedAt) : null,
    remainingMs: terminal ? 0 : deadlineAt === null ? null : Math.max(0, deadlineAt - now),
    timeoutExpired: status === 'TIMED_OUT' || !terminal && timeoutExpired,
    identity: record.identity ? select(record.identity, ['projectRoot', 'agentId', 'sessionKey', 'sessionId']) : null,
    firstRunId: record.firstRunId ?? null, observer,
    deadlineGuard: { state: cleanup ? 'STOPPED' : guardHeartbeat?.jobName && guardHeartbeat.jobName === record.processScope?.jobName
      ? fresh(guardHeartbeat.at, now) ? 'ACTIVE' : 'STALE' : 'UNKNOWN', heartbeatAt: guardHeartbeat?.at ?? null },
    rc: { ...select(rc, ['status', 'phase', 'stage', 'active', 'ended', 'health', 'runId', 'roundId', 'pendingUserTasks', 'reasonCode', 'outcome', 'heartbeatAt']), source: rc.source },
    host, cleanup: cleanup ? select(cleanup, ['reason', 'confirmedAt', 'activeProcesses']) : null,
    artifacts: { result: result ? path.join(runDir, 'result.json') : null, project: record.identity?.projectRoot ?? null,
      transcripts: path.join(runDir, 'transcripts/index.json'), logs: path.join(runDir, 'logs') },
    issues
  };
}
// Read-only: no Gateway calls, process launches, RC reconciliation, record
// writes, session allocation or task retransmission. Each call rereads facts.
export async function queryExperimentStatus(runDir, { timeoutMs = 5000, now = Date.now(), readRcStatus } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw new Error('Invalid query timeoutMs');
  return boundedRead(() => collectStatus(path.resolve(runDir), { now, readRcStatus }), timeoutMs);
}
export function publishExperimentStatus(runDir, { role = 'controller' } = {}) {
  runDir = path.resolve(runDir);
  // Serial publication per producer, always reloading authoritative files. A
  // late snapshot/query cannot overwrite a final status using stale run data.
  const pending = (publications.get(runDir) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const status = await queryExperimentStatus(runDir);
    status.heartbeatAt = Date.now(); status.stale = false;
    status.publisher = { role, pid: process.pid };
    await writeJson(experimentStatusPath(runDir), status); return status;
  });
  publications.set(runDir, pending);
  pending.then(() => { if (publications.get(runDir) === pending) publications.delete(runDir); },
    () => { if (publications.get(runDir) === pending) publications.delete(runDir); });
  return pending;
}
export async function saveRunRecord(record) {
  record.updatedAt = Date.now();
  await writeJson(path.join(record.runDir, 'run.json'), record);
  await publishExperimentStatus(record.runDir).catch(error => statusWriteError(record.runDir, error));
}
async function statusWriteError(runDir, error) {
  await writeJson(path.join(runDir, 'logs/status-publisher-error.json'),
    { at: Date.now(), pid: process.pid, code: error.code ?? 'STATUS_PUBLICATION_FAILED' }).catch(() => {});
}
export function startStatusHeartbeat(record, { intervalMs = 1000 } = {}) {
  let stopping = false, wake;
  const token = randomUUID(), heartbeatFile = path.join(record.runDir, 'rc-status/controller-heartbeat.json');
  const job = (async () => {
    while (!stopping) {
      try {
        const lock = await optionalJson(path.join(record.runDir, 'controller.lock'));
        await writeJson(heartbeatFile, { pid: process.pid, token: lock?.pid === process.pid ? lock.token : token, active: true, at: Date.now() });
        await publishExperimentStatus(record.runDir);
      } catch (error) { await statusWriteError(record.runDir, error); }
      if (!stopping) await new Promise(resolve => { const timer = setTimeout(resolve, intervalMs); wake = () => { clearTimeout(timer); resolve(); }; });
    }
  })();
  return async () => {
    stopping = true; wake?.(); await job;
    try {
      const previous = await optionalJson(heartbeatFile);
      await writeJson(heartbeatFile, { ...previous, pid: process.pid, active: false, at: Date.now() });
      await publishExperimentStatus(record.runDir);
    } catch (error) { await statusWriteError(record.runDir, error); }
  };
}
