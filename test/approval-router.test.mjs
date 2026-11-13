import test from 'node:test';
import assert from 'node:assert/strict';
import { createApprovalRouter, approvalMode } from '../lib/openclaw/approval-router.mjs';

function fixture(t, options = {}) {
  const records = [], sent = [], forwarded = [], controller = new AbortController();
  const router = createApprovalRouter({ record: (_owner, row) => records.push(row), ...options });
  t.after(() => router.close());
  const owner = { agentId: 'main', sessionId: 'private', sessionKey: 'agent:main:runtime-corrector:private',
    parentSessionKey: 'agent:main:user-chat', runId: 'run', deadlineAt: Date.now() + 10000,
    signal: controller.signal, toolNames: ['source_read'], taskId: 'task' };
  const unbind = router.bind(owner), connection = {};
  const request = { id: 'original-request', type: 'confirm', tool: 'source_read', risk: 'high',
    reason: 'Sensitive path: /dev', command: '{"path":"docs/testing/DEVICE_TEST_FRAMEWORK.md"}',
    sessionKey: owner.sessionKey, runId: owner.runId };
  const route = value => router.request(value ?? request, { send: reply => sent.push(reply), forward: value => forwarded.push(value), connection });
  return { router, records, sent, forwarded, controller, owner, request, route, unbind, connection };
}

test('ordinary mode shows the approval in the parent chat and resolves the original host request', async t => {
  const f = fixture(t); f.route();
  assert.equal(f.sent.length, 0);
  assert.equal(f.forwarded[0].sessionKey, f.owner.parentSessionKey);
  assert.equal(f.forwarded[0].runId, f.owner.runId);
  assert.equal(f.forwarded[0].command, f.request.command);
  assert.notEqual(f.forwarded[0].id, f.request.id);
  assert.equal(f.router.status(f.owner.parentSessionKey).pending.length, 1);
  assert.equal(f.router.response({ id: f.forwarded[0].id, action: 'allow' }, f.connection), false);
  assert.deepEqual(f.sent, [{ id: f.request.id, action: 'allow', source: 'runtime-corrector:user' }]);
  assert.equal(f.router.status(f.owner.parentSessionKey).pending.length, 0);
  await Promise.resolve(); assert.deepEqual(f.records.map(row => row.status), ['WAITING_FOR_USER', 'USER_ALLOWED']);
});

test('a rejection remains a rejection, and a reply on another connection cannot authorize work', t => {
  const f = fixture(t); f.route(); const id = f.forwarded[0].id;
  f.router.response({ id, action: 'allow' }, {}); assert.equal(f.sent.length, 0);
  f.router.response({ id, action: 'reject' }, f.connection); assert.equal(f.sent[0].action, 'reject');
  f.router.response({ id, action: 'allow' }, f.connection); assert.equal(f.sent.length, 1);
});

test('unattended authorization is limited to this user session and bound protocol tools', async t => {
  const f = fixture(t); f.router.setMode(f.owner.parentSessionKey, 'unattended'); f.route();
  assert.equal(f.sent[0].action, 'allow'); assert.equal(f.forwarded.length, 0);
  f.route({ ...f.request, tool: 'exec' }); assert.equal(f.sent[1].action, 'reject');
  const business = { ...f.request, sessionKey: f.owner.parentSessionKey };
  f.route(business); assert.deepEqual(f.forwarded, [business]);
  const other = { ...f.owner, sessionKey: 'agent:main:runtime-corrector:other', sessionId: 'other',
    parentSessionKey: 'agent:main:other-user' };
  f.router.bind(other); f.route({ ...f.request, sessionKey: other.sessionKey });
  assert.equal(f.forwarded[1].sessionKey, other.parentSessionKey);
  await Promise.resolve(); assert.equal(f.records[0].status, 'AUTO_ALLOWED');
});

test('a guessed, expired, replaced or cross-agent private run cannot acquire an unattended grant', t => {
  const f = fixture(t, { defaultMode: 'unattended' });
  f.route({ ...f.request, runId: 'foreign' }); assert.equal(f.sent[0].action, 'reject');
  f.unbind(); f.route(); assert.equal(f.sent[1].action, 'reject');
  assert.throws(() => f.router.bind({ ...f.owner, parentSessionKey: 'agent:other:chat' }), /OWNER_INVALID/);
  assert.throws(() => f.router.bind({ ...f.owner, deadlineAt: 0 }), /OWNER_EXPIRED/);
  assert.throws(() => f.router.setMode(f.owner.sessionKey, 'unattended'));
  assert.throws(() => approvalMode('monitor'));
});

test('cancellation rejects pending work and a late user confirmation cannot execute it', t => {
  const f = fixture(t); f.route(); const id = f.forwarded[0].id;
  f.controller.abort(); assert.equal(f.sent[0].action, 'reject');
  assert.equal(f.router.response({ id, action: 'allow' }, f.connection), false);
  assert.equal(f.sent.length, 1); assert.equal(f.router.status(f.owner.parentSessionKey).pending.length, 0);
});

test('waiting for a user has a bounded expiry and transport failure never grants work', async t => {
  const f = fixture(t, { confirmationTimeoutMs: 15 }); f.route();
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(f.sent[0].action, 'reject');
  assert.equal(f.router.status(f.owner.parentSessionKey).recent.at(-1).status, 'EXPIRED');
  f.route({ ...f.request, id: 'next' }); f.router.disconnected(f.connection);
  assert.equal(f.sent.at(-1).action, 'reject');
});

test('changing to unattended mode does not silently approve an existing user confirmation', t => {
  const f = fixture(t); f.route(); f.router.setMode(f.owner.parentSessionKey, 'unattended');
  assert.equal(f.sent.length, 0);
  f.router.response({ id: f.forwarded[0].id, action: 'reject' }, f.connection);
  assert.equal(f.sent[0].action, 'reject');
});

test('a failed transport rejects subsequent business confirmations instead of leaving them pending', t => {
  const f = fixture(t), request = { ...f.request, sessionKey: 'agent:main:business' };
  f.router.request(request, { send: value => f.sent.push(value), forward() { throw new Error('Disconnected'); }, connection: {} });
  assert.equal(f.sent[0].id, request.id); assert.equal(f.sent[0].action, 'reject');
});
