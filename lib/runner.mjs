import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isDeepStrictEqual } from 'node:util';
import { executionPlan } from './config.mjs';
import { json, writeJson, extractPackage, copyTree, manifest, hash, filesUnder, within } from './files.mjs';
import { configureHost, isolatedEnvironment, freePort, startGateway, connectHost, stopGateway, sleep } from './host.mjs';
import { privateState, completion, runIds } from './settlement.mjs';

const execute = promisify(execFile);
const save = record => writeJson(path.join(record.runDir, 'run.json'), record);
async function closeGateway(record) {
  await stopGateway(record);
  record.gatewayStoppedAt = Date.now(); await save(record);
}
const event = (record, value) => fs.appendFile(path.join(record.runDir, 'logs/runner.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n');
const skip = new Set(['.git', '.runtime-correction']);
export function experimentExitCode(result) {
  if (result.status === 'PREPARED') return 0;
  if (result.status !== 'ARCHIVED') return 2;
  return Object.values(result.host ?? {}).some(terminal => terminal.status === 'error') ? 3 : 0;
}
async function acquireController(record) {
  const lock = path.join(record.runDir, 'controller.lock');
  let handle;
  try { handle = await fs.open(lock, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = await json(lock);
    try { process.kill(owner.pid, 0); throw new Error(`Run is already observed by PID ${owner.pid}`); }
    catch (e) { if (e.code !== 'ESRCH') throw e; }
    await fs.unlink(lock);
    handle = await fs.open(lock, 'wx', 0o600);
  }
  await handle.writeFile(JSON.stringify({ pid: process.pid }));
  return async () => { await handle.close(); await fs.unlink(lock); };
}
export async function prepare(input) {
  const id = `${input.id}-${new Date().toISOString().replace(/[-:.]/g, '')}-${randomUUID().slice(0, 8)}`;
  const runDir = path.join(input.paths.outputRoot, id);
  await fs.mkdir(input.paths.outputRoot, { recursive: true });
  await fs.mkdir(runDir);
  for (const dir of ['config', 'runtime', 'logs', 'rc-status', 'transcripts', 'artifacts']) await fs.mkdir(path.join(runDir, dir));
  const record = { version: 1, id, runDir, createdAt: new Date().toISOString(), phase: 'PREPARING', input: executionPlan(input),
    seedRoot: path.join(runDir, 'runtime/project'), home: path.join(runDir, 'runtime/home'), stateDir: path.join(runDir, 'runtime/state'),
    configPath: path.join(runDir, 'runtime/state/openclaw.json'), pluginDir: path.join(runDir, 'runtime/plugin'), port: await freePort(), terminals: {} };
  await save(record);
  console.log(`Run: ${record.runDir}`);
  for (const [from, name] of [[input.sampleFile, 'experiment.yaml'], [input.machineFile, 'machine.yaml'], [input.promptFile, 'prompt.md'], [input.rcConfigFile, 'rc-config.original.yaml']])
    await fs.copyFile(from, path.join(runDir, 'config', name));
  for (const [name, expected] of [['experiment.yaml', input.fingerprint.sampleSha256], ['machine.yaml', input.fingerprint.machineSha256],
    ['prompt.md', input.fingerprint.promptSha256], ['rc-config.original.yaml', input.fingerprint.rcConfigSha256]]) {
    if (hash(await fs.readFile(path.join(runDir, 'config', name))) !== expected) throw new Error(`Input changed while freezing ${name}: ${runDir}`);
  }
  await copyTree(input.projectDir, record.seedRoot, { skip });
  if (!isDeepStrictEqual(await manifest(record.seedRoot), input.fingerprint.project)) throw new Error(`Input changed during copy: ${runDir}`);
  const archive = path.join(runDir, 'runtime/plugin.tgz');
  await fs.copyFile(input.paths.rcPluginPackage, archive);
  if (hash(await fs.readFile(archive)) !== input.fingerprint.pluginSha256) throw new Error('RC archive changed during preparation');
  await extractPackage(archive, record.pluginDir);
  const payload = path.join(record.pluginDir, 'payload/runtime-corrector');
  const packageInfo = await json(path.join(record.pluginDir, 'package.json'));
  const pluginInfo = await json(path.join(payload, 'openclaw.plugin.json'));
  if (packageInfo.name !== 'runtime-corrector-ma' || packageInfo.version !== '1.11.0' || pluginInfo.version !== '1.11.0') throw new Error('Use the RC 1.11.0 MA package with session runtime controls');
  await fs.access(path.join(payload, 'lib/openclaw/session-runtime-client.mjs'));
  // Only this run's extracted template is changed; original package/input stays frozen.
  await fs.copyFile(path.join(runDir, 'config/rc-config.original.yaml'), path.join(payload, '.runtime-corrector-default/config.yaml'));
  const { initializeProjectConfig } = await import(pathToFileURL(path.join(payload, 'lib/openclaw/project-settings.mjs')));
  await initializeProjectConfig({ projectRoot: record.seedRoot, pluginRoot: payload, reviewerModel: () => input.models.reviewer, assertCurrent: async () => {} });
  await fs.copyFile(path.join(record.seedRoot, '.runtime-corrector/config.yaml'), path.join(runDir, 'config/rc-config.effective.yaml'));
  const git = async args => execute(input.paths.git, ['-c', 'user.name=RC Experiment', '-c', 'user.email=rc-experiment@localhost', ...args], { cwd: record.seedRoot, windowsHide: true });
  await git(['init', '-q']);
  await git(['config', 'core.autocrlf', 'false']);
  await git(['config', 'core.longpaths', 'true']);
  const hooksDir = path.join(runDir, 'runtime/git-hooks'); await fs.mkdir(hooksDir);
  await git(['config', 'core.hooksPath', hooksDir]);
  await git(['config', 'commit.gpgsign', 'false']);
  await fs.appendFile(path.join(record.seedRoot, '.git/info/exclude'), '\n.runtime-correction/\n.runtime-corrector/sessions.local.yaml\n');
  await git(['add', '--all', '--force', '.']);
  await git(['commit', '-qm', 'Experiment input and effective RC configuration']);
  record.seedCommit = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  await configureHost(record, input);
  record.phase = 'STARTING'; await save(record);
  return record;
}
export async function createSession(record, rpc) {
  const agentId = record.input.models.agentId;
  record.sessionKeyRequested = `agent:${agentId}:rc-exp:${record.id.toLowerCase()}`;
  record.phase = 'CREATING_SESSION'; await save(record);
  const created = await rpc('sessions.create', { key: record.sessionKeyRequested, agentId,
    model: record.input.models.business, emitCommandHooks: true, worktree: true });
  await writeJson(path.join(record.runDir, 'rc-status/session-created.json'), created);
  if (!created.sessionId || !created.worktree?.path || created.runStarted) throw new Error('Unexpected native session/worktree receipt');
  const projectRoot = await fs.realpath(created.worktree.path);
  if (!within(record.runDir, projectRoot)) throw new Error('Host returned project outside isolated run directory');
  record.identity = { agentId, sessionKey: created.key, sessionId: created.sessionId, projectRoot };
  record.phase = 'ENABLING_RC'; await save(record);
  const enabled = await rpc('runtime-corrector.session.set', { agentId, sessionKey: created.key, sessionId: created.sessionId, enabled: true });
  await writeJson(path.join(record.runDir, 'rc-status/enabled.json'), enabled);
  if (!enabled.effectiveEnabled || path.resolve(enabled.projectRoot) !== projectRoot) throw new Error('RC did not enable on actual session project');
  record.phase = 'READY'; await save(record);
}
export async function dispatchOnce(record, rpc) {
  if (record.requestId || record.firstRunId) throw new Error('Prompt was already submitted or submission is uncertain; resume observation instead');
  // Native chat uses this idempotency key as runId. Persist before sending.
  record.requestId = randomUUID(); record.firstRunId = record.requestId;
  record.phase = 'SUBMITTING'; record.submittedAt = Date.now(); await save(record);
  try {
    const response = await rpc('chat.send', { sessionKey: record.identity.sessionKey, sessionId: record.identity.sessionId,
      message: await fs.readFile(path.join(record.runDir, 'config/prompt.md'), 'utf8'), thinking: 'off',
      idempotencyKey: record.requestId, timeoutMs: record.input.execution.businessTimeoutMs });
    await writeJson(path.join(record.runDir, 'rc-status/send-receipt.json'), response);
    if (response.runId && response.runId !== record.requestId) {
      record.firstRunId = response.runId;
    }
    record.sendAcknowledged = true;
  } catch (error) {
    record.sendAcknowledged = false;
    await event(record, { type: 'SEND_ACK_MISSING', message: String(error.message) });
  }
  record.phase = 'OBSERVING'; await save(record);
}
export async function snapshot(record, rpc) {
  const rc = await rpc('runtime-corrector.runtime.refresh', record.identity);
  const page = await rpc('runtime-corrector.dispatch.list', { offset: 0, limit: 100, filter: 'all' });
  const dispatch = [];
  for (const item of page.sessions ?? []) if (item.sessionId === record.identity.sessionId && item.sessionKey === record.identity.sessionKey) {
    dispatch.push(await rpc('runtime-corrector.dispatch.get', Object.fromEntries(['id', 'agentId', 'sessionKey', 'sessionId', 'scopeFingerprint'].map(k => [k, item[k]]))));
  }
  const captured = { at: Date.now(), rc, dispatch, private: await privateState(record) };
  for (const runId of runIds(captured, record.firstRunId)) {
    if (['ok', 'error'].includes(record.terminals[runId]?.status)) continue;
    try {
      const terminal = await rpc('agent.wait', { runId, timeoutMs: 1000 }, 15000);
      if (['ok', 'error'].includes(terminal.status)) record.terminals[runId] = terminal;
    } catch (error) { await event(record, { type: 'TERMINAL_READ_FAILED', runId, message: String(error.message) }); }
  }
  captured.completion = completion(captured, record.terminals, record.firstRunId);
  await writeJson(path.join(record.runDir, 'rc-status/latest.json'), captured);
  await fs.appendFile(path.join(record.runDir, 'rc-status/history.jsonl'), JSON.stringify(captured) + '\n');
  await save(record);
  return captured;
}
export async function observe(record, rpc, { shouldStop = () => false, readSnapshot = snapshot } = {}) {
  const started = Date.now();
  let lastReport = 0;
  let readFailures = 0;
  for (;;) {
    if (shouldStop()) return { status: 'NEEDS_ATTENTION', reason: 'CONTROLLER_INTERRUPTED' };
    const timeout = record.input.execution.observerTimeoutMs;
    if (timeout && Date.now() - started >= timeout) return { status: 'NEEDS_ATTENTION', reason: 'OBSERVER_DEADLINE_EXPIRED' };
    let current;
    try { current = await readSnapshot(record, rpc); }
    catch (error) {
      readFailures++;
      if (readFailures >= 3) return { status: 'NEEDS_ATTENTION', reason: 'OBSERVATION_FAILED', message: String(error.message) };
      await sleep(record.input.execution.pollIntervalMs); continue;
    }
    readFailures = 0;
    if (Date.now() - lastReport > 30000) {
      console.log(`[${record.id}] RC ${current.rc?.status}/${current.rc?.stage}; ${current.completion.reasons.join(', ') || 'settled'}`);
      lastReport = Date.now();
    }
    if (current.completion.settled) return { status: 'ARCHIVED', host: record.terminals, rc: current.rc, snapshot: current };
    await sleep(record.input.execution.pollIntervalMs);
  }
}
export async function captureTranscripts(record) {
  const indexFile = path.join(record.runDir, 'transcripts/index.json');
  const previous = await json(indexFile).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
  const indexed = new Map(previous.map(item => [item.source, item]));
  const sources = new Set((await filesUnder(path.join(record.stateDir, 'agents'))).filter(f => f.endsWith('.jsonl')));
  if (record.identity) for (const file of await filesUnder(path.join(record.identity.projectRoot, '.runtime-correction/openclaw/native-runs'))) {
    if (!file.endsWith('.json')) continue;
    const work = await json(file);
    if (work.sessionFile) {
      if (!within(record.runDir, work.sessionFile)) throw new Error('Private transcript outside this run');
      sources.add(work.sessionFile);
    }
  }
  for (const file of sources) {
    const dest = `${hash(file).slice(0, 16)}-${path.basename(file)}`;
    try {
      const data = await fs.readFile(file);
      await fs.writeFile(path.join(record.runDir, 'transcripts', dest), data);
      indexed.set(file, { source: file, file: dest, sha256: hash(data), bytes: data.length, capturedAt: Date.now() });
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      if (!indexed.has(file)) indexed.set(file, { source: file, missing: true, reason: 'SOURCE_REMOVED_BEFORE_CAPTURE' });
    }
  }
  await writeJson(indexFile, [...indexed.values()]);
  return [...indexed.values()];
}
async function startCapture(record) {
  let stopping = false, lastError;
  const job = (async () => {
    while (!stopping) {
      try { await captureTranscripts(record); }
      catch (error) { lastError = String(error.message); }
      await sleep(300);
    }
  })();
  return async () => { stopping = true; await job; if (lastError) await event(record, { type: 'CAPTURE_ERROR', message: lastError }); };
}
export async function archive(record, result) {
  // Archives are copies; the original worktree, raw state and logs remain available.
  const project = record.identity?.projectRoot;
  if (project) {
    await copyTree(project, path.join(record.runDir, 'artifacts/project'), { skip });
    const correction = path.join(project, '.runtime-correction');
    try { await copyTree(correction, path.join(record.runDir, 'rc-status/raw')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    const { stdout } = await execute(record.input.paths.git, ['diff', '--binary', 'HEAD'], { cwd: project, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
    await fs.writeFile(path.join(record.runDir, 'artifacts/changes.patch'), stdout);
  }
  const index = await captureTranscripts(record);
  const { snapshot: _snapshot, ...summary } = result;
  record.phase = result.status; record.finishedAt = new Date().toISOString();
  await writeJson(path.join(record.runDir, 'result.json'), { ...summary, id: record.id, identity: record.identity,
    archivedAt: record.finishedAt, artifacts: 'artifacts/project', transcripts: 'transcripts/index.json',
    gatewayRetained: Boolean(record.gatewayPid && !record.gatewayStoppedAt), capturedTranscriptFiles: index.filter(item => !item.missing).length,
    missingTranscripts: index.filter(item => item.missing).map(item => item.source),
    note: 'Execution record only; no independent evaluation or score.' });
  await save(record);
}
export async function run(input, { prepareOnly = false, shouldStop, beforeStart, beforeDispatch } = {}) {
  const record = await prepare(input);
  const release = await acquireController(record);
  let stopCapture;
  let result;
  try {
    if (beforeStart) { await beforeStart(record); await save(record); }
    const rpc = await startGateway(record);
    await createSession(record, rpc);
    stopCapture = await startCapture(record);
    await beforeDispatch?.(record);
    if (prepareOnly) {
      // No chat.send; no model run has been allocated.
      const flags = await rpc('runtime-corrector.session.get', { agentId: record.identity.agentId, sessionKey: record.identity.sessionKey, sessionId: record.identity.sessionId });
      if (!flags.effectiveEnabled) throw new Error('RC not enabled');
      await closeGateway(record);
      result = { status: 'PREPARED', host: null, rc: flags, gatewayRetained: false, noModelDispatch: true };
      await writeJson(path.join(record.runDir, 'result.json'), result);
      record.phase = 'PREPARED'; await save(record);
      return { record, result };
    }
    if (shouldStop?.()) throw new Error('Controller interrupted before prompt submission');
    await dispatchOnce(record, rpc);
    result = await observe(record, rpc, { shouldStop });
    if (result.status === 'ARCHIVED') await closeGateway(record);
    await stopCapture(); stopCapture = null;
    await archive(record, result);
  } catch (error) {
    result = { status: 'NEEDS_ATTENTION', reason: 'RUNNER_ERROR', message: String(error.message) };
    await event(record, result);
    record.phase = 'NEEDS_ATTENTION'; await save(record);
    await writeJson(path.join(record.runDir, 'result.json'), { ...result, gatewayRetained: Boolean(record.gatewayPid && !record.gatewayStoppedAt) });
  } finally { if (stopCapture) await stopCapture(); await release(); }
  return { record, result };
}
export async function resume(runDir, { shouldStop, connect = connectHost } = {}) {
  const record = await json(path.join(path.resolve(runDir), 'run.json'));
  if (path.resolve(record.runDir) !== path.resolve(runDir)) throw new Error('Run directory identity changed');
  if (!record.identity || !record.firstRunId) throw new Error('No submitted run to observe; inspect run.json and logs manually');
  if (record.phase === 'ARCHIVED') throw new Error('Already archived; original run preserved');
  const release = await acquireController(record);
  let stopCapture;
  try {
    let rpc;
    try { rpc = await connect(record); await rpc('health', {}, 5000); }
    catch (error) {
      const result = { status: 'NEEDS_ATTENTION', reason: 'GATEWAY_UNAVAILABLE', message: String(error.message),
        host: record.terminals, rc: { status: 'UNKNOWN', ended: null }, identity: record.identity,
        note: 'Original IDs preserved. No session allocation, prompt retransmission or automatic Gateway restart.' };
      record.phase = result.status;
      await writeJson(path.join(record.runDir, 'result.json'), result); await save(record);
      return { record, result };
    }
    stopCapture = await startCapture(record);
    const result = await observe(record, rpc, { shouldStop });
    if (result.status === 'ARCHIVED') await closeGateway(record);
    await stopCapture(); stopCapture = null;
    await archive(record, result);
    return { record, result };
  } finally { if (stopCapture) await stopCapture(); await release(); }
}
