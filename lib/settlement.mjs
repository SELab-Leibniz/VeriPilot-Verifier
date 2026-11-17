import path from 'node:path';
import { filesUnder, json } from './files.mjs';

export async function privateState(record) {
  const state = { reviews: [], nativeReviews: [], dispatch: [], ledgers: [] };
  const roots = [
    [path.join(record.identity.projectRoot, '.runtime-correction/openclaw/native-stop-reviews'), 'reviews'],
    [path.join(record.identity.projectRoot, '.runtime-correction/openclaw/native-runs'), 'nativeReviews'],
    [path.join(record.stateDir, 'runtime-corrector-stop-sessions'), 'host']
  ];
  for (const [root, kind] of roots) for (const file of await filesUnder(root)) {
    if (!file.endsWith('.json')) continue;
    const value = await json(file);
    // Private reviewer sessionId is its own identity, not the business sessionId.
    // A run has one isolated project: all its native review jobs must settle.
    if (kind !== 'nativeReviews' && (value.sessionId ?? value.identity?.sessionId) !== record.identity.sessionId) continue;
    if (kind === 'host') {
      if (file.split(path.sep).includes('post-run')) state.dispatch.push(value);
      else if (value.admissions) state.ledgers.push(value);
    } else state[kind].push(value);
  }
  return state;
}
export function runIds(snapshot, firstRunId) {
  return [...new Set([firstRunId, snapshot.rc?.runId, ...(snapshot.rc?.history ?? []).map(r => r.runId),
    ...[...snapshot.dispatch, ...snapshot.private.dispatch].flatMap(d => [d.runId, d.correctionRunId, d.dispatching?.runId, d.candidate?.runId, ...(d.completedRuns ?? [])]),
    ...snapshot.private.ledgers.flatMap(l => Object.values(l.admissions ?? {}).map(a => a.hostRequest?.runId))].filter(Boolean))];
}
export function completion(snapshot, terminals, firstRunId) {
  const { rc, dispatch, private: work } = snapshot;
  const reasons = [];
  if (!rc || rc.ended !== true || rc.active !== false || rc.pendingUserTasks !== 0
    || ['UNKNOWN', 'INTERRUPTED'].includes(rc.status) || rc.health === 'STALE' || rc.refreshConfirmed === false) reasons.push('RC_NOT_SETTLED');
  if (!rc?.runId || !rc?.roundId) reasons.push('RC_ROUND_NOT_OBSERVED');
  for (const id of runIds(snapshot, firstRunId)) if (!['ok', 'error'].includes(terminals[id]?.status)) reasons.push(`HOST_TERMINAL_MISSING:${id}`);
  if (!dispatch.length || !work.dispatch.length) reasons.push('DISPATCH_RECORD_MISSING');
  for (const d of [...dispatch, ...work.dispatch]) {
    if (!['IDLE', 'CLOSED'].includes(d.phase) || d.pending?.length || d.dispatching || d.candidate || d.correctionRunId
      || d.requirements?.pending || d.reconciliation?.status === 'UNKNOWN') reasons.push('DISPATCH_NOT_SETTLED');
  }
  if (work.reviews.some(v => v.status !== 'SETTLED')) reasons.push('STOP_REVIEW_PENDING');
  if (work.nativeReviews.some(v => v.status !== 'SETTLED')) reasons.push('PRIVATE_RUN_PENDING');
  for (const ledger of work.ledgers) {
    const admissions = Object.values(ledger.admissions ?? {}).flat();
    // Invalidated can still mean UNCERTAIN: capacity is released only by accounting.
    if (admissions.some(a => a.accounting === 'RESERVED')) reasons.push('ADMISSION_RESERVED');
    if (Object.values(ledger.stops ?? {}).some(s => s.control?.startsWith('WAIT_') && s.releasedAt === undefined)) reasons.push('STOP_CONTROL_PENDING');
  }
  return { settled: reasons.length === 0, reasons: [...new Set(reasons)] };
}
