// Real pinned Gateway/SDK, isolated state, fictional local responses only.
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { harborGatewayConfig } from './bench/harbor-gateway-runner.mjs';
import { createHarborProviderRelay } from './helpers/harbor-provider-relay.mjs';

const [hostRoot, output, pluginRoot] = process.argv.slice(2);
if (!hostRoot || !output || !pluginRoot) throw new Error('Pass hostRoot, fresh output and frozen artifact. No real provider is used.');
await fs.mkdir(output); const project = path.join(output, 'project'); await fs.mkdir(project);
const oldFetch = globalThis.fetch, depsKey = '__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__', oldDeps = globalThis[depsKey];
const undici = createRequire(path.join(hostRoot, 'package.json'))('undici'), denied = [];
const guard = original => async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    denied.push({ origin: url.origin, method: init?.method ?? input?.method ?? 'GET' }); throw new Error('OFFLINE_EXTERNAL_FETCH_DENIED');
  }
  return original(input, init);
};
globalThis.fetch = guard(oldFetch); globalThis[depsKey] = { ...undici, fetch: guard(undici.fetch) };
let relay, gateway, calls = 0, firstStarted, releaseFirst;
const first = new Promise(resolve => { firstStarted = resolve; }), held = new Promise(resolve => { releaseFirst = resolve; });
const load = file => import(pathToFileURL(path.join(hostRoot, file)).href);
const envNames = ['OPENCLAW_STATE_DIR', 'OPENCLAW_CONFIG_PATH', 'OPENCLAW_GATEWAY_TOKEN', 'OPENCLAW_SKIP_CRON', 'OPENAI_API_KEY'];
const savedEnv = new Map(envNames.map(name => [name, process.env[name]])), oldArgv = process.argv[1];
let result;
try {
  const pkg = JSON.parse(await fs.readFile(path.join(hostRoot, 'package.json')));
  if (pkg.version !== '2026.7.1-2') throw new Error('PINNED_HOST_REQUIRED');
  relay = await createHarborProviderRelay({ limits: { usd: 30, requests: 4, maxConcurrent: 4, wallMs: 90000,
    inputPerRequest: 532480, outputPerRequest: 32768, totalInput: 2129920, totalOutput: 131072 }, payloadBytes: 524288,
    upstream: async ({ onWireDispatch, signal }) => {
      onWireDispatch(); const sequence = ++calls;
      if (sequence === 1) { firstStarted(); await Promise.race([held, new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))]); }
      const event = body => 'data: ' + JSON.stringify(body) + '\n\n';
      const base = { id: 'fictional-' + sequence, object: 'chat.completion.chunk', created: 1, model: 'glm-5.3' };
      return new Response(event({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'READY' }, finish_reason: null }] })
        + event({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
        + event({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }) + 'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } });
    } });
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const config = harborGatewayConfig({ root: output, projectRoot: project, pluginRoot, ticket: relay.ticket(), port, rcEnabled: false });
  const changed = { OPENCLAW_STATE_DIR: path.join(output, 'state'), OPENCLAW_CONFIG_PATH: path.join(output, 'config.json'),
    OPENCLAW_GATEWAY_TOKEN: randomUUID(), OPENCLAW_SKIP_CRON: '1', OPENAI_API_KEY: relay.ticket().placeholderCredential };
  for (const [name, value] of Object.entries(changed)) process.env[name] = value;
  process.argv[1] = path.join(hostRoot, 'openclaw.mjs'); await fs.writeFile(changed.OPENCLAW_CONFIG_PATH, JSON.stringify(config));
  gateway = await (await load('dist/server-BnSQQ3Aa.js')).startGatewayServer(port, { bind: 'loopback', host: '127.0.0.1', controlUiEnabled: false });
  const { callGateway } = await load('dist/call-BZWJ3eG1.js');
  const request = (method, params) => callGateway({ url: `ws://127.0.0.1:${port}`, token: changed.OPENCLAW_GATEWAY_TOKEN, config, method, params, timeoutMs: 30000 });
  const begin = async label => {
    const created = await request('sessions.create', { key: 'agent:main:concurrency-' + randomUUID(), agentId: 'main', label });
    const runId = randomUUID();
    await request('chat.send', { sessionKey: created.key, message: 'Fictional transport probe. Reply READY without tools.', idempotencyKey: runId, deliver: false, thinking: 'off', timeoutMs: 60000 });
    return { sessionKey: created.key, runId };
  };
  const a = await begin('Delayed fictional request'); await Promise.race([first, new Promise((_, reject) => setTimeout(() => reject(new Error('NO_FIRST_SDK_REQUEST')), 15000))]);
  const start = Date.now(), b = await begin('Independent fictional request');
  const bTerminal = await request('agent.wait', { runId: b.runId, timeoutMs: 10000 });
  const independentMs = Date.now() - start;
  if (bTerminal.status !== 'ok' || calls !== 2 || !relay.snapshot().budget.active) throw new Error('NATIVE_SDK_REQUESTS_NOT_INDEPENDENT');
  await new Promise(resolve => setTimeout(resolve, 20000));
  releaseFirst(); const aTerminal = await request('agent.wait', { runId: a.runId, timeoutMs: 10000 });
  if (aTerminal.status !== 'ok') throw new Error('FIRST_NATIVE_REQUEST_NOT_SETTLED');
  await relay.close();
  const s = relay.snapshot();
  if (s.budget.requests !== 2 || s.budget.halted || s.budget.inFlightRequests || s.budget.committedInputTokens !== 20) throw new Error('METERING_NOT_SETTLED');
  result = { state: 'ACTUAL_NATIVE_SDK_CONCURRENCY_QUALIFIED_SYNTHETIC_UPSTREAM', hostVersion: pkg.version,
    realProviderRequests: 0, syntheticRequests: calls, independentMs, firstTerminal: aTerminal, secondTerminal: bTerminal,
    maxConcurrent: s.maxConcurrent, budget: s.budget, blockedMetadata: denied, isolatedState: true,
    limitations: ['Independent native sessions qualify transport; actual RC semantics and live provider concurrency require separate evidence.'] };
} catch (error) { result = { state: 'FAILED', code: error.code ?? null, message: error.message, realProviderRequests: 0, syntheticRequests: calls }; }
finally {
  releaseFirst(); await gateway?.close({ reason: 'Fictional transport qualification finished' }); await relay?.close();
  globalThis.fetch = oldFetch; if (oldDeps === undefined) delete globalThis[depsKey]; else globalThis[depsKey] = oldDeps;
  process.argv[1] = oldArgv; for (const [name, value] of savedEnv) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
}
await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ state: result.state, realProviderRequests: 0, syntheticRequests: calls, code: result.code, message: result.message }));
process.exit(result.state === 'FAILED' ? 1 : 0);
