import assert from "node:assert/strict";
import fsSync, { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import * as streamPromises from "node:stream/promises";
import * as workerThreads from "node:worker_threads";
import vm from "node:vm";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test, { before, after } from "node:test";
import { buildMAPackage } from "../lib/ma-package-builder.mjs";
import { baseConfig, marketFixture, waitFor } from "./support/ma-market-fixture.mjs";

const hostRoot = process.env.RC_MA_HOST_ROOT;
const options = { skip: !hostRoot && "Set RC_MA_HOST_ROOT to the packaged MA directory." };
const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const execute = promisify(execFile);
const archiveFs = process.versions.electron ? require("original-fs") : fsSync;
const logger = { info() {}, debug() {}, warn() {}, error() {}, trace() {} };
const inheritedPaths = Object.fromEntries(["OPENCLAW_CONFIG_PATH", "OPENCLAW_STATE_DIR"].map(name => [name, process.env[name]]));
let source, output, artifact;

function installedMain() {
  const fd = archiveFs.openSync(path.join(hostRoot, "resources", "app.asar"), "r");
  try {
    const prefix = Buffer.alloc(16); archiveFs.readSync(fd, prefix, 0, 16, 0);
    const bytes = Buffer.alloc(prefix.readUInt32LE(12)); archiveFs.readSync(fd, bytes, 0, bytes.length, 16);
    const header = JSON.parse(bytes), offset = 8 + prefix.readUInt32LE(4);
    const read = name => {
      const entry = name.split("/").reduce((node, part) => node.files[part], header);
      const contents = Buffer.alloc(entry.size);
      archiveFs.readSync(fd, contents, 0, contents.length, offset + Number(entry.offset));
      return contents.toString("utf8");
    };
    const entry = read("dist-electron/main/index.js");
    const active = /require\("\.\/(index-[^"/]+\.js)"\)/u.exec(entry)?.[1];
    assert(active, "resolve the active main bundle, not one of the stale bundled copies");
    return read(`dist-electron/main/${active}`);
  } finally { archiveFs.closeSync(fd); }
}

function between(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert(a >= 0 && b > a, `installed MA still exposes ${start}`);
  return source.slice(a, b);
}

function named(name) {
  const start = source.indexOf(`function ${name}(`), end = source.indexOf("function ", start + 9);
  assert(start >= 0 && end > start, `installed MA still exposes ${name}`);
  return source.slice(start, end);
}

before(async () => {
  if (!hostRoot) return;
  for (const name of Object.keys(inheritedPaths)) delete process.env[name];
  source = installedMain();
  output = await fs.mkdtemp(path.join(os.tmpdir(), "rc-ma-real-contract-"));
  artifact = await buildMAPackage({ sourceRoot, outputRoot: output });
});
after(async () => {
  if (output) await fs.rm(output, { recursive: true, force: true });
  for (const [name, value] of Object.entries(inheritedPaths)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

test("installed MA streaming and fallback tar extractors both unpack the actual release", options, async () => {
  const context = vm.createContext({ Buffer, TextDecoder, zlib, u: fsSync, fs$2: fs, path$1: path,
    promises$1: streamPromises, logger$2: logger, noopLogger$1: logger });
  vm.runInContext(between("function writeChunk(", "const DOWNLOAD_TIMEOUT_MS="), context);
  vm.runInContext(between('const TAR_TYPE_FILE="0"', 'const TAG="StanPlugin-install"'), context);
  vm.runInContext(between("const TAR_BLOCK_SIZE=", "function extractToTargetDir("), context);
  for (const [name, extract] of [
    ["streaming", root => context.extractTarGzFile(artifact.archive, root)],
    ["fallback", async root => { await fs.mkdir(root); return context.extractTarGzToDir(await fs.readFile(artifact.archive), root); }],
  ]) {
    const root = path.join(output, name); await extract(root);
    assert.equal(typeof require(path.join(root, "index.js")).activate, "function", name);
    const payload = path.join(root, "payload/runtime-corrector");
    await fs.access(path.join(payload, ".runtime-corrector-default/config.yaml"));
    assert.equal(JSON.parse(await fs.readFile(path.join(payload, "openclaw.plugin.json"))).main, "./ma-entry.mjs");
  }
});

test("installed MA Worker activates the package, startup retains it, and actual disable ordering cleans it", options, async t => {
  const f = await marketFixture(t, artifact.directory);
  const raw = between("WORKER_SOURCE=String.raw`", "`;function runActivateInWorker") + "`";
  const workerSource = vm.runInNewContext(raw.slice("WORKER_SOURCE=".length));
  const context = vm.createContext({ WORKER_SOURCE: workerSource, node_worker_threads: workerThreads,
    MessageChannel: workerThreads.MessageChannel, os$1: os, path$1: path, logger$4: logger, setTimeout, clearTimeout,
    buildPluginApi: () => ({ workspacePath: () => f.home, userDataPath: () => f.home,
      config: { get() { assert.fail("installer must not rely on MA's no-op config API"); }, set() { assert.fail("unexpected MA config RPC"); } } }),
  });
  vm.runInContext(between("function runActivateInWorker(", "const RETRYABLE_CODES="), context);
  const result = await context.runActivateInWorker(path.join(f.pluginDir, "index.js"), f.init, "runtime-corrector", { timeoutMs: 15000 });
  assert.equal(result.status, "active", result.error);
  await f.writeMarker(true);

  let config = await f.readConfig();
  const functions = ["pluginEntryExists", "scanPluginManifestIds", "collectKnownPluginIds", "ensureDefaultPluginPaths", "cleanupStalePluginConfigs"].map(named).join("\n");
  const aliases = Object.fromEntries([...functions.matchAll(/\bpath\$\d+\b/gu)].map(([name]) => [name, path]));
  const startup = vm.createContext({ u: fsSync, ...aliases, DEFAULT_PLUGIN_ENTRY: "dist/index.js",
    SEMVER_SUFFIX_REGEX: /[.-]\d+\.\d+.*/u, electron: { app: { isPackaged: true, getPath: () => f.home } },
    getResourcesDirPath$1: () => path.join(hostRoot, "resources"), readPluginRegistry: () => ({}), readAllPluginStates: () => ({}),
    logger$2: logger, isYellowMode: () => false, readConfig$2: () => config, writeConfig$2: next => { config = next; },
    performBackup: () => "fixture-only", cleanupOldBackups() {},
  });
  vm.runInContext(functions, startup);
  for (let restart = 0; restart < 2; restart++) {
    vm.runInContext("ensureDefaultPluginPaths(); cleanupStalePluginConfigs();", startup);
    assert.equal(config.plugins.entries["runtime-corrector"].enabled, true);
    assert(config.plugins.load.paths.includes(f.payload.replaceAll("\\", "/")));
  }

  const disable = vm.createContext({ path$1: path, fs$2: fs, u: fsSync, logger$4: logger, require,
    readPluginStateAsync: async () => JSON.parse(await fs.readFile(f.markerPath)),
    killPluginProcesses: async () => {}, readMatrixPluginManifest: () => null, scanPluginOpenclawSkills: () => [],
    buildPluginApi: () => f.api, electron: { app: { isPackaged: true, getPath: () => f.home } }, getHomeDir$3: () => f.home,
    hasSddFileHandler: () => false, removePluginSddflowFromUser() {}, loadedPlugins: new Map(),
  });
  vm.runInContext(between("async function deactivatePlugin(", "async function unloadHostPlugins("), disable);
  assert.equal((await disable.deactivatePlugin("runtime-corrector", f.pluginDir)).success, true);
  assert.equal(JSON.parse(await fs.readFile(f.markerPath)).enabled, false);
  await waitFor(async () => !(await f.readState()).active);
  assert.deepEqual(await f.readConfig(), baseConfig());
});

test("installed MA alive judge matches the market ID against real OpenClaw plugin metadata", options, async t => {
  const f = await marketFixture(t, artifact.directory, { agents: { defaults: { model: "test/reviewer" }, list: [{ id: "main" }] } });
  assert.equal((await f.plugin.activate(f.api, f.init)).status, "active"); await f.writeMarker(true);
  const { stdout, stderr } = await execute(process.execPath, [path.join(hostRoot, "resources", "openclaw", "openclaw.mjs"), "plugins", "list", "--json"], {
    windowsHide: true, timeout: 20000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", OPENCLAW_NO_RESPAWN: "1", OPENCLAW_CONFIG_PATH: f.configPath,
      OPENCLAW_STATE_DIR: path.dirname(f.configPath), USERPROFILE: f.home, HOME: f.home,
      APPDATA: path.join(f.home, "AppData", "Roaming"), LOCALAPPDATA: path.join(f.home, "AppData", "Local") },
  });
  const metadata = JSON.parse(stdout), native = metadata.plugins.find(value => value.id === "runtime-corrector");
  assert.equal(native?.enabled, true, stderr);
  const records = JSON.parse(await fs.readFile(artifact.registry)).plugins;
  const context = vm.createContext({ pluginAliveCache: null, logger$4: logger, fs$2: fs,
    runPluginsListJson: async () => ({ stdout, stderr, code: 0 }), defaultGetConnectedAt: () => Date.now(),
    listPluginEntries: async () => records, isYellowMode: () => false, withPluginLock: (_id, run) => run(),
  });
  vm.runInContext(between("async function refreshPluginAliveCache(", "async function judgePluginAliveByList("), context);
  vm.runInContext(between("async function judgePluginAliveByList(", "async function judgePluginAliveDispatch("), context);
  vm.runInContext(between("async function writeMarkerResult(", "async function writeMarkerAlive("), context);
  vm.runInContext(between("async function writeMarkerAlive(", "async function findCompleteJsonFile$1("), context);
  await context.refreshPluginAliveCache();
  assert.equal(context.pluginAliveCache.has("runtime-corrector-ma"), false, "the distribution filename is not the OpenClaw ID");
  const judged = await context.judgePluginAliveByList(Object.keys(records)[0], f.markerPath);
  assert.equal(judged.alive, true);
  assert.equal(JSON.parse(await fs.readFile(f.markerPath)).alive, true);
});
