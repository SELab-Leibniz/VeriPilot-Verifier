import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { nativeGatewayCodingProvider, createNativeGatewayEvaluation, createNativeGatewayRequest, nativeGatewayResumeProvider,
  nativeGatewayDiagnosticsPolicy } from '../scripts/helpers/native-gateway-evaluation.mjs';
import { installSimplifyProfileBoundary } from '../scripts/helpers/simplify-native-evaluation.mjs';
import { relayNativeReviewActivity } from '../lib/openclaw/review-activity.mjs';

const provider = { api: 'openai-completions', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', model: 'glm-5.3' };

test('Gateway provider definitions cannot carry credentials or silently select another endpoint', () => {
  const selected = nativeGatewayCodingProvider(provider);
  assert.equal(selected.providerId, 'openai');
  assert.equal(Object.hasOwn(selected.definition, 'apiKey'), false);
  for (const changed of [{ ...provider, apiKey: 'offline-dummy-not-a-secret' },
    { ...provider, baseUrl: 'https://example.invalid/api' }, { ...provider, api: 'anthropic-messages' }])
    assert.throws(() => nativeGatewayCodingProvider(changed), /Unsupported explicit Gateway provider/);
  assert.throws(() => nativeGatewayCodingProvider(provider, 1000000), /pinned 128000-token context ceiling/);
});

test('a Coding Plan Gateway cannot start without an explicit offline or metered provider boundary', async () => {
  await assert.rejects(createNativeGatewayEvaluation({ provider }), /offline network guard or a metered batch/);
  await assert.rejects(createNativeGatewayEvaluation({ provider, providerGuard: { kind: 'unlimited' } }), /offline network guard or a metered batch/);
});

test('the RC-off Gateway rejects options that could reintroduce an RC role or tool', async () => {
  for (const options of [{ prebuiltPluginRoot: 'fixture' }, { reuseProfile: true }, { injectDefect: true },
    { businessToolNames: ['read', 'rc_document'] }, { extraPluginPaths: [{ id: 'runtime-corrector', path: 'fixture' }] },
    { disableRuntimeCorrection: true }, { reviewerProvider: provider }])
    await assert.rejects(createNativeGatewayEvaluation({ omitRuntimeCorrection: true, ...options }), /no Runtime Corrector components/);
});

test('finite phase timeout becomes the public provider silence policy without changing model or mutating input', () => {
  const legacy = nativeGatewayCodingProvider(provider);
  assert.equal(Object.hasOwn(legacy.definition, 'timeoutSeconds'), false);
  assert.deepEqual(nativeGatewayCodingProvider(provider, 128000, null), legacy);
  const original = structuredClone(provider);
  for (const phaseTimeoutMs of [1000, 45000, 240000, 3600000]) {
    const selected = nativeGatewayCodingProvider(provider, 128000, phaseTimeoutMs);
    assert.equal(selected.definition.timeoutSeconds, phaseTimeoutMs / 1000);
    const { timeoutSeconds, ...definition } = selected.definition;
    assert.deepEqual(definition, legacy.definition);
    assert.equal(selected.providerId, legacy.providerId);
    assert.equal(selected.model, legacy.model);
  }
  assert.deepEqual(provider, original);
});

test('invalid or unbounded phase values fail before any native host setup', async () => {
  for (const phaseTimeoutMs of [0, -1000, 999, 1001, 86401000, Infinity, NaN, '240000']) {
    assert.throws(() => nativeGatewayCodingProvider(provider, 128000, phaseTimeoutMs), /Invalid isolated phase timeout/);
    await assert.rejects(createNativeGatewayEvaluation({ provider, phaseTimeoutMs,
      providerGuard: { kind: 'offline_native_gateway_guard' } }), /Invalid isolated phase timeout/);
    await assert.rejects(createNativeGatewayEvaluation({ phaseTimeoutMs }), /Invalid isolated phase timeout/);
  }
});

test('explicit unlimited business policy retains diagnostics without a shorter host recovery deadline', () => {
  const original = { enabled: true, memoryPressureSnapshot: false };
  assert.deepEqual(nativeGatewayDiagnosticsPolicy(original), original);
  assert.deepEqual(nativeGatewayDiagnosticsPolicy(original, { phaseTimeoutMs: 45000 }),
    { ...original, stuckSessionWarnMs: 45000, stuckSessionAbortMs: 45000 });
  assert.deepEqual(nativeGatewayDiagnosticsPolicy(original, { unlimitedBusiness: true, noTimeoutMs: 2_147_483_647 }),
    { ...original, stuckSessionAbortMs: 2_147_483_647 });
  assert.deepEqual(nativeGatewayDiagnosticsPolicy({ ...original, stuckSessionAbortMs: 1000 },
    { phaseTimeoutMs: 45000, unlimitedBusiness: true, noTimeoutMs: 2_147_483_647 }),
  { ...original, stuckSessionWarnMs: 45000, stuckSessionAbortMs: 2_147_483_647 });
  assert.deepEqual(original, { enabled: true, memoryPressureSnapshot: false });
  for (const noTimeoutMs of [null, 0, -1, Infinity, 2_147_483_648])
    assert.throws(() => nativeGatewayDiagnosticsPolicy(original, { unlimitedBusiness: true, noTimeoutMs }), /pinned native no-timeout/);
});

test('pinned host watchdog can cancel a private review before its deadline; explicit unlimited policy preserves the finite role bound', {
  skip: !process.env.RC_OPENCLAW_HOST_ROOT,
}, async () => {
  const hostRoot = process.env.RC_OPENCLAW_HOST_ROOT;
  const pkg = JSON.parse(await fs.readFile(path.join(hostRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'openclaw'); assert.equal(pkg.version, '2026.7.1-2');
  const diagnosticFile = path.join(hostRoot, 'dist/diagnostic-DhwkYT4X.js');
  const source = await fs.readFile(diagnosticFile, 'utf8');
  assert(source.includes('resolveStuckSessionAbortMs as b'));
  assert(source.includes('resolveStuckSessionWarnMs as x'));
  const host = await import(pathToFileURL(diagnosticFile).href);
  const { n: resolveRunTimeout } = await import(pathToFileURL(path.join(hostRoot, 'dist/timeout-0Cw4kcol.js')).href);
  const threshold = diagnostics => host.b({ diagnostics }, host.x({ diagnostics }));
  assert.equal(threshold({ enabled: true }), 360_000);
  const noTimeoutMs = resolveRunTimeout({ overrideMs: 0 });
  assert.equal(noTimeoutMs, 2_147_000_000);
  const oldPolicy = { enabled: true, stuckSessionWarnMs: 1000, stuckSessionAbortMs: 1000 };
  const fixedPolicy = nativeGatewayDiagnosticsPolicy(oldPolicy, { unlimitedBusiness: true, noTimeoutMs });
  assert.equal(threshold(oldPolicy), 1000); assert.equal(threshold(fixedPolicy), noTimeoutMs);
  async function review(diagnostics, roleMs, workMs) {
    const controller = new AbortController(), progress = [];
    let activity;
    const parent = { runId: 'scripted-parent', sessionId: 'scripted-session', sessionKey: 'agent:main:scripted' };
    const sdk = {
      onRunActivity: listener => { activity = listener; return () => { activity = null; }; },
      onAgentEvent: () => () => {}, emitAgentEvent: () => {},
      reportProgress: (_parent, reason) => progress.push(reason),
    };
    const close = relayNativeReviewActivity({ sdk, parent, runId: 'scripted-private', role: 'artifact-reviewer',
      controller, deadlineAt: Date.now() + roleMs });
    const parentTimer = setTimeout(() => activity?.({ type: 'run.completed', runId: parent.runId }), threshold(diagnostics));
    parentTimer.unref();
    const roleTimer = setTimeout(() => controller.abort(new Error('SCRIPTED_PRIVATE_ROLE_DEADLINE')), roleMs);
    try { await delay(workMs, undefined, { signal: controller.signal }); return { status: 'COMPLETED', progress }; }
    catch { return { status: 'ABORTED', reason: controller.signal.reason?.message, progress }; }
    finally { clearTimeout(parentTimer); clearTimeout(roleTimer); close(); }
  }
  const cancelled = await review(oldPolicy, 3000, 1300);
  assert.equal(cancelled.status, 'ABORTED'); assert.match(cancelled.reason, /parent run ended during review/);
  const completed = await review(fixedPolicy, 3000, 1300);
  assert.equal(completed.status, 'COMPLETED');
  assert.deepEqual(completed.progress, ['runtime-corrector:review:started'], 'No heartbeat fabricates reviewer progress');
  const bounded = await review(fixedPolicy, 100, 500);
  assert.equal(bounded.status, 'ABORTED'); assert.equal(bounded.reason, 'SCRIPTED_PRIVATE_ROLE_DEADLINE');
});

test('isolated request forwards an explicit remaining timeout and preserves the legacy default and params', async () => {
  const config = {}, calls = [], imports = [], params = { runId: 'fictional-original', timeoutMs: 1000 };
  const request = createNativeGatewayRequest({ config, port: 12345,
    load: async file => { imports.push(file); return { callGateway: async value => { calls.push(value); return { runId: value.params.runId }; } }; } });
  const accepted = await request('agent.wait', params);
  await request('agent.wait', params, { timeoutMs: 2000 });
  await request('agent.wait', params, { timeoutMs: 45000 });
  assert.equal(accepted.runId, 'fictional-original');
  assert.deepEqual(calls.map(x => x.timeoutMs), [30000, 2000, 45000]);
  assert(calls.every(x => x.config === config && x.params === params && x.method === 'agent.wait'));
  assert(calls.every(x => x.url === 'ws://127.0.0.1:12345'));
  assert.deepEqual(imports, Array(3).fill('dist/call-BZWJ3eG1.js'));
  assert.deepEqual(params, { runId: 'fictional-original', timeoutMs: 1000 });
});

test('request timeout options do not change abort authority or forward unrelated options', async () => {
  const calls = [];
  const request = createNativeGatewayRequest({ config: {}, port: 12345,
    load: async () => ({ callGateway: async value => { calls.push(value); } }) });
  await request('chat.abort', { runId: 'fictional-original' }, { timeoutMs: 1000, scopes: ['fictional-untrusted-scope'] });
  await request('agent.wait', { runId: 'fictional-original' }, { scopes: ['operator.admin'] });
  await request('chat.send', { message: 'resume', systemInputProvenance: { kind: 'internal_system' }, suppressCommandInterpretation: true });
  await request('chat.send', { message: 'normal business input' });
  assert.deepEqual(calls[0].scopes, ['operator.admin']);
  assert.equal(calls[0].timeoutMs, 1000);
  assert.equal(Object.hasOwn(calls[1], 'scopes'), false);
  assert.equal(calls[1].timeoutMs, 30000);
  assert.deepEqual(calls[2].scopes, ['operator.admin']);
  assert.equal(Object.hasOwn(calls[3], 'scopes'), false);
});

test('native plan preview uses read authority while preparation, approval and arming use write authority', async () => {
  const calls = [];
  const request = createNativeGatewayRequest({ config: {}, port: 12345,
    load: async () => ({ callGateway: async value => { calls.push(value); } }) });
  for (const action of ['preview', 'prepare', 'approve', 'arm']) {
    await request(`runtime-corrector.openspec.${action}`, { runId: 'proposal' }, { timeoutMs: 800, scopes: ['operator.admin'] });
  }
  assert.deepEqual(calls.map(value => value.scopes), [['operator.read'], ['operator.write'], ['operator.write'], ['operator.write']]);
  assert(calls.every(value => value.timeoutMs === 800));
});

test('request failure propagates unchanged and does not retry or submit a new run', async () => {
  const failure = new Error('fictional wait failure'), calls = [];
  const request = createNativeGatewayRequest({ config: {}, port: 12345,
    load: async () => ({ callGateway: async value => { calls.push(value); throw failure; } }) });
  await assert.rejects(request('agent.wait', { runId: 'fictional-original' }, { timeoutMs: 2000 }), error => error === failure);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'agent.wait');
  assert.equal(calls[0].params.runId, 'fictional-original');
});

test('the pinned SDK resolves the standard OpenAI credential from process memory', { skip: !process.env.RC_OPENCLAW_HOST_ROOT }, async () => {
  const previous = process.env.OPENAI_API_KEY, dummy = 'offline-gateway-env-dummy-not-a-real-key';
  try {
    process.env.OPENAI_API_KEY = dummy;
    const hostRequire = createRequire(path.join(process.env.RC_OPENCLAW_HOST_ROOT, 'package.json'));
    const sdk = await import(pathToFileURL(path.join(path.dirname(hostRequire.resolve('@openclaw/ai')),
      'env-api-keys-CtMlqaQ4.mjs')).href);
    assert(sdk.n('openai') === dummy, 'The normal SDK auth path must resolve the isolated dummy environment value.');
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});

test('the pinned native transport rejects zero-budget and unrelated requests before dispatch', {
  skip: !process.env.RC_OPENCLAW_HOST_ROOT,
}, async () => {
  const hostRoot = process.env.RC_OPENCLAW_HOST_ROOT;
  const { buildGuardedModelFetch } = await import(pathToFileURL(path.join(hostRoot, 'dist/plugin-sdk/provider-transport-runtime.js')).href);
  const credential = () => 'offline-test-placeholder';
  const profile = { baseUrl: 'https://benchmark.invalid/v1', model: 'deepseek-v4-flash' };
  const originalFetch = globalThis.fetch;
  const send = baseUrl => buildGuardedModelFetch({ provider: 'custom', api: 'openai-completions', id: profile.model, baseUrl })(
    `${baseUrl}/chat/completions`, { method: 'POST', headers: baseUrl === profile.baseUrl ? { authorization: `Bearer ${credential()}` } : {},
      body: JSON.stringify({ model: profile.model }), signal: AbortSignal.timeout(5000) });
  const boundary = installSimplifyProfileBoundary({ hostRoot, provider: profile, credential, maxRequests: 0 });
  try {
    await assert.rejects(send('https://unrelated.invalid/v1'), { message: 'PROFILE_REQUEST_BOUNDARY' });
    assert.deepEqual(boundary.snapshot(), { requests: 0, failure: null });
    await assert.rejects(send(profile.baseUrl), { message: 'PROFILE_REQUEST_LIMIT' });
    assert.deepEqual(boundary.snapshot(), { requests: 0, failure: 'PROFILE_REQUEST_LIMIT' });
  } finally { boundary.close(); }
  assert.equal(globalThis.fetch, originalFetch);
});


test('restored profiles update finite budgets and owned relay ports while retaining provider identity', () => {
  const old = nativeGatewayCodingProvider(provider, 128000, 600000).definition;
  const next = nativeGatewayCodingProvider(provider, 128000, 86400000).definition;
  const before = structuredClone(old);
  assert.equal(nativeGatewayResumeProvider(old, next).timeoutSeconds, 86400);
  assert.deepEqual(old, before, 'The captured profile is never mutated');
  const oldRelay = { ...old, baseUrl: 'http://host.docker.internal:30123/v1' };
  const newRelay = { ...next, baseUrl: 'http://host.docker.internal:30124/v1' };
  assert.throws(() => nativeGatewayResumeProvider(oldRelay, newRelay), /captured profile/);
  assert.equal(nativeGatewayResumeProvider(oldRelay, newRelay, { allowLocalRelayRebind: true }).baseUrl, newRelay.baseUrl);
  for (const changed of [
    { ...next, api: 'anthropic-messages' },
    { ...next, models: [{ ...next.models[0], id: 'other-model' }] },
    { ...next, models: [{ ...next.models[0], contextWindow: 64000 }] },
    { ...next, models: [{ ...next.models[0], reasoning: false }] },
    { ...next, baseUrl: 'https://example.invalid/v1' },
    { ...next, timeoutSeconds: Infinity },
    { ...next, timeoutSeconds: 86401 },
  ]) assert.throws(() => nativeGatewayResumeProvider(old, changed, { allowLocalRelayRebind: true }), /captured profile/);
  assert.throws(() => nativeGatewayResumeProvider(old, newRelay, { allowLocalRelayRebind: true }), /captured profile/);
});
