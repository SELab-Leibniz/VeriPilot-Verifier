// A real RC activity, projected only onto the host's tool-progress UI. MA
// 1.10.1 receives this through session.tool; custom agent streams are filtered
// by its desktop main process. Never emit start/result: those alter tool-use
// blocks or the host's business-tool error summary.
export function createUiProgress({ sdk, parent, id, label, deadlineAt, signal, observeParent = true, isCurrent = () => true }) {
  let closed = false, remove = () => {};
  const current = (allowExpired = false) => !closed && !signal?.aborted && parent.runId && parent.sessionKey
    && Number.isFinite(deadlineAt) && (allowExpired || Date.now() < deadlineAt) && isCurrent();
  const emit = (phase, text, detail = {}, allowExpired = false) => {
    if (!current(allowExpired)) return;
    try {
      sdk.emitAgentEvent({ ...parent, stream: "tool", data: {
        ...detail,
        phase, name: "runtime-corrector.review",
        toolCallId: `runtime-corrector:${parent.runId}:${id}`,
        ...(phase === "end" ? { meta: text } : { partialResult: { views: [{ type: "text", text }] } }),
      } });
    } catch { /* A UI failure must not change review or business execution. */ }
  };
  const close = ({ notify = true, text, allowExpired = false } = {}) => {
    if (closed) return;
    if (notify) emit("end", text ?? "RC 本轮审查已结束；以最终验收结论为准。", {}, allowExpired);
    closed = true;
    remove();
    signal?.removeEventListener("abort", aborted);
  };
  const aborted = () => close({ notify: false });
  signal?.addEventListener("abort", aborted, { once: true });
  remove = (observeParent && sdk.onAgentEvent?.(event => {
    if (event.runId === parent.runId && event.stream === "lifecycle"
      && ["end", "error"].includes(event.data?.phase)) aborted();
  })) || (() => {});
  if (!current()) aborted();
  return {
    get closed() { return closed; },
    update(text = label, detail = {}) {
      if (!current()) { aborted(); return; }
      emit("update", text, detail);
    },
    close,
  };
}
