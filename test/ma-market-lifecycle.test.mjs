import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { before, after } from "node:test";
import { buildMAPackage } from "../lib/ma-package-builder.mjs";
import { baseConfig, marketFixture, waitFor } from "./support/ma-market-fixture.mjs";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const inheritedPaths = Object.fromEntries(["OPENCLAW_CONFIG_PATH", "OPENCLAW_STATE_DIR"].map(name => [name, process.env[name]]));
let output, artifact;
before(async () => {
  // This test file runs in Node's isolated test process. Never inherit a path
  // that could redirect a fake-home lifecycle operation to the real user.
  for (const name of Object.keys(inheritedPaths)) delete process.env[name];
  output = await fs.mkdtemp(path.join(os.tmpdir(), "rc-ma-lifecycle-"));
  artifact = (await buildMAPackage({ sourceRoot, outputRoot: output })).directory;
});
after(async () => {
  await fs.rm(output, { recursive: true, force: true });
  for (const [name, value] of Object.entries(inheritedPaths)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

test("enable configures discovery, permissions and only the main public tool; repeated enable is idempotent", async t => {
  const base = baseConfig(), f = await marketFixture(t, artifact, base);
  const result = await f.plugin.activate(f.api, f.init);
  assert.equal(result.status, "active", result.error); assert.equal(result.restartRequired, true);
  assert.equal(result.packageName, "runtime-corrector"); assert.equal(result.pluginId, result.packageName);
  await f.writeMarker(true);
  const config = await f.readConfig(), entry = config.plugins.entries["runtime-corrector"];
  assert.deepEqual(config.tools, base.tools); assert.deepEqual(config.plugins.entries.existing, base.plugins.entries.existing);
  assert.deepEqual(config.untouched, base.untouched);
  assert.deepEqual(config.plugins.allow, ["existing", "runtime-corrector"]);
  assert.equal(config.plugins.load, undefined);
  assert.deepEqual(entry.hooks, { allowConversationAccess: true, allowPromptInjection: true });
  assert.equal(entry.config.reviewerModel, "test/reviewer");
  assert.deepEqual(config.agents.list[0].tools.alsoAllow, ["browser", "runtime_corrector"]);
  const before = await fs.readFile(f.configPath, "utf8"), files = await fs.readdir(path.dirname(f.configPath));
  assert.equal((await f.plugin.activate(f.api, f.init)).changed, false);
  assert.equal(await fs.readFile(f.configPath, "utf8"), before);
  assert.deepEqual(await fs.readdir(path.dirname(f.configPath)), files);
  const backup = files.find(name => name.endsWith(".bak"));
  assert.match(backup, /^openclaw\.json\.runtime-corrector-[0-9a-f-]+\.bak$/u);
  assert.equal(files.includes("runtime-corrector-ma"), false);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(path.dirname(f.configPath), backup))), base);
  await f.disable(); assert.deepEqual(await f.readConfig(), base);
});

test("unrestricted plugin allowlists remain unrestricted and implicit main-agent scaffolding is removed on disable", async t => {
  for (const allow of [undefined, []]) {
    const base = { agents: { defaults: { model: { primary: "test/reviewer" } } } };
    if (allow) base.plugins = { allow };
    const f = await marketFixture(t, artifact, base);
    assert.equal((await f.plugin.activate(f.api, f.init)).status, "active"); await f.writeMarker(true);
    assert.deepEqual((await f.readConfig()).plugins.allow, allow);
    await f.disable(); assert.deepEqual(await f.readConfig(), base);
  }
});

test("MA installation never adds context bypasses or takes ownership of existing rules", async t => {
  for (const [name, entry] of [
    ["absent config", { enabled: true }],
    ["absent patterns", { config: { existing: "keep" } }],
    ["empty patterns", { config: { bypassSessionPatterns: [] } }],
    ["custom patterns", { config: { existing: "keep", bypassSessionPatterns: ["agent:main:personal:*"] } }],
    ["existing RC pattern", { config: { bypassSessionPatterns: ["agent:main:personal:*", "agent:*:runtime-corrector:**"] } }],
    ["malformed foreign setting", { config: { bypassSessionPatterns: "invalid" } }],
  ]) await t.test(name, async t => {
    const base = baseConfig(); base.plugins.entries["matrix-context-controller"] = entry;
    const f = await marketFixture(t, artifact, base);
    for (let cycle = 0; cycle < 2; cycle++) {
      const result = await f.plugin.activate(f.api, f.init);
      assert.equal(result.status, "active", result.error); await f.writeMarker(true);
      assert.deepEqual((await f.readConfig()).plugins.entries["matrix-context-controller"], entry);
      assert.equal((await f.readState()).bypassAdded, false);
      assert.equal((await f.plugin.activate(f.api, f.init)).changed, false);
      assert.deepEqual((await f.readConfig()).plugins.entries["matrix-context-controller"], entry);
      await f.disable(); assert.deepEqual(await f.readConfig(), base);
    }
  });
});

test("upgrade retains cleanup ownership only for bypasses added by older installers", async t => {
  const base = baseConfig();
  base.plugins.entries["matrix-context-controller"] = { enabled: true, config: { bypassSessionPatterns: ["agent:main:personal:*"] } };
  const f = await marketFixture(t, artifact, base);
  assert.equal((await f.plugin.activate(f.api, f.init)).status, "active"); await f.writeMarker(true);
  // Simulate an active installation created by a release that injected the rule.
  const config = await f.readConfig(), state = await f.readState();
  config.plugins.entries["matrix-context-controller"].config.bypassSessionPatterns.push("agent:*:runtime-corrector:**");
  Object.assign(state, { bypassAdded: true, bypassConfigWasMissing: false, bypassWasMissing: false });
  await fs.writeFile(f.configPath, JSON.stringify(config));
  await fs.writeFile(f.statePath, JSON.stringify(state));
  assert.equal((await f.plugin.activate(f.api, f.init)).changed, false);
  assert.equal((await f.readState()).bypassAdded, true);
  await f.disable(); assert.deepEqual(await f.readConfig(), base);
  assert.equal((await f.plugin.activate(f.api, f.init)).status, "active"); await f.writeMarker(true);
  assert.deepEqual((await f.readConfig()).plugins.entries["matrix-context-controller"], base.plugins.entries["matrix-context-controller"]);
  assert.equal((await f.readState()).bypassAdded, false);
  await f.disable(); assert.deepEqual(await f.readConfig(), base);
});

test("strict agent allow, explicit deny and existing RC parameters survive an enable-disable round trip", async t => {
  const base = baseConfig();
  base.agents.list[0].tools = { allow: ["read"], deny: ["runtime_*"] };
  base.agents.list.push({ id: "other", tools: { alsoAllow: ["read"], deny: ["runtime_corrector"] } });
  base.plugins.enabled = false;
  base.plugins.deny = ["runtime-corrector"];
  base.plugins.entries["runtime-corrector"] = { enabled: false, config: { reviewerModel: "custom/model", hookTimeoutMs: 600000 } };
  const f = await marketFixture(t, artifact, base), result = await f.plugin.activate(f.api, f.init);
  assert.equal(result.status, "active", result.error); await f.writeMarker(true);
  const config = await f.readConfig();
  assert.deepEqual(config.agents.list[0].tools, { allow: ["read", "runtime_corrector"], deny: ["runtime_*"] });
  assert.deepEqual(config.agents.list[1], base.agents.list[1]);
  assert.deepEqual(config.plugins.entries["runtime-corrector"].config, base.plugins.entries["runtime-corrector"].config);
  assert(result.warnings.some(warning => warning.includes("阻止 RC")));
  await f.disable(); assert.deepEqual(await f.readConfig(), base);
});

test("ordinary MA host unload/reload preserves enabled config and its installation marker", async t => {
  const f = await marketFixture(t, artifact);
  assert.equal((await f.plugin.activate(f.api, f.init)).status, "active"); await f.writeMarker(true);
  const before = await fs.readFile(f.configPath, "utf8");
  assert.equal((await f.plugin.deactivate(f.api, f.init)).pending, true);
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(await fs.readFile(f.configPath, "utf8"), before);
  assert.equal((await f.readState()).active, true);
  assert.equal(JSON.parse(await fs.readFile(f.markerPath)).enabled, true);
  await f.disable();
});

test("disable follows the host's committed switch, preserves unrelated edits and restores cached RC settings on re-enable", async t => {
  const f = await marketFixture(t, artifact);
  await f.plugin.activate(f.api, f.init); await f.writeMarker(true);
  const config = await f.readConfig();
  config.plugins.entries["runtime-corrector"].config.reviewerModel = "changed/reviewer";
  config.untouched.added = "after install";
  config.agents.list[0].tools.alsoAllow.push("user_added_tool");
  await fs.writeFile(f.configPath, JSON.stringify(config));
  await f.disable();
  const disabled = await f.readConfig();
  assert.equal(disabled.plugins.entries["runtime-corrector"], undefined);
  assert.deepEqual(disabled.agents.list[0].tools.alsoAllow, ["browser", "user_added_tool"]);
  assert.equal(disabled.untouched.added, "after install");
  assert.equal((await f.readState()).savedEntry.config.reviewerModel, "changed/reviewer");
  assert.equal((await f.plugin.activate(f.api, f.init)).status, "active");
  assert.equal((await f.readConfig()).plugins.entries["runtime-corrector"].config.reviewerModel, "changed/reviewer");
  await f.writeMarker(true); await f.disable();
  await fs.rm(f.pluginDir, { recursive: true, force: true });
  assert.equal(JSON.stringify(await f.readConfig()).includes(f.payload.replaceAll("\\", "/")), false);
  assert.equal((await f.readState()).active, false);
});

test("a superseded package cannot tear down the active extension configuration", async t => {
  const base = baseConfig(), f = await marketFixture(t, artifact, base);
  await f.plugin.activate(f.api, f.init); await f.writeMarker(true);
  await f.plugin.deactivate(f.api, f.init);
  const newDir = path.join(path.dirname(f.pluginDir), "runtime-corrector-9.9.9");
  await fs.cp(artifact, newDir, { recursive: true });
  const next = require(path.join(newDir, "index.js")), init = { ...f.init, pluginDir: newDir, version: "9.9.9" };
  assert.equal((await next.activate(f.api, init)).status, "active");
  await fs.writeFile(path.join(newDir, "install-complete.json"), '{"enabled":true}');
  await f.writeMarker(false);
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal((await f.readConfig()).plugins.load, undefined);
  assert.equal((await f.readState()).owner, await fs.realpath(newDir));
  await fs.writeFile(path.join(newDir, "install-complete.json"), '{"enabled":false}');
  assert.equal((await next.deactivate(f.api, init)).status, "inactive");
  assert.deepEqual(await f.readConfig(), base);
});

test("upgrade reuses legacy installation state, removes its load path and preserves unrelated paths", async t => {
  for (const unrelated of [[], ["~/other-extension"]]) {
    const base = baseConfig();
    if (unrelated.length) base.plugins.load = { paths: unrelated };
    const f = await marketFixture(t, artifact, base, { legacyCache: true });
    const currentCache = path.join(path.dirname(f.configPath), "runtime-corrector");
    await fs.mkdir(path.join(currentCache, "cli-commands"), { recursive: true });
    assert.equal((await f.plugin.activate(f.api, f.init)).status, "active");
    const config = await f.readConfig(), state = await f.readState();
    const oldOwner = path.join(f.home, ".matrixassistant", "plugins", "runtime-corrector-1.9.1");
    state.owner = oldOwner;
    state.payload = path.join(oldOwner, "payload", "runtime-corrector");
    if (!unrelated.length) state.created.push(["plugins", "load"], ["plugins", "load", "paths"]);
    const oldPath = "~/" + path.relative(f.home, state.payload).replaceAll("\\", "/");
    config.plugins.load = { paths: [...unrelated, oldPath, f.pluginDir] };
    await fs.writeFile(f.configPath, JSON.stringify(config));
    await fs.writeFile(f.statePath, JSON.stringify(state));
    assert.equal((await f.plugin.activate(f.api, f.init)).status, "active");
    await f.writeMarker(true);
    assert.deepEqual((await f.readConfig()).plugins.load, base.plugins.load);
    assert.equal((await f.readState()).payload, await fs.realpath(f.pluginDir));
    await assert.rejects(fs.access(path.join(currentCache, "state.json")), { code: "ENOENT" });
    await f.disable();
    assert.deepEqual(await f.readConfig(), base);
  }
});

test("MA-specific OpenClaw entry refuses disabled, missing or corrupt markers and delegates only when enabled", async t => {
  const f = await marketFixture(t, artifact);
  const entry = (await import(pathToFileURL(path.join(f.payload, "ma-entry.mjs")))).default;
  assert.equal(entry.id, "runtime-corrector");
  assert.doesNotThrow(() => entry.register({}));
  await f.writeMarker(true);
  assert.throws(() => entry.register({ runtime: { version: "unsupported" } }), /requires OpenClaw/u);
  const hooks = new Map(), commands = new Map();
  const api = { id: "runtime-corrector", rootDir: f.payload, config: {}, pluginConfig: {}, logger: f.api.logger,
    runtime: { version: "2026.7.1-2", state: { resolveStateDir: () => path.dirname(f.configPath) },
      agent: { runEmbeddedAgent: async () => ({ payloads: [] }) } },
    on: (name, handler) => hooks.set(name, handler), registerTool() {}, registerGatewayMethod() {},
    registerAgentToolResultMiddleware() {}, registerCommand: command => commands.set(command.name, command), registerHttpRoute() {}, registerCli() {},
  };
  entry.register(api);
  assert(hooks.has("before_tool_call")); assert(hooks.has("agent_end")); assert(commands.has("rc-setup"));
  await hooks.get("gateway_stop")();
  await fs.writeFile(f.markerPath, "invalid"); assert.doesNotThrow(() => entry.register({}));
  await fs.unlink(f.markerPath); assert.doesNotThrow(() => entry.register({}));
});

test("invalid configuration, missing default model and mismatched package location report errors without config changes", async t => {
  for (const base of [{}, { agents: { defaults: { model: "test/reviewer" } }, plugins: { load: { paths: "invalid" } } },
    { agents: { defaults: { model: "test/reviewer" } }, plugins: { entries: { "runtime-corrector": { config: [] } } } }]) {
    const f = await marketFixture(t, artifact, base), before = await fs.readFile(f.configPath, "utf8");
    assert.equal(typeof (await f.plugin.activate(f.api, f.init)).error, "string");
    assert.equal(await fs.readFile(f.configPath, "utf8"), before);
  }
  const f = await marketFixture(t, artifact);
  const errors = [], api = { logger: { error: message => errors.push(message) } };
  const wrongId = await f.plugin.activate(api, { ...f.init, pluginId: "runtime-corrector-ma" });
  assert.match(wrongId.error, /market ID runtime-corrector/u);
  assert.deepEqual(errors, ["[runtime-corrector] activate: " + wrongId.error]);
  assert.match((await f.plugin.activate(f.api, { ...f.init, pluginDir: f.home })).error, /pluginDir/u);
  await fs.writeFile(f.configPath, "{broken");
  assert.equal(typeof (await f.plugin.activate(f.api, f.init)).error, "string");
  assert.equal(await fs.readFile(f.configPath, "utf8"), "{broken");
});

test("BOM config is accepted and a conflicting manually registered RC stays untouched", async t => {
  const f = await marketFixture(t, artifact), base = await fs.readFile(f.configPath, "utf8");
  await fs.writeFile(f.configPath, "\uFEFF" + base);
  assert.equal((await f.plugin.activate(f.api, f.init)).status, "active"); await f.writeMarker(true); await f.disable();
  const other = path.join(f.home, "manual-rc"); await fs.mkdir(other);
  await fs.writeFile(path.join(other, "openclaw.plugin.json"), '{"id":"runtime-corrector"}');
  const config = await f.readConfig(); config.plugins.load = { paths: [other] };
  const original = JSON.stringify(config); await fs.writeFile(f.configPath, original);
  assert.match((await f.plugin.activate(f.api, f.init)).error, /Another RC installation/u);
  assert.equal(await fs.readFile(f.configPath, "utf8"), original);
  delete config.plugins.load;
  const withoutExplicitPath = JSON.stringify(config);
  await fs.writeFile(f.configPath, withoutExplicitPath);
  const standalone = path.join(path.dirname(f.pluginDir), "runtime-corrector");
  await fs.mkdir(standalone);
  const manifest = path.join(standalone, "openclaw.plugin.json");
  await fs.writeFile(manifest, '{"id":"runtime-corrector"}');
  assert.match((await f.plugin.activate(f.api, f.init)).error, /Another RC installation/u);
  assert.equal(await fs.readFile(f.configPath, "utf8"), withoutExplicitPath);
  await fs.access(manifest);
});

test("concurrent config edits during a blocked write are preserved with no applied installation state", async t => {
  const f = await marketFixture(t, artifact), rename = fs.rename;
  const concurrent = JSON.stringify({ ...baseConfig(), concurrent: "preserve" });
  const mock = t.mock.method(fs, "rename", async function (from, to) {
    if (to === f.configPath) {
      await fs.writeFile(to, concurrent);
      throw Object.assign(new Error("reader lock"), { code: "EPERM" });
    }
    return rename.call(this, from, to);
  });
  try { assert.match((await f.plugin.activate(f.api, f.init)).error, /config changed/u); }
  finally { mock.mock.restore(); }
  assert.equal(await fs.readFile(f.configPath, "utf8"), concurrent);
  await assert.rejects(fs.access(f.statePath));
  await assert.rejects(fs.access(path.join(path.dirname(f.statePath), "pending.json")));
});

test("an interrupted state commit is recovered from the prepared config transaction on retry", async t => {
  const f = await marketFixture(t, artifact), rename = fs.rename;
  const mock = t.mock.method(fs, "rename", async function (from, to) {
    if (to === f.statePath) throw Object.assign(new Error("fixture state disk error"), { code: "EIO" });
    return rename.call(this, from, to);
  });
  try { assert.match((await f.plugin.activate(f.api, f.init)).error, /fixture state disk error/u); }
  finally { mock.mock.restore(); }
  await fs.access(path.join(path.dirname(f.statePath), "pending.json"));
  assert.equal((await f.plugin.activate(f.api, f.init)).status, "active"); await f.writeMarker(true);
  assert.equal((await f.readConfig()).plugins.load, undefined);
  await assert.rejects(fs.access(path.join(path.dirname(f.statePath), "pending.json")));
  await f.disable(); assert.deepEqual(await f.readConfig(), baseConfig());
});

test("a live installer lock is not stolen", async t => {
  const f = await marketFixture(t, artifact), cache = path.dirname(f.statePath);
  await fs.mkdir(cache, { recursive: true });
  const lock = path.join(cache, "installer.lock"), contents = JSON.stringify({ pid: process.pid });
  await fs.writeFile(lock, contents);
  const before = await fs.readFile(f.configPath, "utf8");
  assert.match((await f.plugin.activate(f.api, f.init)).error, /Another RC MA setup/u);
  assert.equal(await fs.readFile(lock, "utf8"), contents);
  assert.equal(await fs.readFile(f.configPath, "utf8"), before);
});

test("a terminated MA worker's expired lock can be recovered without narrowing tool or plugin policy", async t => {
  const base = baseConfig(); base.agents.list[0].id = "MAIN";
  base.plugins.entries["matrix-context-controller"] = { enabled: true };
  const f = await marketFixture(t, artifact, base), cache = path.dirname(f.statePath);
  await fs.mkdir(cache, { recursive: true });
  await fs.writeFile(path.join(cache, "installer.lock"), JSON.stringify({ pid: process.pid, expiresAt: Date.now() - 1 }));
  assert.equal((await f.plugin.activate(f.api, f.init)).status, "active"); await f.writeMarker(true);
  assert.deepEqual((await f.readConfig()).agents.list[0].tools.alsoAllow, ["browser", "runtime_corrector"]);
  await f.disable(); assert.deepEqual(await f.readConfig(), base);
});

test("RC parameter edits are retained when restoring a pre-existing disabled entry", async t => {
  const base = baseConfig();
  base.plugins.entries["runtime-corrector"] = { enabled: false, config: { reviewerModel: "old/reviewer" } };
  const f = await marketFixture(t, artifact, base);
  await f.plugin.activate(f.api, f.init); await f.writeMarker(true);
  const config = await f.readConfig(); config.plugins.entries["runtime-corrector"].config.reviewerModel = "new/reviewer";
  await fs.writeFile(f.configPath, JSON.stringify(config));
  await f.disable();
  assert.deepEqual((await f.readConfig()).plugins.entries["runtime-corrector"], { enabled: false, config: { reviewerModel: "new/reviewer" } });
});

test("escaping extension entries are rejected before any host config is changed", async t => {
  const f = await marketFixture(t, artifact), file = path.join(f.payload, "openclaw.plugin.json");
  const manifest = JSON.parse(await fs.readFile(file)); manifest.main = "../outside.mjs";
  await fs.writeFile(file, JSON.stringify(manifest));
  const pkgFile = path.join(f.payload, "package.json"), pkg = JSON.parse(await fs.readFile(pkgFile));
  pkg.openclaw.extensions = [manifest.main]; await fs.writeFile(pkgFile, JSON.stringify(pkg));
  await fs.writeFile(path.resolve(f.payload, manifest.main), "export default {};\n");
  const before = await fs.readFile(f.configPath, "utf8");
  assert.match((await f.plugin.activate(f.api, f.init)).error, /escapes/u);
  assert.equal(await fs.readFile(f.configPath, "utf8"), before);
});
