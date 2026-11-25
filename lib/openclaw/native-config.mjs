import { REVIEWER_NATIVE_TOOL_DENY } from "../reviewer-tools.mjs";
import { resolveMaxOutputTokens } from "../agent-output.mjs";

export const PRIVATE_REVIEW_MEMORY_POLICY = 'rc-private-current-task-sources-v1-no-host-memory';
export const NATIVE_REVIEWER_EFFORT_POLICY = 'rc-declared-deepseek-request-controls-v1';

// Honor the declared wire format when a pinned host profile remaps off/low.
// The supported extra_body path affects this private invocation only.
export function withNativeReviewerEffort(config = {}, provider, model, effort = 'low', agentId = 'main') {
  const providerConfig = Object.entries(config.models?.providers ?? {}).find(([id]) => id.toLowerCase() === provider?.toLowerCase())?.[1];
  const selectedModel = providerConfig?.models?.find(entry => entry.id === model || entry.id === `${provider}/${model}`);
  if ((selectedModel?.api ?? providerConfig?.api) !== 'openai-completions' || selectedModel?.reasoning !== true
    || selectedModel.compat?.thinkingFormat !== 'deepseek') return config;
  const controls = { thinking: { type: effort === 'off' ? 'disabled' : 'enabled' } };
  const mapped = selectedModel.compat.reasoningEffortMap?.[effort] ?? selectedModel.thinkingLevelMap?.[effort]
    ?? (selectedModel.compat.supportedReasoningEfforts?.includes(effort) ? effort : undefined);
  if (effort !== 'off' && typeof mapped === 'string' && mapped) controls.reasoning_effort = mapped;
  const params = current => ({ ...current,
    extra_body: { ...(current?.extra_body ?? current?.extraBody ?? {}), ...controls } });
  const defaults = config.agents?.defaults ?? {}, ref = `${provider}/${model}`, selected = defaults.models?.[ref] ?? {};
  return { ...config, agents: { ...config.agents,
    defaults: { ...defaults, models: { ...defaults.models, [ref]: { ...selected, params: params(selected.params) } } },
    ...(config.agents?.list ? { list: config.agents.list.map(agent => agent.id === agentId
      ? { ...agent, params: params(agent.params) } : agent) } : {}) } };
}

// Private runs need direct tool names in persisted receipts. Both host routing
// modes can hide those tools, including Tool Search's local-model lean default.
export function withPrivateReviewerConfig(config = {}, agentId = 'main') {
  const withoutCodeMode = (tools = {}) => ({ ...tools, codeMode: { ...tools.codeMode, enabled: false } });
  const agents = config.agents?.list ?? [];
  const current = agents.find(agent => agent.id === agentId) ?? { id: agentId };
  const reviewer = { ...current, tools: withoutCodeMode(current.tools),
    memorySearch: { ...current.memorySearch, enabled: false } };
  return { ...config, tools: { ...withoutCodeMode(config.tools), toolSearch: false },
    agents: { ...config.agents, list: agents.some(agent => agent.id === agentId)
    ? agents.map(agent => agent.id === agentId ? reviewer : agent) : [...agents, reviewer] } };
}

// Override only this invocation's model parameters, preserving the host config.
export function withNativeMaxOutputTokens(config = {}, provider, model, maxOutputTokens, agentId) {
  const maxTokens = resolveMaxOutputTokens(maxOutputTokens);
  const ref = `${provider}/${model}`;
  const defaults = config.agents?.defaults ?? {};
  const selected = defaults.models?.[ref] ?? {};
  return { ...config, agents: { ...config.agents,
    ...(agentId && config.agents?.list ? { list: config.agents.list.map(agent => agent.id === agentId
      ? { ...agent, params: { ...agent.params, maxTokens } } : agent) } : {}),
    defaults: { ...defaults,
      models: { ...defaults.models, [ref]: { ...selected,
        params: { ...selected.params, maxTokens },
      } },
    },
  } };
}

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

// Narrow the inherited host permissions for read-only reviewer roles.
export function withReadOnlyReviewerTools(config, agentId) {
  const restrict = (tools = {}) => ({ ...tools,
    deny: [...new Set([...(tools.deny ?? []), ...REVIEWER_NATIVE_TOOL_DENY])],
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
