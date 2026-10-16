import { DEFAULT_REVIEW_TIMEOUT_MS, MAX_REVIEW_TIMEOUT_MS } from "../review-timeout.mjs";

export function resolveHookTimeoutMs(configured) {
  return Math.min(configured ?? DEFAULT_REVIEW_TIMEOUT_MS, MAX_REVIEW_TIMEOUT_MS);
}

export function hookReviewBudgetMs(configured, hostTimeoutMs = Infinity) {
  // Leave the existing one-second margin for returning feedback to the host.
  return Math.max(1, Math.min(resolveHookTimeoutMs(configured), hostTimeoutMs) - 1000);
}
