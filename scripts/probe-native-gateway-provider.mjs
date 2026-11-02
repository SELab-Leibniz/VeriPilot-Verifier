// Model-free qualification of the existing native Gateway with the Coding
// Plan provider. The placeholder never authenticates to an external service.
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createNativeGatewayEvaluation } from './helpers/native-gateway-evaluation.mjs';

const args = process.argv.slice(2), value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : null;
if (!value('--host-root') || !value('--output')) throw new Error('Use --host-root and a fresh --output. This probe never calls real models.');
const hostRoot = path.resolve(value('--host-root')), outputRoot = path.resolve(value('--output'));
await fs.mkdir(path.dirname(outputRoot), { recursive: true }); await fs.mkdir(outputRoot);
const sourceRoot = fileURLToPath(new URL('../', import.meta.url)), projectRoot = path.join(outputRoot, 'project');
const placeholder = 'offline-gateway-placeholder-not-an-api-key';
const oldFetch = globalThis.fetch, port = '__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__', oldRuntime = globalThis[port];
const oldConnect = net.Socket.prototype.connect;
const undici = createRequire(path.join(hostRoot, 'package.json'))('undici');
let deniedExternalAttempts = 0, gateway, result;
const deniedDestinations = [];
const local = host => ['127.0.0.1', '::1', '[::1]', 'localhost'].includes(host);
const guardedFetch = original => async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!local(url.hostname)) { deniedExternalAttempts++; deniedDestinations.push({ kind: 'fetch', origin: url.origin, method: init?.method ?? input?.method ?? 'GET' }); throw new Error('OFFLINE_GATEWAY_EXTERNAL_FETCH_DENIED'); }
  return original(input, init);
};
globalThis.fetch = guardedFetch(oldFetch);
globalThis[port] = { ...undici, fetch: guardedFetch(undici.fetch) };
net.Socket.prototype.connect = function (...options) {
  const normalized = Array.isArray(options[0]) ? options[0] : options;
  const option = normalized[0], host = typeof option === 'object' ? option.host ?? 'localhost'
    : typeof normalized[1] === 'string' ? normalized[1] : 'localhost';
  if (!local(host) || typeof option === 'object' && option.path || typeof option === 'string') {
    deniedExternalAttempts++; deniedDestinations.push({ kind: 'socket', host, ipc: Boolean(option?.path) || typeof option === 'string' });
    throw new Error('OFFLINE_GATEWAY_EXTERNAL_SOCKET_DENIED');
  }
  return oldConnect.apply(this, options);
};
try {
  gateway = await createNativeGatewayEvaluation({ hostRoot, sourceRoot, outputRoot, projectRoot,
    confineBusinessFiles: true,
    provider: { api: 'openai-completions', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', model: 'glm-5.3' },
    providerGuard: { kind: 'offline_native_gateway_guard', credential: () => placeholder } });
  const health = await gateway.request('health', {});
  if (!health.ok) throw new Error('The actual authenticated Gateway did not answer health.');
  const sessionId = randomUUID(), sessionKey = `agent:main:provider-probe-${sessionId}`;
  const sessionFile = path.join(gateway.root, 'transport-session.jsonl'), marker = 'Fictional model-free Gateway transport input.';
  await fs.writeFile(sessionFile, [
    { type: 'session', version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: projectRoot },
    { type: 'message', id: randomUUID(), timestamp: new Date().toISOString(),
      message: { role: 'user', content: [{ type: 'text', text: marker }], timestamp: Date.now() } },
  ].map(JSON.stringify).join('\n') + '\n');
  const scope = { agentId: 'main', sessionKey, storePath: gateway.config.session.store };
  await gateway.runtime.agent.session.upsertSessionEntry({ ...scope, entry: { sessionId, sessionFile, spawnedCwd: projectRoot, updatedAt: Date.now() } });
  const saved = await gateway.runtime.agent.session.getSessionEntry({ ...scope, readConsistency: 'latest' });
  const read = await gateway.runtime.subagent.getSession({ sessionKey });
  if (saved?.sessionId !== sessionId || !JSON.stringify(read?.messages).includes(marker)) throw new Error('Actual host session persistence/readback failed.');
  await gateway.drain();
  const metrics = gateway.metrics();
  if (metrics.modelStarts.length || metrics.providerRequests || !gateway.hooks.hasHooks('before_agent_finalize'))
    throw new Error('The model-free probe started a model or lacks RC finalization hooks.');
  result = { state: 'GATEWAY_PROVIDER_TRANSPORT_QUALIFIED_NO_MODELS',
    modelRef: gateway.modelRef, authenticatedGatewayHealth: true, sessionPersisted: true, originalTranscriptRead: true,
    finalizationHook: true, metrics,
    limitations: ['No provider API request, semantic review, business repair or official benchmark was run.',
      'The normal SDK environment credential resolver is checked separately; real Chat Completions auth through Gateway remains unqualified.'] };
} catch (error) {
  result = { state: 'FAILED', error: { code: error.code ?? 'PROBE_FAILED', message: String(error.message).replaceAll(placeholder, '[PLACEHOLDER]') } };
} finally {
  try { await gateway?.close(); }
  finally {
    globalThis.fetch = oldFetch;
    if (oldRuntime === undefined) delete globalThis[port]; else globalThis[port] = oldRuntime;
    net.Socket.prototype.connect = oldConnect;
  }
}
const matches = [];
async function scan(root) {
  for (const item of await fs.readdir(root, { withFileTypes: true })) {
    const file = path.join(root, item.name);
    if (item.isDirectory()) await scan(file);
    else if (item.isFile() && (await fs.readFile(file)).includes(Buffer.from(placeholder))) matches.push(path.relative(outputRoot, file));
  }
}
await scan(outputRoot);
Object.assign(result, { deniedExternalAttempts, deniedDestinations, realProviderRequests: 0, credentialPlaceholderFiles: matches, outputRoot });
// The pinned server attempts GET-only pricing and version metadata at startup.
// These remain blocked before dispatch; they are not model/provider calls.
const metadataOrigins = new Set(['https://openrouter.ai', 'https://raw.githubusercontent.com', 'https://registry.npmjs.org']);
const unexpectedDenied = deniedDestinations.filter(item => item.kind !== 'fetch' || item.method !== 'GET' || !metadataOrigins.has(item.origin));
result.unexpectedNetworkAttempts = unexpectedDenied.length;
result.blockedStartupMetadataRequests = deniedDestinations.length - unexpectedDenied.length;
if (unexpectedDenied.length || matches.length) result.state = 'FAILED';
await fs.writeFile(path.join(outputRoot, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ state: result.state, deniedExternalAttempts, credentialPlaceholderFiles: matches, outputRoot }));
process.exit(result.state === 'GATEWAY_PROVIDER_TRANSPORT_QUALIFIED_NO_MODELS' ? 0 : 1);
