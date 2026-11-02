import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createSyntheticSource, captureSyntheticProviderPayloads } from '../scripts/helpers/synthetic-provider-preflight.mjs';

async function root(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-synthetic-preflight-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir;
}
test('synthetic frozen tool rejects external, undeclared and linked paths before disclosing content', async t => {
  const dir = await root(t), fixture = await createSyntheticSource(path.join(dir, 'source'));
  const outside = path.join(dir, 'private-canary.txt'); await fs.writeFile(outside, 'SYNTHETIC_EXTERNAL_CANARY');
  for (const file of [outside, '../private-canary.txt', 'unknown.txt'])
    await assert.rejects(fixture.tool.execute('denied', { path: file }), /PATH_DENIED/u);
  await fs.rm(path.join(fixture.root, 'request.txt'));
  await fs.symlink(outside, path.join(fixture.root, 'request.txt'));
  await assert.rejects(fixture.tool.execute('linked', { path: 'request.txt' }), /LINK_DENIED/u);
});
test('synthetic snapshot rejects changed bytes and internal links too', async t => {
  const dir = await root(t), fixture = await createSyntheticSource(path.join(dir, 'source'));
  await fs.writeFile(path.join(fixture.root, 'request.txt'), 'changed');
  await assert.rejects(fixture.tool.execute('changed', { path: 'request.txt' }), /SOURCE_CHANGED/u);
  await fs.rm(path.join(fixture.root, 'request.txt'));
  await fs.symlink(path.join(fixture.root, 'SKILL.md'), path.join(fixture.root, 'request.txt'));
  await assert.rejects(fixture.tool.execute('internal-link', { path: 'request.txt' }), /LINK_DENIED/u);
});
test('installed serializer captures initial and tool-result payloads without invoking fetch or loading private context', {
  skip: !process.env.RC_OPENCLAW_HOST_ROOT,
}, async t => {
  const dir = await root(t);
  const record = await captureSyntheticProviderPayloads({ root: dir, hostRoot: process.env.RC_OPENCLAW_HOST_ROOT });
  assert.equal(record.fetchReached, 0); assert.equal(record.authenticationLoaded, false);
  assert.equal(record.captured.length, 2);
  assert(record.captured[1].payload.messages.some(message => JSON.stringify(message).includes('Fictional task:')));
  assert(!JSON.stringify(record.captured).includes(dir));
});

test('actual fetch URL and serialized body are intercepted without headers, credentials or socket access', {
  skip: !process.env.RC_OPENCLAW_HOST_ROOT,
}, async t => {
  const dir = await root(t);
  const output = path.join(dir, 'capture.json');
  const script = `import fs from 'node:fs/promises'; import {captureSyntheticProviderPayloads} from ${JSON.stringify(new URL('../scripts/helpers/synthetic-provider-preflight.mjs', import.meta.url).href)};
    const record = await captureSyntheticProviderPayloads({root:${JSON.stringify(dir)},hostRoot:${JSON.stringify(process.env.RC_OPENCLAW_HOST_ROOT)},captureAtFetch:true});
    await fs.writeFile(${JSON.stringify(output)},JSON.stringify(record));`;
  await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script]);
  const record = JSON.parse(await fs.readFile(output, 'utf8'));
  assert.equal(record.networkRequests, 0); assert.equal(record.fetchReached, 2);
  assert.equal(record.socketAttemptsBlocked, 0); assert.equal(record.wireCaptured.length, 2);
  assert.deepEqual(record.wireCaptured.map(p => p.origin), ['https://open.bigmodel.cn', 'https://open.bigmodel.cn']);
  assert(!JSON.stringify(record.wireCaptured).includes('synthetic-preflight-dummy'));
});

test('Coding Plan installed serializer captures initial and four-toy tool-result inputs without network', {
  skip: !process.env.RC_OPENCLAW_HOST_ROOT,
}, async t => {
  const dir = await root(t), output = path.join(dir, 'coding-capture.json');
  const script = `import fs from 'node:fs/promises';import{captureSyntheticProviderPayloads}from${JSON.stringify(new URL('../scripts/helpers/synthetic-provider-preflight.mjs', import.meta.url).href)};
    const record=await captureSyntheticProviderPayloads({root:${JSON.stringify(dir)},hostRoot:${JSON.stringify(process.env.RC_OPENCLAW_HOST_ROOT)},captureAtFetch:true,protocol:'openai-completions'});
    await fs.writeFile(${JSON.stringify(output)},JSON.stringify(record));`;
  await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script]);
  const record = JSON.parse(await fs.readFile(output, 'utf8'));
  assert.equal(record.networkRequests, 0); assert.equal(record.authenticationLoaded, false);
  assert.equal(record.wireCaptured.length, 2);
  assert(record.wireCaptured.every(frame => frame.pathname === '/api/coding/paas/v4/chat/completions'));
  assert(record.wireCaptured.every(frame => frame.payload.stream_options.include_usage === true));
  assert(record.wireCaptured[1].payload.messages.some(message => message.role === 'tool' && message.content.includes('export const next')));
});
