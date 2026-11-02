// Shared native transport only. The task owns its tools, protocol and completion.
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { bindTaskTools } from './task-tools.mjs';
import { assertRequiredReviewerTools, withNativeSessionLockBudget, withNativeTaskToolPolicy, withReadOnlyReviewerTools, withNativeMaxOutputTokens, withPrivateReviewMemoryPolicy, PRIVATE_REVIEW_MEMORY_POLICY } from './native-config.mjs';
import { blockReviewerToolCall, usesReadOnlyReviewerTools } from '../reviewer-tools.mjs';
import { assertReviewerRunCompleted, reviewerEffortPrompt } from './reviewer-policy.mjs';
import { recordNativeRun, listNativeRuns } from './native-runs.mjs';
import { relayNativeReviewActivity } from './review-activity.mjs';
import { loadNativeCompatibility } from './compat-2026.10.3.mjs';
import { loadSupervisedCompatibility } from './compat-2026.7.1-2.mjs';
import { createInternalRunLease, releaseInternalRunLease } from '../runtime-v2/internal-run.mjs';
import { runInternalExecution } from './internal-context.mjs';
import { acquireBaselineAgent } from './baseline-agent.mjs';
import { taskDirectory } from '../runtime-v2/task-store.mjs';
import { atomicWriteJson } from '../runtime-v2/utils.mjs';
import { outsideDecision } from '../runtime-v2/decision-scope.mjs';

export async function createNativeTaskSession(input, { api, nativeRunner, selection, options = {} }) {
  let sessionId = randomUUID();
  const runId = randomUUID(), agentId = options.agentId ?? 'main';
  selection = { ...selection, config: withPrivateReviewMemoryPolicy(selection.config, agentId),
    privateReviewMemoryPolicy: PRIVATE_REVIEW_MEMORY_POLICY };
  let sessionKey = `agent:${agentId}:runtime-corrector:${sessionId}`, extractor;
  const readOnlyTools = input.role === 'stop-reviewer' || Boolean(input.stopTask) || usesReadOnlyReviewerTools(input.role, input.request);
  const controller = new AbortController();
  const parents = [...new Set([input.abortSignal, options.abortSignal].filter(Boolean))];
  const cancel = () => controller.abort(parents.find(signal => signal.aborted)?.reason);
  for (const signal of parents) signal.addEventListener('abort', cancel, { once: true });
  if (parents.some(signal => signal.aborted)) cancel();
  const deadlineAt = Math.min(input.deadlineAt ?? Infinity, options.deadlineAt ?? Infinity,
    Date.now() + (input.reviewer?.timeoutMs ?? options.reviewerTimeoutMs ?? 120000));
  const timer = setTimeout(() => controller.abort(Object.assign(new Error('Task deadline exhausted'), { code: 'REVIEWER_DEADLINE' })), Math.max(0, deadlineAt - Date.now()));
  const baseline = input.role === 'ground-truth-extractor' && input.request?.reviewScope?.boundedBasis === true;
  let activity = Promise.resolve(), lastPhase, candidateComplete = false;
  const notify = callback => { activity = activity.then(callback).catch(() => {}); };
  function reportPhase(phase) {
    if (!baseline || phase === lastPhase) return activity;
    lastPhase = phase;
    const status = { taskId: input.taskId, runId, sessionId, phase, pid: process.pid,
      updatedAt: Date.now(), deadlineAt, navigationOnly: true };
    // Side-channel progress must be visible while the enclosing decision is
    // still pending. It never enters host messages or establishes a verdict.
    notify(() => outsideDecision(() => atomicWriteJson(path.join(taskDirectory(input.projectRoot, input.taskId), 'baseline-extraction-status.json'), status)));
    return activity;
  }
  let lease;
  try {
    if (baseline) {
      await reportPhase('QUEUED');
      extractor = await acquireBaselineAgent({ owner: api, projectRoot: input.projectRoot, agentId, selection,
        signal: controller.signal, deadlineAt, dispose: async (key, id) => { await nativeRunner.close?.(key, id); } });
      ({ sessionId, sessionKey } = extractor);
    }
    lease = await createInternalRunLease({ projectRoot: input.projectRoot, taskId: input.taskId, role: input.role,
      ttlMs: Math.max(1800000, (input.reviewer?.timeoutMs ?? 120000) * 4) });
  } catch (error) {
    clearTimeout(timer); for (const signal of parents) signal.removeEventListener('abort', cancel);
    await reportPhase('INTERRUPTED'); await extractor?.release(); throw error;
  }
  let pending, unbind, removeActivity, runs = 0, closed = false, settlement = Promise.resolve();
  const ownedRuns = new Map();
  const active = () => {
    controller.signal.throwIfAborted();
    if (closed) throw Object.assign(new Error('Task session closed'), { code: 'REVIEW_TASK_CLOSED' });
    if (Date.now() >= deadlineAt) throw Object.assign(new Error('Task deadline exhausted'), { code: 'REVIEWER_DEADLINE' });
  };
  // Waiting is separate from close: the same extractor must remain repairable.
  async function awaitOwnedSettlement() {
    active();
    const owned = [...ownedRuns.values()];
    const unverified = (message, cause) => Object.assign(new Error(message, { cause }), { code: 'OWNED_SETTLEMENT_UNVERIFIED' });
    if (!owned.length) throw unverified('No owned native dispatch can establish settlement');
    async function wait(operation) {
      active();
      let abort;
      try {
        const value = await Promise.race([Promise.resolve().then(() => { active(); return operation(); }), new Promise((_, reject) => {
          abort = () => reject(controller.signal.reason);
          controller.signal.addEventListener('abort', abort, { once: true });
          if (controller.signal.aborted) abort();
        })]);
        active(); return value;
      } finally { controller.signal.removeEventListener('abort', abort); }
    }
    if (owned.some(run => !run.invocation || !run.settlement))
      throw unverified('An owned native dispatch has no tracked invocation and settlement');
    await wait(() => Promise.all(owned.map(run => Promise.all([run.invocation, run.settlement]))));
    for (const run of owned) if (run.settlementFailed)
      throw unverified('An owned native settlement could not be recorded', run.settlementFailure);
    const records = await wait(() => listNativeRuns(input.projectRoot, input.taskId));
    if (ownedRuns.size !== owned.length || owned.some(run => ownedRuns.get(run.identity.runId) !== run))
      throw unverified('Owned native dispatches changed while checking settlement');
    for (const run of owned) {
      const matches = records.filter(record => record.runId === run.identity.runId);
      if (matches.length !== 1) throw unverified('An owned native settlement record is missing or duplicated');
      const record = matches[0];
      if (['taskId', 'sessionId', 'runId', 'role', 'ownerPid', 'startedAt', 'sessionFile']
        .some(key => record[key] !== run.identity[key]) || record.status !== 'SETTLED'
        || !Number.isFinite(record.settledAt))
        throw unverified('An owned native settlement record has a foreign identity or is not SETTLED');
    }
    active();
    return { taskId: owned[0].identity.taskId, sessionId, role: owned[0].identity.role,
      ownerPid: owned[0].identity.ownerPid, status: 'SETTLED', runIds: owned.map(run => run.identity.runId) };
  }
  async function run(worker) {
    active();
    if (pending) throw new Error('Concurrent native task runs are forbidden');
    if (worker.nativeOwner && ownedRuns.size) { await settlement; active(); }
    candidateComplete = false;
    await reportPhase(worker.phase?.() ?? 'READING');
    const nativeRunId = runs++ === 0 ? runId : randomUUID();
    const completed = new AbortController(), hostSignal = AbortSignal.any([controller.signal, completed.signal]);
    unbind?.();
    const toolNames = worker.tools.map(tool => tool.name);
    assertRequiredReviewerTools(selection.config, agentId, toolNames, selection);
    const taskConfig = withNativeTaskToolPolicy(structuredClone(selection.config), agentId, toolNames);
    const config = withNativeMaxOutputTokens(readOnlyTools ? withReadOnlyReviewerTools(taskConfig, agentId) : taskConfig,
      selection.provider, selection.model, input.taskLimits?.maxTokens ?? input.reviewer?.maxOutputTokens ?? worker.maxTokens ?? options.maxOutputTokens, agentId);
    const sessionFile = extractor?.sessionFile ?? path.join(worker.outputDir, 'host-session.jsonl');
    const nativeRecord = Object.freeze({ taskId: input.taskId, runId: nativeRunId, sessionId, role: input.role,
      ownerPid: process.pid, startedAt: Date.now(), sessionFile, status: 'DISPATCH_COMMITTED' });
    await recordNativeRun(input.projectRoot, nativeRecord);
    await worker.bindNative?.(nativeRecord);
    active();
    unbind = bindTaskTools({ sessionId, sessionKey, runId: nativeRunId, agentId, signal: hostSignal, tools: worker.tools,
      active: () => { active(); worker.active(); }, checkpoint: worker.checkpoint, observeReceipt: worker.observeReceipt,
      nativeOwner: worker.nativeOwner });
    const ownedRun = { identity: nativeRecord, invocation: null, settlement: null, settlementFailed: false, settlementFailure: null };
    ownedRuns.set(nativeRunId, ownedRun);
    notify(() => options.onRunStart?.(nativeRunId, { role: input.role, attemptPhase: 'isolated-task', startedAt: Date.now() }));
    if (options.activityTarget?.runId) {
      removeActivity?.();
      const sdk = await (options.compatibility ?? (api.runtime.version === '2026.10.3' ? loadNativeCompatibility : loadSupervisedCompatibility))();
      removeActivity = relayNativeReviewActivity({ sdk, parent: options.activityTarget, runId: nativeRunId, role: input.role, controller, deadlineAt });
      removeActivity.stage?.(worker.phase?.());
    }
    let hostFailure, abort;
    pending = Promise.resolve().then(() => {
      active(); const remaining = Math.max(1, Math.floor(deadlineAt - Date.now()));
      return runInternalExecution(sessionId, () => {
      const params = { sessionId, sessionKey, agentId,
      sessionFile, workspaceDir: worker.cwd, cwd: worker.cwd,
      agentDir: api.runtime.agent.resolveAgentDir?.(config, agentId), config: withNativeSessionLockBudget(config, remaining),
      provider: selection.provider, model: selection.model, agentHarnessRuntimeOverride: 'openclaw', modelFallbacksOverride: [],
      runId: nativeRunId, trigger: 'manual', lane: `runtime-corrector-reviewer:${sessionId}`,
      timeoutMs: remaining, runTimeoutOverrideMs: remaining, abortSignal: hostSignal, toolsAllow: toolNames,
      disableMessageTool: true, requireExplicitMessageTarget: true, skillsSnapshot: { prompt: '', skills: [] },
      bootstrapContextMode: 'lightweight', promptMode: 'minimal', thinkLevel: input.reviewer?.effort === 'max' ? 'high' : input.reviewer?.effort ?? 'low',
      suppressLiveStreamOutput: true, extraSystemPrompt: [...reviewerEffortPrompt(selection.model, input.reviewer?.effort), '[runtime-corrector:internal]', worker.systemPrompt].join('\n'),
      prompt: worker.prompt, onAgentToolResult: event => {
        worker.observeResult?.(event);
        removeActivity?.stage?.(worker.phase?.());
        if (!closed && !controller.signal.aborted) {
          candidateComplete = worker.phase?.() === 'CANDIDATE_COMPLETE';
          reportPhase(worker.phase?.() ?? 'READING');
        }
        if (!event.isError && worker.isComplete()) completed.abort(new Error('Task receipts committed'));
      }, onAssistantMessageStart: () => {
        try { active(); worker.onAssistantMessageStart({ runId: nativeRunId, sessionId }); }
        catch (error) { hostFailure = error; completed.abort(error); }
      }, onAgentEvent: worker.onAgentEvent };
      active(); params.timeoutMs = params.runTimeoutOverrideMs = Math.max(1, Math.floor(deadlineAt - Date.now()));
      return nativeRunner(params);
      }, readOnlyTools ? name => blockReviewerToolCall(name) : undefined);
    });
    const invocation = pending;
    ownedRun.invocation = invocation.then(() => {}, () => {});
    const previousSettlement = settlement;
    settlement = invocation.finally(async () => {
      try {
        await recordNativeRun(input.projectRoot, { taskId: input.taskId, runId: nativeRunId,
          sessionId, role: input.role, status: 'SETTLED', settledAt: Date.now() });
        await worker.closeNativeWindow?.(nativeRecord);
      } catch (error) { ownedRun.settlementFailed = true; ownedRun.settlementFailure = error; throw error; }
    }).catch(() => {});
    ownedRun.settlement = settlement;
    settlement = Promise.all([previousSettlement, settlement]).then(() => {});
    try {
      const result = await Promise.race([invocation, new Promise((_, reject) => {
        abort = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', abort, { once: true });
        if (controller.signal.aborted) abort();
      })]);
      if (hostFailure) throw hostFailure;
      if (!worker.isComplete()) assertReviewerRunCompleted(result);
      candidateComplete = worker.phase?.() === 'CANDIDATE_COMPLETE';
      await reportPhase(worker.phase?.() ?? 'READING');
      active();
    } catch (error) {
      controller.signal.throwIfAborted();
      // Retain RC's own validation diagnostic; provider/host errors remain redacted.
      if (!worker.isComplete() && error.baselineValidation
        && ['BASELINE_SCOPE_INVALID', 'BASELINE_REPAIR_LIMIT'].includes(error.code)) throw error;
      if (!worker.isComplete()) throw Object.assign(new Error(error.message === 'TURN_LIMIT' ? 'TURN_LIMIT' : 'Native task execution failed'), { code: error.code ?? 'REVIEWER_RUN_FAILED' });
    } finally {
      controller.signal.removeEventListener('abort', abort);
      // A cancelled host cannot keep publishing to a later repair attempt.
      unbind?.(); unbind = null; removeActivity?.(); removeActivity = null;
      completed.abort(new Error('Task host run settled'));
      void invocation.finally(() => { if (pending === invocation) pending = null; }).catch(() => {});
      notify(() => options.onRunEnd?.(nativeRunId, { role: input.role, endedAt: Date.now() }));
    }
  }
  async function close() {
    if (closed) return;
    closed = true; clearTimeout(timer); unbind?.(); removeActivity?.();
    for (const signal of parents) signal.removeEventListener('abort', cancel);
    controller.abort(new Error('Task session closed'));
    const cleanup = async () => {
      await settlement;
      await reportPhase(candidateComplete ? 'CANDIDATE_COMPLETE' : 'INTERRUPTED');
      try { if (extractor) await extractor.release(); else await nativeRunner.close?.(sessionKey, sessionId); }
      finally { await releaseInternalRunLease(lease); }
    };
    if (pending) void pending.then(cleanup, cleanup).catch(() => {}); else await cleanup();
  }
  return { run, close, active, awaitOwnedSettlement, deadlineAt, signal: controller.signal, runId, sessionId, sessionKey, lease,
    extractorReused: extractor?.reused ?? false };
}
