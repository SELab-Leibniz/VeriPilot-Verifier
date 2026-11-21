const $ = id => document.getElementById(id);
const publicKey = /^agent:[a-z0-9_-]+:/iu;
const privateKey = /:runtime-corrector:|:rc-worker:/u;
const sessions = new Map();
let client, ready = false, selection = 0, connection = 0, chosen, snapshot, target, stopping, stopRound, refreshing, listing, manual;
let selectedRoundId = null, roundChoices = [], loadedDetails;
let registryAvailable = false;
const keyOf = (key, id) => JSON.stringify([key, id]);
const businessKey = key => typeof key === "string" && publicKey.test(key) && !privateKey.test(key);
const sessionName = entry => entry.displayName || entry.label || entry.title || entry.key;

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
  PASS: "通过", CHECKED: "已检查", NO_DEVIATION_FOUND: "无偏差", DEVIATION: "有偏差", UNVERIFIED: "未验证", NOT_REVIEWED: "未审",
  NOT_APPLICABLE: "不适用", NOT_COMPUTABLE: "无法核算", CHECKER_ERROR: "检查失败", DISABLED: "未启用",
  FINDING: "发现", HISTORICAL_DEVIATION: "历史偏差",
};

const reviewReasons = {
  REVIEWER_DEADLINE: "终审超时", REVIEW_DEADLINE_EXPIRED: "终审超时", TURN_LIMIT: "终审达到审查步数上限",
  CORRECTION_BUDGET_EXHAUSTED: "本次自动修复次数已用完", USER_CONFIRMED_CANCEL: "已停止本轮纠偏",
  RC_ROUND_TERMINATED: "已停止本轮纠偏", RC_OWNER_EXITED: "纠偏进程已退出",
};
const reviewGroups = [
  { title: "无偏差", judgements: ["PASS", "NO_DEVIATION_FOUND"] },
  { title: "有偏差", judgements: ["DEVIATION"] },
  { title: "未验证", judgements: ["UNVERIFIED", "CHECKER_ERROR", "NOT_COMPUTABLE", "BASIS_PENDING"] },
  { title: "未审", judgements: ["NOT_REVIEWED"] },
];
const reviewStages = {
  READING_BASIS: "正在读取终审依据",
  SELECTING_SCOPE: "审查清单已保存，正在确定本轮范围",
  CHECKING_ITEMS: "本轮已保存的阶段性判定",
};

function reviewLabel(round) {
  return round?.outcome === "PASS" ? "已验证（验收通过）" : round?.reviewLabel;
}

function renderReview(round, review, label, checkingRound) {
  setText("outcome", checkingRound ? "正在读取" : reviewLabel(round) ?? label ?? "不可用");
  const content = $("review-details");
  content.replaceChildren();
  if (checkingRound || !review && !round?.outcome) return;
  const reason = reviewReasons[review?.reasonCode] ?? reviewReasons[round?.reasonCode];
  const stage = review?.provisional && (round?.outcome
    ? review.scopeKnown ? "终审结束前保存的阶段性判定" : null
    : reviewStages[review.stage]);
  const items = review?.items ?? [];
  const summary = document.createElement("p");
  const count = review?.coverage?.selectedObjectCount;
  if (!items.length) {
    const empty = stage && !review.scopeKnown ? stage : !review ? "本轮的逐项记录不可用"
      : !review.scopeKnown ? "本轮没有保存审查清单或逐项判定"
        : count === 0 ? "本轮审查范围为空" : "本轮没有保存逐项判定";
    summary.textContent = [reason, empty].filter(Boolean).join(" · ");
    content.append(summary);
    return;
  }
  const groups = reviewGroups.map(group => ({ title: group.title,
    items: items.filter(item => group.judgements.includes(item.judgement)) }));
  const other = items.filter(item => !reviewGroups.some(group => group.judgements.includes(item.judgement)));
  summary.textContent = [reason, stage, Number.isSafeInteger(count) && count > 0 ? "检查范围 " + count + " 项" : null,
    ...groups.map(group => group.title + " " + group.items.length)].filter(Boolean).join(" · ");
  content.append(summary);
  for (const group of [...groups, { title: "其他记录", items: other }]) {
    if (!group.items.length) continue;
    const section = document.createElement("section"), heading = document.createElement("h4"), list = document.createElement("ul");
    section.className = "review-group";
    heading.textContent = group.title;
    fillList(list, group.items.map(item => [item.label, Object.hasOwn(judgements, item.judgement) ? judgements[item.judgement] : "结论不可用",
      item.reason, ...item.evidence].filter(Boolean).join("\n")));
    section.append(heading, list);
    content.append(section);
  }
}

function roundUrl(roundId) {
  const params = new URLSearchParams({ sessionKey: chosen.key, sessionId: chosen.sessionId });
  if (roundId) params.set("roundId", roundId);
  return "?" + params;
}

function renderRoundPicker(current, details) {
  if (details) roundChoices = details.rounds ?? [];
  const first = roundChoices.find(row => row.isCurrent) ?? roundChoices[0];
  $("round-picker").hidden = !current || !first;
  const options = roundChoices.map(round => {
    const option = document.createElement("option");
    option.value = round.roundId === first.roundId ? "" : round.roundId;
    const kind = round.isCurrent ? "当前轮" : "历史轮";
    option.textContent = [kind, round.isRepair ? "自动修复" : "宿主运行",
      Number.isFinite(round.startedAt) ? new Date(round.startedAt).toLocaleString("zh-CN") : null,
      reviewLabel(round), round.hasBrief ? "有简报" : null].filter(Boolean).join(" · ");
    return option;
  });
  const picker = $("round-select");
  if (picker.options.length !== options.length || options.some((option, index) =>
    option.value !== picker.options[index].value || option.textContent !== picker.options[index].textContent)) picker.replaceChildren(...options);
  const value = options.some(option => option.value === selectedRoundId) ? selectedRoundId : "";
  if (picker.value !== value) picker.value = value;
}

function render(current, details, { checking = false, checkingRound = false } = {}) {
  const display = current?.display;
  setText("phase", display?.line ?? (checking ? "正在读取会话状态" : "RC 状态不可用"));
  setText("round-status", display?.round ?? "状态不可用");
  setText("agent-status", display?.agents ?? "状态不可用");
  setText("switches", current ? "项目纠偏 " + describeSwitch(current.projectEnabled) + " · 会话纠偏 " + describeSwitch(current.sessionEnabled) : "");
  fillList($("activities"), display?.activities ?? []);
  renderRoundPicker(current, details);
  const round = details?.round ?? (selectedRoundId ? roundChoices.find(row => row.roundId === selectedRoundId) : current);
  const brief = details?.brief;
  $("brief").hidden = !brief;
  $("brief-status").hidden = Boolean(brief);
  setText("brief-status", checkingRound ? "正在读取本轮简报" : details ? "本轮无注入简报记录" : "注入简报记录不可用");
  const latestBriefId = details?.latestBriefRoundId;
  $("latest-brief").hidden = !latestBriefId || latestBriefId === details?.roundId;
  if (!$("latest-brief").hidden) {
    const link = $("latest-brief").firstElementChild;
    link.href = roundUrl(latestBriefId);
    link.dataset.round = latestBriefId;
  }
  setText("brief-title", brief ? "本轮注入简报 · " + new Date(brief.at).toLocaleString("zh-CN") + " · "
    + (brief.channel === "run_start" ? "回合开头" : "随工具结果") : "");
  setText("brief-text", brief?.text ?? "该次注入的简报正文不可用");
  renderReview(round, details?.review, display?.review, checkingRound);

  const repairs = details?.repairs ?? [];
  const openInputs = new Map([...$("repair-runs").querySelectorAll("details[data-run]")].map(input => [input.dataset.run, input.open]));
  setText("repair-status", repairs.length ? "" : checkingRound ? "正在读取本轮修复记录"
    : details ? "本轮无已确认的自动修复，暂无下一轮修复输入" : "自动修复记录不可用");
  const repairRows = repairs.map(run => {
    const phase = run.endedAt ? "已结束" : run.closed ? "已终止或未启动"
      : run.runId === current?.runId && current?.phase === "CORRECTING" && display?.agents === "正在运行" ? "正在运行"
        : run.startedAt ? "已启动 · 当前状态待核对"
          : current?.phase === "WAIT_CORRECTION" && [run.runId, run.sourceRunId].includes(current.runId) ? "等待宿主启动" : "尚无启动确认";
    const review = Object.hasOwn(judgements, run.outcome) ? judgements[run.outcome] : null;
    const row = document.createElement("li");
    row.textContent = [phase + (review ? " · " + review : ""), "修复运行 " + run.runId,
      run.sourceRunId && "来源运行 " + run.sourceRunId].filter(Boolean).join("\n");
    if (run.roundId && run.roundId !== details.roundId) {
      const link = document.createElement("a");
      link.href = roundUrl(run.roundId);
      link.dataset.round = run.roundId;
      link.textContent = "查看修复轮";
      row.append("\n", link);
    }
    if (Object.hasOwn(run, "input")) {
      const input = document.createElement("details"), title = document.createElement("summary"), body = document.createElement("pre");
      input.dataset.run = run.runId;
      input.open = openInputs.get(run.runId) ?? Boolean(run.input);
      title.textContent = "修复轮收到的 RC 输入";
      body.textContent = run.input ?? (run.startedAt ? "已确认的修复输入正文不可用" : "尚未确认修复已启动");
      input.append(title, body);
      row.append(input);
    }
    return row;
  });
  $("repair-runs").replaceChildren(...repairRows);
  const repair = details?.repair;
  $("repair").hidden = !repair;
  setText("repair-source", repair?.sourceRunId ? "来源运行 · " + repair.sourceRunId : "");
  setText("repair-text", repair?.text ?? (repair?.started === false ? "等待修复启动" : "修复反馈正文不可用"));
  if (stopRound && current) {
    const stopped = [current, current.lastEndedRound, ...current.history ?? []].find(record => record?.roundId === stopRound);
    if (stopped?.ended && stopped.status === "TERMINATED") setText("stop-receipt", "该轮纠偏已停止");
    else if (stopped?.status === "STOPPING") setText("stop-receipt", "正在停止，等待宿主确认");
  }
  $("terminate").hidden = Boolean(selectedRoundId && selectedRoundId !== current?.roundId)
    || !current?.roundId || current.canTerminate !== true;
  $("terminate").disabled = !ready || $("terminate").hidden || Boolean(stopping);
}

async function refresh(expectedSelection = selection, check = false) {
  if (!ready || !chosen || expectedSelection !== selection) return null;
  if (refreshing?.selection === expectedSelection) {
    if (!check) return refreshing.promise;
    await refreshing.promise;
    if (!ready || selection !== expectedSelection) return null;
  }
  const activeClient = client, selected = chosen;
  const isCurrent = () => ready && client === activeClient && selection === expectedSelection;
  const job = { selection: expectedSelection };
  refreshing = job;
  job.promise = (async () => {
    if (!selected.current) {
      snapshot = target = null;
      const record = selected.record;
      setText("project", record?.projectRoot ?? "");
      render(record && { ...record, canTerminate: false, display: { ...record.display,
        round: "历史会话 · 运行状态不可用", agents: "状态不可用", activities: [],
        line: "RC 历史会话" + (record.outcome ? " · " + record.display.review : ""),
      } }, null);
      return "record";
    }
    try {
      if (!isCurrent()) return null;
      const session = await activeClient.request("runtime-corrector.session.get", { sessionKey: selected.key, sessionId: selected.sessionId });
      if (!isCurrent()) return null;
      if (!session.projectRoot) throw new Error("当前会话没有可读取的 RC 项目");
      const requested = { projectRoot: session.projectRoot, agentId: session.identity?.agentId,
        sessionKey: selected.key, sessionId: selected.sessionId };
      if (!requested.agentId) delete requested.agentId;
      let rechecked = true;
      if (check) {
        try { await activeClient.request("runtime-corrector.runtime.refresh", requested); }
        catch { rechecked = false; }
        if (!isCurrent()) return null;
      }
      const current = await activeClient.request("runtime-corrector.runtime.get", requested);
      if (!isCurrent()) return null;
      if (current.sessionKey !== selected.key || current.sessionId !== selected.sessionId || current.projectRoot !== requested.projectRoot)
        throw new Error("所选会话已变化");
      target = requested;
      snapshot = current;
      setText("project", session.projectRoot);
      let choice, details;
      do {
        choice = selectedRoundId;
        const roundId = choice ?? current.roundId;
        const key = JSON.stringify([current.version, roundId]);
        const reviewing = roundId === current.roundId && current.phase === "REVIEWING";
        details = !check && !reviewing && loadedDetails?.key === key && Date.now() < loadedDetails.expiresAt ? loadedDetails.value : null;
        if (!details) {
          try {
            details = await activeClient.request("runtime-corrector.runtime.details", { ...requested, roundId });
            if (roundId !== null && details?.roundId !== roundId) details = null;
            if (isCurrent() && details)
              loadedDetails = { key, value: details, expiresAt: Date.now() + 12000 };
          } catch (cause) {
            if (cause.code === "CONFLICT" && isCurrent() && choice && choice === selectedRoundId) {
              selectedRoundId = null;
              history.replaceState(null, "", roundUrl(null));
            }
          }
        }
      } while (isCurrent() && choice !== selectedRoundId);
      if (!isCurrent()) return null;
      render(current, details);
      return rechecked ? "checked" : "record";
    } catch {
      if (isCurrent()) { snapshot = target = null; render(null); }
      return null;
    }
  })();
  try { return await job.promise; }
  finally { if (refreshing === job) refreshing = null; }
}

function renderList() {
  const filter = $("session-filter").value.trim().toLowerCase();
  const records = [], others = [];
  let matching = 0;
  for (const entry of sessions.values()) {
    const title = sessionName(entry), project = entry.record?.projectRoot ?? entry.spawnedCwd ?? "";
    if (filter && ![title, entry.key, project].join(" ").toLowerCase().includes(filter)) continue;
    matching++;
    const item = document.createElement("li"), link = document.createElement("a"), note = document.createElement("small");
    const params = new URLSearchParams({ sessionKey: entry.key, sessionId: entry.sessionId });
    link.href = "?" + params;
    link.dataset.session = keyOf(entry.key, entry.sessionId);
    if (link.dataset.session === keyOf(chosen?.key, chosen?.sessionId)) link.setAttribute("aria-current", "page");
    link.append(title);
    note.textContent = entry.current ? entry.record?.display?.round ?? project : "历史会话";
    if (note.textContent) link.append(note);
    item.append(link);
    (entry.record ? records : others).push(item);
  }
  $("sessions").replaceChildren(...records);
  $("other-sessions").replaceChildren(...others);
  $("other-hosts").hidden = others.length === 0;
  if (filter || (!records.length && others.length)) $("other-hosts").open = true;
  setText("list-status", !ready ? "连接宿主后显示会话" : !registryAvailable ? "纠偏会话列表不可用"
    : !matching && filter ? "没有匹配的会话" : records.length ? records.length + " 个纠偏会话" : "暂无纠偏会话记录");
}

function loadSessions(activeClient, expectedConnection) {
  if (listing?.connection === expectedConnection) return listing.promise;
  const job = { connection: expectedConnection };
  listing = job;
  job.promise = (async () => {
    const [host, rc] = await Promise.allSettled([activeClient.request("sessions.list", {}),
      activeClient.request("runtime-corrector.runtime.list", {})]);
    if (!ready || expectedConnection !== connection) return false;
    if (host.status === "rejected") { error("无法读取宿主会话"); return false; }
    error(null);
    const next = new Map();
    if (rc.status === "fulfilled") for (const record of rc.value.sessions ?? []) {
      if (!businessKey(record.sessionKey) || typeof record.sessionId !== "string" || !record.sessionId) continue;
      const key = keyOf(record.sessionKey, record.sessionId);
      if (!next.has(key)) next.set(key, { key: record.sessionKey, sessionId: record.sessionId, label: record.label, record, current: false });
    }
    for (const entry of host.value.sessions ?? []) {
      if (!businessKey(entry.key) || typeof entry.sessionId !== "string" || !entry.sessionId) continue;
      const key = keyOf(entry.key, entry.sessionId);
      next.set(key, { ...next.get(key), ...entry, current: true });
    }
    sessions.clear();
    for (const [key, entry] of next) sessions.set(key, entry);
    registryAvailable = rc.status === "fulfilled";
    const previousKey = chosen && keyOf(chosen.key, chosen.sessionId);
    const query = new URLSearchParams(location.search);
    const linked = query.get("sessionId") ? keyOf(query.get("sessionKey"), query.get("sessionId")) : null;
    const legacy = query.has("session") && !query.has("sessionId") && [...sessions]
      .filter(([, entry]) => entry.current && entry.key === query.get("session"));
    const key = [previousKey, linked, legacy?.length === 1 ? legacy[0][0] : null].find(value => sessions.has(value))
      ?? sessions.keys().next().value;
    const updated = sessions.get(key);
    if (previousKey !== key || updated?.current !== chosen?.current) setSelection(key);
    else { chosen = updated; renderList(); }
    return registryAvailable;
  })().finally(() => { if (listing === job) listing = null; });
  return job.promise;
}

function setSelection(key) {
  chosen = sessions.get(key);
  selection++;
  snapshot = target = stopping = stopRound = null;
  roundChoices = [];
  loadedDetails = null;
  const query = new URLSearchParams(location.search);
  selectedRoundId = chosen?.key === query.get("sessionKey") && chosen.sessionId === query.get("sessionId") ? query.get("roundId") : null;
  setText("stop-receipt", "");
  $("selected").hidden = !chosen;
  renderList();
  if (chosen) {
    setText("name", sessionName(chosen));
    setText("project", "");
    render(null, null, { checking: true });
    void refresh();
  }
}

function chooseRound(roundId) {
  if (!ready || !snapshot || roundId && !roundChoices.some(round => round.roundId === roundId)) return;
  selectedRoundId = !roundId || roundId === snapshot.roundId ? null : roundId;
  history.replaceState(null, "", roundUrl(selectedRoundId));
  render(snapshot, null, { checkingRound: true });
  void refresh();
}

for (const id of ["latest-brief", "repair-runs"]) $(id).addEventListener("click", event => {
  const link = event.target.closest("a[data-round]");
  if (!link || !ready || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  chooseRound(link.dataset.round);
});
$("round-select").addEventListener("change", event => chooseRound(event.currentTarget.value));

for (const id of ["sessions", "other-sessions"]) $(id).addEventListener("click", event => {
  const link = event.target.closest("a[data-session]");
  if (!link || !ready || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  history.replaceState(null, "", link.href);
  setSelection(link.dataset.session);
});
$("session-filter").addEventListener("input", renderList);
$("refresh").addEventListener("click", async () => {
  if (!ready || manual) return;
  const expectedConnection = connection, expectedSelection = selection, hadSelection = Boolean(chosen);
  const job = manual = {};
  $("refresh").disabled = true;
  setText("query-status", "正在刷新状态");
  try {
    const [listed, checked] = await Promise.all([loadSessions(client, expectedConnection), refresh(expectedSelection, true)]);
    if (expectedConnection !== connection || !ready) return;
    const text = !hadSelection || expectedSelection !== selection ? listed ? "会话列表已刷新" : "会话列表刷新不可用"
      : checked === "checked" ? "已重新查询状态" : checked === "record" ? "已重新读取记录" : "无法刷新所选会话状态";
    setText("query-status", text + " · " + new Date().toLocaleTimeString());
  } finally {
    if (manual === job) { manual = null; $("refresh").disabled = !ready; }
  }
});

$("connect").addEventListener("click", async () => {
  const expectedConnection = ++connection;
  ready = false;
  client?.stop();
  client = null;
  selection++;
  snapshot = target = chosen = stopping = stopRound = null;
  roundChoices = [];
  selectedRoundId = loadedDetails = null;
  manual = null;
  sessions.clear();
  $("refresh").disabled = true;
  setText("query-status", "");
  renderList();
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
        $("refresh").disabled = false;
        void loadSessions(activeClient, expectedConnection);
      },
      onClose() {
        if (expectedConnection !== connection) return;
        ready = false;
        selection++;
        $("connect-form").hidden = false;
        $("refresh").disabled = true;
        snapshot = target = null;
        roundChoices = [];
        loadedDetails = null;
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
  if (!ready || !snapshot?.canTerminate || !snapshot.roundId || !target || stopping
    || selectedRoundId && selectedRoundId !== snapshot.roundId) return;
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
