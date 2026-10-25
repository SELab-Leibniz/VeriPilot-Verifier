import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runReviewTask } from '../../lib/review-task/review-task.mjs';
import { loadReviewCheckpoint } from '../../lib/review-task/history-memory.mjs';
import { nativeTools } from '../helpers/native-task.mjs';

async function fixture(t) {
  const parent = path.resolve('.runtime-correction/native-task-tests'); await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'run-')), root = path.join(directory, 'source'), outputDir = path.join(directory, 'review');
  await fs.mkdir(root); await fs.writeFile(path.join(root, 'basis.md'), 'Condition\nException\n'); await fs.writeFile(path.join(root, 'app.txt'), '\uFEFF先校验😀\r\n后保存🌷\n');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const task = { id: 'one', requirement: 'Check the complete original condition', basisFiles: ['basis.md'], targetFiles: ['app.txt'] };
  return { directory, root, outputDir, task };
}
const run = (f, nativeRun, options = {}) => runReviewTask({ ...f, nativeRun, maxAttempts: 1, ...options });
const decode = value => JSON.parse(value.content[0].text);
async function readAndSubmit(worker, taskId = 'one', verdict = 'PASS') {
  const tools = nativeTools(worker); await tools.read('basis.md'); const cite = await tools.read('app.txt');
  return tools.submit(taskId, verdict, [cite]);
}

test('native task has no standalone model fallback', async t => {
  const f = await fixture(t), result = await run(f, undefined);
  assert.equal(result.completed, false); assert.match(result.reason, /native task runner is required/);
});
test('submission is durable before its item receipt and preserves exact UTF-8 excerpts', async t => {
  const f = await fixture(t); let called = 0;
  const result = await run(f, async worker => { await readAndSubmit(worker); }, { onItemResult: async item => {
    const saved = JSON.parse(await fs.readFile(path.join(f.outputDir, 'decision.json'))); assert.equal(saved.taskId, item.taskId);
    const evidence = JSON.parse(await fs.readFile(item.evidencePath)); assert.equal(evidence.citations[0].text, '\uFEFF先校验😀\r\n后保存🌷\n'); called++;
  } });
  assert.equal(result.completed, true); assert.equal(called, 1);
});
test('group keeps independent durable receipts and continues in one host invocation', async t => {
  const f = await fixture(t), tasks = [f.task, { ...f.task, id: 'two' }], receipts = [];
  let calls = 0;
  const result = await run(f, async worker => {
    calls++; const tools = nativeTools(worker); await tools.read('basis.md'); const cite = await tools.read('app.txt');
    const first = decode(await tools.submit('one', 'PASS', [cite])); assert.deepEqual(first.remainingTaskIds, ['two']);
    assert.equal(first.receipt.savedItem, 'one'); await tools.submit('two', 'DEVIATION', [cite]);
  }, { tasks, onItemResult: async item => { receipts.push(item.taskId); return { savedItem: item.taskId }; } });
  assert.equal(calls, 1); assert.deepEqual(receipts, ['one', 'two']); assert.equal(result.status, 'COMPLETED');
  assert.deepEqual(result.items.map(item => item.verdict), ['PASS', 'DEVIATION']);
});
test('group interruption keeps its first receipt and never claims completion', async t => {
  const f = await fixture(t);
  const result = await run(f, async worker => { await readAndSubmit(worker); throw new Error('host interrupted'); }, { tasks: [f.task, { ...f.task, id: 'two' }] });
  assert.equal(result.completed, false); assert.equal(result.items.length, 1); assert.equal(result.items[0].taskId, 'one');
});
for (const mode of ['undelivered', 'failed', 'altered', 'extra-content']) test(`${mode} host result cannot grant basis evidence`, async t => {
  const f = await fixture(t);
  const result = await run(f, async worker => {
    const tools = nativeTools(worker);
    await tools.read('basis.md', {}, mode === 'undelivered' ? { deliver: false } : mode === 'failed' ? { isError: true }
      : { transform: value => mode === 'altered' ? { ...value, content: [{ type: 'text', text: value.content[0].text.slice(0, 20) }] }
        : { ...value, content: [...value.content, { type: 'image', data: '', mimeType: 'image/png' }] } });
    const cite = await tools.read('app.txt');
    await assert.rejects(tools.submit('one', 'PASS', [cite]), /basis not fully read|separate assistant response/);
  });
  assert.equal(result.completed, false);
  const checkpoint = await loadReviewCheckpoint(path.join(f.outputDir, 'review-checkpoint.json'));
  assert.ok(!checkpoint.reads.some(read => read.path === 'basis.md'));
});
test('truncated page cannot cover undisclosed basis tail; subsequent pages can', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.root, 'basis.md'), Array.from({ length: 502 }, (_, i) => `condition ${i}`).join('\n'));
  const result = await run(f, async worker => {
    const tools = nativeTools(worker); await tools.read('basis.md'); const cite = await tools.read('app.txt');
    await assert.rejects(tools.submit('one', 'PASS', [cite]), /basis not fully read/);
    await tools.read('basis.md', { offset: 401 }); await tools.submit('one', 'PASS', [cite]);
  }); assert.equal(result.completed, true);
});
test('oversized first line remains unavailable instead of inventing a range', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.root, 'basis.md'), 'x'.repeat(60000));
  const result = await run(f, async worker => { const tools = nativeTools(worker); await assert.rejects(tools.read('basis.md'), /First line exceeds/); await tools.submit('one', 'UNVERIFIED', []); });
  assert.equal(result.verdict, 'UNVERIFIED'); assert.deepEqual(result.refs, []);
});
test('source navigation stays inside captured scope and cannot grant citations', async t => {
  const f = await fixture(t);
  const result = await run(f, async worker => {
    const tools = nativeTools(worker); tools.turn();
    await assert.rejects(tools.call('source_read', { path: '../outside' }), /ENOENT|outside/);
    assert.equal(decode(await tools.call('source_grep', { pattern: 'Exception' })).navigationOnly, true);
    assert.deepEqual(decode(await tools.call('source_find', { pattern: 'app' })).hits, ['app.txt']);
    await assert.rejects(tools.submit('one', 'PASS', ['fabricated']), /basis not fully read/);
  }); assert.equal(result.completed, false);
});
test('submission in the same assistant turn as retrieval is rejected', async t => {
  const f = await fixture(t); const result = await run(f, async worker => {
    const tools = nativeTools(worker); await tools.read('basis.md'); const cite = await tools.read('app.txt');
    await assert.rejects(tools.call('submit_review', { taskId: 'one', verdict: 'PASS', reason: 'premature', citeIds: [cite] }), /separate assistant response/);
    await tools.submit('one', 'PASS', [cite]);
  }); assert.equal(result.completed, true);
});
test('compaction can discard model context while history restores only acknowledged evidence', async t => {
  const f = await fixture(t); const result = await run(f, async worker => {
    const tools = nativeTools(worker); await tools.read('basis.md'); await tools.read('app.txt');
    await worker.checkpoint('before_compaction'); await worker.onAgentEvent({ stream: 'compaction', data: { phase: 'end' } });
    // Simulate a host summary that contains no IDs: restore from RC's ledger.
    tools.turn(); const state = decode(await tools.call('review_history', { mode: 'state' }));
    const cite = state.citations.find(value => value.path === 'app.txt');
    await tools.submit('one', 'PASS', [cite.citeId]);
  }, { initialHistory: ['Old untrusted observation, never a successful current read.'] });
  assert.equal(result.completed, true); const checkpoint = await loadReviewCheckpoint(path.join(f.outputDir, 'review-checkpoint.json'));
  assert.equal(checkpoint.reads.length, 2); assert.equal(checkpoint.citations.length, 2);
});
test('original source mutation invalidates a saved decision at final currentness check', async t => {
  const f = await fixture(t); const result = await run(f, async worker => { await readAndSubmit(worker); await fs.writeFile(path.join(f.root, 'app.txt'), 'changed'); });
  assert.equal(result.completed, false); assert.match(result.reason, /STALE/); await assert.rejects(fs.stat(path.join(f.outputDir, 'decision.json')), { code: 'ENOENT' });
});
test('frozen source is read after the original changes but cannot be submitted', async t => {
  const f = await fixture(t); const result = await run(f, async worker => {
    await fs.writeFile(path.join(f.root, 'app.txt'), 'changed'); const tools = nativeTools(worker);
    await tools.read('basis.md'); const cite = await tools.read('app.txt'); await assert.rejects(tools.submit('one', 'PASS', [cite]), /STALE/);
  }); assert.equal(result.completed, false);
});
test('cancellation rejects late reads and submissions without promoting receipts', async t => {
  const f = await fixture(t), controller = new AbortController();
  const result = await run(f, async worker => {
    const tools = nativeTools(worker); await tools.read('basis.md'); controller.abort();
    await assert.rejects(tools.read('app.txt'), /abort|closed/i); await assert.rejects(tools.submit('one', 'PASS', []), /abort|closed/i);
  }, { signal: controller.signal }); assert.equal(result.completed, false);
});
test('a closed worker cannot issue tools even when its host kept a reference', async t => {
  const f = await fixture(t); let late;
  const result = await run(f, async worker => { late = nativeTools(worker); }); assert.equal(result.completed, false);
  await assert.rejects(late.call('source_read', { path: 'basis.md' }), /closed/);
});
test('trusted prompt additions preserve the original question and reject executable data', async t => {
  const f = await fixture(t); await run(f, async worker => { assert.match(worker.systemPrompt, /TRUSTED_RULE/); await readAndSubmit(worker); }, { promptAppend: 'TRUSTED_RULE' });
  await assert.rejects(runReviewTask({ ...f, outputDir: `${f.outputDir}-invalid`, promptAppend: () => {} }), /trusted caller/);
});
test('mutated host citation metadata cannot expand an actually disclosed basis page', async t => {
  const f = await fixture(t); const result = await run(f, async worker => {
    const tools = nativeTools(worker);
    await tools.read('basis.md', { limit: 1 }, { transform: result => {
      result.details.citation.end = 3; result.details.citation.byteEnd = Buffer.byteLength('Condition\nException\n');
      return result;
    } });
    const cite = await tools.read('app.txt');
    await assert.rejects(tools.submit('one', 'PASS', [cite]), /basis not fully read/);
  }); assert.equal(result.completed, false);
});

test('redacted telemetry cannot erase a final original-byte receipt or its restored checkpoint', async t => {
  const f = await fixture(t), marker = 'fc-abcdefghijklmnop';
  await fs.writeFile(path.join(f.root, 'basis.md'), `Preserve the fictional marker ${marker}.\n`);
  await fs.writeFile(path.join(f.root, 'app.txt'), `The fictional marker is ${marker}.\n`);
  const masked = value => ({ ...value, content: value.content.map(block => ({ ...block, text: block.text.replaceAll(marker, 'fc-abc…mnop') })) });
  const result = await run(f, async worker => {
    const tools = nativeTools(worker);
    await tools.read('basis.md', {}, { observerTransform: masked });
    const cite = await tools.read('app.txt', {}, { observerTransform: masked });
    await worker.checkpoint('before_compaction');
    tools.turn(); const state = decode(await tools.call('review_history', { mode: 'state' }));
    assert(state.citations.some(citation => citation.citeId === cite));
    await tools.submit('one', 'PASS', [cite]);
  });
  assert.equal(result.completed, true); assert.equal(result.verdict, 'PASS');
  const checkpoint = await loadReviewCheckpoint(path.join(f.outputDir, 'review-checkpoint.json'));
  assert.equal(checkpoint.reads.length, 2);
  const evidence = JSON.parse(await fs.readFile(result.evidencePath));
  assert.equal(evidence.citations[0].text, `The fictional marker is ${marker}.\n`);
  const events = (await fs.readFile(path.join(f.outputDir, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
  const receipt = events.find(event => event.type === 'read_receipt');
  assert.notEqual(events.find(event => event.type === 'read_observer' && event.citeId === receipt.citeId).textSha256, receipt.textSha256);
});
for (const mode of ['observer-only', 'synthetic', 'wrong-call']) test(`${mode} cannot replace a final successful receipt`, async t => {
  const f = await fixture(t); const result = await run(f, async worker => {
    const tools = nativeTools(worker);
    await tools.read('basis.md', {}, mode === 'observer-only' ? { receipt: false } : mode === 'synthetic' ? { isSynthetic: true } : { receiptCallId: 'foreign-call' });
    const cite = await tools.read('app.txt'); await assert.rejects(tools.submit('one', 'PASS', [cite]), /basis not fully read/);
  }); assert.equal(result.completed, false);
});

test('grep inherits parent cancellation when the native caller omits a tool signal', async t => {
  const f = await fixture(t), controller = new AbortController();
  await fs.writeFile(path.join(f.root, 'large.txt'), 'no match here\n'.repeat(1000000));
  const original = (await import('node:fs')).default.createReadStream;
  const nativeFs = (await import('node:fs')).default;
  t.mock.method(nativeFs, 'createReadStream', (file, options) => {
    const stream = original(file, options);
    stream.once('data', () => setImmediate(() => controller.abort(new Error('parent cancelled grep'))));
    return stream;
  });
  const result = await run(f, async worker => {
    const tools = nativeTools(worker); tools.turn();
    await assert.rejects(tools.call('source_grep', { path: 'large.txt', pattern: 'absent' }), /parent cancelled grep/);
  }, { signal: controller.signal });
  assert.equal(result.completed, false);
});
