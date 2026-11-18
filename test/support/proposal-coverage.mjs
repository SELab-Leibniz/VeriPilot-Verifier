// Model the host finalizer separately from the reviewer's coverage metadata.
export function publishProposalCoverage(record, state, file, receipt, overrides = {}) {
  const { result, ...owner } = overrides;
  record(state, file, receipt, {
    runId: receipt?.runId ?? state.nativeRunId,
    taskId: receipt?.taskId ?? state.scopeTaskId,
    sessionId: receipt?.sessionId ?? state.sessionId,
    ...owner,
    result: result ?? { status: 'passed', diagnostics: [],
      metadata: { inputs: receipt?.scope, semanticReview: { status: 'completed' } } },
  });
}
