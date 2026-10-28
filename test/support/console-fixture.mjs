import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureTask, withTaskState, findTask, taskDirectory, decisionGuard } from '../../lib/runtime-v2/task-store.mjs';
import { applyGroundTruthDelta } from '../../lib/runtime-v2/ground-truth-ledger.mjs';
import { buildMetricPopulation, calculateMetricReport } from '../../lib/runtime-v2/metrics.mjs';
import { fingerprint } from '../../lib/runtime-v2/evidence-state.mjs';
import { atomicWriteJson } from '../../lib/runtime-v2/utils.mjs';

export async function consoleFixture({ count = 60 } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-console-experiment-'));
  const record = { id: 'console-demo', agentId: 'main', sessionId: 'demo', sessionKey: 'agent:main:demo',
    projectRoot: root, scopeFingerprint: 'console-scope', label: '控制台验证 · 文档交付', phase: 'IDLE',
    version: 1, updatedAt: Date.now(), pending: [], history: [], pendingCount: 0 };
  let task = await ensureTask({ projectRoot: root, sessionId: record.sessionId });
  const delta = { operations: [{ operation: 'ADD', category: 'requirements', claimId: 'req-console', text: '交付说明包含指标与验证证据',
    authority: 'USER_EXPLICIT', severity: 'HARD', source: { sourceType: 'user', sourceRef: 'u1' } }] };
  await applyGroundTruthDelta({ projectRoot: root, taskId: task.taskId, delta, hookEventId: 'initial-baseline' });
  const dir = taskDirectory(root, task.taskId), current = JSON.parse(await fs.readFile(path.join(dir, 'ground-truth/current.json')));
  const population = await buildMetricPopulation({ projectRoot: root, taskId: task.taskId, groundTruth: current, skillDocuments: [] });
  const objects = Object.values(population.metrics).flat();
  const metricReport = calculateMetricReport({ population, judgements: objects.map(o => ({ objectId: o.objectId,
    judgement: o.metricId === 'M16' ? 'DEVIATION' : 'PASS', reason: o.metricId === 'M16' ? '尚未连接生产入口' : '已定位当前实现', evidence: ['delivery.md#L1'] })) });
  const file = path.join(root, 'delivery.md'); await fs.writeFile(file, '实际交付证据');
  await atomicWriteJson(path.join(dir, 'evaluations/stop-demo.json'), { evaluationId: 'stop-demo', metricReport,
    outcome: { status: 'DEVIATION', feedback: '请补齐生产入口并重新验收。', reasonCode: 'METRIC_DEVIATION' } });
  await withTaskState({ projectRoot: root, taskId: task.taskId }, s => {
    s.turns.total = 12;
    s.verification = { status: 'DEVIATION', evaluationId: 'stop-demo', assessmentId: 'stop-demo', rulesDigest: 'fixture-rules', requirementVersion: current.version,
      requirementDigest: current.digest, ...decisionGuard(s), evidence: { files: [file], fingerprints: {} } };
  });
  const hash = await fingerprint(file);
  await withTaskState({ projectRoot: root, taskId: task.taskId }, s => { s.verification.evidence.fingerprints[file] = hash; });
  const now = Date.now(), events = [];
  for (let i = 0; i < count; i++) events.push({ type: 'RC_RESPONSE', eventId: `response-${i}`, sessionId: 'demo',
    hookEventId: `tool-${i}`, hookEventName: 'PostToolUse', turnId: i + 1, baselineVersion: current.version,
    kind: 'response', status: 'RESPONDED', recordedAt: new Date(now - (count - i) * 60000).toISOString(),
    feedback: { state: 'NONE', text: null } });
  events.push({ type: 'OPENCLAW_ARTIFACT_REVIEW', eventId: 'artifact-demo', recordedAt: new Date(now - 5000).toISOString(),
    file: 'delivery.md', toolCallId: 'write-doc', requirementVersion: current.version, result: { status: 'failed', diagnostics: ['缺少结论'] }, feedback: '请补充报告结论 <script>alert(1)</script>' },
  { type: 'OPENCLAW_FEEDBACK_DELIVERED', recordedAt: new Date(now - 4500).toISOString(), file: 'delivery.md', toolCallId: 'write-doc', feedback: '请补充报告结论 <script>alert(1)</script>' },
  { type: 'SKILL_REVIEW_RESULT', eventId: 'skill-demo', recordedAt: new Date(now - 3000).toISOString(), hookEventId: 'skill-check', turnId: 10,
    skillId: 'document-review', status: 'UNVERIFIED', feedback: null, review: { checkerError: '审查超时' } },
  { type: 'STOP_CORRECTION_SETTLED', eventId: 'stop-demo-event', recordedAt: new Date(now - 2000).toISOString(), evaluationId: 'stop-demo', status: 'DEVIATION' },
  { type: 'RC_RESPONSE', eventId: 'stop-response', recordedAt: new Date(now - 1000).toISOString(), sessionId: 'demo', hookEventId: 'stop-hook',
    kind: 'stop', evaluationId: 'stop-demo', status: 'DEVIATION', turnId: 12, feedback: { state: 'RETURNED', text: '请补齐生产入口并重新验收。' } });
  await fs.mkdir(path.join(dir, 'journal'), { recursive: true });
  await fs.writeFile(path.join(dir, 'journal/events.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
  task = await findTask({ projectRoot: root, sessionId: record.sessionId });
  return { root, record, task, dir, events, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}
