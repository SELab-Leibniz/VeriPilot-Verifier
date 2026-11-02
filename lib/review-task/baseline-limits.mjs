import { DEFAULT_REVIEW_TIMEOUT_MS } from '../review-timeout.mjs';
import { STOP_TASK_LIMITS } from './stop-policy.mjs';

// Leave room for the host feedback margin below Node's signed timer ceiling.
export const MAX_BASELINE_TIMEOUT_MS = 2_147_423_647;

export function resolveBaselineLimits(value = {}, fallback = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('baselineLimits must be an object');
  const allowed = ['timeoutMs', 'maxSteps', 'maxRepairs', 'maxAuditCalls', 'maxExternalRepairs'];
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Unknown baselineLimits field');
  if (Object.values(value).some(number => number === null)) throw new Error('baselineLimits cannot contain null limits');
  const result = {
    timeoutMs: value.timeoutMs ?? fallback.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS,
    maxTurns: value.maxSteps ?? fallback.maxTurns ?? STOP_TASK_LIMITS.maxTurns,
    maxRepairs: value.maxRepairs ?? fallback.maxRepairs ?? 3,
    maxAuditCalls: value.maxAuditCalls ?? 2,
    maxExternalRepairs: value.maxExternalRepairs ?? 1,
  };
  for (const [name, number] of Object.entries(result)) {
    if (!Number.isSafeInteger(number) || number < (['maxRepairs', 'maxExternalRepairs'].includes(name) ? 0 : 1)
      || name === 'timeoutMs' && (number < 1000 || number > MAX_BASELINE_TIMEOUT_MS))
      throw new Error(`Invalid baselineLimits.${name}`);
  }
  return Object.freeze(result);
}
