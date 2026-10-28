// Offline audit against the actual profile/artifact from an explicit live run.
// Never starts a Gateway, model, correction or observer.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function auditNativeStopLoop(outputRoot) {
  const original = await fs.readFile(path.join(outputRoot, 'result.json'), 'utf8'), raw = JSON.parse(original);
  if (raw.mode === 'original-turn' && !raw.injected) return auditNativeOriginalTurn(outputRoot, raw);
  if (!['automatic-loop', 'original-turn'].includes(raw.mode) || !raw.sessionId || !raw.sessionKey) throw new Error('No completed native-loop observation is available to audit.');
  const projectRoot = path.join(outputRoot, 'project'), pluginRoot = path.join(outputRoot, 'native-host/build/runtime-corrector-openclaw');
  const load = relative => import(pathToFileURL(path.join(pluginRoot, relative)).href);
  const [{ findTask, taskDirectory }, { createStopCorrectionStore }, { listNativeRuns }, { readReport }] = await Promise.all([
    load('lib/runtime-v2/task-store.mjs'), load('lib/runtime-v2/stop-correction-store.mjs'), load('lib/openclaw/native-runs.mjs'), load('lib/openclaw/report.mjs'),
  ]);
  const task = await findTask({ projectRoot, sessionId: raw.sessionId });
  const ledger = await createStopCorrectionStore({ directory: path.join(outputRoot, 'native-host/state/runtime-corrector-stop-sessions') }).inspect(raw.sessionId);
  const used = Object.values(ledger?.admissions ?? {}).filter(admission => admission.accounting === 'USED');
  const admission = used.length === 1 ? used[0] : null;
  const businessRuns = new Set((raw.modelStarts ?? []).filter(event => event.sessionId === raw.sessionId && event.runId?.startsWith('rc-stop-')).map(event => event.runId));
  const nativeRuns = task ? await listNativeRuns(projectRoot, task.taskId) : [];
  const evaluations = [];
  if (task) for (const name of await fs.readdir(path.join(taskDirectory(projectRoot, task.taskId), 'evaluations'))) {
    if (!name.endsWith('.json')) continue;
    const evaluation = JSON.parse(await fs.readFile(path.join(taskDirectory(projectRoot, task.taskId), 'evaluations', name), 'utf8'));
    evaluations.push({ evaluationId: evaluation.evaluationId, status: evaluation.outcome?.status,
      rows: evaluation.review?.metricObjectJudgements?.map(row => ({ objectId: row.objectId, judgement: row.judgement })) ?? [] });
  }
  const initialDeviation = admission && ledger.events.some(event => event.type === 'STOP_REVIEW_SETTLED' && event.stopId === admission.stopId && event.status === 'DEVIATION');
  const report = await readReport({ workspaceDir: projectRoot, sessionId: raw.sessionId, sessionKey: raw.sessionKey });
  const finalReview = admission?.finalReview;
  const initial = evaluations.find(value => value.status === 'DEVIATION');
  const final = evaluations.find(value => value.evaluationId === finalReview?.evaluationId && value.status === 'PASS');
  const originalObjectIds = initial?.rows.map(row => row.objectId).sort() ?? [];
  const denominatorPreserved = originalObjectIds.length > 0 && JSON.stringify(originalObjectIds) === JSON.stringify(final?.rows.map(row => row.objectId).sort());
  const roles = Object.fromEntries(['ground-truth-extractor', 'stop-reviewer'].map(role => [role, nativeRuns.filter(run => run.role === role).length]));
  const privateStartsObserved = nativeRuns.every(run => raw.modelStarts.some(event => event.runId === run.runId && event.sessionId === run.sessionId));
  const originalStartObserved = raw.mode !== 'original-turn' || raw.modelStarts.some(event => event.runId === raw.originalRunId && event.sessionId === raw.sessionId);
  const fault = raw.injected ? JSON.parse(await fs.readFile(path.join(outputRoot, 'native-host/fault-injection.json'), 'utf8')) : null;
  const faultConfirmed = !raw.injected || fault.runId === raw.originalRunId && fault.beforeHash !== fault.afterHash;
  const complete = Boolean(task?.verification?.status === 'PASS' && report.verification === 'PASS' && ledger?.used === 1 && used.length === 1
    && businessRuns.size === 1 && businessRuns.has(`rc-stop-${admission.id}`) && admission.endedAt >= admission.startedAt && initialDeviation
    && finalReview?.status === 'PASS' && finalReview.evaluationId === task.verification.evaluationId
    && denominatorPreserved && final.rows.every(row => row.judgement === 'PASS') && raw.deliveryChecks === true
    && nativeRuns.length === 3 && roles['ground-truth-extractor'] === 1 && roles['stop-reviewer'] === 2
    && privateStartsObserved && originalStartObserved && faultConfirmed && nativeRuns.every(run => run.status === 'SETTLED'));
  const audit = { complete, mode: 'offline-audit', taskId: task?.taskId, rawReportedTaskId: raw.taskId,
    historicalTaskIdMismatch: raw.taskId !== task?.taskId, verification: task?.verification?.status, reportVerification: report.verification,
    used: ledger?.used, admissionCount: Object.keys(ledger?.admissions ?? {}).length, initialDeviation: Boolean(initialDeviation),
    finalReview, actualCorrectionRunIds: [...businessRuns], evaluations, originalObjectIds, denominatorPreserved,
    privateStartsObserved, originalStartObserved, faultConfirmed, roles, deliveryChecks: raw.deliveryChecks === true,
    privateRuns: nativeRuns.map(({ role, status, sessionId, runId }) => ({ role, status, sessionId, runId })),
    observationSource: path.join(outputRoot, 'result.json'), noModelCall: true, capturedAt: new Date().toISOString() };
  await fs.writeFile(path.join(outputRoot, 'audit.json'), JSON.stringify(audit, null, 2));
  return audit;
}

async function auditNativeOriginalTurn(outputRoot, raw) {
  const projectRoot = path.join(outputRoot, 'project'), nativeRoot = path.join(outputRoot, 'native-host');
  const load = relative => import(pathToFileURL(path.join(nativeRoot, 'build/runtime-corrector-openclaw', relative)).href);
  const [{ findTask, taskDirectory }, { createStopCorrectionStore }, { listNativeRuns }, { readReport }, { normalizeMessages }] = await Promise.all([
    load('lib/runtime-v2/task-store.mjs'), load('lib/runtime-v2/stop-correction-store.mjs'), load('lib/openclaw/native-runs.mjs'),
    load('lib/openclaw/report.mjs'), load('lib/openclaw/transcript.mjs'),
  ]);
  const task = await findTask({ projectRoot, sessionId: raw.sessionId });
  const report = await readReport({ workspaceDir: projectRoot, sessionId: raw.sessionId, sessionKey: raw.sessionKey });
  const ledger = await createStopCorrectionStore({ directory: path.join(nativeRoot, 'state/runtime-corrector-stop-sessions') }).inspect(raw.sessionId);
  const runs = task ? await listNativeRuns(projectRoot, task.taskId) : [];
  const evaluationId = task?.verification?.evaluationId;
  const evaluation = evaluationId ? JSON.parse(await fs.readFile(path.join(taskDirectory(projectRoot, task.taskId), 'evaluations', `${evaluationId}.json`), 'utf8')) : null;
  const rows = evaluation?.review?.metricObjectJudgements ?? [];
  const population = task ? JSON.parse(await fs.readFile(path.join(taskDirectory(projectRoot, task.taskId), 'metrics/population.json'), 'utf8')) : null;
  const originalObjectIds = Object.values(population?.metrics ?? {}).flatMap(items => items.map(item => item.objectId)).sort();
  const denominatorPreserved = originalObjectIds.length > 0 && JSON.stringify(originalObjectIds) === JSON.stringify(rows.map(row => row.objectId).sort());
  const sessions = JSON.parse(await fs.readFile(path.join(nativeRoot, 'sessions.json'), 'utf8'));
  const entry = sessions[raw.sessionKey];
  const records = (await fs.readFile(entry?.sessionFile ?? path.join(nativeRoot, `${raw.sessionId}.jsonl`), 'utf8')).trim().split('\n').map(JSON.parse);
  const trajectory = (await fs.readFile(path.join(nativeRoot, `${raw.sessionId}.trajectory.jsonl`), 'utf8')).trim().split('\n').map(JSON.parse);
  const mainTerminal = trajectory.filter(event => event.type === 'session.ended' && event.runId === raw.originalRunId).at(-1);
  const actualMainCompleted = mainTerminal?.data?.status === 'success' && mainTerminal.data.aborted === false && mainTerminal.data.timedOut === false;
  const originalUserObserved = normalizeMessages(records).some(value => value.type === 'user' && !value.isMeta
    && (typeof value.message.content === 'string' ? value.message.content
      : value.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')).includes(path.join(outputRoot, 'original-contract.md')));
  const file = path.join(projectRoot, 'app.mjs');
  const actualDeliveryWriteCalls = records.flatMap(record => {
    const message = record.message ?? record;
    return message.role === 'assistant' && Array.isArray(message.content) ? message.content.filter(block => ['toolCall', 'tool_use'].includes(block.type)) : [];
  }).filter(block => {
    const args = block.arguments ?? block.input ?? {}, target = args.path ?? args.file_path;
    return ['write', 'edit'].includes(block.name?.toLowerCase()) && target && path.resolve(projectRoot, target) === file;
  }).length;
  const actualMainStart = raw.modelStarts?.some(event => event.runId === raw.originalRunId && event.sessionId === raw.sessionId) === true;
  const privateStartsObserved = runs.length > 0 && runs.every(run => raw.modelStarts?.some(event => event.runId === run.runId && event.sessionId === run.sessionId));
  const roles = Object.fromEntries(['ground-truth-extractor', 'stop-reviewer'].map(role => [role, new Set(runs.filter(run => run.role === role).map(run => run.sessionId)).size]));
  const admissionCount = Object.keys(ledger?.admissions ?? {}).length;
  const delivery = await import(pathToFileURL(file).href);
  const deliveryChecks = [0, 7, -2].every(value => delivery.accept(value) === value + 1);
  const complete = Boolean(report.verification === 'PASS' && evaluationId === raw.evaluationId && task?.taskId === raw.taskId
    && evaluation?.outcome?.status === 'PASS' && denominatorPreserved && rows.every(row => row.judgement === 'PASS')
    && ledger?.used === 0 && admissionCount === 0 && originalUserObserved && actualMainStart && actualMainCompleted && actualDeliveryWriteCalls > 0 && deliveryChecks
    && privateStartsObserved && roles['ground-truth-extractor'] === 1 && roles['stop-reviewer'] === 1 && runs.every(run => run.status === 'SETTLED'));
  const audit = { mode: 'offline-original-turn-audit', complete, taskId: task?.taskId, evaluationId, reportVerification: report.verification,
    rows: rows.map(({ objectId, judgement }) => ({ objectId, judgement })), originalObjectIds, denominatorPreserved, originalUserObserved, actualMainStart, actualMainCompleted, actualDeliveryWriteCalls,
    used: ledger?.used, admissionCount, roles, privateStartsObserved, allPrivateRunsSettled: runs.every(run => run.status === 'SETTLED'), deliveryChecks,
    noModelCall: true, capturedAt: new Date().toISOString() };
  await fs.writeFile(path.join(outputRoot, 'audit.json'), JSON.stringify(audit, null, 2));
  return audit;
}
