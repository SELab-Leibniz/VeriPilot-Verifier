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

export async function waitForObservation(operation, timeoutMs) {
  let timer;
  try {
    return await Promise.race([operation.then(() => true),
      new Promise(resolve => { timer = setTimeout(resolve, Math.max(1, timeoutMs), false); })]);
  } finally { clearTimeout(timer); }
}

export function lastContextOverflow(transcript) {
  const text = transcript.trimEnd();
  try {
    const row = JSON.parse(text.slice(text.lastIndexOf('\n') + 1));
    const message = row.message;
    return message?.role === 'assistant' && message.stopReason === 'error'
      && /^Context overflow:/iu.test(message.errorMessage ?? '') ? Date.parse(row.timestamp) : NaN;
  } catch { return NaN; }
}

// An escalated post-run record can precede successful same-run compaction.
// Require fresh exact-run wait replies throughout a quiet recovery window.
export function createBusinessStallObserver({ readTranscript, now = Date.now, graceMs = 300_000 } = {}) {
  let quiet = null;
  return async ({ sessionId, runId, post, reply, modelStartAt, requestCount, activeRequests, diagnosticsDrained }) => {
    if (!diagnosticsDrained || !post || post.sessionId !== sessionId || post.runId !== runId || post.phase !== 'FINALIZING'
      || post.reconciliation?.runId !== runId || post.reconciliation.status !== 'UNKNOWN'
      || !Number.isFinite(post.reconciliation.escalatedAt) || Number.isFinite(post.candidate?.terminalConfirmedAt)
      || activeRequests !== 0 || !Number.isSafeInteger(requestCount) || requestCount < 1) {
      quiet = null;
      return null;
    }
    if (!reply) return null; // The terminal observer throttles its polls.
    const terminal = reply.terminal;
    if (reply.type !== 'public-reply' || reply.runId !== runId || terminal?.source !== 'agent.wait'
      || terminal.requestedRunId !== runId || terminal.runId !== runId || terminal.status !== 'timeout'
      || terminal.timeoutPhase !== 'gateway_draining') {
      quiet = null;
      return null;
    }
    const overflowAt = lastContextOverflow(await readTranscript());
    if (!Number.isFinite(modelStartAt) || !Number.isFinite(overflowAt) || overflowAt < modelStartAt) {
      quiet = null;
      return null;
    }
    const key = JSON.stringify([sessionId, runId, post.reconciliation.escalatedAt, modelStartAt, requestCount, overflowAt]);
    const at = now();
    if (quiet?.key !== key || at - quiet.lastReplyAt > 60_000) quiet = { key, since: at };
    quiet.lastReplyAt = at;
    if (at - quiet.since < graceMs) return null;
    return { reason: 'BUSINESS_TERMINAL_UNCONFIRMED', runId, overflowAt, quietSince: quiet.since,
      observedAt: at, escalatedAt: post.reconciliation.escalatedAt, terminal };
  };
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
