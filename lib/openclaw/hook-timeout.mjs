import { DEFAULT_REVIEW_TIMEOUT_MS, MAX_REVIEW_TIMEOUT_MS } from "../review-timeout.mjs";

export function resolveHookTimeoutMs(configured, maximum = MAX_REVIEW_TIMEOUT_MS) {
  return Math.min(configured ?? DEFAULT_REVIEW_TIMEOUT_MS, maximum);
}

export function hookReviewBudgetMs(configured, hostTimeoutMs = Infinity, maximum = MAX_REVIEW_TIMEOUT_MS) {
  // Leave the existing one-second margin for returning feedback to the host.
  return Math.max(1, Math.min(resolveHookTimeoutMs(configured, maximum), hostTimeoutMs) - 1000);
}
