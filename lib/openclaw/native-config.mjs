// Private sessions may legitimately wait for tool reviews longer than the
// host's default five-minute transcript lock. Keep the lock bounded by this
// run, without changing global settings or an explicit operator lock policy.
export function withNativeSessionLockBudget(config, timeoutMs) {
  if (config?.session?.writeLock?.maxHoldMs !== undefined) return config;
  return { ...config, session: { ...config?.session, writeLock: {
    ...config?.session?.writeLock, maxHoldMs: Math.max(300000, Math.ceil(timeoutMs) + 5000),
  } } };
}
