import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { gatewayBatchDestination, installNativeGatewayBatch, gatewayBatchProviderUrl } from '../scripts/helpers/native-gateway-batch.mjs';
import { observeIntegratedSettlement } from '../scripts/helpers/native-integrated-original-case.mjs';
import { awaitHarborGatewaySettlement } from '../scripts/bench/harbor-gateway-controller.mjs';

test('a public custom provider route needs explicit exact HTTPS admission', () => {
  const provider = { baseUrl: 'https://example.test/v1', model: 'example-model' };
  const url = 'https://example.test/v1/chat/completions';
  assert.throws(() => gatewayBatchProviderUrl(provider), /Unsupported/);
  assert.equal(gatewayBatchProviderUrl(provider, url), url);
  assert.throws(() => gatewayBatchProviderUrl(provider, 'https://other.test/v1/chat/completions'), /Unsupported/);
  for (const baseUrl of ['http://example.test/v1', 'https://user:pass@example.test/v1', 'https://example.test/v1?q=1', 'https://example.test/v1#x'])
    assert.throws(() => gatewayBatchProviderUrl({ ...provider, baseUrl }, baseUrl+'/chat/completions'), /Invalid/);
});

async function boundaryFixture(t, { wire = 'wait', wallMs = 5000 } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-boundary-control-'));
  const hostRoot = path.join(root, 'host'), sourceRoot = path.join(root, 'source'), outputRoot = path.join(root, 'output'), projectRoot = path.join(root, 'project');
  for (const directory of [hostRoot, sourceRoot, outputRoot, projectRoot, path.join(sourceRoot, 'control'), path.join(hostRoot, 'node_modules/undici')]) await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(hostRoot, 'package.json'), '{}');
  await fs.writeFile(path.join(hostRoot, 'node_modules/undici/index.js'), 'module.exports = { fetch: globalThis.fetch };\n');
  await fs.writeFile(path.join(sourceRoot, 'contract.txt'), 'Frozen wrapper control.');
  await fs.writeFile(path.join(sourceRoot, 'control/prior.json'), JSON.stringify({ totalProviderRequests: 0, inFlightRequests: 0, cumulativeReferenceEstimateIncludingOldHeldUsd: 0 }));
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const manifest = { kind: 'native-gateway-original-loop-v1', credentialEnv: 'RC_NATIVE_GATEWAY_API_KEY', limits: { requests: 3, perCase: 3, wallMs, inputTokens: 16384, payloadBytes: 4096, outputTokens: 32768, usd: 4 },
    stageDeadline: new Date(Date.now() + 10000).toISOString(), priorSettlement: 'control/prior.json', priorProviderRequests: 0, priorConservativeCommittedUsd: 0, launchClaim: 'control/claim.json',
    sourceHashes: { 'contract.txt': hash(await fs.readFile(path.join(sourceRoot, 'contract.txt'))) }, hostHashes: { 'package.json': hash(await fs.readFile(path.join(hostRoot, 'package.json'))) } };
  const oldFetch = globalThis.fetch, oldConnect = net.Socket.prototype.connect, key = '__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__', oldRuntime = globalThis[key], oldCredential = process.env.RC_NATIVE_GATEWAY_API_KEY;
  const credential = 'mock-only-never-a-real-key'; let entered, wireCalls = 0, batch, release;
  const started = new Promise(resolve => { entered = resolve; });
  const known = () => new Response('data: {"choices":[{"delta":{"content":"mock"},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":1,"total_tokens":5}}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  globalThis.fetch = async (_input, init) => {
    wireCalls++; entered();
    if (wire === 'transport') throw new Error('Mock transport failure');
    if (wire === 'unknown') return new Response('data: [DONE]\n\n');
    if (wire === 'known') return known();
    if (wire === 'linger') return new Promise(resolve => { release = () => resolve(known()); });
    init.signal.throwIfAborted();
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  };
  process.env.RC_NATIVE_GATEWAY_API_KEY = credential;
  const cleanup = async () => {
    release?.();
    try { batch?.abort(new Error('UNIT_CLEANUP')); await batch?.close(); }
    finally {
      globalThis.fetch = oldFetch; net.Socket.prototype.connect = oldConnect;
      if (oldRuntime === undefined) delete globalThis[key]; else globalThis[key] = oldRuntime;
      if (oldCredential === undefined) delete process.env.RC_NATIVE_GATEWAY_API_KEY; else process.env.RC_NATIVE_GATEWAY_API_KEY = oldCredential;
      await fs.rm(root, { recursive: true, force: true });
    }
  };
  try { batch = await installNativeGatewayBatch({ hostRoot, sourceRoot, outputRoot, projectRoot, manifest }); }
  catch (error) { await cleanup(); throw error; }
  t.after(cleanup);
  const request = (signal, { authorization = `Bearer ${credential}`, model = 'glm-5.3' } = {}) => globalThis.fetch('https://open.bigmodel.cn/api/coding/paas/v4/chat/completions', { method: 'POST', signal, headers: { authorization },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Zero-model wrapper control.' }], stream: true, stream_options: { include_usage: true }, max_tokens: 32768 }) });
  return { batch, request, started, calls: () => wireCalls, release: () => release?.(), sourceRoot, projectRoot };
}

test('critical-path actual wrapper keeps negative observation after private cancellation while queued dispatch and unknown usage stay halted', async t => {
  const f = await boundaryFixture(t), { batch, request, projectRoot } = f, privateScope = new AbortController();
  const first = request(privateScope.signal), queued = request(); const completion = Promise.allSettled([first, queued]);
  await f.started; privateScope.abort(new Error('PRIVATE_REVIEW_DEADLINE')); const outcomes = await completion;
  assert(outcomes.every(outcome => outcome.status === 'rejected')); assert.equal(f.calls(), 1);
  const held = batch.metrics().budget; assert.equal(held.halted, 'BUDGET_USAGE_UNKNOWN'); assert.equal(held.inFlightRequests, 0);
  assert.equal(batch.signal.aborted, false, 'a private request must not cancel the case observer');
  await assert.rejects(request()); assert.equal(f.calls(), 1);
  const { elapsedMs: _elapsedBefore, ...heldStable } = held, { elapsedMs: _elapsedAfter, ...afterStable } = batch.metrics().budget;
  assert.deepEqual(afterStable, heldStable); assert.equal(held.committedInputTokens, 16384); assert.equal(held.committedOutputTokens, 32768);
  const identity = { id: 'dispatch', agentId: 'main', sessionId: 'business', sessionKey: 'agent:main:business', projectRoot, scopeFingerprint: 'frozen' };
  const terminal = { ...identity, version: 1, phase: 'IDLE', reviewStatus: 'UNVERIFIED', runId: 'original', completedRuns: ['original'], pending: [], dispatching: null };
  let now = 0;
  const observed = await observeIntegratedSettlement({ signal: batch.signal, now: () => now, pause: async ms => { now += ms; }, deadlineAt: 100,
    auditTerminals: () => awaitHarborGatewaySettlement({ ...identity, originalRunId: 'original', rcEnabled: true, now: () => now, deadlineAt: 100,
      request: async (method, args) => method === 'agent.wait' ? { runId: args.runId, status: 'ok' } : method.endsWith('.list') ? { items: [terminal] } : terminal,
      readPersistentDispatch: async () => terminal }), inspect: async () => ({ task: { status: 'ACTIVE' }, privateRuns: [{ status: 'SETTLED' }] }) });
  assert.equal(observed.authenticTerminals.dispatch.reviewStatus, 'UNVERIFIED'); assert.equal(observed.current.task.status, 'ACTIVE');
  assert.equal(observed.observationOutcome, 'AUTHENTICATED_NEGATIVE_TERMINAL'); assert.equal(now, 0);
  assert.equal(batch.metrics().budget.estimatedCommittedUsd, held.estimatedCommittedUsd);
});

for (const wire of ['transport', 'unknown']) test(`critical-path ${wire} provider error stops queued dispatch and retains the unknown full cap`, async t => {
  const f = await boundaryFixture(t, { wire });
  const results = await Promise.allSettled([f.request(), f.request()]);
  assert(results.every(result => result.status === 'rejected')); assert.equal(f.calls(), 1);
  assert.equal(f.batch.signal.aborted, false); const held = f.batch.metrics().budget;
  assert.equal(held.committedInputTokens, 16384); assert.equal(held.committedOutputTokens, 32768); assert.equal(held.inFlightRequests, 0);
  await assert.rejects(f.request()); assert.equal(f.calls(), 1);
});

for (const guard of ['auth', 'envelope', 'source', 'network', 'socket', 'owner', 'wall']) test(`critical-path authoritative ${guard} guard still cancels case and prevents provider dispatch`, async t => {
  const f = await boundaryFixture(t, { wire: 'known', wallMs: guard === 'wall' ? 1000 : 5000 });
  if (guard === 'auth' || guard === 'envelope') {
    const bad = guard === 'auth' ? { authorization: 'Bearer wrong-mock-key' } : { model: 'unapproved-model' };
    const result = await Promise.allSettled([f.request(undefined, bad), f.request()]); assert(result.every(item => item.status === 'rejected'));
  } else if (guard === 'source') {
    await fs.writeFile(path.join(f.sourceRoot, 'contract.txt'), 'Changed frozen source.');
    const result = await Promise.allSettled([f.request(), f.request()]); assert(result.every(item => item.status === 'rejected'));
  } else if (guard === 'network') await assert.rejects(globalThis.fetch('https://denied.invalid/'));
  else if (guard === 'socket') { const socket = new net.Socket(); assert.throws(() => socket.connect({ host: 'denied.invalid', port: 443 }), /EXTERNAL_SOCKET_DENIED/); socket.destroy(); }
  else if (guard === 'owner') f.batch.abort(new Error('Actual owner stop'));
  else await new Promise(resolve => setTimeout(resolve, 1050));
  assert.equal(f.batch.signal.aborted, true); await assert.rejects(f.request()); assert.equal(f.calls(), 0);
});

test('critical-path close cannot release the boundary while actual mocked provider work is still in flight', async t => {
  const f = await boundaryFixture(t, { wire: 'linger', wallMs: 1000 });
  const pending = f.request(); const rejection = assert.rejects(pending); await f.started; await rejection;
  assert.equal(f.batch.metrics().budget.inFlightRequests, 1);
  await assert.rejects(f.batch.close(), /in-flight provider consumption/);
  f.release(); const deadline = Date.now() + 2000;
  while (f.batch.metrics().budget.inFlightRequests && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.batch.metrics().budget.inFlightRequests, 0);
});

test('Gateway batches route only the approved provider POST and loopback calls', () => {
  assert.equal(gatewayBatchDestination('https://open.bigmodel.cn/api/coding/paas/v4/chat/completions', { method: 'POST' }), 'provider');
  assert.equal(gatewayBatchDestination('http://127.0.0.1:1234/health'), 'loopback');
  for (const url of ['https://open.bigmodel.cn/api/anthropic/v1/messages',
    'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions?copy=1', 'https://example.invalid/collect'])
    assert.throws(() => gatewayBatchDestination(url, { method: 'POST' }), /EXTERNAL_DESTINATION_DENIED/);
  assert.throws(() => gatewayBatchDestination('https://open.bigmodel.cn/api/coding/paas/v4/chat/completions'), /EXTERNAL_DESTINATION_DENIED/);
});

test('unrelated startup metadata is always blocked, never admitted as a provider call', () => {
  assert.equal(gatewayBatchDestination(new Request('https://registry.npmjs.org/openclaw')), 'blocked-startup-metadata');
  assert.throws(() => gatewayBatchDestination('https://registry.npmjs.org/openclaw', { method: 'POST' }), /EXTERNAL_DESTINATION_DENIED/);
});

test('owner cancellation reaches an admitted request and prevents any later wire dispatch', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-owner-cancel-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const hostRoot = path.join(root, 'host'), sourceRoot = path.join(root, 'source');
  const outputRoot = path.join(root, 'output'), projectRoot = path.join(root, 'project');
  for (const directory of [hostRoot, sourceRoot, outputRoot, projectRoot, path.join(sourceRoot, 'control'), path.join(hostRoot, 'node_modules/undici')])
    await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(hostRoot, 'package.json'), '{}');
  await fs.writeFile(path.join(hostRoot, 'node_modules/undici/index.js'), 'module.exports = { fetch: globalThis.fetch };\n');
  await fs.writeFile(path.join(sourceRoot, 'contract.txt'), 'Synthetic cancellation fixture only.\n');
  await fs.writeFile(path.join(sourceRoot, 'control/prior.json'), JSON.stringify({ totalProviderRequests: 7,
    inFlightRequests: 0, cumulativeReferenceEstimateIncludingOldHeldUsd: 0.12 }));
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  const manifest = { kind: 'native-gateway-original-loop-v1', credentialEnv: 'RC_NATIVE_GATEWAY_API_KEY',
    limits: { requests: 3, perCase: 3, wallMs: 5000, inputTokens: 16384, payloadBytes: 4096, outputTokens: 32768, usd: 4 },
    stageDeadline: new Date(Date.now() + 10000).toISOString(), priorSettlement: 'control/prior.json',
    priorProviderRequests: 7, priorConservativeCommittedUsd: 0.12, launchClaim: 'control/claim.json',
    sourceHashes: { 'contract.txt': digest(await fs.readFile(path.join(sourceRoot, 'contract.txt'))) },
    hostHashes: { 'package.json': digest(await fs.readFile(path.join(hostRoot, 'package.json'))) } };
  const previousFetch = globalThis.fetch, previousConnect = net.Socket.prototype.connect;
  const runtimeKey = '__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__', previousRuntime = globalThis[runtimeKey];
  const previousCredential = process.env.RC_NATIVE_GATEWAY_API_KEY;
  const credential = 'unit-fixture-not-a-real-authentication-key';
  process.env.RC_NATIVE_GATEWAY_API_KEY = credential;
  let started, calls = 0, sawAbort = false, batch;
  const entered = new Promise(resolve => { started = resolve; });
  const fakeFetch = async (_input, init) => {
    calls++; started();
    return new Promise(resolve => init.signal.addEventListener('abort', () => {
      sawAbort = true;
      // Simulate a known, fully returned response at cancellation. A missing
      // response would retain the existing unknown-usage reservation instead.
      resolve(new Response('data: {"choices":[{"delta":{"content":"fixture"},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":1,"total_tokens":5}}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    }, { once: true }));
  };
  globalThis.fetch = fakeFetch;
  try {
    batch = await installNativeGatewayBatch({ hostRoot, sourceRoot, outputRoot, projectRoot, manifest });
    const request = () => globalThis.fetch('https://open.bigmodel.cn/api/coding/paas/v4/chat/completions', {
      method: 'POST', headers: { authorization: `Bearer ${credential}` }, body: JSON.stringify({ model: 'glm-5.3',
        messages: [{ role: 'user', content: 'Synthetic fixture' }], stream: true,
        stream_options: { include_usage: true }, max_tokens: 32768 }) });
    const first = request(); await entered;
    batch.abort(new Error('UNIT_OWNER_STOP'));
    await first;
    assert.equal(sawAbort, true);
    await assert.rejects(request(), /UNIT_OWNER_STOP/);
    assert.equal(calls, 1);
    const metrics = batch.metrics();
    assert.equal(metrics.realProviderRequests, 1, 'Only the mock wire dispatch was admitted');
    assert.equal(metrics.cumulativeProviderRequests, 8);
    assert.equal(metrics.budget.inFlightRequests, 0);
    assert.equal(metrics.requests[0].usage.input, 4);
    assert.equal(metrics.requests[0].usage.output, 1);
    await batch.close(); batch = null;
    assert.equal(globalThis.fetch, fakeFetch);
  } finally {
    batch?.abort(new Error('UNIT_CLEANUP'));
    await batch?.close();
    globalThis.fetch = previousFetch; net.Socket.prototype.connect = previousConnect;
    if (previousRuntime === undefined) delete globalThis[runtimeKey]; else globalThis[runtimeKey] = previousRuntime;
    if (previousCredential === undefined) delete process.env.RC_NATIVE_GATEWAY_API_KEY;
    else process.env.RC_NATIVE_GATEWAY_API_KEY = previousCredential;
  }
});
