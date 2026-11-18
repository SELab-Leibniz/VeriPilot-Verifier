import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeModelDiagnosticRoutes, nativeModelCallDiagnostic, nativeBusinessTransportFailure }
  from '../scripts/helpers/native-gateway-evaluation.mjs';
import { providerTraceparentSha256 } from '../scripts/helpers/provider-fetch-timing.mjs';

const trace = { traceId: '1234567890abcdef1234567890abcdef', spanId: '1234567890abcdef', traceFlags: '01' };
const traceHash = providerTraceparentSha256('00-' + trace.traceId + '-' + trace.spanId + '-01');
const config = { models: { providers: { custom: { apiKey: 'PRIVATE_CONFIG_KEY', baseUrl: 'https://private.invalid',
  models: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] } } } };
const routes = () => nativeModelDiagnosticRoutes(config);
const event = (change = {}) => ({ type: 'model.call.started', runId: 'review-run', sessionId: 'private-review',
  sessionKey: 'agent:main:review', callId: 'model-1', seq: 1, ts: 1000,
  provider: 'custom', model: 'deepseek-v4-pro', trace, ...change });

test('trusted SDK-shaped events retain configured model attribution and exact call ownership only', () => {
  const raw = event();
  for (const field of ['headers', 'body', 'modelContent', 'thinking', 'prompt', 'apiKey', 'privateData'])
    Object.defineProperty(raw, field, { get() { throw new Error('Private field must not be read: ' + field); } });
  const projected = nativeModelCallDiagnostic(raw, { trusted: true }, routes());
  assert.deepEqual(projected, { type: 'model.call.started', runId: 'review-run', sessionId: 'private-review',
    sessionKey: 'agent:main:review', callId: 'model-1', seq: 1, ts: 1000, traceparentSha256: traceHash,
    modelAttribution: { status: 'OBSERVED', source: 'TRUSTED_HOST_MODEL_CALL', provider: 'custom', model: 'deepseek-v4-pro' } });
  assert(!JSON.stringify(projected).includes('PRIVATE_'));
  for (const metadata of [undefined, {}, { trusted: false }, { trusted: 'true' }])
    assert.equal(nativeModelCallDiagnostic(raw, metadata, routes()), null);
  for (const type of ['agent.started', 'model.call.unknown', undefined])
    assert.equal(nativeModelCallDiagnostic(event({ type }), { trusted: true }, routes()), null);
  assert.equal(nativeModelCallDiagnostic(null, { trusted: true }, routes()), null);
});

test('missing, malformed and unconfigured model identities remain explicit without retaining their values', () => {
  const cases = [
    [{ provider: undefined }, 'MODEL_IDENTITY_MISSING'],
    [{ model: null }, 'MODEL_IDENTITY_MISSING'],
    [{ provider: 7 }, 'MODEL_IDENTITY_MALFORMED'],
    [{ model: { id: 'PRIVATE_OBJECT_VALUE' } }, 'MODEL_IDENTITY_MALFORMED'],
    [{ model: 'PRIVATE_SECRET\nbody' }, 'MODEL_IDENTITY_MALFORMED'],
    [{ model: 'https://private.invalid/token' }, 'MODEL_IDENTITY_MALFORMED'],
    [{ model: 'sk-PRIVATE_SECRET' }, 'MODEL_IDENTITY_MALFORMED'],
    [{ model: 'a'.repeat(129) }, 'MODEL_IDENTITY_MALFORMED'],
    [{ provider: 'PRIVATE_UNKNOWN_PROVIDER' }, 'MODEL_ROUTE_NOT_CONFIGURED'],
    [{ model: 'PRIVATE_UNKNOWN_MODEL' }, 'MODEL_ROUTE_NOT_CONFIGURED'],
  ];
  for (const [change, reason] of cases) {
    const projected = nativeModelCallDiagnostic(event(change), { trusted: true }, routes());
    assert.deepEqual(projected.modelAttribution, { status: 'UNAVAILABLE', reason });
    assert.equal(projected.runId, 'review-run');
    assert.equal(projected.traceparentSha256, traceHash);
    assert(!JSON.stringify(projected).includes('PRIVATE_'));
    assert(!Object.hasOwn(projected, 'provider'));
    assert(!Object.hasOwn(projected, 'model'));
  }
  assert.equal(nativeModelCallDiagnostic(event(), { trusted: true }).modelAttribution.reason, 'MODEL_ROUTE_NOT_CONFIGURED');
});

test('model attribution follows the trusted event, not an outer evaluation phase or configured role', () => {
  for (const [runId, sessionId, model] of [['business', 'main', 'deepseek-flash'], ['artifact', 'private', 'deepseek-v4-pro'],
    ['wrong-business-model', 'main', 'deepseek-v4-pro']]) {
    const projected = nativeModelCallDiagnostic(event({ runId, sessionId, model, phase: 'business-proposal',
      reviewerModel: 'PRIVATE_ROLE_GUESS' }), { trusted: true }, routes());
    assert.equal(projected.modelAttribution.model, model);
    assert.equal(projected.runId, runId);
    assert.equal(projected.sessionId, sessionId);
    assert(!Object.hasOwn(projected, 'phase'));
    assert(!JSON.stringify(projected).includes('PRIVATE_ROLE_GUESS'));
  }
});

test('route allowlisting uses only bounded configured identifiers and the explicit primary route', () => {
  const original = structuredClone(config);
  const allowed = nativeModelDiagnosticRoutes({ models: { providers: { ...config.models.providers,
    extra: { models: [{ id: 'PRIVATE_ALLOWED_MODEL' }, { id: 'sk-PRIVATE_KEY' }, { id: 'https://private.invalid' }, {}] },
    malformed: { models: null }, 'PRIVATE_BAD_PROVIDER\n': { models: [{ id: 'model' }] } } } },
  { provider: 'anthropic', model: 'controlled-native' });
  assert.equal(allowed.size, 4);
  assert.deepEqual(config, original);
  assert.equal(nativeModelCallDiagnostic(event({ provider: 'anthropic', model: 'controlled-native' }),
    { trusted: true }, allowed).modelAttribution.status, 'OBSERVED');
  assert.equal(nativeModelCallDiagnostic(event({ model: 'PRIVATE_ALLOWED_MODEL' }),
    { trusted: true }, allowed).modelAttribution.status, 'UNAVAILABLE', 'model spelling cannot cross a provider boundary');
  const empty = nativeModelDiagnosticRoutes({}, { provider: 'custom', model: 'sk-PRIVATE_KEY' });
  assert.equal(empty.size, 0);
});

test('attributed lifecycle rows still require the existing exact native-to-wire ownership join', () => {
  const identity = { runId: 'review-run', sessionId: 'private-review', sessionKey: 'agent:main:review' };
  const start = nativeModelCallDiagnostic(event(), { trusted: true }, routes());
  const end = nativeModelCallDiagnostic(event({ type: 'model.call.error', seq: 2, ts: 1090,
    failureKind: 'connection_closed', error: 'PRIVATE_FAILURE' }), { trusted: true }, routes());
  const fixture = () => ({ ...identity, terminal: { source: 'agent.wait', requestedRunId: identity.runId,
    runId: identity.runId, status: 'error', endedAt: 1100 }, modelCalls: [structuredClone(start), structuredClone(end)],
  transportRequests: [{ id: 1, traceparentSha256: traceHash, startedAt: new Date(1005).toISOString(), endedAt: 1080,
    event: 'request_error', observerStopped: false, failure: 'Error', transportCode: 'UND_ERR_SOCKET', responseStatus: 200,
    bytes: 48, bodyChunks: 2 }] });
  assert.equal(nativeBusinessTransportFailure(fixture()).callId, 'model-1');
  for (const mutate of [
    f => { f.modelCalls[1].callId = 'foreign'; },
    f => { f.modelCalls[1].sessionId = 'foreign'; },
    f => { f.modelCalls[0].traceparentSha256 = 'b'.repeat(64); },
    f => { f.transportRequests.push({ ...f.transportRequests[0], id: 2 }); },
    f => { f.modelCalls = f.modelCalls.map(call => nativeModelCallDiagnostic(call, { trusted: false }, routes())).filter(Boolean); },
  ]) {
    const altered = fixture(); mutate(altered);
    assert.equal(nativeBusinessTransportFailure(altered), null);
  }
  assert(!JSON.stringify([start, end]).includes('PRIVATE_FAILURE'));
});
