const $ = id => document.getElementById(id);
const labels = { IDLE: "会话空闲", RUNNING: "任务执行中", FINALIZING: "本轮正在结束", REVIEW_QUEUED: "任务完成情况审查中。",
  REVIEWING: "任务完成情况审查中。", WAIT_CORRECTION: "等待启动纠偏任务", CORRECTING: "纠偏任务执行中", RELEASING: "本轮正在收尾", USER_DISPATCHING: "正在提交待办任务", CLOSED: "会话已关闭" };
const reasons = { STOP_NOT_REQUIRED: '本轮没有需要启动 Stop 审查的工作；这不改变历史验收结论。',
  STOP_STAGE_METRICS_UNDECLARED: '所选阶段没有声明指标，尚未完成验收。',
  NO_APPLICABLE_STAGE_OBJECTS: '所选阶段没有适用的指标对象，尚未完成任务整体验收。',
  NO_APPLICABLE_METRIC_OBJECTS: '当前基线没有适用的指标对象，尚未完成验收。',
  FINDINGS_ONLY_SCOPE: '本轮只扫描当前偏差，没有执行完整指标验收。',
  GROUND_TRUTH_INPUT_UNVERIFIED: '新增用户需求尚未可靠写入基线，验收仍待完成。' };
const taskStates = { PENDING: '已加入待办', DISPATCHING: '正在提交', QUEUED: '宿主已接收，等待开始', UNKNOWN: '提交结果待核对，不会自动重发',
  RUNNING: '执行中', FINISHED: '执行已结束', CANCEL_PENDING: '正在核对取消结果', REMOVED: '已移除', CLOSED: '会话关闭，未执行' };
let client, ready = false, generation = 0, chosen = null, detail = null, offset = 0, total = 0, sessions = [], refreshing = false, dirty = false, taskId = null, editingRevision = null, selectionVersion = 0;
const drafts = new Map();
const error = message => { $("error").hidden = !message; $("error").textContent = message ?? ""; };
const target = record => ({ id: record.id, agentId: record.agentId, sessionKey: record.sessionKey,
  sessionId: record.sessionId, scopeFingerprint: record.scopeFingerprint });
async function request(action, params = {}) {
  if (!ready) throw new Error("Gateway 尚未连接。");
  return client.request(`runtime-corrector.dispatch.${action}`, params);
}
function renderList() {
  $("sessions").replaceChildren(...sessions.map(r => {
    const button = document.createElement("button"); button.className = "session"; button.setAttribute("aria-current", String(chosen?.id === r.id));
    const title = document.createElement("strong"); title.textContent = r.label || r.sessionKey;
    const status = document.createElement("span"); status.textContent = `${labels[r.phase] ?? r.phase} · ${r.pendingCount} 个待办`;
    const project = document.createElement("span"); project.textContent = r.projectRoot;
    button.append(title, status, project); button.addEventListener("click", () => select(r)); return button;
  }));
  $("previous").disabled = offset === 0; $("next").disabled = offset + 100 >= total;
  $("page").textContent = `${total} 个会话 · 第 ${Math.floor(offset / 100) + 1} 页`;
}
function select(record) {
  if (chosen) drafts.set(chosen.id, { taskId, editingRevision, text: $("pending").value, dirty, newText: $("new-task").value });
  selectionVersion++;
  chosen = record; detail = null; taskId = null; dirty = false;
  error(null);
  $("name").textContent = record.label || record.sessionKey; $("project").textContent = record.projectRoot;
  $("identity").textContent = `${record.agentId} · ${record.sessionId}`;
  $("phase").textContent = "正在读取会话状态"; $("reason").textContent = "";
  $("task-receipt").textContent = ''; $("history").replaceChildren(); $("review-summary").hidden = true; $('review-objects').replaceChildren();
  $('requirements-status').textContent = '';
  $("task-target").textContent = `新任务将发送到：${record.sessionKey}（${record.projectRoot}）`;
  $("new-task").value = drafts.get(record.id)?.newText ?? "";
  $("pending").value = ""; $("save").disabled = true; $("remove").disabled = true;
  $("new-task").readOnly = true; $("add-form").querySelector("button").disabled = true;
  const url = new URL(location.href); url.searchParams.set("session", record.sessionKey); history.replaceState(null, "", url);
  renderList(); void refreshDetail();
}
function renderDetail(record) {
  if (detail?.version > record.version) return;
  detail = record; $("empty").hidden = true; $("selected").hidden = false;
  $("name").textContent = record.label || record.sessionKey; $("project").textContent = record.projectRoot;
  $("identity").textContent = `${record.agentId} · ${record.sessionId}`;
  $("phase").textContent = labels[record.phase] ?? record.phase;
  $('requirements-status').textContent = record.requirements ? `当前需求基线 v${record.requirements.version}。${record.requirements.pending
    ? '有新的用户输入待对齐，将在首次纠偏相关动作或 Stop 前更新；尚未按新要求完成验收。' : '当前没有登记的待对齐输入。'}` : '';
  $("reason").textContent = record.phase === "REVIEW_QUEUED" ? "正在等待审查资源。" : reasons[record.reason] ?? record.reason ?? "";
  $("task-target").textContent = `新任务将发送到：${record.sessionKey}（${record.projectRoot}）`;
  $("history").replaceChildren(...[...(record.history ?? [])].reverse().map(task => {
    const row = document.createElement('li'), status = document.createElement('strong'), text = document.createElement('p'), meta = document.createElement('small');
    status.textContent = taskStates[task.status] ?? task.status;
    text.textContent = task.text + (task.truncated ? '（正文已截短，完整内容见目标聊天）' : '');
    meta.textContent = `${new Date(task.updatedAt).toLocaleString()} · ${task.id}${task.reviewStatus ? ` · 审查 ${task.reviewStatus}` : ''}`;
    row.append(status, text, meta); return row;
  }));
  const summary = record.reviewSummary, scope = summary?.scopeSelection;
  $("review-summary").hidden = !summary;
  $("review-basis").textContent = summary ? `基线 v${summary.groundTruthVersion ?? '?'} · ${summary.status} · 范围内 ${scope?.selectedObjectCount ?? '?'} / 原始 ${scope?.fullObjectCount ?? '?'} 项 · 已审定 ${summary.reviewedObjectCount ?? 0} 项。${reasons[scope?.reasonCode] ?? ''}` : '';
  const openedMetrics = new Set([...$('review-objects').querySelectorAll('details[open]')].map(element => element.dataset.metric));
  $("review-objects").replaceChildren(...Object.entries(scope?.metrics ?? {}).filter(([, metric]) => metric.enabled).map(([id, metric]) => {
    const group = document.createElement('details'), title = document.createElement('summary'), list = document.createElement('ul');
    group.dataset.metric = id; group.open = openedMetrics.has(id);
    title.textContent = `${id}：原始 ${metric.available} 项，选中 ${metric.selected} 项`;
    for (const object of metric.objects) { const item = document.createElement('li'); item.textContent = `${object.selected ? '本轮检查' : '范围外'} · ${object.objectId} · ${object.description}`; list.append(item); }
    group.append(title, list); return group;
  }));
  let task = record.pending.find(t => t.id === taskId) ?? record.pending[0];
  const draft = drafts.get(record.id);
  if (!dirty && draft?.dirty && record.pending.some(t => t.id === draft.taskId)) {
    taskId = draft.taskId; editingRevision = draft.editingRevision; task = record.pending.find(t => t.id === taskId); dirty = true; $("pending").value = draft.text;
  }
  if (dirty) task = record.pending.find(t => t.id === taskId);
  if (!dirty) { editingRevision = task?.revision ?? null; taskId = task?.id ?? null; $("pending").value = task?.text ?? ""; }
  $("pending").readOnly = !task || record.phase === "CLOSED";
  $("new-task").readOnly = record.phase === "CLOSED";
  $("add-form").querySelector("button").disabled = record.phase === "CLOSED";
  $("save").disabled = !task || !dirty || record.phase === "CLOSED"; $("remove").disabled = !task || record.phase === "CLOSED";
  $("queue-note").textContent = dirty && (!task || task.revision !== editingRevision) ? "待办已在其他页面更新或开始执行。当前草稿已保留，保存前请重新选择任务。" : record.dispatching?.status === "UNKNOWN" ? "上次任务提交结果尚未确认；不会自动重复提交。"
    : record.pending.length > 1 ? `共有 ${record.pending.length} 个待办，按加入顺序执行。删除仅影响选中待办。` : "删除待办不会停止审查。";
  $("reload").hidden = !dirty || Boolean(task && task.revision === editingRevision);
  $("more").hidden = record.pending.length < 2;
  $("other-tasks").replaceChildren(...record.pending.filter(t => t.id !== taskId).map(t => {
    const button = document.createElement("button"); button.textContent = t.text.slice(0, 80);
    button.addEventListener("click", () => { taskId = t.id; dirty = false; drafts.delete(record.id); renderDetail(record); }); return button;
  }));
  $("updated").textContent = `状态更新于 ${new Date(record.updatedAt).toLocaleTimeString()}；关闭页面不会停止后台执行。`;
}
async function refreshDetail() {
  if (!chosen || !ready) return;
  const selected = target(chosen), token = generation, selection = selectionVersion;
  try {
    const record = await request("get", selected);
    if (token === generation && selection === selectionVersion && chosen?.id === selected.id) renderDetail(record);
  } catch (e) { if (token === generation && selection === selectionVersion && chosen?.id === selected.id) error(e.message); }
}
async function refresh() {
  if (!ready || refreshing) return;
  refreshing = true; const token = generation;
  try {
    const result = await request("list", { offset, limit: 100, search: $("search").value.trim(), filter: $("filter").value });
    if (token !== generation) return;
    sessions = result.sessions; total = result.total; renderList();
    if (!chosen) {
      const key = new URL(location.href).searchParams.get("session");
      let initial = key ? sessions.find(r => r.sessionKey === key) : sessions[0];
      if (key && !initial) {
        const found = await request("list", { search: key, limit: 100 });
        if (token !== generation || chosen) return;
        initial = found.sessions.find(r => r.sessionKey === key);
        if (!initial) error("链接对应的会话尚未登记，请从列表选择会话。");
      }
      if (initial && !chosen) select(initial);
    } else await refreshDetail();
  } catch (e) { if (token === generation) error(e.message); }
  finally { refreshing = false; }
}
$("connect").addEventListener("click", async () => {
  client?.stop(); ready = false; const token = ++generation; error(null);
  try {
    const response = await fetch("/plugins/runtime-corrector/capabilities.json"); const capabilities = await response.json();
    if (!response.ok) throw new Error(capabilities.error);
    const { t: NativeGatewayClient } = await import(capabilities.browserClient);
    client = new NativeGatewayClient({ url: `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`,
      token: $("token").value.trim() || undefined,
      onHello() { if (token !== generation) return; ready = true; $("token").value = ""; $("connection").textContent = "已连接"; void refresh(); },
      onClose() { if (token !== generation) return; ready = false; $("connection").textContent = "连接已断开，后台任务继续运行"; } });
    $("connection").textContent = "正在连接"; client.start();
  } catch (e) { error(e.message); }
});
$("pending").addEventListener("input", () => { dirty = true; $("save").disabled = !taskId; });
$("reload").addEventListener("click", () => {
  if (!detail) return;
  drafts.delete(detail.id); dirty = false; taskId = null; renderDetail(detail); error(null);
});
for (const action of ["save", "remove"]) $(action).addEventListener("click", async () => {
  const record = detail, task = record?.pending.find(t => t.id === taskId); if (!task) return;
  const selected = target(record), text = $("pending").value, selection = selectionVersion, revision = editingRevision;
  $("save").disabled = true; $("remove").disabled = true;
  try {
    const result = await request(action === "save" ? "edit" : "remove", { ...selected, taskId: task.id, revision, text });
    const draft = drafts.get(selected.id), savedRevision = result.pending.find(t => t.id === task.id)?.revision;
    if (draft?.taskId === task.id && draft.editingRevision === revision) {
      if (action === "save") { draft.editingRevision = savedRevision; draft.dirty = draft.text !== text; }
      else { draft.dirty = false; draft.taskId = null; }
    }
    if (action === "save" && chosen?.id === selected.id && taskId === task.id && editingRevision === revision)
      editingRevision = savedRevision;
    if (chosen?.id === selected.id && selection === selectionVersion) {
      if (action === "save" && $("pending").value !== text) editingRevision = result.pending.find(t => t.id === task.id)?.revision;
      else { dirty = false; taskId = null; }
      renderDetail(result); error(null);
    }
    await refresh();
  } catch (e) { if (chosen?.id === selected.id && selection === selectionVersion) { error(e.message); await refreshDetail(); } }
});
$("add-form").addEventListener("submit", async event => {
  event.preventDefault(); if (!chosen || !$("new-task").value.trim()) return;
  const selected = target(chosen), text = $("new-task").value;
  // Reuse this ID after an unknown response; a changed draft gets a new ID.
  const key = `rc-pending:${selected.id}`; let intent;
  try { intent = JSON.parse(sessionStorage.getItem(key)); } catch { /* No prior intent. */ }
  if (intent?.text !== text) intent = { text, commandId: crypto.randomUUID() };
  sessionStorage.setItem(key, JSON.stringify(intent));
  try {
    const result = await request("add", { ...selected, ...intent }); sessionStorage.removeItem(key);
    if (chosen?.id === selected.id) $("task-receipt").textContent = `任务已接收，目标：${selected.sessionKey}。任务 ID：${result.id}。空闲时立即执行；领取后请查看任务历史和目标聊天。`;
    if (chosen?.id === selected.id && $("new-task").value === text) $("new-task").value = "";
    const draft = drafts.get(selected.id); if (draft?.newText === text) draft.newText = "";
    await refresh(); error(null);
  } catch (e) { error(e.message); }
});
for (const id of ["search", "filter"]) $(id).addEventListener("input", () => { offset = 0; void refresh(); });
$("previous").addEventListener("click", () => { offset = Math.max(0, offset - 100); void refresh(); });
$("next").addEventListener("click", () => { offset += 100; void refresh(); });
setInterval(() => { if (!document.hidden) void refresh(); }, 3000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) void refresh(); });
window.addEventListener("pagehide", () => { generation++; client?.stop(); });
