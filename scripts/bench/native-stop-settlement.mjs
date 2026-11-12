// Native Stop jobs (lib/openclaw/native-stop-review.mjs) persist one record per
// occurrence; closing the Gateway before they settle cancels them. Results are
// written only after every record of the session settled and the task's
// current verification is carried by one of them.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const sha256 = value => createHash('sha256').update(value).digest('hex');
export const nativeStopReviewDirectory = (projectRoot, sessionKey, sessionId) =>
  path.join(projectRoot, '.runtime-correction/openclaw/native-stop-reviews', sha256(JSON.stringify([sessionKey, sessionId])));

export async function readNativeStopRecords({ projectRoot, sessionKey, sessionId }) {
  const directory = nativeStopReviewDirectory(projectRoot, sessionKey, sessionId);
  const names = await fs.readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  return Promise.all(names.filter(name => /^[0-9a-f]{64}\.json$/u.test(name)).sort().map(async name => {
    const file = path.join(directory, name);
    try { return { file, ...JSON.parse(await fs.readFile(file, 'utf8')) }; }
    catch (error) { if (error instanceof SyntaxError || error.code === 'ENOENT') return { file, status: 'UNREADABLE' }; throw error; }
  }));
}

export const nativeStopSummary = record => ({ occurrenceId: record.occurrenceId ?? null, runId: record.runId ?? null, status: record.status ?? null,
  reviewStatus: record.reviewStatus ?? null, reasonCode: record.reasonCode ?? null, evaluationId: record.evaluationId ?? null,
  enabledRevision: record.enabledRevision ?? 0, deadlineAt: record.deadlineAt ?? null, settledAt: record.settledAt ?? null });

// A job past its own deadline, or a settled session whose current verification
// no record carries, will not change any more: give up after a grace period
// instead of polling until the run deadline. Unarmed calls reset the clock.
export function nativeStopGrace({ graceMs = 60_000, now = Date.now } = {}) {
  let since = null;
  return (state, armed = true) => {
    if (!armed || state.settled) { since = null; return null; }
    const at = now(), deadlines = state.pending.map(row => row.deadlineAt);
    if (state.pending.length && deadlines.every(Number.isFinite)) {
      since = null;
      return at > Math.max(...deadlines) + graceMs ? 'NATIVE_STOP_OVERDUE' : null;
    }
    since ??= at;
    return at - since > graceMs ? (state.pending.length ? 'NATIVE_STOP_UNREADABLE' : 'NATIVE_STOP_NO_CARRIER') : null;
  };
}

// A terminal settlement (stop-terminal-*) has no assessment; its record is the
// SETTLED job of terminalRunId. Every other verification, including document-only
// skips (stop-skip-*, SKIPPED), must be carried by a SETTLED record's evaluationId.
export function nativeStopSettlement(records = [], verification = null) {
  const pending = records.filter(record => record.status !== 'SETTLED').map(nativeStopSummary);
  const required = verification?.evaluationId ? { evaluationId: verification.evaluationId, terminalRunId: verification.terminalRunId ?? null } : null;
  const carrier = required && records.find(record => record.status === 'SETTLED'
    && (required.terminalRunId ? record.runId === required.terminalRunId : record.evaluationId === required.evaluationId));
  return { settled: !pending.length && (!required || Boolean(carrier)), pending, required,
    carrier: carrier ? nativeStopSummary(carrier) : null, records: records.map(nativeStopSummary) };
}

export async function waitNativeStopSettled({ projectRoot, sessionKey, sessionId, readVerification, deadlineAt, pollMs = 500, graceMs, beforePoll, abandon }) {
  const startedAt = Date.now(), grace = nativeStopGrace({ graceMs });
  let state, reason = null;
  for (;;) {
    await beforePoll?.();
    state = nativeStopSettlement(await readNativeStopRecords({ projectRoot, sessionKey, sessionId }), await readVerification());
    if (state.settled) break;
    reason = grace(state) ?? (Date.now() >= deadlineAt ? 'DEADLINE' : abandon?.() ? 'ABANDONED' : null);
    if (reason) break;
    await new Promise(resolve => setTimeout(resolve, Math.max(1, Math.min(pollMs, deadlineAt - Date.now()))));
  }
  return { nativeStopSettled: state.settled, nativeStopReason: reason, nativeStopWaitMs: Date.now() - startedAt, nativeStopRecords: state.records,
    nativeStopPending: state.pending, nativeStopRequired: state.required, nativeStopVerification: state.carrier };
}
