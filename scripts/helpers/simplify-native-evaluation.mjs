import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { createNativeGatewayEvaluation } from './native-gateway-evaluation.mjs';

export const simplifyProviderUrl = 'https://open.bigmodel.cn/api/coding/paas/v4';
const arkAnthropicUrl = 'https://ark.cn-beijing.volces.com/api/coding';
export const deepseekModel = 'deepseek-v4-flash';
export const deepseekCodingModel = 'deepseek-flash';
export const deepseekReviewerModel = 'deepseek-v4-pro';
let transientProfileKey;

export function supportsSimplifyModel(provider, model, openclawProfile) {
  return provider === 'host-profile' ? [deepseekCodingModel, deepseekModel].includes(model) && Boolean(openclawProfile)
    : ['coding-plan', 'anthropic-environment'].includes(provider) && ['glm-5.3', 'glm-5.3-flash'].includes(model) && !openclawProfile;
}

export async function resolveSimplifyProvider(kind, model, openclawProfile, reviewerModel) {
  if (kind !== 'host-profile') return { identity: simplifyProviderIdentity(kind, model) };
  if (!supportsSimplifyModel(kind, model, openclawProfile)) throw new Error('DeepSeek requires the custom OpenClaw profile route.');
  try {
    const { openclawProfileProvider } = await import('../evaluate-openclaw-document-e2e.mjs');
    const profile = path.resolve(openclawProfile);
    const { modelRef, provider, credential } = await openclawProfileProvider(profile, `custom/${model}`);
    const profileKey = credential();
    const reviewer = reviewerModel && reviewerModel !== model
      ? await openclawProfileProvider(profile, `custom/${reviewerModel}`) : null;
    if (reviewer && (reviewer.provider.api !== provider.api || reviewer.provider.baseUrl !== provider.baseUrl
      || reviewer.credential() !== profileKey)) throw new Error('Reviewer must use the same protected provider.');
    const endpoint = new URL(provider.baseUrl);
    if (provider.api !== 'openai-completions' || endpoint.protocol !== 'https:' || endpoint.username || endpoint.password
      || endpoint.search || endpoint.hash || JSON.stringify([provider, reviewer?.provider]).includes(profileKey))
      throw new Error('Invalid profile provider.');
    transientProfileKey = profileKey;
    return { identity: { kind, origin: endpoint.origin, endpointSha256: createHash('sha256').update(provider.baseUrl).digest('hex'),
      model, modelRef, ...(reviewer ? { reviewerModelRef: reviewer.modelRef } : {}) }, provider, credential,
      reviewerProvider: reviewer?.provider };
  } catch {
    throw new Error('The custom DeepSeek provider or its transient credential is unavailable or invalid.');
  }
}

export async function countProfileCredentialMatches(directory, credential) {
  const key = credential();
  const needles = [Buffer.from(key), Buffer.from(key, 'utf16le')];
  let matches = 0;
  const pending = [directory];
  while (pending.length) {
    const root = pending.pop();
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      const file = path.join(root, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (entry.isFile()) {
        const bytes = await fs.readFile(file);
        if (needles.some(needle => bytes.includes(needle))) matches++;
      }
    }
  }
  return matches;
}

// Count provider dispatches before they reach the network and fence SDK retries
// after an upstream failure. The SDK and the process fetch share this boundary.
// With pairRateLimitPauseMs a peer's 429 pauses this run's next dispatch until
// the shared cooldown ends instead of failing it; the pause is recorded.
export function installSimplifyProfileBoundary({ hostRoot, provider, credential, reviewerModel, maxRequests = Infinity, pairRateLimitFile,
  pairRateLimitPauseMs = null, authMarker, preResponseRetryDeadlineAt = null }) {
  const target = `${provider.baseUrl.replace(/\/$/u, '')}/chat/completions`;
  const allowedModels = new Set([provider.model, reviewerModel].filter(Boolean));
  const origin = new URL(target).origin, runtimeKey = '__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__';
  const offline = maxRequests === 0;
  const previousFetch = globalThis.fetch, previousRuntime = globalThis[runtimeKey];
  const undici = createRequire(path.join(hostRoot, 'package.json'))('undici');
  if (preResponseRetryDeadlineAt !== null && (!Number.isSafeInteger(preResponseRetryDeadlineAt) || preResponseRetryDeadlineAt <= 0))
    throw new Error('A bounded provider retry requires an absolute deadline.');
  const stats = { requests: 0, failure: null, ...(pairRateLimitPauseMs ? { pairPauses: 0, pairPausedMs: 0 } : {}),
    ...(preResponseRetryDeadlineAt !== null ? { preResponseRetries: 0 } : {}) };
  let closed = false, retryReserved = false;
  const fail = code => { stats.failure ??= code; return new Error(stats.failure); };
  const peerLimitedAt = () => fs.readFile(pairRateLimitFile, 'utf8').then(text => Number.parseInt(text, 10) || 0, error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  async function admitDispatch(signal) {
    signal?.throwIfAborted();
    if (closed) throw new Error('PROFILE_REQUEST_BOUNDARY_CLOSED');
    if (stats.failure) throw fail(stats.failure);
    const limitedAt = pairRateLimitFile ? await peerLimitedAt() : null;
    if (limitedAt !== null && !pairRateLimitPauseMs) throw fail('PROFILE_PAIR_RATE_LIMIT');
    if (limitedAt !== null && Date.now() < limitedAt + pairRateLimitPauseMs) {
      const pausedAt = Date.now();
      stats.pairPauses++;
      for (let until = limitedAt + pairRateLimitPauseMs; Date.now() < until; until = Math.max(until, (await peerLimitedAt() ?? 0) + pairRateLimitPauseMs)) {
        if (signal?.aborted) throw signal.reason ?? new Error('aborted');
        await delay(Math.min(1000, Math.max(1, until - Date.now())), undefined, { signal });
      }
      stats.pairPausedMs += Date.now() - pausedAt;
      if (stats.failure) throw fail(stats.failure);
    }
    signal?.throwIfAborted();
    if (closed) throw new Error('PROFILE_REQUEST_BOUNDARY_CLOSED');
  }
  const wrap = fetch => async (input, init) => {
    const plainInput = typeof input === 'string' || input instanceof URL;
    const url = new URL(plainInput ? input : input.url);
    const headers = new Headers(init?.headers ?? input?.headers);
    const authorized = headers.get('authorization') === `Bearer ${authMarker ?? credential()}`;
    if (url.origin !== origin && !authorized && headers.get('authorization') !== `Bearer ${credential()}`) {
      if (offline) throw new Error('PROFILE_REQUEST_BOUNDARY');
      return fetch(input, init);
    }
    const signal = init?.signal ?? input?.signal;
    await admitDispatch(signal);
    if (url.href !== target || String(init?.method ?? input?.method).toUpperCase() !== 'POST' || !authorized) throw fail('PROFILE_REQUEST_BOUNDARY');
    if (stats.requests >= maxRequests) throw fail('PROFILE_REQUEST_LIMIT');
    const body = typeof init?.body === 'string' ? init.body : await input.clone?.().text();
    let model;
    try { if (body && !body.includes(credential())) model = JSON.parse(body).model; } catch {}
    if (!allowedModels.has(model)) throw fail('PROFILE_MODEL_BOUNDARY');
    if (stats.failure) throw fail(stats.failure);
    if (stats.requests >= maxRequests) throw fail('PROFILE_REQUEST_LIMIT');
    if (authMarker) headers.set('authorization', `Bearer ${credential()}`);
    const wire = { ...init, ...(authMarker || preResponseRetryDeadlineAt !== null ? { headers } : {}), redirect: 'error' };
    let response;
    stats.requests++;
    try { response = await fetch(plainInput ? url.href : input, wire); }
    catch (error) {
      if (signal?.aborted) throw error;
      const retryableSocketError = [error?.code, error?.cause?.code].some(code => ['ECONNRESET', 'UND_ERR_SOCKET'].includes(code));
      // A rejected fetch has delivered no Response to OpenClaw. Once a
      // Response exists, body errors belong to the native run's evidence.
      if (preResponseRetryDeadlineAt === null || closed || stats.failure || retryReserved
        || !plainInput || typeof wire.body !== 'string' || stats.requests >= maxRequests
        || Date.now() >= preResponseRetryDeadlineAt
        || !retryableSocketError) throw fail('PROFILE_TRANSPORT_FAILURE');
      retryReserved = true;
      const deadlineSignal = AbortSignal.timeout(Math.max(1, preResponseRetryDeadlineAt - Date.now()));
      const retrySignal = signal ? AbortSignal.any([signal, deadlineSignal]) : deadlineSignal;
      await admitDispatch(retrySignal);
      if (Date.now() >= preResponseRetryDeadlineAt) throw fail('PROFILE_TRANSPORT_FAILURE');
      if (stats.requests >= maxRequests) throw fail('PROFILE_REQUEST_LIMIT');
      stats.preResponseRetries++;
      stats.requests++;
      try { response = await fetch(url.href, { ...wire, signal: retrySignal }); }
      catch (retryError) {
        if (retrySignal.aborted) throw retryError;
        throw fail('PROFILE_TRANSPORT_FAILURE');
      }
    }
    if (response.status >= 400) {
      if (response.status === 429 && pairRateLimitFile) await fs.writeFile(pairRateLimitFile, `${Date.now()}\n`, { flag: pairRateLimitPauseMs ? 'w' : 'wx' })
        .catch(error => { if (error.code !== 'EEXIST') throw error; });
      await response.body?.cancel().catch(() => {});
      throw fail(response.status === 429 ? 'PROFILE_RATE_LIMIT' : `PROFILE_HTTP_${response.status}`);
    }
    return response;
  };
  const guardedFetch = wrap(previousFetch);
  // OpenClaw recognizes mocked fetch before resolving DNS. Only use that
  // entry point for the isolated zero-request run, where no URL can dispatch.
  if (offline) guardedFetch.mock = {};
  globalThis.fetch = guardedFetch;
  globalThis[runtimeKey] = { ...undici, fetch: wrap(undici.fetch) };
  return { snapshot: () => ({ ...stats }), close() {
    closed = true;
    globalThis.fetch = previousFetch;
    if (previousRuntime === undefined) delete globalThis[runtimeKey]; else globalThis[runtimeKey] = previousRuntime;
  } };
}

export const loadPackaged = (root, file) => import(pathToFileURL(path.join(root, file)).href);

export function requireSimplifyStopSwitches(compileRuntimeV2Config) {
  const { stopCorrection } = compileRuntimeV2Config({ version: 2, stopCorrection: {
    enabled: true, originalRequirementsBasis: true, deviationOnly: true,
  } });
  if (stopCorrection.originalRequirementsBasis !== true || stopCorrection.deviationOnly !== true)
    throw new Error('Prebuilt package does not expose both approved Stop switches.');
}

export function redactEvaluationText(value) {
  let text = String(value ?? '');
  if (transientProfileKey) text = text.replaceAll(transientProfileKey, '[REDACTED_CREDENTIAL]');
  for (const key of ['RC_EVAL_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']) {
    if (process.env[key]) text = text.replaceAll(process.env[key], '[REDACTED_CREDENTIAL]');
  }
  return text;
}

export function summarizeProviderUsage(observedCalls, observations) {
  const complete = observations.filter(value => ['input', 'output', 'totalTokens'].every(key =>
    Number.isSafeInteger(value?.[key]) && value[key] >= 0) && value.totalTokens > 0);
  const count = Number.isSafeInteger(observedCalls) && observedCalls >= 0 ? observedCalls : 0;
  const consistent = complete.length <= count;
  return { observedCalls: count, completeCalls: consistent ? complete.length : 0,
    tokens: consistent && complete.length ? complete.reduce((total, value) => total + value.totalTokens, 0) : null,
    ...(consistent ? {} : { unexpectedUsageRecords: complete.length }) };
}

export async function readProviderTiming(root, name = 'provider-fetch-timing.jsonl') {
  const text = await fs.readFile(path.join(root, name), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  return text.split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
}

export async function waitSimplifyRunTerminal(gateway, runId, deadlineAt, signal) {
  if (!runId) throw new Error('Missing evaluation run identity.');
  while (Date.now() < deadlineAt && !signal?.aborted) {
    let response;
    try {
      response = await gateway.request('agent.wait', { runId, timeoutMs: 1 },
        { timeoutMs: Math.min(5000, Math.max(1, deadlineAt - Date.now())) });
    } catch (error) {
      // The public client establishes a fresh authenticated connection per poll.
      if (!/^gateway timeout after \d+ms(?:\r?\n|$)/u.test(error?.message ?? '')) throw error;
    }
    if (Date.now() >= deadlineAt || signal?.aborted) break;
    if (response) {
      const terminal = response.result ?? response;
      if (terminal?.runId !== runId) throw new Error('Evaluation terminal run identity mismatch.');
      if (terminal.status === 'ok' || terminal.status === 'error') return terminal;
      if (terminal.status !== 'timeout') throw new Error('Unexpected evaluation terminal status.');
    }
    try { await delay(Math.min(500, Math.max(0, deadlineAt - Date.now())), undefined, { signal }); }
    catch (error) { if (!signal?.aborted) throw error; }
  }
  return null;
}

export function simplifyProviderIdentity(provider, model, env = process.env) {
  let endpoint;
  if (provider === 'coding-plan') {
    if (!env.RC_EVAL_API_KEY?.trim()) throw new Error('Set RC_EVAL_API_KEY in the evaluation process environment.');
    endpoint = simplifyProviderUrl;
  } else if (provider === 'anthropic-environment') {
    if (!env.ANTHROPIC_AUTH_TOKEN?.trim() || ![arkAnthropicUrl, `${arkAnthropicUrl}/`].includes(env.ANTHROPIC_BASE_URL)
      || env.ANTHROPIC_MODEL !== model || env.RC_EVAL_NATIVE_MODEL && env.RC_EVAL_NATIVE_MODEL !== model)
      throw new Error('Use the existing Ark Anthropic-compatible endpoint, its process credential and matching configured model.');
    endpoint = env.ANTHROPIC_BASE_URL;
  } else throw new Error('Choose coding-plan or anthropic-environment.');
  return { kind: provider, origin: new URL(endpoint).origin, endpointSha256: createHash('sha256').update(endpoint).digest('hex'), model };
}

export async function createSimplifyGateway({ model, reviewerModel, providerKind = 'coding-plan', openclawProfile, maxRequests, pairRateLimitFile, pairRateLimitPauseMs = null,
  nativeCustomProvider = false, preResponseRetryDeadlineAt = null, ...options }) {
  const { identity: providerIdentity, provider, credential, reviewerProvider } = await resolveSimplifyProvider(providerKind, model, openclawProfile, reviewerModel);
  // The custom model name uses a public SDK marker. Only the wire boundary holds the real credential.
  const authMarker = provider && nativeCustomProvider ? 'rc-isolated-provider-placeholder' : undefined;
  const boundary = provider && installSimplifyProfileBoundary({ hostRoot: options.hostRoot, provider, credential, reviewerModel: reviewerProvider?.model, maxRequests, pairRateLimitFile,
    pairRateLimitPauseMs, authMarker, preResponseRetryDeadlineAt });
  let gateway;
  const finish = async () => {
    if (!boundary) return;
    boundary.close();
    await fs.writeFile(path.join(options.outputRoot, 'provider-boundary.json'), JSON.stringify(boundary.snapshot()), { flag: 'wx' });
  };
  try {
    gateway = await createNativeGatewayEvaluation({ ...options, hostProfileAuthMarker: authMarker, skipBootstrap: true, confineBusinessFiles: true,
      ...(providerKind === 'coding-plan' ? { provider: { api: 'openai-completions', baseUrl: simplifyProviderUrl, model },
        providerGuard: { kind: 'authorized_simplify_experiment', credential: () => process.env.RC_EVAL_API_KEY } } : {}),
      ...(provider ? { reviewerProvider, provider: { ...provider, definition: { ...provider.definition,
        ...(options.contextWindowTokens ? { contextWindow: options.contextWindowTokens } : {}) } },
        providerGuard: { kind: 'authorized_simplify_experiment', hostProfile: true, credential },
        onGatewayStart: () => fs.writeFile(path.join(options.outputRoot, 'gateway-start.json'), '{"starts":1}\n', { flag: 'wx' }) } : {}) });
  } catch (error) { await finish(); throw error; }
  return { ...gateway, providerIdentity, providerStatus: boundary?.snapshot,
    async close() { try { await gateway.close(); } finally { await finish(); } } };
}

export async function createSimplifyStopNative(options) {
  const { projectRoot, prebuiltPluginRoot } = options;
  const gateway = await createSimplifyGateway(options);
  try {
    const { createOpenClawReviewerFactory } = await loadPackaged(prebuiltPluginRoot, 'lib/openclaw/reviewer.mjs');
    const api = { id: 'runtime-corrector', runtime: gateway.runtime, config: gateway.config, logger: { warn() {} } };
    const run = createOpenClawReviewerFactory(api, { pluginRoot: gateway.pluginRoot,
      runEmbeddedAgent: params => gateway.runtime.agent.runEmbeddedAgent(params) });
    return { model: gateway.model, modelRef: gateway.modelRef, providerIdentity: gateway.providerIdentity, providerStatus: gateway.providerStatus, run, close: gateway.close,
      metrics: () => gateway.metrics(), root: gateway.root, port: gateway.port, projectRoot };
  } catch (error) {
    await gateway.close();
    throw error;
  }
}
