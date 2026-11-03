import assert from "node:assert/strict";
import test from "node:test";
import { registerHostSetup, initializeHostConfig, INTERNAL_SESSION_BYPASS_PATTERN } from "../lib/openclaw/host-setup.mjs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runInternalExecution, runManagedExecution } from "../lib/openclaw/internal-context.mjs";

const owner = { isAuthorizedSender: true, gatewayClientScopes: ["operator.admin"], agentId: "conversation-agent" };
function fixture(config, { beforeCommit, restart, defaults, snapshot } = {}) {
  let source = structuredClone(config), writes = 0, calls = 0, command;
  const api = { runtime: { agent: { defaults }, config: {
    current() { throw new Error("Must use a fresh source draft, not cached runtime config."); },
    async mutateConfigFile(options) {
      calls++;
      assert.equal(options.base, "source");
      assert.deepEqual(options.afterWrite, { mode: "auto" });
      const draft = structuredClone(source);
      const result = await options.mutate(draft, { snapshot: snapshot ?? { path: "/isolated/profile/openclaw.json" } });
      await beforeCommit?.(draft);
      source = draft;
      writes++;
      return { result, followUp: { requiresRestart: restart === true } };
    },
  } }, registerCommand(value) { command = value; } };
  registerHostSetup(api);
  return { api, get command() { return command; }, get config() { return source; }, get writes() { return writes; },
    get calls() { return calls; }, run: ctx => command.handler({ ...owner, ...ctx }) };
}

test("setup uses the default agent and global model, preserves other host policy, and does not rewrite a completed setup", async () => {
  const config = { models: { providers: { private: { apiKey: "${PRIVATE_MODEL_KEY}" } } },
    tools: { profile: "coding", alsoAllow: ["browser", "coding"], deny: ["exec"] },
    plugins: { load: { paths: ["/existing/plugin"] }, allow: ["other"], entries: { other: { enabled: false } } },
    agents: { defaults: { model: { primary: "custom/global", fallbacks: ["custom/fallback"] } }, list: [
      { id: "conversation-agent", model: "custom/conversation" },
      { id: "Primary-Assistant", default: true, tools: { profile: "coding", deny: ["write"] } },
    ] }, bindings: [{ agentId: "conversation-agent", match: { channel: "chat" } }] };
  const f = fixture(config), response = await f.run();
  assert.match(response.text, /主 Agent：primary-assistant/u);
  assert.match(response.text, /等待宿主热加载/u);
  assert.deepEqual(f.config.plugins.entries["runtime-corrector"], { enabled: true,
    hooks: { allowConversationAccess: true, allowPromptInjection: true },
    config: { reviewerModel: "custom/global", hookTimeoutMs: 3600000 } });
  assert.deepEqual(f.config.agents.list[1].tools, { profile: "coding", deny: ["write"],
    alsoAllow: ["browser", "coding", "runtime_corrector"] });
  assert.deepEqual(f.config.agents.list[0], config.agents.list[0]);
  for (const key of ["models", "tools", "bindings"]) assert.deepEqual(f.config[key], config[key]);
  assert.deepEqual(f.config.agents.defaults, config.agents.defaults);
  assert.deepEqual(f.config.plugins.load, config.plugins.load);
  assert.deepEqual(f.config.plugins.entries.other, config.plugins.entries.other);
  assert.deepEqual(f.config.plugins.allow, ["other", "runtime-corrector"]);
  assert.match((await f.run()).text, /无需修改/u);
  assert.equal(f.writes, 1);
});

test("explicit setup backs up the exact source before appending the internal-session bypass and is idempotent", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rc-host-setup-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, "openclaw.json");
  const config = { agents: { defaults: { model: "p/m" } }, plugins: { entries: {
    "matrix-context-controller": { enabled: true, config: { existing: "keep", bypassSessionPatterns: ["agent:main:personal:*"] } },
  } } };
  const original = "// preserved source formatting\r\n" + JSON.stringify(config, null, 2) + "\r\n";
  await fs.writeFile(configPath, original);
  const f = fixture(config, { snapshot: { path: configPath, raw: original }, async beforeCommit() {
    const backups = (await fs.readdir(root)).filter(file => file.endsWith(".bak"));
    assert.equal(backups.length, 1);
    assert.equal(await fs.readFile(path.join(root, backups[0]), "utf8"), original);
    assert.equal(await fs.readFile(configPath, "utf8"), original);
  } });
  assert.match((await f.run()).text, /备份文件/u);
  assert.deepEqual(f.config.plugins.entries["matrix-context-controller"].config,
    { existing: "keep", bypassSessionPatterns: ["agent:main:personal:*", INTERNAL_SESSION_BYPASS_PATTERN] });
  assert.match((await f.run()).text, /无需修改/u); assert.equal(f.writes, 1);
  assert.equal((await fs.readdir(root)).filter(file => file.endsWith(".bak")).length, 1);
  const ready = structuredClone(f.config), result = initializeHostConfig(ready);
  assert.equal(result.changed, false); assert.deepEqual(result.changedPaths, []);
});

test("context bypass follows the host colon-aware wildcard grammar and malformed rules never write", async () => {
  const compile = pattern => new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&")
    .replace(/\*\*/gu, "\u0000").replace(/\*/gu, "[^:]*").replace(/\u0000/gu, ".*") + "$");
  const pattern = compile(INTERNAL_SESSION_BYPASS_PATTERN);
  for (const key of ["agent:main:runtime-corrector:reviewer", "agent:other:runtime-corrector:worker:child"])
    assert.equal(pattern.test(key), true);
  for (const key of ["agent:main:main", "agent:main:runtime-corrector-other:reviewer", "agent:main:ordinary:runtime-corrector:child"])
    assert.equal(pattern.test(key), false);
  const config = { agents: { defaults: { model: "p/m" } }, plugins: { entries: {
    "matrix-context-controller": { config: { bypassSessionPatterns: "invalid" } },
  } } };
  const f = fixture(config); assert.match((await f.run()).text, /必须是字符串列表/u);
  assert.equal(f.writes, 0); assert.deepEqual(f.config, config);
});

test("explicit RC model/timeouts and the agent's own tool scope remain intact", async () => {
  const f = fixture({ agents: { defaults: { model: "custom/global" }, list: [{ id: "work", tools: { alsoAllow: ["read"] } }] },
    tools: { alsoAllow: ["browser"] }, plugins: { entries: { "runtime-corrector": { enabled: false,
      hooks: { allowConversationAccess: false, allowPromptInjection: false, allowModelOverride: false },
      config: { reviewerModel: "custom/chosen", hookTimeoutMs: 600000, reviewerTimeoutMs: 700000, enabled: false } } } } });
  assert.match((await f.run()).text, /custom\/chosen/u);
  assert.deepEqual(f.config.plugins.entries["runtime-corrector"].config, {
    reviewerModel: "custom/chosen", hookTimeoutMs: 600000, reviewerTimeoutMs: 700000, enabled: false });
  assert.deepEqual(f.config.plugins.entries["runtime-corrector"].hooks, {
    allowConversationAccess: true, allowPromptInjection: true, allowModelOverride: false });
  assert.deepEqual(f.config.agents.list[0].tools.alsoAllow, ["read", "runtime_corrector"]);
  assert.equal(f.config.plugins.allow, undefined);
});

test("implicit main, first agent, aliases and host built-in defaults resolve without a hardcoded model", async () => {
  const implicit = fixture({ agents: { defaults: { model: "fast", models: { "provider/actual": { alias: "Fast" } } } }, plugins: { allow: [] } });
  assert.match((await implicit.run()).text, /主 Agent：main/u);
  assert.equal(implicit.config.plugins.entries["runtime-corrector"].config.reviewerModel, "provider/actual");
  assert.deepEqual(implicit.config.plugins.allow, []);
  const first = fixture({ agents: { defaults: { model: "provider/global" }, list: [{ id: "first" }, { id: "main" }] } });
  assert.match((await first.run()).text, /主 Agent：first/u);
  assert.equal(first.config.agents.list[1].tools, undefined);
  const builtin = fixture({}, { defaults: { provider: "host-provider", model: "host-default" } });
  await builtin.run();
  assert.equal(builtin.config.plugins.entries["runtime-corrector"].config.reviewerModel, "host-provider/host-default");
});

test("allowlists remain valid and existing plugin/tool denies are preserved and reported", async () => {
  for (const allow of [["read"], []]) {
    const f = fixture({ agents: { defaults: { model: "custom/global" }, list: [{ id: "work", tools: { allow, deny: ["runtime_*"] } }] },
      tools: { alsoAllow: ["browser"] }, plugins: { enabled: false, deny: ["runtime-corrector"] } });
    const response = await f.run(), tools = f.config.agents.list[0].tools;
    if (allow.length) { assert.deepEqual(tools.allow, ["read", "runtime_corrector"]); assert.equal(tools.alsoAllow, undefined); }
    else { assert.equal(tools.allow, undefined); assert.deepEqual(tools.alsoAllow, ["browser", "runtime_corrector"]); }
    assert.deepEqual(tools.deny, ["runtime_*"]);
    assert.deepEqual(f.config.plugins.deny, ["runtime-corrector"]);
    assert.equal(f.config.plugins.enabled, false);
    assert.match(response.text, /阻止 RC 加载/u);
    assert.match(response.text, /工具 deny/u);
  }
});

test("reload policy is reported without requesting a forced restart", async () => {
  for (const [mode, expected] of [["off", /需要重启/u], ["restart", /自动请求重启/u], ["hot", /等待宿主热加载/u]]) {
    const f = fixture({ gateway: { reload: { mode } }, agents: { defaults: { model: "p/m" } } });
    assert.match((await f.run()).text, expected);
  }
  const forced = fixture({ agents: { defaults: { model: "p/m" } } }, { restart: true });
  assert.match((await forced.run()).text, /自动请求重启/u);
});

test("only authenticated admins or trusted channel owners can initialize, and private RC runs cannot", async () => {
  const f = fixture({ agents: { defaults: { model: "p/m" } } });
  assert.equal(f.command.name, "rc-setup");
  assert.equal(f.command.requireAuth, true);
  assert.deepEqual(f.command.requiredScopes, ["operator.admin"]);
  for (const ctx of [{ isAuthorizedSender: false }, { gatewayClientScopes: ["operator.write"] },
    { gatewayClientScopes: ["operator.read"], senderIsOwner: true }, { gatewayClientScopes: undefined, senderIsOwner: false }]) {
    assert.match((await f.run(ctx)).text, /管理员权限/u);
  }
  assert.match((await runInternalExecution("review", () => f.run())).text, /管理员权限/u);
  assert.match((await runManagedExecution("worker", () => f.run())).text, /管理员权限/u);
  assert.equal(f.calls, 0);
  assert.match((await f.run({ gatewayClientScopes: undefined, senderIsOwner: true })).text, /已保存/u);
});

test("invalid input, absent native API and rejected writes never report success or save partial changes", async () => {
  for (const config of [{}, { agents: { defaults: { model: "unknown-alias" } } },
    { agents: { defaults: { model: "p/m" }, list: [{ id: "a", tools: { alsoAllow: "invalid" } }] } }]) {
    const f = fixture(config);
    assert.match((await f.run()).text, /初始化失败/u);
    assert.deepEqual(f.config, config);
    assert.equal(f.writes, 0);
  }
  const f = fixture({ agents: { defaults: { model: "p/m" } } });
  assert.match((await f.run({ args: "--config /untrusted/openclaw.json" })).text, /不接受参数/u);
  assert.equal(f.calls, 0);
  f.api.runtime.config.mutateConfigFile = undefined;
  assert.match((await f.run()).text, /缺少安全配置写入接口/u);
  const rejected = fixture({ agents: { defaults: { model: "p/m" } } }, {
    beforeCommit() { throw new Error("native validation rejected config"); } });
  assert.match((await rejected.run()).text, /初始化失败：native validation rejected config/u);
  assert.equal(rejected.writes, 0);
  assert.equal(rejected.config.plugins, undefined);
});
