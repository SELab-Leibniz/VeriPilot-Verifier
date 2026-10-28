import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedLinePage } from '../lib/line-page.mjs';
import { sourcePage } from '../lib/review-task/source-tools.mjs';
import { disclosedRange } from '../lib/review-task/evidence-utils.mjs';
test('UTF-8 byte budgets preserve exact line boundaries, CRLF and trailing empty lines', () => {
  const lines = ['甲😀\r', 'β', ''];
  const budget = Buffer.byteLength(lines.slice(0, 2).join('\n'));
  const page = boundedLinePage(lines, { start: 1, count: 3, byteLimit: budget, separatorBytes: 1 });
  assert.deepEqual(page.lines, lines.slice(0, 2)); assert.equal(page.next, 3);
  const last = boundedLinePage(lines, { start: 3, count: 1, byteLimit: 1 });
  assert.deepEqual(last.lines, ['']); assert.equal(last.next, null);
});
test('numbered documents and unnumbered original evidence keep distinct byte accounting', () => {
  const lines = ['abc', 'def'];
  assert.deepEqual(boundedLinePage(lines, { start: 1, count: 2, byteLimit: 6 }).lines, lines);
  assert.deepEqual(boundedLinePage(lines, { start: 1, count: 2, byteLimit: 6, separatorBytes: 1 }).lines, ['abc']);
  assert.deepEqual(boundedLinePage(lines, { start: 1, count: 2, byteLimit: 6, render: (line, n) => `${n}: ${line}` }).lines, ['1: abc']);
  assert.throws(() => sourcePage(Buffer.from('x'.repeat(51201))), /First line/);
  assert.throws(() => sourcePage(Buffer.from([0xff])), /UTF-8/);
  assert.throws(() => sourcePage(Buffer.from('one\ntwo'), { offset: 3 }), /2 lines.*Offset is part-local/);
});

test('optional numbered source pages preserve original coverage and reject forged display receipts', () => {
  const bytes = Buffer.from('甲😀\r\nβ\n'), args = { offset: 2, limit: 2, numbered: true };
  const page = sourcePage(bytes, args);
  assert.match(page.content.map(block => block.text).join(''), /^\[2\] β\n\[3\] \n/u);
  assert.deepEqual(disclosedRange(bytes, args, page), { start: 2, end: 3 });
  assert.equal(disclosedRange(bytes, { offset: 2, limit: 2 }, page), null, 'a display flag cannot be forged after reading');
  const forged = structuredClone(page); forged.content[0].text = forged.content[0].text.replace('β', 'invented');
  assert.equal(disclosedRange(bytes, args, forged), null);
  const dense = Buffer.from('x'.repeat(51198));
  assert.equal(sourcePage(dense).details.page.end, 1);
  assert.throws(() => sourcePage(dense, { numbered: true }), /First line/, 'display prefixes count against the page budget');
});
