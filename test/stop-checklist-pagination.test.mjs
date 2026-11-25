import test from 'node:test';
import assert from 'node:assert/strict';
import { createChecklistTransport, CHECKLIST_RESPONSE_MAX_BYTES } from '../lib/runtime-v2/stop-workspace-review.mjs';

const bytes = value => Buffer.byteLength(JSON.stringify(value));
function fixture() {
  const state = { owner: 'generic-owner', scope: 'TASK_COMPLETE', source: 'source-a', revision: 0, cancelled: false };
  let checks = 0;
  const transport = createChecklistTransport({ identity: () => ({ ...state }), current: async () => {
    checks++; if (state.cancelled) throw Object.assign(new Error('Cancelled generic scope'), { code: 'CANCELLED' });
  } });
  return { state, transport, get checks() { return checks; } };
}
const clause = i => `Original generic duty ${i}: preserve every boundary and condition. ` + '验证顺序、输入和错误分支🚀。'.repeat(18);
const object = i => ({ objectId: `M16:generic-${i}`, taskId: `M16:generic-${i}`, metricId: 'M16', description: clause(i),
  proofOwners: ['SOURCE'], originalSourceAnchor: { ref: 'generic-original', anchorId: `anchor-${i}` }, savedResult: null });
const known = i => ({ id: `known-original-${i}`, requirement: clause(i), sourceCurrent: true,
  retainedSource: { ref: 'generic-original', anchorId: `anchor-${i}` }, formedAssociation: {
    id: `known-original-${i}`, objectId: `M16:generic-${i}`, requirement: clause(i),
    kind: 'REVIEWER_ASSERTED_DUTY_CORRESPONDENCE', reason: 'The full generic original span retains all clauses and conditions. '.repeat(12),
    proofSubject: { metricId: 'M16', verificationTarget: 'IMPLEMENTATION', applicabilityKind: 'UNCONDITIONAL', proofOwners: ['SOURCE'] },
  } });
function fullPage(objects, candidates, args, auxiliary = {}) {
  const offset = args.offset ?? 0, knownOffset = args.knownOffset ?? Math.min(offset, candidates.length), limit = args.limit ?? 20;
  return { classification: { stopClassification: 'TASK_COMPLETE' }, items: objects.slice(offset, offset + limit), total: objects.length,
    knownObligations: { navigationOnly: true, exhaustive: false, total: candidates.length,
      items: candidates.slice(knownOffset, knownOffset + limit), nextOffset: knownOffset + limit < candidates.length ? knownOffset + limit : null },
    nextOffset: offset + limit < objects.length ? offset + limit : null, ...auxiliary };
}
function bounded(value) {
  assert(bytes(value) <= CHECKLIST_RESPONSE_MAX_BYTES);
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value);
}
async function details(transport, navigation) {
  let args = navigation.arguments, text = '', calls = 0;
  do {
    const value = await transport.detail(args); bounded(value);
    assert.equal(value.readProofGranted, false); assert.equal(value.assessmentGranted, false);
    assert.equal(value.offset, Buffer.byteLength(text));
    text += value.jsonText; calls++;
    assert(value.nextOffset === null || value.nextOffset === Buffer.byteLength(text));
    args = value.next?.arguments;
  } while (args);
  return { value: JSON.parse(text), calls };
}
async function enumerate(f, objects, candidates, auxiliary = {}) {
  let args = { offset: 0, limit: 20 }, pages = 0, sawIndependent = false;
  const found = [], originals = [], outputs = [];
  do {
    const offset = args.offset, knownOffset = args.knownOffset ?? Math.min(offset, candidates.length);
    const value = await f.transport.page(fullPage(objects, candidates, args, auxiliary), {
      ...args, knownOffset, explicitCursors: args.knownOffset !== undefined });
    bounded(value); outputs.push(value); pages++; assert(pages < 200);
    assert.equal(value.nextOffset, offset + value.items.length < objects.length ? offset + value.items.length : null);
    assert.equal(value.knownObligations.nextOffset, knownOffset + value.knownObligations.items.length < candidates.length
      ? knownOffset + value.knownObligations.items.length : null);
    if (value.next && value.next.arguments.offset !== value.next.arguments.knownOffset) sawIndependent = true;
    for (const item of value.items) originals.push(item.fullContentDeferred ? (await details(f.transport, item.readWith)).value : item);
    for (const item of value.knownObligations.items) found.push(item.fullContentDeferred ? (await details(f.transport, item.readWith)).value : item);
    args = value.next?.arguments ?? (value.nextOffset !== null ? { offset: value.nextOffset, limit: 20 } : null);
  } while (args);
  assert.deepEqual(originals, objects); assert.deepEqual(found, candidates);
  return { pages, sawIndependent, outputs };
}

test('small checklist responses retain their existing shape and identity', async () => {
  const f = fixture(), full = fullPage([object(0)], [known(0)], { offset: 0, limit: 5 });
  assert(bytes(full) < 8192); assert.equal(await f.transport.page(full, { offset: 0, knownOffset: 0, limit: 5 }), full);
  assert.equal(Object.hasOwn(full, 'next'), false); assert.equal(f.state.revision, 0);
});

test('small separate scope summaries preserve their count fields and legacy shape', async () => {
  const f = fixture(), full = { stopClassification: 'TASK_COMPLETE', stage: null, items: 7, files: 2, next: 'review_checklist' };
  assert.equal(await f.transport.summary(full), full); assert.equal(f.state.revision, 0);
});

test('fresh and reused scope summaries defer lossless metadata within the full JSON cap', async () => {
  const f = fixture(), auxiliary = { artifactCandidates: Array.from({ length: 48 }, (_, i) => ({ id: `generic-${i}`, text: clause(i) })),
    programEvidenceFiles: Array.from({ length: 96 }, (_, i) => `generic/${i}/` + 'execution/'.repeat(20)) };
  for (const reused of [false, true]) {
    const full = { stopClassification: 'TASK_COMPLETE', stage: null, items: 31, files: 4, next: 'review_checklist',
      ...(reused ? { reused: true } : {}), ...auxiliary };
    const value = await f.transport.summary(full); bounded(value);
    assert.equal(value.items, 31); assert.equal(value.files, 4); assert.equal(value.next, 'review_checklist');
    assert.equal(value.reused, full.reused); const deferred = await details(f.transport, value.checklistDetails.readWith);
    for (const key of value.checklistDetails.fields) assert.deepEqual(deferred.value[key], auxiliary[key]);
    f.state.owner = 'foreign-owner';
    await assert.rejects(f.transport.detail(value.checklistDetails.readWith.arguments), { code: 'REVIEW_NAVIGATION_STALE' });
    f.state.owner = 'generic-owner';
  }
});

test('large Unicode checklist and known streams enumerate every complete row with independent cursors', async () => {
  const f = fixture(), objects = Array.from({ length: 31 }, (_, i) => object(i)), candidates = Array.from({ length: 23 }, (_, i) => known(i));
  const result = await enumerate(f, objects, candidates);
  assert(result.pages > 1); assert(result.sawIndependent); assert(f.checks >= result.pages);
});

test('known obligations continue after the checklist nextOffset becomes null', async () => {
  const result = await enumerate(fixture(), [object(0)], Array.from({ length: 17 }, (_, i) => known(i)));
  assert(result.outputs.some(page => page.nextOffset === null && page.knownObligations.nextOffset !== null && page.next));
});

test('small unequal streams still issue a complete known-only continuation', async () => {
  const f = fixture(), objects = [object(0)], candidates = [known(0), known(1)];
  const page = await f.transport.page(fullPage(objects, candidates, { offset: 0, limit: 1 }), { offset: 0, knownOffset: 0, limit: 1 });
  bounded(page); assert.equal(page.nextOffset, null);
  assert.deepEqual(page.next.arguments, { offset: 1, knownOffset: 1, limit: 1 });
  const next = await f.transport.page(fullPage(objects, candidates, page.next.arguments), { ...page.next.arguments, explicitCursors: true });
  bounded(next); assert.deepEqual(next.items, []); assert.deepEqual(next.knownObligations.items, [candidates[1]]); assert.equal(next.next, null);
});

test('checklist continues after the known stream is exhausted without replaying known IDs', async () => {
  const result = await enumerate(fixture(), Array.from({ length: 21 }, (_, i) => object(i)), [known(0)]);
  assert(result.outputs.some(page => page.nextOffset !== null && page.knownObligations.nextOffset === null));
});

test('auxiliary-only overflow is lossless, bounded and separate from evidence', async () => {
  const f = fixture(), auxiliary = {
    artifactCandidates: Array.from({ length: 64 }, (_, i) => ({ path: `generic/${i}/` + 'delivery/'.repeat(20), sha256: 'a'.repeat(64) })),
    programEvidenceFiles: Array.from({ length: 96 }, (_, i) => `generic/${i}/` + 'process/'.repeat(20)),
    expectedFileChecks: Array.from({ length: 64 }, (_, i) => ({ objectId: `M16:generic-${i}`, path: `out/${i}`, reason: clause(i) })),
  };
  const value = await f.transport.page(fullPage([], [], { offset: 0 }, auxiliary), { offset: 0, knownOffset: 0 });
  bounded(value); assert(value.checklistDetails); assert.deepEqual(value.items, []); assert.equal(value.next, null);
  const restored = await details(f.transport, value.checklistDetails.readWith);
  for (const key of value.checklistDetails.fields) assert.deepEqual(restored.value[key], auxiliary[key]);
  assert(restored.calls > 1); assert.equal(f.state.revision, 0);
});

test('an oversized single canonical row is retrievable without clipping its text or ID', async () => {
  const f = fixture(), large = { ...object(0), description: 'Preserve every compound clause. 验证边界🚀\n'.repeat(900),
    condition: 'When an input is permitted, retain its complete corresponding error branch.' };
  const full = fullPage([large], [], { offset: 0 });
  const page = await f.transport.page(full, { offset: 0, knownOffset: 0 }); bounded(page);
  assert.equal(page.items[0].objectId, large.objectId); assert.equal(page.items[0].fullCanonicalTextInDetails, true);
  assert.equal(Object.hasOwn(page.items[0], 'description'), false);
  assert.deepEqual((await details(f.transport, page.items[0].readWith)).value, large);
});

test('escaped strings, Unicode pairs and escaped lone surrogates round trip through detail bytes', async () => {
  const f = fixture(), large = { ...known(0), requirement: ('\"\\\n\t🚀验证' + '\ud800').repeat(1500) };
  const page = await f.transport.page(fullPage([], [large], { offset: 0 }), { offset: 0, knownOffset: 0 }); bounded(page);
  const restored = await details(f.transport, page.knownObligations.items[0].readWith);
  assert.deepEqual(restored.value, large); assert(restored.calls > 2);
});

for (const changed of ['owner', 'scope', 'source', 'revision']) test(`details reject changed ${changed} and cannot grant a fresh read`, async () => {
  const f = fixture(), page = await f.transport.page(fullPage([], [], { offset: 0 }, { large: 'x'.repeat(20000) }), { offset: 0, knownOffset: 0 });
  f.state[changed] = changed === 'revision' ? 1 : 'different';
  await assert.rejects(f.transport.detail(page.checklistDetails.readWith.arguments), { code: 'REVIEW_NAVIGATION_STALE' });
});

test('foreign, forged and cancelled detail pointers remain unavailable', async () => {
  const f = fixture(), page = await f.transport.page(fullPage([], [], { offset: 0 }, { large: 'x'.repeat(20000) }), { offset: 0, knownOffset: 0 });
  const args = page.checklistDetails.readWith.arguments;
  await assert.rejects(fixture().transport.detail(JSON.parse(JSON.stringify(args))), { code: 'REVIEW_NAVIGATION_STALE' });
  await assert.rejects(f.transport.detail({ ...args, detailDigest: 'f'.repeat(64) }), { code: 'REVIEW_NAVIGATION_STALE' });
  f.state.cancelled = true; await assert.rejects(f.transport.detail(args), { code: 'CANCELLED' });
});

test('detail offsets reject mid-codepoint, negative and foreign-range cursors', async () => {
  const f = fixture(), text = '🚀'.repeat(5000);
  const page = await f.transport.page(fullPage([], [], { offset: 0 }, { large: text }), { offset: 0, knownOffset: 0 });
  const args = page.checklistDetails.readWith.arguments;
  const first = await f.transport.detail(args), encoded = Buffer.from(JSON.stringify({ large: text }));
  const continuation = encoded.findIndex(byte => (byte & 0xc0) === 0x80);
  for (const offset of [-1, encoded.length + 1, continuation])
    await assert.rejects(f.transport.detail({ ...args, offset }), { code: 'REVIEW_NAVIGATION_RANGE' });
  assert(first.nextOffset > 0);
});
