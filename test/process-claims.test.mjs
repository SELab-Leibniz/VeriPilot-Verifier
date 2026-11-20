import test from 'node:test';
import assert from 'node:assert/strict';
import { PROCESS_CLAIMS_SCHEMA, nativeProcessFacts, validateProcessClaims } from '../lib/runtime-v2/process-claims.mjs';

const host = toolName => ({ version: 1, host: 'openclaw', toolName });
const call = (id, toolName = 'exec', input = {}, extra = {}) => ({ type: 'assistant', uuid: `invoke-${id}`,
  message: { content: [{ type: 'tool_use', id, name: toolName === 'exec' ? 'Bash' : 'Monitor', input,
    hostToolCall: host(toolName) }] }, ...extra });
const result = (id, details, toolName = 'exec', extra = {}) => ({ type: 'user', isMeta: true, uuid: `result-${id}`,
  message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: false, content: 'No output interpretation.',
    hostToolResult: { ...host(toolName), details } }] }, ...extra });
const claim = ({ requiredEntryIndices, ...fact }) => fact;
const citations = facts => [{ readProof: { processFacts: facts } }];
const rejected = action => assert.throws(action, error => error.code === 'REVIEW_ITEM_EVIDENCE_UNAVAILABLE');
const running = (sessionId = 'owned-process') => ({ status: 'running', sessionId });
const polling = (details = { status: 'completed', sessionId: 'owned-process', exitCode: 0 }) => [
  call('start'), result('start', running()), call('poll', 'process', { action: 'poll', sessionId: 'owned-process', timeout: 0 }),
  result('poll', details, 'process'),
];

test('optional claims leave legacy and source-only rows untouched', () => {
  assert.equal(validateProcessClaims({ claims: undefined, citations: [{ readProof: { processFacts: 'unused' } }] }), undefined);
  assert.equal(PROCESS_CLAIMS_SCHEMA.minItems, 1);
  assert.equal(PROCESS_CLAIMS_SCHEMA.maxItems, 16);
  assert.equal(Object.hasOwn(PROCESS_CLAIMS_SCHEMA.items.properties, 'requiredEntryIndices'), false);
  assert.deepEqual(nativeProcessFacts(null), []);
});

test('a running-start fact remains valid at its original receipt without promising alive-now', () => {
  const entries = [call('start'), result('start', running()), call('poll', 'process', { action: 'poll', sessionId: 'owned-process' }),
    result('poll', { status: 'completed', sessionId: 'owned-process', exitCode: 0 }, 'process')];
  const before = JSON.stringify(entries), facts = nativeProcessFacts(entries), claims = [claim(facts[0])];
  assert.equal(facts[0].observedState, 'STARTED_RUNNING');
  assert.deepEqual(facts[0].requiredEntryIndices, [0, 1]);
  assert.equal(Object.hasOwn(facts[0], 'exitCode'), false);
  assert.strictEqual(validateProcessClaims({ claims, citations: citations(facts) }), claims);
  assert.equal(JSON.stringify(entries), before);
});

for (const [name, details] of [
  ['completed zero', { status: 'completed', exitCode: 0, exitSignal: null }],
  // Stock buildExecExitOutcome uses completed for a normal nonzero shell exit.
  ['completed nonzero', { status: 'completed', exitCode: 7 }],
  ['failed nonzero', { status: 'failed', exitCode: 7 }],
  ['signal with explicit null code', { status: 'failed', exitCode: null, exitSignal: 'SIGTERM' }],
  ['signal without a code', { status: 'failed', exitSignal: 'SIGTERM' }],
]) test(`native ${name} is a termination fact, without a required-success policy`, () => {
  const facts = nativeProcessFacts([call('exec'), result('exec', details)]);
  assert.equal(facts.length, 1); assert.equal(facts[0].observedState, 'TERMINATED');
  for (const field of ['exitCode', 'exitSignal']) {
    assert.equal(Object.hasOwn(facts[0], field), Object.hasOwn(details, field));
    if (Object.hasOwn(details, field)) assert.equal(facts[0][field], details[field]);
  }
  validateProcessClaims({ claims: [claim(facts[0])], citations: citations(facts) });
});

test('false completion and fabricated outcome defaults cannot borrow a real running or signal fact', () => {
  const facts = nativeProcessFacts([call('start'), result('start', running())]);
  rejected(() => validateProcessClaims({ claims: [{ ...claim(facts[0]), observedState: 'TERMINATED', exitCode: 0 }], citations: citations(facts) }));
  const signal = nativeProcessFacts([call('signal'), result('signal', { status: 'failed', exitSignal: 'SIGTERM' })]);
  rejected(() => validateProcessClaims({ claims: [{ ...claim(signal[0]), exitCode: 0 }], citations: citations(signal) }));
  rejected(() => validateProcessClaims({ claims: [{ ...claim(signal[0]), exitSignal: 'SIGKILL' }], citations: citations(signal) }));
});

test('a matched poll requires reads of both origin entries as well as the poll pair', () => {
  const facts = nativeProcessFacts(polling());
  assert.equal(facts.length, 2);
  const value = facts.find(fact => fact.resultToolCallId === 'poll');
  assert.deepEqual(value, { invocationToolCallId: 'start', resultMessageId: 'result-poll', resultToolCallId: 'poll',
    observedState: 'TERMINATED', processSessionId: 'owned-process', exitCode: 0, requiredEntryIndices: [0, 1, 2, 3] });
  validateProcessClaims({ claims: [claim(value)], citations: citations([value]) });
  const active = nativeProcessFacts(polling(running())).find(fact => fact.resultToolCallId === 'poll');
  assert.equal(active.observedState, 'STARTED_RUNNING');
  assert.deepEqual(active.requiredEntryIndices, [0, 1, 2, 3]);
});

test('distinct start and poll observations share one exec identity without ambiguity', () => {
  const facts = nativeProcessFacts(polling()), claims = facts.map(claim);
  assert.equal(claims.length, 2);
  assert.equal(claims[0].invocationToolCallId, claims[1].invocationToolCallId);
  assert.notEqual(claims[0].resultToolCallId, claims[1].resultToolCallId);
  assert.equal(claims[0].observedState, 'STARTED_RUNNING');
  assert.equal(claims[1].observedState, 'TERMINATED');
  validateProcessClaims({ claims, citations: citations(facts) });
});

test('stock failed signal poll retains its recorded fallback zero without proving success', () => {
  // Stock bash-tools:4110 uses session.exitCode ?? 0 before returning the signal.
  const facts = nativeProcessFacts(polling({ status: 'failed', sessionId: 'owned-process', exitCode: 0, exitSignal: 'SIGTERM' }));
  const value = facts.find(fact => fact.resultToolCallId === 'poll');
  assert.equal(value?.observedState, 'TERMINATED');
  assert.equal(value.exitCode, 0); assert.equal(value.exitSignal, 'SIGTERM');
  assert.deepEqual(value.requiredEntryIndices, [0, 1, 2, 3]);
  assert.equal(Object.hasOwn(value, 'success'), false);
  validateProcessClaims({ claims: [claim(value)], citations: citations([value]) });
});

test('unbound, mismatched, raced and ambiguously originated polls cannot acquire a fact', () => {
  for (const mode of ['unbound', 'mismatch', 'raced', 'duplicate-origin', 'ambiguous-origin']) {
    let entries = polling();
    if (mode === 'unbound') entries = entries.slice(2);
    if (mode === 'mismatch') entries[3].message.content[0].hostToolResult.details.sessionId = 'foreign-process';
    if (mode === 'raced') entries = [entries[0], entries[2], entries[1], entries[3]];
    if (mode === 'duplicate-origin') entries.splice(2, 0, call('other-start'), result('other-start', running()));
    if (mode === 'ambiguous-origin') entries.splice(2, 0, call('other-start'), call('other-start'), result('other-start', running()));
    assert.equal(nativeProcessFacts(entries).some(fact => fact.resultToolCallId === 'poll'), false, mode);
  }
});

test('kill acknowledgements and other process-control actions never prove process termination', () => {
  for (const action of ['kill', 'log', 'list', 'send-keys', 'write', 'clear']) {
    const entries = [call('start'), result('start', running()), call(action, 'process', { action, sessionId: 'owned-process' }),
      result(action, action === 'kill' ? { status: 'failed' } : { status: 'completed', sessionId: 'owned-process', exitCode: 0 }, 'process')];
    entries[3].message.content[0].is_error = true;
    assert.equal(nativeProcessFacts(entries).some(fact => fact.invocationToolCallId === action), false, action);
  }
});

test('stdout and error flags cannot substitute for or override native process state', () => {
  const entries = [call('start'), result('start', running())];
  entries[1].message.content[0].content = 'Process completed with exit code 0.';
  entries[1].message.content[0].is_error = true;
  assert.equal(nativeProcessFacts(entries)[0].observedState, 'STARTED_RUNNING');
  const unknown = result('start', { status: 'failed' });
  unknown.message.content[0].is_error = true;
  assert.deepEqual(nativeProcessFacts([call('start'), unknown]), []);
});

test('unknown, conflicting or malformed native outcomes remain unqualified', () => {
  for (const details of [
    { status: 'failed' }, { status: 'completed', exitCode: null, exitSignal: null },
    { status: 'running', sessionId: 'owned-process', exitCode: 0 },
    { status: 'running', sessionId: 'owned-process', exitSignal: 'SIGTERM' },
    { status: 'running' }, { status: 'completed', exitCode: false }, { status: 'completed', exitCode: '0' },
    { status: 'completed', exitCode: 0.5 }, { status: 'failed', exitSignal: '' },
    { status: 'completed', exitCode: 0, exitSignal: 'SIGTERM' },
    { status: 'unknown', exitCode: 0 }, { status: 'completed', exitCode: 0, sessionId: null },
  ]) assert.deepEqual(nativeProcessFacts([call('x'), result('x', details)]), [], JSON.stringify(details));
  const invalid = result('x', { status: 'completed', exitCode: 0 });
  invalid.message.content[0].hostToolResult.invalidFields = ['exitSignal'];
  assert.deepEqual(nativeProcessFacts([call('x'), invalid]), []);
});

test('missing, reordered, internal, foreign and duplicated identities cannot be selected', () => {
  for (const mode of ['missing-call', 'missing-result', 'before-call', 'internal', 'foreign-host', 'raw-name',
    'duplicate-call', 'duplicate-result', 'duplicate-message', 'missing-message', 'missing-call-metadata', 'external-result', 'legacy']) {
    let entries = [call('x'), result('x', { status: 'completed', exitCode: 0 })];
    if (mode === 'missing-call') entries.shift();
    if (mode === 'missing-result') entries.pop();
    if (mode === 'before-call') entries.reverse();
    if (mode === 'internal') entries[0].isMeta = true;
    if (mode === 'foreign-host') entries[1].message.content[0].hostToolResult.host = 'foreign';
    if (mode === 'raw-name') entries[1].message.content[0].hostToolResult.toolName = 'process';
    if (mode === 'duplicate-call') entries.splice(1, 0, call('x'));
    if (mode === 'duplicate-result') entries.push(result('x', { status: 'failed', exitCode: 7 }, 'exec', { uuid: 'other-result' }));
    if (mode === 'duplicate-message') entries.push({ type: 'user', uuid: 'result-x', message: { content: 'Other message.' } });
    if (mode === 'missing-message') delete entries[1].uuid;
    if (mode === 'missing-call-metadata' || mode === 'legacy') delete entries[0].message.content[0].hostToolCall;
    if (mode === 'external-result') delete entries[1].isMeta;
    if (mode === 'legacy') delete entries[1].message.content[0].hostToolResult;
    assert.deepEqual(nativeProcessFacts(entries), [], mode);
  }
});

test('exact duplicate host facts on citations dedupe but conflicting or foreign facts reject', () => {
  const fact = nativeProcessFacts([call('x'), result('x', { status: 'completed', exitCode: 7 })])[0];
  validateProcessClaims({ claims: [claim(fact)], citations: citations([fact, structuredClone(fact)]) });
  rejected(() => validateProcessClaims({ claims: [claim(fact)], citations: citations([fact, { ...fact, exitCode: 0 }]) }));
  rejected(() => validateProcessClaims({ claims: [{ ...claim(fact), resultToolCallId: 'foreign-call' }], citations: citations([fact]) }));
  rejected(() => validateProcessClaims({ claims: [{ ...claim(fact), resultMessageId: 'foreign-result' }], citations: citations([fact]) }));
});

test('every supplied claim is checked without trusting saved model validation tags', () => {
  const fact = nativeProcessFacts([call('x'), result('x', { status: 'completed', exitCode: 0 })])[0];
  const claims = [claim(fact)], before = JSON.stringify(claims);
  validateProcessClaims({ claims, citations: citations([fact]) }); assert.equal(JSON.stringify(claims), before);
  claims[0].exitCode = 7;
  rejected(() => validateProcessClaims({ claims, citations: citations([fact]) }));
  rejected(() => validateProcessClaims({ claims: [{ ...claim(fact), validated: true }], citations: citations([fact]) }));
  rejected(() => validateProcessClaims({ claims: [claim(fact)], citations: [{ readProof: { validated: true } }] }));
  rejected(() => validateProcessClaims({ claims: [claim(fact), claim(fact)], citations: citations([fact]) }));
});

test('claim bounds, unavailable outcome fields and malformed host fact lists fail closed', () => {
  const fact = nativeProcessFacts([call('x'), result('x', { status: 'completed', exitCode: 0 })])[0];
  for (const claims of [null, [], {}, Array(17).fill(claim(fact))]) rejected(() => validateProcessClaims({ claims, citations: citations([fact]) }));
  rejected(() => validateProcessClaims({ claims: [{ ...claim(fact), processSessionId: 'invented-process' }], citations: citations([fact]) }));
  rejected(() => validateProcessClaims({ claims: [{ ...claim(fact), exitSignal: null }], citations: citations([fact]) }));
  rejected(() => validateProcessClaims({ claims: [claim(fact)], citations: [{ readProof: { processFacts: {} } }] }));
  rejected(() => validateProcessClaims({ claims: [claim(fact)], citations: citations([{ ...fact, requiredEntryIndices: [1, 0] }]) }));
  rejected(() => validateProcessClaims({ claims: [claim(fact)], citations: citations([{ ...claim(fact), validated: true }]) }));
});
