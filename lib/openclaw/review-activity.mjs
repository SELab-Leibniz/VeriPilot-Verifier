import path from "node:path";

const roleLabels = {
  "onboarding-extractor": "正在提取需求",
  "onboarding-adjudicator": "正在核对需求基线",
  "ground-truth-extractor": "正在更新需求基线",
  "artifact-reviewer": "正在评审文档",
  "stop-reviewer": "正在验收当前成果",
};

export function reviewProgressText(event) {
  const label = roleLabels[event.role] ?? ({ WRITING: "正在修改文件", REVIEWING_ARTIFACT: "正在评审文档" }[event.phase]);
  if (!label) return null;
  return `${label}${event.file ? `：${path.basename(event.file)}` : ""}。`;
}

const STATUS_INTERVAL_MS = 30000;

// Diagnostics preserve real reviewer activity for the host watchdog. MA also
// observes public agent events, but not diagnostic run.progress. A bounded
// status event keeps that observer alive without touching assistant buffers,
// tool results, model messages, or the diagnostic evidence of actual progress.
export function relayNativeReviewActivity({ sdk, parent, runId, role, controller, deadlineAt }) {
  let closed = false, timer, lastActivityAt = null, lastActivityType = null;
  let removeActivity = () => {}, removeEvents = () => {};
  const startedAt = Date.now();
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    removeActivity(); removeEvents();
    controller.signal.removeEventListener("abort", close);
  };
  controller.signal.addEventListener("abort", close, { once: true });
  if (controller.signal.aborted || deadlineAt <= startedAt) { close(); return close; }
  const stop = () => { if (!closed) controller.abort(new Error("OpenClaw parent run ended during review.")); };
  removeActivity = sdk.onRunActivity((event) => {
    if (closed || controller.signal.aborted) return;
    if (event.runId === parent.runId && event.type === "run.completed") { stop(); return; }
    if (event.sessionId === parent.sessionId && event.type === "session.recovery.requested") { stop(); return; }
    if (event.runId !== runId || String(event.reason ?? "").startsWith("runtime-corrector:")) return;
    if (/^(run\.progress|model\.call\.|tool\.execution\.)/u.test(event.type)) {
      lastActivityAt = Date.now(); lastActivityType = event.type;
      sdk.reportProgress(parent, `runtime-corrector:review:${event.type}`);
    }
  });
  removeEvents = sdk.onAgentEvent?.((event) => {
    if (event.runId === parent.runId && event.stream === "lifecycle" && ["end", "error"].includes(event.data?.phase)) stop();
  }) ?? (() => {});
  sdk.reportProgress(parent, "runtime-corrector:review:started");
  const text = reviewProgressText({ role });
  if (text) sdk.emitAgentEvent({ ...parent, stream: "assistant", data: {
    text, replace: true, itemId: `runtime-corrector:review:${parent.runId}`,
  } });
  const status = () => {
    if (closed || controller.signal.aborted) return;
    const now = Date.now();
    if (now >= deadlineAt) { close(); return; }
    // AgentEventStream is publicly extensible. Deliberately omit message/text,
    // role and state: this is observer liveness, not a model reply or terminal.
    sdk.emitAgentEvent({ ...parent, stream: "runtime-corrector.progress", data: {
      reviewRunId: runId, reviewRole: role, phase: "waiting",
      elapsedMs: Math.max(0, now - startedAt), deadlineAt, lastActivityAt, lastActivityType,
    } });
    if (!closed && !controller.signal.aborted) {
      timer = setTimeout(status, Math.min(STATUS_INTERVAL_MS, deadlineAt - now));
      timer.unref?.();
    }
  };
  // A missing/unbounded caller deadline must never create an immortal lease.
  if (Number.isFinite(deadlineAt)) status();
  return close;
}
