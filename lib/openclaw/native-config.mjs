// Private sessions may legitimately wait for tool reviews longer than the
// host's default five-minute transcript lock. Keep the lock bounded by this
// run, without changing global settings or an explicit operator lock policy.
export function withNativeSessionLockBudget(config, timeoutMs) {
  if (config?.session?.writeLock?.maxHoldMs !== undefined) return config;
  return { ...config, session: { ...config?.session, writeLock: {
    ...config?.session?.writeLock, maxHoldMs: Math.max(300000, Math.ceil(timeoutMs) + 5000),
  } } };
}

// An explicit runtime allowlist narrows tools after the host's profile filter;
// it does not grant plugin tools through that filter. Grant only this private
// run's protocol on its selected agent, preserving inherited extras and denies.
export function withNativeTaskToolPolicy(config, agentId, toolNames) {
  const agents = config.agents?.list ?? [];
  const current = agents.find(agent => agent.id === agentId) ?? { id: agentId };
  const reviewer = { ...current, tools: { ...current.tools,
    alsoAllow: [...new Set([...(current.tools?.alsoAllow ?? config.tools?.alsoAllow ?? []), ...toolNames])],
  } };
  return { ...config, tools: { ...config.tools, allow: [...toolNames] },
    agents: { ...config.agents, list: agents.some(agent => agent.id === agentId)
      ? agents.map(agent => agent.id === agentId ? reviewer : agent) : [...agents, reviewer] },
  };
}
