import assert from 'node:assert/strict';
import test from 'node:test';
import { createOriginalSourceAnchor } from '../lib/runtime-v2/original-source-anchor.mjs';
import { sha256 } from '../lib/runtime-v2/utils.mjs';

const source = (text, ref = 'transcript:message-1') => {
  const bytes = Buffer.from(text);
  return { bytes, ref, sha256: sha256(bytes) };
};

test('original anchors use exact UTF-8 byte offsets and retain CR before LF', () => {
  const prefix = 'préface\r\n';
  const selected = '保留主题🧪\r';
  const input = source(`${prefix}${selected}\nVerify.\r\n`);
  const anchor = createOriginalSourceAnchor({ ...input, start: 2, end: 2 });
  const byteStart = Buffer.byteLength(prefix);
  const byteEnd = byteStart + Buffer.byteLength(selected);
  assert.match(anchor.anchorId, /^original-source-[a-f0-9]{64}$/u);
  assert.deepEqual(anchor, { anchorId: anchor.anchorId, kind: 'USER_MESSAGE',
    ref: input.ref, sha256: input.sha256, byteStart, byteEnd });
  assert.equal(input.bytes.subarray(byteStart, byteEnd).toString('utf8'), selected);
});

test('whole and paged reads of the same source bytes produce one anchor', () => {
  const prefix = 'α heading\r\n';
  const body = 'First duty.\r\n第二项。\r\n';
  const input = source(`${prefix}${body}Final context.\n`);
  const whole = createOriginalSourceAnchor({ ...input, start: 2, end: 3 });
  const part = createOriginalSourceAnchor({ ...input, bytes: Buffer.from(body), byteOffset: Buffer.byteLength(prefix), start: 1, end: 2 });
  assert.deepEqual(part, whole);
  assert.notEqual(sha256(Buffer.from(body)), part.sha256);
  const firstSegment = createOriginalSourceAnchor({ ...input, bytes: Buffer.from(prefix), start: 1, end: 1 });
  assert.deepEqual(firstSegment, createOriginalSourceAnchor({ ...input, start: 1, end: 1 }));
});

test('identical occurrences and distinct message references have different anchors', () => {
  const input = source('Keep this.\nKeep this.\n');
  const first = createOriginalSourceAnchor({ ...input, start: 1, end: 1 });
  const second = createOriginalSourceAnchor({ ...input, start: 2, end: 2 });
  assert.notEqual(first.anchorId, second.anchorId);
  assert.deepEqual(input.bytes.subarray(first.byteStart, first.byteEnd), input.bytes.subarray(second.byteStart, second.byteEnd));
  const anotherMessage = createOriginalSourceAnchor({ ...input, ref: 'transcript:message-2', start: 1, end: 1 });
  assert.notEqual(first.anchorId, anotherMessage.anchorId);
});

test('a source revision changes the anchor even if the selected bytes stay fixed', () => {
  const input = source('Keep this.\nContext.\n');
  const changed = source('Keep this.\nChanged context.\n');
  const oldAnchor = createOriginalSourceAnchor({ ...input, start: 1, end: 1 });
  const newAnchor = createOriginalSourceAnchor({ ...changed, start: 1, end: 1 });
  assert.equal(newAnchor.byteStart, oldAnchor.byteStart);
  assert.equal(newAnchor.byteEnd, oldAnchor.byteEnd);
  assert.notEqual(newAnchor.anchorId, oldAnchor.anchorId);
  assert.deepEqual(createOriginalSourceAnchor({ ...input, sha256: input.sha256.toUpperCase(), start: 1, end: 1 }), oldAnchor);
});

test('invalid or empty source intervals cannot create anchors', () => {
  const input = { ...source('One duty.\n \t\r\n'), start: 1, end: 1 };
  for (const params of [
    { ref: '' }, { ref: '  ' }, { ref: 1 }, { sha256: 'a'.repeat(63) }, { sha256: 'q'.repeat(64) },
    { bytes: 'not a byte buffer' }, { bytes: Buffer.alloc(0) }, { bytes: Buffer.from([0xc0, 0xae]) },
    { start: 0 }, { start: 1.5 }, { start: 2, end: 1 }, { end: 4 }, { end: '1' }, { end: Infinity },
    { start: 2, end: 2 }, { start: 3, end: 3 },
    { byteOffset: -1 }, { byteOffset: 0.5 }, { byteOffset: Number.MAX_SAFE_INTEGER },
  ]) {
    assert.throws(() => createOriginalSourceAnchor({ ...input, ...params }), undefined, JSON.stringify(params));
  }
});
