// Actual HTTP admission with controlled delayed upstreams; no account/model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarborProviderRelay } from '../scripts/helpers/harbor-provider-relay.mjs';
const limits = { usd: 20, requests: 4, maxConcurrent: 2, wallMs: 5000,
  inputPerRequest: 262144, outputPerRequest: 32768, totalInput: 1048576, totalOutput: 131072 };
const complete = () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Fictional response.' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }), { headers: { 'content-type': 'application/json' } });
function send(relay, name, signal) {
  const ticket = relay.ticket();
  return fetch(ticket.relayBaseUrl + '/chat/completions', { method: 'POST', signal,
    headers: { authorization: 'Bearer ' + ticket.placeholderCredential, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'glm-5.3', messages: [{ role: 'user', content: name }], max_tokens: 32, stream: false }) });
}

test('slow private work cannot hold an independent business request behind its entire generation', async t => {
  let release, started;
  const held = new Promise(resolve => { release = resolve; });
  const firstStarted = new Promise(resolve => { started = resolve; });
  const relay = await createHarborProviderRelay({ limits, upstream: async ({ body, onWireDispatch }) => {
    onWireDispatch();
    if (JSON.parse(body).messages[0].content === 'fictional private') { started(); await held; }
    return complete();
  } });
  t.after(async () => { release(); await relay.close(); });
  const privateRequest = send(relay, 'fictional private'); await firstStarted;
  const business = await send(relay, 'fictional business', AbortSignal.timeout(1000));
  assert.equal(business.status, 200); await business.text();
  assert.equal(relay.snapshot().wireDispatchAttempts, 2);
  assert.equal(relay.snapshot().budget.inFlightRequests, 1);
  assert.equal(relay.snapshot().budget.active, true);
  release(); await (await privateRequest).text(); await relay.close();
  const s = relay.snapshot();
  assert.equal(s.budget.requests, 2); assert.equal(s.budget.committedInputTokens, 20);
  assert.equal(s.budget.committedOutputTokens, 4); assert.equal(s.budget.inFlightRequests, 0);
  assert.equal(s.budget.active, false); assert.equal(s.maxConcurrent, 2);
});

test('unknown usage aborts other admitted work, drains queued work and never dispatches it', async t => {
  let finishUnknown, bothStarted, count = 0;
  const ready = new Promise(resolve => { bothStarted = resolve; });
  const relay = await createHarborProviderRelay({ limits, upstream: ({ body, signal, onWireDispatch }) => {
    onWireDispatch(); if (++count === 2) bothStarted();
    if (JSON.parse(body).messages[0].content === 'fictional unknown')
      return new Promise(resolve => { finishUnknown = () => resolve(new Response('{}', { headers: { 'content-type': 'application/json' } })); });
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  t.after(() => relay.close());
  const first = send(relay, 'fictional unknown'), second = send(relay, 'fictional active');
  await ready;
  const third = send(relay, 'fictional queued');
  await new Promise(resolve => setTimeout(resolve, 30)); finishUnknown();
  await Promise.allSettled([first, second, third].map(async pending => { const response = await pending; await response.text(); }));
  await relay.close();
  const s = relay.snapshot();
  assert.equal(s.wireDispatchAttempts, 2); assert.equal(s.budget.requests, 2);
  assert.equal(s.budget.halted, 'BUDGET_USAGE_UNKNOWN'); assert.equal(s.budget.inFlightRequests, 0);
  assert.equal(s.budget.committedInputTokens, limits.inputPerRequest * 2);
  assert.equal(s.queued, 0); assert.equal(s.preAdmissionCancelled, 1);
});
