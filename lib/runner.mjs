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
import { snapshot, observe, settleAndClose } from './observation.mjs';
import { ensureExperimentClock, checkExperimentDeadline, expireExperiment } from './experiment-deadline.mjs';
import { startDeadlineWatchdog } from './deadline-watchdog.mjs';
import { saveRunRecord, startStatusHeartbeat } from './experiment-status.mjs';
export { snapshot, observe, settleAndClose } from './observation.mjs';

const execute = promisify(execFile);
const save = saveRunRecord;
async function closeGateway(record) {
  record.phase = 'STOPPING_GATEWAY'; await save(record);
  await stopGateway(record);
  record.gatewayStoppedAt = Date.now(); await save(record);
}
const event = (record, value) => fs.appendFile(path.join(record.runDir, 'logs/runner.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n');
const skip = new Set(['.git', '.runtime-correction']);
const generatedDependencies = ['node_modules', 'oh_modules'];
export function experimentExitCode(result) {
  if (result.status === 'PREPARED') return 0;
  if (result.status === 'FAILED') return 1;
  if (result.status === 'TIMED_OUT') return 4;
  if (result.status === 'TIMEOUT_CLEANUP_FAILED') return 5;
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
  await handle.writeFile(JSON.stringify({ pid: process.pid, token: randomUUID() }));
  return async () => { await handle.close(); await fs.unlink(lock); };
}
export async function prepare(input) {
  const id = `${input.id}-${new Date().toISOString().replace(/[-:.]/g, '')}-${randomUUID().slice(0, 8)}`;
  const runDir = path.join(input.paths.outputRoot, id);
  await fs.mkdir(input.paths.outputRoot, { recursive: true });
  await fs.mkdir(runDir);
  for (const dir of ['config', 'runtime', 'logs', 'rc-status', 'transcripts', 'artifacts']) await fs.mkdir(path.join(runDir, dir));
  const record = { version: 2, id, runDir, createdAt: new Date().toISOString(), phase: 'PREPARING', input: executionPlan(input),
    seedRoot: path.join(runDir, 'runtime/project'), home: path.join(runDir, 'runtime/home'), stateDir: path.join(runDir, 'runtime/state'),
    configPath: path.join(runDir, 'runtime/state/openclaw.json'), pluginDir: path.join(runDir, 'runtime/plugin'), port: await freePort(), terminals: {} };
  ensureExperimentClock(record);
  await save(record);
  const stopStatus = startStatusHeartbeat(record);
  console.log(`Run: ${record.runDir}`);
  try {
  for (const [from, name] of [[input.sampleFile, 'experiment.yaml'], [input.machineFile, 'machine.yaml'], [input.promptFile, 'prompt.md'], [input.rcConfigFile, 'rc-config.original.yaml']])
    await fs.copyFile(from, path.join(runDir, 'config', name));
  for (const [name, expected] of [['experiment.yaml', input.fingerprint.sampleSha256], ['machine.yaml', input.fingerprint.machineSha256],
    ['prompt.md', input.fingerprint.promptSha256], ['rc-config.original.yaml', input.fingerprint.rcConfigSha256]]) {
    if (hash(await fs.readFile(path.join(runDir, 'config', name))) !== expected) throw new Error(`Input changed while freezing ${name}: ${runDir}`);
  }
  await copyTree(input.projectDir, record.seedRoot, { skip });
  checkExperimentDeadline(record);
  if (!isDeepStrictEqual(await manifest(record.seedRoot), input.fingerprint.project)) throw new Error(`Input changed during copy: ${runDir}`);
  const archive = path.join(runDir, 'runtime/plugin.tgz');
  await fs.copyFile(input.paths.rcPluginPackage, archive);
  if (hash(await fs.readFile(archive)) !== input.fingerprint.pluginSha256) throw new Error('RC archive changed during preparation');
  await extractPackage(archive, record.pluginDir);
  checkExperimentDeadline(record);
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
  const git = async args => {
    checkExperimentDeadline(record);
    return execute(input.paths.git, ['-c', 'user.name=RC Experiment', '-c', 'user.email=rc-experiment@localhost', ...args],
      { cwd: record.seedRoot, windowsHide: true, timeout: Math.min(60000, record.experimentDeadlineAt - Date.now()) });
  };
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
  } catch (error) {
    // Preparation/command errors that hit the absolute limit are timeouts too.
    error.record ??= record;
    checkExperimentDeadline(record);
    throw error;
  } finally { await stopStatus(); }
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
  if (record.experimentDeadlineAt) checkExperimentDeadline(record);
  const originalPrompt = await fs.readFile(path.join(record.runDir, 'config/prompt.md'), 'utf8');
  const project = record.identity.projectRoot;
  const message = project ? `本次实验的实际项目目录是：${project}\n所有文件读写使用此目录下的绝对路径。执行项目命令前先运行：Set-Location -LiteralPath '${project.replaceAll("'", "''")}'。\n\n${originalPrompt}` : originalPrompt;
  await fs.writeFile(path.join(record.runDir, 'config/submitted-prompt.md'), message);
  record.submittedPromptSha256 = hash(message);
  // Native chat uses this idempotency key as runId. Persist before sending.
  record.requestId = randomUUID(); record.firstRunId = record.requestId;
  record.phase = 'SUBMITTING'; record.submittedAt = Date.now(); await save(record);
  try {
    const response = await rpc('chat.send', { sessionKey: record.identity.sessionKey, sessionId: record.identity.sessionId,
      message, thinking: 'off',
      idempotencyKey: record.requestId, timeoutMs: record.experimentDeadlineAt
        ? Math.max(1, Math.min(record.input.execution.businessTimeoutMs || Infinity, record.experimentDeadlineAt - Date.now()))
        : record.input.execution.businessTimeoutMs });
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
export async function checkpoint(record, result) {
  const { snapshot: _snapshot, ...summary } = result;
  record.phase = result.status; record.observerStoppedAt = Date.now();
  if (['TIMED_OUT', 'FAILED'].includes(result.status)) record.finishedAt = new Date().toISOString();
  const payload = { ...summary, id: record.id, identity: record.identity,
    observedAt: record.observerStoppedAt, gatewayRetained: Boolean(record.gatewayPid && !record.gatewayStoppedAt),
    partialProject: record.identity?.projectRoot ?? null, artifacts: null,
    note: result.status === 'TIMED_OUT'
      ? 'Sample stopped at its hard deadline. Partial project, raw state and logs retained in place; no successful completion or full artifact copy is claimed.'
      : result.status === 'TIMEOUT_CLEANUP_FAILED'
        ? 'Deadline expired, but process cleanup is unconfirmed. Original work and evidence retained.'
        : 'Observation stopped. Original work/state retained; the sample deadline remains enforced. Active project was not copied or declared finished.' };
  await writeJson(path.join(record.runDir, 'rc-status', `checkpoint-${Date.now()}-${randomUUID().slice(0, 8)}.json`), payload);
  await writeJson(path.join(record.runDir, 'result.json'), payload); await save(record);
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
  record.phase = 'ARCHIVING'; await save(record);
  // Archives are copies; the original worktree, raw state and logs remain available.
  const project = record.identity?.projectRoot;
  if (project) {
    await copyTree(project, path.join(record.runDir, 'artifacts/project'), { skip: new Set([...skip, ...generatedDependencies]) });
    const correction = path.join(project, '.runtime-correction');
    try { await copyTree(correction, path.join(record.runDir, 'rc-status/raw')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    const { stdout } = await execute(record.input.paths.git, ['diff', '--binary', 'HEAD'], { cwd: project, windowsHide: true, timeout: 30000, maxBuffer: 32 * 1024 * 1024 });
    await fs.writeFile(path.join(record.runDir, 'artifacts/changes.patch'), stdout);
  }
  const index = await captureTranscripts(record);
  const { snapshot: _snapshot, ...summary } = result;
  record.phase = result.status; record.finishedAt = new Date().toISOString();
  await writeJson(path.join(record.runDir, 'result.json'), { ...summary, id: record.id, identity: record.identity,
    archivedAt: record.finishedAt, artifacts: 'artifacts/project', excludedProjectDirectories: generatedDependencies, transcripts: 'transcripts/index.json',
    gatewayRetained: Boolean(record.gatewayPid && !record.gatewayStoppedAt), capturedTranscriptFiles: index.filter(item => !item.missing).length,
    missingTranscripts: index.filter(item => item.missing).map(item => item.source),
    note: 'Execution record only; no independent evaluation or score.' });
  await save(record);
}
export async function run(input, { prepareOnly = false, shouldStop, beforeStart, beforeDispatch, observerOptions } = {}) {
  let record;
  try { record = await prepare(input); }
  catch (e) {
    if (!e.record) throw e;
    record = e.record;
    const result = { status: e.code === 'EXPERIMENT_DEADLINE_EXPIRED' ? 'TIMED_OUT' : 'FAILED',
      reason: e.code ?? 'PREPARATION_FAILED', message: String(e.message), cleanupConfirmed: true, noModelDispatch: true };
    await checkpoint(record, result); return { record, result };
  }
  const release = await acquireController(record);
  const stopStatus = startStatusHeartbeat(record);
  let stopCapture;
  let result;
  try {
    if (beforeStart) { await beforeStart(record); await save(record); }
    checkExperimentDeadline(record);
    const rpc = await startGateway(record);
    checkExperimentDeadline(record);
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
      record.phase = 'PREPARED'; record.finishedAt = new Date().toISOString(); await save(record);
      return { record, result };
    }
    if (shouldStop?.()) throw new Error('Controller interrupted before prompt submission');
    checkExperimentDeadline(record);
    await startDeadlineWatchdog(record); await save(record);
    await dispatchOnce(record, rpc);
    result = await settleAndClose(record, rpc, { ...observerOptions, shouldStop, stop: closeGateway,
      onExpired: lastSnapshot => expireExperiment(record, null, { lastSnapshot }) });
    await stopCapture(); stopCapture = null;
    if (result.status === 'ARCHIVED') await archive(record, result);
    else await checkpoint(record, result);
  } catch (error) {
    const expired = Date.now() >= ensureExperimentClock(record);
    if (expired && record.processScope) result = await expireExperiment(record, null);
    else result = { status: expired && !record.gatewayPid ? 'TIMED_OUT' : 'NEEDS_ATTENTION', reason: error.code ?? 'RUNNER_ERROR', message: String(error.message), noModelDispatch: !record.firstRunId };
    await event(record, result);
    await checkpoint(record, result);
  } finally {
    try { if (stopCapture) await stopCapture(); }
    finally { try { await stopStatus(); } finally { await release(); } }
  }
  return { record, result };
}
export async function resume(runDir, { shouldStop, connect = connectHost, observerOptions } = {}) {
  const record = await json(path.join(path.resolve(runDir), 'run.json'));
  if (path.resolve(record.runDir) !== path.resolve(runDir)) throw new Error('Run directory identity changed');
  if (['ARCHIVED', 'TIMED_OUT'].includes(record.phase)) throw new Error('Already finished; original run preserved');
  ensureExperimentClock(record);
  if (Date.now() < record.experimentDeadlineAt && (!record.identity || !record.firstRunId))
    throw new Error('No submitted run to observe; inspect run.json and logs manually');
  const release = await acquireController(record);
  const stopStatus = startStatusHeartbeat(record);
  let stopCapture;
  try {
    if (Date.now() >= record.experimentDeadlineAt) {
      const lastSnapshot = await json(path.join(record.runDir, 'rc-status/latest.json')).catch(() => null);
      const result = await expireExperiment(record, null, { lastSnapshot });
      await checkpoint(record, result);
      return { record, result };
    }
    let rpc;
    record.phase = 'RECONNECTING'; delete record.observerStoppedAt; await save(record);
    try { rpc = await connect(record); await rpc('health', {}, 5000); }
    catch (error) {
      const result = { status: 'NEEDS_ATTENTION', reason: 'GATEWAY_UNAVAILABLE', message: String(error.message),
        host: record.terminals, rc: { status: 'UNKNOWN', ended: null }, identity: record.identity,
        note: 'Original IDs preserved. No session allocation, prompt retransmission or automatic Gateway restart.' };
      await checkpoint(record, result);
      return { record, result };
    }
    record.phase = 'OBSERVING'; await save(record);
    stopCapture = await startCapture(record);
    const result = await settleAndClose(record, rpc, { ...observerOptions, shouldStop, stop: closeGateway,
      onExpired: lastSnapshot => expireExperiment(record, null, { lastSnapshot }) });
    await stopCapture(); stopCapture = null;
    if (result.status === 'ARCHIVED') await archive(record, result);
    else await checkpoint(record, result);
    return { record, result };
  } finally {
    try { if (stopCapture) await stopCapture(); }
    finally { try { await stopStatus(); } finally { await release(); } }
  }
}
