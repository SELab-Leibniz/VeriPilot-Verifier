// These are transport-byte limits, not token estimates. Native compaction stays
// in charge of model context; this independent guard bounds repeated retrieval
// even when compaction would otherwise let one short review keep reading.
export const REVIEWER_CONTEXT_LIMITS = Object.freeze({
  maxBytes: 128 * 1024,
  maxResultBytes: 32 * 1024,
  maxToolCalls: 64,
  systemReserve: 8192,
  outputReserve: 16384,
});

const positive = value => Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
const byteLength = value => Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value) ?? "", "utf8");
export const isReviewerContextBudgetError = error => error?.code === "REVIEWER_CONTEXT_BUDGET";

export function createReviewerContextGuard({ controller, limits = REVIEWER_CONTEXT_LIMITS } = {}) {
  const budget = { ...REVIEWER_CONTEXT_LIMITS, ...limits };
  let maxBytes = budget.maxBytes, usedBytes = 0, toolCalls = 0, failure = null;
  function stop(reason) {
    failure ??= Object.assign(new Error(`REVIEWER_CONTEXT_BUDGET: ${reason}; bytes=${usedBytes}/${maxBytes}; calls=${toolCalls}/${budget.maxToolCalls}. Unchecked objects remain UNVERIFIED.`),
      { code: "REVIEWER_CONTEXT_BUDGET", reviewerRuntimeFailure: true });
    controller?.abort(failure);
    throw failure;
  }
  function check() {
    if (failure) throw failure;
    if (usedBytes > maxBytes) stop("cumulative retrieval allowance exhausted");
    if (toolCalls > budget.maxToolCalls) stop("tool-call allowance exhausted");
  }
  function consume(value) {
    check();
    let size;
    try { size = byteLength(value); } catch { stop("unmeasurable retrieval payload"); }
    usedBytes += size;
    check();
    return size;
  }
  return {
    // Only caller-owned cloned config is inspected. Known model context/output
    // sizes can tighten the byte allowance with a conservative 1 byte : 1 token
    // planning margin. This is not a tokenizer or a precise total-token bound;
    // hidden system text, reasoning and provider framing remain host-owned.
    configure(config, provider, model) {
      const providerConfig = Object.entries(config?.models?.providers ?? {}).find(([id]) => id.toLowerCase() === String(provider).toLowerCase())?.[1];
      const entry = providerConfig?.models?.find(item => item.id === model || item.id === `${provider}/${model}`);
      const declared = positive(entry?.contextTokens) ?? positive(entry?.contextWindow);
      const cap = positive(config?.agents?.defaults?.contextTokens);
      const context = declared && cap ? Math.min(declared, cap) : declared ?? cap;
      if (context) maxBytes = Math.min(maxBytes, Math.max(0, context - Math.max(budget.outputReserve, positive(entry?.maxTokens) ?? 0) - budget.systemReserve));
      check();
    },
    prompt(text) { consume(text); },
    observe(name, value) {
      check();
      if (name === "read:result") {
        const result = value?.result;
        let size;
        try { size = byteLength(result); } catch { stop("unmeasurable tool result"); }
        // Reject the complete result before a model sees it. Never append its
        // contents to a diagnostic or silently truncate evidence into a pass.
        if (size > budget.maxResultBytes) stop(`single result exceeds ${budget.maxResultBytes} bytes`);
        consume(result);
      } else {
        toolCalls++;
        check();
        consume({ name, args: value });
      }
    },
    get state() { return { usedBytes, maxBytes, toolCalls, maxResultBytes: budget.maxResultBytes, maxToolCalls: budget.maxToolCalls }; },
  };
}
