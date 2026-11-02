import test from 'node:test';
import assert from 'node:assert/strict';
import { createIntegratedBusinessObserver } from '../scripts/helpers/native-integrated-observation.mjs';

const business = { sessionId: 'session', sessionKey: 'key' };
const ctx = { ...business, runId: 'original' };
const event = { toolName: 'exec', toolCallId: 'call', params: { command: 'unit-contract' } };
function observer() {
  const records = [];
  return { records, observer: createIntegratedBusinessObserver({ business: async () => business, append: async item => records.push(item) }) };
}
test('bare native middleware context resolves only the actual unique before-tool binding and never changes the result', async () => {
  const f = observer();
  await f.observer.before(event, ctx);
  const result = { toolName: 'exec', toolCallId: 'call', isError: false, result: { details: { status: 'completed', exitCode: 0 } } };
  const before = structuredClone(result);
  assert.equal(await f.observer.result(result, { runtime: 'openclaw' }), undefined);
  assert.deepEqual(result, before);
  assert.deepEqual(Object.fromEntries(['sessionId', 'sessionKey', 'runId'].map(key => [key, f.records.at(-1)[key]])), ctx);
  assert.equal(f.records.at(-1).event, result);
});
test('reused bare call ID and mismatched explicit identities cannot select a recent or foreign owner', async () => {
  const f = observer(); await f.observer.before(event, ctx);
  await f.observer.before(event, { ...ctx, runId: 'correction' });
  await f.observer.result({ toolCallId: 'call', toolName: 'exec', result: {} }, { runtime: 'openclaw' });
  assert.equal(f.records.at(-1).reason, 'ambiguous-tool-call');
  await f.observer.result({ toolCallId: 'call', toolName: 'exec', result: {} }, { ...ctx, sessionId: 'foreign' });
  assert.equal(f.records.at(-1).reason, 'no-matching-tool-call');
  await f.observer.result({ toolCallId: 'call', toolName: 'exec', result: {} }, ctx);
  assert.equal(f.records.at(-1).phase, 'result'); assert.equal(f.records.at(-1).runId, 'original');
});
test('blocked, missing-owner and unpaired events cannot create native result evidence', async () => {
  const f = observer(); await f.observer.before(event, ctx, { block: true });
  await f.observer.result({ toolCallId: 'call', toolName: 'exec', result: {} });
  assert.equal(f.records.at(-1).phase, 'unavailable');
  await f.observer.before({ ...event, toolCallId: 'no-run' }, business);
  await f.observer.result({ toolCallId: 'no-run', result: {} });
  assert.equal(f.records.at(-1).phase, 'unavailable');
});
test('duplicate native before call IDs in the same run are ambiguous instead of overwriting the first operation', async () => {
  const f = observer(); await f.observer.before(event, ctx);
  await f.observer.before({ ...event, params: { command: 'different command' } }, ctx);
  await f.observer.result({ toolCallId: 'call', toolName: 'exec', result: {} }, ctx);
  assert.equal(f.records.at(-1).reason, 'ambiguous-tool-call');
});
test('private/business same call ID stays ambiguous with bare context in either arrival order and never copies private payload', async () => {
  const privateCtx = { sessionId: 'private-session', sessionKey: 'private-key', runId: 'private-run' };
  const read = { toolName: 'read', toolCallId: 'shared', params: { path: 'business-public.md' } };
  const privateRead = { ...read, params: { path: 'PRIVATE_PAYLOAD_MUST_NOT_BE_COPIED' } };
  for (const privateFirst of [false, true]) {
    const f = observer();
    if (privateFirst) await f.observer.before(privateRead, privateCtx);
    await f.observer.before(read, ctx);
    if (!privateFirst) await f.observer.before(privateRead, privateCtx);
    await f.observer.result({ toolName: 'read', toolCallId: 'shared', result: { content: 'PRIVATE_PAYLOAD_MUST_NOT_BE_COPIED' } }, { runtime: 'openclaw' });
    assert.equal(f.records.at(-1).reason, 'ambiguous-tool-call');
    assert.equal(f.records.filter(record => record.phase === 'result').length, 0);
    await f.observer.result({ toolName: 'read', toolCallId: 'shared', result: { content: 'PRIVATE_PAYLOAD_MUST_NOT_BE_COPIED' } }, privateCtx);
    assert.equal(f.records.filter(record => record.phase === 'result').length, 0);
    assert(!JSON.stringify(f.records).includes('PRIVATE_PAYLOAD_MUST_NOT_BE_COPIED'));
    await f.observer.result({ toolName: 'read', toolCallId: 'shared', result: { content: 'public' } }, ctx);
    assert.equal(f.records.at(-1).phase, 'result'); assert.equal(f.records.at(-1).sessionId, business.sessionId);
  }
});
test('unique private receipts are skipped, and different private tool names do not disambiguate a bare reused ID', async () => {
  const f = observer(), privateCtx = { sessionId: 'private', sessionKey: 'private-key', runId: 'private-run' };
  await f.observer.before({ toolName: 'read', toolCallId: 'private-only', params: { path: 'private' } }, privateCtx);
  await f.observer.result({ toolCallId: 'private-only', toolName: 'read', result: { content: 'private' } });
  assert.equal(f.records.length, 0);
  await f.observer.before(event, ctx);
  await f.observer.before({ ...event, toolName: 'read' }, privateCtx);
  await f.observer.result({ toolCallId: 'call', toolName: 'exec', result: {} });
  assert.equal(f.records.at(-1).reason, 'ambiguous-tool-call');
});
test('observation capacity latches fail-closed without discarding old conflicts or reassigning the newest owner', async () => {
  const f = observer(); await f.observer.before(event, ctx);
  for (let i = 0; i < 1024; i++) await f.observer.before({ toolName: 'read', toolCallId: `private-${i}` },
    { sessionId: `private-${i}`, sessionKey: `private-key-${i}`, runId: `private-run-${i}` });
  await f.observer.result({ toolCallId: 'call', toolName: 'exec', result: {} }, ctx);
  assert.equal(f.records.at(-1).reason, 'observation-binding-cap');
  assert.equal(f.records.filter(record => record.phase === 'result').length, 0);
  await f.observer.before(event, { ...ctx, runId: 'newest-run' });
  await f.observer.result({ toolCallId: 'call', toolName: 'exec', result: {} });
  assert.equal(f.records.at(-1).reason, 'observation-binding-cap');
});
