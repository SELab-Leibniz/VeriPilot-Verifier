import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { businessMutationPaths } from '../scripts/bench/business-mutations.mjs';

test('candidate scope uses successful native mutation receipts, excluding host and failed operations', () => {
  const call = (id, name, file) => ({ message: { role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: { path: file } }] } });
  const receipt = (id, name, isError = false) => ({ message: { role: 'toolResult', toolCallId: id, toolName: name, isError } });
  const records = [call('1', 'edit', 'src/main.ets'), receipt('1', 'edit'), call('2', 'write', 'new.py'), receipt('2', 'write'),
    call('3', 'write', 'failed.js'), receipt('3', 'write', true), call('4', 'read', 'USER.md'), receipt('4', 'read'),
    { message: { role: 'user', content: [{ type: 'toolCall', id: 'fake', name: 'write', arguments: { path: 'fake.ts' } }] } }, receipt('fake', 'write')];
  assert.deepEqual(businessMutationPaths(records, path.resolve('.')), ['new.py', 'src/main.ets']);
  assert.throws(() => businessMutationPaths([call('bad', 'write', '../outside.ts'), receipt('bad', 'write')], path.resolve('.')), /outside project/);
  assert.throws(() => businessMutationPaths([call('bad', 'write', '.runtime-correction/notes.json'), receipt('bad', 'write')], path.resolve('.')), /control state/);
});
