import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { outsideDecision } from './decision-scope.mjs';
import { taskDirectory, withTaskResourceLock } from './task-store.mjs';
import { atomicWriteJson, readJson } from './utils.mjs';

export const BASELINE_REFRESH_RETRY = Object.freeze({ delayMs: 60_000, maximumDelayMs: 300_000, maxAttempts: 3 });
const liveOwners = globalThis[Symbol.for('runtime-corrector.baseline-refresh-owners')] ??= new Set();
const alive = pid => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};

// This is scheduling state, never a baseline or a successful verification. It
// survives a failed decision so the next tool cannot reopen the same budget.
export async function runAutomaticBaselineRefresh({ projectRoot, taskId, key, actionId, deadlineAt, signal, run, retryOnNewAction = false,
  now = Date.now }) {
  const file = path.join(taskDirectory(projectRoot, taskId), 'baseline-refresh-attempt.json');
  const update = callback => outsideDecision(() => withTaskResourceLock({ projectRoot, taskId,
    resource: 'baseline-refresh-attempt', timeoutMs: 5000, reclaimDeadOwner: true }, callback));
  const owner = randomUUID();
  const admission = await update(async () => {
    signal?.throwIfAborted();
    const previous = await readJson(file), currentTime = now();
    const same = previous?.key === key;
    // A changed source still cannot steal a live extractor's ownership.
    if (previous?.status === 'RUNNING'
      && (previous.pid === process.pid ? liveOwners.has(previous.owner) : alive(previous.pid)) && currentTime < previous.deadlineAt)
      return { deferred: true, reason: 'BASELINE_REFRESH_IN_PROGRESS', retryAt: previous.deadlineAt };
    const attempts = same ? previous.attempts : 0;
    if (same && previous.code === 'BASELINE_FROZEN_AUTHORIZATION_REQUIRED')
      return { deferred: true, reason: previous.code, previousCode: previous.code, attempts };
    if (same && (attempts >= BASELINE_REFRESH_RETRY.maxAttempts
      || currentTime < previous.retryAt && !(retryOnNewAction && previous.actionId !== actionId)
      || previous.retryAfterAction && previous.actionId === actionId))
      return { deferred: true, reason: attempts >= BASELINE_REFRESH_RETRY.maxAttempts
        ? 'BASELINE_REFRESH_RETRY_LIMIT' : 'BASELINE_REFRESH_BACKOFF', retryAt: previous.retryAt,
      previousCode: previous.code, attempts };
    const entry = { key, actionId, owner, pid: process.pid, status: 'RUNNING', attempts: attempts + 1,
      startedAt: currentTime, deadlineAt: Math.min(deadlineAt ?? Infinity, currentTime + 86_400_000) };
    await atomicWriteJson(file, entry);
    liveOwners.add(owner);
    return entry;
  });
  if (admission.deferred) return admission;
  let result, failure;
  try { result = await run(); failure = result?.unverified ? result.error ?? new Error('Baseline remains unverified') : null; }
  catch (error) { failure = error; }
  try { await update(async () => {
    const entry = await readJson(file);
    if (entry?.owner !== owner || entry.key !== key) return;
    if (!failure) { await fs.unlink(file); return; }
    const delayMs = Math.min(BASELINE_REFRESH_RETRY.maximumDelayMs,
      BASELINE_REFRESH_RETRY.delayMs * 2 ** (entry.attempts - 1));
    const retryAfterAction = failure.code === 'BASELINE_AUDIT_INCOMPLETE';
    await atomicWriteJson(file, { ...entry, status: 'FAILED', endedAt: now(), retryAfterAction,
      retryAt: now() + (retryAfterAction ? 0 : delayMs), code: String(failure.code ?? 'BASELINE_REFRESH_FAILED').slice(0, 160) });
  }); } finally { liveOwners.delete(owner); }
  if (failure && !result) throw failure;
  return result;
}
