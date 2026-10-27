export const DEFAULT_MAX_OUTPUT_TOKENS = 32768;

export function resolveMaxOutputTokens(value = DEFAULT_MAX_OUTPUT_TOKENS, label = 'maxOutputTokens') {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive safe integer`);
  return value;
}

// Child-process overrides stay private to RC; never change the parent's env.
export function withAgentOutputEnvironment(env, maxOutputTokens) {
  return { ...env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(resolveMaxOutputTokens(maxOutputTokens)) };
}
