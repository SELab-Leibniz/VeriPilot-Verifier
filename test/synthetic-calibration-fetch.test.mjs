import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createProviderRequestBudget } from '../scripts/helpers/provider-request-budget.mjs';
import { createSyntheticCalibrationFetch, syntheticSseUsage } from '../scripts/helpers/synthetic-calibration-fetch.mjs';
const origin = 'https://open.bigmodel.cn', url = origin + '/api/anthropic/v1/messages';
const payload = { model: 'glm-5.3', max_tokens: 8192, messages: [{ role: 'user', content: 'new fictional input' }] };
const sse = 'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":2,"cache_creation_input_tokens":3}}}\n\n'
  + 'data: {"type":"message_delta","usage":{"output_tokens":20}}\n\ndata: {"type":"message_stop"}\n\n';
function fixture() {
  let sends = 0; const rows = [];
  const budget = createProviderRequestBudget({ origin, limits: { usd: 3, requests: 1, wallMs: 1000, inputPerRequest: 32768, outputPerRequest: 8192, totalInput: 131072, totalOutput: 32768 },
    prices: { input: 10, output: 40, cacheRead: 10, cacheWrite: 10 } }); // fictional cap rates for offline tests
  const fetch = createSyntheticCalibrationFetch({ budget, origin, getApprovedPayload: () => payload, onRecord: r => rows.push(r),
    fetchImpl: async () => { sends++; return new Response(sse, { headers: { 'content-type': 'text/event-stream' } }); } });
  return { fetch, budget, rows, sends: () => sends };
}
const init = body => ({ method: 'POST', body: JSON.stringify(body), headers: { authorization: 'synthetic-header-must-not-be-recorded' } });
test('guard inspects actual URL and wire max_tokens before any dispatch', async () => {
  const f = fixture();
  await assert.rejects(f.fetch('https://example.invalid/api/anthropic/v1/messages', init(payload)), { code: 'BUDGET_ORIGIN_MISMATCH' });
  await assert.rejects(f.fetch(url + '?token=fictitious', init(payload)), { code: 'BUDGET_ORIGIN_MISMATCH' });
  await assert.rejects(f.fetch(origin + '/api/anthropic/messages', init(payload)), { code: 'SYNTHETIC_ENDPOINT_DENIED' });
  await assert.rejects(f.fetch(url, init({ ...payload, max_tokens: 8193 })));
  assert.equal(f.sends(), 0); assert.equal(f.budget.snapshot().requests, 0);
});
test('actual SSE bytes and cache usage are preserved; next request is blocked before the fetch callback', async () => {
  const f = fixture();
  assert.equal(await (await f.fetch(url, init(payload))).text(), sse);
  assert.deepEqual(f.rows[0].usage, { input: 10, output: 20, cacheRead: 2, cacheWrite: 3 });
  assert.equal(f.budget.snapshot().committedInputTokens, 15);
  await assert.rejects(f.fetch(url, init(payload)), { code: 'BUDGET_REQUEST_LIMIT' });
  assert.equal(f.sends(), 1); assert(!JSON.stringify(f.rows).includes('synthetic-header'));
});
test('missing cache fields, missing final usage, or truncated SSE is unknown rather than synthetic zero', () => {
  for (const bad of [sse.replace(',"cache_read_input_tokens":2', ''), sse.replace('"output_tokens":20', '"other":20'), sse.replace('data: {"type":"message_stop"}', '')])
    assert.throws(() => syntheticSseUsage(bad), { code: 'BUDGET_USAGE_UNKNOWN' });
});
test('serialized input envelope and caller-payload changes cannot expand the reviewed request', async () => {
  const f = fixture();
  await assert.rejects(f.fetch(url, init({ ...payload, privateMaterial: 'not approved' })));
  assert.equal(f.sends(), 0);
});

test('302 cannot follow to another origin or consume another uncounted request', async t => {
  let redirectedRequests = 0, initialRequests = 0;
  const destination = http.createServer((_req, res) => { redirectedRequests++; res.end('must never arrive'); });
  await new Promise(resolve => destination.listen(0, '127.0.0.1', resolve));
  const server = http.createServer((req, res) => { initialRequests++; req.resume();
    res.writeHead(302, { location: `http://127.0.0.1:${destination.address().port}/unapproved` }); res.end(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const s of [server, destination]) { s.closeAllConnections(); await new Promise(resolve => s.close(resolve)); } });
  const local = `http://127.0.0.1:${server.address().port}`;
  const budget = createProviderRequestBudget({ origin: local, limits: { usd: 3, requests: 4, wallMs: 1000, inputPerRequest: 32768, outputPerRequest: 8192, totalInput: 131072, totalOutput: 32768 },
    prices: { input: 7, output: 22, cacheRead: 7, cacheWrite: 7 } });
  const wrapped = createSyntheticCalibrationFetch({ budget, origin: local, fetchImpl: fetch, getApprovedPayload: () => payload });
  await assert.rejects(wrapped(local + '/api/anthropic/v1/messages', init(payload)), { code: 'BUDGET_USAGE_UNKNOWN' });
  assert.equal(initialRequests, 1); assert.equal(redirectedRequests, 0);
  assert.equal(budget.snapshot().requests, 1); assert.equal(budget.snapshot().halted, 'BUDGET_USAGE_UNKNOWN');
});
