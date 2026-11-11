// Stop-only execution settings. Generic workers and other hosts retain their
// own defaults; the OpenClaw Stop dispatcher explicitly supplies this policy.
export const STOP_TASK_LIMITS = Object.freeze({ maxTurns: 200, maxTokens: 32768, maxAttempts: 2 });
export function resolveStopTaskLimits(maxReviewSteps = STOP_TASK_LIMITS.maxTurns) {
  if (!Number.isSafeInteger(maxReviewSteps) || maxReviewSteps < 1)
    throw new Error('stopCorrection.maxReviewSteps must be a positive safe integer');
  return Object.freeze({ ...STOP_TASK_LIMITS, maxTurns: maxReviewSteps });
}
export const STOP_TASK_PROTOCOL = 'openclaw-stop-task-v8-local-citation-labels';
