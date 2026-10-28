import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { shortArktsWorkspace } from '../scripts/bench/short-workspace.mjs';

test('descriptive long experiment names do not lengthen native workspaces or bias the two arms', () => {
  const first = shortArktsWorkspace(path.join('results', 'long-experiment-name'.repeat(30), 'baseline'), 'biz');
  const second = shortArktsWorkspace(path.join('results', 'long-experiment-name'.repeat(30), 'candidate'), 'biz');
  assert.equal(first.length, second.length); assert.notEqual(first, second);
  assert.equal(first, shortArktsWorkspace(path.join('results', 'long-experiment-name'.repeat(30), 'baseline'), 'biz'));
  assert(first.startsWith(path.resolve('.runtime-correction/b') + path.sep));
  if (process.platform === 'win32') assert(path.join(first, 'entry/.test/default/cache/default/default@UnitTestArkTS/esmodule/debug/filesInfo.txt').length < 240);
  assert.throws(() => shortArktsWorkspace('results', '../outside'), /kind/);
});
