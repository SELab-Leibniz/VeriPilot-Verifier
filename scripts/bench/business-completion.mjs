import { createHash } from 'node:crypto';

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
  return typeof runId === 'string' && runId.length > 0 && terminal?.source === 'agent.wait' && terminal.runId === runId
    && ['ok', 'error'].includes(terminal.status);
}
export function businessCompleted(terminal, runId) {
  return knownBusinessTerminal(terminal, runId) && terminal.status === 'ok';
}

// The active retained branch must end in the exact stream error. The leaf
// may hold a short text fragment. All invocations must already have results.
export function retainedBusinessTransportError(records, { runId, sessionId }) {
  if (!runId || !sessionId || records[0]?.type !== 'session' || records[0]?.id !== sessionId) return null;
  const entries = records.slice(1).filter(row => row?.id);
  const byId = new Map(entries.map(row => [row.id, row]));
  const leaf = entries.at(-1), message = leaf?.message;
  const startedAt = message?.timestamp, persistedAt = Date.parse(leaf?.timestamp);
  const content = message?.content;
  const fragment = Array.isArray(content) && content.length === 1 ? content[0] : null;
  const retainedTextBytes = fragment?.type === 'text' && typeof fragment.text === 'string'
    && Object.keys(fragment).every(key => key === 'type' || key === 'text') ? Buffer.byteLength(fragment.text) : null;
  if (byId.size !== entries.length || leaf?.type !== 'message' || message?.role !== 'assistant'
    || message.stopReason !== 'error' || message.errorMessage !== 'terminated'
    || !Array.isArray(content) || content.length > 0 && (retainedTextBytes === null || retainedTextBytes > 1024)
    || message.usage?.totalTokens !== 0
    || !Number.isFinite(startedAt) || !Number.isFinite(persistedAt) || persistedAt < startedAt) return null;
  const results = new Map(), seen = new Set([leaf.id]);
  for (let row = byId.get(leaf.parentId); row && !seen.has(row.id); row = byId.get(row.parentId)) {
    seen.add(row.id);
    const value = row.message;
    if (value?.role === 'user') {
      if (value.idempotencyKey !== `${runId}:user` || results.size) return null;
      return { messageId: leaf.id, messageSha256: createHash('sha256').update(JSON.stringify(message)).digest('hex'),
        startedAt, persistedAt, failureKind: 'terminated', ...(retainedTextBytes ? { retainedTextBytes } : {}) };
    }
    if (value?.role === 'toolResult') {
      if (!value.toolCallId || !value.toolName || results.has(value.toolCallId)) return null;
      results.set(value.toolCallId, value.toolName);
    } else if (value?.role === 'assistant') {
      for (const call of value.content?.filter?.(block => block.type === 'toolCall') ?? []) {
        if (!call.id || !call.name || results.get(call.id) !== call.name) return null;
        results.delete(call.id);
      }
    }
  }
  return null;
}

export function pairedBusinessWorkflowFailure(final, openSpec) {
  if (!final?.settled || !knownBusinessTerminal(final.terminal, final.finalRunId)) return 'OPENCLAW_BUSINESS_UNSETTLED';
  if (final.terminal.status === 'error') return 'OPENCLAW_BUSINESS_TERMINAL_ERROR';
  if (openSpec.proposal?.readyToApply !== true) return 'OPENSPEC_PLAN_NOT_READY';
  if (openSpec.applyChecklistPreserved === false) return 'OPENSPEC_APPLY_CHECKLIST_CHANGED';
  if (openSpec.applyChecklistPreserved !== true) return 'OPENSPEC_APPLY_PROGRESS_UNVERIFIED';
  if (openSpec.applyChecklistCorrection && openSpec.applyChecklistCorrection.verified !== true) return 'OPENSPEC_APPLY_CHECKLIST_RECOVERY_UNVERIFIED';
  if (openSpec.applyWorkflowScope?.status === 'CHANGED') return 'OPENSPEC_APPLY_WORKFLOW_CHANGED';
  if (Object.hasOwn(openSpec, 'applyWorkflowScope') && openSpec.applyWorkflowScope?.status !== 'PRESERVED')
    return 'OPENSPEC_APPLY_WORKFLOW_UNVERIFIED';
  if (openSpec.codeing?.applyComplete === true) return null;
  return openSpec.codeing?.readyToApply === true ? 'OPENSPEC_APPLY_INCOMPLETE' : 'OPENSPEC_APPLY_PROGRESS_UNVERIFIED';
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
