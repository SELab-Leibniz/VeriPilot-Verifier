import path from 'node:path';
import { runReviewTask } from '../review-task/review-task.mjs';
import { runStopTaskReview, canUseStopTaskReview } from '../runtime-v2/stop-task-review.mjs';
import { runStopTaskGroup, canUseStopTaskGroup } from '../runtime-v2/stop-task-group.mjs';
import { runStopClassificationTask } from '../runtime-v2/stop-classification-task.mjs';
import { runStopFindingsTask } from '../runtime-v2/stop-findings-task.mjs';
import { STOP_TASK_LIMITS } from '../review-task/stop-policy.mjs';
import { taskDirectory } from '../runtime-v2/task-store.mjs';
import { createNativeTaskSession } from './task-session.mjs';

export function assertStopTaskInput(input) {
  const scope = input.request?.reviewScope, classification = input.request?.fixedStopClassification;
  let type;
  if (input.role === 'stop-reviewer' && scope?.kind === 'classification') type = 'classification';
  else if (input.role === 'stop-reviewer' && scope?.findingsOnly === true
    && ['INTERMEDIATE', 'WAITING_FOR_USER', 'BLOCKED_EXTERNAL'].includes(classification?.stopClassification)) type = 'findings';
  else if (scope?.kind === 'stop-group' && canUseStopTaskGroup(input)) type = 'review-group';
  else if (canUseStopTaskReview(input)) type = scope?.kind === 'file-quality' ? 'file-quality' : 'review';
  if (!type || input.workerType && input.workerType !== type || input.request?.workerType && input.request.workerType !== type)
    throw Object.assign(new Error('Unsupported or inconsistent Stop task scope; legacy review is unavailable.'),
      { code: scope?.kind === 'stop-group' ? 'STOP_GROUP_UNSUPPORTED' : 'STOP_TASK_SCOPE_UNSUPPORTED' });
  return type;
}

export async function runOpenClawStopTask(input, dependencies) {
  if (input.abortSignal?.aborted) throw Object.assign(new Error('Stop task cancelled'), { code: 'REVIEW_COLLECTION_CANCELLED' });
  const workerType = assertStopTaskInput(input);
  input = { ...input, taskLimits: input.taskLimits ?? STOP_TASK_LIMITS };
  const session = await createNativeTaskSession(input, dependencies);
  try {
    if (workerType === 'classification' || workerType === 'findings') {
      const execute = workerType === 'classification' ? runStopClassificationTask : runStopFindingsTask;
      return await execute(input, { session });
    }
    const execute = input.request.reviewScope?.kind === 'stop-group' ? runStopTaskGroup : runStopTaskReview;
    const result = await execute({ ...input,
      pluginRoot: dependencies.options?.pluginRoot, skillRoots: dependencies.options?.skillRoots,
      abortSignal: session.signal,
      onReviewEvent: event => {
        if (event.type === 'tool') void Promise.resolve().then(() => dependencies.options?.onTool?.({
          runId: session.runId, role: input.role, name: `source_${event.name}`, args: event.args })).catch(() => {});
      },
    }, { runTask: worker => runReviewTask({ ...worker, nativeRun: session.run,
      model: { id: dependencies.selection.model, provider: dependencies.selection.provider } }) });
    return { ...result, lease: session.lease, sessionId: session.sessionId };
  } catch (error) {
    const code = typeof error.code === 'string' ? error.code : 'REVIEW_TASK_FAILED';
    const diagnostic = error.reviewDiagnostic;
    const allowed = new Set(['CONTEXT_UNSAFE', 'CONTEXT_COMPACTION_FAILED', 'CHECKPOINT_FAILED', 'TURN_LIMIT', 'NO_VALID_SUBMISSION']);
    const root = path.resolve(taskDirectory(input.projectRoot, input.taskId), 'review-task-runs');
    const relative = typeof diagnostic?.resultPath === 'string' ? path.relative(root, path.resolve(diagnostic.resultPath)) : null;
    const safeDiagnostic = allowed.has(diagnostic?.cause) && relative && relative !== '..'
      && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) && path.basename(relative) === 'result.json'
      ? { cause: diagnostic.cause, resultPath: path.resolve(diagnostic.resultPath) } : null;
    throw Object.assign(new Error(safeDiagnostic
      ? `Isolated Stop review did not complete (${safeDiagnostic.cause}). Details: ${safeDiagnostic.resultPath}`
      : `Isolated Stop review did not complete (${code}); inspect its saved trace.`),
    { code, ...(safeDiagnostic ? { reviewDiagnostic: safeDiagnostic } : {}),
      ...(workerType === 'findings' && error.partialReview ? { partialReview: error.partialReview,
        partialReviewIsActive: () => !input.abortSignal?.aborted && Date.now() < (input.deadlineAt ?? Infinity) } : {}) });
  } finally { await session.close(); }
}
