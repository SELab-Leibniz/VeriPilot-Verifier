import { DEFAULT_REVIEW_TIMEOUT_MS, resolveReviewTimeoutMs } from '../../lib/review-timeout.mjs';

// One explicit ceiling follows the original request, private reviewers, Stop
// assessment, correction host and observer. A parent may still end sooner.
export function nativeStopTimeouts(value = DEFAULT_REVIEW_TIMEOUT_MS) {
  const wallMs = resolveReviewTimeoutMs(value, '--timeout-ms');
  if (wallMs < 2000 || wallMs % 1000 !== 0)
    throw new Error('--timeout-ms must be a whole number of seconds, at least 2000 ms.');
  const feedbackReserveMs = Math.min(30000, Math.floor(wallMs / 10));
  return Object.freeze({ wallMs, phaseTimeoutMs: wallMs,
    assessmentTimeoutMs: wallMs, feedbackReserveMs,
    reviewerTimeoutMs: wallMs - feedbackReserveMs });
}
