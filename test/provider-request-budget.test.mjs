import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createProviderRequestBudget } from '../scripts/helpers/provider-request-budget.mjs';

const origin = 'https://open.bigmodel.cn';
const prices = { input: '10', output: '20', cacheRead: '5', cacheWrite: '15' }; // fictitious test rates
const limits = { usd: '1', requests: 2, wallMs: 2000, inputPerRequest: 100, outputPerRequest: 100, totalInput: 200, totalOutput: 200 };
const request = { origin, inputTokensUpperBound: 100, maxOutputTokens: 100 };
const complete = (input = 10, output = 20) => ({ value: 'ok', usage: { input, output, cacheRead: 0, cacheWrite: 0 } });
const guard = options => createProviderRequestBudget({ origin, limits, prices, ...options });

test('reserves maximum cost and request slot before dispatch and settles exact reported usage', async () => {
  const budget = guard();
  assert.equal(await budget.run(request, async ({ maxOutputTokens }) => {
    assert.equal(maxOutputTokens, 100);
    assert.deepEqual({ ...budget.snapshot(), elapsedMs: 0 }, { origin, requests: 1, committedInputTokens: 100, committedOutputTokens: 100,
      estimatedCommittedUsd: 0.0035, active: true, inFlightRequests: 1, halted: null, elapsedMs: 0, rateKind: 'explicit_reference_estimate_not_verified_bill' });
    return complete();
  }), 'ok');
  assert.equal(budget.snapshot().estimatedCommittedUsd, 0.0005);
  assert.equal(budget.snapshot().committedInputTokens, 10);
});

test('request count includes each attempt, rejects before third dispatch, and does not retry', async () => {
  const budget = guard(); let sent = 0;
  for (let i = 0; i < 2; i++) await budget.run(request, async () => { sent++; return complete(); });
  await assert.rejects(budget.run(request, async () => { sent++; }), { code: 'BUDGET_REQUEST_LIMIT' });
  assert.equal(sent, 2); assert.equal(budget.snapshot().requests, 2);
});

test('estimated dollar and aggregate token caps reject before spending remaining balance', async () => {
  let sent = 0;
  const budget = guard({ limits: { ...limits, usd: '0.003499999' } });
  await assert.rejects(budget.run(request, async () => { sent++; }), { code: 'BUDGET_COST_LIMIT' });
  assert.equal(sent, 0); assert.equal(budget.snapshot().requests, 0);
  const tokens = guard({ limits: { ...limits, totalInput: 100 } });
  await tokens.run(request, async () => complete(100, 0));
  await assert.rejects(tokens.run(request, async () => { sent++; }), { code: 'BUDGET_TOTAL_TOKEN_LIMIT' });
  assert.equal(sent, 0);
});

test('origins, per-request limits and concurrent admission cannot bypass reservations', async () => {
  const budget = guard(); let sent = 0, finish;
  await assert.rejects(budget.run({ ...request, origin: 'https://example.invalid' }, async () => { sent++; }), { code: 'BUDGET_ORIGIN_MISMATCH' });
  await assert.rejects(budget.run({ ...request, origin: origin + '/path?token=not-a-secret' }, async () => { sent++; }), { code: 'BUDGET_ORIGIN_INVALID' });
  await assert.rejects(budget.run({ ...request, maxOutputTokens: 101 }, async () => { sent++; }), { code: 'BUDGET_REQUEST_TOKEN_LIMIT' });
  const first = budget.run(request, () => new Promise(resolve => { sent++; finish = () => resolve(complete()); }));
  await assert.rejects(budget.run(request, async () => { sent++; }), { code: 'BUDGET_CONCURRENT_DISPATCH' });
  finish(); await first; assert.equal(sent, 1);
});

for (const kind of ['failure', 'missing', 'incomplete']) test(`${kind} usage keeps reservation and prevents all subsequent dispatch`, async () => {
  const budget = guard(); let sent = 0;
  const failure = new Error('fictitious private error');
  await assert.rejects(budget.run(request, async () => {
    sent++;
    if (kind === 'failure') throw failure;
    return kind === 'missing' ? { value: 'unknown' } : { usage: { input: 1, output: 1 } };
  }));
  assert.equal(budget.snapshot().estimatedCommittedUsd, 0.0035);
  await assert.rejects(budget.run(request, async () => { sent++; }), { code: 'BUDGET_USAGE_UNKNOWN' });
  assert.equal(sent, 1); assert(!JSON.stringify(budget.snapshot()).includes('private error'));
});

test('a native abort with a numeric code preserves the original failure and closes unknown usage', async () => {
  const budget = guard(), failure = new DOMException('Synthetic native stream abort', 'AbortError');
  assert.equal(typeof failure.code, 'number');
  await assert.rejects(budget.run(request, async () => { throw failure; }), error => error === failure);
  assert.equal(budget.snapshot().halted, 'BUDGET_USAGE_UNKNOWN');
  assert.equal(budget.snapshot().estimatedCommittedUsd, 0.0035);
  assert.equal(budget.snapshot().inFlightRequests, 0);
  await assert.rejects(budget.run(request, async () => assert.fail('must not dispatch again')), { code: 'BUDGET_USAGE_UNKNOWN' });
});

test('reported overrun is retained honestly and closes the ledger', async () => {
  const budget = guard();
  await assert.rejects(budget.run(request, async () => complete(120, 101)), { code: 'BUDGET_USAGE_EXCEEDS_RESERVATION' });
  assert.equal(budget.snapshot().committedInputTokens, 120);
  assert.equal(budget.snapshot().committedOutputTokens, 101);
  assert.equal(budget.snapshot().estimatedCommittedUsd, 0.00322);
  await assert.rejects(budget.run(request, async () => complete()), { code: 'BUDGET_USAGE_EXCEEDS_RESERVATION' });
});

test('wall-clock limit rejects expired admission and aborts in-flight local work', async () => {
  let now = 10; const budget = guard({ now: () => now }); now += 2000;
  await assert.rejects(budget.run(request, async () => assert.fail('must not dispatch')), { code: 'BUDGET_WALL_LIMIT' });
  let aborted = false;
  const active = guard({ limits: { ...limits, wallMs: 20 } });
  await assert.rejects(active.run(request, ({ signal }) => new Promise(() => {
    signal.addEventListener('abort', () => { aborted = true; }, { once: true });
  })), { code: 'BUDGET_WALL_LIMIT' });
  assert(aborted); assert.equal(active.snapshot().requests, 1);
  assert.equal(active.snapshot().estimatedCommittedUsd, 0.0035);
  assert.equal(active.snapshot().inFlightRequests, 1, 'abort is not proof that upstream terminated');
});

test('a late settlement remains unknown, keeps its reservation and never reopens the ledger', async () => {
  let finish;
  const budget = guard({ limits: { ...limits, wallMs: 10 } });
  await assert.rejects(budget.run(request, () => new Promise(resolve => { finish = resolve; })), { code: 'BUDGET_WALL_LIMIT' });
  assert.equal(budget.snapshot().inFlightRequests, 1);
  finish(complete()); await new Promise(resolve => setImmediate(resolve));
  assert.equal(budget.snapshot().inFlightRequests, 0);
  assert.equal(budget.snapshot().estimatedCommittedUsd, 0.0035);
  await assert.rejects(budget.run(request, async () => assert.fail('must not restart')), { code: 'BUDGET_WALL_LIMIT' });
});

test('controlled local HTTP response settles once; next request is rejected before hitting the server', async t => {
  let received = 0;
  const server = http.createServer((req, res) => { received++; req.resume(); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(complete())); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const local = `http://127.0.0.1:${server.address().port}`;
  const budget = guard({ origin: local, limits: { ...limits, requests: 1 } });
  const send = async ({ signal }) => (await fetch(local, { method: 'POST', body: 'new synthetic input', signal })).json();
  assert.equal(await budget.run({ ...request, origin: local }, send), 'ok');
  await assert.rejects(budget.run({ ...request, origin: local }, send), { code: 'BUDGET_REQUEST_LIMIT' });
  assert.equal(received, 1);
});

test('concurrent roles reserve aggregate capacity atomically and keep active true until both settle', async () => {
  const budget = guard({ limits: { ...limits, maxConcurrent: 2, totalInput: 150 } });
  let finish, secondSent = false;
  const first = budget.run(request, () => new Promise(resolve => { finish = () => resolve(complete()); }));
  await assert.rejects(budget.run(request, async () => { secondSent = true; return complete(); }), { code: 'BUDGET_TOTAL_TOKEN_LIMIT' });
  assert.equal(secondSent, false); assert.equal(budget.snapshot().requests, 1);
  finish(); await first;
  await budget.run(request, async () => complete());
  assert.equal(budget.snapshot().requests, 2); assert.equal(budget.snapshot().committedInputTokens, 20);
});

test('one unknown concurrent role retains its reservation while another settles honestly', async () => {
  const budget = guard({ limits: { ...limits, maxConcurrent: 2 } });
  let firstDone, secondDone;
  const first = budget.run(request, () => new Promise(resolve => { firstDone = resolve; }));
  const second = budget.run(request, () => new Promise(resolve => { secondDone = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(budget.snapshot().inFlightRequests, 2);
  firstDone({ value: 'unknown' }); await assert.rejects(first, { code: 'BUDGET_USAGE_UNKNOWN' });
  assert.equal(budget.snapshot().active, true);
  secondDone(complete()); await second;
  assert.equal(budget.snapshot().committedInputTokens, 110); assert.equal(budget.snapshot().committedOutputTokens, 120);
  assert.equal(budget.snapshot().inFlightRequests, 0); assert.equal(budget.snapshot().active, false);
  await assert.rejects(budget.run(request, async () => assert.fail('must not dispatch')), { code: 'BUDGET_USAGE_UNKNOWN' });
});
