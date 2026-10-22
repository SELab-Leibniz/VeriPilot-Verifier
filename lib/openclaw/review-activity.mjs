import path from "node:path";
import { createUiProgress } from "./ui-progress.mjs";

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
  let closed = false, timer, progress, lastActivityAt = null, lastActivityType = null;
  let removeActivity = () => {}, removeEvents = () => {};
  const startedAt = Date.now();
  const close = () => {
    if (closed) return;
    progress?.close({ notify: !controller.signal.aborted && Date.now() < deadlineAt });
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
  progress = createUiProgress({ sdk, parent, id: runId, label: reviewProgressText({ role }) ?? "RC 正在审查。",
    deadlineAt, signal: controller.signal, observeParent: false });
  const status = () => {
    if (closed || controller.signal.aborted) return;
    const now = Date.now();
    if (now >= deadlineAt) { close(); return; }
    progress.update(undefined, {
      reviewRunId: runId, reviewRole: role,
      elapsedMs: Math.max(0, now - startedAt), deadlineAt, lastActivityAt, lastActivityType,
    });
    if (!closed && !controller.signal.aborted) {
      timer = setTimeout(status, Math.min(STATUS_INTERVAL_MS, deadlineAt - now));
      timer.unref?.();
    }
  };
  // A missing/unbounded caller deadline must never create an immortal lease.
  if (Number.isFinite(deadlineAt)) status();
  return close;
}
