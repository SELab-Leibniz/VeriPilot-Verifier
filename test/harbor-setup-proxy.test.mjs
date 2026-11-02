// Real HTTP/TCP ports with controlled targets. No account/model is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createHarborSetupProxy } from '../scripts/helpers/harbor-setup-proxy.mjs';
import { createPilotPhaseController } from '../scripts/bench/run-harbor-gateway-pilot.mjs';
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise(resolve => server.close(resolve));
function access(proxy, target, auth = true) {
  const url = new URL(proxy.url), authorization = 'Basic ' + Buffer.from(`${url.username}:${url.password}`).toString('base64');
  return new Promise((resolve, reject) => {
    const request = http.get({ host: url.hostname, port: url.port, path: target,
      headers: auth ? { 'proxy-authorization': typeof auth === 'string' ? auth : authorization } : {} }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.once('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    }); request.once('error', reject);
  });
}

test('setup HTTP preserves bytes and strips disposable proxy auth; wrong caps/targets never reach upstream', async t => {
  let calls = 0; const bytes = Buffer.from([0, 1, 127, 128, 255]);
  const target = http.createServer((request, response) => { calls++; assert.equal(request.headers['proxy-authorization'], undefined); response.end(bytes); });
  const port = await listen(target), proxy = await createHarborSetupProxy({ bind: '127.0.0.1', advertisedHost: '127.0.0.1', allowHosts: ['127.0.0.1'], httpPorts: [port] });
  t.after(async () => { await proxy.close(); await close(target); });
  const result = await access(proxy, `http://127.0.0.1:${port}/public-package`); assert.equal(result.status, 200); assert.deepEqual(result.body, bytes);
  const challenge = await access(proxy, `http://127.0.0.1:${port}/`, false);
  assert.equal(challenge.status, 407);
  assert.equal(challenge.headers['proxy-authenticate'], 'Basic realm="rc-setup"');
  const url = new URL(proxy.url), expectedAuthLength = ('Basic ' + Buffer.from(`${url.username}:${url.password}`).toString('base64')).length;
  assert.equal((await access(proxy, `http://127.0.0.1:${port}/`, 'é'.repeat(expectedAuthLength))).status, 407);
  assert.equal((await access(proxy, 'http://example.invalid/')).status, 403); assert.equal(calls, 1);
});

test('unauthenticated CONNECT advertises Basic auth before any upstream connection', async t => {
  let calls = 0;
  const target = net.createServer(socket => { calls++; socket.destroy(); });
  const port = await listen(target);
  const proxy = await createHarborSetupProxy({ bind: '127.0.0.1', advertisedHost: '127.0.0.1', allowHosts: ['127.0.0.1'], connectPorts: [port] });
  t.after(async () => { await proxy.close(); await close(target); });
  const url = new URL(proxy.url);
  const response = await new Promise((resolve, reject) => {
    const request = http.request({ host: url.hostname, port: url.port, method: 'CONNECT', path: `127.0.0.1:${port}` });
    request.on('connect', (result, socket) => { socket.destroy(); resolve(result); });
    request.on('error', reject); request.end();
  });
  assert.equal(response.statusCode, 407);
  assert.equal(response.headers['proxy-authenticate'], 'Basic realm="rc-setup"');
  assert.equal(calls, 0);
});

test('authenticated CONNECT preserves opaque bytes and close revokes live tunnels', async t => {
  const target = net.createServer(socket => socket.pipe(socket)); const port = await listen(target);
  const proxy = await createHarborSetupProxy({ bind: '127.0.0.1', advertisedHost: '127.0.0.1', allowHosts: ['127.0.0.1'], connectPorts: [port] });
  t.after(async () => { await proxy.close(); await close(target); });
  const url = new URL(proxy.url), bytes = Buffer.from([22, 3, 3, 0, 17, 255]);
  const client = await new Promise((resolve, reject) => {
    const request = http.request({ host: url.hostname, port: url.port, method: 'CONNECT', path: `127.0.0.1:${port}`,
      headers: { 'proxy-authorization': 'Basic ' + Buffer.from(`${url.username}:${url.password}`).toString('base64') } });
    request.on('connect', (response, socket) => { assert.equal(response.statusCode, 200); resolve(socket); }); request.on('error', reject); request.end();
  });
  const received = new Promise(resolve => client.once('data', resolve)); client.write(bytes); assert.deepEqual(await received, bytes);
  const ended = new Promise(resolve => client.once('close', resolve)); await proxy.close(); await ended;
  assert.equal(proxy.snapshot().closed, true); assert.equal(proxy.snapshot().activeSockets, 0);
});

test('the actual phase-start callback revokes installation access before a model ticket is issued', async t => {
  const proxy = await createHarborSetupProxy({ bind: '127.0.0.1', advertisedHost: '127.0.0.1' });
  const controller = await createPilotPhaseController({ officialWallMs: 10000, rcEnabled: false,
    limits: { usd: 20, requests: 2, wallMs: 10000, inputPerRequest: 262144, outputPerRequest: 32768, totalInput: 524288, totalOutput: 65536, payloadBytes: 131072 },
    upstream: () => { throw new Error('No model call allowed'); }, onPhaseStart: () => proxy.close() });
  t.after(async () => { await controller.close(); await proxy.close(); });
  const descriptor = controller.descriptor();
  const response = await fetch(descriptor.startUrl, { method: 'POST', headers: { authorization: `Bearer ${descriptor.controlToken}` },
    body: JSON.stringify({ phaseStartedAt: Date.now(), officialWallMs: 10000, rcEnabled: false }) });
  assert.equal(response.status, 200); assert.equal(proxy.snapshot().closed, true); assert.equal(proxy.snapshot().activeSockets, 0);
  assert.equal(controller.receipt().budget.requests, 0); assert.equal(controller.receipt().wireDispatchAttempts, 0);
});

test('idle CONNECT timeout closes both sides without waiting for whole-proxy shutdown', async t => {
  const peers = new Set();
  const target = net.createServer(socket => { peers.add(socket); socket.once('close', () => peers.delete(socket)); });
  const port = await listen(target);
  const proxy = await createHarborSetupProxy({ bind: '127.0.0.1', advertisedHost: '127.0.0.1', allowHosts: ['127.0.0.1'], connectPorts: [port], idleTimeoutMs: 50 });
  t.after(async () => { await proxy.close(); for (const socket of peers) socket.destroy(); await close(target); });
  const url = new URL(proxy.url);
  const client = await new Promise((resolve, reject) => {
    const request = http.request({ host: url.hostname, port: url.port, method: 'CONNECT', path: `127.0.0.1:${port}`,
      headers: { 'proxy-authorization': 'Basic ' + Buffer.from(`${url.username}:${url.password}`).toString('base64') } });
    request.on('connect', (response, socket) => { assert.equal(response.statusCode, 200); resolve(socket); }); request.on('error', reject); request.end();
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Idle tunnel client remained open')), 1000);
    client.once('close', () => { clearTimeout(timer); resolve(); }); client.resume();
  });
  assert.equal(client.destroyed, true); assert.equal(proxy.snapshot().closed, false);
});
