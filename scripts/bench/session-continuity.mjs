// Isolated benchmark sessions must preserve their genuine history across the
// host's default daily boundary. Idle mode without an idle limit disables both
// reset clocks; it does not rewrite transcript or lifecycle timestamps.
export const EXPERIMENT_SESSION_RESET = Object.freeze({ mode: 'idle' });

export function assertBusinessSessionIdentity({ sessionId, sessionKey, runId }, entry, modelStarts) {
  const starts = modelStarts.filter(event => event.runId === runId);
  if (entry?.sessionId === sessionId && starts.every(event => event.sessionId === sessionId)) return;
  const error = new Error('Native business session identity changed; refusing to accept a replacement history.');
  error.code = 'ARKTS_SESSION_IDENTITY_DRIFT';
  error.evidence = { sessionId, sessionKey, runId, actualSessionId: entry?.sessionId ?? null,
    actualBusinessStart: starts.some(event => event.sessionId === sessionId),
    unexpectedBusinessStart: starts.some(event => event.sessionId !== sessionId),
    observedStarts: starts };
  throw error;
}
