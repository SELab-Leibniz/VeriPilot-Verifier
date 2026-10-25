import { runReviewTask } from '../review-task/review-task.mjs';
import { bindTaskTools, TASK_TOOL_NAMES } from './task-tools.mjs';
import { withNativeSessionLockBudget } from './native-config.mjs';
import { assertReviewerRunCompleted, reviewerEffortPrompt } from './reviewer-policy.mjs';
import { recordNativeRun } from './native-runs.mjs';
import { relayNativeReviewActivity } from './review-activity.mjs';
import { loadNativeCompatibility } from './compat-2026.10.3.mjs';
import { loadSupervisedCompatibility } from './compat-2026.7.1-2.mjs';
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runStopTaskReview } from "../runtime-v2/stop-task-review.mjs";
import { runStopTaskGroup } from "../runtime-v2/stop-task-group.mjs";
import { taskDirectory } from "../runtime-v2/task-store.mjs";
import { createInternalRunLease, releaseInternalRunLease } from "../runtime-v2/internal-run.mjs";
import { runInternalExecution } from "./internal-context.mjs";

// The host owns authentication and model execution. RC never opens an auth store.
export async function runOpenClawStopTask(input, { api, nativeRunner, selection, options = {} }) {
  const runId = randomUUID(), sessionId = randomUUID();
  const lease = await createInternalRunLease({ projectRoot: input.projectRoot, taskId: input.taskId, role: input.role,
    ttlMs: Math.max(1800000, (input.reviewer?.timeoutMs ?? 120000) * 4) });
  // Notification callbacks are telemetry; neither callback failures nor slow
  // cleanup may erase a submitted decision or hold the Stop collector open.
  let activity = Promise.resolve();
  const notify = callback => { activity = activity.then(callback).catch(() => {}); };
  notify(() => options.onRunStart?.(runId, { role: input.role, attemptPhase: "isolated-task", startedAt: Date.now() }));
  try {
    const agentId = options.agentId ?? 'main';
    const sessionKey = `agent:${agentId}:runtime-corrector:${sessionId}`;
    const controller = new AbortController();
    const parentSignal = input.abortSignal ?? options.abortSignal;
    const cancel = () => controller.abort(parentSignal.reason);
    parentSignal?.addEventListener('abort', cancel, { once: true });
    if (parentSignal?.aborted) cancel();
    const deadlineAt = Math.min(input.deadlineAt ?? Infinity, options.deadlineAt ?? Infinity,
      Date.now() + (input.reviewer?.timeoutMs ?? options.reviewerTimeoutMs ?? 120000));
    const timer = setTimeout(() => controller.abort(Object.assign(new Error('Review deadline exhausted'), { code: 'REVIEWER_DEADLINE' })), Math.max(0, deadlineAt - Date.now()));
    let pending, unbind, removeActivity, hostRuns = 0;
    const close = async () => {
      unbind?.();
      await nativeRunner.close?.(sessionKey, sessionId);
    };
    const nativeRun = async worker => {
      const nativeRunId = hostRuns++ === 0 ? runId : randomUUID();
      controller.signal.throwIfAborted();
      const remaining = Math.floor(deadlineAt - Date.now());
      if (remaining <= 0) throw Object.assign(new Error('Review deadline exhausted'), { code: 'REVIEWER_DEADLINE' });
      unbind?.();
      unbind = bindTaskTools({ sessionId, sessionKey, tools: worker.tools,
        active: () => { controller.signal.throwIfAborted(); worker.active(); }, checkpoint: worker.checkpoint, observeReceipt: worker.observeReceipt });
      const completed = new AbortController();
      let hostFailure;
      const hostSignal = AbortSignal.any([controller.signal, completed.signal]);
      const config = structuredClone(selection.config);
      const ref = `${selection.provider}/${selection.model}`;
      config.agents ??= {}; config.agents.defaults ??= {}; config.agents.defaults.models ??= {};
      const currentModel = config.agents.defaults.models[ref] ?? {};
      config.agents.defaults.models[ref] = { ...currentModel, params: { ...currentModel.params, maxTokens: worker.maxTokens } };
      // This private native run exposes only the bound evidence protocol.
      config.tools = { ...config.tools, allow: TASK_TOOL_NAMES };
      await recordNativeRun(input.projectRoot, { taskId: input.taskId, runId: nativeRunId, sessionId, role: input.role,
        ownerPid: process.pid, startedAt: Date.now(), status: 'DISPATCH_COMMITTED' });
      if (options.activityTarget?.runId) {
        removeActivity?.();
        const sdk = await (options.compatibility ?? (api.runtime.version === '2026.10.3' ? loadNativeCompatibility : loadSupervisedCompatibility))();
        removeActivity = relayNativeReviewActivity({ sdk, parent: options.activityTarget, runId: nativeRunId, role: input.role, controller, deadlineAt });
      }
      pending = Promise.resolve().then(() => nativeRunner({ sessionId, sessionKey, agentId,
        sessionFile: path.join(worker.outputDir, 'host-session.jsonl'),
        workspaceDir: worker.cwd, cwd: worker.cwd, agentDir: api.runtime.agent.resolveAgentDir?.(config, agentId),
        config: withNativeSessionLockBudget(config, remaining), provider: selection.provider, model: selection.model,
        agentHarnessRuntimeOverride: 'openclaw', modelFallbacksOverride: [], runId: nativeRunId, trigger: 'manual',
        lane: `runtime-corrector-reviewer:${sessionId}`, timeoutMs: remaining, runTimeoutOverrideMs: remaining,
        abortSignal: hostSignal, toolsAllow: TASK_TOOL_NAMES, disableMessageTool: true,
        requireExplicitMessageTarget: true, skillsSnapshot: { prompt: '', skills: [] },
        bootstrapContextMode: 'lightweight', promptMode: 'minimal', thinkLevel: input.reviewer?.effort === 'max' ? 'high' : input.reviewer?.effort ?? 'low',
        suppressLiveStreamOutput: true, extraSystemPrompt: [...reviewerEffortPrompt(selection.model, input.reviewer?.effort), '[runtime-corrector:internal]', worker.systemPrompt].join('\n'),
        prompt: worker.prompt, onAgentToolResult: event => {
          worker.observeResult(event);
          if (event.toolName === 'submit_review' && !event.isError && worker.isComplete()) completed.abort(new Error('Review receipts committed'));
        },
        onAssistantMessageStart: () => {
          try { worker.onAssistantMessageStart(); }
          catch (error) { hostFailure = error; completed.abort(error); }
        }, onAgentEvent: worker.onAgentEvent }));
      void pending.then(() => recordNativeRun(input.projectRoot, { taskId: input.taskId, runId: nativeRunId, sessionId, role: input.role,
        status: 'SETTLED', settledAt: Date.now() }), () => recordNativeRun(input.projectRoot, { taskId: input.taskId, runId: nativeRunId, sessionId, role: input.role,
        status: 'SETTLED', settledAt: Date.now() })).catch(() => {});
      let abort;
      try {
        const result = await Promise.race([pending, new Promise((_, reject) => {
          abort = () => reject(controller.signal.reason); controller.signal.addEventListener('abort', abort, { once: true });
          if (controller.signal.aborted) abort();
        })]);
        if (hostFailure) throw hostFailure;
        if (!worker.isComplete()) assertReviewerRunCompleted(result);
        controller.signal.throwIfAborted();
      } catch (error) {
        controller.signal.throwIfAborted();
        if (!worker.isComplete()) throw Object.assign(new Error(error.message === 'TURN_LIMIT' ? 'TURN_LIMIT' : 'Native review execution failed; inspect the isolated host trace.'), { code: error.code ?? 'REVIEWER_RUN_FAILED' });
      } finally { controller.signal.removeEventListener('abort', abort); }
    };
    try {
      const execute = input.request.reviewScope?.kind === "stop-group" ? runStopTaskGroup : runStopTaskReview;
      const result = await runInternalExecution(sessionId, () => execute({ ...input,
        pluginRoot: options.pluginRoot, skillRoots: options.skillRoots,
        abortSignal: controller.signal,
        onReviewEvent: event => {
          if (event.type === "tool") notify(() => options.onTool?.({ runId, role: input.role, name: `source_${event.name}`, args: event.args }));
        } }, { runTask: worker => runReviewTask({ ...worker, nativeRun,
          model: { id: selection.model, provider: selection.provider } }) }));
      return { ...result, lease, sessionId };
    } finally {
      clearTimeout(timer); parentSignal?.removeEventListener('abort', cancel); removeActivity?.(); unbind?.();
      // A host ignoring cancellation cannot retain tools or publish late reads.
      // Defer transcript cleanup until that host invocation actually settles.
      if (pending) void pending.then(close, close).catch(() => {});
      else await close();
    }
  } catch (error) {
    // Provider errors may echo request headers. Preserve a public code, never a
    // raw network message containing authentication or provider configuration.
    const code = typeof error.code === "string" ? error.code : "REVIEW_TASK_FAILED";
    const diagnostic = error.reviewDiagnostic;
    const allowed = new Set(["CONTEXT_UNSAFE", "CONTEXT_COMPACTION_FAILED", "CHECKPOINT_FAILED", "TURN_LIMIT", "NO_VALID_SUBMISSION"]);
    const diagnosticRoot = path.resolve(taskDirectory(input.projectRoot, input.taskId), "review-task-runs");
    const relative = typeof diagnostic?.resultPath === "string" ? path.relative(diagnosticRoot, path.resolve(diagnostic.resultPath)) : null;
    const safeDiagnostic = allowed.has(diagnostic?.cause) && relative && relative !== ".."
      && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) && path.basename(relative) === "result.json"
      ? { cause: diagnostic.cause, resultPath: path.resolve(diagnostic.resultPath) } : null;
    throw Object.assign(new Error(safeDiagnostic
      ? `Isolated Stop review did not complete (${safeDiagnostic.cause}). Details: ${safeDiagnostic.resultPath}`
      : `Isolated Stop review did not complete (${code}); inspect its saved trace.`),
    { code, ...(safeDiagnostic ? { reviewDiagnostic: safeDiagnostic } : {}) });
  } finally {
    notify(() => options.onRunEnd?.(runId, { role: input.role, endedAt: Date.now() }));
    void releaseInternalRunLease(lease).catch(() => {});
  }
}
