// Seed a broken delivery, then let the real registered host hooks and Gateway
// perform automatic dispatch, trusted-start accounting, business repair and Stop.
// The initial delivery/events are a fixture, never presented as a model run.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { nativeStopTimeouts } from './native-stop-timeouts.mjs';
import { findTask } from '../../lib/runtime-v2/task-store.mjs';
import { createStopCorrectionStore } from '../../lib/runtime-v2/stop-correction-store.mjs';

export async function prepareNativeLoopProject({ gateway, projectRoot, outputRoot }) {
  const timeouts = gateway.stopTimeouts ?? nativeStopTimeouts();
  const contract = path.join(projectRoot, 'requirements/original-contract.md'), file = path.join(projectRoot, 'app.mjs');
  await fs.mkdir(path.dirname(contract), { recursive: true });
  await fs.writeFile(contract, 'The exported accept(value) must return the supplied finite number plus one, without storing state. Other input types are outside scope.\n');
  const requirement = `Implement exported accept(value) in app.mjs: for every allowed finite-number input return that number plus one without storing state. Preserve the complete original contract at ${contract}; other input types are outside scope.`;
  await fs.writeFile(file, 'export const accept = value => value + 1;\n');
  await fs.writeFile(path.join(projectRoot, 'AGENTS.md'), 'This isolated acceptance project exports a small ES module from app.mjs.\n');
  const git = process.platform === 'win32' ? 'C:/Program Files/Git/cmd/git.exe' : 'git';
  execFileSync(git, ['init', '--quiet', projectRoot], { windowsHide: true });
  execFileSync(git, ['-C', projectRoot, 'add', 'app.mjs', 'requirements/original-contract.md', 'AGENTS.md'], { windowsHide: true });
  execFileSync(git, ['-C', projectRoot, '-c', 'user.name=RC Local Evaluation', '-c', 'user.email=rc@example.invalid',
    '-c', 'core.hooksPath=nonexistent', 'commit', '--quiet', '-m', 'fixture baseline'], { windowsHide: true });
  await fs.mkdir(path.join(projectRoot, '.runtime-corrector'), { recursive: true });
  await fs.writeFile(path.join(projectRoot, '.runtime-corrector/config.yaml'), `version: 2
artifacts: []
dynamicGroundTruth:
  enabled: true
  materialRoots: [requirements]
  panel:
    size: 0
skillCorrection:
  enabled: false
artifactCorrection:
  groundTruthReviewEnabled: false
implementationCorrection:
  enabled: false
stopCorrection:
  enabled: true
  waitMode: until_pass
  maxCorrectionsPerSession: 1
  maxCorrectionsPerFlow: 1
  assessmentTimeoutMs: ${timeouts.assessmentTimeoutMs}
  feedbackReserveMs: ${timeouts.feedbackReserveMs}
  metrics:
${Array.from({ length: 16 }, (_, index) => `    M${String(index + 1).padStart(2, '0')}: ${[7, 8, 11, 12, 14, 15].includes(index)}`).join('\n')}
reviewers:
  defaults:
    model: ${gateway.modelRef ?? `anthropic/${gateway.model}`}
    effort: low
    timeoutMs: ${timeouts.reviewerTimeoutMs}
    maxOutputTokens: 32768
`);
  const { loadConfig } = await import(pathToFileURL(path.join(gateway.pluginRoot, 'lib/runtime-corrector.mjs')).href);
  await loadConfig({ cwd: projectRoot, pluginRoot: gateway.pluginRoot });
  return { contract, file, requirement };
}

export async function runNativeStopLoopCase({ gateway, projectRoot, outputRoot, sessionId, sessionKey, sessionFile }) {
  const { file, requirement } = await prepareNativeLoopProject({ gateway, projectRoot, outputRoot });
  const userId = randomUUID(), initialRunId = `seeded-${randomUUID()}`, text = 'The implementation is complete.';
  const user = { type: 'message', id: userId, parentId: null, timestamp: new Date().toISOString(),
    message: { role: 'user', content: [{ type: 'text', text: requirement }], timestamp: Date.now() } };
  await fs.writeFile(sessionFile, [
    { type: 'session', version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: projectRoot }, user,
  ].map(JSON.stringify).join('\n') + '\n');
  const ctx = { agentId: 'main', sessionId, sessionKey, runId: initialRunId, workspaceDir: projectRoot,
    trigger: 'user', modelProviderId: 'anthropic', modelId: gateway.model };
  await gateway.hooks.runSessionStart({ sessionId, source: 'startup' }, ctx);
  await gateway.hooks.runBeforePromptBuild({ prompt: requirement, messages: [user.message] }, ctx);
  await gateway.hooks.runBeforeToolCall({ toolName: 'write', toolCallId: 'program-seeded-delivery', params: { path: file } }, ctx);
  const registered = globalThis[Symbol.for('runtime-corrector.openclaw.session-project-state')];
  const active = [...registered.values()].flatMap(value => [...value.states?.values() ?? []])
    .find(value => value.sessionId === sessionId && value.projectRoot === projectRoot);
  if (!active?.projectScope.enabled || !active.nativeNeedsStop) throw new Error('The actual registered hooks did not activate this project and mark its seeded delivery for Stop.');
  await fs.writeFile(file, 'export const accept = value => value;\n');
  const assistant = { type: 'message', id: randomUUID(), parentId: userId, timestamp: new Date().toISOString(),
    message: { role: 'assistant', content: [{ type: 'text', text }], api: 'anthropic-messages', provider: 'fixture',
      model: 'program-seeded-initial-completion', stopReason: 'stop', timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } };
  await fs.appendFile(sessionFile, JSON.stringify(assistant) + '\n');
  console.log(JSON.stringify({ state: 'seeded-terminal-event', sessionId, taskId: active.scopeTaskId, initialDelivery: 'program fixture; not a model execution' }));
  await gateway.hooks.runBeforeAgentFinalize({ sessionId, runId: initialRunId, lastAssistantMessage: text }, ctx);
  await gateway.hooks.runAgentEnd({ sessionId, runId: initialRunId, success: true, messages: [user.message, assistant.message] }, ctx);
  const store = createStopCorrectionStore({ directory: path.join(gateway.runtime.state.resolveStateDir(), 'runtime-corrector-stop-sessions') });
  const deadline = Date.now() + (gateway.stopTimeouts ?? nativeStopTimeouts()).wallMs; let last, state, ledger;
  while (Date.now() < deadline) {
    await gateway.drain();
    state = await findTask({ projectRoot, sessionId }); ledger = await store.inspect(sessionId);
    const progress = { state: state?.status, verification: state?.verification?.status, used: ledger?.used,
      admitted: Object.keys(ledger?.admissions ?? {}).length, modelCalls: gateway.metrics().modelStarts.length };
    if (JSON.stringify(progress) !== last) { last = JSON.stringify(progress); console.log(last); }
    if (state?.verification?.status === 'PASS' && ledger?.used === 1) break;
    if (['STOPPED_UNVERIFIED', 'CANCELLED', 'STOPPED_CHECKER_ERROR'].includes(state?.status)) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const used = Object.values(ledger?.admissions ?? {}).filter(admission => admission.accounting === 'USED');
  const actualStarts = new Set(gateway.metrics().modelStarts.filter(event => event.sessionId === sessionId && event.runId?.startsWith('rc-stop-')).map(event => event.runId));
  const expectedRun = used.length === 1 ? `rc-stop-${used[0].id}` : null;
  const initialDeviation = used.length === 1 && ledger.events.some(event => event.type === 'STOP_REVIEW_SETTLED'
    && event.stopId === used[0].stopId && event.status === 'DEVIATION');
  const finalReview = used[0]?.finalReview;
  const complete = state?.verification?.status === 'PASS' && ledger?.used === 1 && used.length === 1
    && actualStarts.size === 1 && actualStarts.has(expectedRun) && initialDeviation
    && used[0].endedAt >= used[0].startedAt && finalReview?.status === 'PASS' && finalReview.evaluationId === state.verification.evaluationId;
  const result = { mode: 'automatic-loop', initialDelivery: 'program-seeded fixture and registered initial host hooks',
    businessDispatch: 'actual installed Gateway; no injected dispatcher or trusted-start observer', complete,
    status: state?.status, verification: state?.verification?.status, used: ledger?.used,
    admissionCount: Object.keys(ledger?.admissions ?? {}).length, usedAdmissionCount: used.length,
    actualCorrectionRunIds: [...actualStarts], expectedRun, initialDeviation, finalReview, taskId: state?.taskId, sessionId, sessionKey, sessionFile,
    stops: Object.values(ledger?.stops ?? {}).map(stop => ({ id: stop.id, reviewStatus: stop.reviewStatus, control: stop.control, reasonCode: stop.reasonCode })),
    ...gateway.metrics(), outputRoot };
  if (complete) {
    const delivery = await import(pathToFileURL(file).href);
    result.deliveryChecks = [0, 7, -2].every(value => delivery.accept(value) === value + 1);
    result.complete &&= result.deliveryChecks;
  }
  return result;
}
