// The public terminal owns completion. Diagnostic session.ended events also
// describe intermediate attempts and cannot establish whole-run success.
export async function readBusinessTerminal(request, runId) {
  try {
    const response = await request('agent.wait', { runId, timeoutMs: 1000 });
    const value = response?.result ?? response;
    return { source: 'agent.wait', requestedRunId: runId, runId: value?.runId ?? null,
      status: value?.runId === runId ? value.status : 'identity_mismatch',
      ...(typeof value?.startedAt === 'number' ? { startedAt: value.startedAt } : {}),
      ...(typeof value?.endedAt === 'number' ? { endedAt: value.endedAt } : {}),
      ...(typeof value?.error === 'string' ? { error: value.error } : {}),
      ...(typeof value?.timeoutPhase === 'string' ? { timeoutPhase: value.timeoutPhase } : {}),
      ...(typeof value?.providerStarted === 'boolean' ? { providerStarted: value.providerStarted } : {}) };
  } catch (error) { return { source: 'agent.wait', requestedRunId: runId, runId, status: 'unavailable',
    errorName: error?.name ?? 'Error', ...(typeof error?.code === 'string' ? { errorCode: error.code } : {}) }; }
}
export function knownBusinessTerminal(terminal, runId) {
  return terminal?.source === 'agent.wait' && terminal.runId === runId
    && ['ok', 'error'].includes(terminal.status);
}
export function businessCompleted(terminal, runId) {
  return knownBusinessTerminal(terminal, runId) && terminal.status === 'ok';
}

export function nativeCompactionStart(event, { sessionId, sessionKey }) {
  const prefix = `${sessionId}:compaction:cmp-`;
  return event?.sessionId === sessionId && event.sessionKey === sessionKey
    && typeof event.runId === 'string' && event.runId.startsWith(prefix)
    && /^[A-Za-z0-9_-]+$/u.test(event.runId.slice(prefix.length));
}

// Gateway terminal caches expire independently of a long RC review. Capture
// the real public reply as soon as the business leaves RUNNING and retain it.
// A new business model call or trusted correction invalidates the old reply.
export function createBusinessTerminalObserver({ now = Date.now, pollIntervalMs = 2000 } = {}) {
  let selected, generation, terminal = null, lastPollAt = -Infinity, events = [];
  const key = starts => {
    const last = starts.at(-1);
    return last ? JSON.stringify([last.seq ?? null, last.ts ?? null]) : 'no-business-start';
  };
  return {
    get terminal() { return terminal; },
    drainEvents() { const result = events; events = []; return result; },
    async poll(request, runId, modelStarts, phase, { force = false } = {}) {
      const readStarts = () => (typeof modelStarts === 'function' ? modelStarts() : modelStarts).filter(event => event.runId === runId);
      const starts = readStarts(), next = key(starts);
      if (selected !== runId || generation !== next) {
        if (terminal) events.push({ type: 'invalidated', observedAt: now(), runId: selected,
          reason: selected !== runId ? 'business-run-replaced' : 'new-business-model-call', terminal });
        selected = runId; generation = next; terminal = null; lastPollAt = -Infinity;
      }
      if (terminal) return terminal;
      if (!force && (!phase || phase === 'RUNNING' || now() - lastPollAt < pollIntervalMs)) return null;
      lastPollAt = now();
      const observed = await readBusinessTerminal(request, runId);
      const latest = readStarts();
      if (key(latest) !== generation) {
        events.push({ type: 'stale-reply-rejected', observedAt: now(), runId,
          reason: 'business-model-call-during-query', terminal: observed });
        generation = key(latest); terminal = null; lastPollAt = -Infinity;
        return null;
      }
      const lastStartAt = starts.at(-1)?.ts;
      const stale = typeof lastStartAt === 'number' && typeof observed.endedAt === 'number' && observed.endedAt < lastStartAt;
      events.push({ type: stale ? 'stale-reply-rejected' : 'public-reply', observedAt: now(), runId,
        businessGeneration: generation, phase, terminal: observed });
      if (!stale && knownBusinessTerminal(observed, runId)) terminal = observed;
      return terminal;
    },
  };
}
export function createBusinessRunTracker(originalRunId, sessionId) {
  let selected = originalRunId;
  return {
    get runId() { return selected; },
    observe(record) {
      // Only RC's trusted correction receipt may replace the original ID.
      // A memory/compaction run can have the same session and a later model call.
      if (record?.sessionId === sessionId && typeof record.correctionRunId === 'string' && record.correctionRunId)
        selected = record.correctionRunId;
    },
  };
}
