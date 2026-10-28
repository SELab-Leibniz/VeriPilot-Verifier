// A real first business request through authenticated sessions.create/chat.send.
// No user/assistant transcript records, lifecycle callbacks or GT are injected.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { prepareNativeLoopProject } from './native-stop-loop-case.mjs';

export async function runNativeOriginalTurn({ gateway, projectRoot, outputRoot }) {
  const { file, requirement } = await prepareNativeLoopProject({ gateway, projectRoot, outputRoot });
  await fs.writeFile(file, 'export const accept = value => value;\n');
  const key = `agent:main:rc-initial-${randomUUID()}`;
  const created = await gateway.request('sessions.create', { key, agentId: 'main', label: 'RC isolated original turn' });
  if (!created.ok || !created.key) throw new Error('The actual Gateway did not create the requested isolated session.');
  const sessionKey = created.key, scope = { agentId: 'main', sessionKey, storePath: gateway.config.session.store };
  await gateway.runtime.agent.session.patchSessionEntry({ ...scope, update: entry => ({ ...entry, spawnedCwd: projectRoot }) });
  const saved = await gateway.runtime.agent.session.getSessionEntry({ ...scope, readConsistency: 'latest' });
  if (!saved?.sessionId || saved.spawnedCwd !== projectRoot) throw new Error('The actual project selection was not persisted.');
  const sessionId = saved.sessionId, runId = randomUUID();
  if (gateway.faultInjection) await fs.writeFile(path.join(gateway.root, 'fault-target.json'), JSON.stringify({ runId }));
  const accepted = await gateway.request('chat.send', { sessionKey, sessionId, message: requirement,
    idempotencyKey: runId, deliver: false, thinking: 'off', timeoutMs: 180000 });
  console.log(JSON.stringify({ state: 'actual-chat-request', sessionId, runId, acceptedRunId: accepted.runId, outputRoot }));
  const load = relative => import(pathToFileURL(path.join(gateway.pluginRoot, relative)).href);
  const [{ findTask }, { createStopCorrectionStore }, { readReport }, { listNativeRuns }, { normalizeMessages }] = await Promise.all([
    load('lib/runtime-v2/task-store.mjs'), load('lib/runtime-v2/stop-correction-store.mjs'), load('lib/openclaw/report.mjs'),
    load('lib/openclaw/native-runs.mjs'), load('lib/openclaw/transcript.mjs'),
  ]);
  const store = createStopCorrectionStore({ directory: path.join(gateway.runtime.state.resolveStateDir(), 'runtime-corrector-stop-sessions') });
  const deadline = Date.now() + 540000; let last, task, ledger, earlyTermination;
  while (Date.now() < deadline) {
    await gateway.drain(); task = await findTask({ projectRoot, sessionId }); ledger = await store.inspect(sessionId);
    const progress = { status: task?.status, verification: task?.verification?.status, used: ledger?.used, modelCalls: gateway.metrics().modelStarts.length };
    if (JSON.stringify(progress) !== last) { last = JSON.stringify(progress); console.log(last); }
    if (task?.verification?.status === 'PASS' || ['STOPPED_UNVERIFIED', 'STOPPED_CHECKER_ERROR'].includes(task?.status)) break;
    if (!gateway.metrics().modelStarts.length) {
      const snapshot = await gateway.runtime.subagent.getSession({ sessionKey });
      const terminal = (snapshot.messages ?? []).map(record => record.message ?? record).at(-1);
      if (terminal?.role === 'assistant' && terminal.stopReason === 'stop') {
        earlyTermination = 'The host ended the original request before starting a model.';
        break;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const session = await gateway.runtime.subagent.getSession({ sessionKey }), records = session.messages ?? [];
  const entries = normalizeMessages(records);
  const originalUserObserved = entries.some(entry => entry.type === 'user' && !entry.isMeta
    && (typeof entry.message.content === 'string' ? entry.message.content
      : entry.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')).includes(requirement));
  const writes = records.flatMap(record => {
    const message = record.message ?? record;
    return message.role === 'assistant' && Array.isArray(message.content) ? message.content.filter(block => ['toolCall', 'tool_use'].includes(block.type)) : [];
  }).filter(block => {
    const args = block.arguments ?? block.input ?? {}, target = args.path ?? args.file_path;
    return ['write', 'edit'].includes(block.name?.toLowerCase()) && target && path.resolve(projectRoot, target) === file;
  });
  const report = await readReport({ workspaceDir: projectRoot, sessionId, sessionKey });
  const runs = task ? await listNativeRuns(projectRoot, task.taskId) : [];
  const roles = Object.fromEntries(['ground-truth-extractor', 'stop-reviewer'].map(role => [role, new Set(runs.filter(run => run.role === role).map(run => run.sessionId)).size]));
  let deliveryChecks = false;
  if (task?.verification?.status === 'PASS') { const module = await import(pathToFileURL(file).href); deliveryChecks = [0, 7, -2].every(value => module.accept(value) === value + 1); }
  const actualMainStart = gateway.metrics().modelStarts.some(event => event.runId === runId && event.sessionId === sessionId);
  const expectedUsed = gateway.faultInjection ? 1 : 0;
  const used = Object.values(ledger?.admissions ?? {}).filter(item => item.accounting === 'USED');
  const injected = gateway.faultInjection ? await fs.readFile(path.join(gateway.root, 'fault-injection.json'), 'utf8').then(JSON.parse, () => null) : null;
  const faultCycleComplete = !gateway.faultInjection || injected?.runId === runId && used.length === 1
    && used[0].finalReview?.status === 'PASS' && used[0].finalReview.evaluationId === task?.verification?.evaluationId
    && ledger.events.some(event => event.type === 'STOP_REVIEW_SETTLED' && event.stopId === used[0].stopId && event.status === 'DEVIATION')
    && gateway.metrics().modelStarts.some(event => event.runId === `rc-stop-${used[0].id}` && event.sessionId === sessionId);
  const complete = report.verification === 'PASS' && ledger?.used === expectedUsed && Object.keys(ledger?.admissions ?? {}).length === expectedUsed
    && originalUserObserved && actualMainStart && writes.length > 0 && deliveryChecks
    && roles['ground-truth-extractor'] === 1 && roles['stop-reviewer'] === expectedUsed + 1 && runs.every(run => run.status === 'SETTLED') && faultCycleComplete;
  return { mode: 'original-turn', complete, gatewayEntry: 'authenticated sessions.create + chat.send; no seeded lifecycle',
    sessionId, sessionKey, originalRunId: runId, taskId: task?.taskId, verification: report.verification, status: task?.status,
    evaluationId: task?.verification?.evaluationId, used: ledger?.used, earlyTermination, admissionCount: Object.keys(ledger?.admissions ?? {}).length,
    originalUserObserved, actualMainStart, actualDeliveryWriteCalls: writes.length, deliveryChecks, roles,
    ...(gateway.faultInjection ? { injected, faultCycleComplete, finalReview: used[0]?.finalReview } : {}),
    privateRuns: runs.map(({ role, status, sessionId, runId }) => ({ role, status, sessionId, runId })), ...gateway.metrics(), outputRoot };
}
