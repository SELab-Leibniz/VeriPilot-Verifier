import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createUiProgress } from "./ui-progress.mjs";
import { boundHostFeedback } from "../runtime-v2/feedback-delivery.mjs";

export function stopWaitText(record) {
  const summary = stopWaitSummary(record);
  return record.verificationFeedback && !["CANCELLED", "PASS"].includes(record.reviewStatus)
    ? boundHostFeedback(record.verificationFeedback, { prefix: summary }) : summary;
}

function stopWaitSummary(record) {
  if (record.reasonCode === "SESSION_CORRECTION_LIMIT") return "会话业务纠偏额度已用完，本次未自动审查，已解除等待；不生成验收通过。";
  if (record.reasonCode === "FLOW_CORRECTION_LIMIT") return "当前流程业务纠偏次数已达上限，本次未自动审查，已解除等待；不生成验收通过。";
  if (["SESSION_ADMISSION_PENDING", "FLOW_ADMISSION_PENDING"].includes(record.reasonCode)) return "RC 可用名额被未决启动占用，尚未计为已用；本次未自动审查，已解除等待。";
  if (record.reasonCode === "HOST_START_PROTOCOL_UNSUPPORTED") return "RC 发现偏差，但当前适配尚未接通可信启动协议；未启动自动纠偏，已解除等待，本次不算验收通过。";
  if (record.reasonCode === "STOP_SESSION_MIGRATION_REQUIRED") return "RC 会话额度历史尚待迁移核对，本次未启动自动审查，已解除等待；不生成验收通过结论。";
  if (record.reasonCode === "STOP_WAIT_DEADLINE_EXPIRED") return "RC 等待修正与复验超时，已解除等待；本次结果未通过完整验收。";
  if (record.reasonCode === "CORRECTION_BUDGET_EXHAUSTED") return "RC 已用完配置的纠偏次数，仍未通过验收；已解除等待，允许后续任务继续。";
  if (record.reasonCode === "REVIEW_DEADLINE_EXPIRED") return "RC 验收超时，已解除等待；本次结果未通过完整验收。";
  if (record.reasonCode === "RC_STOP_KEEPALIVE_UNAVAILABLE") return "RC 宿主保活通知失败，已解除等待；本次验收未验证。";
  if (record.reviewStatus === "PASS") return "RC 验收通过，已解除等待。";
  if (record.reviewStatus === "DISABLED") return "RC Stop 审查已按项目配置关闭，已解除等待；本次不生成验收通过结论。";
  if (record.reviewStatus === "DEVIATION") {
    if (["ADMITTED", "FINISHED"].includes(record.followupStatus)) return "RC 发现偏差，纠偏反馈已交给宿主；本轮评审等待已结束。";
    if (record.followupStatus === "REJECTED") return "RC 发现偏差，但宿主拒绝了纠偏反馈；已解除等待，本次结果未通过验收。";
    return "RC 发现偏差；纠偏反馈尚未确认交给宿主，已解除等待，本次结果未通过验收。";
  }
  if (record.reviewStatus === "CANCELLED") return "RC 验收已取消，已解除等待；本次结果未验证。";
  return "RC 验收未能完成，已解除等待；本次结果未验证。";
}

// UI events only: never append messages to the host transcript or prompt.
// Keep post-run background review separate from a live caller waiting at a gate.
export function createStopWaitStatus(api, compatibility) {
  let pending;
  const runs = new WeakMap();
  const load = () => pending ??= (async () => {
    if (compatibility) return compatibility();
    if (!["2026.7.1-2", "2026.10.3"].includes(api.runtime.version)) return null;
    let file;
    try { file = createRequire(import.meta.url).resolve("openclaw/package.json"); }
    catch { file = path.join(path.dirname(await fs.realpath(process.argv[1])), "package.json"); }
    const pkg = JSON.parse(await fs.readFile(file, "utf8"));
    if (pkg.version !== api.runtime.version || pkg.name !== "openclaw") return null;
    const sdkRoot = path.join(path.dirname(file), "dist/plugin-sdk");
    const [harness, diagnostics] = await Promise.all([
      import(pathToFileURL(path.join(sdkRoot, "agent-harness.js"))),
      import(pathToFileURL(path.join(sdkRoot, "text-runtime.js"))).catch(() => ({})),
    ]);
    return { ...harness, markDiagnosticSessionProgress: diagnostics.markDiagnosticSessionProgress };
  })();
  const publish = async ({ state, runId, text, phase, deadlineAt, signal, waiting = false, progressId = "stop-wait", isCurrent = () => true }) => {
    // Background post-run reviews do not own a live business run. Only a
    // currently blocked dispatch/model request may renew the client's timer.
    if (!waiting || !runId) return;
    if (signal?.aborted || !isCurrent()) { publish.close(state, runId, progressId); return; }
    let live = true, timer;
    try {
      return await Promise.race([(async () => {
        const sdk = await load();
        if (!live || signal?.aborted || !isCurrent()) return;
        if (typeof sdk?.emitAgentEvent !== "function"
          || phase !== "settled" && typeof sdk.markDiagnosticSessionProgress !== "function") return false;
        const parent = { sessionId: state.sessionId, sessionKey: state.sessionKey, runId, agentId: state.agentId };
        let entries = runs.get(state);
        if (!entries) runs.set(state, entries = new Map());
        const key = `${runId}:${progressId}`;
        let progress = entries.get(key);
        if (!progress) {
          progress = createUiProgress({ sdk, parent, id: progressId, label: "正在等待 RC 评审与复验。",
            deadlineAt, signal, isCurrent });
          entries.set(key, progress);
          // Retain bounded closed entries so late callbacks cannot resurrect
          // a terminal run. Active entries are never evicted.
          for (const [key, value] of entries) if (entries.size > 64 && value.closed) entries.delete(key);
        }
        if (phase === "settled") progress.close({ text, allowExpired: true });
        else {
          progress.update(text, { reviewPhase: phase, deadlineAt });
          // MA's stuck-session recovery does not observe tool UI updates.
          // Renew only this live, bounded RC waiter through the public SDK;
          // do not fabricate model/tool execution or prolong background work.
          if (progress.closed) return false;
          await sdk.markDiagnosticSessionProgress(parent);
        }
        return true;
      })(), new Promise(resolve => { timer = setTimeout(() => resolve(false), 500); })]);
    } catch { return false; } // The gate must release when host keepalive is unavailable.
    finally { live = false; clearTimeout(timer); }
  };
  publish.close = (state, runId, progressId = "stop-wait") => runs.get(state)?.get(`${runId}:${progressId}`)?.close({ notify: false });
  return publish;
}
