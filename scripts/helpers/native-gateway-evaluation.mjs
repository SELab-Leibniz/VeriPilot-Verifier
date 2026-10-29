// Development only. Start the pinned installed host with an isolated profile;
// no installed host source/configuration or existing user sessions are changed.
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { buildPlugin } from '../../lib/plugin-builder.mjs';
import { installProviderFetchTiming } from './provider-fetch-timing.mjs';
import { TASK_TOOL_NAMES, BASELINE_TOOL_NAMES } from '../../lib/openclaw/tool-contracts.mjs';
import { EXPERIMENT_SESSION_RESET } from '../bench/session-continuity.mjs';

export function nativeModelContextWindow(value = 128000) {
  const tokens = Number(value);
  if (!Number.isSafeInteger(tokens) || tokens < 65536 || tokens > 2097152)
    throw new Error('Model context capacity must be an integer from 65536 to 2097152 tokens.');
  return tokens;
}

async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const port = socket.address().port;
  await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  return port;
}

export async function createNativeGatewayEvaluation({ hostRoot, projectRoot, outputRoot, sourceRoot, reuseProfile = false, injectDefect = false,
  prebuiltPluginRoot = null, extraPluginPaths = [], businessToolNames = ['read', 'write', 'edit'], confineBusinessFiles = false,
  phaseTimeoutMs = null, unlimitedBusiness = false, disableMemoryFlush = false, preserveSessionHistory = false, contextWindowTokens }) {
  const contextWindow = nativeModelContextWindow(contextWindowTokens);
  if (contextWindowTokens !== undefined && !process.env.ANTHROPIC_BASE_URL)
    throw new Error('An explicit model context capacity requires the configured custom provider definition.');
  if (phaseTimeoutMs !== null && (!Number.isSafeInteger(phaseTimeoutMs) || phaseTimeoutMs < 1000 || phaseTimeoutMs > 3600000
    || phaseTimeoutMs % 1000 !== 0)) throw new Error('Invalid isolated phase timeout.');
  const pkg = JSON.parse(await fs.readFile(path.join(hostRoot, 'package.json'), 'utf8'));
  if (pkg.name !== 'openclaw' || pkg.version !== '2026.7.1-2') throw new Error('This gateway probe requires installed OpenClaw 2026.7.1-2.');
  // This pinned host defines overrideMs=0 as its native no-timeout sentinel.
  // Defaults must use that same sentinel for automatic business corrections;
  // private reviewers still receive their explicit project role deadlines.
  const noTimeoutMs = unlimitedBusiness ? (await import(pathToFileURL(path.join(hostRoot, 'dist/timeout-0Cw4kcol.js')).href)).n({ overrideMs: 0 }) : null;
  const root = path.join(outputRoot, 'native-host');
  await fs.mkdir(root, { recursive: true }); await fs.mkdir(projectRoot, { recursive: true });
  const port = await freePort(), model = process.env.RC_EVAL_NATIVE_MODEL ?? process.env.ANTHROPIC_MODEL ?? 'transport-only';
  process.env.OPENCLAW_STATE_DIR = path.join(root, 'state');
  process.env.OPENCLAW_CONFIG_PATH = path.join(root, 'config.json');
  process.env.OPENCLAW_GATEWAY_TOKEN = randomBytes(32).toString('hex');
  process.env.OPENCLAW_SKIP_CRON = '1';
  if (process.env.ANTHROPIC_AUTH_TOKEN) process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_AUTH_TOKEN;
  process.argv[1] = path.join(hostRoot, 'openclaw.mjs');
  const pluginRoot = prebuiltPluginRoot ? await fs.realpath(prebuiltPluginRoot) : reuseProfile ? await fs.realpath(path.join(root, 'build/runtime-corrector-openclaw'))
    : await buildPlugin({ host: 'openclaw', sourceRoot, outputRoot: path.join(root, 'build') });
  if (unlimitedBusiness) {
    const manifest = JSON.parse(await fs.readFile(path.join(pluginRoot, 'openclaw.plugin.json'), 'utf8'));
    if (!manifest.configSchema?.properties?.businessRunTimeoutMs) throw new Error('This frozen plugin cannot disable RC business-correction deadlines; do not silently claim an unbounded host.');
  }
  let config = { logging: { level: 'warn', consoleLevel: 'silent', file: path.join(root, 'host.log') },
    gateway: { mode: 'local', port, bind: 'loopback', auth: { mode: 'token' }, controlUi: { enabled: false }, reload: { mode: 'off' } },
    discovery: { mdns: { mode: 'off' } }, cron: { enabled: false }, diagnostics: { enabled: true }, browser: { enabled: false },
    agents: { defaults: { workspace: projectRoot, model: { primary: `anthropic/${model}` }, sandbox: { mode: 'off' }, heartbeat: { every: '0m' },
      ...(unlimitedBusiness ? { timeoutSeconds: Math.floor(noTimeoutMs / 1000) } : phaseTimeoutMs ? { timeoutSeconds: phaseTimeoutMs / 1000 } : {}),
      ...(disableMemoryFlush ? { compaction: { memoryFlush: { enabled: false } } } : {}) },
      list: [{ id: 'main', agentDir: path.join(root, 'agent'),
        tools: { allow: [...new Set([...businessToolNames, 'runtime_corrector', 'rc_progress', ...TASK_TOOL_NAMES, ...BASELINE_TOOL_NAMES])] } }] },
    ...(confineBusinessFiles ? { tools: { fs: { workspaceOnly: true } } } : {}),
    session: { store: path.join(root, 'sessions.json'), ...(preserveSessionHistory ? { reset: EXPERIMENT_SESSION_RESET } : {}) },
    ...(process.env.ANTHROPIC_BASE_URL ? { models: { mode: 'replace', providers: { anthropic: {
      api: 'anthropic-messages', baseUrl: process.env.ANTHROPIC_BASE_URL,
      models: [{ id: model, name: model, input: ['text'], reasoning: false, contextWindow, maxTokens: 32768 }],
    } } } } : {}),
    plugins: { enabled: true, allow: ['runtime-corrector'], load: { paths: [pluginRoot] }, entries: {
      'runtime-corrector': { enabled: true, hooks: { allowConversationAccess: true, allowPromptInjection: true },
        ...(phaseTimeoutMs ? { config: { hookTimeoutMs: phaseTimeoutMs, reviewerTimeoutMs: phaseTimeoutMs,
          ...(unlimitedBusiness ? { businessRunTimeoutMs: 0 } : {}) } } : {}) },
    } },
  };
  for (const extra of extraPluginPaths) {
    if (!extra || !/^[a-z][a-z0-9-]*$/u.test(extra.id)) throw new Error('Invalid experiment plugin identity');
    config.plugins.allow.push(extra.id); config.plugins.load.paths.push(await fs.realpath(extra.path));
    config.plugins.entries[extra.id] = { enabled: true };
  }
  if (reuseProfile) {
    config = JSON.parse(await fs.readFile(process.env.OPENCLAW_CONFIG_PATH, 'utf8'));
    if (contextWindowTokens !== undefined && config.models?.providers?.anthropic?.models?.find(item => item.id === model)?.contextWindow !== contextWindow)
      throw new Error('Explicit model context capacity differs from the captured profile.');
    config.gateway = { ...config.gateway, port, bind: 'loopback', auth: { mode: 'token' } };
  }
  if (unlimitedBusiness) {
    config.agents.defaults.timeoutSeconds = Math.floor(noTimeoutMs / 1000);
    config.plugins.entries['runtime-corrector'].config = { ...config.plugins.entries['runtime-corrector'].config, businessRunTimeoutMs: 0 };
  }
  if (disableMemoryFlush) config.agents.defaults.compaction = { ...config.agents.defaults.compaction,
    memoryFlush: { ...config.agents.defaults.compaction?.memoryFlush, enabled: false } };
  if (injectDefect && !reuseProfile) {
    // A local experiment plugin corrupts only this fixture's delivery, once,
    // immediately before the REAL original host run finalizes. Host terminal,
    // RC dispatch, business repair and quota observation remain unmodified.
    const fixtureRoot = path.join(root, 'fault-fixture'); await fs.mkdir(fixtureRoot, { recursive: true });
    await fs.writeFile(path.join(fixtureRoot, 'package.json'), JSON.stringify({ name: 'rc-fault-fixture', version: '1.0.0', type: 'module',
      openclaw: { extensions: ['./index.mjs'] } }));
    await fs.writeFile(path.join(fixtureRoot, 'openclaw.plugin.json'), JSON.stringify({ id: 'rc-fault-fixture', name: 'RC isolated fault injection',
      main: './index.mjs', version: '1.0.0', configSchema: { type: 'object', additionalProperties: false, properties: {} } }));
    await fs.writeFile(path.join(fixtureRoot, 'index.mjs'), `import fs from 'node:fs/promises'; import path from 'node:path'; import {createHash} from 'node:crypto';
const root=${JSON.stringify(root)}, project=${JSON.stringify(projectRoot)};
export default {id:'rc-fault-fixture',name:'RC isolated fault injection',register(api){api.on('before_agent_finalize',async(event,ctx)=>{
 const target=await fs.readFile(path.join(root,'fault-target.json'),'utf8').then(JSON.parse,()=>null);
 if(target)await fs.writeFile(path.join(root,'fault-hook-observation.json'),JSON.stringify({eventRunId:event.runId,contextRunId:ctx.runId,workspaceDir:ctx.workspaceDir,targetRunId:target.runId}));
 if(!target||(event.runId??ctx.runId)!==target.runId||path.resolve(ctx.workspaceDir??'')!==project)return;
 const receipt=path.join(root,'fault-injection.json');if(await fs.access(receipt).then(()=>true,()=>false))return;
 const file=path.join(project,'app.mjs'),before=await fs.readFile(file),after=Buffer.from('export const accept = value => value;\\n');
 await fs.writeFile(file,after);const hash=b=>createHash('sha256').update(b).digest('hex');
 await fs.writeFile(receipt,JSON.stringify({kind:'program fault injection before actual original host finalization',runId:target.runId,at:Date.now(),file,beforeHash:hash(before),afterHash:hash(after)}));
},{priority:1000});}};`);
    config.plugins.allow.push('rc-fault-fixture'); config.plugins.load.paths.push(fixtureRoot);
    config.plugins.entries['rc-fault-fixture'] = { enabled: true, hooks: { allowConversationAccess: true, allowPromptInjection: true } };
  }
  // The random loopback Gateway token lives in this process only. Existing
  // provider credentials are inherited, not embedded in this saved config.
  await fs.writeFile(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(config, null, 2));
  const timing = process.env.ANTHROPIC_BASE_URL ? await installProviderFetchTiming({
    file: path.join(root, reuseProfile ? 'restart-provider-fetch-timing.jsonl' : 'provider-fetch-timing.jsonl'), origin: new URL(process.env.ANTHROPIC_BASE_URL).origin,
  }) : null;
  let gateway, unsubscribe;
  const modelStarts = [];
  try {
    const load = relative => import(pathToFileURL(path.join(hostRoot, relative)).href);
    const { startGatewayServer } = await load('dist/server-BnSQQ3Aa.js');
    gateway = await startGatewayServer(port, { bind: 'loopback', host: '127.0.0.1', controlUiEnabled: false });
    const { createPluginRuntime } = await load('dist/plugins/runtime/index.js');
    const { getGlobalHookRunner, getGlobalPluginRegistry } = await load('dist/plugins/hook-runner-global.js');
    const registry = getGlobalPluginRegistry(), plugin = registry.plugins.find(item => item.id === 'runtime-corrector');
    if (plugin?.status !== 'loaded') throw new Error('The actual Gateway did not load the built RC plugin.');
    for (const extra of extraPluginPaths) if (registry.plugins.find(item => item.id === extra.id)?.status !== 'loaded')
      throw new Error(`Experiment capability failed to load before any business request: ${extra.id}`);
    if (injectDefect && registry.plugins.find(item => item.id === 'rc-fault-fixture')?.status !== 'loaded')
      throw new Error('The isolated fault-injection plugin was not loaded; no business model should be started.');
    const runtime = createPluginRuntime({ allowGatewaySubagentBinding: true });
    if (!await runtime.gateway.isAvailable()) throw new Error('The actual in-process Gateway dispatch port is unavailable.');
    const diagnostics = await load('dist/plugin-sdk/diagnostic-runtime.js');
    unsubscribe = diagnostics.onInternalDiagnosticEvent(event => {
      if (event.type === 'model.call.started') modelStarts.push({ runId: event.runId, sessionId: event.sessionId, sessionKey: event.sessionKey, ts: event.ts, seq: event.seq });
    });
    return { runtime, hooks: getGlobalHookRunner(), registry, config, model, pluginRoot, root, port, faultInjection: injectDefect,
      async request(method, params) {
        const { callGateway } = await load('dist/call-BZWJ3eG1.js');
        return callGateway({ url: `ws://127.0.0.1:${port}`, token: process.env.OPENCLAW_GATEWAY_TOKEN,
          config, method, params, timeoutMs: 30000,
          // Each request has a new connection. The isolated controller must
          // authenticate its exact-run abort as admin rather than its creator.
          ...(method === 'chat.abort' ? { scopes: ['operator.admin'] } : {}) });
      },
      setPhase: value => timing?.setPhase(value),
      async drain() { await diagnostics.waitForDiagnosticEventsDrained(); },
      metrics: () => ({ hostVersion: pkg.version, ownerPid: process.pid, providerRequests: timing?.requestCount ?? null, modelStarts: structuredClone(modelStarts), pluginStatus: plugin.status, isolatedState: root }),
      async close() { try { await gateway.close({ reason: 'Isolated RC acceptance probe finished' }); } finally { unsubscribe?.(); await timing?.close(); } },
    };
  } catch (error) { try { await gateway?.close({ reason: 'Isolated RC acceptance probe failed' }); } finally { unsubscribe?.(); await timing?.close(); } throw error; }
}
