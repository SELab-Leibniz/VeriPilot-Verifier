import { isInternalExecution, isManagedExecution } from "./internal-context.mjs";

const pluginId = "runtime-corrector";
const toolName = "runtime_corrector";
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);

function record(parent, key) {
  if (parent[key] === undefined) parent[key] = {};
  if (!object(parent[key])) throw new Error(`${key} 必须是配置对象，未修改配置。`);
  return parent[key];
}

function names(value, label) {
  if (!Array.isArray(value) || value.some(name => typeof name !== "string")) {
    throw new Error(`${label} 必须是字符串列表，未修改配置。`);
  }
  return value;
}

// Match the host's default-agent selection, including its implicit main agent.
function primaryAgent(config) {
  const agents = record(config, "agents");
  agents.list ??= [];
  if (!Array.isArray(agents.list) || agents.list.some(agent => !object(agent))) {
    throw new Error("agents.list 必须是 Agent 配置列表，未修改配置。");
  }
  if (!agents.list.length) agents.list.push({ id: "main" });
  const selected = agents.list.find(agent => agent.default) ?? agents.list[0];
  if (typeof selected.id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/iu.test(selected.id.trim())) {
    throw new Error("主 Agent ID 无效，未修改配置。");
  }
  return selected;
}

function defaultModel(config, fallback) {
  const configured = config.agents?.defaults?.model;
  let model = typeof configured === "string" ? configured : configured?.primary;
  model ??= fallback;
  if (typeof model !== "string" || !model.trim()) throw new Error("未找到 OpenClaw 全局默认模型，未修改配置。");
  model = model.trim();
  // Resolve a configured alias before persisting a provider/model reference.
  if (!model.includes("/")) model = Object.entries(config.agents?.defaults?.models ?? {})
    .find(([, value]) => value?.alias?.toLowerCase() === model.toLowerCase())?.[0] ?? model;
  if (!/^[^/\s]+\/\S+$/u.test(model)) throw new Error("全局默认模型须能解析为 provider/model，未修改配置。");
  return model;
}

// Only called on the host's fresh source-config draft, never its runtime object.
export function initializeHostConfig(config, { fallbackModel } = {}) {
  if (!object(config)) throw new Error("OpenClaw 配置必须是对象。");
  const before = structuredClone(config);
  const plugins = record(config, "plugins");
  const entry = record(record(plugins, "entries"), pluginId);
  const hooks = record(entry, "hooks"), settings = record(entry, "config");
  const changed = [];
  entry.enabled = true;
  hooks.allowConversationAccess = true;
  hooks.allowPromptInjection = true;
  if (settings.reviewerModel === undefined) settings.reviewerModel = defaultModel(config, fallbackModel);
  if (typeof settings.reviewerModel !== "string" || !settings.reviewerModel.trim()) {
    throw new Error("RC reviewerModel 无效，未修改配置。");
  }
  if (settings.hookTimeoutMs === undefined) settings.hookTimeoutMs = 3600000;
  // An absent/empty plugin allowlist is unrestricted; do not narrow it to RC.
  if (plugins.allow !== undefined) {
    const allow = names(plugins.allow, "plugins.allow");
    if (allow.length && !allow.includes(pluginId)) allow.push(pluginId);
  }
  const agent = primaryAgent(config), tools = record(agent, "tools");
  if (tools.allow !== undefined) names(tools.allow, "Agent tools.allow");
  if (tools.alsoAllow !== undefined) names(tools.alsoAllow, "Agent tools.alsoAllow");
  if (tools.allow !== undefined && tools.alsoAllow !== undefined) throw new Error("Agent 的 allow 与 alsoAllow 不能同时设置。");
  if (tools.allow?.length) {
    if (!tools.allow.includes(toolName)) tools.allow.push(toolName);
  } else {
    // An empty allowlist adds no restriction. Use additive grants, without
    // publishing the invalid combination of allow and alsoAllow.
    delete tools.allow;
    tools.alsoAllow = [...names(tools.alsoAllow ?? config.tools?.alsoAllow ?? [], "Agent/global tools.alsoAllow")];
    if (!tools.alsoAllow.includes(toolName)) tools.alsoAllow.push(toolName);
  }
  const previousEntry = before.plugins?.entries?.[pluginId];
  for (const [key, value] of [["enabled", entry.enabled], ["hooks", hooks], ["config", settings]]) {
    if (JSON.stringify(previousEntry?.[key]) !== JSON.stringify(value)) changed.push(`plugins.entries.${pluginId}.${key}`);
  }
  if (JSON.stringify(before.plugins?.allow) !== JSON.stringify(plugins.allow)) changed.push("plugins.allow");
  if (JSON.stringify(before.agents?.list) !== JSON.stringify(config.agents.list)) changed.push("agents.list");
  const warnings = [];
  if (plugins.enabled === false || plugins.deny?.includes(pluginId)) warnings.push("宿主全局插件开关或 deny 仍阻止 RC 加载；这些设置已保留。");
  const matches = pattern => typeof pattern === "string" && [toolName, pluginId, "group:plugins"].some(value =>
    new RegExp(`^${pattern.toLowerCase().split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join(".*")}$`, "u").test(value));
  if ([...(config.tools?.deny ?? []), ...(tools.deny ?? [])].some(matches)) warnings.push("现有工具 deny 仍可能阻止 runtime_corrector；禁用规则已保留。");
  return { agentId: agent.id.trim().toLowerCase(), reviewerModel: settings.reviewerModel,
    hookTimeoutMs: settings.hookTimeoutMs, changedPaths: changed, warnings,
    reloadMode: config.gateway?.reload?.mode ?? "hybrid" };
}

export function registerHostSetup(api) {
  api.registerCommand({ name: "rc-setup", description: "初始化 RC 宿主配置及主 Agent 工具授权", acceptsArgs: true,
    requireAuth: true, requiredScopes: ["operator.admin"], async handler(ctx) {
      try {
        if (isInternalExecution() || isManagedExecution() || ctx.isAuthorizedSender !== true
          || !(ctx.gatewayClientScopes ? ctx.gatewayClientScopes.includes("operator.admin") : ctx.senderIsOwner === true)) {
          throw new Error("需要可信用户身份及宿主管理员权限。");
        }
        if (ctx.args?.trim()) throw new Error("用法：/rc-setup（不接受参数）");
        const host = api.runtime?.config;
        if (typeof host?.mutateConfigFile !== "function") throw new Error("当前宿主缺少安全配置写入接口，无法执行 /rc-setup。");
        const defaults = api.runtime.agent?.defaults;
        const fallbackModel = defaults?.provider && defaults?.model ? `${defaults.provider}/${defaults.model}` : undefined;
        const unchanged = new Error("RC_SETUP_UNCHANGED");
        let result, configPath;
        try {
          const saved = await host.mutateConfigFile({ base: "source", afterWrite: { mode: "auto" }, mutate(draft, context) {
            result = initializeHostConfig(draft, { fallbackModel });
            configPath = context.snapshot.path;
            if (!result.changedPaths.length) throw unchanged;
            return result;
          } });
          if (saved.followUp?.requiresRestart) result.reloadMode = "restart";
        } catch (error) { if (error !== unchanged) throw error; }
        const application = !result.changedPaths.length ? "配置已就绪，无需修改。"
          : result.reloadMode === "off" ? "已保存。宿主自动重载已关闭，需要重启 OpenClaw 后生效。"
            : result.reloadMode === "restart" ? "已保存。宿主当前策略将自动请求重启 OpenClaw。"
              : "已保存，等待宿主热加载；后续运行使用新配置，无需手动重启。";
        return { text: [application, `主 Agent：${result.agentId}`, `Reviewer 模型：${result.reviewerModel}`,
          `Hook 超时：${result.hookTimeoutMs} 毫秒`, `配置文件：${configPath}`,
          ...result.warnings].join("\n") };
      } catch (error) { return { text: `RC 初始化失败：${error.message}` }; }
    } });
}
