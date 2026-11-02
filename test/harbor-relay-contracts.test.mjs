// Real loopback HTTP, synthetic upstream only. No model or account is called.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarborProviderRelay, codingPlanRelayUpstream, CODING_CHAT_ENDPOINT } from '../scripts/helpers/harbor-provider-relay.mjs';

const limits = { usd: 20, requests: 4, wallMs: 3000, inputPerRequest: 262144,
  outputPerRequest: 32768, totalInput: 1048576, totalOutput: 131072 };
const payload = () => ({ model: 'glm-5.3', stream: true, max_tokens: 32768,
  stream_options: { include_usage: true }, messages: [
    { role: 'system', content: 'Fictional transport qualification; preserve source and tool identities.' },
    { role: 'user', content: 'Read the fictional local contract.' },
  ] });
const sse = (usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Synthetic response.' }, finish_reason: null }] })}\n\n`
  + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], ...(usage ? { usage } : {}) })}\n\ndata: [DONE]\n\n`;
const response = usage => new Response(sse(usage), { headers: { 'content-type': 'text/event-stream' } });
async function fixture(t, upstream, options = {}) {
  const relay = await createHarborProviderRelay({ upstream, limits, ...options });
  t.after(() => relay.close());
  const ticket = relay.ticket();
  const send = (body = payload(), route = '/chat/completions', credential = ticket.placeholderCredential) =>
    fetch(ticket.relayBaseUrl + route, { method: 'POST', headers: {
      authorization: `Bearer ${credential}`, 'content-type': 'application/json',
    }, body: JSON.stringify(body) });
  return { relay, ticket, send };
}

test('relay keeps controller authentication separate and preserves the native textual payload and SSE', async t => {
  const controllerCredential = 'synthetic-controller-auth-not-a-real-key'; let wireCalls = 0;
  const original = payload(), bytes = JSON.stringify(original);
  const upstream = codingPlanRelayUpstream(controllerCredential, { fetchImpl: async (url, init) => {
    wireCalls++; assert.equal(url, CODING_CHAT_ENDPOINT); assert.equal(init.method, 'POST');
    assert.equal(init.headers.authorization, `Bearer ${controllerCredential}`);
    assert.equal(init.redirect, 'error'); assert.equal(Buffer.from(init.body).toString(), bytes);
    return response();
  } });
  const f = await fixture(t, upstream), received = await f.send(original);
  assert.equal(received.status, 200); assert.equal(await received.text(), sse());
  const state = f.relay.snapshot();
  assert.equal(wireCalls, 1); assert.equal(state.budget.requests, 1);
  assert.equal(state.budget.committedInputTokens, 100); assert.equal(state.budget.committedOutputTokens, 20);
  assert.equal(state.budget.inFlightRequests, 0); assert.equal(state.records[0].httpStatus, 200);
  assert(!JSON.stringify(f.ticket).includes(controllerCredential));
  assert(!JSON.stringify(state).includes(controllerCredential));
  assert(!JSON.stringify(state).includes(f.ticket.placeholderCredential));
});

test('wrong tickets, routes, multimodal input and output-cap changes never reach upstream', async t => {
  let calls = 0; const f = await fixture(t, async () => { calls++; return response(); });
  assert.equal((await f.send(payload(), '/chat/completions', 'wrong-disposable-ticket')).status, 403);
  assert.equal((await f.send(payload(), '/other')).status, 403);
  const image = payload(); image.messages[1].content = [{ type: 'image_url', image_url: { url: 'https://example.invalid/a.png' } }];
  assert.equal((await f.send(image)).status, 400);
  assert.equal((await f.send({ ...payload(), max_tokens: 32769 })).status, 400);
  assert.equal(calls, 0); assert.equal(f.relay.snapshot().budget.requests, 0);
});

test('unknown streamed usage holds its full reservation and stops subsequent upstream dispatch', async t => {
  let calls = 0; const f = await fixture(t, async () => { calls++; return response(null); });
  await (await f.send()).text();
  const state = f.relay.snapshot();
  assert.equal(state.budget.halted, 'BUDGET_USAGE_UNKNOWN');
  assert.equal(state.budget.committedInputTokens, limits.inputPerRequest);
  assert.equal(state.budget.committedOutputTokens, limits.outputPerRequest);
  assert.equal(state.budget.inFlightRequests, 0);
  assert.equal((await f.send()).status, 503); assert.equal(calls, 1);
});

test('concurrent original/reviewer requests share serial admission and one request cap', async t => {
  let calls = 0, active = 0, maximum = 0;
  const f = await fixture(t, async () => {
    calls++; active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 10)); active--; return response();
  }, { limits: { ...limits, requests: 2 } });
  const first = await Promise.all([f.send(), f.send()]);
  await Promise.all(first.map(r => r.text()));
  assert.equal(maximum, 1); assert.equal(calls, 2);
  assert.equal((await f.send()).status, 502); assert.equal(calls, 2);
  assert.equal(f.relay.snapshot().budget.requests, 2);
  assert.equal(f.relay.snapshot().budget.inFlightRequests, 0);
});

test('one wall deadline aborts an admitted upstream and does not turn cancellation into known usage', async t => {
  let aborted = false, calls = 0;
  const f = await fixture(t, ({ signal }) => new Promise((resolve, reject) => {
    calls++; const stop = () => { aborted = true; reject(signal.reason); };
    if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
  }), { limits: { ...limits, wallMs: 200 } });
  const received = await f.send(); await received.text();
  assert.equal(aborted, true); assert.equal(calls, 1);
  assert.equal(f.relay.snapshot().budget.halted, 'BUDGET_WALL_LIMIT');
  assert.equal(f.relay.snapshot().budget.committedInputTokens, limits.inputPerRequest);
  assert.equal(f.relay.snapshot().budget.inFlightRequests, 0);
});
