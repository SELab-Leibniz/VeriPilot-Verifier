import test from 'node:test';
import assert from 'node:assert/strict';
import { harborGatewayConfig, validateHarborRelayTicket } from '../scripts/bench/harbor-gateway-runner.mjs';
const ticket = () => ({ kind: 'rc-harbor-relay-ticket-v1', model: 'openai/glm-5.3', relayBaseUrl: 'http://host.docker.internal:12345/v1',
  placeholderCredential: 'rc-placeholder-' + 'a'.repeat(64), officialWallMs: 10000, deadlineAt: Date.now() + 10000,
  tokenLimits: { inputPerRequest: 262144, outputPerRequest: 32768, totalInput: 2621440, totalOutput: 327680, requests: 10 } });
test('RC-on and RC-off use the same host, model, terminal policy, resources and routes with only the plugin enable bit differing', () => {
  const input = { root: '/logs/agent/rc-runtime', projectRoot: '/app', pluginRoot: '/logs/agent/plugin', port: 1234, ticket: ticket() };
  const on = harborGatewayConfig({ ...input, rcEnabled: true }), off = harborGatewayConfig({ ...input, rcEnabled: false });
  on.plugins.entries['runtime-corrector'].enabled = false; assert.deepEqual(on, off);
  assert.equal(on.agents.defaults.workspace, '/app'); assert.equal(on.session.reset.mode, 'idle');
  assert.equal(on.models.providers.openai.baseUrl, input.ticket.relayBaseUrl);
  assert.equal(on.models.providers.openai.timeoutSeconds, 10);
  assert(!JSON.stringify(on).includes(input.ticket.placeholderCredential));
  assert.deepEqual(on.tools, { deny: ['message'] });
});
test('provider silence policy is finite and never exceeds the original ticket window', () => {
  for (const officialWallMs of [1000, 10999, 1800000]) {
    const original = { ...ticket(), officialWallMs };
    const config = harborGatewayConfig({ root: '/fixture', projectRoot: '/fixture', pluginRoot: '/fixture/plugin', port: 1234,
      ticket: original, rcEnabled: false });
    const value = config.models.providers.openai.timeoutSeconds;
    assert(Number.isSafeInteger(value) && value > 0);
    assert.equal(value, Math.floor(officialWallMs / 1000));
    assert(value * 1000 <= officialWallMs);
    assert.equal(config.diagnostics.stuckSessionAbortMs, officialWallMs);
    assert.equal(original.officialWallMs, officialWallMs);
  }
});
test('tickets reject external targets, real-key-shaped auth, expired wall time and missing finite limits', () => {
  assert.throws(() => validateHarborRelayTicket({ ...ticket(), relayBaseUrl: 'https://example.invalid/v1' }), /ROUTE_UNQUALIFIED/u);
  assert.throws(() => validateHarborRelayTicket({ ...ticket(), placeholderCredential: 'not-a-disposable-cap' }), /TICKET_INVALID/u);
  assert.throws(() => validateHarborRelayTicket({ ...ticket(), deadlineAt: 1 }), /TICKET_INVALID/u);
  assert.throws(() => validateHarborRelayTicket({ ...ticket(), tokenLimits: {} }), /TICKET_INVALID/u);
});

test('baseline benchmark ticket retains its explicitly selected flash model throughout host configuration', () => {
  const selected = { ...ticket(), model: 'openai/glm-5.3-flash' };
  const config = harborGatewayConfig({ root: '/fixture', projectRoot: '/app', pluginRoot: '/fixture/plugin',
    port: 1234, ticket: selected, rcEnabled: true });
  assert.equal(config.agents.defaults.model.primary, selected.model);
  assert.equal(config.models.providers.openai.models[0].id, 'glm-5.3-flash');
  const model = config.models.providers.openai.models[0];
  assert.equal(model.reasoning, true);
  assert.equal(model.thinkingLevelMap.off, 'low');
  assert.equal(model.compat.supportsReasoningEffort, true);
  assert.equal(model.compat.thinkingFormat, 'openai');
});
