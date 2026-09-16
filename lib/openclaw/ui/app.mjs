const $ = (id) => document.getElementById(id);
const labels = { EXECUTING: "正在执行任务", WRITING: "正在写入", REVIEWING_ARTIFACT: "正在评审文件", REVIEWING: "正在评审",
  ASSESSING: "正在验收当前成果", WAITING_FOR_WORKER: "等待执行器响应", TOOL_EXECUTION: "正在运行工具", DELIVERED: "已交付",
  AWAITING_CORRECTION: "存在偏差，等待授权修正", ACTIVE: "任务等待继续", COMPLETED: "任务要求已验收", UPDATING_REQUIREMENTS: "正在更新需求基线",
  UNVERIFIED: "验收尚未完成", STOPPED: "自动执行已停止", CANCELLED: "已取消", STOPPING: "正在停止", PASS: "通过", STALE: "证据已过期", DEVIATION: "存在偏差" };
let client, ready = false, busy = false, report, connectionGeneration = 0;
let lastCommand;
try { lastCommand = JSON.parse(localStorage.getItem("runtime-corrector.last-command") ?? "null"); } catch { /* Corrupt local pointer is not a new command. */ }
$("session").value = new URL(location.href).searchParams.get("session") ?? lastCommand?.sessionKey ?? "";
function error(value) { $("error").hidden = !value; $("error").textContent = value ?? ""; }
function showReceipt(value) {
  const { commandId, actionId, status, action, windowId, receivedAt, startedAt, deadlineAt, reason, nativeRunId, delivery, priorDelivery, workerDelivery } = value;
  $("receipt").textContent = JSON.stringify({ commandId, actionId, status, action, windowId, receivedAt, startedAt,
    deadlineAt, reason, nativeRunId, delivery, priorDelivery, workerDelivery,
    assessment: value.outcome ? { decision: value.outcome.decision, status: value.outcome.status ?? value.outcome.report?.status,
      mode: value.outcome.assessmentMode, correctionsUsed: value.outcome.correctionAttempt } : undefined }, null, 2);
}
function target() { const sessionKey = $("session").value.trim(); if (!sessionKey) throw new Error("请填写原生聊天会话键，可从聊天页面网址的 session 参数取得。"); return { sessionKey }; }
async function request(method, params = {}) {
  if (!ready) throw new Error("Gateway 尚未认证连接。");
  return client.request(`runtime-corrector.${method}`, { ...target(), ...params });
}
function render(data) {
  report = data;
  $("phase").textContent = labels[data.phase] ?? data.phase ?? "尚无任务记录";
  $("verification").textContent = labels[data.verification] ?? "未验证";
  $("target").textContent = data.progress?.file ? `目标文件：${data.progress.file}` : `任务：${data.taskId ?? "未建立"}`;
  const b = data.budget;
  $("budget").textContent = b ? `${b.correctionsUsed} / ${b.maximum ?? "未验证"}` : "—";
  $("failures").textContent = b?.infrastructureConsecutiveFailures ?? "—";
  $("requirements").textContent = data.requirementVersion ?? "—";
  $("reason").textContent = data.pauseReason ?? "";
  const activity = data.reviewActivity;
  $("run-counts").textContent = activity ? `已记录原生评审 ${activity.nativeCalls} 次；格式修复 ${activity.formatRepairs} 次${activity.executionRound ? `；当前执行第 ${activity.executionRound} 轮` : ""}${b?.correctionsUsed ? `；已使用 ${b.correctionsUsed} 次内容修正` : ""}。` : "评审调用次数：未验证";
  $("report").textContent = data.text;
  $("details").textContent = JSON.stringify({ findings: data.findings, assessment: data.assessment, files: data.files,
    unsettledRuns: data.unsettledRuns }, null, 2);
  $("files").replaceChildren(...(data.files ?? []).map((file) => {
    const tr = document.createElement("tr");
    for (const value of [file.file, labels[file.status] ?? "未验证", file.feedbackDelivered.length, file.modifications.length, file.verifiedFixes.length]) {
      const td = document.createElement("td"); td.textContent = String(value); tr.append(td);
    } return tr;
  }));
}
async function refresh() {
  if (busy || !ready || !$("session").value.trim()) return;
  busy = true;
  const generation = connectionGeneration, sessionKey = target().sessionKey;
  try {
    const value = await request("status");
    if (generation === connectionGeneration && sessionKey === target().sessionKey) { render(value); error(null); }
  }
  catch (e) { if (generation === connectionGeneration) error(e.message); }
  finally { busy = false; }
}
$("connect").addEventListener("click", async () => {
  connectionGeneration++; client?.stop(); ready = false;
  const generation = connectionGeneration;
  try {
    const contract = await (await fetch("/plugins/runtime-corrector/capabilities.json")).json();
    if (contract.version !== "2026.7.1-2") throw new Error("宿主客户端契约不匹配。");
    const { t: NativeGatewayClient } = await import(contract.browserClient);
    if (typeof NativeGatewayClient !== "function") throw new Error("原生浏览器客户端不可用。");
    client = new NativeGatewayClient({ url: `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`,
      token: $("token").value.trim() || undefined,
      onHello() { if (generation !== connectionGeneration) return; ready = true; $("connection").textContent = "已认证连接"; $("token").value = ""; void refresh(); },
      onClose(event) { if (generation !== connectionGeneration) return; ready = false; $("connection").textContent = "连接已断开"; error(event?.error?.message ?? "请检查 Gateway 认证或设备配对状态。"); } });
    $("connection").textContent = "正在认证"; client.start();
  } catch (e) { error(e.message); }
});
for (const button of document.querySelectorAll("[data-action]")) button.addEventListener("click", async () => {
  button.disabled = true;
  try {
    const action = button.dataset.action;
    if (["status", "feedback"].includes(action)) {
      const sessionKey = target().sessionKey, generation = connectionGeneration;
      const value = await request(action);
      if (generation === connectionGeneration && sessionKey === target().sessionKey) render(value);
      return;
    }
    const params = { ...target(), commandId: crypto.randomUUID(), actionId: "main", action,
      ...(report?.guard ? { expected: report.guard } : {}), ...(action === "update-requirements" ? { text: $("requirement-text").value } : {}) };
    if (action === "update-requirements" && !params.text.trim()) throw new Error("请填写要求变更。");
    lastCommand = { sessionKey: params.sessionKey, commandId: params.commandId, actionId: params.actionId };
    localStorage.setItem("runtime-corrector.last-command", JSON.stringify(lastCommand));
    $("receipt").textContent = `发送中；commandId=${params.commandId}。响应未知时请核对回执，不重复提交。`;
    showReceipt(await request("control", params));
    error(null); await refresh();
  } catch (e) { error(e.message); }
  finally { button.disabled = false; }
});
$("check-receipt").addEventListener("click", async () => {
  try {
    if (!lastCommand) throw new Error("尚无可查询的指令编号。");
    showReceipt(await request("receipt", lastCommand));
  } catch (e) { error(e.message); }
});
setInterval(refresh, 2000);
setInterval(() => {
  $("waiting").textContent = report?.waitingSince
    ? `该阶段已等待 ${Math.max(0, Math.floor((Date.now() - report.waitingSince) / 1000))} 秒；记录时间 ${new Date(report.capturedAt).toLocaleTimeString()}。计时不会续期验收时限。` : "";
}, 1000);
$("session").addEventListener("change", () => { report = null; void refresh(); });
window.addEventListener("pagehide", () => { connectionGeneration++; client?.stop(); });
