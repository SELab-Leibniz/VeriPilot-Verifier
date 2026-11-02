import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarborProviderRelay, codingPlanRelayUpstream } from '../scripts/helpers/harbor-provider-relay.mjs';
const limits = { usd: 20, requests: 3, wallMs: 3000, inputPerRequest: 262144, outputPerRequest: 32768, totalInput: 786432, totalOutput: 98304 };
const payload = { model: 'glm-5.3', messages: [{ role: 'user', content: 'Controlled local qualification.' }], max_tokens: 32, stream: false };
async function request(relay) { const ticket = relay.ticket(); return fetch(ticket.relayBaseUrl + '/chat/completions', {
  method: 'POST', headers: { authorization: 'Bearer ' + ticket.placeholderCredential, 'content-type': 'application/json' }, body: JSON.stringify(payload) }); }

test('admission observer failure is not counted as upstream invocation or wire traffic', async t => {
  const relay = await createHarborProviderRelay({ limits, upstream: () => { throw new Error('must not run'); }, onRecord: () => { throw new Error('pre-dispatch observer failed'); } });
  t.after(() => relay.close()); await (await request(relay)).text();
  const s = relay.snapshot(); assert.equal(s.admittedRequests, 1); assert.equal(s.upstreamInvocations, 0); assert.equal(s.wireDispatchAttempts, 0);
});

test('explicit upstream preflight failure cannot be reported as a provider wire dispatch', async t => {
  const relay = await createHarborProviderRelay({ limits, upstream: () => { throw new Error('pre-outbound validation failed'); } });
  t.after(() => relay.close()); await (await request(relay)).text();
  const s = relay.snapshot(); assert.equal(s.admittedRequests, 1); assert.equal(s.upstreamInvocations, 1); assert.equal(s.wireDispatchAttempts, 0);
});

test('trusted fetch boundary counts once and leaves upstream auth out of tickets, payloads and metadata', async t => {
  const secret = 'controlled-fake-upstream-auth-not-an-account-key'; let calls = 0;
  const upstream = codingPlanRelayUpstream(secret, { fetchImpl: async (url, init) => {
    calls++; assert.equal(url, 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions');
    assert.equal(init.headers.authorization, 'Bearer ' + secret); assert.equal(JSON.parse(init.body).messages[0].content, payload.messages[0].content);
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'local only' } }],
      usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 } }), { headers: { 'content-type': 'application/json' } });
  } });
  const relay = await createHarborProviderRelay({ limits, upstream }); t.after(() => relay.close());
  await (await request(relay)).text(); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(calls, 1); assert.equal(relay.snapshot().wireDispatchAttempts, 1); assert.equal(relay.snapshot().admittedRequests, 1);
  assert(!JSON.stringify([relay.ticket(), relay.snapshot()]).includes(secret));
});
