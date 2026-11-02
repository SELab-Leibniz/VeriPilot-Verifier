// Both arms use authenticated host terminals. Durable RC scheduling state is
// read-only and cannot replace actual agent.wait receipts.
const fail = code => Object.assign(new Error(code), { code });
const sameSnapshot = (view, persisted) => Number.isSafeInteger(view.version) && view.version === persisted.version
  && view.phase === persisted.phase && view.reviewStatus === persisted.reviewStatus;

export function harborGatewayErrorDiagnostic(error) {
  const names = ['GatewayTransportError', 'AbortError', 'TimeoutError', 'Error', 'TypeError', 'SyntaxError', 'RangeError'];
  return { name: names.includes(error?.name) ? error.name : 'OtherError',
    ...(['timeout', 'closed'].includes(error?.kind) ? { kind: error.kind } : {}),
    ...(Number.isSafeInteger(error?.timeoutMs) && error.timeoutMs > 0 ? { timeoutMs: error.timeoutMs } : {}),
    ...(typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/u.test(error.code)
      || Number.isSafeInteger(error?.code) ? { code: error.code } : {}) };
}
const isWaitTransportTimeout = error => error instanceof Error && error.name === 'GatewayTransportError'
  && error.kind === 'timeout' && Number.isSafeInteger(error.timeoutMs) && error.timeoutMs > 0;
const cleanupError = (runId, fallbackCode, error) => {
  const diagnostic = harborGatewayErrorDiagnostic(error);
  return { runId, code: typeof diagnostic.code === 'string' ? diagnostic.code : fallbackCode, diagnostic };
};
const cleanupTerminal = value => ({ runId: value.runId, status: value.status,
  ...(Number.isSafeInteger(value.startedAt) ? { startedAt: value.startedAt } : {}),
  ...(Number.isSafeInteger(value.endedAt) ? { endedAt: value.endedAt } : {}),
  ...(['rpc', 'stop', 'error', 'timeout', 'aborted', 'length', 'toolUse'].includes(value.stopReason) ? { stopReason: value.stopReason } : {}) });

export async function awaitHarborGatewaySettlement({ request, originalRunId, sessionId, sessionKey, projectRoot,
  rcEnabled, deadlineAt, signal, readPersistentDispatch, now = Date.now, cleanupMs = 10000,
  pause = ms => new Promise(resolve => setTimeout(resolve, ms)), onObservation = async () => {} }) {
  const terminal = new Map(), owned = new Set([originalRunId]); let lastIdentity;
  if (!originalRunId || !Number.isSafeInteger(deadlineAt) || !Number.isSafeInteger(cleanupMs) || cleanupMs < 1 || cleanupMs > 30000)
    throw fail('HARBOR_SETTLEMENT_ARGUMENTS_INVALID');
  const check = () => { signal?.throwIfAborted(); if (now() >= deadlineAt) throw fail('HARBOR_TASK_WALL_LIMIT'); };
  const waitRun = async (runId, until = deadlineAt, cleaning = false) => {
    if (!cleaning) check();
    const remaining = Math.max(1, until - now());
    let result;
    try { result = await request('agent.wait', { runId, timeoutMs: Math.min(1000, remaining) }, { timeoutMs: Math.min(2000, remaining) }); }
    catch (error) {
      // A typed observation timeout says nothing about the owned task's terminal.
      if (cleaning || !isWaitTransportTimeout(error)) throw error;
      await onObservation({ waitTransportTimeout: true, runId, diagnostic: harborGatewayErrorDiagnostic(error) });
      check();
      return false;
    }
    const value = result?.result ?? result;
    if (value?.runId !== runId) throw fail('HARBOR_TERMINAL_IDENTITY_MISMATCH');
    if (!['ok', 'error', 'timeout'].includes(value.status)) throw fail('HARBOR_TERMINAL_UNKNOWN');
    if (value.status !== 'timeout') terminal.set(runId, value);
    if (value.status === 'error' && !cleaning) throw fail('HARBOR_BUSINESS_RUN_FAILED');
    return value.status !== 'timeout';
  };
  const cleanup = async () => {
    const until = now() + cleanupMs, aborted = [], errors = [];
    for (const runId of owned) if (!terminal.has(runId)) {
      try { await request('chat.abort', { sessionKey, runId }, { timeoutMs: Math.max(1, Math.min(2000, until - now())) }); aborted.push(runId); }
      catch (error) { errors.push(cleanupError(runId, 'CANCEL_REQUEST_FAILED', error)); }
    }
    while (now() < until && [...owned].some(runId => !terminal.has(runId))) {
      for (const runId of owned) if (!terminal.has(runId) && now() < until) {
        try { await waitRun(runId, until, true); }
        catch (error) { errors.push(cleanupError(runId, 'TERMINAL_READ_FAILED', error)); }
      }
      if ([...owned].some(runId => !terminal.has(runId))) await pause(Math.min(50, Math.max(0, until - now())));
    }
    const unconfirmed = [...owned].filter(runId => !terminal.has(runId));
    return { cancelledExactRunIds: aborted, terminals: [...terminal.values()].map(cleanupTerminal), unconfirmed, complete: unconfirmed.length === 0, errors,
      note: 'Cleanup only cancels/reads already-owned runs; it never renews the task deadline or starts business/model work.' };
  };
  const validateIdentity = (value, identity) => {
    if (!value || ['id', 'agentId', 'sessionId', 'sessionKey', 'scopeFingerprint'].some(key => value[key] !== identity[key])
      || value.projectRoot !== projectRoot) throw fail('HARBOR_DISPATCH_SCOPE_CHANGED');
  };
  try {
    while (!await waitRun(originalRunId)) { check(); await pause(50); }
    if (!rcEnabled) { check(); return { complete: true, mode: 'rc-off', originalRunId, terminals: [...terminal.values()], rcSettlement: 'disabled' }; }
    if (typeof readPersistentDispatch !== 'function') throw fail('HARBOR_RC_COMPLETION_READER_REQUIRED');
    while (true) {
      check();
      const page = await request('runtime-corrector.dispatch.list', { offset: 0, limit: 100, filter: 'all' });
      const rows = Array.isArray(page) ? page : page?.items ?? page?.sessions;
      if (!Array.isArray(rows)) throw fail('HARBOR_DISPATCH_LIST_INVALID');
      const matches = rows.filter(row => row.sessionId === sessionId && row.sessionKey === sessionKey && row.projectRoot === projectRoot);
      if (matches.length > 1) throw fail('HARBOR_DISPATCH_SCOPE_AMBIGUOUS');
      const row = matches[0];
      if (row) {
        const identity = { id: row.id, agentId: row.agentId, sessionId, sessionKey, scopeFingerprint: row.scopeFingerprint };
        if (lastIdentity && JSON.stringify(identity) !== lastIdentity) throw fail('HARBOR_DISPATCH_SCOPE_CHANGED');
        lastIdentity = JSON.stringify(identity);
        const view = await request('runtime-corrector.dispatch.get', identity), persisted = await readPersistentDispatch(identity);
        validateIdentity(view, identity); validateIdentity(persisted, identity);
        if (!sameSnapshot(view, persisted)) { await onObservation({ inconsistentSnapshot: true, publicVersion: view.version, persistentVersion: persisted.version }); await pause(100); continue; }
        for (const runId of new Set([...(persisted.completedRuns ?? []), persisted.runId, persisted.correctionRunId].filter(Boolean))) {
          owned.add(runId); if (!terminal.has(runId)) await waitRun(runId);
        }
        await onObservation({ phase: view.phase, reviewStatus: view.reviewStatus, version: view.version,
          completedRuns: persisted.completedRuns, pending: view.pending?.length ?? null, terminals: [...terminal.keys()] });
        if (view.phase === 'CLOSED') throw fail('HARBOR_RC_DISPATCH_CLOSED');
        if (view.phase === 'IDLE' && Array.isArray(view.pending) && view.pending.length === 0
          && Array.isArray(persisted.pending) && persisted.pending.length === 0 && !view.dispatching && !persisted.dispatching
          && [...owned].every(runId => persisted.completedRuns?.includes(runId) && terminal.get(runId)?.status === 'ok')) {
          const finalView = await request('runtime-corrector.dispatch.get', identity), finalPersisted = await readPersistentDispatch(identity);
          validateIdentity(finalView, identity); validateIdentity(finalPersisted, identity);
          if (!sameSnapshot(finalView, finalPersisted) || finalView.version !== view.version) { await pause(100); continue; }
          check();
          return { complete: true, mode: 'rc-on', originalRunId, terminals: [...terminal.values()], dispatch: {
            ...identity, phase: view.phase, reviewStatus: view.reviewStatus, completedRuns: persisted.completedRuns, pending: 0, version: view.version },
            semanticAccepted: null };
        }
      }
      await pause(100);
    }
  } catch (error) { error.cleanup = await cleanup(); throw error; }
}
