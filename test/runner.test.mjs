import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chooseModels } from '../lib/config.mjs';
import { completion, privateState } from '../lib/settlement.mjs';
import { dispatchOnce, observe, captureTranscripts, experimentExitCode, resume } from '../lib/runner.mjs';
import { isolatedEnvironment, activateIsolatedEnvironment } from '../lib/host.mjs';
import { within, extractPackage, writeJson, json, redact } from '../lib/files.mjs';

const source = { agents: { defaults: { model: { primary: 'p/business' } }, list: [{ id: 'main', default: true }] },
  models: { providers: { p: { models: [{ id: 'business' }, { id: 'reviewer' }] } } },
  plugins: { entries: { 'runtime-corrector': { config: { reviewerModel: 'p/reviewer' } } } } };
const settled = () => ({ rc: { ended: true, active: false, pendingUserTasks: 0, status: 'ENDED', runId: 'r1', roundId: 'round1' },
  dispatch: [{ phase: 'IDLE', runId: 'r1', pending: [] }], private: { dispatch: [{ phase: 'IDLE', runId: 'r1', pending: [] }], reviews: [], nativeReviews: [], ledgers: [] } });
test('auto selects existing host models; unavailable explicit roles fail', () => {
  assert.deepEqual(chooseModels(source), { agentId: 'main', business: 'p/business', reviewer: 'p/reviewer' });
  assert.throws(() => chooseModels(source, { agent: 'missing' }), /No configured agent/);
  assert.throws(() => chooseModels(source, { reviewer: 'p/not-installed' }), /Unavailable/);
});
test('completion waits for native terminal even when public RC says ended', () => {
  assert.equal(completion(settled(), { r1: { status: 'ok' } }, 'r1').settled, true);
  assert.equal(completion(settled(), { r1: { status: 'timeout' } }, 'r1').settled, false);
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
  for (const mutate of mutations) { const s = settled(); mutate(s); assert.equal(completion(s, { r1: { status: 'ok' } }, 'r1').settled, false); }
});
test('an automatic followup needs its own terminal', () => {
  const s = settled(); s.rc.runId = 'r2'; s.dispatch[0].runId = 'r2'; s.private.dispatch[0].runId = 'r2';
  assert.equal(completion(s, { r1: { status: 'ok' } }, 'r1').settled, false);
  assert.equal(completion(s, { r1: { status: 'ok' }, r2: { status: 'error' } }, 'r1').settled, true);
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
  const record = { id: 'fault', input: { execution: { observerTimeoutMs: 0 } }, terminals: { r1: { status: 'error', error: 'DNS error' } } };
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
