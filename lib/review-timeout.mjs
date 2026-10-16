export const DEFAULT_REVIEW_TIMEOUT_MS = 20 * 60 * 1000;
export const MAX_REVIEW_TIMEOUT_MS = 60 * 60 * 1000;
export const MIN_REVIEW_TIMEOUT_MS = 1000;

export function resolveReviewTimeoutMs(value, label = "reviewer.timeoutMs") {
  const timeoutMs = value === undefined ? DEFAULT_REVIEW_TIMEOUT_MS : value;
  if (!Number.isInteger(timeoutMs)
    || timeoutMs < MIN_REVIEW_TIMEOUT_MS
    || timeoutMs > MAX_REVIEW_TIMEOUT_MS) {
    throw new Error(`${label} 必须是 ${MIN_REVIEW_TIMEOUT_MS} 到 ${MAX_REVIEW_TIMEOUT_MS} 之间的整数。`);
  }
  return timeoutMs;
}
