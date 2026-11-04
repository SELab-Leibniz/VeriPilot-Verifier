import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createSourceTools, toolText } from '../lib/review-task/source-tools.mjs';
import { captureFiles } from '../lib/review-task/evidence-utils.mjs';
import { createTaskEvidence } from '../lib/review-task/task-evidence.mjs';
import { fileSymlinkSkipReason } from './helpers/file-symlink-capability.mjs';

async function fixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'frozen-root-alias-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'physical'), outside = path.join(base, 'outside'), alias = path.join(base, 'alias');
  await fs.mkdir(root); await fs.mkdir(outside);
  await fs.writeFile(path.join(root, 'source.txt'), 'ORIGINAL selected text.\n');
  await fs.writeFile(path.join(outside, 'source.txt'), 'OUTSIDE text must not enter evidence.\n');
  await fs.symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  return { base, root, outside, alias };
}

test('frozen reads and navigation accept an alias of their selected root', async t => {
  const f = await fixture(t), tools = createSourceTools(f.alias, await captureFiles(f.alias));
  const read = tools.find(tool => tool.name === 'read');
  assert.match(toolText(await read.execute('read', { path: 'source.txt' })), /ORIGINAL selected text/);
  for (const name of ['ls', 'find', 'grep']) {
    const tool = tools.find(tool => tool.name === name);
    const result = JSON.parse(toolText(await tool.execute(name, { path: '.', pattern: name === 'find' ? 'source' : 'ORIGINAL' })));
    assert.equal(result.navigationOnly, true);
    assert.equal(result.hits.length, 1);
    assert.match(result.hits[0], /source\.txt/);
  }
});

test('root alias support cannot expand the frozen inventory or follow a replaced child outside', { skip: await fileSymlinkSkipReason() }, async t => {
  const f = await fixture(t), tools = createSourceTools(f.alias, await captureFiles(f.alias));
  const read = tools.find(tool => tool.name === 'read'), grep = tools.find(tool => tool.name === 'grep');
  await fs.writeFile(path.join(f.root, 'new.txt'), 'Not captured.');
  await assert.rejects(read.execute('unlisted', { path: 'new.txt' }), /not part of the frozen snapshot/);
  await assert.rejects(read.execute('outside', { path: path.join(f.outside, 'source.txt') }), /outside snapshot/);
  await fs.rm(path.join(f.root, 'source.txt'));
  await fs.symlink(path.join(f.outside, 'source.txt'), path.join(f.root, 'source.txt'));
  await assert.rejects(read.execute('linked-read', { path: 'source.txt' }), /outside snapshot/);
  await assert.rejects(grep.execute('linked-grep', { path: '.', pattern: 'OUTSIDE' }), /Linked source is forbidden/);
});

test('retargeting the root alias cannot retarget an already created frozen reader', async t => {
  const f = await fixture(t), read = createSourceTools(f.alias, await captureFiles(f.alias)).find(tool => tool.name === 'read');
  await fs.unlink(f.alias);
  await fs.symlink(f.outside, f.alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.match(toolText(await read.execute('original-root', { path: 'source.txt' })), /ORIGINAL selected text/);
  await assert.rejects(read.execute('new-alias-root', { path: path.join(f.alias, 'source.txt') }), /outside snapshot/);
});

test('an aliased frozen root grants coverage only after its actual persisted read and still detects mutation', async t => {
  const f = await fixture(t);
  const evidence = await createTaskEvidence({ root: f.alias, active() {}, journal: { appendMessage() {} } });
  const read = evidence.tools.find(tool => tool.name === 'source_read');
  const result = await read.execute('actual-read', { path: 'source.txt' });
  assert.equal(evidence.reads.length, 0);
  assert.equal(evidence.registry.size, 0);
  evidence.observeReceipt({ toolName: 'source_read', toolCallId: 'actual-read', isSynthetic: false,
    message: { role: 'toolResult', toolName: 'source_read', toolCallId: 'actual-read', isError: false, content: result.content } });
  assert.equal(evidence.reads.length, 1);
  assert.equal(evidence.reads[0].path, 'source.txt');
  assert.equal(evidence.registry.size, 1);
  await evidence.assertFrozen();
  await fs.writeFile(path.join(f.root, 'source.txt'), 'Changed original.\n');
  await assert.rejects(evidence.assertFrozen(), { code: 'BASELINE_INPUT_CHANGED' });
});
