import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { channel } from 'node:diagnostics_channel';
import { pathToFileURL } from 'node:url';
import { installProviderFetchTiming, providerTraceparentSha256 } from '../scripts/helpers/provider-fetch-timing.mjs';
import { nativeBusinessTransportFailure } from '../scripts/helpers/native-gateway-evaluation.mjs';

async function fixture(t, handler, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-fetch-timing-'));
  const probe = '/__rc_local_transport_probe__';
  const server = http.createServer((request, response) => {
    if (request.url === probe) { request.resume(); response.writeHead(204); response.end(); }
    else handler(request, response);
  });
  let timing, origin;
  t.after(async () => { await timing?.close(); server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true }); });
  // Some Windows machines allocate ephemeral ports from 1024, including
  // fetch-blocked ports. Verify transport BEFORE installing the observer, so
  // the probe never contributes to requestCount. Retry only that exact cause.
  for (let attempt = 0; attempt < 16; attempt++) {
    await new Promise((resolve, reject) => { server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
    origin = `http://127.0.0.1:${server.address().port}`;
    try { assert.equal((await fetch(origin + probe, { signal: AbortSignal.timeout(2000) })).status, 204); break; }
    catch (error) {
      if (error.cause?.message !== 'bad port') throw error;
      origin = null; await new Promise(resolve => server.close(resolve));
    }
  }
  if (!origin) throw new Error('No fetch-compatible local test port was allocated');
  timing = await installProviderFetchTiming({ file: path.join(root, 'timing.jsonl'), origin, ...options });
  return { origin, timing, rows: async () => (await fs.readFile(timing.file, 'utf8')).trim().split('\n').map(JSON.parse) };
}

test('passive request timing preserves fetch and SSE bytes without saving private data', async t => {
  const canary = 'PRIVATE_FETCH_CANARY_1427';
  const body = `data: {"type":"thinking_delta","thinking":"${canary} 中文🌻"}\r\n\r\n`;
  const original = globalThis.fetch;
  const f = await fixture(t, (request, response) => { assert.equal(request.headers.authorization, canary);
    request.resume(); response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(body.slice(0, 30)); setTimeout(() => response.end(body.slice(30)), 10); });
  f.timing.setPhase('review:1');
  const response = await fetch(`${f.origin}/messages?key=${canary}`, { method: 'POST', headers: { authorization: canary }, body: canary });
  assert.equal(await response.text(), body); await f.timing.close();
  const rows = await f.rows(), end = rows.at(-1);
  assert.equal(globalThis.fetch, original); assert.equal(f.timing.requestCount, 1);
  assert.equal(rows.find(row => row.event === 'response').status, 200);
  assert.equal(end.event, 'response_end'); assert.equal(end.phase, 'review:1');
  assert.equal(end.bytes, Buffer.byteLength(body)); assert(end.bodyChunks >= 1); assert(end.firstBodyMs >= 0);
  const saved = await fs.readFile(f.timing.file, 'utf8');
  for (const secret of [canary, '127.0.0.1', 'thinking_delta', 'authorization']) assert.equal(saved.includes(secret), false);
});

test('HTTP failures are observable while another origin and response bodies remain unchanged', async t => {
  const f = await fixture(t, (request, response) => { request.resume(); response.writeHead(429); response.end('PRIVATE_RESPONSE'); });
  const other = await fixture(t, (request, response) => { request.resume(); response.end('other'); });
  assert.equal(await (await fetch(other.origin)).text(), 'other');
  assert.equal(await (await fetch(f.origin)).text(), 'PRIVATE_RESPONSE'); await f.timing.close();
  assert.equal(f.timing.requestCount, 1);
  assert.equal((await f.rows()).find(row => row.event === 'response').status, 429);
  assert.equal((await fs.readFile(f.timing.file, 'utf8')).includes('PRIVATE_RESPONSE'), false);
});

test('a long response reports byte progress before completion without recording stream content', async t => {
  let finish;
  const secret = 'PRIVATE_STREAM_PROGRESS';
  const f = await fixture(t, (request, response) => {
    request.resume(); response.writeHead(200); response.write(secret);
    setTimeout(() => response.write(secret), 15);
    finish = () => response.end(secret);
  }, { progressIntervalMs: 1 });
  const response = await fetch(f.origin), text = response.text();
  let rows = [];
  for (const end = Date.now() + 2000; Date.now() < end;) {
    rows = await f.rows().catch(() => []);
    if (rows.some(row => row.event === 'response_progress' && row.bytes >= Buffer.byteLength(secret) * 2)) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert(rows.some(row => row.event === 'response_progress' && row.bytes >= Buffer.byteLength(secret) * 2 && row.bodyChunks > 0));
  assert(!rows.some(row => row.event === 'response_end'));
  finish(); assert.equal(await text, secret.repeat(3)); await f.timing.close();
  assert.equal((await fs.readFile(f.timing.file, 'utf8')).includes(secret), false);
});

test('closing a stalled observation is immediate and does not cancel its actual request', async t => {
  let finish;
  const f = await fixture(t, (request, response) => { request.resume(); response.writeHead(200); response.write('start'); finish = () => response.end('end'); });
  const response = await fetch(f.origin), body = response.text();
  await f.timing.close();
  assert.equal((await f.rows()).at(-1).observerStopped, true);
  finish(); assert.equal(await body, 'startend');
  assert.equal((await f.rows()).length, 3);
});

test('an aborted real request retains its original error and logs no message', async t => {
  const f = await fixture(t, (request, response) => { request.resume(); response.writeHead(200); response.write('start'); });
  const abort = new AbortController(), failure = new Error('PRIVATE_ABORT_MESSAGE');
  const response = await fetch(f.origin, { signal: abort.signal });
  const body = response.text(); abort.abort(failure);
  await assert.rejects(body, error => error === failure || error.name === 'AbortError');
  await f.timing.close();
  assert((await f.rows()).some(row => row.event === 'request_error'));
  assert.equal((await fs.readFile(f.timing.file, 'utf8')).includes('PRIVATE_ABORT_MESSAGE'), false);
});

test('a dropped response body records the HTTP status and allowlisted socket code', async t => {
  let drop;
  const secret = 'PRIVATE_TERMINATED_STREAM';
  const f = await fixture(t, (request, response) => {
    request.resume(); response.writeHead(200); response.write(secret);
    drop = () => response.destroy();
  });
  const response = await fetch(f.origin);
  const rejected = assert.rejects(response.text());
  drop();
  await rejected;
  await f.timing.close();
  const error = (await f.rows()).at(-1);
  assert.equal(error.event, 'request_error');
  assert.equal(error.responseStatus, 200);
  assert.equal(error.transportCode, 'UND_ERR_SOCKET');
  assert.equal(error.observerStopped, false);
  assert.equal((await fs.readFile(f.timing.file, 'utf8')).includes(secret), false);
});

test('correlation retains only the exact trace hash and a closed request observation', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-fetch-correlation-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const origin = 'https://contract.invalid';
  const timing = await installProviderFetchTiming({ file: path.join(root, 'timing.jsonl'), origin, captureTraceparent: true });
  t.after(() => timing.close());
  const rawTrace = '00-1234567890abcdef1234567890abcdef-1234567890abcdef-01';
  const headers = ['Authorization', 'PRIVATE_CORRELATION_AUTH', 'traceparent', rawTrace];
  const request = { origin, headers };
  channel('undici:request:create').publish({ request });
  channel('undici:request:create').publish({ request: { origin, headers: [...headers, 'TraceParent', rawTrace] } });
  channel('undici:request:create').publish({ request: { origin: 'https://other.invalid', headers } });
  assert.equal(timing.traceRequests().length, 1);
  assert.equal(timing.traceRequests()[0].event, 'request');
  channel('undici:request:headers').publish({ request, response: { statusCode: 200 } });
  channel('undici:request:bodyChunkReceived').publish({ request, chunk: Buffer.from('PRIVATE_CORRELATION_BODY') });
  channel('undici:request:error').publish({ request, error: Object.assign(new Error('PRIVATE_CORRELATION_ERROR'), { code: 'UND_ERR_SOCKET' }) });
  const [closed] = timing.traceRequests();
  assert.equal(closed.traceparentSha256, providerTraceparentSha256(rawTrace));
  assert.equal(closed.event, 'request_error');
  assert.equal(closed.transportCode, 'UND_ERR_SOCKET');
  assert.equal(closed.responseStatus, 200);
  assert(Number.isSafeInteger(closed.endedAt));
  await timing.close();
  assert.equal(timing.requestCount, 2);
  const saved = await fs.readFile(timing.file, 'utf8');
  for (const value of ['PRIVATE_CORRELATION', rawTrace, origin, 'Authorization']) assert.equal(saved.includes(value), false);
});

function nativeFailureFixture() {
  const identity = { runId: 'apply', sessionId: 'business', sessionKey: 'agent:main:business' };
  const traceparentSha256 = 'a'.repeat(64);
  const call = { ...identity, callId: 'owned', traceparentSha256 };
  return { ...identity, terminal: { source: 'agent.wait', requestedRunId: identity.runId, runId: identity.runId, status: 'error', endedAt: 1100 },
    modelCalls: [
      { ...call, type: 'model.call.started', ts: 1000, seq: 1 },
      { ...call, type: 'model.call.error', ts: 1090, seq: 2, failureKind: 'connection_closed' },
    ], transportRequests: [{ id: 1, traceparentSha256, startedAt: new Date(1005).toISOString(), endedAt: 1080,
      event: 'request_error', observerStopped: false, failure: 'Error', transportCode: 'UND_ERR_SOCKET', responseStatus: 200, bytes: 549, bodyChunks: 2 }] };
}

test('benchmark transport recovery requires a settled exact business terminal, latest owned call and unique closed wire', () => {
  assert.equal(nativeBusinessTransportFailure(nativeFailureFixture())?.transportCode, 'UND_ERR_SOCKET');
  for (const mutate of [
    f => { f.terminal.requestedRunId = 'reviewer'; },
    f => { f.terminal.status = 'timeout'; },
    f => { f.modelCalls[1].sessionKey = 'agent:main:reviewer'; },
    f => { f.modelCalls[1].callId = 'other-call'; },
    f => { f.modelCalls[1].failureKind = 'aborted'; },
    f => { f.modelCalls[1].ts = 1200; },
    f => { f.modelCalls.push({ ...f.modelCalls[0], callId: 'newer', seq: 3 }); },
    f => { f.modelCalls.push({ ...f.modelCalls[0], runId: 'compaction', callId: 'newer', seq: 3 }); },
    f => { f.modelCalls.push({ ...f.modelCalls[0], runId: 'reviewer', sessionId: 'private', sessionKey: 'private', seq: 3 }); },
    f => { f.transportRequests[0].traceparentSha256 = 'b'.repeat(64); },
    f => { f.transportRequests[0].event = 'response_end'; },
    f => { f.transportRequests[0].failure = 'AbortError'; },
    f => { f.transportRequests.push({ ...f.transportRequests[0], id: 2, event: 'request' }); },
  ]) {
    const value = nativeFailureFixture(); mutate(value);
    assert.equal(nativeBusinessTransportFailure(value), null, mutate.toString());
  }
});

test('an SDK completed call can match a closed stream only with the controller-attested terminated assistant leaf', () => {
  const f = nativeFailureFixture();
  f.modelCalls[1] = { ...f.modelCalls[1], type: 'model.call.completed', failureKind: undefined };
  f.transportRequests[0] = { ...f.transportRequests[0], transportCode: undefined, failure: 'OtherError' };
  assert.equal(nativeBusinessTransportFailure(f), null);
  const assistantError = { failureKind: 'terminated', messageId: 'business-leaf', messageSha256: 'c'.repeat(64), startedAt: 1001, persistedAt: 1081 };
  assert.equal(nativeBusinessTransportFailure({ ...f, assistantError })?.assistantMessageSha256, assistantError.messageSha256);
  for (const change of [{ startedAt: 999 }, { startedAt: 1006 }, { persistedAt: 1079 }, { persistedAt: 1101 }, { failureKind: 'timeout' }])
    assert.equal(nativeBusinessTransportFailure({ ...f, assistantError: { ...assistantError, ...change } }), null);
  f.transportRequests[0].bytes = 0;
  assert.equal(nativeBusinessTransportFailure({ ...f, assistantError }), null);
});

test('owned subscriptions are released without removing other diagnostics listeners', async t => {
  const port = channel('undici:request:create'); let otherCalls = 0;
  const observer = () => { otherCalls++; }; port.subscribe(observer); t.after(() => port.unsubscribe(observer));
  const f = await fixture(t, (request, response) => { request.resume(); response.end('ok'); });
  await f.timing.close(); await f.timing.close();
  assert.equal(await (await fetch(f.origin)).text(), 'ok');
  assert(otherCalls >= 1); assert.equal(f.timing.requestCount, 0);
});

test('installed host direct provider transport is observed without a model call or host mutation', {
  skip: !process.env.RC_OPENCLAW_HOST_ROOT,
}, async t => {
  const requestSettings = [];
  const f = await fixture(t, async (request, response) => {
    let raw = ''; for await (const part of request) raw += part;
    const payload = JSON.parse(raw);
    requestSettings.push({ thinkingPresent: Object.hasOwn(payload, 'thinking'),
      thinkingType: payload.thinking?.type ?? null, maxTokens: payload.max_tokens });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('event: message_start\ndata: {"type":"message_start","message":{"id":"local","type":"message","role":"assistant","model":"controlled-transport","content":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n'); });
  const load = relative => import(pathToFileURL(path.join(process.env.RC_OPENCLAW_HOST_ROOT, relative)).href);
  const { i: createStream } = await load('dist/provider-stream-CqSx37Uy.js');
  const original = globalThis.fetch;
  const model = { id: 'controlled-transport', name: 'controlled-transport', provider: 'anthropic', api: 'anthropic-messages', baseUrl: f.origin,
    reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const stream = createStream(model)(model, { messages: [{ role: 'user', content: 'Local transport contract only.', timestamp: Date.now() }] },
    { apiKey: 'controlled-local-not-a-secret', maxTokens: 16, reasoning: 'off' });
  const result = await stream.result();
  assert.equal(result.stopReason, 'stop', JSON.stringify({ stopReason: result.stopReason, error: result.errorMessage }));
  // The pinned host emits explicit disabled thinking only when the model
  // advertises that capability. A false capability flag leaves it unspecified.
  assert.deepEqual(requestSettings[0], { thinkingPresent: false, thinkingType: null, maxTokens: 16 });
  const capable = { ...model, reasoning: true };
  const second = await createStream(capable)(capable,
    { messages: [{ role: 'user', content: 'Local transport contract only.', timestamp: Date.now() }] },
    { apiKey: 'controlled-local-not-a-secret', maxTokens: 16, reasoning: 'off' }).result();
  assert.equal(second.stopReason, 'stop');
  assert.deepEqual(requestSettings[1], { thinkingPresent: true, thinkingType: 'disabled', maxTokens: 16 });
  await f.timing.close();
  assert.equal(f.timing.requestCount, 2); assert.equal(globalThis.fetch, original);
  assert.equal((await f.rows()).find(row => row.event === 'response').status, 200);
  assert.equal((await f.rows()).at(-1).event, 'response_end');
});
