import path from 'node:path';
import { runReviewTask } from '../review-task/review-task.mjs';
import { runStopTaskReview } from '../runtime-v2/stop-task-review.mjs';
import { runStopTaskGroup } from '../runtime-v2/stop-task-group.mjs';
import { taskDirectory } from '../runtime-v2/task-store.mjs';
import { createNativeTaskSession } from './task-session.mjs';

export async function runOpenClawStopTask(input, dependencies) {
  const session = await createNativeTaskSession(input, dependencies);
  try {
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
    { code, ...(safeDiagnostic ? { reviewDiagnostic: safeDiagnostic } : {}) });
  } finally { await session.close(); }
}
