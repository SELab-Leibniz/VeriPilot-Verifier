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

// Native hooks also await reviewers. Their parent is not a supervised worker,
// so it needs its own scoped relay; otherwise the stock watchdog kills useful
// work while a reviewer is still streaming. Never manufacture timer activity.
export function relayNativeReviewActivity({ sdk, parent, runId, role, controller }) {
  let closed = false;
  const stop = () => { if (!closed) controller.abort(new Error("OpenClaw parent run ended during review.")); };
  const removeActivity = sdk.onRunActivity((event) => {
    if (closed || controller.signal.aborted) return;
    if (event.runId === parent.runId && event.type === "run.completed") { stop(); return; }
    if (event.sessionId === parent.sessionId && event.type === "session.recovery.requested") { stop(); return; }
    if (event.runId !== runId || String(event.reason ?? "").startsWith("runtime-corrector:")) return;
    if (/^(run\.progress|model\.call\.|tool\.execution\.)/u.test(event.type)) {
      sdk.reportProgress(parent, `runtime-corrector:review:${event.type}`);
    }
  });
  const removeEvents = sdk.onAgentEvent?.((event) => {
    if (event.runId === parent.runId && event.stream === "lifecycle" && ["end", "error"].includes(event.data?.phase)) stop();
  });
  sdk.reportProgress(parent, "runtime-corrector:review:started");
  sdk.emitAgentEvent({ ...parent, stream: "assistant", data: {
    text: reviewProgressText({ role }), replace: true,
    itemId: `runtime-corrector:review:${parent.runId}`,
  } });
  return () => { closed = true; removeActivity(); removeEvents?.(); };
}
