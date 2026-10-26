import { REVIEWER_NATIVE_TOOL_DENY } from "../reviewer-tools.mjs";

// Fail before dispatch, instead of asking a model to complete a protocol whose
// receipt/read tools the operator explicitly disabled. Never remove a deny.
export function assertRequiredReviewerTools(config, agentId, toolNames, {provider,model}={}) {
  const agent=config.agents?.list?.find(value=>value.id===agentId);
  const policies=[];
  const add=(label,tools)=>{
    if(!tools)return;
    policies.push([label,tools]);
    for(const key of [provider,provider&&model?`${provider}/${model}`:null].filter(Boolean))
      if(tools.byProvider?.[key])policies.push([`${label}.byProvider.${key}`,tools.byProvider[key]]);
  };
  add('tools',config.tools);add(`agents.${agentId}.tools`,agent?.tools);
  add('tools.sandbox.tools',config.tools?.sandbox?.tools);add('agents.defaults.sandbox.tools',config.agents?.defaults?.sandbox?.tools);add(`agents.${agentId}.sandbox.tools`,agent?.sandbox?.tools);
  const matches=(pattern,value)=>new RegExp('^'+pattern.toLowerCase().split('*').map(part=>part.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&')).join('.*')+'$','u').test(value);
  const blocked=[];
  for(const [policy,tools] of policies)for(const pattern of tools.deny??[])
    for(const name of toolNames)if([name,'runtime-corrector','group:plugins'].some(value=>matches(pattern,value)))blocked.push({tool:name,policy,pattern});
  if(blocked.length)throw Object.assign(new Error('RC_REQUIRED_TOOLS_DENIED: '+blocked.map(item=>`${item.tool} (${item.policy}.deny: ${item.pattern})`).join('; ')),{code:'RC_REQUIRED_TOOLS_DENIED',blockedTools:blocked});
}

// Private sessions may legitimately wait for tool reviews longer than the
// host's default five-minute transcript lock. Keep the lock bounded by this
// run, without changing global settings or an explicit operator lock policy.
export function withNativeSessionLockBudget(config, timeoutMs) {
  if (config?.session?.writeLock?.maxHoldMs !== undefined) return config;
  return { ...config, session: { ...config?.session, writeLock: {
    ...config?.session?.writeLock, maxHoldMs: Math.max(300000, Math.ceil(timeoutMs) + 5000),
  } } };
}

// Add private review tools to the selected agent's profile without replacing
// the host's tool catalog. Global/provider policies and explicit denies still
// decide availability. Keep this per-run copy valid when an allowlist exists.
export function withNativeReviewerTools(config, agentId, toolNames) {
  if (!toolNames.length) return config;
  const agents = config.agents?.list ?? [];
  const current = agents.find(agent => agent.id === agentId) ?? { id: agentId };
  const tools = current.tools ?? {};
  const grants = tools.allow?.length
    ? { allow: [...new Set([...tools.allow, ...toolNames])] }
    : { alsoAllow: [...new Set([...(tools.alsoAllow ?? config.tools?.alsoAllow ?? []), ...toolNames])] };
  const reviewer = { ...current, tools: { ...tools, ...grants } };
  return { ...config, agents: { ...config.agents, list: agents.some(agent => agent.id === agentId)
    ? agents.map(agent => agent.id === agentId ? reviewer : agent) : [...agents, reviewer] } };
}

// Narrow only this private run. Code Mode would replace the inherited catalog
// with exec/wait, so keep the read/search catalog directly available instead.
export function withReadOnlyReviewerTools(config, agentId) {
  const restrict = (tools = {}) => ({ ...tools,
    deny: [...new Set([...(tools.deny ?? []), ...REVIEWER_NATIVE_TOOL_DENY])],
    codeMode: { ...tools.codeMode, enabled: false },
  });
  const agents = config.agents?.list ?? [];
  const current = agents.find(agent => agent.id === agentId) ?? { id: agentId };
  const reviewer = { ...current, tools: restrict(current.tools) };
  return { ...config, tools: restrict(config.tools), agents: { ...config.agents,
    list: agents.some(agent => agent.id === agentId)
      ? agents.map(agent => agent.id === agentId ? reviewer : agent) : [...agents, reviewer],
  } };
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
