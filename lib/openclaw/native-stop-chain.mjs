// A bounded, session-scoped wait across native correction runs. Assessments
// retain their own receipts/deadlines; this gate never executes business work.
export function createNativeStopChains(chains = new Map(), runOwners = new Map()) {
  const key = state => JSON.stringify([state.projectRoot, state.sessionKey, state.sessionId]);
  const runKey = (state, runId) => JSON.stringify([state.sessionKey, state.sessionId, runId]);
  return {
    get(state) { return chains.get(key(state)); },
    owner(state, runId) { return runId ? runOwners.get(runKey(state, runId)) : undefined; },
    begin({ state, runId, taskId, budgetMs, onCancel, onSettled, onPhase }) {
      let chain = chains.get(key(state));
      if (chain?.runs.has(runId)) {
        chain.enter(runId, "REVIEWING");
        return chain;
      }
      chain?.cancel("RC_STOP_CHAIN_SUPERSEDED");
      const record = { sessionId: state.sessionId, sessionKey: state.sessionKey, taskId,
        rootRunId: runId, runId, phase: "REVIEWING", status: "WAITING", createdAt: Date.now(),
        deadlineAt: Date.now() + budgetMs, budgetMs };
      let release, closed = false, cleanup;
      const released = new Promise(resolve => { release = resolve; });
      const phase = value => {
        if (record.phase === value) return;
        record.phase = value;
        void Promise.resolve().then(() => onPhase?.(structuredClone(record))).catch(() => {});
      };
      const settle = result => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        Object.assign(record, result, { status: "SETTLED", settledAt: Date.now() });
        const snapshot = structuredClone(record);
        release(snapshot);
        void Promise.resolve().then(() => onSettled?.(snapshot)).catch(() => {});
      };
      chain = {
        record, runs: new Set([runId]), released,
        get pending() { return !closed; },
        get cleanup() { return cleanup; },
        isStale(ownedRunId) {
          return closed || [...this.runs].indexOf(ownedRunId) < [...this.runs].indexOf(record.runId);
        },
        // Called before native admission; only a durable RC receipt may link a child.
        link(parentRunId, receipt) {
          if (closed || receipt.taskId !== taskId || parentRunId !== record.runId) return;
          this.runs.add(receipt.runId);
          runOwners.set(runKey(state, receipt.runId), this);
        },
        enter(nextRunId, nextPhase = "CORRECTING") {
          if (closed || !this.runs.has(nextRunId)) return;
          const ordered = [...this.runs];
          if (ordered.indexOf(nextRunId) < ordered.indexOf(record.runId)) return;
          record.runId = nextRunId;
          phase(nextPhase);
        },
        assessed(result) {
          if (closed || result.runId !== record.runId) return;
          if ((result.reviewStatus === "DEVIATION" || result.feedbackOnly) && result.followupStatus === "ADMITTED") {
            phase(result.feedbackOnly ? "REVIEWING" : "CORRECTING");
            return;
          }
          settle({ reviewStatus: result.reviewStatus, evaluationId: result.evaluationId,
            ...(result.verificationFeedback ? { verificationFeedback: result.verificationFeedback } : {}),
            ...(result.followupStatus ? { followupStatus: result.followupStatus } : {}),
            ...(result.reasonCode ? { reasonCode: result.reasonCode } : result.reviewStatus === "DEVIATION"
              ? { reasonCode: "STOP_NOT_PASS" } : {}) });
        },
        cancel(reasonCode = "RC_STOP_CANCELLED") {
          if (closed) return;
          settle({ reviewStatus: "CANCELLED", reasonCode });
          cleanup = Promise.resolve().then(() => onCancel?.(reasonCode)).catch(() => {});
        },
        expire() {
          if (closed) return;
          settle({ reviewStatus: "UNVERIFIED", reasonCode: "STOP_WAIT_DEADLINE_EXPIRED" });
          cleanup = Promise.resolve().then(() => onCancel?.("STOP_WAIT_DEADLINE_EXPIRED")).catch(() => {});
        },
      };
      const timer = setTimeout(() => chain.expire(), Math.max(1, record.deadlineAt - Date.now()));
      timer.unref?.();
      chains.set(key(state), chain);
      runOwners.set(runKey(state, runId), chain);
      return chain;
    },
    link(state, receipt) { chains.get(key(state))?.link(state.nativeRunId, receipt); },
    cancel(state, reasonCode) { chains.get(key(state))?.cancel(reasonCode); },
    forget(state) {
      const chain = chains.get(key(state));
      if (!chain) return;
      chains.delete(key(state));
      for (const runId of chain.runs) if (runOwners.get(runKey(state, runId)) === chain) runOwners.delete(runKey(state, runId));
    },
  };
}
