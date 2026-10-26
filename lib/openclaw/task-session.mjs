// Shared native transport only. The task owns its tools, protocol and completion.
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { bindTaskTools } from './task-tools.mjs';
import { assertRequiredReviewerTools, withNativeSessionLockBudget, withNativeTaskToolPolicy, withReadOnlyReviewerTools } from './native-config.mjs';
import { blockReviewerToolCall, usesReadOnlyReviewerTools } from '../reviewer-tools.mjs';
import { assertReviewerRunCompleted, reviewerEffortPrompt } from './reviewer-policy.mjs';
import { recordNativeRun } from './native-runs.mjs';
import { relayNativeReviewActivity } from './review-activity.mjs';
import { loadNativeCompatibility } from './compat-2026.10.3.mjs';
import { loadSupervisedCompatibility } from './compat-2026.7.1-2.mjs';
import { createInternalRunLease, releaseInternalRunLease } from '../runtime-v2/internal-run.mjs';
import { runInternalExecution } from './internal-context.mjs';

export async function createNativeTaskSession(input, { api, nativeRunner, selection, options = {} }) {
  const sessionId = randomUUID(), runId = randomUUID(), agentId = options.agentId ?? 'main';
  const sessionKey = `agent:${agentId}:runtime-corrector:${sessionId}`;
  const readOnlyTools = usesReadOnlyReviewerTools(input.role, input.request);
  const controller = new AbortController();
  const parents = [...new Set([input.abortSignal, options.abortSignal].filter(Boolean))];
  const cancel = () => controller.abort(parents.find(signal => signal.aborted)?.reason);
  for (const signal of parents) signal.addEventListener('abort', cancel, { once: true });
  if (parents.some(signal => signal.aborted)) cancel();
  const deadlineAt = Math.min(input.deadlineAt ?? Infinity, options.deadlineAt ?? Infinity,
    Date.now() + (input.reviewer?.timeoutMs ?? options.reviewerTimeoutMs ?? 120000));
  const timer = setTimeout(() => controller.abort(Object.assign(new Error('Task deadline exhausted'), { code: 'REVIEWER_DEADLINE' })), Math.max(0, deadlineAt - Date.now()));
  const lease = await createInternalRunLease({ projectRoot: input.projectRoot, taskId: input.taskId, role: input.role,
    ttlMs: Math.max(1800000, (input.reviewer?.timeoutMs ?? 120000) * 4) });
  let pending, unbind, removeActivity, runs = 0, closed = false, activity = Promise.resolve();
  const notify = callback => { activity = activity.then(callback).catch(() => {}); };
  const active = () => {
    controller.signal.throwIfAborted();
    if (closed) throw Object.assign(new Error('Task session closed'), { code: 'REVIEW_TASK_CLOSED' });
    if (Date.now() >= deadlineAt) throw Object.assign(new Error('Task deadline exhausted'), { code: 'REVIEWER_DEADLINE' });
  };
  async function run(worker) {
    active();
    if (pending) throw new Error('Concurrent native task runs are forbidden');
    const nativeRunId = runs++ === 0 ? runId : randomUUID(), remaining = Math.floor(deadlineAt - Date.now());
    unbind?.();
    unbind = bindTaskTools({ sessionId, sessionKey, tools: worker.tools,
      active: () => { active(); worker.active(); }, checkpoint: worker.checkpoint, observeReceipt: worker.observeReceipt });
    const completed = new AbortController(), hostSignal = AbortSignal.any([controller.signal, completed.signal]);
    const toolNames = worker.tools.map(tool => tool.name);
    assertRequiredReviewerTools(selection.config, agentId, toolNames, selection);
    const taskConfig = withNativeTaskToolPolicy(structuredClone(selection.config), agentId, toolNames);
    const config = readOnlyTools ? withReadOnlyReviewerTools(taskConfig, agentId) : taskConfig;
    const ref = `${selection.provider}/${selection.model}`;
    config.agents ??= {}; config.agents.defaults ??= {}; config.agents.defaults.models ??= {};
    const model = config.agents.defaults.models[ref] ?? {};
    config.agents.defaults.models[ref] = { ...model, params: { ...model.params, maxTokens: worker.maxTokens } };
    await recordNativeRun(input.projectRoot, { taskId: input.taskId, runId: nativeRunId, sessionId, role: input.role,
      ownerPid: process.pid, startedAt: Date.now(),sessionFile:path.join(worker.outputDir,'host-session.jsonl'), status: 'DISPATCH_COMMITTED' });
    notify(() => options.onRunStart?.(nativeRunId, { role: input.role, attemptPhase: 'isolated-task', startedAt: Date.now() }));
    if (options.activityTarget?.runId) {
      removeActivity?.();
      const sdk = await (options.compatibility ?? (api.runtime.version === '2026.10.3' ? loadNativeCompatibility : loadSupervisedCompatibility))();
      removeActivity = relayNativeReviewActivity({ sdk, parent: options.activityTarget, runId: nativeRunId, role: input.role, controller, deadlineAt });
    }
    let hostFailure, abort;
    pending = Promise.resolve().then(() => runInternalExecution(sessionId, () => nativeRunner({ sessionId, sessionKey, agentId,
      sessionFile: path.join(worker.outputDir, 'host-session.jsonl'), workspaceDir: worker.cwd, cwd: worker.cwd,
      agentDir: api.runtime.agent.resolveAgentDir?.(config, agentId), config: withNativeSessionLockBudget(config, remaining),
      provider: selection.provider, model: selection.model, agentHarnessRuntimeOverride: 'openclaw', modelFallbacksOverride: [],
      runId: nativeRunId, trigger: 'manual', lane: `runtime-corrector-reviewer:${sessionId}`,
      timeoutMs: remaining, runTimeoutOverrideMs: remaining, abortSignal: hostSignal, toolsAllow: toolNames,
      disableMessageTool: true, requireExplicitMessageTarget: true, skillsSnapshot: { prompt: '', skills: [] },
      bootstrapContextMode: 'lightweight', promptMode: 'minimal', thinkLevel: input.reviewer?.effort === 'max' ? 'high' : input.reviewer?.effort ?? 'low',
      suppressLiveStreamOutput: true, extraSystemPrompt: [...reviewerEffortPrompt(selection.model, input.reviewer?.effort), '[runtime-corrector:internal]', worker.systemPrompt].join('\n'),
      prompt: worker.prompt, onAgentToolResult: event => {
        worker.observeResult?.(event);
        if (!event.isError && worker.isComplete()) completed.abort(new Error('Task receipts committed'));
      }, onAssistantMessageStart: () => {
        try { active(); worker.onAssistantMessageStart(); }
        catch (error) { hostFailure = error; completed.abort(error); }
      }, onAgentEvent: worker.onAgentEvent }), readOnlyTools ? name => blockReviewerToolCall(name) : undefined));
    const invocation = pending;
    void invocation.finally(() => recordNativeRun(input.projectRoot, { taskId: input.taskId, runId: nativeRunId,
      sessionId, role: input.role, status: 'SETTLED', settledAt: Date.now() })).catch(() => {});
    try {
      const result = await Promise.race([invocation, new Promise((_, reject) => {
        abort = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', abort, { once: true });
        if (controller.signal.aborted) abort();
      })]);
      if (hostFailure) throw hostFailure;
      if (!worker.isComplete()) assertReviewerRunCompleted(result);
      active();
    } catch (error) {
      controller.signal.throwIfAborted();
      if (!worker.isComplete()) throw Object.assign(new Error(error.message === 'TURN_LIMIT' ? 'TURN_LIMIT' : 'Native task execution failed'), { code: error.code ?? 'REVIEWER_RUN_FAILED' });
    } finally {
      controller.signal.removeEventListener('abort', abort);
      // A cancelled host cannot keep publishing to a later repair attempt.
      unbind?.(); unbind = null; removeActivity?.(); removeActivity = null;
      void invocation.finally(() => { if (pending === invocation) pending = null; }).catch(() => {});
      notify(() => options.onRunEnd?.(nativeRunId, { role: input.role, endedAt: Date.now() }));
    }
  }
  async function close() {
    if (closed) return;
    closed = true; clearTimeout(timer); unbind?.(); removeActivity?.();
    for (const signal of parents) signal.removeEventListener('abort', cancel);
    controller.abort(new Error('Task session closed'));
    const cleanup = async () => { await nativeRunner.close?.(sessionKey, sessionId); await releaseInternalRunLease(lease); };
    if (pending) void pending.then(cleanup, cleanup).catch(() => {}); else await cleanup();
  }
  return { run, close, active, deadlineAt, signal: controller.signal, runId, sessionId, sessionKey, lease };
}
