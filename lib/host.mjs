import fs from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { json, optionalJson, writeJson, redact, regular } from './files.mjs';
import { startSampleSupervisor, inspectProcess, waitForSampleStop } from './process-scope.mjs';
import { startDeadlineWatchdog } from './deadline-watchdog.mjs';

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
export function isolatedEnvironment(record) {
  const { paths, environment, binPaths } = record.input;
  const env = { ...process.env };
  const inheritedPath = env.PATH ?? env.Path ?? '';
  for (const key of Object.keys(env)) if (/^(OPENCLAW_|RC_OPENCLAW_|PATH$|PSMODULEANALYSISCACHEPATH$)/i.test(key)) delete env[key];
  return { ...env, ...environment,
    PATH: [...binPaths, inheritedPath].join(path.delimiter),
    HOME: record.home, USERPROFILE: record.home,
    APPDATA: path.join(record.home, 'AppData/Roaming'), LOCALAPPDATA: path.join(record.home, 'AppData/Local'),
    TEMP: path.join(record.runDir, 'runtime/tmp'), TMP: path.join(record.runDir, 'runtime/tmp'), TMPDIR: path.join(record.runDir, 'runtime/tmp'),
    PSModuleAnalysisCachePath: path.join(record.runDir, 'runtime/tmp/powershell-module-cache'),
    OPENCLAW_CONFIG_PATH: record.configPath, OPENCLAW_STATE_DIR: record.stateDir,
    OPENCLAW_NO_RESPAWN: '1', ELECTRON_RUN_AS_NODE: '1', RC_OPENCLAW_HOST_ROOT: paths.openclawRoot };
}
export function activateIsolatedEnvironment(record) {
  const environment = isolatedEnvironment(record);
  for (const key of Object.keys(process.env)) if (/^(OPENCLAW_|RC_OPENCLAW_)/i.test(key)) delete process.env[key];
  Object.assign(process.env, environment);
}
export async function configureHost(record, input) {
  const { paths, models, source } = input;
  await fs.mkdir(record.stateDir, { recursive: true });
  await fs.mkdir(record.home, { recursive: true });
  for (const dir of ['AppData/Roaming', 'AppData/Local']) await fs.mkdir(path.join(record.home, dir), { recursive: true });
  await fs.mkdir(path.join(record.runDir, 'runtime/tmp'), { recursive: true });
  const providers = structuredClone(source.models.providers);
  const saved = await optionalJson(path.join(paths.hostState, 'agents', models.agentId, 'agent/models.json'));
  for (const [name, settings] of Object.entries(providers)) {
    if (!settings.apiKey && saved?.providers?.[name]?.apiKey) settings.apiKey = saved.providers[name].apiKey;
  }
  const agentDir = path.join(record.stateDir, 'agents', models.agentId, 'agent');
  await fs.mkdir(agentDir, { recursive: true });
  for (const name of ['auth-profiles.json', 'auth.json']) {
    const from = path.join(paths.hostState, 'agents', models.agentId, 'agent', name);
    try { await regular(from); await fs.copyFile(from, path.join(agentDir, name)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  const cfg = {
    gateway: { mode: 'local', port: record.port, bind: 'loopback', auth: { mode: 'token', token: randomUUID() }, controlUi: { enabled: false } },
    models: { mode: 'replace', providers },
    agents: { defaults: { workspace: record.seedRoot, model: models.business, thinkingDefault: 'off', maxConcurrent: 4,
      heartbeat: { every: '0m' }, memorySearch: { provider: 'none' }, timeoutSeconds: 300 }, list: [{ id: models.agentId, default: true }] },
    tools: { profile: 'full' }, channels: {}, cron: { enabled: false },
    plugins: { allow: [], entries: {} },
    logging: { level: 'debug', consoleLevel: 'info', file: path.join(record.runDir, 'logs/openclaw.log') }
  };
  await writeJson(record.configPath, cfg);
  // Environment is isolated before loading installer/host modules (which may cache paths).
  activateIsolatedEnvironment(record);
  const installer = await import(pathToFileURL(path.join(record.pluginDir, 'installer.mjs')));
  const install = await installer.activate({ logger: { info() {}, warn() {}, error() {} } },
    { homeDir: record.home, pluginDir: record.pluginDir, pluginId: 'runtime-corrector', isPackaged: true });
  if (install.status !== 'active') throw new Error('RC install did not activate');
  await writeJson(path.join(record.pluginDir, 'install-complete.json'), { id: 'runtime-corrector', enabled: true, version: '1.11.0' });
  const active = await json(record.configPath);
  active.plugins.entries['runtime-corrector'].config ??= {};
  active.plugins.entries['runtime-corrector'].config.reviewerModel = models.reviewer;
  active.plugins.entries['runtime-corrector'].config.businessRunTimeoutMs = Math.max(1, Math.min(input.execution.businessTimeoutMs || Infinity,
    (record.experimentDeadlineAt ?? Date.now() + input.execution.maxRuntimeMs) - Date.now()));
  await writeJson(record.configPath, active);
  await writeJson(path.join(record.runDir, 'config/host.redacted.json'), redact(active));
}
export async function connectHost(record) {
  activateIsolatedEnvironment(record);
  const { callGatewayFromCli } = await import(pathToFileURL(path.join(record.input.paths.openclawRoot, 'dist/plugin-sdk/gateway-runtime.js')));
  const cfg = await json(record.configPath);
  return (method, params = {}, timeoutMs = 30000, { signal } = {}) => callGatewayFromCli(method,
    { url: `ws://127.0.0.1:${record.port}`, token: cfg.gateway.auth.token, timeout: String(timeoutMs), json: true }, params,
    { progress: false, signal, scopes: ['operator.admin', 'operator.read', 'operator.write', 'operator.approvals', 'operator.pairing'] });
}
export async function startGateway(record) {
  const out = openSync(path.join(record.runDir, 'logs/gateway.stdout.log'), 'a');
  const err = openSync(path.join(record.runDir, 'logs/gateway.stderr.log'), 'a');
  let child;
  try {
    child = spawn(record.input.paths.node, [path.join(record.input.paths.openclawRoot, 'openclaw.mjs'), 'gateway', 'run', '--port', String(record.port), '--bind', 'loopback'],
      { cwd: record.seedRoot, env: isolatedEnvironment(record), stdio: ['ignore', out, err], detached: true, windowsHide: true });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  } finally { closeSync(out); closeSync(err); }
  child.unref();
  record.gatewayPid = child.pid;
  await writeJson(path.join(record.runDir, 'run.json'), record);
  try { await startSampleSupervisor(record); }
  catch (error) {
    // No session/model is allowed before containment is ready. This is our
    // original ChildProcess handle, never an unchecked recycled PID.
    child.kill(); throw error;
  }
  if (child.exitCode !== null || child.signalCode !== null) throw new Error('Gateway exited during process-scope setup');
  await startDeadlineWatchdog(record);
  await writeJson(path.join(record.runDir, 'run.json'), record);
  const rpc = await connectHost(record);
  const deadline = Math.min(Date.now() + 90000, record.experimentDeadlineAt ?? Infinity);
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Gateway exited: see ${record.runDir}/logs`);
    try { await rpc('health', {}, 2000); return rpc; } catch { await sleep(1000); }
  }
  if (Date.now() >= (record.experimentDeadlineAt ?? Infinity)) throw Object.assign(new Error('Experiment deadline during Gateway startup'), { code: 'EXPERIMENT_DEADLINE_EXPIRED' });
  throw new Error('Gateway startup timeout; logs and original process retained');
}
export async function stopGateway(record) {
  if (!Number.isSafeInteger(record.gatewayPid) || record.gatewayPid <= 0) throw new Error('Missing gateway PID');
  if (!record.processScope) throw new Error('Legacy run has no process-scope identity; automatic Gateway shutdown is unavailable');
  // Verify this exact process before termination, including when observing a resumed run.
  let command;
  if (process.platform === 'win32') {
    const actual = await inspectProcess(record.gatewayPid);
    if (!actual || record.processScope?.root.startedAt !== actual.startedAt) {
      if (record.processScope) await waitForSampleStop(record, { normal: true });
      return; // The original root exited; a reused PID must remain untouched.
    }
    command = actual.commandLine;
  } else {
    try { command = (await fs.readFile(`/proc/${record.gatewayPid}/cmdline`, 'utf8')).replaceAll('\0', ' '); }
    catch (e) { if (e.code !== 'ENOENT') throw e; command = ''; }
  }
  if (!command.trim()) return;
  const normalized = command.replaceAll('\\', '/').toLowerCase();
  if (!normalized.includes(path.join(record.input.paths.openclawRoot, 'openclaw.mjs').replaceAll('\\', '/').toLowerCase())
    || !normalized.includes(`--port ${record.port}`) || !normalized.includes('gateway')) throw new Error('Gateway process identity changed; did not terminate it');
  process.kill(record.gatewayPid, 'SIGTERM');
  for (let i = 0; i < 50; i++) {
    try { process.kill(record.gatewayPid, 0); } catch (e) {
      if (e.code === 'ESRCH') { if (record.processScope) await waitForSampleStop(record, { normal: true }); return; } throw e;
    }
    await sleep(100);
  }
  throw new Error('Gateway shutdown not confirmed');
}
