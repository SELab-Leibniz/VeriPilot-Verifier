import test from 'node:test';
import assert from 'node:assert/strict';
import { awaitHarborGatewaySettlement, harborGatewayErrorDiagnostic } from '../scripts/bench/harbor-gateway-controller.mjs';
import { harborGatewayFailureDetails } from '../scripts/bench/harbor-gateway-runner.mjs';
const identity = { id: 'record', agentId: 'main', sessionId: 'session', sessionKey: 'agent:main:trial', scopeFingerprint: 'scope', projectRoot: '/work' };
const idle = { ...identity, version: 4, phase: 'IDLE', reviewStatus: 'PASS', completedRuns: ['original', 'repair'], runId: 'repair', pending: [], dispatching: null };
const options = { originalRunId: 'original', ...identity, rcEnabled: true };
const transportTimeout = () => Object.assign(new Error('private connection details must not be retained'), {
  name: 'GatewayTransportError', kind: 'timeout', timeoutMs: 2000,
  connectionDetails: { message: 'fictional secret connection text' } });

test('RC-off awaits only its exact original host terminal without accessing RC state', async () => {
  let reads = 0;
  const result = await awaitHarborGatewaySettlement({ ...options, rcEnabled: false, deadlineAt: Date.now() + 1000,
    request: async (method, params) => { assert.equal(method, 'agent.wait'); return { runId: params.runId, status: 'ok' }; },
    readPersistentDispatch: () => { reads++; } });
  assert.equal(result.complete, true); assert.equal(reads, 0); assert.equal(result.mode, 'rc-off');
});

test('RC-on retries mismatched snapshots and verifies the real corrective terminal before stable IDLE', async () => {
  let current = 0, stateReads = 0; const waited = [], observations = [];
  const result = await awaitHarborGatewaySettlement({ ...options, deadlineAt: 1000, now: () => current, pause: async ms => { current += ms; },
    request: async (method, params) => {
      if (method === 'agent.wait') { waited.push(params.runId); return { runId: params.runId, status: 'ok' }; }
      if (method.endsWith('.list')) return { items: [idle] };
      return { ...idle };
    }, readPersistentDispatch: async () => ({ ...idle, version: ++stateReads === 1 ? 3 : 4 }),
    onObservation: value => observations.push(value) });
  assert.equal(result.complete, true); assert.deepEqual(waited, ['original', 'repair']);
  assert(observations.some(row => row.inconsistentSnapshot)); assert.equal(result.dispatch.version, 4);
  assert.equal(result.semanticAccepted, null);
});

test('a status change with unchanged version cannot mix public PASS and durable DEVIATION into completion', async () => {
  let current = 0, reads = 0;
  const result = await awaitHarborGatewaySettlement({ ...options, deadlineAt: 1000, now: () => current, pause: async ms => { current += ms; },
    request: async (method, params) => method === 'agent.wait' ? { runId: params.runId, status: 'ok' }
      : method.endsWith('.list') ? { items: [idle] } : { ...idle },
    readPersistentDispatch: async () => ({ ...idle, reviewStatus: ++reads === 1 ? 'DEVIATION' : 'PASS' }) });
  assert.equal(result.complete, true); assert(reads >= 3);
});

test('deadline cancels the exact owned correction and waits for its actual terminal without resetting task time', async () => {
  let current = 0, cancelled = false; const aborted = [], waited = [];
  const correcting = { ...idle, phase: 'CORRECTING', completedRuns: ['original'], correctionRunId: 'repair' };
  await assert.rejects(awaitHarborGatewaySettlement({ ...options, deadlineAt: 5, cleanupMs: 100, now: () => current, pause: async ms => { current += ms; },
    request: async (method, params) => {
      if (method === 'chat.abort') { aborted.push(params); cancelled = true; return { ok: true }; }
      if (method === 'agent.wait') {
        waited.push(params.runId);
        if (params.runId === 'original') return { runId: 'original', status: 'ok' };
        if (cancelled) return { runId: 'repair', status: 'error' };
        current = 5; return { runId: 'repair', status: 'timeout' };
      }
      return method.endsWith('.list') ? { items: [correcting] } : correcting;
    }, readPersistentDispatch: async () => correcting }), error => {
    assert.equal(error.code, 'HARBOR_TASK_WALL_LIMIT'); assert.equal(error.cleanup.complete, true);
    assert.deepEqual(error.cleanup.cancelledExactRunIds, ['repair']);
    assert.deepEqual(aborted, [{ sessionKey: identity.sessionKey, runId: 'repair' }]);
    assert.equal(waited.at(-1), 'repair'); assert.equal(current, 105); return true;
  });
});

test('foreign terminal receipt never certifies completion and unconfirmed cancellation remains explicit', async () => {
  let current = 0;
  await assert.rejects(awaitHarborGatewaySettlement({ ...options, deadlineAt: 1000, cleanupMs: 1, now: () => current,
    pause: async ms => { current += ms; }, request: async method => method === 'agent.wait' ? { runId: 'foreign', status: 'ok' } : {},
    readPersistentDispatch: async () => idle }), error => {
    assert.equal(error.code, 'HARBOR_TERMINAL_IDENTITY_MISMATCH'); assert.equal(error.cleanup.complete, false);
    assert.deepEqual(error.cleanup.unconfirmed, ['original']); return true;
  });
});

test('typed agent.wait observation timeouts retry the same run until an authentic terminal in both arms', async t => {
  for (const rcEnabled of [false, true]) await t.test(String(rcEnabled), async () => {
    let current = 0, waits = 0; const methods = [], seen = [], observations = [];
    const state = { ...idle, completedRuns: ['original'], runId: 'original' };
    const result = await awaitHarborGatewaySettlement({ ...options, rcEnabled, deadlineAt: 10000,
      now: () => current, pause: async ms => { current += ms; }, onObservation: value => observations.push(value),
      request: async (method, params) => {
        methods.push(method);
        if (method === 'agent.wait') {
          seen.push(params.runId);
          if (++waits <= 2) throw transportTimeout();
          return { runId: params.runId, status: 'ok', stopReason: 'stop' };
        }
        return method.endsWith('.list') ? { items: [state] } : state;
      }, readPersistentDispatch: async () => state });
    assert.equal(result.complete, true);
    assert.deepEqual(seen, ['original', 'original', 'original']);
    assert(!methods.includes('chat.abort')); assert(!methods.includes('agent'));
    const retry = observations.filter(x => x.waitTransportTimeout);
    assert.equal(retry.length, 2);
    assert.deepEqual(retry[0], { waitTransportTimeout: true, runId: 'original',
      diagnostic: { name: 'GatewayTransportError', kind: 'timeout', timeoutMs: 2000 } });
  });
});

test('repeated typed observation timeouts stop at the original deadline and only clean up the owned run', async () => {
  let current = 0, cancelled = false; const waits = [], observations = [];
  await assert.rejects(awaitHarborGatewaySettlement({ ...options, rcEnabled: false, deadlineAt: 100, cleanupMs: 10,
    now: () => current, pause: async ms => { current += ms; }, onObservation: x => observations.push(x),
    request: async (method, params, limits) => {
      if (method === 'chat.abort') { cancelled = true; assert.equal(current, 100); assert.equal(params.runId, 'original'); return {}; }
      assert.equal(method, 'agent.wait'); assert.equal(params.runId, 'original');
      waits.push({ at: current, ...limits });
      if (cancelled) return { runId: 'original', status: 'error', stopReason: 'rpc', error: 'private model text' };
      assert(limits.timeoutMs <= 100 - current);
      throw transportTimeout();
    } }), error => {
    assert.equal(error.code, 'HARBOR_TASK_WALL_LIMIT');
    assert.equal(error.cleanup.complete, true);
    assert.deepEqual(error.cleanup.cancelledExactRunIds, ['original']);
    assert.equal(current, 100);
    assert.equal(JSON.stringify(harborGatewayFailureDetails(error)).includes('private model text'), false);
    return true;
  });
  assert.equal(observations.length, 2);
  assert.deepEqual(waits.map(x => x.at), [0, 50, 100]);
});

test('caller cancellation during a typed observation timeout is preserved instead of retried', async () => {
  const signal = new AbortController(), reason = new Error('private cancellation reason');
  const methods = [];
  await assert.rejects(awaitHarborGatewaySettlement({ ...options, signal: signal.signal, deadlineAt: 10000,
    now: () => 0, request: async (method, params) => {
      methods.push(method);
      if (method === 'chat.abort') return {};
      if (methods.length === 1) { signal.abort(reason); throw transportTimeout(); }
      return { runId: params.runId, status: 'error', stopReason: 'rpc' };
    } }), error => {
    assert.equal(error, reason); assert.equal(error.cleanup.complete, true);
    assert(!JSON.stringify(harborGatewayFailureDetails(error)).includes(reason.message));
    return true;
  });
  assert.deepEqual(methods, ['agent.wait', 'chat.abort', 'agent.wait']);
});

test('non-timeout and untyped timeout errors are not swallowed or mistaken for task progress', async t => {
  const cases = [Object.assign(new Error('private closed text'), { name: 'GatewayTransportError', kind: 'closed', code: 1006 }),
    Object.assign(new Error('private untyped text'), { kind: 'timeout', timeoutMs: 2000 }),
    Object.assign(new Error('private timer text'), { name: 'TimeoutError' })];
  for (const failure of cases) await t.test(failure.name + (failure.kind ?? ''), async () => {
    const methods = [];
    await assert.rejects(awaitHarborGatewaySettlement({ ...options, deadlineAt: 10000, now: () => 0,
      request: async (method, params) => {
        methods.push(method);
        if (method === 'chat.abort') return {};
        if (methods.length === 1) throw failure;
        return { runId: params.runId, status: 'error', stopReason: 'rpc', error: 'private terminal text' };
      } }), error => {
      assert.equal(error, failure); assert.equal(error.cleanup.complete, true);
      assert.equal(JSON.stringify(harborGatewayFailureDetails(error)).includes('private'), false);
      return true;
    });
    assert.deepEqual(methods, ['agent.wait', 'chat.abort', 'agent.wait']);
  });
});

test('typed timeouts from a different RPC remain failures, never observation retries', async () => {
  const failure = transportTimeout(), methods = [];
  await assert.rejects(awaitHarborGatewaySettlement({ ...options, deadlineAt: 10000, now: () => 0,
    readPersistentDispatch: async () => idle,
    request: async (method, params) => {
      methods.push(method);
      if (method === 'agent.wait') return { runId: params.runId, status: 'ok' };
      throw failure;
    } }), error => error === failure && error.cleanup.complete);
  assert.deepEqual(methods, ['agent.wait', 'runtime-corrector.dispatch.list']);
});

test('a corrective wait timeout cannot certify stable IDLE before that exact corrective terminal', async () => {
  let current = 0, repairWaits = 0; const runIds = [], methods = [];
  const result = await awaitHarborGatewaySettlement({ ...options, deadlineAt: 10000,
    now: () => current, pause: async ms => { current += ms; }, readPersistentDispatch: async () => idle,
    request: async (method, params) => {
      methods.push(method);
      if (method === 'agent.wait') {
        runIds.push(params.runId);
        if (params.runId === 'repair' && ++repairWaits === 1) throw transportTimeout();
        return { runId: params.runId, status: 'ok' };
      }
      return method.endsWith('.list') ? { items: [idle] } : idle;
    } });
  assert.equal(result.complete, true);
  assert.deepEqual(runIds, ['original', 'repair', 'repair']);
  assert.equal(result.terminals.find(x => x.runId === 'repair').status, 'ok');
  assert(!methods.includes('agent') && !methods.includes('chat.abort'));
});

test('a foreign terminal after a typed wait timeout still fails identity validation', async () => {
  let current = 0, attempts = 0;
  await assert.rejects(awaitHarborGatewaySettlement({ ...options, deadlineAt: 10000, cleanupMs: 1,
    now: () => current, pause: async ms => { current += ms; }, request: async method => {
      if (method === 'agent.wait') {
        if (++attempts === 1) throw transportTimeout();
        return { runId: 'foreign', status: 'ok' };
      }
      return {};
    } }), error => error.code === 'HARBOR_TERMINAL_IDENTITY_MISMATCH' && !error.cleanup.complete);
});

test('cleanup failures preserve the primary failure plus controlled cancel/read diagnostics', async () => {
  const primary = Object.assign(new Error('private original error'), { code: 'HARBOR_BUSINESS_RUN_FAILED' });
  const closed = Object.assign(new Error('private socket error'), { name: 'GatewayTransportError', kind: 'closed', code: 1006 });
  let current = 0, calls = 0;
  await assert.rejects(awaitHarborGatewaySettlement({ ...options, deadlineAt: 10000, cleanupMs: 5,
    now: () => current, pause: async ms => { current += ms; }, request: async method => {
      if (++calls === 1) throw primary;
      if (method === 'chat.abort') throw closed;
      throw transportTimeout();
    } }), error => {
    assert.equal(error, primary); assert.equal(error.cleanup.complete, false);
    assert.deepEqual(error.cleanup.unconfirmed, ['original']);
    assert.deepEqual(error.cleanup.errors.map(x => x.diagnostic), [
      { name: 'GatewayTransportError', kind: 'closed', code: 1006 },
      { name: 'GatewayTransportError', kind: 'timeout', timeoutMs: 2000 }]);
    const saved = harborGatewayFailureDetails(error);
    assert.equal(saved.code, 'HARBOR_BUSINESS_RUN_FAILED');
    assert.deepEqual(saved.diagnostic, { name: 'Error', code: 'HARBOR_BUSINESS_RUN_FAILED' });
    assert(!JSON.stringify(saved).includes('private'));
    return true;
  });
});

test('error diagnostics discard arbitrary message, cause, connection and malformed diagnostic fields', () => {
  const error = Object.assign(new Error('private provider message'), { name: 'private provider name', kind: 'private kind',
    timeoutMs: Infinity, code: 'private code', cause: new Error('private cause'), connectionDetails: { token: 'private token' } });
  assert.deepEqual(harborGatewayErrorDiagnostic(error), { name: 'OtherError' });
  assert.deepEqual(harborGatewayFailureDetails(error), { code: 'HARBOR_GATEWAY_FAILED', diagnostic: { name: 'OtherError' }, cleanup: null });
});
