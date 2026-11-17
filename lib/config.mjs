import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { parseSimpleYaml } from './yaml.mjs';
import { json, regular, manifest, hash, within, redact } from './files.mjs';

const execute = promisify(execFile);
const yaml = async file => parseSimpleYaml(await fs.readFile(file, 'utf8'), { source: file });
function keys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a mapping`);
  if (allowed) for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown ${label}.${key}`);
}
function resolvePath(value, base, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing path: ${label}`);
  const expanded = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key) => {
    if (!process.env[key]) throw new Error(`Environment variable ${key} is not set (${label})`);
    return process.env[key];
  });
  return path.resolve(base, expanded);
}
export function chooseModels(source, wanted = {}) {
  for (const [key, value] of Object.entries(wanted)) if (typeof value !== 'string' || !value.trim()) throw new Error(`models.${key} must be a nonempty string`);
  const configured = source.agents?.list ?? [], defaults = source.agents?.defaults ?? {};
  if (!Array.isArray(configured)) throw new Error('Host agents.list must be an array');
  const list = configured.length ? configured : [{ id: 'main', default: true }];
  // Same default selection as MA OpenClaw: explicit default, first entry, implicit main.
  const chosen = wanted.agent && wanted.agent !== 'auto' ? wanted.agent : (list.find(a => a.default)?.id ?? list[0]?.id);
  const agentId = typeof chosen === 'string' ? chosen.trim().toLowerCase() : '';
  const agent = list.find(a => a.id?.trim().toLowerCase() === agentId);
  if (!agent || !/^[a-z0-9_-]+$/i.test(agentId)) throw new Error('No configured agent available; set models.agent');
  const primary = value => typeof value === 'string' ? value : value?.primary;
  const business = wanted.business && wanted.business !== 'auto' ? wanted.business : primary(agent.model) ?? primary(defaults.model);
  const reviewer = wanted.reviewer && wanted.reviewer !== 'auto' ? wanted.reviewer : source.plugins?.entries?.['runtime-corrector']?.config?.reviewerModel;
  for (const [role, model] of Object.entries({ business, reviewer })) {
    const slash = typeof model === 'string' ? model.indexOf('/') : -1;
    const provider = source.models?.providers?.[model?.slice(0, slash)];
    if (slash < 1 || !Array.isArray(provider?.models) || !provider.models.some(m => m.id === model.slice(slash + 1))) throw new Error(`Unavailable configured ${role} model: ${model ?? '(none)'}`);
  }
  return { agentId, business, reviewer };
}
export async function loadInputs(sampleFile, machineFile) {
  sampleFile = path.resolve(sampleFile); machineFile = path.resolve(machineFile);
  const sample = await yaml(sampleFile), machine = await yaml(machineFile);
  keys(sample, ['version', 'id', 'projectDir', 'promptFile', 'rcConfigFile', 'execution'], 'experiment');
  keys(machine, ['version', 'paths', 'harmony', 'extraPath', 'env', 'models'], 'machine');
  if (sample.version !== 1 || machine.version !== 1) throw new Error('Expected config version: 1');
  if (!/^[A-Za-z0-9_-]{1,60}$/.test(sample.id ?? '')) throw new Error('Invalid sample id');
  keys(machine.paths, ['node', 'git', 'python', 'openclawRoot', 'rcPluginPackage', 'hostConfig', 'hostState', 'outputRoot'], 'paths');
  const paths = Object.fromEntries(['node', 'git', 'openclawRoot', 'rcPluginPackage', 'hostConfig', 'hostState', 'outputRoot'].map(k => [k, resolvePath(machine.paths[k], path.dirname(machineFile), k)]));
  for (const k of ['node', 'git', 'rcPluginPackage', 'hostConfig']) await regular(paths[k]);
  if (machine.paths.python) { paths.python = resolvePath(machine.paths.python, path.dirname(machineFile), 'python'); await regular(paths.python); }
  for (const k of ['openclawRoot', 'hostState']) await regular(paths[k], true);
  const projectDir = resolvePath(sample.projectDir, path.dirname(sampleFile), 'projectDir');
  const promptFile = resolvePath(sample.promptFile, path.dirname(sampleFile), 'promptFile');
  const rcConfigFile = resolvePath(sample.rcConfigFile, path.dirname(sampleFile), 'rcConfigFile');
  await regular(projectDir, true); await regular(promptFile); await regular(rcConfigFile);
  if (within(projectDir, paths.outputRoot) || within(paths.outputRoot, projectDir)) throw new Error('Output and project directories must not contain each other');
  try { await fs.lstat(path.join(projectDir, '.runtime-corrector')); throw new Error('Use a clean project; .runtime-corrector is provided by rcConfigFile'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const host = await json(path.join(paths.openclawRoot, 'package.json'));
  if (host.name !== 'openclaw' || host.version !== '2026.7.1-2') throw new Error(`MVP supports MA OpenClaw 2026.7.1-2; found ${host.version}`);
  await regular(path.join(paths.openclawRoot, 'openclaw.mjs'));
  const nodeVersion = (await execute(paths.node, ['--version'], { windowsHide: true, timeout: 10000 })).stdout.trim();
  const [major, minor, patch] = nodeVersion.replace(/^v/, '').split('.').map(Number);
  if (!(major === 22 && (minor > 22 || minor === 22 && patch >= 3)
    || major === 24 && minor >= 15 || major === 25 && minor >= 9 || major >= 26)) throw new Error('Node 22.22.3+, 24.15+ or 25.9+ required (Node 23 unsupported)');
  const gitVersion = (await execute(paths.git, ['--version'], { windowsHide: true, timeout: 10000 })).stdout.trim();
  if (!/^git version \d/i.test(gitVersion)) throw new Error('paths.git is not a working Git executable');
  const environment = {};
  if (paths.python) environment.PYTHON = paths.python;
  keys(machine.harmony ?? {}, ['deveco', 'sdk', 'java', 'ohpm', 'hvigor'], 'harmony');
  const harmony = {};
  for (const [key, value] of Object.entries(machine.harmony ?? {})) {
    if (value === '') continue;
    harmony[key] = resolvePath(value, path.dirname(machineFile), `harmony.${key}`);
    await regular(harmony[key], true);
  }
  const vars = { deveco: 'DEVECO_HOME', sdk: 'DEVECO_SDK_HOME', java: 'JAVA_HOME', ohpm: 'OHPM_HOME', hvigor: 'HVIGOR_HOME' };
  for (const [key, value] of Object.entries(harmony)) environment[vars[key]] = value;
  if (!Array.isArray(machine.extraPath ?? [])) throw new Error('extraPath must be a list');
  const binPaths = [path.dirname(paths.node), path.dirname(paths.git)];
  if (paths.python) binPaths.push(path.dirname(paths.python));
  for (const key of ['java', 'ohpm', 'hvigor']) if (harmony[key]) {
    const bin = path.join(harmony[key], 'bin'); await regular(bin, true); binPaths.push(bin);
  }
  for (const value of machine.extraPath ?? []) { const bin = resolvePath(value, path.dirname(machineFile), 'extraPath'); await regular(bin, true); binPaths.push(bin); }
  keys(machine.env ?? {}, null, 'env');
  for (const [key, value] of Object.entries(machine.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /^(OPENCLAW_|RC_OPENCLAW_|HOME$|USERPROFILE$|APPDATA$|LOCALAPPDATA$|PATH$|NODE_OPTIONS$|TEMP$|TMP$|TMPDIR$)/i.test(key) || typeof value !== 'string') throw new Error(`Unsupported environment variable: ${key}`);
    environment[key] = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => { if (!process.env[name]) throw new Error(`Unset ${name}`); return process.env[name]; });
  }
  keys(machine.models ?? {}, ['agent', 'business', 'reviewer'], 'models');
  // OpenClaw profiles are JSON5. Reuse its installed parser, without loading host runtime.
  const contents = await fs.readFile(paths.hostConfig, 'utf8');
  let source;
  try { source = JSON.parse(contents.replace(/^\uFEFF/, '')); }
  catch {
    try { source = createRequire(path.join(paths.openclawRoot, 'package.json'))('json5').parse(contents); }
    catch { throw new Error(`Invalid OpenClaw JSON/JSON5 config or missing host json5 dependency: ${paths.hostConfig}`); }
  }
  const models = chooseModels(source, machine.models);
  const execution = { businessTimeoutMs: 0, pollIntervalMs: 1000, observerTimeoutMs: 0, ...sample.execution };
  keys(execution, ['businessTimeoutMs', 'pollIntervalMs', 'observerTimeoutMs'], 'execution');
  for (const [k, v] of Object.entries(execution)) if (!Number.isSafeInteger(v) || v < (k === 'pollIntervalMs' ? 100 : 0)) throw new Error(`Invalid execution.${k}`);
  const prompt = await fs.readFile(promptFile, 'utf8');
  if (!prompt.trim()) throw new Error('Empty prompt');
  const rc = parseSimpleYaml(await fs.readFile(rcConfigFile, 'utf8'), { source: rcConfigFile });
  if (rc.enabled === false) throw new Error('RC is disabled in sample config');
  return { sampleFile, machineFile, id: sample.id, paths, projectDir, promptFile, rcConfigFile, prompt, source, models, execution, environment, binPaths, harmony,
    fingerprint: { hostVersion: host.version, nodeVersion, gitVersion, hostConfigSha256: hash(contents), pluginSha256: hash(await fs.readFile(paths.rcPluginPackage)),
      sampleSha256: hash(await fs.readFile(sampleFile)), machineSha256: hash(await fs.readFile(machineFile)),
      promptSha256: hash(await fs.readFile(promptFile)), rcConfigSha256: hash(await fs.readFile(rcConfigFile)), project: await manifest(projectDir) } };
}
export function executionPlan(input) {
  const { source, prompt, ...plan } = input;
  return plan;
}
export const publicPlan = input => redact(executionPlan(input));
