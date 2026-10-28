const $ = id => document.getElementById(id);
const labels = { PASS: '通过', DEVIATION: '没过', UNVERIFIED: '未验证', CHECKER_ERROR: '检查器异常', FAILED: '失败', ERROR: '异常',
  ACTIVE: '看护中', UPDATED: '已更新', RESPONDED: '已响应', TRIGGERED: '已触发', RECORDED: '已记录', DISABLED: '未启用',
  NOT_APPLICABLE: '不适用', NOT_COMPUTABLE: '无适用对象', BASIS_PENDING: '基线待定', EXTERNAL_BLOCKED: '外部阻塞',
  NOT_YET_EXECUTED: '尚未执行', NOT_YET_APPLICABLE: '暂不适用' };
const kinds = { response: '触发响应', artifact: '产物看护', baseline: '基线提取', skill: 'Skill 看护', stop: '任务完成看护', system: '运行异常' };
const hooks = { PostToolUse: '工具执行后', PreToolUse: '工具执行前', UserPromptSubmit: '用户输入', Stop: '任务结束检查', PreCompact: '上下文整理前' };
const delivery = { NONE: '未生成反馈', UNKNOWN: '送达未知', RETURNED: '已生成反馈，宿主送达未确认', TOOL_RESULT: '已写入宿主工具结果',
  ADMITTED: '宿主已接收续作', OBSERVED: '模型已观察反馈', REJECTED: '宿主拒绝续作', SUPPRESSED: '观察模式：未发送' };
const metricNames = ['需求分解覆盖', '需求分解合格', '测试契约覆盖', '测试契约合格', '验收标准覆盖', '验收标准合格', '需求产物可追溯', 'Skill 步骤遵循',
  '开发规范遵循', '强制经验规则遵循', '固定流程遵循', '需求执行', '验收闭环', '里程碑闭环', '关键旅程通过', '生产实现覆盖'];
const date = value => value === null || value === undefined ? '时间未知' : new Date(value).toLocaleString('zh-CN', { hour12: false });
function node(tag, text, className) { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (className) n.className = className; return n; }
function badge(status) { const n = node('span', labels[status] ?? status ?? '未知', 'badge'); n.dataset.status = status; return n; }
function disclosure(title, content) { const d = node('details'); d.append(node('summary', title), content); return d; }
function json(value) { return node('pre', JSON.stringify(value, null, 2), 'evidence'); }
function metricTable(metrics) {
  const table = node('table'), head = node('thead'), tr = node('tr');
  for (const title of ['指标', '结果', '检查对象 / 原因']) { const cell = node('th', title); cell.scope = 'col'; tr.append(cell); }
  head.append(tr); const body = node('tbody');
  for (const m of metrics) {
    const row = node('tr'), name = node('td', `${m.metricId} · ${metricNames[Number(m.metricId?.slice(1)) - 1] ?? m.name ?? ''}`), state = node('td');
    state.append(badge(m.status)); const info = node('td');
    if (m.objects?.length) {
      const list = node('ul');
      for (const o of m.objects) { const li = node('li'); li.append(badge(o.judgement), node('span', ` ${o.objectId} · ${o.description ?? ''} ${o.reason ?? ''}`)); list.append(li); }
      info.append(disclosure(`${m.objects.length} 个对象 · 展开依据`, list));
    } else info.textContent = m.reason ?? m.reasonCode ?? `${m.objectCount ?? 0} 个对象；未保存审查明细`;
    row.append(name, state, info); body.append(row);
  }
  table.append(head, body); return table;
}

export function createObservationPanel(request) {
  let selected = null, serial = 0, offset = 0, total = 0, timer, opened = new Set();
  const readQuery = () => ({ offset, limit: 25, search: $('obs-search').value.trim(), kind: $('obs-kind').value,
    attention: $('obs-attention').checked, order: $('obs-order').value,
    from: $('obs-from').value ? new Date($('obs-from').value).getTime() : null,
    to: $('obs-to').value ? new Date($('obs-to').value).getTime() : null });
  function showError(message) { $('obs-error').hidden = !message; $('obs-error').textContent = message ?? ''; }
  function renderRow(r) {
    const d = node('details', undefined, 'observation'); d.dataset.id = r.id; d.open = opened.has(r.id);
    d.addEventListener('toggle', () => { if (d.isConnected) { if (d.open) opened.add(r.id); else opened.delete(r.id); } });
    const summary = node('summary'), line = node('span', undefined, 'record-title');
    line.append(node('span', kinds[r.kind] ?? r.kind, 'record-kind'), badge(r.status), node('strong', hooks[r.title] ?? r.title ?? r.source));
    if (r.feedback?.state && r.feedback.state !== 'NONE') line.append(node('span', delivery[r.feedback.state] ?? '送达未知', 'record-kind'));
    summary.append(line, node('span', `${date(r.time)} · 轮次 ${r.turnId ?? '未知'}${r.baselineVersion !== null && r.baselineVersion !== undefined ? ` · 基线 v${r.baselineVersion}` : ''}`, 'record-meta'));
    d.append(summary); const body = node('div', undefined, 'record-body');
    body.append(node('p', `记录 ID：${r.id}`, 'muted'), node('p', `轮次 ID：${r.turnId ?? '历史未记录'} · Hook：${r.hookEventId ?? '未知'}${r.toolCallId ? ` · 工具调用：${r.toolCallId}` : ''}`, 'muted'));
    if (r.reason || r.error) body.append(node('p', r.error ?? r.reason, r.attention ? 'attention-text' : 'muted'));
    if (r.baselinePending) body.append(node('p', '当时有新需求待对齐，当前基线尚未覆盖全部输入。', 'attention-text'));
    if (r.watcher) body.append(node('p', `看护 Skill：${r.watcher.skillId} · ${labels[r.watcher.status] ?? r.watcher.status}`));
    if (r.metrics?.length) { const wrap = node('div', undefined, 'table-scroll'); wrap.append(metricTable(r.metrics)); body.append(node('h4', '本次指标审查'), wrap); }
    if (r.scope) body.append(disclosure('本次审查范围', json(r.scope)));
    body.append(node('h4', '给宿主的反馈'), node('p', delivery[r.feedback?.state] ?? '送达未知', 'feedback-state'));
    if (r.feedback?.text) body.append(node('pre', r.feedback.text, 'feedback-text'));
    if (r.changes) body.append(disclosure('基线变更内容', json(r.changes)));
    if (r.review || r.result) body.append(disclosure('检查详情', json(r.review ?? r.result)));
    body.append(node('p', `来源：${r.source ?? 'RC_RESPONSE'}`, 'muted'));
    const link = node('button', '复制记录链接', 'secondary');
    link.addEventListener('click', async () => {
      const url = new URL(location.href); url.searchParams.set('record', r.id);
      try { await navigator.clipboard.writeText(url.href); link.textContent = '链接已复制'; }
      catch { showError(`复制失败。记录 ID：${r.id}`); }
    }); body.append(link); d.append(body); return d;
  }
  function render(data) {
    total = data.total;
    $('obs-status').textContent = `${date(data.capturedAt)} 读取 · ${data.taskId ? `任务 ${data.taskId}` : '此会话尚无纠偏任务记录'} · 自动刷新`;
    showError(data.warnings?.join('；'));
    $('obs-overview').replaceChildren(...[
      ['响应与检查记录', data.summary.total], ['需关注', data.summary.attention], ['宿主有回执', data.summary.feedbackConfirmed],
    ].map(([name, value]) => { const stat = node('div'); stat.append(node('strong', String(value)), node('span', name)); return stat; }));
    const baseline = data.baseline, base = $('obs-baseline-body');
    $('obs-baseline').querySelector('summary').textContent = baseline ? `当前需求基线 v${baseline.version} · ${baseline.pending ? '新输入待对齐' : baseline.version ? '已提取' : '尚未提取'}` : '当前需求基线 · 尚无记录';
    const openClaims = new Set([...base.querySelectorAll('details[open]')].map(d => d.querySelector('summary')?.textContent));
    base.replaceChildren();
    if (baseline) {
      base.append(node('p', `冻结版本：${baseline.frozenAtVersion ?? '未冻结'} · 更新于 ${date(baseline.updatedAt)}`, 'muted'));
      if (baseline.extraction) {
        const progress = baseline.extraction, phase = ({ QUEUED: '排队', READING: '读取原始依据', EXTRACTING: '整理需求', REPAIRING: '校正候选',
          CANDIDATE_COMPLETE: '候选已生成，发布结果以当前基线为准', INTERRUPTED: '提取中断', UNVERIFIED: '提取状态已过期，未验证' })[progress.phase] ?? '未知';
        base.append(node('p', `提取阶段：${phase} · 更新于 ${date(progress.updatedAt)}`, ['INTERRUPTED', 'UNVERIFIED'].includes(progress.phase) ? 'attention-text' : 'muted'));
        base.append(node('p', progress.notice, 'muted'));
      }
      if (!baseline.available) base.append(node('p', '基线正文尚未提取或与当前版本不一致。', 'attention-text'));
      const list = node('ul');
      for (const c of baseline.claims ?? []) list.append(node('li', `${c.claimId ?? ''} · ${c.category ?? ''} · ${c.text ?? ''}`));
      if (list.childElementCount) { const claims = disclosure(`需求与约束（${list.childElementCount}）`, list); claims.open = openClaims.has(claims.firstChild.textContent); base.append(claims); }
    }
    const metricOpen = new Set([...$('obs-metric-body').querySelectorAll('details[open]')].map(d => d.closest('tr')?.firstChild.textContent));
    $('obs-metric-body').replaceChildren(data.metrics.length ? metricTable(data.metrics) : node('p', '尚无指标记录。'));
    for (const d of $('obs-metric-body').querySelectorAll('details')) d.open = metricOpen.has(d.closest('tr').firstChild.textContent);
    $('obs-count').textContent = `匹配 ${data.total} 条 / 共 ${data.summary.total} 条；每页 25 条。${data.summary.attention ? '需关注包括偏差、未验证和检查失败。' : ''}`;
    $('obs-records').replaceChildren(...(data.records.length ? data.records.map(renderRow) : [node('p', data.summary.total ? '没有匹配的记录，请调整或清除筛选。' : '暂无运行记录；等待插件在此会话中触发。', 'empty-records')]));
    $('obs-page').textContent = `${total ? Math.floor(offset / 25) + 1 : 0} / ${Math.ceil(total / 25)} 页`;
    $('obs-previous').disabled = offset === 0; $('obs-next').disabled = offset + 25 >= total;
  }
  async function refresh() {
    if (!selected) return;
    const token = ++serial, identity = selected, query = readQuery();
    if (query.from !== null && query.to !== null && query.from > query.to) { showError('开始时间不能晚于结束时间。'); return; }
    try {
      const data = await request('observations', { ...identity, query });
      if (token !== serial || identity !== selected) return;
      if (offset && offset >= data.total) { offset = Math.max(0, Math.floor((data.total - 1) / 25) * 25); return refresh(); }
      render(data);
    } catch (e) { if (token === serial && identity === selected) { showError(`运行记录读取失败：${e.message}。已显示的证据可能过期。`); $('obs-status').textContent = '读取失败，等待重试'; } }
  }
  function changed() { serial++; offset = 0; clearTimeout(timer); timer = setTimeout(() => void refresh(), 200); }
  for (const id of ['obs-search', 'obs-kind', 'obs-order', 'obs-from', 'obs-to', 'obs-attention']) $(id).addEventListener('input', changed);
  $('obs-refresh').addEventListener('click', () => void refresh());
  $('obs-clear').addEventListener('click', () => {
    for (const id of ['obs-search', 'obs-from', 'obs-to']) $(id).value = '';
    $('obs-kind').value = 'all'; $('obs-order').value = 'desc'; $('obs-attention').checked = false; changed();
  });
  $('obs-previous').addEventListener('click', () => { offset = Math.max(0, offset - 25); void refresh(); });
  $('obs-next').addEventListener('click', () => { offset += 25; void refresh(); });
  for (const action of ['expand', 'collapse']) $(`obs-${action}`).addEventListener('click', () => {
    for (const d of $('obs-records').querySelectorAll('details.observation')) { d.open = action === 'expand'; if (d.open) opened.add(d.dataset.id); else opened.delete(d.dataset.id); }
  });
  return { refresh, pause() { serial++; $('obs-status').textContent = '连接已断开，显示上次读取的证据'; }, select(identity) {
    if (selected && selected.id !== identity.id) { const url = new URL(location.href); url.searchParams.delete('record'); history.replaceState(null, '', url); }
    serial++; selected = identity; offset = 0; opened = new Set(); clearTimeout(timer); showError(null);
    for (const id of ['obs-search', 'obs-from', 'obs-to']) $(id).value = '';
    $('obs-kind').value = 'all'; $('obs-order').value = 'desc'; $('obs-attention').checked = false;
    const recordId = new URL(location.href).searchParams.get('record'); if (recordId) { $('obs-search').value = recordId; opened.add(recordId); }
    $('obs-overview').replaceChildren(); $('obs-baseline-body').replaceChildren(); $('obs-metric-body').replaceChildren(); $('obs-records').replaceChildren();
    $('obs-count').textContent = ''; $('obs-page').textContent = ''; $('obs-previous').disabled = true; $('obs-next').disabled = true;
    $('obs-status').textContent = '正在读取运行证据…'; void refresh();
  } };
}
