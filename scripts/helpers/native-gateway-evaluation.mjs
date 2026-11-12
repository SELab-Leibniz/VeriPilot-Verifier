// Development only. Start the pinned installed host with an isolated profile;
// no installed host source/configuration or existing user sessions are changed.
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { buildPlugin } from '../../lib/plugin-builder.mjs';
import { installProviderFetchTiming } from './provider-fetch-timing.mjs';
import { MAX_REVIEW_TIMEOUT_MS } from '../../lib/review-timeout.mjs';
import { TASK_TOOL_NAMES, BASELINE_TOOL_NAMES } from '../../lib/openclaw/tool-contracts.mjs';
import { EXPERIMENT_SESSION_RESET } from '../bench/session-continuity.mjs';

export function nativeModelContextWindow(value = 128000) {
  const tokens = Number(value);
  if (!Number.isSafeInteger(tokens) || tokens < 65536 || tokens > 2097152)
    throw new Error('Model context capacity must be an integer from 65536 to 2097152 tokens.');
  return tokens;
}

function validatePhaseTimeoutMs(phaseTimeoutMs) {
  if (phaseTimeoutMs !== null && (!Number.isSafeInteger(phaseTimeoutMs) || phaseTimeoutMs < 1000 || phaseTimeoutMs > MAX_REVIEW_TIMEOUT_MS
    || phaseTimeoutMs % 1000 !== 0)) throw new Error('Invalid isolated phase timeout.');
}

function localRelayUrl(value) {
  try { const u = new URL(value); return u.protocol === 'http:' && u.hostname === 'host.docker.internal'
    && /^[1-9]\d{0,4}$/u.test(u.port) && u.pathname === '/v1' && !u.username && !u.password && !u.search && !u.hash; }
  catch { return false; }
}

// A restored task may reconnect its disposable metered relay and adopt a new
// explicit finite silence budget. Model, API, context and thinking stay pinned.
export function nativeGatewayResumeProvider(captured, requested, { allowLocalRelayRebind = false } = {}) {
  const fail = () => { throw new Error('The explicit Gateway provider differs from the captured profile.'); };
  if (!captured || !requested) fail();
  const { baseUrl: oldUrl, timeoutSeconds: _oldTimeout, ...oldIdentity } = captured;
  const { baseUrl: newUrl, timeoutSeconds, ...newIdentity } = requested;
  if (!isDeepStrictEqual(oldIdentity, newIdentity)) fail();
  if (oldUrl !== newUrl && !(allowLocalRelayRebind && localRelayUrl(oldUrl) && localRelayUrl(newUrl))) fail();
  if (timeoutSeconds !== undefined && (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1
    || timeoutSeconds > MAX_REVIEW_TIMEOUT_MS / 1000)) fail();
  return { ...captured, ...requested };
}

export function nativeGatewayCodingProvider(provider, contextWindow = 128000, phaseTimeoutMs = null, { allowLocalRelay = false } = {}) {
  const relay = allowLocalRelay && localRelayUrl(provider?.baseUrl);
  if (provider?.api !== 'openai-completions'
    || !['https://open.bigmodel.cn/api/coding/paas/v4', 'https://ark.cn-beijing.volces.com/api/coding/v3'].includes(provider.baseUrl) && !relay
    || !/^[\w.:-]+$/u.test(provider.model ?? '')
    || (provider.baseUrl === 'https://open.bigmodel.cn/api/coding/paas/v4' || relay) && !['glm-5.3', 'glm-5.3-flash'].includes(provider.model)
    || Object.keys(provider).some(key => !['api', 'baseUrl', 'model'].includes(key)))
    throw new Error('Unsupported explicit Gateway provider definition. Credentials belong only to the transient provider guard.');
  if (nativeModelContextWindow(contextWindow) > 128000)
    throw new Error('The Coding Plan probe retains its pinned 128000-token context ceiling.');
  validatePhaseTimeoutMs(phaseTimeoutMs);
  const flash = provider.model === 'glm-5.3-flash';
  return { providerId: 'openai', model: provider.model, definition: {
    api: provider.api, baseUrl: provider.baseUrl,
    // The host caps this public idle/first-event policy by each run's remainder.
    ...(phaseTimeoutMs !== null ? { timeoutSeconds: phaseTimeoutMs / 1000 } : {}),
    models: [{ id: provider.model, name: provider.model, input: ['text'], reasoning: provider.model.startsWith('glm-'),
      ...(flash ? { thinkingLevelMap: { off: 'low', minimal: 'low', low: 'low', medium: 'high', high: 'high', xhigh: 'max', max: 'max' } } : {}),
      contextWindow: nativeModelContextWindow(contextWindow), maxTokens: 32768,
      compat: { supportsUsageInStreaming: true, maxTokensField: 'max_tokens', supportsStore: false,
        supportsDeveloperRole: false, supportsReasoningEffort: flash, requiresReasoningContentOnAssistantMessages: provider.model.startsWith('glm-'), ...(flash ? { thinkingFormat: 'openai' } : {}) } }],
  } };
}

// A provider copied from an installed host profile. Only its endpoint and one
// model entry are copied; the key reaches the SDK through the transient guard.
export function nativeGatewayHostProfileProvider(provider, phaseTimeoutMs = null, authMarker) {
  let url = null;
  try { url = new URL(provider?.baseUrl); } catch {}
  const definition = provider?.definition;
  if (provider?.api !== 'openai-completions' || url?.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || !/^[\w.:-]+$/u.test(provider.model ?? '') || definition?.id !== provider.model
    || Object.keys(provider).some(key => !['api', 'baseUrl', 'model', 'definition'].includes(key))
    || Object.keys(definition).some(key => /key|secret|password|header|auth/iu.test(key)))
    throw new Error('Unsupported host-profile Gateway provider definition. Credentials belong only to the transient provider guard.');
  validatePhaseTimeoutMs(phaseTimeoutMs);
  return { providerId: authMarker ? 'custom' : 'openai', model: provider.model, definition: {
    api: provider.api, baseUrl: provider.baseUrl, ...(authMarker ? { apiKey: authMarker } : {}),
    ...(phaseTimeoutMs !== null ? { timeoutSeconds: phaseTimeoutMs / 1000 } : {}),
    models: [{ input: ['text'], ...structuredClone(definition), name: definition.name ?? provider.model }],
  } };
}

// The probe socket stays bound until the Gateway binds, so the remaining
// TOCTOU window is tiny; a lost race is retried with a fresh port.
export async function reservePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  socket.unref();
  let closed;
  return { port: socket.address().port, release: () => closed ??= new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve())) };
}
export const addressInUse = error => error?.code === 'EADDRINUSE' || error?.cause?.code === 'EADDRINUSE'
  || /EADDRINUSE|address already in use/iu.test(String(error?.message ?? ''));
export async function bindWithRetry(start, reserved, { attempts = 4, onRebind = async () => {} } = {}) {
  let { port } = reserved;
  for (let attempt = 1; ; attempt++) {
    await reserved?.release(); reserved = null;
    try { return { port, server: await start(port), attempts: attempt }; }
    catch (error) {
      if (attempt >= attempts || !addressInUse(error)) throw error;
      reserved = await reservePort(); port = reserved.port;
      await onRebind(port);
    }
  }
}

export function createNativeGatewayRequest({ load, port, config }) {
  return async (method, params, options = {}) => {
    const { callGateway } = await load('dist/call-BZWJ3eG1.js');
    return callGateway({ url: `ws://127.0.0.1:${port}`, token: process.env.OPENCLAW_GATEWAY_TOKEN,
      config, method, params, timeoutMs: options.timeoutMs ?? 30000,
      // Each request has a new connection. The isolated controller must
      // authenticate its exact-run abort and manual compaction as admin.
      ...(['chat.abort', 'sessions.compact'].includes(method) ? { scopes: ['operator.admin'] } : {}) });
  };
}

export async function createNativeGatewayEvaluation({ hostRoot, projectRoot, outputRoot, sourceRoot, reuseProfile = false, injectDefect = false,
  prebuiltPluginRoot = null, extraPluginPaths = [], businessToolNames = ['read', 'write', 'edit'], businessToolDeny = [], confineBusinessFiles = false,
  phaseTimeoutMs = null, reviewerTimeoutMs = phaseTimeoutMs, hookTimeoutMs = phaseTimeoutMs, businessTimeoutMs = phaseTimeoutMs,
  unlimitedBusiness = false, hostProfileAuthMarker, disableMemoryFlush = false, preserveSessionHistory = false, contextWindowTokens, baselineLimits, baselineWireMode, skipBootstrap = false,
  compaction = null, contextTokens, logLevel = 'warn', provider, reviewerProvider, providerGuard, onGatewayStart, disableRuntimeCorrection = false }) {
  const contextWindow = nativeModelContextWindow(contextWindowTokens);
  const hostProfile = providerGuard?.kind === 'host_profile_native_document'
    || ['authorized_simplify_experiment', 'metered_native_gateway_batch'].includes(providerGuard?.kind) && providerGuard.hostProfile === true;
  const coding = !provider ? null : hostProfile ? nativeGatewayHostProfileProvider(provider, phaseTimeoutMs, hostProfileAuthMarker)
    : nativeGatewayCodingProvider(provider, contextWindow, phaseTimeoutMs, { allowLocalRelay: providerGuard?.kind === 'relay_native_gateway_batch' });
  if (reviewerProvider) {
    if (!hostProfile || !coding || reviewerProvider.baseUrl !== provider.baseUrl || reviewerProvider.model === provider.model)
      throw new Error('The reviewer requires a distinct model on the same host profile.');
    const reviewer = nativeGatewayHostProfileProvider(reviewerProvider, phaseTimeoutMs, hostProfileAuthMarker);
    coding.definition.models.push(...reviewer.definition.models);
  }
  const authorizedDocument = hostProfile || provider?.model === 'glm-5.3-flash' && providerGuard?.kind === 'authorized_native_document';
  if (coding && !authorizedDocument && !['offline_native_gateway_guard', 'metered_native_gateway_batch', 'relay_native_gateway_batch', 'authorized_simplify_experiment'].includes(providerGuard?.kind))
    throw new Error('The explicit Gateway provider requires an offline network guard or a metered batch.');
  if (contextWindowTokens !== undefined && !coding && !process.env.ANTHROPIC_BASE_URL)
    throw new Error('An explicit model context capacity requires the configured custom provider definition.');
  validatePhaseTimeoutMs(phaseTimeoutMs);
  for (const [name, value, minimum] of [['reviewerTimeoutMs', reviewerTimeoutMs, 1000], ['hookTimeoutMs', hookTimeoutMs, 2000], ['businessTimeoutMs', businessTimeoutMs, 1000]])
    if (value !== null && (!Number.isSafeInteger(value) || value < minimum || value > MAX_REVIEW_TIMEOUT_MS || value % 1000 !== 0))
      throw new Error(`Invalid isolated ${name}.`);
  const pkg = JSON.parse(await fs.readFile(path.join(hostRoot, 'package.json'), 'utf8'));
  if (pkg.name !== 'openclaw' || pkg.version !== '2026.7.1-2') throw new Error('This gateway probe requires installed OpenClaw 2026.7.1-2.');
  // This pinned host defines overrideMs=0 as its native no-timeout sentinel.
  // Defaults must use that same sentinel for automatic business corrections;
  // private reviewers still receive their explicit project role deadlines.
  const noTimeoutMs = unlimitedBusiness ? (await import(pathToFileURL(path.join(hostRoot, 'dist/timeout-0Cw4kcol.js')).href)).n({ overrideMs: 0 }) : null;
  const root = path.join(outputRoot, 'native-host');
  await fs.mkdir(root, { recursive: true }); await fs.mkdir(projectRoot, { recursive: true });
  const reserved = await reservePort(), model = coding?.model ?? process.env.RC_EVAL_NATIVE_MODEL ?? process.env.ANTHROPIC_MODEL ?? 'transport-only';
  const providerId = coding?.providerId ?? 'anthropic', providerBaseUrl = coding?.definition.baseUrl ?? process.env.ANTHROPIC_BASE_URL;
  let port = reserved.port;
  process.env.OPENCLAW_STATE_DIR = path.join(root, 'state');
  process.env.OPENCLAW_CONFIG_PATH = path.join(root, 'config.json');
  process.env.OPENCLAW_GATEWAY_TOKEN = randomBytes(32).toString('hex');
  process.env.OPENCLAW_SKIP_CRON = '1';
  if (!coding && process.env.ANTHROPIC_AUTH_TOKEN) process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_AUTH_TOKEN;
  process.argv[1] = path.join(hostRoot, 'openclaw.mjs');
  const pluginRoot = prebuiltPluginRoot ? await fs.realpath(prebuiltPluginRoot) : reuseProfile ? await fs.realpath(path.join(root, 'build/runtime-corrector-openclaw'))
    : await buildPlugin({ host: 'openclaw', sourceRoot, outputRoot: path.join(root, 'build') });
  if (unlimitedBusiness) {
    const manifest = JSON.parse(await fs.readFile(path.join(pluginRoot, 'openclaw.plugin.json'), 'utf8'));
    if (!manifest.configSchema?.properties?.businessRunTimeoutMs) throw new Error('This frozen plugin cannot disable RC business-correction deadlines; do not silently claim an unbounded host.');
  }
  let config = { logging: { level: logLevel, consoleLevel: 'silent', file: path.join(root, 'host.log') },
    gateway: { mode: 'local', port, bind: 'loopback', auth: { mode: 'token' }, controlUi: { enabled: false }, reload: { mode: 'off' } },
    discovery: { mdns: { mode: 'off' } }, cron: { enabled: false }, diagnostics: { enabled: true }, browser: { enabled: false },
    agents: { defaults: { workspace: projectRoot, model: { primary: `${providerId}/${model}` }, sandbox: { mode: 'off' }, heartbeat: { every: '0m' },
      ...(coding ? { thinkingDefault: 'low', skipBootstrap: skipBootstrap || !authorizedDocument, skills: ['runtime-corrector', 'runtime-corrector-control',
        'runtime-corrector-init', 'runtime-corrector-workflow', 'semantic-review', 'document-corrector'] } : {}),
      ...(unlimitedBusiness ? { timeoutSeconds: Math.floor(noTimeoutMs / 1000) } : businessTimeoutMs ? { timeoutSeconds: businessTimeoutMs / 1000 } : {}),
      ...(disableMemoryFlush ? { compaction: { memoryFlush: { enabled: false } } } : {}) },
      list: [{ id: 'main', agentDir: path.join(root, 'agent'),
        tools: { allow: [...new Set([...businessToolNames, 'runtime_corrector', 'rc_document', 'rc_progress', ...TASK_TOOL_NAMES, ...BASELINE_TOOL_NAMES])],
          ...(businessToolDeny.length ? { deny: businessToolDeny } : {}) } }] },
    ...(confineBusinessFiles ? { tools: { fs: { workspaceOnly: true } } } : {}),
    session: { store: path.join(root, 'sessions.json'), ...(preserveSessionHistory ? { reset: EXPERIMENT_SESSION_RESET } : {}) },
    ...(providerBaseUrl ? { models: { mode: 'replace', providers: { [providerId]: coding?.definition ?? {
      api: 'anthropic-messages', baseUrl: providerBaseUrl,
      models: [{ id: model, name: model, input: ['text'], reasoning: false, contextWindow, maxTokens: 32768 }],
    } } } } : {}),
    plugins: { enabled: true, allow: ['runtime-corrector'], load: { paths: [pluginRoot] }, entries: {
      'runtime-corrector': { enabled: true, hooks: { allowConversationAccess: true, allowPromptInjection: true },
        ...(hookTimeoutMs || reviewerTimeoutMs || businessTimeoutMs || baselineLimits || baselineWireMode ? { config: {
          ...(baselineLimits ? { baselineLimits } : {}), ...(baselineWireMode ? { baselineWireMode } : {}),
          ...(hookTimeoutMs ? { hookTimeoutMs } : {}), ...(reviewerTimeoutMs ? { reviewerTimeoutMs } : {}),
          ...(businessTimeoutMs ? { businessRunTimeoutMs: businessTimeoutMs } : {}),
          ...(unlimitedBusiness ? { businessRunTimeoutMs: 0 } : {}) } } : {}) },
    } },
  };
  if (reuseProfile) {
    config = JSON.parse(await fs.readFile(process.env.OPENCLAW_CONFIG_PATH, 'utf8'));
    if (coding) config.models.providers[providerId] = nativeGatewayResumeProvider(config.models?.providers?.[providerId], coding.definition,
      { allowLocalRelayRebind: providerGuard?.kind === 'relay_native_gateway_batch' });
    if (contextWindowTokens !== undefined && config.models?.providers?.[providerId]?.models?.find(item => item.id === model)?.contextWindow !== contextWindow)
      throw new Error('Explicit model context capacity differs from the captured profile.');
    config.gateway = { ...config.gateway, port, bind: 'loopback', auth: { mode: 'token' } };
  }
  for (const extra of extraPluginPaths) {
    if (!extra || !/^[a-z][a-z0-9-]*$/u.test(extra.id)) throw new Error('Invalid experiment plugin identity');
    config.plugins.allow = [...new Set([...config.plugins.allow, extra.id])];
    config.plugins.load.paths = [...new Set([...config.plugins.load.paths, await fs.realpath(extra.path)])];
    config.plugins.entries[extra.id] = { enabled: true, ...(extra.hooks ? { hooks: extra.hooks } : {}),
      ...(extra.config ? { config: extra.config } : {}) };
  }
  if (phaseTimeoutMs) {
    config.diagnostics = { ...config.diagnostics, stuckSessionWarnMs: phaseTimeoutMs, stuckSessionAbortMs: phaseTimeoutMs };
    config.session = { ...config.session, writeLock: { ...config.session?.writeLock, maxHoldMs: phaseTimeoutMs + 5000 } };
    config.agents.defaults.timeoutSeconds = (businessTimeoutMs ?? phaseTimeoutMs) / 1000;
    const settings = config.plugins.entries['runtime-corrector'];
    settings.config = { ...settings.config, hookTimeoutMs: hookTimeoutMs ?? phaseTimeoutMs, reviewerTimeoutMs: reviewerTimeoutMs ?? phaseTimeoutMs };
    if (reuseProfile && provider) config.models.providers[providerId] = { ...config.models.providers[providerId],
      baseUrl: provider.baseUrl, timeoutSeconds: phaseTimeoutMs / 1000 };
  }
  if (unlimitedBusiness) {
    config.agents.defaults.timeoutSeconds = Math.floor(noTimeoutMs / 1000);
    config.plugins.entries['runtime-corrector'].config = { ...config.plugins.entries['runtime-corrector'].config, businessRunTimeoutMs: 0 };
  }
  if (disableRuntimeCorrection) {
    const settings = config.plugins.entries['runtime-corrector'];
    settings.config = { ...settings.config, enabled: false };
  }
  if (compaction) config.agents.defaults.compaction = { ...config.agents.defaults.compaction, ...structuredClone(compaction) };
  if (disableMemoryFlush) config.agents.defaults.compaction = { ...config.agents.defaults.compaction,
    memoryFlush: { ...config.agents.defaults.compaction?.memoryFlush, enabled: false } };
  if (contextTokens !== undefined) config.agents.defaults.contextTokens = contextTokens;
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
  const timing = providerBaseUrl ? await installProviderFetchTiming({
    file: path.join(root, reuseProfile ? 'restart-provider-fetch-timing.jsonl' : 'provider-fetch-timing.jsonl'), origin: new URL(providerBaseUrl).origin,
  }) : null;
  let gateway, unsubscribe;
  let restoreCredential = () => {};
  const modelStarts = [];
  try {
    if (coding && !hostProfileAuthMarker) {
      const credential = providerGuard.credential?.();
      if (typeof credential !== 'string' || !credential.trim()) throw new Error('The Gateway provider guard has no transient credential.');
      // The pinned SDK resolves the standard provider from OPENAI_API_KEY.
      // Neither the saved profile nor models definition receives its value.
      const previous = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = credential;
      restoreCredential = () => { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; };
    }
    const load = relative => import(pathToFileURL(path.join(hostRoot, relative)).href);
    const { startGatewayServer } = await load('dist/server-BnSQQ3Aa.js');
    ({ port, server: gateway } = await bindWithRetry(value => startGatewayServer(value, { bind: 'loopback', host: '127.0.0.1', controlUiEnabled: false }), reserved, {
      async onRebind(value) { config.gateway.port = value; await fs.writeFile(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(config, null, 2)); } }));
    await onGatewayStart?.();
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
    return { runtime, hooks: getGlobalHookRunner(), registry, config, model, modelRef: `${providerId}/${model}`, pluginRoot, root, port, faultInjection: injectDefect,
      request: createNativeGatewayRequest({ load, port, config }),
      setPhase: value => timing?.setPhase(value),
      async drain() { await diagnostics.waitForDiagnosticEventsDrained(); },
      metrics: () => ({ hostVersion: pkg.version, ownerPid: process.pid, providerRequests: timing?.requestCount ?? null, modelStarts: structuredClone(modelStarts), pluginStatus: plugin.status, isolatedState: root }),
      async close() { try { await gateway.close({ reason: 'Isolated RC acceptance probe finished' }); } finally { unsubscribe?.(); restoreCredential(); await timing?.close(); } },
    };
  } catch (error) { try { await reserved.release(); await gateway?.close({ reason: 'Isolated RC acceptance probe failed' }); } finally { unsubscribe?.(); restoreCredential(); await timing?.close(); } throw error; }
}
