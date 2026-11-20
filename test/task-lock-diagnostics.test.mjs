import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOpenClawRuntime } from '../lib/openclaw/runtime.mjs';
import { withTaskResourceLock, ensureTask, findTask, withTaskState } from '../lib/runtime-v2/task-store.mjs';
import { correctionFixtureRuntime } from './support/openclaw-project-scope.mjs';

const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
const code = 'TASK_STATE_LOCK_TIMEOUT';
const fakeSecret = 'LOCAL_FAKE_LOCK_SENTINEL_0123456789';

async function competingClaim(t, root, { timeoutMs = 80, advance } = {}) {
  const taskId = 'diagnostic-task', resource = 'live-resource';
  const directory = path.join(root, '.runtime-correction/locks', `${taskId}-${resource}.lock.claims`);
  await fs.mkdir(directory, { recursive: true });
  const earlier = path.join(directory, 'earlier.json');
  await fs.writeFile(earlier, JSON.stringify({ token: 'earlier', pid: process.pid, createdAtMs: Date.now() - 1000 }));
  if (advance) {
    const original = fs.readFile;
    t.mock.method(fs, 'readFile', async (file, ...args) => {
      const bytes = await original(file, ...args);
      if (String(file) === earlier) advance();
      return bytes;
    });
  }
  let entered = false, error;
  try {
    await withTaskResourceLock({ projectRoot: root, taskId, resource, timeoutMs, staleMs: 60000,
      reclaimDeadOwner: true }, async () => { entered = true; });
  } catch (caught) { error = caught; }
  assert(error instanceof Error);
  assert.equal(error.code, code);
  assert.match(error.message, /Timed out waiting for Runtime Corrector state lock:/);
  assert.equal(entered, false);
  assert.deepEqual(await fs.readdir(directory), ['earlier.json'], 'only the rejected waiter claim is removed');
  return error;
}

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `rc-${fakeSecret}-`)));
  let runtime;
  t.after(async () => { await runtime?.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  await fs.mkdir(path.join(root, '.runtime-corrector'));
  await fs.writeFile(path.join(root, '.runtime-corrector/config.yaml'), `version: 2
artifacts: []
dynamicGroundTruth:
  enabled: false
stopCorrection:
  enabled: false
`);
  const sid = 'lock-diagnostic-session', transcript = path.join(root, 'native.jsonl');
  await fs.writeFile(transcript, [
    { type: 'session', id: sid },
    { type: 'message', id: 'original-user', parentId: null, message: { role: 'user', content: 'Observe the current result.' } },
  ].map(JSON.stringify).join('\n') + '\n');
  const warnings = [], sharedState = {}, hostAbort = new AbortController();
  let modelCalls = 0, admissionCalls = 0;
  const sessions = { getSessionEntry: async () => ({ sessionId: sid, sessionFile: transcript }),
    resolveStorePath: () => path.join(root, 'sessions.json'), resolveSessionFilePath: () => transcript,
    runWithWorkAdmission: async (params, run) => run(params.signal) };
  const api = { id: 'runtime-corrector', config: { agents: { defaults: { model: { primary: 'fixture/unused' } } } },
    pluginConfig: {}, logger: { warn: message => warnings.push(message) },
    runtime: { version: '2026.7.1-2', state: { resolveStateDir: () => path.join(root, 'host-state') },
      agent: { session: sessions, runEmbeddedAgent: async () => { modelCalls++; assert.fail('no model dispatch is permitted'); } } } };
  runtime = correctionFixtureRuntime(createOpenClawRuntime)(api, { pluginRoot, sharedState, nativeHooks: true });
  const ctx = { workspaceDir: root, sessionId: sid, sessionKey: 'agent:main:lock-diagnostic', agentId: 'main',
    runId: 'owned-run', trigger: 'user', abortSignal: hostAbort.signal };
  await runtime.prompt({ prompt: 'Observe the current result.' }, ctx);
  await runtime.waitForBackgroundReviews();
  const task = await ensureTask({ projectRoot: root, sessionId: sid });
  await withTaskState({ projectRoot: root, taskId: task.taskId }, state => {
    state.stop.correctionAttempts = 1;
    state.verification = { status: 'DEVIATION', reasonCode: 'PREEXISTING_TEST_MARKER' };
  });
  const before = await findTask({ projectRoot: root, sessionId: sid });
  return { root, runtime, ctx, warnings, hostAbort, before,
    state: sharedState.states.get(`main:${sid}`),
    modelCalls: () => modelCalls, admissionCalls: () => admissionCalls,
    failAdmission(error) { sessions.runWithWorkAdmission = async () => { admissionCalls++; throw error; }; },
    async unchangedBusinessState() {
      const after = await findTask({ projectRoot: root, sessionId: sid });
      assert.deepEqual(after.verification, before.verification, 'a diagnostic cannot clear a prior recorded verdict');
      assert.deepEqual(after.deviations, before.deviations);
      assert.equal(after.stop.correctionAttempts, before.stop.correctionAttempts, 'no correction quota is spent or renewed');
      assert.equal(modelCalls, 0);
      assert.equal(hostAbort.signal.aborted, false, 'RC errors never cancel host execution');
    } };
}

const originalResult = () => ({ isError: true, content: [
  { type: 'text', text: 'Actual original host output.' }, { type: 'image', data: 'fixture', mimeType: 'image/png' },
], details: { status: 'failed', exitCode: 7, nested: { retained: true } }, mediaUrl: 'fixture://retained-media', terminate: false });

function retained(result, original) {
  assert(result?.result);
  assert.deepEqual({ ...result.result, content: original.content }, original);
  assert.deepEqual(result.result.content.slice(0, original.content.length), original.content);
  assert.equal(result.result.content.length, original.content.length + 1);
  return result.result.content.at(-1).text;
}

test('real live-claim timeout is typed and removes only its own waiter', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-lock-producer-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const error = await competingClaim(t, root);
  assert(error.message.includes(root), 'the existing detailed producer message stays available to redacted logging');
});

test('the original acquisition deadline is not renewed after a poll', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-lock-deadline-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let now = 1000, reads = 0;
  t.mock.method(Date, 'now', () => now);
  await competingClaim(t, root, { timeoutMs: 80, advance: () => { reads++; now += 40; } });
  assert.equal(reads, 2);
  assert.equal(now, 1080);
});

test('a real filesystem failure retains its original code', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-lock-filesystem-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.runtime-correction'));
  await fs.writeFile(path.join(root, '.runtime-correction/locks'), 'not a directory');
  await assert.rejects(withTaskResourceLock({ projectRoot: root, taskId: 'fs-error', resource: 'owned' }, () => {}), error => {
    assert.notEqual(error.code, code);
    assert(['EEXIST', 'ENOTDIR'].includes(error.code));
    return true;
  });
});

test('actual typed producer error preserves native host output and redacts only the detailed log', async t => {
  const prior = process.env.RC_DIAGNOSTIC_FAKE_SECRET;
  process.env.RC_DIAGNOSTIC_FAKE_SECRET = fakeSecret;
  t.after(() => { if (prior === undefined) delete process.env.RC_DIAGNOSTIC_FAKE_SECRET; else process.env.RC_DIAGNOSTIC_FAKE_SECRET = prior; });
  const f = await fixture(t), beforeTypedWarningCount = f.warnings.length;
  const error = await competingClaim(t, f.root);
  assert(error.message.includes(fakeSecret));
  f.failAdmission(error);
  const original = originalResult(), snapshot = structuredClone(original);
  const result = await f.runtime.toolResult({ toolName: 'read', toolCallId: 'typed-result', args: { path: 'result.txt' }, result: original }, f.ctx);
  const notice = retained(result, snapshot);
  assert.equal(f.admissionCalls(), 1);
  assert.deepEqual(original, snapshot);
  assert(notice.includes(`RC_REVIEW_UNVERIFIED: ${code}`));
  assert(notice.includes('while observing a host tool result'));
  assert(notice.includes('The original host tool result is retained.'));
  assert(notice.endsWith('This check did not finish.'));
  assert(!notice.includes(fakeSecret) && !notice.includes(f.root));
  assert(!notice.includes('The review remains') && !notice.includes('correction authority'));
  assert(Buffer.byteLength(notice) < 1024);
  const typedWarnings = f.warnings.slice(beforeTypedWarningCount);
  t.diagnostic('DIAGNOSTIC_LOG_OBSERVATION ' + JSON.stringify({ beforeTypedWarningCount, warnings: f.warnings.map((message, index) => ({ index, stage: index < beforeTypedWarningCount ? 'fixture-initialization' : 'typed-failure', bytes: Buffer.byteLength(message), sha256: createHash('sha256').update(message).digest('hex'), containsFake: message.includes(fakeSecret), containsRoot: message.includes(f.root), containsRedaction: message.includes('<redacted>'), containsTimeoutText: message.includes('Timed out waiting for Runtime Corrector state lock:') })) }));
  assert(typedWarnings.length > 0, 'the actual typed-failure logger must be observed');
  assert(typedWarnings.some(message => message.includes('Timed out waiting for Runtime Corrector state lock:') && message.includes('<redacted>')));
  assert(typedWarnings.every(message => !message.includes(fakeSecret)));
  const priorWarnings = f.warnings.slice(0, beforeTypedWarningCount);
  assert(priorWarnings.includes(`[runtime-corrector] ${path.join(f.root, '.runtime-corrector/config.yaml')} must declare an artifact or enable a version 2 correction feature.`), 'classify the distinct pre-existing config-validation path; this is not the typed failure logger');
  assert(priorWarnings.every(message => !message.includes('Timed out waiting for Runtime Corrector state lock:')));
  assert(typedWarnings.every(message => !message.includes(f.root)), 'every new typed-failure warning must redact the ambient fake secret in the detailed path');
  await f.unchangedBusinessState();
});

for (const other of ['uncoded-same-message', 'ENOENT', 'EPERM']) test(`${other} keeps the existing native fallback`, async t => {
  const f = await fixture(t), actual = await competingClaim(t, f.root);
  const error = new Error(actual.message);
  if (other !== 'uncoded-same-message') error.code = other;
  f.failAdmission(error);
  const original = originalResult(), result = await f.runtime.toolResult({ toolName: 'read', toolCallId: other,
    args: { path: 'result.txt' }, result: original }, f.ctx);
  const notice = retained(result, original);
  assert.equal(notice, `[runtime-corrector:feedback] RC_REVIEW_UNVERIFIED: ${other === 'uncoded-same-message' ? 'Error' : other}`);
  await f.unchangedBusinessState();
});

test('pre-tool diagnostics do not claim that a tool result already exists or veto the call', async t => {
  const f = await fixture(t), error = await competingClaim(t, f.root);
  f.failAdmission(error);
  assert.equal(await f.runtime.beforeTool({ toolName: 'write', toolCallId: 'pre-tool', params: { path: 'draft.md' } }, f.ctx), undefined);
  const notice = f.state.seen.get('feedback:pre-tool');
  assert(notice.includes('during the pre-tool check'));
  assert(!notice.includes('host tool result is retained'));
  assert(notice.endsWith('This check did not finish.'));
  await f.unchangedBusinessState();
});

test('a cancelled host call starts no lock attempt or diagnostic', async t => {
  const f = await fixture(t), error = await competingClaim(t, f.root);
  f.failAdmission(error); f.hostAbort.abort(new Error('owned cancellation'));
  const original = originalResult(), snapshot = structuredClone(original), beforeWarnings = f.warnings.length;
  assert.equal(await f.runtime.toolResult({ toolName: 'read', toolCallId: 'cancelled', args: {}, result: original }, f.ctx), undefined);
  assert.equal(f.admissionCalls(), 0); assert.equal(f.warnings.length, beforeWarnings);
  assert.deepEqual(original, snapshot); assert.equal(f.modelCalls(), 0);
});

for (const [name, interaction] of [
  ['approval', { details: { status: 'approval-pending', approvalId: 'owned-approval' } }],
  ['question', { interactive: true, channelData: { question: 'Continue?' } }],
]) test(`${name} identity and native structure remain unchanged`, async t => {
  const f = await fixture(t), error = await competingClaim(t, f.root);
  f.failAdmission(error);
  const original = { ...originalResult(), ...interaction }, snapshot = structuredClone(original);
  assert.equal(await f.runtime.toolResult({ toolName: 'exec', toolCallId: name, args: {}, result: original }, f.ctx), undefined);
  assert.deepEqual(original, snapshot);
  assert.equal(f.admissionCalls(), 1);
  await f.unchangedBusinessState();
});
