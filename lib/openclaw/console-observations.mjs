import { promises as fs } from 'node:fs';
import path from 'node:path';
import { taskDirectory, decisionGuard } from '../runtime-v2/task-store.mjs';
import { matchesEvidence } from '../runtime-v2/evidence-state.mjs';
import { FileTransactionJournal } from '../runtime-v2/transaction-journal.mjs';
import { METRIC_CATALOG } from '../runtime-v2/metrics.mjs';

const ATTENTION = new Set(['DEVIATION', 'UNVERIFIED', 'CHECKER_ERROR', 'FAILED', 'ERROR', 'REJECTED', 'BASIS_PENDING']);
const SEARCH_LABELS = { PASS: '通过', DEVIATION: '没过 偏差', UNVERIFIED: '未验证', CHECKER_ERROR: '检查器异常',
  DISABLED: '未启用', RESPONDED: '已响应', TRIGGERED: '已触发', UPDATED: '已更新',
  response: '触发响应', artifact: '产物看护', baseline: '基线提取', skill: 'skill看护', stop: '任务完成看护', system: '运行异常',
  NONE: '未生成反馈', UNKNOWN: '送达未知', RETURNED: '已生成反馈 宿主送达未确认', TOOL_RESULT: '已写入宿主工具结果',
  ADMITTED: '宿主已接收续作', OBSERVED: '模型已观察反馈', SUPPRESSED: '观察模式 未发送' };
const time = value => { const n = typeof value === 'number' ? value : Date.parse(value); return Number.isFinite(n) ? n : null; };
const feedback = (text, state = 'UNKNOWN') => ({ state: text ? state : 'NONE', text: text || null });
const array = value => Array.isArray(value) ? value : [];
export function metricVerdict(metric) {
  if (metric.enabled === false || metric.status === 'DISABLED') return 'DISABLED';
  const objects = array(metric.objects);
  if (objects.some(o => o.judgement === 'DEVIATION')) return 'DEVIATION';
  if (metric.status === 'CHECKER_ERROR' || objects.some(o => o.judgement === 'CHECKER_ERROR')) return 'CHECKER_ERROR';
  if (['NOT_COMPUTABLE', 'NOT_APPLICABLE'].includes(metric.status)) return metric.status;
  if (!objects.length || objects.some(o => !['PASS', 'NOT_APPLICABLE'].includes(o.judgement))) return 'UNVERIFIED';
  return objects.some(o => o.judgement === 'PASS') ? 'PASS' : 'NOT_APPLICABLE';
}
const metricRows = report => Object.entries(METRIC_CATALOG).map(([id, spec]) => {
  const m = report?.metrics?.find(m => m.metricId === id);
  return m ? { ...m, status: metricVerdict(m) } : { metricId: id, name: spec.name, status: 'UNVERIFIED',
    reasonCode: '本次未审查 / 无指标明细', objects: [] };
});

export function validateObservationQuery(query = {}) {
  const { offset = 0, limit = 25, search = '', kind = 'all', attention = false, order = 'desc', from = null, to = null } = query;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100
    || typeof search !== 'string' || search.length > 1000 || !['all', 'response', 'artifact', 'baseline', 'skill', 'stop', 'system'].includes(kind)
    || typeof attention !== 'boolean' || !['asc', 'desc'].includes(order)
    || [from, to].some(v => v !== null && (!Number.isSafeInteger(v) || v < 0)) || from !== null && to !== null && from > to)
    throw new Error('Invalid observation query.');
  return { offset, limit, search, kind, attention, order, from, to };
}

/** Reads RC evidence only. No host queries, state writes, or invented delivery acknowledgements. */
export async function readConsoleObservations(record, task, query = {}) {
  const q = validateObservationQuery(query), warnings = [];
  if (!task) return { capturedAt: Date.now(), taskId: null, baseline: null, metrics: [], watchers: [], records: [], total: 0,
    summary: { total: 0, attention: 0, feedbackConfirmed: 0 }, warnings, ...q };
  const directory = taskDirectory(record.projectRoot, task.taskId);
  const committed = task.projectionPending && task.decisionSequence != null
    ? await new FileTransactionJournal(directory).effects(task.decisionSequence) : null;
  if (task.projectionPending && !committed) warnings.push('提交的证据尚未投影，当前显示可能不完整。');
  async function read(name, jsonl = false) {
    try {
      let raw = committed?.files?.[path.normalize(name)];
      if (raw === undefined) {
        const file = await fs.open(path.join(directory, name), 'r');
        try {
          const stat = await file.stat(), max = 16 * 1024 * 1024;
          if (stat.size > max) { warnings.push(`${name} 超过 16 MiB；请归档后查看完整历史。`); return jsonl ? [] : null; }
          raw = await file.readFile('utf8');
        } finally { await file.close(); }
      }
      if (!jsonl) return JSON.parse(raw);
      // Ignore an actively appended incomplete tail, but surface malformed complete lines.
      const lines = raw.slice(0, raw.lastIndexOf('\n') + 1).split(/\r?\n/u).filter(Boolean), values = [];
      for (const line of lines) {
        try {
          const value = JSON.parse(line);
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid record');
          values.push(value);
        } catch { warnings.push(`${name} 包含损坏记录，已跳过。`); }
      }
      for (const event of committed?.events ?? []) if (path.normalize(event.file) === path.normalize(name)
        && !values.some(v => v.eventId === event.value.eventId)) values.push(event.value);
      return values;
    } catch (error) {
      if (error.code === 'ENOENT') {
        return jsonl ? (committed?.events ?? []).filter(e => path.normalize(e.file) === path.normalize(name)).map(e => e.value) : null;
      }
      warnings.push(`${name} 无法读取：${error.code ?? error.name}`); return jsonl ? [] : null;
    }
  }
  const [events, current, history, population] = await Promise.all([
    read('journal/events.jsonl', true), read('ground-truth/current.json'), read('ground-truth/history.jsonl', true), read('metrics/population.json'),
  ]);
  const evaluations = new Map();
  async function evaluation(id) {
    if (typeof id !== 'string' || !/^[\w.-]{1,180}$/u.test(id)) return null;
    if (!evaluations.has(id)) evaluations.set(id, read(`evaluations/${id}.json`));
    return evaluations.get(id);
  }
  const latest = await evaluation(task.verification?.evaluationId ?? task.stop?.lastAssessmentId);
  const report = latest?.metricReport;
  const baseline = { version: task.groundTruth.version, pending: Boolean(task.groundTruth.pendingUserCursor),
    frozenAtVersion: current?.frozenAtVersion ?? null, digest: task.groundTruth.digest, updatedAt: current?.updatedAt ?? null,
    available: Boolean(current && current.version === task.groundTruth.version && current.digest === task.groundTruth.digest),
    claims: current?.version === task.groundTruth.version && current?.digest === task.groundTruth.digest
      ? array(current?.claims).filter(c => !['RETRACTED', 'SUPERSEDED'].includes(c.status)) : [] };
  const guard = decisionGuard(task), verification = task.verification;
  const evidenceCurrent = Boolean(verification && verification.requirementVersion === baseline.version
    && verification.requirementDigest === baseline.digest && verification.generation === guard.generation
    && verification.rulesDigest && verification.assessmentId
    && verification.cancelEpoch === guard.cancelEpoch && !task.control?.cancelled && !task.control?.pendingRequirement
    && await matchesEvidence(verification.evidence));
  const metrics = Object.entries(METRIC_CATALOG).map(([id, spec]) => {
    const metric = report?.metrics?.find(m => m.metricId === id), config = population?.metricCatalog?.[id];
    const currentReport = baseline.available && evidenceCurrent && !baseline.pending && report?.groundTruthVersion === baseline.version
      && (!population || report?.populationVersion === population.version);
    return { metricId: id, name: spec.name, status: config?.enabled === false ? 'DISABLED' : currentReport && metric ? metricVerdict(metric) : 'UNVERIFIED',
      reason: config?.enabled === false ? '未启用' : !currentReport && metric ? '历史审查基线、证据或指标范围已过期 / 待验证' : metric?.reasonCode ?? (metric ? null : '尚无当前基线审查结果'),
      objectCount: array(population?.metrics?.[id]).length, objects: currentReport ? array(metric?.objects) : [],
      reportVersion: report?.groundTruthVersion ?? null };
  });
  const rows = [], seen = new Set(), responseHooks = new Set(events.filter(e => e.type === 'RC_RESPONSE').map(e => e.hookEventId));
  function add(row) {
    if (seen.has(row.id)) return; seen.add(row.id);
    row.attention = ATTENTION.has(row.status) || Boolean(row.error) || row.baselinePending || row.feedback?.state === 'REJECTED';
    row.time = time(row.recordedAt); rows.push(row);
  }
  for (const [index, event] of events.entries()) {
    if (event.sessionId && event.sessionId !== record.sessionId) continue;
    const base = { id: event.eventId ?? `journal:${index}`, recordedAt: event.recordedAt, turnId: event.turnId ?? null,
      hookEventId: event.hookEventId ?? null, kind: 'system', source: event.type, status: event.status ?? 'RECORDED',
      baselineVersion: event.baselineVersion ?? null, feedback: feedback(null, 'UNKNOWN') };
    if (event.type === 'RC_RESPONSE') {
      if (event.kind === 'stop' && event.evaluationId && events.some(e => e.type === 'STOP_CORRECTION_SETTLED' && e.evaluationId === event.evaluationId)) continue;
      add({ ...base, ...event, id: base.id, kind: event.kind ?? 'response', feedback: event.feedback ?? feedback(null),
        title: event.title ?? event.hookEventName, metrics: event.metrics ?? [] });
    } else if (event.type === 'HOOK_EVENT' && !responseHooks.has(event.hookEventId)) {
      add({ ...base, kind: 'response', title: event.hookEventName, status: 'TRIGGERED', feedback: { state: 'UNKNOWN', text: null },
        reason: '历史触发记录未保存完整响应与轮次。' });
    } else if (event.type === 'OPENCLAW_ARTIFACT_REVIEW') {
      const delivery = events.find(e => e.type === 'OPENCLAW_FEEDBACK_DELIVERED' && e.toolCallId === event.toolCallId && e.file === event.file);
      const metricEvent = events.find(e => e.type === 'OPENCLAW_ARTIFACT_METRICS' && e.toolCallId === event.toolCallId && e.file === event.file);
      const assessed = await evaluation(metricEvent?.evaluationId);
      add({ ...base, kind: 'artifact', title: event.file, toolCallId: event.toolCallId, baselineVersion: event.requirementVersion,
        status: event.result?.status === 'passed' ? 'PASS' : event.result?.status === 'failed' ? 'DEVIATION' : 'UNVERIFIED',
        result: event.result, metrics: assessed?.metricReport ? metricRows(assessed.metricReport) : [],
        feedback: delivery ? feedback(delivery.feedback, 'TOOL_RESULT') : feedback(event.feedback) });
    } else if (event.type === 'STOP_CORRECTION_SETTLED' || event.type === 'STOP_REVIEWS_DISABLED') {
      const assessed = await evaluation(event.evaluationId), outcome = assessed?.outcome ?? {};
      const response = events.find(e => e.type === 'RC_RESPONSE' && e.kind === 'stop' && e.evaluationId === event.evaluationId);
      const receiptEvents = events.filter(e => e.assessmentId === event.evaluationId && e.type.startsWith('NATIVE_STOP_FOLLOWUP_'));
      const state = receiptEvents.some(e => e.type.endsWith('_OBSERVED')) ? 'OBSERVED'
        : receiptEvents.some(e => e.type.endsWith('_ADMITTED')) ? 'ADMITTED'
        : receiptEvents.some(e => e.type.endsWith('_REJECTED')) ? 'REJECTED' : response?.feedback?.state ?? 'UNKNOWN';
      add({ ...base, kind: 'stop', title: '任务完成后的看护', evaluationId: event.evaluationId,
        turnId: response?.turnId ?? null, hookEventId: response?.hookEventId ?? null,
        baselineVersion: assessed?.metricReport?.groundTruthVersion ?? null, reason: event.reasonCode ?? outcome.reasonCode,
        status: event.type === 'STOP_REVIEWS_DISABLED' ? 'DISABLED' : !assessed ? 'UNVERIFIED' : event.status ?? outcome.status ?? 'UNVERIFIED',
        metrics: metricRows(assessed?.metricReport), scope: assessed?.metricReport?.scopeSelection ?? assessed?.review?.scopeSelection,
        feedback: feedback(response?.feedback?.text ?? outcome.feedback, state) });
    } else if (event.type === 'SKILL_REVIEW_RESULT') {
      const response = events.find(e => e.type === 'RC_RESPONSE' && e.hookEventId === event.hookEventId);
      add({ ...base, kind: 'skill', title: event.skillId, watcherId: event.watcherId, review: event.review,
        feedback: feedback(event.feedback, event.shadowMode ? 'SUPPRESSED' : response?.feedback?.state ?? 'UNKNOWN') });
    } else if (/FAILED|UNRESOLVED|UNVERIFIED|NOT_ESTABLISHED|INCOMPLETE/u.test(event.type ?? '')) {
      add({ ...base, kind: event.type.startsWith('GROUND_TRUTH') ? 'baseline' : event.type.startsWith('SKILL') ? 'skill' : 'system',
        status: 'UNVERIFIED', title: event.skillId ?? event.type, error: event.error ?? event.reason ?? event.type });
    }
  }
  const versions = new Map();
  for (const event of history) {
    const key = `${event.version}:${event.hookEventId ?? ''}`;
    if (!versions.has(key)) versions.set(key, []); versions.get(key).push(event);
  }
  for (const [key, group] of versions) add({ id: `baseline:${key}`, kind: 'baseline', source: 'ground-truth/history.jsonl',
    title: `基线更新 v${group[0].version}`, recordedAt: group[0].recordedAt, hookEventId: group[0].hookEventId,
    turnId: null, status: 'UPDATED', baselineVersion: group[0].version, changes: group,
    feedback: { state: 'NONE', text: null } });
  const watchers = Object.values(task.watchers ?? {});
  for (const watcher of watchers) add({ id: `watcher:${watcher.watcherId}`, kind: 'skill', source: 'watcher snapshot',
    title: watcher.skillId, recordedAt: watcher.completedAt ?? watcher.startedAt, turnId: watcher.lastCheckTurn ?? watcher.startedTurn,
    status: watcher.status, watcher, feedback: { state: 'UNKNOWN', text: null }, reason: '看护最新状态；反馈请查看对应响应记录。' });
  const summary = { total: rows.length, attention: rows.filter(r => r.attention).length,
    feedbackConfirmed: rows.filter(r => ['TOOL_RESULT', 'OBSERVED', 'ADMITTED'].includes(r.feedback?.state)).length };
  const words = q.search.toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  const filtered = rows.filter(r => {
    if ((q.kind !== 'all' && r.kind !== q.kind) || q.attention && !r.attention
      || q.from !== null && (r.time === null || r.time < q.from) || q.to !== null && (r.time === null || r.time > q.to)) return false;
    if (!words.length) return true;
    const text = (JSON.stringify(r) + ' ' + [r.status, r.kind, r.feedback?.state, ...array(r.metrics).map(m => m.status)]
      .map(key => SEARCH_LABELS[key] ?? '').join(' ')).toLocaleLowerCase();
    return words.every(word => text.includes(word));
  });
  filtered.sort((a, b) => (q.order === 'desc' ? -1 : 1) * ((a.time ?? 0) - (b.time ?? 0) || a.id.localeCompare(b.id)));
  return { ...q, capturedAt: Date.now(), taskId: task.taskId, baseline, metrics, watchers, summary,
    warnings: [...new Set(warnings)], total: filtered.length, records: filtered.slice(q.offset, q.offset + q.limit) };
}
