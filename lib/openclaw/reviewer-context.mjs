// Native compaction owns model context. This guard bounds each tool result,
// without a cumulative byte or tool-call cap.
export const REVIEWER_CONTEXT_LIMITS = Object.freeze({
  maxResultBytes: 32 * 1024,
});

const byteLength = value => Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value) ?? "", "utf8");
export const isReviewerContextBudgetError = error => error?.code === "REVIEWER_CONTEXT_BUDGET";

export function createReviewerContextGuard({ controller, limits = REVIEWER_CONTEXT_LIMITS } = {}) {
  const budget = { ...REVIEWER_CONTEXT_LIMITS, ...limits };
  let toolCalls = 0, failure = null;
  function stop(reason) {
    failure ??= Object.assign(new Error(`REVIEWER_CONTEXT_BUDGET: ${reason}; calls=${toolCalls}. Unchecked objects remain UNVERIFIED.`),
      { code: "REVIEWER_CONTEXT_BUDGET", reviewerRuntimeFailure: true });
    controller?.abort(failure);
    throw failure;
  }
  return {
    observe(name, value) {
      if (failure) throw failure;
      if (name === "read:result") {
        const result = value?.result;
        let size;
        try { size = byteLength(result); } catch { stop("unmeasurable tool result"); }
        // Reject the complete result before a model sees it. Never append its
        // contents to a diagnostic or silently truncate evidence into a pass.
        if (size > budget.maxResultBytes) stop(`single result exceeds ${budget.maxResultBytes} bytes`);
      } else {
        toolCalls++;
      }
    },
    get state() { return { toolCalls, maxResultBytes: budget.maxResultBytes }; },
  };
}
