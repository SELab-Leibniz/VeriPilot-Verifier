import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { recordingUpstream } from '../scripts/bench/run-harbor-gateway-pilot.mjs';
const credential = 'fictional-upstream-capability-for-tests';
const digest = value => createHash('sha256').update(value).digest('hex');
async function fixture(t, chunks) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'harbor-recording-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let wires = 0;
  const upstream = recordingUpstream(credential, directory, { fetchImpl: async (url, init) => {
    assert.equal(url, 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions');
    assert.equal(init.headers.authorization, `Bearer ${credential}`);
    return new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } }),
      { headers: { 'content-type': 'text/event-stream' } });
  } });
  const response = await upstream({ body: Buffer.from('{"model":"glm-5.3"}'), onWireDispatch: () => { wires++; } });
  return { directory, response, wires: () => wires };
}

test('recorded upstream preserves exact normal bytes, including fragmented UTF-8, while forwarding', async t => {
  const source = Buffer.from('data: {"content":"虚构响应"}\n\ndata: [DONE]\n\n');
  const f = await fixture(t, Array.from(source, byte => Uint8Array.of(byte)));
  assert.deepEqual(Buffer.from(await f.response.arrayBuffer()), source); assert.equal(f.wires(), 1);
  assert.deepEqual(await fs.readFile(path.join(f.directory, 'response-1.body')), source);
  const metadata = JSON.parse(await fs.readFile(path.join(f.directory, 'response-1.metadata.json'), 'utf8'));
  assert.equal(metadata.sourceSha256, digest(source)); assert.equal(metadata.storedSha256, digest(source));
  assert.equal(metadata.complete, true); assert.equal(metadata.credentialRedacted, false);
});

test('a reflected credential split across arbitrary chunks fails before the full secret is forwarded or stored', async t => {
  for (const split of [1, Math.floor(credential.length / 2), credential.length - 1]) {
    const source = Buffer.from('data: prefix ' + credential + ' suffix\n\n');
    const boundary = 'data: prefix '.length + split;
    const f = await fixture(t, [source.subarray(0, boundary), source.subarray(boundary)]);
    const reader = f.response.body.getReader(), received = [];
    await assert.rejects(async () => {
      while (true) { const { value, done } = await reader.read(); if (done) break; received.push(Buffer.from(value)); }
    }, { code: 'PILOT_UPSTREAM_AUTH_REFLECTION' });
    assert(!Buffer.concat(received).includes(Buffer.from(credential)));
    const stored = await fs.readFile(path.join(f.directory, 'response-1.partial'));
    assert(!stored.includes(Buffer.from(credential)));
    const metadata = JSON.parse(await fs.readFile(path.join(f.directory, 'response-1.metadata.json'), 'utf8'));
    assert.equal(metadata.complete, false); assert.equal(metadata.credentialRedacted, true);
    assert.equal(metadata.sourceSha256, digest(source)); assert.equal(f.wires(), 1);
  }
});
