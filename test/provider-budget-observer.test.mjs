import test from 'node:test';
import assert from 'node:assert/strict';
import { providerBudget, observeFetch, installBudgetObserver } from '../scripts/bench/provider-budget-observer.mjs';

test('budget diagnostics preserve the exact request and response while emitting no input text or credentials', async () => {
  const secret = 'private-sentinel-value';
  const body = { model: 'deepseek-v4-flash', max_tokens: 1, messages: [{ role: 'user', content: secret }], apiKey: secret };
  const init = { headers: { authorization: secret }, body: JSON.stringify(body) }, response = { sentinel: true }, records = [];
  const fetch = observeFetch((input, actual) => { assert.equal(input, 'http://fixture'); assert.equal(actual, init); return response; }, row => records.push(row));
  assert.equal(fetch('http://fixture', init), response);
  assert.equal(records[0].maxTokens, 1); assert.equal(records[0].serializerEstimatedInputTokens, Math.ceil(secret.length / 4 * 1.25));
  assert(!JSON.stringify(records).includes(secret));
  assert.equal(providerBudget({ ...body, model: secret }), null);
  assert.equal(observeFetch(() => response, () => { throw Error('disk failure'); })('fixture', init), response);
});

test('wire estimates distinguish CJK weighting and RC content counts without copying any content', () => {
  const row = providerBudget({ model: 'deepseek-v4.1-flash', max_tokens: 100, messages: [
    { role: 'user', content: '中文' }, { role: 'assistant', content: '', tool_calls: [{ id: 'call', function: { name: 'runtime_corrector', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call', content: '[runtime-corrector:feedback] abc' },
    { role: 'user', content: '[RC implementation hints | advisory]\nfixture' },
  ] });
  assert(row.serializerEstimatedInputTokens > 10); assert(row.observedBriefCharacters > 0);
  assert.equal(row.observedFeedbackCharacters, row.observedRcToolCharacters); assert(row.observedRcToolCharacters > 0);
});

test('late injected SDK transport and Request bodies remain observable without consuming or changing the actual request', async () => {
  const records = [], body = { model: 'deepseek-v4-flash', max_tokens: 1, messages: [{ role: 'user', content: 'Private prompt.' }] };
  const request = new Request('http://fixture/v1/chat/completions', { method: 'POST', body: JSON.stringify(body) });
  const response = new Response('fixture'); let actualBody, actualInput, actualInit;
  const runtime = { fetch: globalThis.fetch };
  installBudgetObserver(runtime, value => records.push(value));
  const dependency = {};
  runtime.__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__ = { dependency, fetch: async (input, init) => {
    actualInput = input; actualInit = init; actualBody = await input.text(); return response;
  } };
  const init = { redirect: 'error' };
  assert.equal(await runtime.__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__.fetch(request, init), response);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(actualInput, request); assert.equal(actualInit, init); assert.equal(actualBody, JSON.stringify(body));
  assert.equal(runtime.__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__.dependency, dependency);
  assert.equal(records.length, 1); assert.equal(records[0].maxTokens, 1);
  assert(!JSON.stringify(records).includes('Private prompt.'));
});
