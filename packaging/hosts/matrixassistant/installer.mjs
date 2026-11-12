import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageName = "runtime-corrector-ma", pluginId = "runtime-corrector", toolName = "runtime_corrector";
const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const bypassPattern = "agent:*:runtime-corrector:**";
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const hash = value => createHash("sha256").update(value).digest("hex");
const parse = raw => JSON.parse(raw.replace(/^\uFEFF/u, ""));
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const key = value => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
const jobs = globalThis[Symbol.for("runtime-corrector-ma.deactivation-jobs")] ??= new Map();

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
  const config = path.resolve(process.env.OPENCLAW_CONFIG_PATH
    ?? path.join(process.env.OPENCLAW_STATE_DIR ?? path.join(home, ".openclaw"), "openclaw.json"));
  const cache = path.join(path.dirname(config), packageName);
  return { owner, home, config, cache, state: path.join(cache, "state.json"), pending: path.join(cache, "pending.json"),
    lock: path.join(cache, "installer.lock"), payload: await fs.realpath(path.join(owner, "payload", pluginId)),
    marker: path.join(owner, "install-complete.json") };
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
    });
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
  config.plugins ??= {};
  if (!object(config.plugins)) throw new Error("plugins must be an object.");
  config.plugins.load ??= {};
  if (!object(config.plugins.load)) throw new Error("plugins.load must be an object.");
  config.plugins.load.paths ??= [];
  return list(config.plugins.load.paths, "plugins.load.paths");
}

function withoutPath(values, target, home) {
  const expand = value => value === "~" ? home : value.startsWith("~/") || value.startsWith("~\\") ? path.join(home, value.slice(2)) : value;
  return values.filter(value => key(expand(value)) !== key(target));
}

function createdContainers(config) {
  return [["plugins"], ["plugins", "entries"], ["plugins", "load"], ["plugins", "load", "paths"], ["agents"], ["agents", "list"]]
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
  if (!agent.tools[name]?.includes(toolName) || previous?.tools?.[name]?.includes(toolName)) return null;
  return { agentId: agent.id, name, createdAgent: previous === undefined,
    before: previous?.tools ?? null, after: structuredClone(agent.tools) };
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
    agent.tools[grant.name] = agent.tools[grant.name].filter(value => value !== toolName);
    if (!agent.tools[grant.name].length && grant.before?.[grant.name] === undefined) delete agent.tools[grant.name];
    if (!Object.keys(agent.tools).length && grant.before === null) delete agent.tools;
  }
  if (grant.createdAgent && Object.keys(agent).length === 1 && agent.id === grant.agentId) {
    config.agents.list = agents.filter(value => value !== agent);
  }
}

async function validatePayload(where) {
  const manifest = parse(await fs.readFile(path.join(where.payload, "openclaw.plugin.json"), "utf8"));
  const pkg = parse(await fs.readFile(path.join(where.payload, "package.json"), "utf8"));
  if (manifest.id !== pluginId || typeof manifest.main !== "string" || !pkg.openclaw?.extensions?.includes(manifest.main)) {
    throw new Error("Invalid RC OpenClaw payload manifest/entry.");
  }
  const entry = await fs.realpath(path.resolve(where.payload, manifest.main));
  const relative = path.relative(where.payload, entry);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !(await fs.stat(entry)).isFile()) {
    throw new Error("RC OpenClaw payload entry escapes the payload directory.");
  }
  return pkg;
}

export async function activate(api, init) {
  const where = await locations(init);
  await validatePayload(where);
  const { initializeHostConfig } = await import(pathToFileURL(path.join(where.payload, "lib", "openclaw", "host-setup.mjs")));
  const result = await locked(where, async (config, state, commit) => {
    const before = structuredClone(config), paths = loadPaths(config);
    for (const candidate of paths) {
      const expanded = candidate.replace(/^~(?=[\\/]|$)/u, where.home);
      const raw = await readOptional(path.join(expanded, "openclaw.plugin.json"));
      if (raw && parse(raw).id === pluginId && key(expanded) !== key(where.payload)
        && !(state?.active && key(expanded) === key(state.payload))) {
        throw new Error("Another RC installation is configured in plugins.load.paths; remove that conflicting path before enabling the MA package.");
      }
    }
    const previousEntry = state?.active ? state.previousEntry : before.plugins?.entries?.[pluginId] ?? null;
    if (!config.plugins.entries?.[pluginId] && state?.savedEntry) {
      config.plugins.entries ??= {};
      config.plugins.entries[pluginId] = structuredClone(state.savedEntry);
    }
    const setup = initializeHostConfig(config);
    config.plugins.load.paths = withoutPath(paths, state?.active ? state.payload : where.payload, where.home);
    if (!config.plugins.load.paths.some(value => key(value) === key(where.payload))) config.plugins.load.paths.push(where.payload.replaceAll("\\", "/"));
    const grant = captureGrant(before, config, setup.agentId);
    const grants = state?.active ? [...state.grants] : [];
    if (grant && !grants.some(value => value.agentId === grant.agentId && value.name === grant.name)) grants.push(grant);
    const bypassBefore = before.plugins?.entries?.["matrix-context-controller"]?.config?.bypassSessionPatterns;
    const next = { schemaVersion: 1, configPath: where.config, active: true, owner: where.owner, payload: where.payload,
      generation: state?.active && state.owner === where.owner ? state.generation : randomUUID(), previousEntry,
      configuredEntry: state?.active ? state.configuredEntry : structuredClone(config.plugins.entries[pluginId]),
      savedEntry: null, grants, created: state?.active ? state.created : createdContainers(before),
      allowAdded: state?.active ? state.allowAdded : Array.isArray(before.plugins?.allow) && before.plugins.allow.length > 0 && !before.plugins.allow.includes(pluginId),
      bypassAdded: (state?.active && state.bypassAdded) || (Array.isArray(config.plugins.entries["matrix-context-controller"]?.config?.bypassSessionPatterns)
        && !bypassBefore?.includes(bypassPattern)),
      bypassConfigWasMissing: state?.active ? state.bypassConfigWasMissing : before.plugins?.entries?.["matrix-context-controller"]?.config === undefined,
      bypassWasMissing: state?.active ? state.bypassWasMissing : bypassBefore === undefined };
    const saved = await commit(next);
    return { status: "active", pluginId, packageName, pluginRoot: where.payload, restartRequired: true, ...saved, warnings: setup.warnings };
  });
  api?.logger?.info?.(`[${packageName}] configured ${where.payload}; restart the gateway to load RC`);
  return result;
}

async function removeConfiguration(where, expectedGeneration) {
  return locked(where, async (config, state, commit) => {
    if (!state?.active || key(state.owner) !== key(where.owner) || state.generation !== expectedGeneration) return { status: "inactive", changed: false };
    const entry = config.plugins?.entries?.[pluginId];
    const savedEntry = object(entry) ? structuredClone(entry) : state.savedEntry;
    if (Array.isArray(config.plugins?.load?.paths)) config.plugins.load.paths = withoutPath(config.plugins.load.paths, state.payload, where.home);
    if (object(config.plugins?.entries)) {
      if (state.previousEntry === null) delete config.plugins.entries[pluginId];
      else {
        const restored = structuredClone(state.previousEntry);
        // Preserve RC parameter edits made while the market package was active,
        // without retaining the installer's default additions in the baseline.
        const initial = state.configuredEntry?.config ?? {}, latest = savedEntry?.config ?? {};
        for (const name of new Set([...Object.keys(initial), ...Object.keys(latest)])) {
          if (equal(initial[name], latest[name])) continue;
          restored.config ??= {};
          if (Object.hasOwn(latest, name)) restored.config[name] = structuredClone(latest[name]);
          else delete restored.config[name];
        }
        config.plugins.entries[pluginId] = restored;
      }
    }
    if (state.allowAdded && Array.isArray(config.plugins?.allow)) config.plugins.allow = config.plugins.allow.filter(value => value !== pluginId);
    for (const grant of state.grants) removeGrant(config, grant);
    if (state.bypassAdded) {
      const settings = config.plugins?.entries?.["matrix-context-controller"]?.config;
      if (Array.isArray(settings?.bypassSessionPatterns)) {
        settings.bypassSessionPatterns = settings.bypassSessionPatterns.filter(value => value !== bypassPattern);
        if (!settings.bypassSessionPatterns.length && state.bypassWasMissing) delete settings.bypassSessionPatterns;
        if (!Object.keys(settings).length && state.bypassConfigWasMissing) delete config.plugins.entries["matrix-context-controller"].config;
      }
    }
    pruneCreated(config, state.created);
    const saved = await commit({ ...state, active: false, savedEntry, owner: null, payload: null, grants: [] });
    return { status: "inactive", ...saved };
  });
}

async function marker(where) {
  const raw = await readOptional(where.marker);
  return raw === undefined ? null : parse(raw);
}

export async function deactivate(api, init) {
  const where = await locations(init), raw = await readOptional(where.state);
  if (raw === undefined) return { status: "inactive", changed: false };
  const state = validateState(parse(raw), where);
  if (!state.active || key(state.owner) !== key(where.owner)) return { status: "inactive", changed: false };
  const current = await marker(where);
  if (!current || current.enabled === false) return removeConfiguration(where, state.generation);
  // MA calls this same hook for ordinary host reloads. Explicit disable writes
  // enabled:false only AFTER this promise resolves; uninstall then waits 3s.
  // Keep reloads unchanged and observe the committed switch before teardown.
  const jobKey = `${where.config}\0${where.owner}`;
  const existing = jobs.get(jobKey);
  if (existing?.generation === state.generation) {
    existing.deadline = Date.now() + 2500; return { status: "deactivating", pending: true };
  }
  if (existing) clearTimeout(existing.timer);
  const job = { generation: state.generation, deadline: Date.now() + 2500, timer: null };
  const check = async () => {
    if (jobs.get(jobKey) !== job) return;
    try {
      const observed = await marker(where);
      if (!observed || observed.enabled === false) {
        await removeConfiguration(where, state.generation);
        if (jobs.get(jobKey) === job) jobs.delete(jobKey);
        api?.logger?.info?.(`[${packageName}] removed this installation's config references`);
        return;
      }
    } catch (error) { api?.logger?.warn?.(`[${packageName}] deferred teardown: ${error.message}`); }
    if (Date.now() >= job.deadline) { if (jobs.get(jobKey) === job) jobs.delete(jobKey); return; }
    job.timer = setTimeout(check, 40); job.timer.unref();
  };
  job.timer = setTimeout(check, 20); job.timer.unref(); jobs.set(jobKey, job);
  return { status: "deactivating", pending: true };
}
