import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMessages } from '../lib/openclaw/transcript.mjs';

const result = details => normalizeMessages([{ id: 'result', message: {
  role: 'toolResult', toolCallId: 'command', toolName: 'exec', details,
  content: [{ type: 'text', text: 'Process exited with code 0.' }],
} }])[0].message.content[0].hostToolResult;

test('malformed native metadata remains explicitly unavailable without copying nested payloads', () => {
  const details = { status: { text: 'completed' }, sessionId: ['foreign'], exitCode: NaN,
    exitSignal: { name: 'SIGTERM' }, unrelated: { private: 'not process metadata' } };
  const value = result(details);
  assert.deepEqual(value.details, {});
  assert.deepEqual(value.invalidFields, ['status', 'sessionId', 'exitCode', 'exitSignal']);
  assert.equal(JSON.stringify(value).includes('private'), false);
  assert.deepEqual(result([]).invalidFields, ['details']);
  assert.deepEqual(result('completed').invalidFields, ['details']);
});

test('wrong primitive types and null are retained exactly for later factual validation', () => {
  const value = result({ status: false, sessionId: 7, exitCode: true, exitSignal: null });
  assert.deepEqual(value.details, { status: false, sessionId: 7, exitCode: true, exitSignal: null });
  assert.equal(value.invalidFields, undefined);
  assert.equal(result(undefined).details.exitCode, undefined);
});

test('native invocation names survive alias normalization without changing the requested action', () => {
  const records = ['exec', 'apply_patch'].map((name, i) => ({ id: `message-${i}`, message: {
    role: 'assistant', content: [{ type: 'toolCall', id: `call-${i}`, name, arguments: { command: 'unchanged' } }],
  } }));
  const before = JSON.stringify(records);
  const calls = normalizeMessages(records).map(entry => entry.message.content[0]);
  assert.deepEqual(calls.map(call => call.name), ['Bash', 'Bash']);
  assert.deepEqual(calls.map(call => call.hostToolCall.toolName), ['exec', 'apply_patch']);
  assert.deepEqual(calls.map(call => call.input), [{ command: 'unchanged' }, { command: 'unchanged' }]);
  assert.equal(JSON.stringify(records), before);
});
