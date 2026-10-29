import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { processOrderCases } from '../scripts/helpers/process-order-fixtures.mjs';

test('controlled process fixtures preserve actual read/write order, contents and whole-file scope', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-process-order-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const finals = [];
  for (const fixture of processOrderCases) {
    const file = path.join(root, fixture.id + '.mjs');
    const entries = await fixture.prepare({ file });
    const calls = entries.filter(row => row.type === 'assistant').map(row => row.message.content[0]);
    const results = new Map(entries.filter(row => row.type === 'user').map(row => [row.message.content[0].tool_use_id, row.message.content[0].content]));
    assert.equal(calls.length, 2);
    assert.deepEqual(new Set(calls.map(call => call.name)), new Set(['Read', 'Write']));
    for (const call of calls) assert(results.has(call.id));
    const read = calls.find(call => call.name === 'Read');
    const readText = results.get(read.id);
    if (fixture.id === 'business-read-before-write') {
      assert.equal(calls[0].name, 'Read');
      assert.match(readText, /value \+ 0/u);
    } else {
      assert.equal(calls[0].name, 'Write');
      assert.match(readText, /value \+ 1/u);
    }
    assert.equal(/\p{Script=Han}/u.test(readText), fixture.id !== 'business-partial-read-after-write');
    if (fixture.id === 'business-partial-read-after-write') {
      assert.equal(read.input.limit, 3);
      assert.equal(readText.split('\n').length, 3);
      assert(readText.split('\n').length < fixture.code.split('\n').length);
      assert.equal(fixture.expected, 'DEVIATION', 'An observed truncated read-back is concrete wrong-scope execution.');
    }
    assert.equal(fixture.expected === 'PASS', fixture.id === 'business-full-read-after-write');
    finals.push(await fs.readFile(file, 'utf8'));
  }
  assert.equal(new Set(finals).size, 1, 'Current source is identical; only actual actor/event/scope evidence differs.');
  assert.match(finals[0], /\p{Script=Han}/u);
});
