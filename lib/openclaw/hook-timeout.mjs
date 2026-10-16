const DEFAULT_HOOK_TIMEOUT_MS = 1200000;
const MAX_HOOK_TIMEOUT_MS = 3600000;

export function resolveHookTimeoutMs(configured) {
  return Math.min(configured ?? DEFAULT_HOOK_TIMEOUT_MS, MAX_HOOK_TIMEOUT_MS);
}

export function hookReviewBudgetMs(configured, hostTimeoutMs = Infinity) {
  // Leave the existing one-second margin for returning feedback to the host.
  return Math.max(1, Math.min(resolveHookTimeoutMs(configured), hostTimeoutMs) - 1000);
}
