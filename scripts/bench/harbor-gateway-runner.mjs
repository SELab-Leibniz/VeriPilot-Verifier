// Container-side RC-owned runner. Both arms run the installed host through the
// same Gateway; provider authentication here is only a disposable relay cap.
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { awaitHarborGatewaySettlement, harborGatewayErrorDiagnostic } from './harbor-gateway-controller.mjs';
import { prepareHarborWorkspace } from './prepare-harbor-workspace.mjs';

export function validateHarborRelayTicket(ticket, now = Date.now()) {
  if (ticket?.kind !== 'rc-harbor-relay-ticket-v1' || ticket.model !== 'openai/glm-5.3'
    || !/^rc-placeholder-[a-f0-9]{64}$/u.test(ticket.placeholderCredential ?? '')
    || !Number.isSafeInteger(ticket.deadlineAt) || ticket.deadlineAt <= now
    || !Number.isSafeInteger(ticket.officialWallMs) || ticket.officialWallMs < 1000
    || ['inputPerRequest', 'outputPerRequest', 'totalInput', 'totalOutput', 'requests'].some(key => !Number.isSafeInteger(ticket.tokenLimits?.[key]) || ticket.tokenLimits[key] < 1)
    || ticket.tokenLimits.outputPerRequest > 32768)
    throw new Error('HARBOR_RELAY_TICKET_INVALID');
  const url = new URL(ticket.relayBaseUrl);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'host.docker.internal'].includes(url.hostname)
    || !url.port || url.pathname !== '/v1' || url.username || url.password || url.search || url.hash)
    throw new Error('HARBOR_RELAY_ROUTE_UNQUALIFIED');
  return ticket;
}

export function harborGatewayConfig({ root, projectRoot, pluginRoot, ticket, port, rcEnabled }) {
  validateHarborRelayTicket(ticket);
  return { logging: { level: 'warn', consoleLevel: 'silent', file: path.join(root, 'host.log') },
    gateway: { mode: 'local', port, bind: 'loopback', auth: { mode: 'token' }, controlUi: { enabled: false }, reload: { mode: 'off' } },
    discovery: { mdns: { mode: 'off' } }, cron: { enabled: false }, browser: { enabled: false }, diagnostics: { enabled: true },
    agents: { defaults: { workspace: projectRoot, model: { primary: ticket.model }, sandbox: { mode: 'off' }, skipBootstrap: true,
      heartbeat: { every: '0m' }, timeoutSeconds: Math.max(1, Math.ceil(ticket.officialWallMs / 1000)) },
      list: [{ id: 'main', agentDir: path.join(root, 'agent') }] },
    // Retain the normal terminal tool policy. Only headless messaging is denied,
    // as in the pinned inherited Harbor OpenClaw adapter.
    tools: { deny: ['message'] }, session: { store: path.join(root, 'sessions.json'), reset: { mode: 'idle' } },
    // Public provider policy controls implicit idle/first-event watchdogs. The
    // host still caps them by each original/private run's remaining timeout.
    models: { mode: 'replace', providers: { openai: { api: 'openai-completions', baseUrl: ticket.relayBaseUrl,
      timeoutSeconds: Math.floor(ticket.officialWallMs / 1000),
      models: [{ id: 'glm-5.3', name: 'glm-5.3', input: ['text'], reasoning: false, contextWindow: 128000,
        maxTokens: ticket.tokenLimits.outputPerRequest, compat: { supportsUsageInStreaming: true, maxTokensField: 'max_tokens',
          supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false } }] } } },
    plugins: { enabled: true, allow: ['runtime-corrector'], load: { paths: [pluginRoot] }, entries: {
      'runtime-corrector': { enabled: rcEnabled, hooks: { allowConversationAccess: true, allowPromptInjection: true } } } } };
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}

export function harborInstructionIdentity(instruction) {
  if (typeof instruction !== 'string' || !instruction.trim()) throw new Error('HARBOR_ORIGINAL_INSTRUCTION_REQUIRED');
  const effective = instruction.trim(), sha = text => createHash('sha256').update(text).digest('hex');
  return { rawSha256: sha(instruction), hostEffectiveSha256: sha(effective),
    rawBytes: Buffer.byteLength(instruction), hostEffectiveBytes: Buffer.byteLength(effective),
    hostNormalization: 'standard agent RPC String.trim()', hostInputByteIdentical: instruction === effective };
}

export async function dispatchHarborOriginalAgent({ request, instruction, runId, sessionId, sessionKey,
  deadlineAt, now = Date.now }) {
  const remainingMs = deadlineAt - now();
  if (!Number.isSafeInteger(remainingMs) || remainingMs < 1000)
    throw Object.assign(new Error('HARBOR_TASK_WALL_LIMIT'), { code: 'HARBOR_TASK_WALL_LIMIT' });
  const accepted = await request('agent', { sessionId, sessionKey, agentId: 'main', message: instruction,
    idempotencyKey: runId, deliver: false, thinking: 'off', timeout: Math.floor(remainingMs / 1000) },
  { timeoutMs: remainingMs });
  if (accepted?.runId !== runId || accepted?.sessionKey !== sessionKey) throw new Error('HARBOR_ORIGINAL_RUN_ID_MISMATCH');
  return accepted;
}

export function harborGatewayFailureDetails(error) {
  const diagnostic = harborGatewayErrorDiagnostic(error);
  return { code: typeof diagnostic.code === 'string' ? diagnostic.code : 'HARBOR_GATEWAY_FAILED', diagnostic,
    cleanup: error.cleanup ?? null };
}

export async function runHarborGatewayTrial({ hostRoot, projectRoot, pluginRoot, outputRoot, ticket, rcEnabled, instruction,
  probeOnly = false, signal, artifactHashes = null, policyPath, criteriaPath, nativeTranscriptOutput }) {
  validateHarborRelayTicket(ticket); signal?.throwIfAborted();
  const pkg = JSON.parse(await fs.readFile(path.join(hostRoot, 'package.json'), 'utf8'));
  if (pkg.name !== 'openclaw' || pkg.version !== '2026.7.1-2') throw new Error('HARBOR_HOST_VERSION_MISMATCH');
  const project = await fs.realpath(projectRoot), plugin = await fs.realpath(pluginRoot);
  const verifyArtifact = async () => {
    if (!artifactHashes) { if (!probeOnly) throw new Error('HARBOR_FROZEN_ARTIFACT_MANIFEST_REQUIRED'); return; }
    for (const [relative, expected] of Object.entries(artifactHashes)) {
      if (path.isAbsolute(relative) || relative.split(/[\\/]/u).includes('..')) throw new Error('HARBOR_ARTIFACT_PATH_INVALID');
      const file = path.join(plugin, relative);
      if (await fs.realpath(file) !== file || createHash('sha256').update(await fs.readFile(file)).digest('hex') !== expected)
        throw new Error('HARBOR_ARTIFACT_CHANGED');
    }
  };
  await verifyArtifact();
  if (!policyPath || !criteriaPath) throw new Error('HARBOR_FROZEN_OPERATIONAL_POLICY_REQUIRED');
  const operationalPolicy = await prepareHarborWorkspace({ projectRoot: project, pluginRoot: plugin, policyPath, criteriaPath });
  await fs.mkdir(outputRoot); const root = await fs.realpath(outputRoot), port = await freePort();
  const config = harborGatewayConfig({ root, projectRoot: project, pluginRoot: plugin, ticket, port, rcEnabled });
  const savedEnv = new Map(), changedEnv = { OPENCLAW_STATE_DIR: path.join(root, 'state'), OPENCLAW_CONFIG_PATH: path.join(root, 'config.json'),
    OPENCLAW_GATEWAY_TOKEN: randomBytes(32).toString('hex'), OPENCLAW_SKIP_CRON: '1', OPENAI_API_KEY: ticket.placeholderCredential };
  // A terminal-capable task must never inherit a real provider key. The actual
  // upstream secret stays in the external relay controller, outside the host.
  for (const [key, value] of Object.entries(process.env)) if (value && /API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET_KEY/u.test(key)
    && !(key === 'OPENAI_API_KEY' && value === ticket.placeholderCredential)) throw new Error('HARBOR_CONTAINER_AUTH_ENV_FORBIDDEN');
  for (const [key, value] of Object.entries(changedEnv)) { savedEnv.set(key, process.env[key]); process.env[key] = value; }
  const oldArgv = process.argv[1]; process.argv[1] = path.join(hostRoot, 'openclaw.mjs');
  await fs.writeFile(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(config, null, 2));
  const load = file => import(pathToFileURL(path.join(hostRoot, file)).href);
  let gateway, runId, sessionKey, diagnostics, unsubscribe, instructionIdentity; const observations = [], modelStarts = [];
  try {
    const { startGatewayServer } = await load('dist/server-BnSQQ3Aa.js');
    gateway = await startGatewayServer(port, { bind: 'loopback', host: '127.0.0.1', controlUiEnabled: false });
    const { createPluginRuntime } = await load('dist/plugins/runtime/index.js');
    const { getGlobalPluginRegistry } = await load('dist/plugins/hook-runner-global.js');
    const { callGateway } = await load('dist/call-BZWJ3eG1.js');
    const runtime = createPluginRuntime({ allowGatewaySubagentBinding: true });
    diagnostics = await load('dist/plugin-sdk/diagnostic-runtime.js');
    unsubscribe = diagnostics.onInternalDiagnosticEvent(event => {
      if (event.type === 'model.call.started') modelStarts.push({ runId: event.runId, sessionId: event.sessionId, sessionKey: event.sessionKey });
    });
    const pluginState = getGlobalPluginRegistry()?.plugins?.find(item => item.id === 'runtime-corrector');
    if (rcEnabled ? pluginState?.status !== 'loaded' : pluginState?.status === 'loaded') throw new Error('HARBOR_RC_ARM_STATE_MISMATCH');
    const request = (method, params, options = {}) => callGateway({ url: `ws://127.0.0.1:${port}`, token: process.env.OPENCLAW_GATEWAY_TOKEN,
      config, method, params, timeoutMs: options.timeoutMs ?? 3000,
      ...(method === 'chat.abort' ? { scopes: ['operator.admin'] } : {}) });
    if (!(await request('health', {})).ok) throw new Error('HARBOR_GATEWAY_HEALTH_FAILED');
    const created = await request('sessions.create', { key: `agent:main:harbor-${randomUUID()}`, agentId: 'main', label: 'Harbor trial' });
    if (!created.ok || !created.key) throw new Error('HARBOR_SESSION_CREATE_FAILED');
    sessionKey = created.key;
    const scope = { agentId: 'main', sessionKey, storePath: config.session.store };
    await runtime.agent.session.patchSessionEntry({ ...scope, update: entry => ({ ...entry, spawnedCwd: project }) });
    const saved = await runtime.agent.session.getSessionEntry({ ...scope, readConsistency: 'latest' });
    if (!saved?.sessionId || saved.spawnedCwd !== project) throw new Error('HARBOR_PROJECT_BINDING_FAILED');
    const sessionId = saved.sessionId;
    if (probeOnly) {
      await diagnostics.waitForDiagnosticEventsDrained();
      if (modelStarts.length) throw new Error('HARBOR_MODEL_FREE_PROBE_STARTED_MODEL');
      return { state: 'ACTUAL_GATEWAY_ARM_BOOTSTRAPPED_NO_TASK', rcEnabled, sessionId, sessionKey,
        pluginLoaded: pluginState?.status === 'loaded', operationalPolicy, originalTaskSubmitted: false, modelStarts, realProviderRequests: 0, semanticAcceptance: null };
    }
    instructionIdentity = harborInstructionIdentity(instruction);
    runId = randomUUID();
    await fs.writeFile(path.join(root, 'original-instruction-identity.json'), JSON.stringify({
      entry: 'agent', runId, sessionId, sessionKey, deadlineAt: ticket.deadlineAt, ...instructionIdentity }, null, 2));
    await dispatchHarborOriginalAgent({ request, instruction, runId, sessionId, sessionKey, deadlineAt: ticket.deadlineAt });
    const settled = await awaitHarborGatewaySettlement({ request, originalRunId: runId, sessionId, sessionKey,
      projectRoot: project, rcEnabled, deadlineAt: ticket.deadlineAt, signal,
      readPersistentDispatch: async identity => {
        if (!/^[a-f0-9]{64}$/u.test(identity.id)) throw new Error('HARBOR_DISPATCH_RECORD_ID_INVALID');
        return JSON.parse(await fs.readFile(path.join(runtime.state.resolveStateDir(), 'runtime-corrector-stop-sessions/post-run', `${identity.id}.json`), 'utf8'));
      }, onObservation: value => observations.push(value) });
    await diagnostics.waitForDiagnosticEventsDrained(); await verifyArtifact();
    const current = await runtime.agent.session.getSessionEntry({ ...scope, readConsistency: 'latest' });
    if (current?.sessionId !== sessionId || current.spawnedCwd !== project
      || !modelStarts.some(event => event.runId === runId && event.sessionId === sessionId)
      || modelStarts.some(event => event.runId === runId && event.sessionId !== sessionId)) throw new Error('HARBOR_ORIGINAL_RUN_IDENTITY_UNPROVEN');
    if (!nativeTranscriptOutput || !current.sessionFile) throw new Error('HARBOR_NATIVE_TRAJECTORY_UNAVAILABLE');
    const sessionFile = await fs.realpath(current.sessionFile);
    if (!sessionFile.startsWith(root + path.sep)) throw new Error('HARBOR_NATIVE_TRAJECTORY_OUTSIDE_ISOLATED_PROFILE');
    const nativeTranscript = await fs.readFile(sessionFile);
    await fs.writeFile(nativeTranscriptOutput, nativeTranscript);
    return { state: 'HOST_AND_RC_SETTLED_REQUIRES_EXTERNAL_METERING_RECEIPT', ...settled, sessionId, sessionKey,
      originalBusinessEntry: 'agent', instructionSha256: instructionIdentity.rawSha256, instructionIdentity,
      observations, modelStarts, operationalPolicy,
      nativeTranscript: { path: nativeTranscriptOutput, source: sessionFile, bytes: nativeTranscript.length,
        sha256: createHash('sha256').update(nativeTranscript).digest('hex') }, officialGraderInvoked: false };
  } catch (error) {
    await fs.writeFile(path.join(root, 'failure.json'), JSON.stringify({ ...harborGatewayFailureDetails(error),
      runId: runId ?? null, sessionKey: sessionKey ?? null,
      originalBusinessEntry: 'agent', instructionIdentity: instructionIdentity ?? null, observations }, null, 2)); throw error;
  } finally {
    try { await gateway?.close({ reason: 'RC-owned Harbor wrapper finished' }); }
    finally { unsubscribe?.(); process.argv[1] = oldArgv; for (const [key, value] of savedEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), index = args.indexOf('--manifest');
  if (index < 0) throw new Error('Use --manifest with the container-side public run specification.');
  const spec = JSON.parse(await fs.readFile(args[index + 1], 'utf8'));
  if (spec.instructionPath) spec.instruction = await fs.readFile(spec.instructionPath, 'utf8');
  try { const result = await runHarborGatewayTrial(spec); await fs.writeFile(spec.resultPath, JSON.stringify(result, null, 2)); }
  catch { process.exitCode = 1; }
}
