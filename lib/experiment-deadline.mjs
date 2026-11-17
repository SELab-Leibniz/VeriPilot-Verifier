import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeJson } from './files.mjs';
import { privateState } from './settlement.mjs';
import { waitForSampleStop, validateStopReceipt } from './process-scope.mjs';

export const DEFAULT_MAX_RUNTIME_MS = 21600000;
export function ensureExperimentClock(record) {
  const limit = record.input?.execution?.maxRuntimeMs ?? DEFAULT_MAX_RUNTIME_MS;
  record.experimentStartedAt ??= Date.parse(record.createdAt) || Date.now();
  record.experimentDeadlineAt ??= record.experimentStartedAt + limit;
  return record.experimentDeadlineAt;
}
export function checkExperimentDeadline(record) {
  if (Date.now() >= ensureExperimentClock(record)) throw Object.assign(new Error('Configured experiment maximum runtime expired'), { code: 'EXPERIMENT_DEADLINE_EXPIRED', record });
}
// Whole-sample timeout is intentionally different from the manual current-round
// RC control. It ends the sample's entire kernel Job, including queued work.
export async function expireExperiment(record, _rpc, { lastSnapshot, waitForStop = waitForSampleStop, reconcile } = {}) {
  if (Date.now() < ensureExperimentClock(record)) throw new Error('Experiment hard limit has not expired');
  let receipt;
  try { receipt = validateStopReceipt(record, await waitForStop(record)); }
  catch (e) {
    return { status: 'TIMEOUT_CLEANUP_FAILED', reason: 'EXPERIMENT_DEADLINE_EXPIRED', timeoutExpired: true,
      cleanupConfirmed: false, host: record.terminals ?? {}, rc: lastSnapshot?.rc ?? { status: 'UNKNOWN', ended: null },
      message: String(e.message), requiresFreshCheck: true };
  }
  record.gatewayStoppedAt = receipt.confirmedAt;
  const before = lastSnapshot?.private ?? (record.identity ? await privateState(record) : null);
  let rc = { status: 'NOT_REGISTERED', ended: null };
  if (record.identity) {
    try {
      const client = reconcile ?? (await import(pathToFileURL(path.join(record.pluginDir, 'payload/runtime-corrector/lib/openclaw/session-runtime-client.mjs')))).refreshSessionRuntimeStatus;
      rc = await client(record.identity, { request: async () => { throw new Error('Sample Job is confirmed stopped'); } });
    } catch { rc = { ...lastSnapshot?.rc, status: 'UNKNOWN', ended: null, refreshConfirmed: false }; }
  }
  const timeout = { expiredAt: record.experimentDeadlineAt, stoppedAt: receipt.confirmedAt, processScope: receipt,
    queuedAtLastObservation: before?.dispatch?.flatMap(d => d.pending ?? []) ?? [],
    privateRunsInterrupted: before?.nativeReviews?.filter(r => r.status !== 'SETTLED').map(r => ({ role: r.role, runId: r.runId, sessionId: r.sessionId, lastObservedStatus: r.status })) ?? [] };
  await writeJson(path.join(record.runDir, 'rc-status/experiment-timeout.json'), timeout);
  return { status: 'TIMED_OUT', reason: 'EXPERIMENT_DEADLINE_EXPIRED', cleanupConfirmed: true, timeoutExpired: true,
    host: record.terminals ?? {}, rc, timeout, noModelDispatch: !record.firstRunId,
    note: 'Entire sample process scope stopped. Missing native terminal receipts were not fabricated; raw queues/private records are retained as interrupted evidence.' };
}
