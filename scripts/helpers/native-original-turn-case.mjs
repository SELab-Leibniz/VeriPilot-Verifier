// A real first business request through authenticated sessions.create/chat.send.
// No user/assistant transcript records, lifecycle callbacks or GT are injected.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { prepareNativeLoopProject } from './native-stop-loop-case.mjs';
import { dispatchHarborOriginalAgent } from '../bench/harbor-gateway-runner.mjs';
import { awaitHarborGatewaySettlement } from '../bench/harbor-gateway-controller.mjs';

export async function dispatchNativeOriginalTurn({ gateway, requirement, runId, sessionId, sessionKey,
  entry = 'chat', deadlineAt, now = Date.now }) {
  if (!['chat', 'agent'].includes(entry)) throw new Error('Unsupported original business entry');
  if (entry === 'agent') return dispatchHarborOriginalAgent({ request: (...args) => gateway.request(...args),
    instruction: requirement, runId, sessionId, sessionKey,
    deadlineAt: Math.min(deadlineAt, now() + 180000), now });
  return gateway.request('chat.send', { sessionKey, sessionId, message: requirement,
    idempotencyKey: runId, deliver: false, thinking: 'off', timeoutMs: 180000 });
}

export async function auditNativeOriginalTerminals({ gateway, originalRunId, sessionId, sessionKey,
  projectRoot, deadlineAt, signal }) {
  return awaitHarborGatewaySettlement({ request: (...args) => gateway.request(...args), originalRunId,
    sessionId, sessionKey, projectRoot, deadlineAt, signal, rcEnabled: true,
    readPersistentDispatch: async identity => {
      if (!/^[a-f0-9]{64}$/u.test(identity.id)) throw new Error('Invalid private dispatch identity');
      return JSON.parse(await fs.readFile(path.join(gateway.runtime.state.resolveStateDir(),
        'runtime-corrector-stop-sessions/post-run', `${identity.id}.json`), 'utf8'));
    } });
}

export async function finalizeNativeOriginalCompletion({ inspect, auditTerminals }) {
  const before = await inspect();
  if (!before.complete) return { ...before, authenticTerminals: null };
  const authenticTerminals = await auditTerminals();
  const current = await inspect();
  return { ...current, authenticTerminals,
    complete: current.complete && authenticTerminals.complete === true
      && authenticTerminals.dispatch?.reviewStatus === 'PASS' };
}

export async function runNativeOriginalTurn({ gateway, projectRoot, outputRoot, signal, wallMs = 540000,
  originalBusinessEntry = 'chat', deadlineAt = Date.now() + wallMs }) {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(deadlineAt) || deadlineAt <= Date.now()) throw new Error('Original component deadline expired');
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
  const accepted = await dispatchNativeOriginalTurn({ gateway, requirement, runId, sessionId, sessionKey,
    entry: originalBusinessEntry, deadlineAt });
  console.log(JSON.stringify({ state: 'actual-original-request', entry: originalBusinessEntry, sessionId, runId, acceptedRunId: accepted.runId, outputRoot }));
  const load = relative => import(pathToFileURL(path.join(gateway.pluginRoot, relative)).href);
  const [{ findTask }, { createStopCorrectionStore }, { readReport }, { listNativeRuns }, { normalizeMessages }] = await Promise.all([
    load('lib/runtime-v2/task-store.mjs'), load('lib/runtime-v2/stop-correction-store.mjs'), load('lib/openclaw/report.mjs'),
    load('lib/openclaw/native-runs.mjs'), load('lib/openclaw/transcript.mjs'),
  ]);
  const store = createStopCorrectionStore({ directory: path.join(gateway.runtime.state.resolveStateDir(), 'runtime-corrector-stop-sessions') });
  const deadline = deadlineAt; let last, task, ledger, earlyTermination;
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      earlyTermination = 'The experiment admission boundary stopped the original run.';
      await gateway.request('chat.abort', { sessionKey, runId }).catch(() => {});
      break;
    }
    await gateway.drain(); task = await findTask({ projectRoot, sessionId }); ledger = await store.inspect(sessionId);
    const progress = { status: task?.status, verification: task?.verification?.status, used: ledger?.used, modelCalls: gateway.metrics().modelStarts.length };
    if (JSON.stringify(progress) !== last) { last = JSON.stringify(progress); console.log(last); }
    const finalReceipt = Object.values(ledger?.admissions ?? {}).find(item => item.accounting === 'USED')?.finalReview;
    if (task?.verification?.status === 'PASS' && (!gateway.faultInjection || finalReceipt?.status === 'PASS')) {
      // PASS publication can precede the final asynchronous native receipt.
      // Keep observing inside the existing deadline rather than failing early.
      const privateRuns = await listNativeRuns(projectRoot, task.taskId);
      if (privateRuns.length && privateRuns.every(run => run.status === 'SETTLED')) break;
    }
    if (['STOPPED_UNVERIFIED', 'STOPPED_CHECKER_ERROR'].includes(task?.status)) break;
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
  async function inspectCompletion() {
  await gateway.drain();
  task = await findTask({ projectRoot, sessionId }); ledger = await store.inspect(sessionId);
  const report = await readReport({ workspaceDir: projectRoot, sessionId, sessionKey });
  const runs = task ? await listNativeRuns(projectRoot, task.taskId) : [];
  const roles = Object.fromEntries(['ground-truth-extractor', 'stop-reviewer'].map(role => [role, new Set(runs.filter(run => run.role === role).map(run => run.sessionId)).size]));
  let deliveryChecks = false;
  if (task?.verification?.status === 'PASS') {
    const url = pathToFileURL(file);
    url.searchParams.set('observedSource', createHash('sha256').update(await fs.readFile(file)).digest('hex'));
    const module = await import(url.href); deliveryChecks = [0, 7, -2].every(value => module.accept(value) === value + 1);
  }
  const actualMainStart = gateway.metrics().modelStarts.some(event => event.runId === runId && event.sessionId === sessionId);
  const expectedUsed = gateway.faultInjection ? 1 : 0;
  const used = Object.values(ledger?.admissions ?? {}).filter(item => item.accounting === 'USED');
  const injected = gateway.faultInjection ? await fs.readFile(path.join(gateway.root, 'fault-injection.json'), 'utf8').then(JSON.parse, () => null) : null;
  const faultCycleComplete = !gateway.faultInjection || injected?.runId === runId && used.length === 1
    && used[0].finalReview?.status === 'PASS' && used[0].finalReview.evaluationId === task?.verification?.evaluationId
    && ledger.events.some(event => event.type === 'STOP_REVIEW_SETTLED' && event.stopId === used[0].stopId && event.status === 'DEVIATION')
    && gateway.metrics().modelStarts.some(event => event.runId === `rc-stop-${used[0].id}` && event.sessionId === sessionId);
  const complete = report.verification === 'PASS' && task?.verification?.status === 'PASS'
    && ledger?.used === expectedUsed && Object.keys(ledger?.admissions ?? {}).length === expectedUsed
    && originalUserObserved && actualMainStart && writes.length > 0 && deliveryChecks
    && roles['ground-truth-extractor'] === 1 && roles['stop-reviewer'] === expectedUsed + 1 && runs.every(run => run.status === 'SETTLED') && faultCycleComplete;
  return { complete, report, runs, roles, deliveryChecks, actualMainStart, used, injected, faultCycleComplete };
  }
  const snapshot = originalBusinessEntry === 'agent'
    ? await finalizeNativeOriginalCompletion({ inspect: inspectCompletion,
      auditTerminals: () => auditNativeOriginalTerminals({ gateway, originalRunId: runId, sessionId, sessionKey,
        projectRoot, deadlineAt, signal }) })
    : { ...await inspectCompletion(), authenticTerminals: null };
  const { complete, authenticTerminals, report, runs, roles, deliveryChecks, actualMainStart, used, injected, faultCycleComplete } = snapshot;
  return { mode: 'original-turn', complete, originalBusinessEntry, authenticTerminals,
    gatewayEntry: `authenticated sessions.create + ${originalBusinessEntry === 'agent' ? 'agent' : 'chat.send'}; no seeded lifecycle`,
    sessionId, sessionKey, originalRunId: runId, taskId: task?.taskId, verification: report.verification, status: task?.status,
    evaluationId: task?.verification?.evaluationId, used: ledger?.used, earlyTermination, admissionCount: Object.keys(ledger?.admissions ?? {}).length,
    originalUserObserved, actualMainStart, actualDeliveryWriteCalls: writes.length, deliveryChecks, roles,
    ...(gateway.faultInjection ? { injected, faultCycleComplete, finalReview: used[0]?.finalReview } : {}),
    privateRuns: runs.map(({ role, status, sessionId, runId }) => ({ role, status, sessionId, runId })), ...gateway.metrics(), outputRoot };
}
