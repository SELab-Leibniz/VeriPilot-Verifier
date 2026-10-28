import { appendTaskJournal, findTask } from './task-store.mjs';
import { eventId } from './event-identity.mjs';

export async function recordObservation(projectRoot, taskId, event) {
  try { await appendTaskJournal(projectRoot, taskId, event); }
  catch (error) { console.warn('[runtime-corrector] Response record unavailable:', error.code ?? error.name); }
}

// A hook return is not a host acknowledgement. Capture the distinction at the source.
export async function recordRuntimeResponse(options, result) {
  if (!result?.handled || !result.taskId) return;
  const task = await findTask({ projectRoot: options.projectRoot, sessionId: options.input.session_id, explicitTaskId: result.taskId });
  if (!task) return;
  const input = options.input, shadow = options.plan?.runtimeV2?.shadowMode === true;
  const kind = input.hook_event_name === 'Stop' ? 'stop' : result.watcher ? 'skill'
    : options.artifact ? 'artifact' : result.groundTruthChanged || result.groundTruthError ? 'baseline' : 'response';
  const body = result.feedback || null;
  await recordObservation(options.projectRoot, task.taskId, { type: 'RC_RESPONSE', sessionId: input.session_id,
    hookEventId: eventId(input),
    hookEventName: input.hook_event_name, toolCallId: input.tool_use_id ?? null, turnId: task.turns.total,
    kind, baselineVersion: task.groundTruth.version, baselinePending: Boolean(task.groundTruth.pendingUserCursor),
    status: result.groundTruthError ? 'UNVERIFIED' : result.status ?? result.stop?.status ?? result.watcher?.status ?? 'RESPONDED',
    reason: result.reasonCode ?? result.reason ?? result.groundTruthError ?? null,
    title: result.watcher?.skillId ?? options.artifact?.path ?? input.hook_event_name,
    feedback: { state: shadow && body ? 'SUPPRESSED' : body ? 'RETURNED' : 'NONE', text: body },
    evaluationId: input.hook_event_name === 'Stop' ? task.stop?.lastAssessmentId ?? null : null,
    watcher: result.watcher ? { skillId: result.watcher.skillId, status: result.watcher.status } : null,
  });
}
