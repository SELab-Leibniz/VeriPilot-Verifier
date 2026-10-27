// Stop-only execution settings. Generic workers and other hosts retain their
// own defaults; the OpenClaw Stop dispatcher explicitly supplies this policy.
export const STOP_TASK_LIMITS = Object.freeze({ maxTurns: 200, maxTokens: 32768, maxAttempts: 2 });
export const STOP_TASK_PROTOCOL = 'openclaw-stop-task-v3';
