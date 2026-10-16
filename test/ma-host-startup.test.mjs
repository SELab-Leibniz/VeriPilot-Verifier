import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { configureMAHost } from "../scripts/configure-ma-host.mjs";

// Execute the installed application's actual startup functions without starting
// Electron or writing its real config, state, backups or registry.
function startupSource(hostRoot) {
  const fd = fs.openSync(path.join(hostRoot, "resources/app.asar"), "r");
  try {
    const prefix = Buffer.alloc(16);
    fs.readSync(fd, prefix, 0, prefix.length, 0);
    const headerBytes = Buffer.alloc(prefix.readUInt32LE(12));
    fs.readSync(fd, headerBytes, 0, headerBytes.length, 16);
    const files = JSON.parse(headerBytes).files["dist-electron"].files.main.files;
    for (const [name, entry] of Object.entries(files)) {
      if (!name.endsWith(".js") || entry.unpacked) continue;
      const bytes = Buffer.alloc(entry.size);
      fs.readSync(fd, bytes, 0, bytes.length, 8 + prefix.readUInt32LE(4) + Number(entry.offset));
      const source = bytes.toString("utf8");
      if (source.includes("function cleanupStalePluginConfigs(")) return source;
    }
    throw new Error("Installed host startup functions were not found.");
  } finally {
    fs.closeSync(fd);
  }
}

test("installed MA startup reproduces deletion and retains the repaired plugin twice", {
  skip: !process.env.RC_MA_HOST_ROOT && "Set RC_MA_HOST_ROOT to the packaged MA directory.",
}, async t => {
  const hostRoot = process.env.RC_MA_HOST_ROOT;
  const source = startupSource(hostRoot);
  const names = ["pluginEntryExists", "scanPluginManifestIds", "collectKnownPluginIds",
    "ensureDefaultPluginPaths", "cleanupStalePluginConfigs"];
  const functions = names.map(name => {
    const start = source.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `installed host still declares ${name}`);
    const end = source.indexOf("function ", start + 9);
    assert.ok(end > start, `can extract installed ${name}`);
    return source.slice(start, end);
  }).join("\n");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rc-matrix-startup-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pluginRoot = path.join(root, ".openclaw/extensions/runtime-corrector");
  const configPath = path.join(root, ".openclaw/openclaw.json");
  const manifestPath = path.join(pluginRoot, "openclaw.plugin.json");
  const manifest = JSON.parse(fs.readFileSync(new URL("../packaging/hosts/openclaw/openclaw.plugin.json", import.meta.url)));
  fs.mkdirSync(path.dirname(path.join(pluginRoot, manifest.main)), { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, manifest.main), "export default {};\n");
  fs.writeFileSync(path.join(pluginRoot, "package.json"), JSON.stringify({ openclaw: { extensions: [manifest.main] } }));
  const base = () => ({ plugins: { allow: ["runtime-corrector"], entries: { "runtime-corrector": {
    enabled: true, config: { reviewerModel: "test/reviewer", hookTimeoutMs: 600000 },
  } } } });
  let config;
  const context = vm.createContext({ u: fs, path$2: path, DEFAULT_PLUGIN_ENTRY: "dist/index.js",
    SEMVER_SUFFIX_REGEX: /[.-]\d+\.\d+.*/,
    electron: { app: { isPackaged: true, getPath: () => root } },
    getResourcesDirPath$1: () => path.join(hostRoot, "resources"),
    readPluginRegistry: () => ({}), readAllPluginStates: () => ({}),
    logger$2: { info() {}, warn() {}, error() {} }, isYellowMode: () => false,
    readConfig$2: () => config, writeConfig$2: next => { config = next; },
    performBackup: () => "isolated-test-only", cleanupOldBackups() {},
  });
  vm.runInContext(functions, context);

  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  config = base();
  vm.runInContext("ensureDefaultPluginPaths(); cleanupStalePluginConfigs();", context);
  assert.equal(config.plugins.entries[manifest.id], undefined, "even a fixed manifest is missed without a load path");
  const { main, ...legacyManifest } = manifest;
  fs.writeFileSync(manifestPath, JSON.stringify(legacyManifest));
  config = base();
  config.plugins.load = { paths: [pluginRoot] };
  vm.runInContext("ensureDefaultPluginPaths(); cleanupStalePluginConfigs();", context);
  assert.equal(config.plugins.entries[manifest.id], undefined, "a load path alone cannot fix a missing manifest.main");

  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  fs.writeFileSync(configPath, JSON.stringify(base()));
  await configureMAHost({ configPath, pluginRoot });
  config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const repairedEntry = structuredClone(config.plugins.entries[manifest.id]);
  for (let startup = 0; startup < 2; startup++) {
    vm.runInContext("ensureDefaultPluginPaths(); cleanupStalePluginConfigs();", context);
    assert.deepEqual(config.plugins.entries[manifest.id], repairedEntry);
    assert.ok(config.plugins.allow.includes(manifest.id));
    assert.ok(config.plugins.load.paths.includes(pluginRoot.replaceAll("\\", "/")));
  }
});

test("MA startup retains main tool opt-in and new development sessions resolve it without widening deny rules", {
  skip: !process.env.RC_MA_HOST_ROOT && "Set RC_MA_HOST_ROOT to the packaged MA directory.",
}, async t => {
  const hostRoot = process.env.RC_MA_HOST_ROOT;
  const source = startupSource(hostRoot);
  const functions = ["forceTemplateValues", "getPathValue", "ensureDefaults"].map(name => {
    const start = source.indexOf(`function ${name}(`);
    const end = source.indexOf("function ", start + 9);
    assert.ok(start >= 0 && end > start, `installed ${name} can be extracted`);
    return source.slice(start, end);
  }).join("\n");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rc-ma-tools-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pluginRoot = path.join(root, "extensions/runtime-corrector");
  const configPath = path.join(root, "openclaw.json");
  const manifest = JSON.parse(fs.readFileSync(new URL("../packaging/hosts/openclaw/openclaw.plugin.json", import.meta.url)));
  fs.mkdirSync(path.dirname(path.join(pluginRoot, manifest.main)), { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, manifest.main), "export default {};\n");
  fs.writeFileSync(path.join(pluginRoot, "openclaw.plugin.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(pluginRoot, "package.json"), JSON.stringify({ openclaw: { extensions: [manifest.main] } }));
  const defaults = JSON.parse(fs.readFileSync(path.join(hostRoot, "resources/openclaw-defaults.json")));
  let config = { tools: { profile: "coding", alsoAllow: [...defaults.tools.alsoAllow, "runtime_corrector"] },
    agents: { list: [{ id: "main", default: true, tools: { deny: ["write"] } },
      { id: "other", tools: { alsoAllow: ["read"], deny: ["runtime_corrector"] } }] } };
  const context = vm.createContext({ loadDefaults: () => defaults, readConfigFile: () => config,
    writeConfig$3: next => { config = next; }, CONFIG_PATH: configPath, ConfigParseError: class extends Error {},
    KNOWN_INVALID_KEYS: {}, getDefaultAgentEntries: () => [], DEFAULT_CRON_MAX_CONCURRENT_RUNS: 3,
    EXACT_TOOLS_ARRAY_PATHS: new Set(["tools.alsoAllow", "tools.deny", "tools.media.image.models"]),
    logger$2: { info() {}, error() {} },
  });
  vm.runInContext(functions, context);
  vm.runInContext("ensureDefaults()", context);
  assert.ok(!config.tools.alsoAllow.includes("runtime_corrector"), "the real startup reproduces removal from the global list");
  fs.writeFileSync(configPath, JSON.stringify(config));
  await configureMAHost({ configPath, pluginRoot, toolAgent: "main" });
  config = JSON.parse(fs.readFileSync(configPath));
  const mainTools = structuredClone(config.agents.list[0].tools);
  const other = structuredClone(config.agents.list[1]);
  const { r: effectivePolicy, t: filterTools } = await import(pathToFileURL(path.join(hostRoot,
    "resources/openclaw/dist/agent-tools.policy-YD9HuYgO.js")));
  const { c: mergeAlsoAllow, h: profilePolicy } = await import(pathToFileURL(path.join(hostRoot,
    "resources/openclaw/dist/tool-policy-BHUGxE3p.js")));
  const visible = sessionKey => {
    const policy = effectivePolicy({ config, sessionKey });
    let tools = ["read", "write", "browser", "coding", "runtime_corrector", "rc_progress"].map(name => ({ name }));
    for (const layer of [mergeAlsoAllow(profilePolicy(policy.profile), policy.profileAlsoAllow),
      policy.globalPolicy, policy.agentPolicy]) tools = filterTools(tools, layer);
    return tools.map(tool => tool.name);
  };
  for (let restart = 0; restart < 2; restart++) {
    vm.runInContext("ensureDefaults()", context);
    assert.deepEqual(config.agents.list[0].tools, mainTools);
    assert.deepEqual(config.agents.list[1], other);
    for (const tool of ["read", "browser", "coding", "runtime_corrector"]) {
      assert.ok(visible(`agent:main:session-new-${restart}`).includes(tool), tool);
    }
    assert.ok(!visible(`agent:main:session-new-${restart}`).includes("write"), "agent deny must remain effective");
    assert.ok(!visible(`agent:main:session-new-${restart}`).includes("rc_progress"), "private review tool is not granted");
    assert.ok(!visible(`agent:other:session-new-${restart}`).includes("runtime_corrector"), "other agents remain unchanged");
  }
});
