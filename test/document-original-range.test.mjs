import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDocumentTools, bindDocumentTools, registerDocumentTools } from '../lib/document-tools.mjs';
import { createOriginalSourceAnchor } from '../lib/runtime-v2/original-source-anchor.mjs';
import { knownOriginalOwner } from '../lib/runtime-v2/known-original-capacity.mjs';
import { sha256 } from '../lib/runtime-v2/utils.mjs';

async function fixture(t, text, ref = 'transcript:原始要求🧪') {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'document-original-range-')));
  const proposal = 'openspec/changes/range-guidance/proposal.md', tasks = 'openspec/changes/range-guidance/tasks.md';
  await fs.mkdir(path.dirname(path.join(root, proposal)), { recursive: true });
  await fs.writeFile(path.join(root, proposal), '# Plan\nPreserve the original conditions.\n');
  await fs.writeFile(path.join(root, tasks), '- [ ] Implement and verify the declared behavior.\n');
  const requestPath = path.join(root, 'request/request.json'), sourcePath = path.join(root, 'request/user-sources/original.txt');
  await fs.mkdir(path.dirname(sourcePath), { recursive: true }); await fs.writeFile(sourcePath, text);
  const source = { ref, path: sourcePath, sha256: sha256(text) };
  const controller = new AbortController(), sessionId = `review-${path.basename(root)}`;
  const state = { projectRoot: root, sessionId: 'owner', sessionKey: 'agent:owner', scopeTaskId: 'task',
    projectScope: { fingerprint: 'scope' }, nativeRunId: 'review-run', reviewController: controller };
  const tools = await createDocumentTools({ projectRoot: root, requestPath, signal: controller.signal,
    semantic: { artifactFiles: [proposal, tasks], originalRequirements: { digest: sha256(text), userMessages: [source] } },
    originalDutyCohortContext: { owner: knownOriginalOwner(state), sourceRunId: state.nativeRunId } });
  let factory, ownerCurrent = true;
  registerDocumentTools({ registerTool(value) { factory = value; } });
  const release = bindDocumentTools({ sessionId, runId: 'review-run', tools, active() {} });
  t.after(async () => { release(); await fs.rm(root, { recursive: true, force: true }); });
  const native = factory({ sessionId, runId: 'review-run', assertInvocationCurrent() {
    if (!ownerCurrent) throw Object.assign(new Error('Original owner changed'), { code: 'OWNER_CHANGED' });
  } });
  const call = async args => JSON.parse((await native.execute('current-call', args)).content[0].text);
  const anchor = (start, end) => createOriginalSourceAnchor({ ref: source.ref, sha256: source.sha256,
    bytes: Buffer.from(text), start, end });
  return { tools, call, source, sourcePath, controller, anchor, expireOwner() { ownerCurrent = false; } };
}

async function rangeError(f, start, count) {
  let rejected;
  await assert.rejects(f.call({ action: 'read_original', ref: f.source.ref, start, count }), error => {
    rejected = error; assert.equal(error.code, 'DOCUMENT_ORIGINAL_RANGE_INVALID');
    assert.match(error.message, /Valid original physical line range is 1-\d+/u);
    assert(error.message.includes(JSON.stringify(error.originalRangeIssue)), 'Native error text carries the complete retry pointer.');
    return true;
  });
  return rejected.originalRangeIssue;
}

for (const ending of ['', '\r\n']) test(`oversized original reads disclose exact Unicode/CRLF bounds without granting authority (${ending ? 'terminal LF' : 'no terminal LF'})`, async t => {
  const text = `# 原始要求\r\n保留🧪 条件。\r\n仅在启用时记录。${ending}`, f = await fixture(t, text);
  const end = text.split('\n').length, issue = await rangeError(f, 2, 200);
  assert.deepEqual(issue, { requested: { start: 2, count: 200 }, validLineRange: { start: 1, end },
    retryRange: { start: 2, count: end - 1 },
    reuseRequestedRef: true, navigationOnly: true, readProofGranted: false });
  const expected = f.anchor(2, end), duty = { originalSourceAnchorId: expected.anchorId, requirement: '保留完整条件。' };
  await assert.rejects(f.call({ action: 'stage_original_duties', duties: [duty] }), /DOCUMENT_ORIGINAL_DUTY_READ_REQUIRED/u);
  await assert.rejects(f.tools.verifyRequirementCoverage([{ ...duty, disposition: 'UNVERIFIED',
    reason: 'A rejected read does not disclose this range.', targets: [] }]), /issued by read_original in this review/u);
  assert.equal(f.tools.originalDutyAccounting().status, 'NOT_EXERCISED');
  assert.equal(f.tools.originalDutyAccounting().stagedCount, 0);
  const read = await f.call({ action: 'read_original', ref: f.source.ref, ...issue.retryRange });
  assert.deepEqual(read.anchor, expected);
  assert.equal(read.text, Buffer.from(text).subarray(expected.byteStart, expected.byteEnd).toString('utf8'));
  const staged = await f.call({ action: 'stage_original_duties', duties: [duty] });
  assert.equal(staged.stagedCount, 1, 'Only the separately executed successful retry authorizes staging.');
});

test('starts beyond EOF suggest a nonempty in-bounds original line and preserve strict last-line handling', async t => {
  const f = await fixture(t, 'First condition.\r\n第二项🧪。\r\n\r\n');
  const issue = await rangeError(f, 99, 5);
  assert.deepEqual(issue.validLineRange, { start: 1, end: 4 });
  assert.deepEqual(issue.retryRange, { start: 2, count: 1 }); assert.equal(issue.reuseRequestedRef, true);
  await assert.rejects(f.call({ action: 'read_original', ref: f.source.ref, start: 4, count: 1 }), error => {
    assert.equal(error.message, 'Original user source range contains no text.');
    assert.equal(error.originalRangeIssue, undefined); return true;
  });
  const read = await f.call({ action: 'read_original', ref: f.source.ref, ...issue.retryRange });
  assert.deepEqual(read.anchor, f.anchor(2, 2)); assert.equal(read.text, '第二项🧪。\r');
});

test('blank originals offer no fictional successful retry', async t => {
  const f = await fixture(t, ' \t\r\n\r\n'), issue = await rangeError(f, 9, 2);
  assert.equal(issue.retryRange, null); assert.deepEqual(issue.validLineRange, { start: 1, end: 3 });
  await assert.rejects(f.call({ action: 'read_original', ref: f.source.ref, start: 9, count: 2 }), error => {
    assert.match(error.message, /no nonempty line to suggest/u);
    assert.doesNotMatch(error.message, /Retry the listed/u); return true;
  });
  await assert.rejects(f.call({ action: 'read_original', ref: f.source.ref, start: 1, count: 1 }), /range contains no text/u);
  const empty = await fixture(t, '');
  await assert.rejects(empty.call({ action: 'read_original', ref: empty.source.ref, start: 9, count: 2 }), error => {
    assert.equal(error.message, 'Invalid original user source segment.'); assert.equal(error.originalRangeIssue, undefined); return true;
  });
  for (const tools of [f.tools, empty.tools]) assert.equal(tools.originalDutyAccounting().status, 'NOT_EXERCISED');
});

test('range diagnostics stay bounded without changing or truncating a long original reference', async t => {
  const ref = `transcript:${'原'.repeat(2000)}`, f = await fixture(t, 'One complete condition.', ref);
  await assert.rejects(f.call({ action: 'read_original', ref, start: 9, count: 2 }), error => {
    assert(Buffer.byteLength(error.message) < 1024);
    assert(!error.message.includes(ref)); assert.match(error.message, /SAME exact ref/u);
    assert.deepEqual(error.originalRangeIssue.retryRange, { start: 1, count: 1 }); return true;
  });
  assert.equal(f.source.ref, ref);
  const read = await f.call({ action: 'read_original', ref, start: 1, count: 1 });
  assert.equal(read.anchor.ref, ref); assert.deepEqual(read.anchor, f.anchor(1, 1));
});

test('malformed coordinates and undeclared sources retain their original rejection without a fabricated retry', async t => {
  const f = await fixture(t, 'One condition.\nLast condition.');
  for (const [start, count] of [[0, 1], [1.5, 1], [true, 1], [1, 0], [1, 201], [1, '2']])
    await assert.rejects(f.call({ action: 'read_original', ref: f.source.ref, start, count }), error => {
      assert.equal(error.message, 'DOCUMENT_RANGE_INVALID'); assert.equal(error.originalRangeIssue, undefined); return true;
    });
  await assert.rejects(f.call({ action: 'read_original', ref: 'unknown-source', start: 9, count: 2 }),
    /DOCUMENT_ORIGINAL_SOURCE_UNDECLARED/u);
  assert.equal(f.tools.originalDutyAccounting().status, 'NOT_EXERCISED');
});

test('changed source, expired owner and cancellation are not relabeled as original-range errors', async t => {
  const changed = await fixture(t, 'Original condition.\n');
  await fs.writeFile(changed.sourcePath, 'Changed condition.\n');
  await assert.rejects(changed.call({ action: 'read_original', ref: changed.source.ref, start: 9, count: 2 }),
    /DOCUMENT_ORIGINAL_SOURCE_CHANGED/u);
  const owner = await fixture(t, 'Original condition.\n'); owner.expireOwner();
  await assert.rejects(owner.call({ action: 'read_original', ref: owner.source.ref, start: 9, count: 2 }), { code: 'OWNER_CHANGED' });
  const cancelled = await fixture(t, 'Original condition.\n'); cancelled.controller.abort(new Error('Original review cancelled'));
  await assert.rejects(cancelled.call({ action: 'read_original', ref: cancelled.source.ref, start: 9, count: 2 }), /Original review cancelled/u);
  for (const f of [changed, owner, cancelled]) assert.equal(f.tools.originalDutyAccounting().status, 'NOT_EXERCISED');
});

test('invalid UTF-8 and valid but oversized text keep their existing rejection', async t => {
  const invalid = await fixture(t, 'Original condition.');
  const badBytes = Buffer.from([0xc0, 0xae]); await fs.writeFile(invalid.sourcePath, badBytes); invalid.source.sha256 = sha256(badBytes);
  await assert.rejects(invalid.call({ action: 'read_original', ref: invalid.source.ref, start: 9, count: 2 }), error => {
    assert.equal(error.message, 'Invalid text interval'); assert.equal(error.originalRangeIssue, undefined); return true;
  });
  const large = await fixture(t, '条'.repeat(3000));
  await assert.rejects(large.call({ action: 'read_original', ref: large.source.ref, start: 1, count: 1 }), /DOCUMENT_ORIGINAL_RANGE_TOO_LARGE/u);
  for (const f of [invalid, large]) assert.equal(f.tools.originalDutyAccounting().status, 'NOT_EXERCISED');
});
