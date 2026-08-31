import { eventId } from "./event-identity.mjs";
import { inspectInternalRun } from "./internal-run.mjs";
import { appendTaskJournal, findTask } from "./task-store.mjs";


function explicitTaskId(env) {
  return env.RUNTIME_CORRECTOR_TASK_ID ?? null;
}


/**
 * Record the lifecycle boundary without loading project configuration or
 * traversing recovery state. SessionStart owns cleanup of interrupted work.
 */
export async function handleRuntimeV2SessionEnd({ input, projectRoot, env = process.env }) {
  try {
    const internal = await inspectInternalRun(env);
    if (internal.internal) return { handled: true, internal: true, skipped: "SKIPPED_INTERNAL" };
    const task = await findTask({
      projectRoot,
      sessionId: input.session_id,
      explicitTaskId: explicitTaskId(env),
    });
    if (task) {
      await appendTaskJournal(projectRoot, task.taskId, {
        type: "HOOK_EVENT",
        hookEventId: eventId(input),
        hookEventName: "SessionEnd",
        toolName: null,
        lifecycleOnly: true,
      });
    }
    return {
      handled: true,
      taskId: task?.taskId ?? null,
      reason: task ? "SESSION_END_RECORDED" : "SESSION_END_TASKLESS",
    };
  } catch {
    return { handled: true, taskId: null, reason: "SESSION_END_FAIL_OPEN" };
  }
}
