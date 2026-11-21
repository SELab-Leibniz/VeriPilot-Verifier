const $ = id => document.getElementById(id);
const publicKey = /^agent:[a-z0-9_-]+:/iu;
const privateKey = /:runtime-corrector:|:rc-worker:/u;
const sessions = new Map();
let client, ready = false, selection = 0, connection = 0, chosen, snapshot, target, stopping, stopRound, refreshing, listing;

function error(message) {
  $("error").hidden = !message;
  $("error").textContent = message ?? "";
}

function setText(id, text) { $(id).textContent = text; }

function describeSwitch(value) { return value === true ? "开启" : value === false ? "关闭" : "未知"; }

function fillList(element, values) {
  element.replaceChildren(...values.map(value => {
    const item = document.createElement("li");
    item.textContent = value;
    return item;
  }));
}

const judgements = {
  PASS: "通过", CHECKED: "已检查", NO_DEVIATION_FOUND: "无偏差", DEVIATION: "有偏差", UNVERIFIED: "未验证",
  NOT_APPLICABLE: "不适用", NOT_COMPUTABLE: "无法核算", CHECKER_ERROR: "检查失败", DISABLED: "未启用",
  FINDING: "发现", HISTORICAL_DEVIATION: "历史偏差",
};

function render(current, details, { checking = false } = {}) {
  const display = current?.display;
  setText("phase", display?.line ?? (checking ? "正在读取会话状态" : "RC 状态不可用"));
  setText("switches", current ? "项目纠偏 " + describeSwitch(current.projectEnabled) + " · 会话纠偏 " + describeSwitch(current.sessionEnabled) : "");
  const activities = display?.activities ?? [];
  fillList($("activities"), activities.length ? activities : !current || current.status === "UNKNOWN" || !current.registered
    ? ["当前纠偏 Agent 状态不可用"] : current.running ? [display.activity] : ["当前无纠偏 Agent 在运行"]);
  const brief = details?.brief;
  setText("brief", brief ? "最近注入简报 · " + new Date(brief.at).toLocaleString() + " · "
    + (brief.channel === "run_start" ? "回合开头" : "随工具结果") : "最近注入简报记录不可用");
  setText("outcome", display?.review ?? "不可用");

  const review = $("review-details");
  review.replaceChildren();
  const summary = document.createElement("p");
  if (details?.review) {
    const { items, coverage } = details.review;
    summary.textContent = typeof coverage?.selectedObjectCount === "number"
      ? "本轮检查范围 · " + coverage.selectedObjectCount + " 个对象"
      : items.length ? "本轮检查明细" : "现有记录没有逐项明细";
    review.append(summary);
    if (items.length) {
      const list = document.createElement("ul");
      fillList(list, items.map(item => [item.label, Object.hasOwn(judgements, item.judgement) ? judgements[item.judgement] : "结论不可用",
        item.reason, ...item.evidence].filter(Boolean).join("\n")));
      review.append(list);
    }
  } else {
    summary.textContent = current?.outcome ? "明细不可用" : display?.review ?? "不可用";
    review.append(summary);
  }

  const repair = details?.repair;
  $("repair").hidden = !repair;
  setText("repair-source", repair?.sourceRunId ? "来源运行 · " + repair.sourceRunId : "");
  setText("repair-text", repair?.text ?? (repair?.started === false ? "等待修复启动" : "修复输入不可用"));
  if (stopRound && current) {
    const stopped = [current, current.lastEndedRound, ...current.history ?? []].find(record => record?.roundId === stopRound);
    if (stopped?.ended && stopped.status === "TERMINATED") setText("stop-receipt", "该轮纠偏已停止");
    else if (stopped?.status === "STOPPING") setText("stop-receipt", "正在停止，等待宿主确认");
  }
  $("terminate").disabled = !ready || !current?.roundId || current.canTerminate !== true || Boolean(stopping);
}

async function refresh(expectedSelection = selection) {
  if (!ready || !chosen || refreshing === expectedSelection) return;
  refreshing = expectedSelection;
  const activeClient = client, selected = chosen;
  const isCurrent = () => ready && client === activeClient && selection === expectedSelection;
  try {
    const session = await activeClient.request("runtime-corrector.session.get", { sessionKey: selected.key, sessionId: selected.sessionId });
    if (!isCurrent()) return;
    if (!session.projectRoot) throw new Error("当前会话没有可读取的 RC 项目");
    const requested = { projectRoot: session.projectRoot, agentId: session.identity?.agentId,
      sessionKey: selected.key, sessionId: selected.sessionId };
    if (!requested.agentId) delete requested.agentId;
    const current = await activeClient.request("runtime-corrector.runtime.get", requested);
    if (!isCurrent()) return;
    target = requested;
    snapshot = current;
    setText("project", session.projectRoot);
    let details;
    try { details = await activeClient.request("runtime-corrector.runtime.details", { ...requested, roundId: current.roundId }); }
    catch { /* The current status stays usable when a report is missing or the round changes. */ }
    if (isCurrent()) render(current, details?.roundId === current.roundId ? details : null);
  } catch {
    if (isCurrent()) { snapshot = target = null; render(null); }
  } finally {
    if (refreshing === expectedSelection) refreshing = null;
  }
}

async function loadSessions(activeClient, expectedConnection) {
  if (listing === expectedConnection) return;
  listing = expectedConnection;
  try {
    const result = await activeClient.request("sessions.list", { limit: 200 });
    if (!ready || expectedConnection !== connection) return;
    sessions.clear();
    const list = $("sessions");
    list.replaceChildren(new Option("请选择会话", ""));
    for (const entry of result.sessions ?? []) {
      if (typeof entry.key !== "string" || !publicKey.test(entry.key) || privateKey.test(entry.key)
        || typeof entry.sessionId !== "string" || !entry.sessionId) continue;
      const title = entry.displayName || entry.label || entry.key;
      const key = JSON.stringify([entry.key, entry.sessionId]);
      sessions.set(key, entry);
      list.add(new Option(title + " · " + entry.key, key));
    }
    list.disabled = !sessions.size;
    if (!sessions.size) setText("connection", "已连接 · 没有可查看的会话");
    const query = new URLSearchParams(location.search);
    const linked = JSON.stringify(chosen ? [chosen.key, chosen.sessionId] : [query.get("sessionKey"), query.get("sessionId")]);
    if (sessions.has(linked)) list.value = linked;
    else if (!chosen && !query.has("sessionId") && query.has("session")) {
      const matches = [...sessions].filter(([, entry]) => entry.key === query.get("session"));
      if (matches.length === 1) list.value = matches[0][0];
    }
    if (!chosen || !sessions.has(linked)) setSelection();
  } catch {
    if (expectedConnection === connection) error("无法读取宿主会话");
  } finally {
    if (listing === expectedConnection) listing = null;
  }
}

function setSelection() {
  chosen = sessions.get($("sessions").value);
  selection++;
  snapshot = target = stopping = stopRound = null;
  setText("stop-receipt", "");
  $("selected").hidden = !chosen;
  if (chosen) {
    setText("name", chosen.displayName || chosen.label || chosen.key);
    setText("project", "");
    render(null, null, { checking: true });
    void refresh();
  }
}

$("sessions").addEventListener("change", setSelection);
$("connect").addEventListener("click", async () => {
  const expectedConnection = ++connection;
  ready = false;
  client?.stop();
  client = null;
  selection++;
  snapshot = target = chosen = stopping = stopRound = null;
  $("sessions").disabled = true;
  $("selected").hidden = true;
  error(null);
  try {
    setText("connection", "正在连接");
    const response = await fetch("/plugins/runtime-corrector/capabilities.json");
    const capabilities = await response.json();
    if (!response.ok) throw new Error(capabilities.error);
    const { t: NativeGatewayClient } = await import(capabilities.browserClient);
    if (expectedConnection !== connection) return;
    const activeClient = new NativeGatewayClient({
      url: (location.protocol === "https:" ? "wss" : "ws") + "://" + location.host,
      token: $("token").value.trim() || undefined,
      onHello() {
        if (expectedConnection !== connection) return;
        ready = true;
        $("token").value = "";
        $("connect-form").hidden = true;
        setText("connection", "已连接");
        void loadSessions(activeClient, expectedConnection);
      },
      onClose() {
        if (expectedConnection !== connection) return;
        ready = false;
        $("connect-form").hidden = false;
        $("sessions").disabled = true;
        snapshot = target = null;
        render(null);
        setText("connection", "连接已断开");
      },
    });
    client = activeClient;
    activeClient.start();
  } catch (cause) {
    if (expectedConnection === connection) { error(cause.message); setText("connection", "未连接"); }
  }
});

$("terminate").addEventListener("click", async () => {
  if (!ready || !snapshot?.canTerminate || !snapshot.roundId || !target || stopping) return;
  const activeSelection = selection, activeClient = client, roundId = snapshot.roundId;
  const request = { ...target, roundId };
  stopping = roundId;
  stopRound = roundId;
  $("terminate").disabled = true;
  setText("stop-receipt", "正在停止，等待宿主确认");
  try {
    const result = await activeClient.request("runtime-corrector.runtime.terminate", request);
    if (selection !== activeSelection || client !== activeClient) return;
    if (result.target?.roundId === roundId && result.target.ended) setText("stop-receipt", "该轮纠偏已停止");
  } catch {
    if (selection === activeSelection && client === activeClient) setText("stop-receipt", "停止结果待核对，请查看当前状态");
  } finally {
    if (selection === activeSelection && client === activeClient) { stopping = null; void refresh(); }
  }
});

setInterval(() => { if (!document.hidden) void refresh(); }, 3000);
setInterval(() => { if (ready && !document.hidden) void loadSessions(client, connection); }, 12000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) void refresh(); });
window.addEventListener("pagehide", () => { connection++; client?.stop(); });
