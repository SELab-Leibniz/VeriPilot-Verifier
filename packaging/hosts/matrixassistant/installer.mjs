import { promises as fs, watchFile, unwatchFile } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMarketOwner, nativeOwnerFile, pathKey as key, readNativeOwner, runNativeCommand, sameNativeOwner } from "./native-install.mjs";

const packageName = "runtime-corrector", pluginId = packageName, toolName = "runtime_corrector";
const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const legacyBypassPattern = "agent:*:runtime-corrector:**";
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const hash = value => createHash("sha256").update(value).digest("hex");
const parse = raw => JSON.parse(raw.replace(/^\uFEFF/u, ""));
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const jobs = globalThis[Symbol.for(`${packageName}.deactivation-jobs`)] ??= new Map();

async function readOptional(file) {
  try { return await fs.readFile(file, "utf8"); }
  catch (error) { if (error.code !== "ENOENT") throw error; return undefined; }
}

async function atomicWrite(file, value, expected) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, value, { flag: "wx", mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      if (expected !== undefined && await fs.readFile(file, "utf8") !== expected) throw new Error("OpenClaw config changed during MA setup; retry.");
      try { await fs.rename(temporary, file); break; }
      catch (error) {
        if (!["EBUSY", "EPERM", "EACCES"].includes(error.code) || attempt >= 7) throw error;
        await new Promise(resolve => setTimeout(resolve, Math.min(10 * 2 ** attempt, 250)));
      }
    }
  } finally { await fs.rm(temporary, { force: true }); }
}

async function locations(init = {}) {
  if (init.pluginId && init.pluginId !== pluginId) {
    throw new Error("Publish the MA package with market ID runtime-corrector so MA can match its OpenClaw status.");
  }
  const owner = await fs.realpath(packageRoot);
  if (init.pluginDir && key(await fs.realpath(init.pluginDir)) !== key(owner)) throw new Error("MA pluginDir does not match the installed package.");
  const home = init.homeDir ?? os.homedir();
  if (!path.isAbsolute(home)) throw new Error("MA homeDir must be absolute.");
  return installLocations(owner, home);
}

async function installLocations(owner, home) {
  const stateDir = path.resolve(process.env.OPENCLAW_STATE_DIR ?? path.join(home, ".openclaw"));
  const config = path.resolve(process.env.OPENCLAW_CONFIG_PATH ?? path.join(stateDir, "openclaw.json"));
  const currentCache = path.join(path.dirname(config), packageName);
  const legacyCache = `${currentCache}-ma`;
  // An older installation and its deferred teardown must share the same lock
  // and ownership state as the upgrade.
  const cache = await fs.lstat(legacyCache).then(() => legacyCache, error => {
    if (error.code !== "ENOENT") throw error;
    return currentCache;
  });
  const extensions = path.join(stateDir, "extensions");
  return { owner, home, config, extensions, native: path.join(extensions, pluginId), cache,
    state: path.join(cache, "state.json"), pending: path.join(cache, "pending.json"),
    lock: path.join(cache, "installer.lock"), marker: path.join(owner, "install-complete.json") };
}

function validateState(state, where) {
  if (!object(state) || state.schemaVersion !== 1 || state.configPath !== where.config
    || typeof state.active !== "boolean" || !Array.isArray(state.grants)
    || !Array.isArray(state.created) || (state.active && (typeof state.owner !== "string" || typeof state.payload !== "string"))) {
    throw new Error("Invalid RC MA installation state; configuration was not changed.");
  }
  return state;
}

async function locked(where, run) {
  await fs.mkdir(where.cache, { recursive: true, mode: 0o700 });
  let lock;
  try { lock = await fs.open(where.lock, "wx", 0o600); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    // A terminated installer must not permanently prevent repair. Respect live
    // operations until their lease outlasts MA's activation timeout.
    const raw = await readOptional(where.lock);
    let owner;
    try { owner = parse(raw ?? ""); } catch {}
    let alive = true;
    if (Number.isInteger(owner?.pid) && owner.pid > 0) {
      try { process.kill(owner.pid, 0); }
      catch (cause) { alive = cause.code !== "ESRCH"; }
    }
    const expired = Number.isFinite(owner?.expiresAt) && Date.now() > owner.expiresAt;
    if (alive && !expired) throw new Error("Another RC MA setup is running; retry after it finishes.");
    if (await readOptional(where.lock) !== raw) throw new Error("RC MA setup lock changed; retry.");
    await fs.unlink(where.lock);
    lock = await fs.open(where.lock, "wx", 0o600);
  }
  // A host-terminated Worker shares the still-live MA PID. Give that abandoned
  // lock a finite lease, longer than MA's ordinary 120s activation timeout.
  const token = json({ pid: process.pid, token: randomUUID(), expiresAt: Date.now() + 150000 });
  try {
    await lock.writeFile(token);
    const pendingRaw = await readOptional(where.pending);
    if (pendingRaw !== undefined) {
      const pending = parse(pendingRaw), current = hash(await fs.readFile(where.config, "utf8"));
      if (current === pending.after) await atomicWrite(where.state, json(validateState(pending.next, where)));
      else if (current !== pending.before) throw new Error("RC MA setup was interrupted and the config changed; restore its config backup before retrying.");
      await fs.unlink(where.pending);
    }
    const stateRaw = await readOptional(where.state);
    const state = stateRaw === undefined ? null : validateState(parse(stateRaw), where);
    const original = await fs.readFile(where.config, "utf8");
    const config = parse(original);
    if (!object(config)) throw new Error("OpenClaw config must be an object.");
    return await run(config, state, async next => {
      const contents = equal(parse(original), config) ? original : json(config);
      const pending = { before: hash(original), after: hash(contents), next };
      await atomicWrite(where.pending, json(pending));
      let applied = false;
      try {
        if (contents !== original) {
          await fs.writeFile(`${where.config}.${packageName}-${randomUUID()}.bak`, original, { flag: "wx", mode: 0o600 });
          await atomicWrite(where.config, contents, original);
        }
        applied = true;
        await atomicWrite(where.state, json(next));
        await fs.unlink(where.pending);
      } catch (error) {
        // After a committed config write retain the recovery record. Before a
        // write, leave the old state and the host's concurrent edit untouched.
        if (!applied) await fs.rm(where.pending, { force: true });
        throw error;
      }
      return { changed: contents !== original };
    }, original);
  } finally {
    await lock.close();
    if (await readOptional(where.lock) === token) await fs.unlink(where.lock);
  }
}

function list(value, label) {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) throw new Error(`${label} must be a string list.`);
  return value;
}

function loadPaths(config) {
  if (config.plugins !== undefined && !object(config.plugins)) throw new Error("plugins must be an object.");
  const load = config.plugins?.load;
  if (load === undefined) return [];
  if (!object(load)) throw new Error("plugins.load must be an object.");
  return load.paths === undefined ? [] : list(load.paths, "plugins.load.paths");
}

function expandHome(value, home) {
  return value === "~" ? home : value.startsWith("~/") || value.startsWith("~\\") ? path.join(home, value.slice(2)) : value;
}

function withoutPath(values, target, home) {
  return values.filter(value => key(expandHome(value, home)) !== key(target));
}

function createdContainers(config) {
  return [["plugins"], ["plugins", "entries"], ["agents"], ["agents", "list"]]
    .filter(parts => parts.reduce((value, part) => value?.[part], config) === undefined);
}

function pruneCreated(config, created) {
  for (const parts of [...created].sort((a, b) => b.length - a.length)) {
    const parent = parts.slice(0, -1).reduce((value, part) => value?.[part], config);
    const name = parts.at(-1), value = parent?.[name];
    if ((object(value) || Array.isArray(value)) && Object.keys(value).length === 0) delete parent[name];
  }
}

function captureGrant(before, after, id) {
  const matches = value => typeof value.id === "string" && value.id.toLowerCase() === id;
  const agent = after.agents.list.find(matches);
  const previous = before.agents?.list?.find(matches);
  const name = Array.isArray(agent.tools?.allow) && agent.tools.allow.length ? "allow" : "alsoAllow";
  if (!agent.tools[name]?.includes(toolName)) return null;
  const beforeTools = structuredClone(previous?.tools ?? null);
  // /rc-setup may already have granted the main agent this tool. Re-enable
  // grants it again. Preserve a strict allowlist if removing it would open access.
  if (beforeTools?.[name]?.includes(toolName)) {
    const remaining = beforeTools[name].filter(value => value !== toolName);
    if (name === "allow" && !remaining.length) return null;
    beforeTools[name] = remaining;
  }
  return { agentId: agent.id, name, createdAgent: previous === undefined,
    before: beforeTools, after: structuredClone(agent.tools) };
}

function removeGrant(config, grant) {
  const agents = config.agents?.list;
  if (!Array.isArray(agents)) return;
  const agent = agents.find(value => value.id === grant.agentId);
  if (!object(agent?.tools)) return;
  if (equal(agent.tools, grant.after)) {
    if (grant.before === null) delete agent.tools;
    else agent.tools = structuredClone(grant.before);
  } else if (Array.isArray(agent.tools[grant.name])) {
    if (grant.name === "allow" && agent.tools.allow.length && agent.tools.allow.every(value => value === toolName)) return;
    agent.tools[grant.name] = agent.tools[grant.name].filter(value => value !== toolName);
    if (!agent.tools[grant.name].length && grant.before?.[grant.name] === undefined) delete agent.tools[grant.name];
    if (!Object.keys(agent.tools).length && grant.before === null) delete agent.tools;
  }
  if (grant.createdAgent && Object.keys(agent).length === 1 && agent.id === grant.agentId) {
    config.agents.list = agents.filter(value => value !== agent);
  }
}

async function validatePackage(directory) {
  const manifest = parse(await fs.readFile(path.join(directory, "openclaw.plugin.json"), "utf8"));
  const pkg = parse(await fs.readFile(path.join(directory, "package.json"), "utf8"));
  if (pkg.name !== packageName || typeof pkg.version !== "string" || manifest.id !== pluginId
    || typeof manifest.main !== "string" || !pkg.openclaw?.extensions?.includes(manifest.main)) {
    throw new Error("Invalid RC OpenClaw extension manifest or entry.");
  }
  const entry = await fs.realpath(path.resolve(directory, manifest.main));
  const relative = path.relative(directory, entry);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !(await fs.stat(entry)).isFile()) {
    throw new Error("RC OpenClaw entry escapes the extension directory.");
  }
  return pkg.version;
}

async function installedDirectory(directory) {
  try {
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe RC install directory: ${directory}`);
    return await fs.realpath(directory);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function nativeDeployment(where, state, version, original, init) {
  const extensions = await fs.realpath(where.extensions).catch(error => {
    if (error.code !== "ENOENT") throw error;
  });
  if (extensions && key(extensions) === key(path.dirname(where.owner))) {
    const existing = key(where.native) === key(where.owner) ? undefined
      : await readOptional(path.join(where.native, "openclaw.plugin.json"));
    if (existing && parse(existing).id === pluginId) {
      throw new Error("Another RC installation is present in the OpenClaw extensions directory. Resolve the duplicate before enabling the MA package.");
    }
    return { directory: where.owner };
  }
  if (!isMarketOwner(where.home, where.owner)) {
    throw new Error("The RC package must be in the active OpenClaw extensions or default MA market directory.");
  }
  for (const entry of extensions ? await fs.readdir(extensions, { withFileTypes: true }) : []) {
    if (!entry.isDirectory() || !entry.name.startsWith(`${pluginId}-`)) continue;
    const raw = await readOptional(path.join(extensions, entry.name, "openclaw.plugin.json"));
    if (raw && parse(raw).id === pluginId) throw new Error("Another RC installation is present in the OpenClaw extensions directory.");
  }

  const target = await installedDirectory(where.native);
  const current = readNativeOwner(where.owner);
  const previous = target && readNativeOwner(target);
  const owned = state?.active && key(state.payload) === key(where.native) && key(state.owner) === key(where.owner);
  if (target && (!previous || key(previous.owner) !== key(where.owner))) {
    throw new Error("Another RC installation occupies the OpenClaw native install directory.");
  }
  if (target && owned && sameNativeOwner(current, previous) && previous.version === version) return { directory: target };

  const { stdout } = await runNativeCommand(where, ["list", "--json"], original, init?.clientInstallPath);
  const other = parse(stdout).plugins.some(plugin => plugin.id === pluginId
    && (!target || !plugin.source || key(path.dirname(plugin.source)) !== key(target)));
  if (other) throw new Error("Another RC installation is registered with OpenClaw.");

  const owner = { owner: where.owner, version, token: randomUUID() };
  await atomicWrite(path.join(where.owner, nativeOwnerFile), json(owner));
  const { config: nativeConfig } = await runNativeCommand(
    where, ["install", where.owner, ...(target ? ["--force"] : [])], original, init?.clientInstallPath);
  const installed = await installedDirectory(where.native);
  if (!installed || !sameNativeOwner(owner, readNativeOwner(installed)) || await validatePackage(installed) !== version) {
    throw new Error("OpenClaw did not install the verified RC package in its native extensions directory.");
  }
  const record = nativeConfig.plugins?.installs?.[pluginId];
  return { directory: installed, deployed: true, installRecord: ownsInstallRecord(where, record) ? record : undefined };
}

function ownsInstallRecord(where, record) {
  return typeof record?.sourcePath === "string" && typeof record?.installPath === "string"
    && key(record.sourcePath) === key(where.owner) && key(record.installPath) === key(where.native);
}

export async function activate(api, init) {
  const where = await locations(init);
  const version = await validatePackage(where.owner);
  const { initializeHostConfig } = await import(pathToFileURL(path.join(where.owner, "lib", "openclaw", "host-setup.mjs")));
  const result = await locked(where, async (config, state, commit, original) => {
    const before = structuredClone(config), paths = loadPaths(config);
    let retained = withoutPath(paths, where.owner, where.home);
    if (state?.active) retained = withoutPath(retained, state.payload, where.home);
    for (const candidate of retained) {
      const raw = await readOptional(path.join(expandHome(candidate, where.home), "openclaw.plugin.json"));
      if (raw && parse(raw).id === pluginId) {
        throw new Error("Another RC installation is configured in plugins.load.paths. Resolve that duplicate before enabling the MA package.");
      }
    }
    const previousEntry = state?.active ? state.previousEntry : before.plugins?.entries?.[pluginId] ?? null;
    if (!config.plugins?.entries?.[pluginId] && state?.savedEntry) {
      config.plugins ??= {};
      config.plugins.entries ??= {};
      config.plugins.entries[pluginId] = structuredClone(state.savedEntry);
    }
    const setup = initializeHostConfig(config);
    const deployment = await nativeDeployment(where, state, version, original, init);
    if (deployment.installRecord) {
      config.plugins.installs ??= {};
      config.plugins.installs[pluginId] = deployment.installRecord;
    }
    if (retained.length !== paths.length) {
      config.plugins.load.paths = retained;
      if (state?.active) pruneCreated(config, state.created.filter(parts => parts[0] === "plugins" && parts[1] === "load"));
    }
    const grant = captureGrant(before, config, setup.agentId);
    const grants = state?.active ? [...state.grants] : [];
    if (grant && !grants.some(value => value.agentId === grant.agentId && value.name === grant.name)) grants.push(grant);
    const next = { schemaVersion: 1, configPath: where.config, active: true, owner: where.owner, payload: deployment.directory,
      generation: state?.active && state.owner === where.owner && !deployment.deployed ? state.generation : randomUUID(), previousEntry,
      configuredEntry: state?.active ? state.configuredEntry : structuredClone(config.plugins.entries[pluginId]),
      savedEntry: null, grants, created: state?.active ? state.created : createdContainers(before),
      allowAdded: state?.active ? state.allowAdded : Array.isArray(before.plugins?.allow) && before.plugins.allow.length > 0 && !before.plugins.allow.includes(pluginId),
      // Retain ownership only to undo additions made by an older active installer.
      bypassAdded: state?.active === true && state.bypassAdded === true,
      bypassConfigWasMissing: state?.active === true && state.bypassConfigWasMissing === true,
      bypassWasMissing: state?.active === true && state.bypassWasMissing === true };
    const saved = await commit(next);
    return { status: "active", pluginId, packageName, pluginRoot: deployment.directory, restartRequired: true, ...saved, warnings: setup.warnings };
  });
  api?.logger?.info?.(`[${packageName}] configured ${result.pluginRoot}; restart the gateway to load RC`);
  return result;
}

function restoreConfiguration(where, config, state) {
  const entry = config.plugins?.entries?.[pluginId];
  const savedEntry = object(entry) ? structuredClone(entry) : state.savedEntry ?? state.previousEntry;
  if (Array.isArray(config.plugins?.load?.paths)) config.plugins.load.paths = withoutPath(config.plugins.load.paths, state.payload, where.home);
  // MA skips deactivate when uninstalling an already disabled package. Keep
  // the user's RC parameters in savedEntry for re-enable, outside the live registry.
  if (object(config.plugins?.entries)) delete config.plugins.entries[pluginId];
  if (state.allowAdded) removePositive(config.plugins, "allow", [pluginId]);
  for (const grant of state.grants) removeGrant(config, grant);
  if (state.bypassAdded) {
    const settings = config.plugins?.entries?.["matrix-context-controller"]?.config;
    if (Array.isArray(settings?.bypassSessionPatterns)) {
      settings.bypassSessionPatterns = settings.bypassSessionPatterns.filter(value => value !== legacyBypassPattern);
      if (!settings.bypassSessionPatterns.length && state.bypassWasMissing) delete settings.bypassSessionPatterns;
      if (!Object.keys(settings).length && state.bypassConfigWasMissing) delete config.plugins.entries["matrix-context-controller"].config;
    }
  }
  pruneCreated(config, state.created);
  return { ...state, active: false, savedEntry, owner: null, payload: null, grants: [] };
}

async function marker(where) {
  const raw = await readOptional(where.marker);
  return raw === undefined ? null : parse(raw);
}

function strippedMarketMarker(current, version) {
  return current?.pluginId === pluginId && current.version === version
    && !Object.hasOwn(current, "source") && !Object.hasOwn(current, "enabled");
}

async function hasReplacementRegistration(where, config, payload) {
  const target = config.plugins?.installs?.[pluginId]?.installPath;
  const belongs = value => [where.owner, payload].some(owned => owned && key(value) === key(owned));
  if (typeof target === "string" && !belongs(expandHome(target, where.home))) return true;
  for (const value of loadPaths(config)) {
    const directory = expandHome(value, where.home);
    if (!belongs(directory)) {
      const raw = await readOptional(path.join(directory, "openclaw.plugin.json")).catch(error => {
        if (error.code !== "ENOTDIR") throw error;
      });
      if (raw) {
        try { if (parse(raw).id === pluginId) return true; }
        catch (error) { if (!(error instanceof SyntaxError)) throw error; }
      }
    }
  }
  return false;
}

function removePositive(policy, field, names) {
  const values = policy?.[field];
  if (!Array.isArray(values) || !values.some(value => names.includes(value))) return;
  const rest = values.filter(value => !names.includes(value));
  // Removing the last member of a user-defined strict allowlist would open access.
  if (rest.length || field === "alsoAllow") policy[field] = rest;
}

function removeUninstalledReferences(where, config, payload) {
  const plugins = config.plugins;
  if (plugins?.entries) delete plugins.entries[pluginId];
  const record = plugins?.installs?.[pluginId];
  const directRecord = key(path.dirname(where.owner)) === key(where.extensions)
    && typeof record?.installPath === "string" && key(expandHome(record.installPath, where.home)) === key(where.owner);
  if (directRecord || ownsInstallRecord(where, record)) {
    delete plugins.installs[pluginId];
    if (!Object.keys(plugins.installs).length) delete plugins.installs;
  }
  if (Array.isArray(plugins?.load?.paths)) {
    plugins.load.paths = withoutPath(withoutPath(plugins.load.paths, where.owner, where.home), payload, where.home);
  }
  removePositive(plugins, "allow", [pluginId]);
  for (const tools of [config.tools, ...(config.agents?.list ?? []).map(agent => agent.tools)]) {
    removePositive(tools, "allow", [pluginId, toolName]);
    removePositive(tools, "alsoAllow", [pluginId, toolName]);
  }
}

async function marketUninstallRequested(where, owner) {
  const directory = await installedDirectory(where.owner);
  if (!directory) return true;
  if (key(directory) !== key(where.owner) || !sameNativeOwner(owner, readNativeOwner(directory))) return false;
  let current;
  try { current = await marker(where); }
  catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
  return strippedMarketMarker(current, owner.version);
}

export async function reconcileNativeUninstall(owner, home = os.homedir(), installRoot) {
  if (!isMarketOwner(home, owner.owner)) return true;
  const where = await installLocations(owner.owner, home);
  if (!await marketUninstallRequested(where, owner)) return false;
  return locked(where, async (config, state, commit, original) => {
    if (!await marketUninstallRequested(where, owner)) return false;
    if (state?.active && (key(state.owner) !== key(where.owner) || key(state.payload) !== key(where.native))) return true;
    if (await hasReplacementRegistration(where, config, where.native)) return true;
    const target = await installedDirectory(where.native);
    if (target) {
      if (!sameNativeOwner(owner, readNativeOwner(target))) return true;
      await runNativeCommand(where, ["uninstall", pluginId, "--force"], original, installRoot);
      if (await installedDirectory(where.native)) throw new Error("OpenClaw did not remove the RC native extension.");
    }
    if (!await marketUninstallRequested(where, owner)) return false;
    if (state) {
      const next = state.active ? restoreConfiguration(where, config, state) : state;
      removeUninstalledReferences(where, config, where.native);
      pruneCreated(config, state.created);
      await commit(next);
    }
    if (await installedDirectory(where.owner) && await marketUninstallRequested(where, owner)) {
      await fs.rm(where.owner, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
    return true;
  });
}

export async function deactivate(api, init) {
  const where = await locations(init), raw = await readOptional(where.state);
  if (raw === undefined) return { status: "inactive", changed: false };
  const state = validateState(parse(raw), where);
  if (!state.active || key(state.owner) !== key(where.owner)) return { status: "inactive", changed: false };
  const jobKey = `${where.config}\0${where.owner}`;
  const existing = jobs.get(jobKey);
  if (existing?.generation === state.generation && existing.check) return existing.check();
  if (existing?.stop) existing.stop();
  else clearTimeout(existing?.timer); // A previous MA package can share this process.

  const version = init?.version || await validatePackage(where.owner);
  const nativeOwner = isMarketOwner(where.home, where.owner) ? readNativeOwner(where.owner) : null;
  let queue = Promise.resolve(), retry;
  const pending = { status: "deactivating", pending: true };
  const stop = () => {
    unwatchFile(where.marker, notify);
    clearTimeout(retry);
    if (jobs.get(jobKey) === job) jobs.delete(jobKey);
  };
  const reconcile = async () => {
    const current = await marker(where);
    if (current?.enabled === true) return pending;
    const uninstalled = strippedMarketMarker(current, version) || (!current && !await installedDirectory(where.owner));
    if (!uninstalled && current && current.enabled !== false) return pending;
    if (await readOptional(where.state) === undefined) { stop(); return { status: "inactive", changed: false }; }
    if (uninstalled && nativeOwner) {
      if (await reconcileNativeUninstall(nativeOwner, where.home, init?.clientInstallPath)) stop();
      return { status: "inactive" };
    }
    return locked(where, async (config, latest, commit) => {
      if (latest?.generation !== state.generation || (latest.active && key(latest.owner) !== key(where.owner))) {
        stop(); return { status: "inactive", changed: false };
      }
      // An intervening enable or reinstall may have replaced the observed marker.
      if (!equal(current, await marker(where))) return pending;
      if (!latest.active && !uninstalled) return { status: "inactive", changed: false };
      if (await hasReplacementRegistration(where, config, state.payload)) {
        stop(); return { status: "inactive", changed: false };
      }
      const next = latest.active ? restoreConfiguration(where, config, latest) : latest;
      if (uninstalled) {
        removeUninstalledReferences(where, config, state.payload);
        pruneCreated(config, latest.created);
      }
      const saved = await commit(next);
      if (uninstalled) stop();
      return { status: "inactive", ...saved };
    });
  };
  const check = () => {
    // Serialize notifications so removal during a disable commit is seen afterwards.
    const operation = queue.then(() => jobs.get(jobKey) === job ? reconcile() : { status: "inactive", changed: false });
    queue = operation.catch(error => {
      api?.logger?.warn?.(`[${packageName}] deferred teardown: ${error.message}`);
      if (jobs.get(jobKey) === job && !retry && (error instanceof SyntaxError ||
        /another RC MA setup|lock changed|config changed during MA setup/iu.test(error.message) ||
        ["EPERM", "EACCES", "EBUSY"].includes(error.code))) {
        retry = setTimeout(() => { retry = undefined; notify(); }, 500);
        retry.unref();
      }
    });
    return operation;
  };
  const notify = () => { void check(); };
  const job = { generation: state.generation, stop, check };
  jobs.set(jobKey, job);
  // Disable/uninstall commits its marker after the hook returns. Also observe
  // removal after disable: MA skips the hook for an already disabled plugin.
  watchFile(where.marker, { persistent: false, interval: 250 }, notify);
  return check();
}
