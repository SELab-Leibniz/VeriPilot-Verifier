import { STOP_TASK_LIMITS } from '../review-task/stop-policy.mjs';
import { createNativeTaskSession } from './task-session.mjs';
import { runWorkspaceStopReview } from '../runtime-v2/stop-workspace-review.mjs';
import * as openclawHost from '../hosts/openclaw.mjs';

export function assertStopTaskInput(input) {
  if (input.role !== 'stop-reviewer' || input.request?.reviewScope?.kind !== 'workspace-stop'
    || input.workerType && input.workerType !== 'workspace-stop'
    || input.request?.workerType && input.request.workerType !== 'workspace-stop')
    throw Object.assign(new Error('Stop requires one workspace review; legacy classification, copied-source and grouped model scopes are unavailable.'),
      { code: 'STOP_TASK_SCOPE_UNSUPPORTED' });
  return 'workspace-stop';
}

export async function runOpenClawStopTask(input, dependencies) {
  if (input.abortSignal?.aborted) throw Object.assign(new Error('Stop task cancelled'), { code: 'REVIEW_COLLECTION_CANCELLED' });
  assertStopTaskInput(input);
  const now = Date.now();
  const publicationDeadlineAt = Math.min(input.deadlineAt ?? Infinity, dependencies.options?.deadlineAt ?? Infinity,
    now + (input.reviewer?.timeoutMs ?? dependencies.options?.reviewerTimeoutMs ?? 120000));
  const reserve = Math.min(3000, Math.max(0, Math.floor((publicationDeadlineAt - now) / 8)));
  const session = await createNativeTaskSession({ ...input, deadlineAt: publicationDeadlineAt - reserve,
    taskLimits: input.taskLimits ?? STOP_TASK_LIMITS }, dependencies);
  let outcome;
  try {
    outcome = await runWorkspaceStopReview({ ...input, publicationDeadlineAt, taskLimits: input.taskLimits ?? STOP_TASK_LIMITS,
      hostAdapter: openclawHost, pluginRoot: input.pluginRoot ?? dependencies.options?.pluginRoot,
      skillRoots: input.skillRoots ?? dependencies.options?.skillRoots }, { session });
    return outcome;
  } catch (error) {
    const code = typeof error.code === 'string' ? error.code : 'REVIEW_TASK_FAILED';
    throw Object.assign(new Error(`Isolated Stop review did not complete (${code}); inspect its saved trace.`),
      { code, ...(error.sourceCoverage ? { sourceCoverage: error.sourceCoverage } : {}) });
  } finally {
    const cleanup = session.close().catch(error => {
      dependencies.api?.logger?.warn?.(`Stop reviewer cleanup failed (${error.code ?? error.name})`);
    });
    if (outcome && outcome.collection?.complete !== false) await cleanup;
    else void cleanup;
  }
}
