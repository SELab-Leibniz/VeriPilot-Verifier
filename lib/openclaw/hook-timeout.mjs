import { DEFAULT_REVIEW_TIMEOUT_MS, MAX_REVIEW_TIMEOUT_MS } from "../review-timeout.mjs";

export const MAX_HOT_HOOK_TIMEOUT_MS = 10_000;
export const isHotHook = name => ["before_tool_call", "before_prompt_build", "reply_payload_sending", "agent_end"].includes(name);

export function hotHookTimeoutMs(configured) {
  return Math.min(resolveHookTimeoutMs(configured), MAX_HOT_HOOK_TIMEOUT_MS);
}

export function resolveHookTimeoutMs(configured, maximum = MAX_REVIEW_TIMEOUT_MS) {
  return Math.min(configured ?? DEFAULT_REVIEW_TIMEOUT_MS, maximum);
}

export function hookReviewBudgetMs(configured, hostTimeoutMs = Infinity, maximum = MAX_REVIEW_TIMEOUT_MS) {
  // Leave the existing one-second margin for returning feedback to the host.
  return Math.max(1, Math.min(resolveHookTimeoutMs(configured, maximum), hostTimeoutMs) - 1000);
}
