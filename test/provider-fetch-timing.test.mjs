import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { channel } from 'node:diagnostics_channel';
import { pathToFileURL } from 'node:url';
import { installProviderFetchTiming } from '../scripts/helpers/provider-fetch-timing.mjs';

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
