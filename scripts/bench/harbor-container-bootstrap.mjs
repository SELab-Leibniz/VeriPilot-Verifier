// Execute only host health/session bootstrapping, never chat.send or a model.
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { createRequire } from 'node:module';
import { runHarborGatewayTrial } from './harbor-gateway-runner.mjs';
const spec = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
const local = host => ['127.0.0.1', '::1', '[::1]', 'localhost'].includes(host);
const oldFetch = globalThis.fetch, oldConnect = net.Socket.prototype.connect, key = '__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__', oldDeps = globalThis[key];
const undici = createRequire(path.join(spec.hostRoot, 'package.json'))('undici');
const denied = [];
const guard = original => async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!local(url.hostname)) { denied.push({ origin: url.origin, method: init?.method ?? input?.method ?? 'GET' }); throw new Error('NO_MODEL_BOOTSTRAP_EXTERNAL_FETCH_DENIED'); }
  return original(input, init);
};
globalThis.fetch = guard(oldFetch); globalThis[key] = { ...undici, fetch: guard(undici.fetch) };
net.Socket.prototype.connect = function (...options) {
  const normalized = Array.isArray(options[0]) ? options[0] : options, option = normalized[0];
  const host = typeof option === 'object' ? option.host ?? 'localhost' : typeof normalized[1] === 'string' ? normalized[1] : 'localhost';
  if (!local(host) || typeof option === 'object' && option.path || typeof option === 'string') throw new Error('NO_MODEL_BOOTSTRAP_EXTERNAL_SOCKET_DENIED');
  return oldConnect.apply(this, options);
};
try {
  const result = await runHarborGatewayTrial({ ...spec, probeOnly: true });
  const metadata = new Set(['https://registry.npmjs.org', 'https://openrouter.ai', 'https://raw.githubusercontent.com']);
  if (denied.some(row => row.method !== 'GET' || !metadata.has(row.origin))) throw new Error('Unexpected no-model network attempt');
  await fs.writeFile(spec.resultPath, JSON.stringify({ ...result, deniedStartupMetadata: denied }, null, 2));
} finally {
  globalThis.fetch = oldFetch; net.Socket.prototype.connect = oldConnect;
  if (oldDeps === undefined) delete globalThis[key]; else globalThis[key] = oldDeps;
}
process.exit(0);
