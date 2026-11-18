import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { simplifySchedule } from '../scripts/simplify-experiment-schedule.mjs';
import { nativeGatewayHostProfileProvider } from '../scripts/helpers/native-gateway-evaluation.mjs';
import { countProfileCredentialMatches, deepseekCodingModel, deepseekModel, deepseekReviewerModel, installSimplifyProfileBoundary,
  resolveSimplifyProvider, supportsSimplifyModel } from '../scripts/helpers/simplify-native-evaluation.mjs';

test('the DeepSeek route is explicit and the first eight scheduled slots retain their order', () => {
  assert.equal(supportsSimplifyModel('host-profile', 'deepseek-flash', 'fixture.json'), true);
  assert.equal(supportsSimplifyModel('host-profile', 'deepseek-flash'), false);
  assert.equal(supportsSimplifyModel('host-profile', 'deepseek-v4-flash', 'fixture.json'), true);
  assert.equal(supportsSimplifyModel('host-profile', 'deepseek-v4-flash'), false);
  assert.equal(supportsSimplifyModel('coding-plan', 'deepseek-flash'), false);
  assert.equal(supportsSimplifyModel('coding-plan', 'deepseek-v4-flash'), false);
  assert.equal(supportsSimplifyModel('coding-plan', 'glm-5.3-flash'), true);
  assert.equal(supportsSimplifyModel('anthropic-environment', 'glm-5.3-flash'), true);
  assert.deepEqual(simplifySchedule('1').slice(0, 8).map(({ sample, arm, repeat }) => [sample, arm, repeat]),
    ['internal-correct', 'six-functions'].flatMap(sample => ['A', 'B1', 'B2', 'B12'].map(arm => [sample, arm, 1])));
});

test('the business and reviewer models use their exact registered IDs and one isolated profile credential', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-simplify-profile-models-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'openclaw.json');
  const agentDirectory = path.join(root, 'agents', 'main', 'agent');
  await fs.mkdir(agentDirectory, { recursive: true });
  const dummy = 'fixture-profile-only-not-a-real-api-key';
  const database = new DatabaseSync(path.join(agentDirectory, 'openclaw-agent.sqlite'));
  try {
    database.exec('CREATE TABLE auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT NOT NULL)');
    database.prepare('INSERT INTO auth_profile_store VALUES (?, ?)').run('primary', JSON.stringify({
      profiles: { 'custom:default': { provider: 'custom', type: 'api_key', key: dummy } },
    }));
  } finally { database.close(); }
  const baseUrl = 'https://benchmark.invalid/v1';
  const models = [deepseekModel, deepseekCodingModel, deepseekReviewerModel];
  const writeConfig = definitions => fs.writeFile(configPath, JSON.stringify({
    agents: { defaults: { model: { primary: `custom/${deepseekModel}` } } },
    models: { providers: { custom: { api: 'openai-completions', baseUrl, models: definitions } } },
  }));
  await writeConfig(models.map(id => ({ id, name: `${id} fixture label`, contextWindow: 32768 })));
  const resolved = await resolveSimplifyProvider('host-profile', 'deepseek-flash', configPath, 'deepseek-v4-pro');
  assert.equal(resolved.identity.modelRef, 'custom/deepseek-flash');
  assert.equal(resolved.identity.reviewerModelRef, 'custom/deepseek-v4-pro');
  assert(resolved.credential() === dummy);
  assert.equal(resolved.provider.baseUrl, baseUrl);
  assert.equal(resolved.reviewerProvider.baseUrl, baseUrl);
  const modelRoutes = [resolved.provider, resolved.reviewerProvider].map(provider =>
    nativeGatewayHostProfileProvider(provider, null, 'fixture-placeholder'));
  assert.deepEqual(modelRoutes.map(route => `${route.providerId}/${route.model}`),
    ['custom/deepseek-flash', 'custom/deepseek-v4-pro']);
  assert.deepEqual(modelRoutes.map(route => route.definition.models[0].id), ['deepseek-flash', 'deepseek-v4-pro']);
  assert(!JSON.stringify(modelRoutes).includes(dummy));

  await writeConfig([{ id: deepseekModel }]);
  const historical = await resolveSimplifyProvider('host-profile', deepseekModel, configPath);
  assert.equal(historical.identity.modelRef, 'custom/deepseek-v4-flash');
  assert.equal(historical.reviewerProvider, undefined);
  await assert.rejects(resolveSimplifyProvider('host-profile', deepseekCodingModel, configPath, deepseekReviewerModel), /unavailable or invalid/u);
  await assert.rejects(resolveSimplifyProvider('host-profile', deepseekModel, configPath, deepseekReviewerModel), /unavailable or invalid/u);
  await writeConfig([{ id: deepseekCodingModel }, { id: deepseekReviewerModel, description: dummy }]);
  await assert.rejects(resolveSimplifyProvider('host-profile', deepseekCodingModel, configPath, deepseekReviewerModel), /unavailable or invalid/u);
});

test('profile wire admission limits dispatches and stops SDK retries after a 429', async t => {
  const hostRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-simplify-wire-'));
  t.after(() => fs.rm(hostRoot, { recursive: true, force: true }));
  const undici = path.join(hostRoot, 'node_modules/undici');
  await fs.mkdir(undici, { recursive: true });
  await fs.writeFile(path.join(undici, 'index.js'), 'exports.fetch = globalThis.fetch;');
  const credential = () => 'test-only-credential-never-dispatched';
  const provider = { baseUrl: 'https://example.invalid/v1', model: 'deepseek-v4-flash' };
  const send = () => fetch(`${provider.baseUrl}/chat/completions`, { method: 'POST',
    headers: { authorization: `Bearer ${credential()}` }, body: JSON.stringify({ model: provider.model }) });
  const previous = globalThis.fetch;
  let status = 200, dispatches = 0;
  globalThis.fetch = async () => { dispatches++; return new Response(null, { status }); };
  try {
    const bounded = installSimplifyProfileBoundary({ hostRoot, provider, credential, maxRequests: 2 });
    try {
      await send(); await send();
      await assert.rejects(send, /PROFILE_REQUEST_LIMIT/u);
      assert.equal(dispatches, 2);
    } finally { bounded.close(); }
    status = 429;
    const limited = installSimplifyProfileBoundary({ hostRoot, provider, credential });
    try {
      await assert.rejects(send, /PROFILE_RATE_LIMIT/u);
      await assert.rejects(send, /PROFILE_RATE_LIMIT/u);
      assert.deepEqual(limited.snapshot(), { requests: 1, failure: 'PROFILE_RATE_LIMIT' });
      assert.equal(dispatches, 3);
    } finally { limited.close(); }
    status = 200;
    const dual = installSimplifyProfileBoundary({ hostRoot, provider: { ...provider, model: deepseekCodingModel }, credential, reviewerModel: deepseekReviewerModel });
    try {
      const sendModel = model => fetch(`${provider.baseUrl}/chat/completions`, { method: 'POST',
        headers: { authorization: `Bearer ${credential()}` }, body: JSON.stringify({ model }) });
      await sendModel('deepseek-flash'); await sendModel('deepseek-v4-pro');
      assert.equal(dual.snapshot().requests, 2);
      await assert.rejects(() => sendModel('deepseek-v4-flash'), /PROFILE_MODEL_BOUNDARY/u);
      await assert.rejects(() => sendModel(undefined), /PROFILE_MODEL_BOUNDARY/u);
    } finally { dual.close(); }
    await fs.writeFile(path.join(hostRoot, 'test-encoded'), Buffer.from(credential(), 'utf16le'));
    assert.equal(await countProfileCredentialMatches(hostRoot, credential), 1);
  } finally { globalThis.fetch = previous; }
});

async function profileFetchFixture(t, fetch, options = {}) {
  const hostRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-simplify-retry-'));
  const undici = path.join(hostRoot, 'node_modules/undici');
  await fs.mkdir(undici, { recursive: true });
  await fs.writeFile(path.join(undici, 'index.js'), 'exports.fetch = globalThis.fetch;');
  const provider = { baseUrl: 'https://example.invalid/v1', model: 'deepseek-v4-flash' };
  const credential = () => 'test-only-profile-token';
  const url = `${provider.baseUrl}/chat/completions`;
  const post = { method: 'POST', headers: { authorization: `Bearer ${credential()}` },
    body: JSON.stringify({ model: provider.model, messages: [{ role: 'user', content: 'Fixture' }] }) };
  const previous = globalThis.fetch;
  let boundary;
  t.after(async () => {
    boundary?.close();
    globalThis.fetch = previous;
    await fs.rm(hostRoot, { recursive: true, force: true });
  });
  globalThis.fetch = fetch;
  boundary = installSimplifyProfileBoundary({ hostRoot, provider, credential, ...options });
  return { boundary, url, post, send: extra => globalThis.fetch(url, { ...post, ...extra }) };
}

const beforeResponseReset = (code = 'ECONNRESET') => new TypeError('fetch failed', {
  cause: Object.assign(new Error('socket reset'), { code }),
});

test('opt-in pre-response reset replay reuses the admitted POST and shares one retry across fetch paths', async t => {
  const wire = [];
  const { boundary, post, send, url } = await profileFetchFixture(t, async (input, init) => {
    wire.push({ input, method: init.method, body: init.body, auth: new Headers(init.headers).get('authorization'),
      redirect: init.redirect });
    if (wire.length !== 2) throw beforeResponseReset();
    return new Response('ok');
  }, { preResponseRetryDeadlineAt: Date.now() + 60_000 });

  assert.equal(await (await send()).text(), 'ok');
  assert.deepEqual(wire, Array(2).fill({ input: url, method: 'POST', body: post.body,
    auth: post.headers.authorization, redirect: 'error' }));
  assert.equal(boundary.snapshot().requests, 2);
  assert.equal(boundary.snapshot().preResponseRetries, 1);
  assert.equal(boundary.snapshot().failure, null);

  const sdk = globalThis.__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__;
  await assert.rejects(() => sdk.fetch(url, post), /PROFILE_TRANSPORT_FAILURE/u);
  assert.equal(wire.length, 3);
  assert.equal(boundary.snapshot().requests, 3);
  assert.equal(boundary.snapshot().preResponseRetries, 1);
});

test('an Undici socket rejection before headers gets one counted retry across both fetch paths', async t => {
  for (const shape of ['cause', 'top-level']) await t.test(shape, async t => {
    const failure = shape === 'cause' ? beforeResponseReset('UND_ERR_SOCKET')
      : Object.assign(new TypeError('fetch failed'), { code: 'UND_ERR_SOCKET' });
    const wire = [];
    const { boundary, send, post, url } = await profileFetchFixture(t, async (input, init) => {
      wire.push({ input, method: init.method, body: init.body, authorization: new Headers(init.headers).get('authorization') });
      if (wire.length !== 2) throw failure;
      return new Response('complete response');
    }, { preResponseRetryDeadlineAt: Date.now() + 60_000 });
    assert.equal(await (await send()).text(), 'complete response');
    assert.deepEqual(wire, Array(2).fill({ input: url, method: 'POST', body: post.body, authorization: post.headers.authorization }));
    assert.deepEqual(boundary.snapshot(), { requests: 2, failure: null, preResponseRetries: 1 });
    await assert.rejects(() => globalThis.__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__.fetch(url, post), /PROFILE_TRANSPORT_FAILURE/u);
    assert.equal(wire.length, 3);
    assert.deepEqual(boundary.snapshot(), { requests: 3, failure: 'PROFILE_TRANSPORT_FAILURE', preResponseRetries: 1 });
  });
});

test('pre-response resets do not replay without opt-in, after the deadline, or over the wire limit', async t => {
  const cases = [
    ['default', {}],
    ['expired', { preResponseRetryDeadlineAt: Date.now() - 1000 }],
    ['request limit', { preResponseRetryDeadlineAt: Date.now() + 60_000, maxRequests: 1 }],
  ];
  for (const [name, options] of cases) await t.test(name, async t => {
    let dispatches = 0;
    const { boundary, send } = await profileFetchFixture(t, async () => {
      dispatches++;
      throw beforeResponseReset();
    }, options);
    await assert.rejects(send, /PROFILE_(?:TRANSPORT_FAILURE|REQUEST_LIMIT)/u);
    assert.equal(dispatches, 1);
    assert.equal(boundary.snapshot().requests, 1);
    assert.equal(boundary.snapshot().preResponseRetries ?? 0, 0);
  });
});

test('an aborted request or a streamed POST body never replays after ECONNRESET', async t => {
  for (const when of ['before fetch', 'during fetch', 'streamed body']) await t.test(when, async t => {
    const controller = new AbortController();
    let dispatches = 0;
    const { boundary, send, url, post } = await profileFetchFixture(t, async () => {
      dispatches++;
      if (when === 'during fetch') controller.abort();
      throw beforeResponseReset();
    }, { preResponseRetryDeadlineAt: Date.now() + 60_000 });
    if (when === 'before fetch') controller.abort();
    if (when === 'streamed body') {
      const body = new ReadableStream({ start(stream) {
        stream.enqueue(new TextEncoder().encode(post.body));
        stream.close();
      } });
      const request = new Request(url, { ...post, body, duplex: 'half' });
      await assert.rejects(() => globalThis.fetch(request), /PROFILE_TRANSPORT_FAILURE/u);
    } else {
      await assert.rejects(() => send({ signal: controller.signal }));
    }
    assert.equal(boundary.snapshot().requests, dispatches);
    if (when === 'before fetch') assert(dispatches <= 1);
    else assert.equal(dispatches, 1);
    assert.equal(boundary.snapshot().preResponseRetries, 0);
  });
});

test('a replay that also resets terminates the boundary after two wire dispatches', async t => {
  let dispatches = 0;
  const { boundary, send } = await profileFetchFixture(t, async () => {
    dispatches++;
    throw beforeResponseReset();
  }, { preResponseRetryDeadlineAt: Date.now() + 60_000 });
  await assert.rejects(send, /PROFILE_TRANSPORT_FAILURE/u);
  await assert.rejects(send, /PROFILE_TRANSPORT_FAILURE/u);
  assert.equal(dispatches, 2);
  assert.equal(boundary.snapshot().requests, 2);
  assert.equal(boundary.snapshot().preResponseRetries, 1);
});

test('HTTP failure and response-body reset never replay a POST', async t => {
  for (const failure of ['HTTP', 'auth', 'stream', 'Undici stream']) await t.test(failure, async t => {
    let dispatches = 0;
    const { boundary, send } = await profileFetchFixture(t, async () => {
      dispatches++;
      if (failure === 'HTTP' || failure === 'auth') return new Response(null, { status: failure === 'auth' ? 401 : 503 });
      return new Response(new ReadableStream({ start(stream) {
        stream.error(beforeResponseReset(failure === 'Undici stream' ? 'UND_ERR_SOCKET' : 'ECONNRESET'));
      } }));
    }, { preResponseRetryDeadlineAt: Date.now() + 60_000 });
    if (failure === 'HTTP' || failure === 'auth') await assert.rejects(send, { message: failure === 'auth' ? 'PROFILE_HTTP_401' : 'PROFILE_HTTP_503' });
    else await assert.rejects((await send()).text(), /fetch failed/u);
    assert.equal(dispatches, 1);
    assert.equal(boundary.snapshot().requests, 1);
    assert.equal(boundary.snapshot().preResponseRetries, 0);
  });
});
