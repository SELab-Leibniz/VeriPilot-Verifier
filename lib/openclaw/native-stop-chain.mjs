import { scheduleStopDeadline } from "../runtime-v2/stop-deadline.mjs";

// Each Stop owns an admission window. A confirmed business repair has no
// review timer; its next Stop starts a fresh window on the same waiting chain.
export function createNativeStopChains(chains = new Map(), runOwners = new Map()) {
  const key = state => JSON.stringify([state.projectRoot, state.sessionKey, state.sessionId]);
  const runKey = (state, runId) => JSON.stringify([state.sessionKey, state.sessionId, runId]);
  return {
    get(state) { return chains.get(key(state)); },
    owner(state, runId) { return runId ? runOwners.get(runKey(state, runId)) : undefined; },
    begin({ state, runId, taskId, budgetMs, onCancel, onSettled, onPhase }) {
      let chain = chains.get(key(state));
      if (chain?.runs.has(runId)) {
        chain.review(runId, budgetMs);
        return chain;
      }
      chain?.cancel("RC_STOP_CHAIN_SUPERSEDED");
      const record = { sessionId: state.sessionId, sessionKey: state.sessionKey, taskId,
        rootRunId: runId, runId, phase: "REVIEWING", status: "WAITING", createdAt: Date.now(),
        deadlineAt: Date.now() + budgetMs, budgetMs };
      let release, closed = false, cleanup, cancelTimer;
      const released = new Promise(resolve => { release = resolve; });
      const phase = value => {
        if (record.phase === value) return;
        record.phase = value;
        void Promise.resolve().then(() => onPhase?.(structuredClone(record))).catch(() => {});
      };
      const settle = result => {
        if (closed) return;
        closed = true;
        cancelTimer?.();
        Object.assign(record, result, { status: "SETTLED", settledAt: Date.now() });
        const snapshot = structuredClone(record);
        release(snapshot);
        void Promise.resolve().then(() => onSettled?.(snapshot)).catch(() => {});
      };
      chain = {
        record, runs: new Set([runId]), released, reviewedRuns: new Set([runId]), startedRuns: new Set(),
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
        enter(nextRunId, nextPhase = this.startedRuns.has(nextRunId) ? "CORRECTING" : "WAIT_START") {
          if (closed || !this.runs.has(nextRunId)) return;
          const ordered = [...this.runs];
          if (ordered.indexOf(nextRunId) < ordered.indexOf(record.runId)) return;
          record.runId = nextRunId;
          phase(nextPhase);
        },
        review(nextRunId, nextBudgetMs) {
          if (closed || !this.runs.has(nextRunId) || this.isStale(nextRunId)) return;
          if (!this.reviewedRuns.has(nextRunId)) {
            this.reviewedRuns.add(nextRunId);
            record.budgetMs = nextBudgetMs;
            record.deadlineAt = Date.now() + nextBudgetMs;
            cancelTimer?.();
            cancelTimer = scheduleStopDeadline(() => this.expire(), record.deadlineAt);
          }
          this.enter(nextRunId, "REVIEWING");
        },
        // Call only after the session ledger accepts a trusted actual-start
        // fact. API acceptance and a user-role transcript record are insufficient.
        observeStart(nextRunId) {
          if (closed || !this.runs.has(nextRunId) || this.isStale(nextRunId) || this.reviewedRuns.has(nextRunId)) return;
          this.startedRuns.add(nextRunId);
          cancelTimer?.();
          record.deadlineAt = null;
          this.enter(nextRunId, "CORRECTING");
        },
        assessed(result) {
          if (closed || result.runId !== record.runId) return;
          if ((result.reviewStatus === "DEVIATION" || result.feedbackOnly)
            && ["ADMITTED", "QUEUED", "UNKNOWN", "STARTED"].includes(result.followupStatus)) {
            // Queue acknowledgement retains the current admission cutoff.
            // Only observeStart can end that timer.
            if (record.phase !== "CORRECTING") phase("WAIT_START");
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
      cancelTimer = scheduleStopDeadline(() => chain.expire(), record.deadlineAt);
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
