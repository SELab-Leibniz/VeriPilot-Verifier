// The public terminal owns completion. Diagnostic session.ended events also
// describe intermediate attempts and cannot establish whole-run success.
export async function readBusinessTerminal(request, runId) {
  try {
    const response = await request('agent.wait', { runId, timeoutMs: 1000 });
    const value = response?.result ?? response;
    return { source: 'agent.wait', requestedRunId: runId, runId: value?.runId ?? null,
      status: value?.runId === runId ? value.status : 'identity_mismatch',
      ...(typeof value?.startedAt === 'number' ? { startedAt: value.startedAt } : {}),
      ...(typeof value?.endedAt === 'number' ? { endedAt: value.endedAt } : {}) };
  } catch { return { source: 'agent.wait', requestedRunId: runId, runId, status: 'unavailable' }; }
}
export function knownBusinessTerminal(terminal, runId) {
  return terminal?.source === 'agent.wait' && terminal.runId === runId
    && ['ok', 'error'].includes(terminal.status);
}
export function businessCompleted(terminal, runId) {
  return knownBusinessTerminal(terminal, runId) && terminal.status === 'ok';
}
export function latestBusinessRunId(modelStarts, sessionId, fallback) {
  return modelStarts.filter(event => event.sessionId === sessionId && typeof event.runId === 'string').at(-1)?.runId ?? fallback;
}
