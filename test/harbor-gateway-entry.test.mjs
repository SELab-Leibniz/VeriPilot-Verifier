import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { dispatchHarborOriginalAgent, harborInstructionIdentity } from '../scripts/bench/harbor-gateway-runner.mjs';
import { awaitHarborGatewaySettlement } from '../scripts/bench/harbor-gateway-controller.mjs';

const original = { instruction: '  Fictional original user task.\r\n', runId: 'original', sessionId: 'session',
  sessionKey: 'agent:main:trial', deadlineAt: 10999, now: () => 1000 };
const accepted = { runId: original.runId, sessionKey: original.sessionKey, status: 'accepted' };

test('standard agent ingress retains raw user/session identity and spends only remaining integer seconds', async () => {
  const calls = [];
  const result = await dispatchHarborOriginalAgent({ ...original,
    request: async (...args) => { calls.push(args); return accepted; } });
  assert.equal(result, accepted);
  assert.deepEqual(calls, [['agent', { sessionId: 'session', sessionKey: 'agent:main:trial', agentId: 'main',
    message: original.instruction, idempotencyKey: 'original', deliver: false, thinking: 'off', timeout: 9 },
  { timeoutMs: 9999 }]]);
  assert.equal('inputProvenance' in calls[0][1], false);
  assert.equal('modelRun' in calls[0][1], false);
  assert.equal('suppressPromptPersistence' in calls[0][1], false);
});

test('raw and host-effective identities distinguish standard trim without rewriting the task', () => {
  const identity = harborInstructionIdentity(original.instruction);
  const sha = value => createHash('sha256').update(value).digest('hex');
  assert.equal(identity.rawSha256, sha(original.instruction));
  assert.equal(identity.hostEffectiveSha256, sha('Fictional original user task.'));
  assert.notEqual(identity.rawSha256, identity.hostEffectiveSha256);
  assert.equal(identity.rawBytes, Buffer.byteLength(original.instruction));
  assert.equal(identity.hostEffectiveBytes, Buffer.byteLength(original.instruction.trim()));
  assert.equal(identity.hostInputByteIdentical, false);
  assert.equal(harborInstructionIdentity('Fictional task.').hostInputByteIdentical, true);
  for (const value of ['', ' \r\n', null]) assert.throws(() => harborInstructionIdentity(value), /ORIGINAL_INSTRUCTION_REQUIRED/u);
});

test('an expired or subsecond remainder cannot dispatch or select the no-timeout sentinel', async () => {
  let calls = 0;
  const request = async () => { calls++; return accepted; };
  for (const deadlineAt of [999, 1000, 1999, Number.NaN])
    await assert.rejects(dispatchHarborOriginalAgent({ ...original, deadlineAt, request }),
      error => error.code === 'HARBOR_TASK_WALL_LIMIT');
  assert.equal(calls, 0);
  await dispatchHarborOriginalAgent({ ...original, deadlineAt: 2000,
    request: async (method, params) => { assert.equal(params.timeout, 1); return accepted; } });
});

test('wrong accepted identity and dispatch failure are not retried under a new run', async () => {
  let calls = 0;
  for (const receipt of [{ ...accepted, runId: 'foreign' }, { ...accepted, sessionKey: 'foreign' }])
    await assert.rejects(dispatchHarborOriginalAgent({ ...original,
      request: async () => { calls++; return receipt; } }), /ORIGINAL_RUN_ID_MISMATCH/u);
  const failure = new Error('fictional transport failure');
  await assert.rejects(dispatchHarborOriginalAgent({ ...original,
    request: async () => { calls++; throw failure; } }), error => error === failure);
  assert.equal(calls, 3);
});

test('agent acceptance is followed by authentic wait receipts; timeout observation does not resubmit the user task', async () => {
  let current = 0, waits = 0;
  const methods = [];
  const request = async (method, params) => {
    methods.push(method);
    if (method === 'agent') return accepted;
    assert.equal(method, 'agent.wait'); assert.equal(params.runId, original.runId);
    return { runId: original.runId, status: ++waits === 1 ? 'timeout' : 'ok' };
  };
  const admission = await dispatchHarborOriginalAgent({ ...original, request });
  assert.equal(admission.status, 'accepted'); assert.equal(admission.complete, undefined);
  const result = await awaitHarborGatewaySettlement({ ...original, originalRunId: original.runId, rcEnabled: false, request,
    now: () => current, pause: async ms => { current += ms; } });
  assert.equal(result.complete, true);
  assert.deepEqual(methods, ['agent', 'agent.wait', 'agent.wait']);
});

test('an authentic original error remains failure even after accepted headless dispatch', async () => {
  const methods = [];
  const request = async (method, params) => {
    methods.push(method);
    if (method === 'agent') return accepted;
    assert.equal(method, 'agent.wait');
    return { runId: params.runId, status: 'error', livenessState: 'abandoned', error: 'fictional incomplete turn' };
  };
  await dispatchHarborOriginalAgent({ ...original, request });
  await assert.rejects(awaitHarborGatewaySettlement({ ...original, originalRunId: original.runId, rcEnabled: false, request }), error => {
    assert.equal(error.code, 'HARBOR_BUSINESS_RUN_FAILED');
    assert.equal(error.cleanup.complete, true);
    assert.equal(error.cleanup.terminals[0].status, 'error');
    return true;
  });
  assert.deepEqual(methods, ['agent', 'agent.wait']);
});
