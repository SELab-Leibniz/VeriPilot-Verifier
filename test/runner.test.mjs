import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chooseModels } from '../lib/config.mjs';
import { completion, privateState } from '../lib/settlement.mjs';
import { dispatchOnce, observe, captureTranscripts, experimentExitCode, resume, archive } from '../lib/runner.mjs';
import { isolatedEnvironment, activateIsolatedEnvironment } from '../lib/host.mjs';
import { within, extractPackage, writeJson, json, redact } from '../lib/files.mjs';

const source = { agents: { defaults: { model: { primary: 'p/business' } }, list: [{ id: 'main', default: true }] },
  models: { providers: { p: { models: [{ id: 'business' }, { id: 'reviewer' }] } } },
  plugins: { entries: { 'runtime-corrector': { config: { reviewerModel: 'p/reviewer' } } } } };
const settled = () => ({ rc: { ended: true, active: false, pendingUserTasks: 0, status: 'ENDED', runId: 'r1', roundId: 'round1' },
  dispatch: [{ phase: 'IDLE', runId: 'r1', pending: [] }], private: { dispatch: [{ phase: 'IDLE', runId: 'r1', pending: [] }], reviews: [], nativeReviews: [], ledgers: [] } });

test('current RC INTERRUPTED can settle only with fresh status, native terminals and no remaining private work', () => {
  const snapshot = settled(), terminals = { r1: { runId: 'r1', status: 'error' } };
  snapshot.rc.status = 'INTERRUPTED'; snapshot.rc.phase = 'CLOSED'; snapshot.rc.health = 'SETTLED';
  assert.equal(completion(snapshot, terminals, 'r1').settled, true);
  snapshot.rc.phase = 'IDLE';
  assert.equal(completion(snapshot, terminals, 'r1').settled, false);
  snapshot.rc.phase = 'CLOSED';
  assert.equal(completion(snapshot, {}, 'r1').settled, false);
  snapshot.private.nativeReviews.push({ status: 'WAITING_FOR_AGENT_SLOT' });
  assert.equal(completion(snapshot, terminals, 'r1').settled, false);
  snapshot.private.nativeReviews.length = 0; snapshot.rc.health = 'OWNER_EXITED';
  assert.equal(completion(snapshot, terminals, 'r1').settled, false);
});
test('auto selects existing host models; unavailable explicit roles fail', () => {
  assert.deepEqual(chooseModels(source), { agentId: 'main', business: 'p/business', reviewer: 'p/reviewer' });
  assert.throws(() => chooseModels(source, { agent: 'missing' }), /No configured agent/);
  assert.throws(() => chooseModels(source, { reviewer: 'p/not-installed' }), /Unavailable/);
});
test('completion waits for native terminal even when public RC says ended', () => {
  assert.equal(completion(settled(), { r1: { runId: 'r1', status: 'ok' } }, 'r1').settled, true);
  assert.equal(completion(settled(), { r1: { runId: 'r1', status: 'timeout' } }, 'r1').settled, false);
});
test('disabled requirement extraction leaves a metadata cursor without releasing queued users, private work or reservations', () => {
  const s = settled(), terminals = { r1: { runId: 'r1', status: 'ok' } };
  s.dispatch[0].requirements = { version: 0, pending: true, pendingUserCursor: 'original-user' };
  assert.equal(completion(s, terminals, 'r1').settled, false);
  s.requirementsRefreshEnabled = true;
  assert.equal(completion(s, terminals, 'r1').settled, false);
  s.requirementsRefreshEnabled = false;
  assert.equal(completion(s, terminals, 'r1').settled, true);
  assert.equal(completion(s, {}, 'r1').settled, false);
  for (const mutate of [s => s.rc.pendingUserTasks = 1, s => s.dispatch[0].pending.push({ id: 'next-user' }),
    s => s.private.nativeReviews.push({ status: 'WAITING_FOR_AGENT_SLOT' }),
    s => s.private.ledgers.push({ admissions: { a: { accounting: 'RESERVED' } } })]) {
    const copy = structuredClone(s); mutate(copy); assert.equal(completion(copy, terminals, 'r1').settled, false);
  }
});
test('completion blocks queued tasks, repair dispatch, private reviewer and reservations', () => {
  const mutations = [
    s => s.rc.pendingUserTasks = 1,
    s => s.dispatch[0].dispatching = { status: 'UNKNOWN' },
    s => s.private.dispatch[0].candidate = { runId: 'r2' },
    s => s.private.dispatch[0].correctionRunId = 'r2',
    s => s.private.reviews.push({ status: 'RUNNING' }),
    s => s.private.nativeReviews.push({ status: 'DISPATCH_COMMITTED' }),
    s => s.private.ledgers.push({ admissions: { a: { accounting: 'RESERVED' } } }),
    s => s.private.ledgers.push({ admissions: { a: { accounting: 'RESERVED', invalidatedAt: 123, startStatus: 'UNCERTAIN' } } }),
    s => s.private.ledgers.push({ stops: { a: { control: 'WAIT_DELIVERY' } } }),
    s => s.rc.status = 'UNKNOWN',
    s => s.private.dispatch = []
  ];
  for (const mutate of mutations) { const s = settled(); mutate(s); assert.equal(completion(s, { r1: { runId: 'r1', status: 'ok' } }, 'r1').settled, false); }
});
test('an automatic followup needs its own terminal', () => {
  const s = settled(); s.rc.runId = 'r2'; s.dispatch[0].runId = 'r2'; s.private.dispatch[0].runId = 'r2';
  assert.equal(completion(s, { r1: { runId: 'r1', status: 'ok' } }, 'r1').settled, false);
  assert.equal(completion(s, { r1: { runId: 'r1', status: 'ok' }, r2: { runId: 'r2', status: 'error' } }, 'r1').settled, true);
});
test('lost send acknowledgement persists original ID and never retransmits', async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-runner-send-'));
  await fs.mkdir(path.join(runDir, 'config')); await fs.mkdir(path.join(runDir, 'logs'));
  await fs.writeFile(path.join(runDir, 'config/prompt.md'), 'do task');
  const record = { runDir, identity: { sessionKey: 'agent:main:test', sessionId: 's' }, input: { execution: { businessTimeoutMs: 0 } } };
  let calls = 0;
  const rpc = async (method, params) => {
    calls++; assert.equal(method, 'chat.send');
    const saved = await json(path.join(runDir, 'run.json'));
    assert.equal(saved.requestId, params.idempotencyKey); assert.equal(params.timeoutMs, 0);
    throw new Error('transport lost after acceptance');
  };
  await dispatchOnce(record, rpc);
  assert.equal(record.sendAcknowledged, false);
  await assert.rejects(() => dispatchOnce(record, rpc), /already submitted/);
  assert.equal(calls, 1);
});

test('submitted task binds file tools and commands to the actual Session worktree while preserving original prompt bytes', async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-session-workspace-'));
  await fs.mkdir(path.join(runDir, 'config')); await fs.mkdir(path.join(runDir, 'logs'));
  const original = 'Implement quicksort.py and run tests.\n';
  await fs.writeFile(path.join(runDir, 'config/prompt.md'), original);
  const projectRoot = path.join(runDir, "session's worktree");
  const record = { runDir, identity: { sessionKey: 'agent:main:test', sessionId: 's', projectRoot },
    input: { execution: { businessTimeoutMs: 0 } } };
  await dispatchOnce(record, async (method, params) => {
    assert.equal(method, 'chat.send'); assert.ok(params.message.includes(projectRoot));
    assert.ok(params.message.includes("session''s worktree")); assert.ok(params.message.endsWith(original));
    assert.equal(await fs.readFile(path.join(runDir, 'config/submitted-prompt.md'), 'utf8'), params.message);
    return { runId: params.idempotencyKey };
  });
  assert.equal(await fs.readFile(path.join(runDir, 'config/prompt.md'), 'utf8'), original);
  assert.equal(record.sendAcknowledged, true); assert.ok(record.submittedPromptSha256);
});
test('observer interrupt and network failure preserve unresolved run', async () => {
  const record = { input: { execution: { observerTimeoutMs: 0, pollIntervalMs: 100 } } };
  assert.equal((await observe(record, null, { shouldStop: () => true })).reason, 'CONTROLLER_INTERRUPTED');
  const result = await observe(record, null, { readSnapshot: async () => { throw new Error('offline'); } });
  assert.equal(result.status, 'NEEDS_ATTENTION');
  assert.equal(result.reason, 'OBSERVATION_FAILED');
});
test('settled provider failure is archived truthfully and stops a batch with nonzero exit', async () => {
  const s = settled(); s.rc.outcome = 'UNVERIFIED'; s.rc.reasonCode = 'HOST_RUN_NOT_COMPLETED';
  s.completion = { settled: true, reasons: [] };
  const record = { id: 'fault', firstRunId: 'r1', input: { execution: { observerTimeoutMs: 0 } }, terminals: { r1: { runId: 'r1', status: 'error', error: 'DNS error' } } };
  const result = await observe(record, null, { readSnapshot: async () => s });
  assert.equal(result.status, 'ARCHIVED'); assert.equal(result.rc.outcome, 'UNVERIFIED');
  assert.equal(result.host.r1.status, 'error'); assert.equal(experimentExitCode(result), 3);
});
test('resume on a disconnected machine preserves IDs and records unknown without allocating or resending', async () => {
  const runDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-offline-resume-')));
  const original = { runDir, identity: { projectRoot: path.join(runDir, 'project'), sessionId: 's', sessionKey: 'agent:main:s' },
    firstRunId: 'original', requestId: 'original', phase: 'OBSERVING', terminals: {} };
  await writeJson(path.join(runDir, 'run.json'), original);
  const calls = [];
  const { record, result } = await resume(runDir, { connect: async () => async method => { calls.push(method); throw new Error('original Gateway offline'); } });
  assert.deepEqual(calls, ['health']); assert.equal(result.reason, 'GATEWAY_UNAVAILABLE');
  assert.equal(experimentExitCode(result), 2); assert.equal(result.rc.ended, null);
  assert.equal(record.firstRunId, 'original'); assert.equal((await json(path.join(runDir, 'run.json'))).requestId, 'original');
  assert.equal((await json(path.join(runDir, 'result.json'))).status, 'NEEDS_ATTENTION');
});
test('machine paths/environment reach child; production OpenClaw overrides removed', () => {
  const old = process.env.OPENCLAW_GATEWAY_TOKEN; process.env.OPENCLAW_GATEWAY_TOKEN = 'production';
  try {
    const env = isolatedEnvironment({ runDir: 'run', home: 'new-home', configPath: 'new-config', stateDir: 'new-state',
      input: { paths: { openclawRoot: 'host' }, environment: { DEVECO_SDK_HOME: 'sdk', JAVA_HOME: 'java' }, binPaths: ['custom-bin'] } });
    assert.equal(env.DEVECO_SDK_HOME, 'sdk'); assert.equal(env.OPENCLAW_STATE_DIR, 'new-state');
    assert.equal(env.TEMP, env.TMPDIR); assert.equal(env.TMP, env.TEMP);
    assert.equal(env.PSModuleAnalysisCachePath, path.join('run', 'runtime/tmp/powershell-module-cache'));
    assert.equal(env.OPENCLAW_GATEWAY_TOKEN, undefined); assert.ok(env.PATH.startsWith('custom-bin'));
  } finally { if (old === undefined) delete process.env.OPENCLAW_GATEWAY_TOKEN; else process.env.OPENCLAW_GATEWAY_TOKEN = old; }
});
test('parent SDK process also drops inherited OpenClaw overrides', () => {
  const previous = { ...process.env };
  try {
    process.env.OPENCLAW_GATEWAY_TOKEN = 'old-profile-token';
    process.env.OPENCLAW_PROFILE = 'production';
    activateIsolatedEnvironment({ runDir: 'run', home: 'home', configPath: 'config', stateDir: 'state',
      input: { paths: { openclawRoot: 'host' }, environment: {}, binPaths: [] } });
    assert.equal(process.env.OPENCLAW_GATEWAY_TOKEN, undefined);
    assert.equal(process.env.OPENCLAW_PROFILE, undefined);
    assert.equal(process.env.OPENCLAW_CONFIG_PATH, 'config');
  } finally {
    for (const key of Object.keys(process.env)) if (!Object.hasOwn(previous, key)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});
test('path containment and redaction', () => {
  assert.equal(within(path.resolve('a'), path.resolve('a/b')), true);
  assert.equal(within(path.resolve('a'), path.resolve('ab')), false);
  assert.equal(redact({ x: { apiKey: 'key', model: 'ok' }, token: 'secret' }).x.apiKey, '[REDACTED]');
});
test('reviewer native session identity does not hide pending private work', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-private-'));
  await writeJson(path.join(root, '.runtime-correction/openclaw/native-runs/task/reviewer.json'),
    { sessionId: 'private-reviewer-session', status: 'DISPATCH_COMMITTED', runId: 'review-run' });
  const state = await privateState({ identity: { projectRoot: root, sessionId: 'business-session' }, stateDir: path.join(root, 'state') });
  assert.equal(state.nativeReviews.length, 1);
  assert.equal(state.nativeReviews[0].runId, 'review-run');
});
test('capture preserves final private JSONL after temporary source disappears', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-capture-'));
  await fs.mkdir(path.join(root, 'transcripts'));
  const source = path.join(root, 'runtime/tmp/review/host-session.jsonl');
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, '{"message":"review"}\n');
  const projectRoot = path.join(root, 'project');
  await writeJson(path.join(projectRoot, '.runtime-correction/openclaw/native-runs/task/run.json'),
    { sessionId: 'reviewer', ownerPid: 123, sessionFile: source, status: 'SETTLED' });
  const record = { runDir: root, stateDir: path.join(root, 'state'), identity: { projectRoot } };
  await captureTranscripts(record);
  await fs.unlink(source);
  const index = await captureTranscripts(record);
  assert.equal(index[0].missing, undefined);
  assert.equal(await fs.readFile(path.join(root, 'transcripts', index[0].file), 'utf8'), '{"message":"review"}\n');
});
test('real RC archive extracts with USTAR checksum validation', { skip: !process.env.RC_TEST_PACKAGE }, async () => {
  const dest = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-runner-package-'));
  await extractPackage(process.env.RC_TEST_PACKAGE, dest);
  assert.equal((await json(path.join(dest, 'payload/runtime-corrector/openclaw.plugin.json'))).id, 'runtime-corrector');
});

test('archiving keeps generated output and source while excluding rebuildable dependency junctions', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-archive-links-')));
  const project = path.join(root, 'run/project'), runDir = path.join(root, 'run'), shared = path.join(root, 'shared-dependency');
  await fs.mkdir(project, { recursive: true }); await fs.mkdir(shared);
  await fs.writeFile(path.join(shared, 'external.txt'), 'shared dependency stays in place');
  await fs.writeFile(path.join(project, 'source.txt'), 'original source');
  await fs.writeFile(path.join(project, '.gitignore'), 'node_modules/\noh_modules/\n');
  const git = args => execFileSync('git', ['-C', project, '-c', 'user.name=RC Test', '-c', 'user.email=rc-test@localhost',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=nonexistent', ...args], { windowsHide: true });
  git(['init', '-q']); git(['add', 'source.txt', '.gitignore']); git(['commit', '-qm', 'Original input']);
  await fs.writeFile(path.join(project, 'source.txt'), 'final source');
  await fs.mkdir(path.join(project, 'build')); await fs.writeFile(path.join(project, 'build/result.txt'), 'generated build output');
  for (const name of ['node_modules', 'oh_modules']) {
    await fs.mkdir(path.join(project, name)); await fs.symlink(shared, path.join(project, name, 'package'), process.platform === 'win32' ? 'junction' : 'dir');
  }
  const record = { id: 'archive-test', runDir, stateDir: path.join(runDir, 'state'), identity: { projectRoot: project, agentId: 'main', sessionId: 's', sessionKey: 'agent:main:s' },
    input: { paths: { git: 'git' } }, terminals: {} };
  await archive(record, { status: 'ARCHIVED', host: {}, rc: { status: 'ENDED' } });
  const output = path.join(runDir, 'artifacts/project');
  assert.equal(await fs.readFile(path.join(output, 'source.txt'), 'utf8'), 'final source');
  assert.equal(await fs.readFile(path.join(output, 'build/result.txt'), 'utf8'), 'generated build output');
  for (const name of ['node_modules', 'oh_modules']) await assert.rejects(() => fs.lstat(path.join(output, name)), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(shared, 'external.txt'), 'utf8'), 'shared dependency stays in place');
  assert.deepEqual((await json(path.join(runDir, 'result.json'))).excludedProjectDirectories, ['node_modules', 'oh_modules']);
  const patch = await fs.readFile(path.join(runDir, 'artifacts/changes.patch'), 'utf8');
  assert.match(patch, /final source/);
  assert.match(patch, /--- \/dev\/null\n\+\+\+ b\/build\/result\.txt\n@@ [^\n]+ @@\n\+generated build output/);
  assert.doesNotMatch(patch, /node_modules|oh_modules|external\.txt/);
  assert.equal(execFileSync('git', ['-C', project, 'status', '--porcelain'], { encoding: 'utf8' }), ' M source.txt\n?? build/\n');
  assert.deepEqual((await fs.readdir(path.join(runDir, 'artifacts'))).sort(), ['changes.patch', 'project']);
});
test('change patch keeps force-added baseline files and leaves out dependency folders even without .gitignore', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-archive-patch-')));
  const project = path.join(root, 'run/project'), runDir = path.join(root, 'run');
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, 'kept.log'), 'baseline log');
  const git = args => execFileSync('git', ['-C', project, '-c', 'user.name=RC Test', '-c', 'user.email=rc-test@localhost',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=nonexistent', ...args], { windowsHide: true });
  git(['init', '-q']); await fs.writeFile(path.join(project, '.git/info/exclude'), '*.log\n');
  git(['add', '--all', '--force', '.']); git(['commit', '-qm', 'Original input']);
  for (const file of ['src/new.txt', 'node_modules/pkg/index.js', 'entry/oh_modules/pkg/index.ets']) {
    await fs.mkdir(path.dirname(path.join(project, file)), { recursive: true }); await fs.writeFile(path.join(project, file), `content of ${file}`);
  }
  await archive({ id: 'patch-test', runDir, stateDir: path.join(runDir, 'state'), identity: { projectRoot: project, agentId: 'main', sessionId: 's', sessionKey: 'agent:main:s' },
    input: { paths: { git: 'git' } }, terminals: {} }, { status: 'ARCHIVED', host: {}, rc: { status: 'ENDED' } });
  const patch = await fs.readFile(path.join(runDir, 'artifacts/changes.patch'), 'utf8');
  assert.deepEqual([...patch.matchAll(/^diff --git a\/(\S+)/gm)].map(match => match[1]), ['src/new.txt']);
});
