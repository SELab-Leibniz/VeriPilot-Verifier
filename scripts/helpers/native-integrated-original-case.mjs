// One genuine original business session. Only the host creates user/tool turns
// and automatic RC events; this driver dispatches and reads their evidence.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { dispatchIntegratedOriginal, integratedHash } from './native-integrated-module-case.mjs';
import { auditNativeOriginalTerminals } from './native-original-turn-case.mjs';
import { summarizeIntegratedNativeEvidence } from './native-integrated-evidence.mjs';

// The existing authenticated waiter owns original-run/correction/dispatch
// state. Do not wait for a business PASS before entering that waiter.
export async function observeIntegratedSettlement({ auditTerminals, inspect, deadlineAt, signal,
  now = Date.now, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  let authenticTerminals = null, terminalError = null, current = null;
  try { authenticTerminals = await auditTerminals(); }
  catch (error) { terminalError = { code: error.code ?? error.name, message: error.message }; }
  let privateSettled = false, observationOutcome = null;
  while (now() < deadlineAt && !signal?.aborted) {
    current = await inspect();
    privateSettled = current.privateRuns.length > 0 && current.privateRuns.every(run => run.status === 'SETTLED');
    const dispatch = authenticTerminals?.dispatch;
    const matchingTask = current.task && (!dispatch?.scopeTaskId || dispatch.scopeTaskId === current.task.taskId)
      && (!current.task.sessionIds || current.task.sessionIds.includes(dispatch?.sessionId));
    if (privateSettled && matchingTask && authenticTerminals?.complete === true && authenticTerminals.semanticAccepted === null
      && authenticTerminals.originalRunId && dispatch?.id && dispatch.sessionId && dispatch.sessionKey && dispatch.scopeFingerprint
      && dispatch.phase === 'IDLE' && dispatch.reviewStatus === 'UNVERIFIED' && dispatch.pending === 0) {
      observationOutcome = 'AUTHENTICATED_NEGATIVE_TERMINAL'; break;
    }
    if (privateSettled && current.task?.status !== 'ACTIVE') break;
    await pause(Math.min(250, Math.max(0, deadlineAt - now())));
  }
  return { authenticTerminals, terminalError, current, privateSettled, observationOutcome };
}

export async function runIntegratedOriginalCase({ gateway, fixture, outputRoot, bindingFile, deadlineAt, signal }) {
  const business = await dispatchIntegratedOriginal({ gateway, fixture, bindingFile, deadlineAt, signal });
  const load = relative => import(pathToFileURL(path.join(gateway.pluginRoot, relative)).href);
  const [{ findTask, taskDirectory }, { createStopCorrectionStore }, { listNativeRuns }] = await Promise.all([
    load('lib/runtime-v2/task-store.mjs'), load('lib/runtime-v2/stop-correction-store.mjs'), load('lib/openclaw/native-runs.mjs')]);
  const store = createStopCorrectionStore({ directory: path.join(gateway.runtime.state.resolveStateDir(), 'runtime-corrector-stop-sessions') });
  let task, ledger, privateRuns = [];
  const { authenticTerminals, terminalError, observationOutcome } = await observeIntegratedSettlement({ deadlineAt, signal,
    auditTerminals: () => auditNativeOriginalTerminals({ gateway, originalRunId: business.originalRunId,
      sessionId: business.sessionId, sessionKey: business.sessionKey, projectRoot: fixture.projectRoot, deadlineAt, signal }),
    inspect: async () => {
      await gateway.drain();
      task = await findTask({ projectRoot: fixture.projectRoot, sessionId: business.sessionId });
      privateRuns = task ? await listNativeRuns(fixture.projectRoot, task.taskId) : [];
      return { task, privateRuns };
    } });
  // Fresh read after authentic terminal audit; an earlier published PASS is
  // never substituted for the final source/task/dispatch state.
  await gateway.drain();
  task = await findTask({ projectRoot: fixture.projectRoot, sessionId: business.sessionId });
  ledger = await store.inspect(business.sessionId);
  privateRuns = task ? await listNativeRuns(fixture.projectRoot, task.taskId) : [];
  const session = await gateway.runtime.subagent.getSession({ sessionKey: business.sessionKey });
  const read = file => fs.readFile(file, 'utf8').then(text => JSON.parse(text), error => { if (error.code === 'ENOENT') return null; throw error; });
  const injected = await read(path.join(gateway.root, 'fault-injection.json'));
  const observations = await fs.readFile(path.join(outputRoot, 'native-business-tools.jsonl'), 'utf8')
    .then(text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)), error => { if (error.code === 'ENOENT') return []; throw error; });
  const currentHashes = Object.fromEntries(await Promise.all(fixture.deliverables.map(async file =>
    [file, integratedHash(await fs.readFile(path.join(fixture.projectRoot, file)))])));
  const actionEvidence = summarizeIntegratedNativeEvidence({ observations, fixture, business, currentHashes, faultAt: injected?.at ?? null });
  const taskRoot = task ? taskDirectory(fixture.projectRoot, task.taskId) : null;
  const currentTruth = taskRoot ? await read(path.join(taskRoot, 'ground-truth/current.json')) : null;
  const sameTask = task && task.status !== 'ACTIVE' && (!authenticTerminals?.dispatch?.scopeTaskId || authenticTerminals.dispatch.scopeTaskId === task.taskId)
    && (!task.sessionIds || task.sessionIds.includes(business.sessionId));
  const result = { state: authenticTerminals?.complete && sameTask && privateRuns.length > 0 && privateRuns.every(run => run.status === 'SETTLED')
    ? 'SETTLED_REQUIRES_INDEPENDENT_MODULE_AUDIT' : 'INCOMPLETE', automaticModuleAcceptance: null,
    business, taskId: task?.taskId, formalVerification: task?.verification, taskStatus: task?.status,
    authenticTerminals, terminalError, observationOutcome, actionEvidence, currentHashes, injected,
    actualPrivateRoles: Object.fromEntries([...new Set(privateRuns.map(run => run.role))].map(role =>
      [role, privateRuns.filter(run => run.role === role).length])),
    privateRuns: privateRuns.map(({ role, status, sessionId, runId }) => ({ role, status, sessionId, runId })),
    taskEvidenceRoot: taskRoot, nativeToolObservations: path.join(outputRoot, 'native-business-tools.jsonl'),
    independentAuditRequired: ['Complete original authority and applicability of every baseline claim.',
      'Automatic current-document review, actual feedback and settled owning receipts.',
      'Actual Skill read/watcher/checker and fresh post-edit verification. A new watcher or fresh M08 assessment can establish the corrected stage; an old PASS cannot.',
      'Formal Stop current source/basis and authentic terminal dispatch. Fault control must have exactly the existing one injected fault and real repair.'],
    ...gateway.metrics() };
  await fs.writeFile(path.join(outputRoot, 'actual-business-session.json'), JSON.stringify(session, null, 2));
  await fs.writeFile(path.join(outputRoot, 'actual-final-task.json'), JSON.stringify(task, null, 2));
  await fs.writeFile(path.join(outputRoot, 'actual-final-ledger.json'), JSON.stringify(ledger, null, 2));
  await fs.writeFile(path.join(outputRoot, 'actual-current-truth.json'), JSON.stringify(currentTruth, null, 2));
  return result;
}
