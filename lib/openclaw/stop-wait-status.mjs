import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function stopWaitText(record) {
  if (record.reasonCode === "STOP_WAIT_DEADLINE_EXPIRED") return "RC 等待修正与复验超时，已解除等待；本次结果未通过完整验收。";
  if (record.reasonCode === "CORRECTION_BUDGET_EXHAUSTED") return "RC 已用完配置的纠偏次数，仍未通过验收；已解除等待，允许后续任务继续。";
  if (record.reasonCode === "REVIEW_DEADLINE_EXPIRED") return "RC 验收超时，已解除等待；本次结果未通过完整验收。";
  if (record.reviewStatus === "PASS") return "RC 验收通过，已解除等待。";
  if (record.reviewStatus === "DEVIATION") {
    if (["ADMITTED", "FINISHED"].includes(record.followupStatus)) return "RC 发现偏差，纠偏反馈已交给宿主；本轮评审等待已结束。";
    if (record.followupStatus === "REJECTED") return "RC 发现偏差，但宿主拒绝了纠偏反馈；已解除等待，本次结果未通过验收。";
    return "RC 发现偏差；纠偏反馈尚未确认交给宿主，已解除等待，本次结果未通过验收。";
  }
  if (record.reviewStatus === "CANCELLED") return "RC 验收已取消，已解除等待；本次结果未验证。";
  return "RC 验收未能完成，已解除等待；本次结果未验证。";
}

// UI events only: never append messages to the host transcript or prompt.
// Existing hosts share the live reply surface rather than a separate RC banner.
export function createStopWaitStatus(api, compatibility) {
  let pending;
  const load = () => pending ??= (async () => {
    if (compatibility) return compatibility();
    if (!["2026.7.1-2", "2026.10.3"].includes(api.runtime.version)) return null;
    let file;
    try { file = createRequire(import.meta.url).resolve("openclaw/package.json"); }
    catch { file = path.join(path.dirname(await fs.realpath(process.argv[1])), "package.json"); }
    const pkg = JSON.parse(await fs.readFile(file, "utf8"));
    if (pkg.version !== api.runtime.version || pkg.name !== "openclaw") return null;
    return import(pathToFileURL(path.join(path.dirname(file), "dist/plugin-sdk/agent-harness.js")));
  })();
  return async ({ state, runId, text, baseText = "", phase, deadlineAt, isCurrent = () => true }) => {
    let live = true, timer;
    try {
      await Promise.race([(async () => {
        const sdk = await load();
        if (!live || !sdk?.emitAgentEvent || !isCurrent()) return;
        const parent = { sessionId: state.sessionId, sessionKey: state.sessionKey, runId, agentId: state.agentId };
        sdk.emitAgentEvent({ ...parent, stream: "runtime-corrector.progress", data: { phase, deadlineAt } });
        if (text) sdk.emitAgentEvent({ ...parent, stream: "assistant", data: {
          text: [baseText, `[runtime-corrector] ${text}`].filter(Boolean).join("\n\n"),
          replace: true, itemId: `runtime-corrector:stop:${runId}`,
        } });
      })(), new Promise(resolve => { timer = setTimeout(resolve, 500); })]);
    } catch { /* A failed status channel must never prevent release. */ }
    finally { live = false; clearTimeout(timer); }
  };
}
