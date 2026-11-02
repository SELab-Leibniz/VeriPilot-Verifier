// Actual loopback control/relay HTTP; synthetic upstream, no model/account.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPilotPhaseController } from '../scripts/bench/run-harbor-gateway-pilot.mjs';
const limits = { usd: 20, requests: 4, wallMs: 10000, inputPerRequest: 262144,
  outputPerRequest: 32768, totalInput: 1048576, totalOutput: 131072, payloadBytes: 131072 };
const start = (controller, body, token) => {
  const d = controller.descriptor();
  return fetch(d.startUrl, { method: 'POST', headers: { authorization: `Bearer ${token ?? d.controlToken}` }, body: JSON.stringify(body) });
};
const synthetic = ({ onWireDispatch }) => {
  onWireDispatch();
  return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Fictional control.' } }],
    usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 } }), { headers: { 'content-type': 'application/json' } });
};
function request(ticket) {
  const route = new URL(ticket.relayBaseUrl); route.hostname = '127.0.0.1';
  return fetch(route + '/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${ticket.placeholderCredential}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'glm-5.3', messages: [{ role: 'user', content: 'Fictional phase control.' }], max_tokens: 16, stream: false }) });
}

test('controller admits one matching phase and concurrent /start cannot renew task time', async t => {
  let calls = 0;
  const controller = await createPilotPhaseController({ officialWallMs: 10000, rcEnabled: true, limits, upstream: args => { calls++; return synthetic(args); } });
  t.after(() => controller.close());
  const phaseStartedAt = Date.now(), body = { phaseStartedAt, officialWallMs: 10000, rcEnabled: true };
  const responses = await Promise.all([start(controller, body), start(controller, body)]);
  assert.deepEqual(responses.map(x => x.status).sort(), [200, 409]);
  const ticket = await responses.find(x => x.status === 200).json();
  assert.equal(ticket.deadlineAt, phaseStartedAt + 10000);
  assert.equal(ticket.officialWallMs, 10000); assert.equal(calls, 0);
  const result = await request(ticket); assert.equal(result.status, 200); await result.text();
  await controller.close();
  const receipt = controller.receipt();
  assert.equal(receipt.deadlineAt, ticket.deadlineAt); assert.equal(receipt.budget.requests, 1);
  assert.equal(receipt.budget.committedInputTokens, 20); assert.equal(receipt.budget.inFlightRequests, 0);
  assert.equal(receipt.wireDispatchAttempts, 1); assert.equal(calls, 1);
  assert(!JSON.stringify(receipt).includes(ticket.placeholderCredential));
});

test('wrong auth, stale clock, arm or official wall never activates a provider', async t => {
  const controller = await createPilotPhaseController({ officialWallMs: 10000, rcEnabled: false, limits, upstream: () => { throw new Error('must not run'); } });
  t.after(() => controller.close());
  const good = { phaseStartedAt: Date.now(), officialWallMs: 10000, rcEnabled: false };
  assert.equal((await start(controller, good, 'wrong')).status, 403);
  for (const body of [{ ...good, phaseStartedAt: Date.now() - 20000 }, { ...good, officialWallMs: 12000 }, { ...good, rcEnabled: true }]) {
    assert.equal((await start(controller, body)).status, 400);
    assert.equal(controller.receipt().providerStarted, false);
  }
  assert.equal((await start(controller, { ...good, phaseStartedAt: Date.now() })).status, 200);
});

test('canonical task deadline aborts an in-flight model transport and preserves unknown usage commitment', async t => {
  let dispatched = false;
  const controller = await createPilotPhaseController({ officialWallMs: 1000, rcEnabled: true, limits,
    upstream: ({ signal, onWireDispatch }) => {
      dispatched = true; onWireDispatch();
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } });
  t.after(() => controller.close());
  const response = await start(controller, { phaseStartedAt: Date.now(), officialWallMs: 1000, rcEnabled: true });
  const ticket = await response.json();
  const pending = request(ticket).then(async r => { await r.text(); return r.status; }).catch(() => null);
  await new Promise(resolve => setTimeout(resolve, 1100)); await pending; await controller.close();
  const receipt = controller.receipt();
  assert(dispatched); assert.equal(receipt.controllerState, 'DEADLINE_EXPIRED');
  assert.equal(receipt.budget.requests, 1); assert.equal(receipt.budget.inFlightRequests, 0);
  assert.equal(receipt.budget.committedInputTokens, limits.inputPerRequest);
  assert(receipt.budget.halted);
});
