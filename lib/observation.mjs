import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeJson } from './files.mjs';
import { privateState, completion, runIds, settlementKey } from './settlement.mjs';
import { boundedRead } from './async.mjs';
import { saveRunRecord } from './experiment-status.mjs';
import { parseSimpleYaml } from './yaml.mjs';
export { boundedRead } from './async.mjs';

export const OBSERVATION_DEFAULTS = Object.freeze({ observerTimeoutMs: 21600000, uncertainTimeoutMs: 300000, queryTimeoutMs: 15000 });
export function observationPolicy(record, overrides = {}) {
  const supplied = { ...record.input?.execution, ...overrides };
  // Old run records used 0 for unlimited observation. Resume them with a finite
  // controller budget, leaving the original input and all native budgets intact.
  return { pollIntervalMs: supplied.pollIntervalMs ?? 1000, ...Object.fromEntries(Object.entries(OBSERVATION_DEFAULTS)
    .map(([key, fallback]) => [key, Number.isSafeInteger(supplied[key]) && supplied[key] > 0 ? supplied[key] : fallback])) };
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const error = (code, message) => Object.assign(new Error(message), { code });
const retryableStatusRead = error => error.code === 'STATUS_QUERY_TIMEOUT'
  || /^Timed out waiting for Runtime Corrector state lock: /.test(error.message ?? '');
async function journal(record, row) {
  if (!record.runDir) return;
  await fs.mkdir(path.join(record.runDir, 'logs'), { recursive: true });
  await fs.appendFile(path.join(record.runDir, 'logs/runner.jsonl'), JSON.stringify({ at: Date.now(), ...row }) + '\n');
}
const clients = new WeakMap();
async function publicClient(record) {
  if (!clients.has(record)) clients.set(record, import(pathToFileURL(path.join(record.pluginDir, 'payload/runtime-corrector/lib/openclaw/session-runtime-client.mjs'))));
  return clients.get(record);
}
function checkIdentity(record, status) {
  const expected = record.identity;
  if (['projectRoot', 'sessionId', 'sessionKey', 'agentId'].some(k => status?.[k] !== expected[k]))
    throw error('RC_IDENTITY_MISMATCH', 'RC returned a different Session/project identity');
  if (status.owner?.pid && record.gatewayPid && status.owner.pid !== record.gatewayPid)
    throw error('RC_OWNER_CHANGED', 'RC owner differs from this run Gateway; kept the original run');
}
async function requirementsRefreshEnabled(record) {
  // RC's requirements.pending is a ledger cursor, not its user-task queue.
  // Disregard it only when the frozen and current configs agree that neither
  // dynamic requirement extraction nor Skill extraction can consume it.
  try {
    const frozen = await fs.readFile(path.join(record.runDir, 'config/rc-config.effective.yaml'), 'utf8');
    const current = await fs.readFile(path.join(record.identity.projectRoot, '.runtime-corrector/config.yaml'), 'utf8');
    if (frozen !== current) return undefined;
    const config = parseSimpleYaml(frozen);
    return config.dynamicGroundTruth?.enabled === false && config.skillCorrection?.enabled === false ? false : undefined;
  } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
export async function snapshot(record, rpc, { signal, statusClient, policy = observationPolicy(record) } = {}) {
  const read = (method, params, timeout = policy.queryTimeoutMs) => boundedRead(async querySignal => {
    const result = await rpc(method, params, timeout, { signal: querySignal });
    querySignal.throwIfAborted(); return result;
  }, timeout, signal);
  const client = statusClient ?? await publicClient(record);
  signal?.throwIfAborted();
  const rc = await client.refreshSessionRuntimeStatus(record.identity, { request: (method, params) => read(method, params) });
  signal?.throwIfAborted(); checkIdentity(record, rc);
  const page = await read('runtime-corrector.dispatch.list', { offset: 0, limit: 100, filter: 'all' });
  const dispatch = [];
  if (!Array.isArray(page.sessions)) throw error('DISPATCH_RESPONSE_INVALID', 'Invalid dispatch session list');
  for (const item of page.sessions) if (item.sessionId === record.identity.sessionId && item.sessionKey === record.identity.sessionKey) {
    const detail = await read('runtime-corrector.dispatch.get', Object.fromEntries(['id', 'agentId', 'sessionKey', 'sessionId', 'scopeFingerprint'].map(k => [k, item[k]])));
    checkIdentity(record, detail); dispatch.push(detail);
  }
  const captured = { at: Date.now(), rc, dispatch, private: await privateState(record),
    requirementsRefreshEnabled: await requirementsRefreshEnabled(record), queryErrors: [] };
  const accepted = {};
  await Promise.all(runIds(captured, record.firstRunId).map(async runId => {
    const cached = record.terminals?.[runId];
    if (cached?.runId === runId && ['ok', 'error'].includes(cached.status)) return;
    try {
      const terminal = await read('agent.wait', { runId, timeoutMs: 1000 });
      if (terminal.runId !== runId) throw error('HOST_TERMINAL_IDENTITY_MISMATCH', 'Native receipt runId mismatch');
      if (['ok', 'error'].includes(terminal.status)) accepted[runId] = terminal;
    } catch (e) {
      signal?.throwIfAborted();
      captured.queryErrors.push({ runId, code: e.code ?? 'TERMINAL_READ_FAILED', message: String(e.message) });
    }
  }));
  // A timed-out/cancelled read can never write a late success over a checkpoint.
  signal?.throwIfAborted();
  record.terminals ??= {}; Object.assign(record.terminals, accepted);
  captured.completion = completion(captured, record.terminals, record.firstRunId);
  await writeJson(path.join(record.runDir, 'rc-status/latest.json'), captured);
  signal?.throwIfAborted();
  await fs.appendFile(path.join(record.runDir, 'rc-status/history.jsonl'), JSON.stringify(captured) + '\n');
  signal?.throwIfAborted();
  await saveRunRecord(record);
  return captured;
}
export async function observe(record, rpc, { shouldStop = () => false, readSnapshot = snapshot, policy: overrides,
  startedAt = Date.now(), now = Date.now, wait = pause } = {}) {
  const policy = observationPolicy(record, overrides), softDeadline = startedAt + policy.observerTimeoutMs;
  const deadline = Math.min(softDeadline, record.experimentDeadlineAt ?? Infinity);
  let lastReport = -Infinity, readFailures = 0, uncertainSince = null, current;
  const attention = (reason, extra = {}) => ({ status: 'NEEDS_ATTENTION', reason, host: record.terminals ?? {},
    rc: current?.rc ?? { status: 'UNKNOWN', ended: null }, requiresFreshCheck: true,
    snapshot: current, blockingReasons: current?.completion?.reasons ?? [], observer: { startedAt, endedAt: now(), policy }, ...extra });
  const deadlineReason = () => (record.experimentDeadlineAt ?? Infinity) <= softDeadline ? 'EXPERIMENT_DEADLINE_EXPIRED' : 'OBSERVER_DEADLINE_EXPIRED';
  for (;;) {
    if (shouldStop()) return attention('CONTROLLER_INTERRUPTED');
    if (now() >= deadline) return attention(deadlineReason());
    if (uncertainSince !== null && now() - uncertainSince >= policy.uncertainTimeoutMs)
      return attention('STATE_UNCONFIRMED_TIMEOUT');
    const readStartedAt = now();
    try {
      const uncertaintyRemaining = uncertainSince === null ? Infinity : policy.uncertainTimeoutMs - (readStartedAt - uncertainSince);
      current = await boundedRead(signal => readSnapshot(record, rpc, { signal, policy }), Math.min(deadline - readStartedAt, policy.queryTimeoutMs * 4, uncertaintyRemaining));
      current.completion = completion(current, record.terminals ?? {}, record.firstRunId);
      readFailures = 0;
    } catch (e) {
      if (now() >= deadline) return attention(deadlineReason());
      uncertainSince ??= readStartedAt;
      if (++readFailures >= 3 && !retryableStatusRead(e)) return attention('OBSERVATION_FAILED', { message: String(e.message), queryError: e.code });
      if (now() - uncertainSince >= policy.uncertainTimeoutMs)
        return attention('STATE_UNCONFIRMED_TIMEOUT', { message: String(e.message), queryError: e.code });
      await journal(record, { type: 'STATUS_READ_RETRY', code: e.code, message: String(e.message), attempt: readFailures });
      await wait(Math.min(policy.pollIntervalMs, Math.max(0, deadline - now()), policy.uncertainTimeoutMs - (now() - uncertainSince))); continue;
    }
    if (shouldStop()) return attention('CONTROLLER_INTERRUPTED');
    if (now() >= deadline) return attention(deadlineReason());
    if (now() - lastReport > 30000) {
      console.log(`[${record.id}] RC ${current.rc?.status}/${current.rc?.stage}; ${current.completion.reasons.join(', ') || 'settled'}`);
      lastReport = now();
    }
    if (current.completion.settled) return { status: 'ARCHIVED', host: record.terminals, rc: current.rc, snapshot: current,
      observer: { startedAt, endedAt: now(), policy } };
    const healthyActive = current.rc?.active === true && current.rc?.ended === false
      && ['WAITING', 'RUNNING', 'STOPPING'].includes(current.rc.status)
      && !['UNKNOWN', 'STALE', 'OWNER_EXITED'].includes(current.rc.health)
      && current.rc.refreshConfirmed !== false && current.rc.hostReconciliation !== 'UNKNOWN' && !current.queryErrors?.length;
    if (healthyActive) uncertainSince = null;
    else uncertainSince ??= now();
    if (uncertainSince !== null && now() - uncertainSince >= policy.uncertainTimeoutMs)
      return attention('STATE_UNCONFIRMED_TIMEOUT');
    await wait(Math.min(policy.pollIntervalMs, deadline - now(), uncertainSince === null ? Infinity : policy.uncertainTimeoutMs - (now() - uncertainSince)));
  }
}
export async function confirmAndStop(record, rpc, candidate, { stop, readSnapshot = snapshot, policy = observationPolicy(record), timeoutMs = policy.queryTimeoutMs * 4 } = {}) {
  const fresh = await boundedRead(signal => readSnapshot(record, rpc, { signal, policy }), timeoutMs);
  fresh.completion = completion(fresh, record.terminals ?? {}, record.firstRunId);
  if (!fresh.completion.settled || settlementKey(fresh) !== settlementKey(candidate)) return { closed: false, fresh };
  await stop(record); return { closed: true, fresh };
}
export async function settleAndClose(record, rpc, { stop, onExpired, readSnapshot = snapshot, now = Date.now, ...options } = {}) {
  const startedAt = now(), policy = observationPolicy(record, options.policy);
  for (;;) {
    const result = await observe(record, rpc, { ...options, readSnapshot, now, startedAt });
    if (result.reason === 'EXPERIMENT_DEADLINE_EXPIRED' && onExpired) return onExpired(result.snapshot);
    if (result.status !== 'ARCHIVED') return result;
    let checked;
    try {
      const remaining = Math.min(startedAt + policy.observerTimeoutMs, record.experimentDeadlineAt ?? Infinity) - now();
      if (remaining <= 0) throw error('OBSERVER_DEADLINE_EXPIRED', 'Observer deadline before final check');
      if (options.shouldStop?.()) return { ...result, status: 'NEEDS_ATTENTION', reason: 'CONTROLLER_INTERRUPTED', requiresFreshCheck: true };
      checked = await confirmAndStop(record, rpc, result.snapshot, { stop, readSnapshot, policy, timeoutMs: Math.min(remaining, policy.queryTimeoutMs * 4) });
    } catch (e) {
      if (now() >= (record.experimentDeadlineAt ?? Infinity) && onExpired) return onExpired(result.snapshot);
      return { ...result, status: 'NEEDS_ATTENTION', reason: 'FINAL_CHECK_UNAVAILABLE', requiresFreshCheck: true, message: String(e.message) };
    }
    if (!checked.closed) {
      await journal(record, { type: 'FINAL_GUARD_CHANGED', roundId: checked.fresh.rc?.roundId, reasons: checked.fresh.completion.reasons });
      continue;
    }
    return { ...result, snapshot: checked.fresh, rc: checked.fresh.rc, host: record.terminals };
  }
}
