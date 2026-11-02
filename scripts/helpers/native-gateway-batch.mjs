// Development-only provider admission for a real Gateway original/repair loop.
// It observes the installed serializer; it never supplies claims or verdicts.
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { createRequire } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { createProviderRequestBudget } from './provider-request-budget.mjs';
import { createNativeStopProviderFetch, validateNativeStopBatchLimits } from './native-stop-evaluation.mjs';
import { syntheticOpenAiSseUsage } from './synthetic-calibration-fetch.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const local = host => ['127.0.0.1', '::1', '[::1]', 'localhost'].includes(host);
const metadata = new Set(['https://openrouter.ai', 'https://raw.githubusercontent.com', 'https://registry.npmjs.org']);

export function gatewayBatchDestination(input, init, providerUrl = 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions') {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  const method = init?.method ?? input?.method ?? 'GET';
  if (local(url.hostname)) return 'loopback';
  if (url.href === providerUrl && method === 'POST') return 'provider';
  if (method === 'GET' && metadata.has(url.origin)) return 'blocked-startup-metadata';
  throw new Error('GATEWAY_EXTERNAL_DESTINATION_DENIED');
}

export async function installNativeGatewayBatch({ hostRoot, sourceRoot, outputRoot, projectRoot, manifest, offline = false }) {
  assert.equal(manifest.kind, 'native-gateway-original-loop-v1');
  assert.equal(manifest.credentialEnv, 'RC_NATIVE_GATEWAY_API_KEY');
  const provider = manifest.provider ?? { baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', model: 'glm-5.3' };
  const providerUrl = `${provider.baseUrl.replace(/\/$/u, '')}/chat/completions`;
  const providerOrigin = new URL(providerUrl).origin;
  assert(['https://open.bigmodel.cn/api/coding/paas/v4/chat/completions',
    'https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions'].includes(providerUrl), 'Unsupported metered provider route');
  const limits = validateNativeStopBatchLimits(manifest.limits);
  for (const [file, sha] of Object.entries(manifest.sourceHashes))
    assert.equal(digest(await fs.readFile(path.join(sourceRoot, file))), sha, `Unfrozen source: ${file}`);
  for (const [file, sha] of Object.entries(manifest.hostHashes))
    assert.equal(digest(await fs.readFile(path.join(hostRoot, file))), sha, `Unfrozen host: ${file}`);
  const prior = JSON.parse(await fs.readFile(path.join(sourceRoot, manifest.priorSettlement), 'utf8'));
  assert.equal(prior.inFlightRequests, 0);
  assert.equal(prior.totalProviderRequests, manifest.priorProviderRequests);
  assert.equal(prior.cumulativeReferenceEstimateIncludingOldHeldUsd, manifest.priorConservativeCommittedUsd);
  const deadlineAt = Math.min(Date.now() + limits.wallMs, Date.parse(manifest.stageDeadline));
  assert(Number.isFinite(deadlineAt) && deadlineAt > Date.now(), 'The batch launch deadline expired');
  const credential = offline ? 'offline-gateway-dummy-never-authenticated' : process.env[manifest.credentialEnv];
  assert(credential?.trim(), 'A dedicated transient Gateway credential is required');
  if (!offline) delete process.env[manifest.credentialEnv];
  if (!offline) await fs.writeFile(path.join(sourceRoot, manifest.launchClaim), JSON.stringify({
    outputRoot, startedAt: new Date().toISOString(), deadlineAt: new Date(deadlineAt).toISOString(),
  }, null, 2), { flag: 'wx', mode: 0o600 });
  const budget = createProviderRequestBudget({ origin: providerOrigin,
    limits: { usd: limits.usd, requests: limits.requests, wallMs: deadlineAt - Date.now(),
      inputPerRequest: limits.inputTokens, outputPerRequest: limits.outputTokens,
      totalInput: limits.requests * limits.inputTokens, totalOutput: limits.requests * limits.outputTokens },
    prices: { input: 7, output: 22, cacheRead: 7, cacheWrite: 7 } });
  const controller = new AbortController(), dispatchController = new AbortController(), socketScope = new AsyncLocalStorage();
  const stopCase = error => { controller.abort(error); dispatchController.abort(error); return error; };
  const requests = [], blockedStartupMetadata = [], denied = [];
  const oldFetch = globalThis.fetch, port = '__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__', oldRuntime = globalThis[port];
  const oldConnect = net.Socket.prototype.connect;
  const undici = createRequire(path.join(hostRoot, 'package.json'))('undici');
  let queue = Promise.resolve(), dispatches = 0, active;
  const timer = setTimeout(() => stopCase(new Error('GATEWAY_BATCH_WALL_LIMIT')), deadlineAt - Date.now());
  const metrics = () => ({ kind: offline ? 'offline_native_gateway_capture' : 'metered_native_gateway_original_loop',
    limits, deadlineAt: new Date(deadlineAt).toISOString(), budget: budget.snapshot(), requests,
    realProviderRequests: offline ? 0 : dispatches, simulatedDispatches: offline ? dispatches : 0,
    blockedStartupMetadata, denied, cumulativeProviderRequests: prior.totalProviderRequests + (offline ? 0 : dispatches),
    cumulativeConservativeReferenceUsd: prior.cumulativeReferenceEstimateIncludingOldHeldUsd + (offline ? 0 : budget.snapshot().estimatedCommittedUsd),
    actualAccountBill: 'unknown', offlineSemanticVerdictAccepted: false,
    stopped: controller.signal.aborted ? String(controller.signal.reason?.message ?? 'BATCH_STOPPED').replaceAll(credential, '[REDACTED_CREDENTIAL]') : null,
    dispatchStopped: dispatchController.signal.aborted ? String(dispatchController.signal.reason?.message ?? 'DISPATCH_STOPPED').replaceAll(credential, '[REDACTED_CREDENTIAL]') : null });
  const checkpoint = () => fs.writeFile(path.join(outputRoot, 'gateway-batch-checkpoint.json'), JSON.stringify(metrics(), null, 2));
  const wrapped = original => {
    // This phase covers the existing authoritative request/auth/envelope/source
    // checks, before budget admission. It is never inferred from error text.
    let boundaryPending = false, requestSignal;
    const fetchProvider = createNativeStopProviderFetch({ budget, maxPayloadBytes: limits.payloadBytes,
      providerUrl, expectedModel: provider.model,
      inputTokensUpperBound: limits.inputTokens, maxOutputTokens: limits.outputTokens,
      validateRequest(input, init) {
        controller.signal.throwIfAborted();
        requestSignal = init?.signal;
        const headers = new Headers(init?.headers ?? input?.headers);
        assert(headers.get('authorization') === `Bearer ${credential}`, 'Dedicated Gateway authentication mismatch');
      },
      async validatePayload(payload) {
        assert(!JSON.stringify(payload).includes(credential), 'Credential cannot enter a request body');
        assert(payload.messages.every(message => ['system', 'user', 'assistant', 'tool'].includes(message.role)));
        // The only workspace is newly authored for this run. Never inherit a
        // personal bootstrap file or an existing session's conversation.
        for (const name of ['SOUL.md', 'TOOLS.md', 'IDENTITY.md', 'USER.md', 'HEARTBEAT.md', 'BOOTSTRAP.md', 'MEMORY.md'])
          assert(!(await fs.lstat(path.join(projectRoot, name)).catch(() => null)), `Unexpected fixture bootstrap: ${name}`);
        for (const [file, sha] of Object.entries(manifest.sourceHashes))
          assert.equal(digest(await fs.readFile(path.join(sourceRoot, file))), sha, 'Execution source changed during batch');
        boundaryPending = false;
        controller.signal.throwIfAborted(); dispatchController.signal.throwIfAborted(); requestSignal?.throwIfAborted();
      },
      async onRequest(payload) {
        active = { request: budget.snapshot().requests, payloadSha256: digest(Buffer.from(JSON.stringify(payload))),
          payloadBytes: Buffer.byteLength(JSON.stringify(payload)), tools: (payload.tools ?? []).map(tool => tool.function.name) };
        requests.push(active);
        await fs.writeFile(path.join(outputRoot, `request-${active.request}.json`), JSON.stringify(payload, null, 2), { flag: 'wx' });
        await checkpoint();
      },
      async onResponse({ status, bytes }) {
        const text = bytes.toString('utf8'), safe = text.replaceAll(credential, '[REDACTED_CREDENTIAL]');
        await fs.writeFile(path.join(outputRoot, `response-${active.request}.sse`), safe, { flag: 'wx' });
        Object.assign(active, { status, responseSourceSha256: digest(bytes), responseStoredSha256: digest(Buffer.from(safe)),
          credentialRedacted: text !== safe });
        if (status >= 200 && status < 300) {
          try { Object.assign(active, syntheticOpenAiSseUsage(text)); } catch { active.usageUnknown = true; }
        } else active.usageUnknown = true;
      },
      async fetchImpl(input, init) {
        dispatches++;
        if (offline) {
          const text = 'OFFLINE_CAPTURE_ONLY; no baseline, review, business solution or acceptance is asserted.';
          const sse = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } })}\n\ndata: [DONE]\n\n`;
          setTimeout(() => stopCase(new Error('OFFLINE_GATEWAY_PAYLOAD_CAPTURED')), 0);
          return new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
        }
        return socketScope.run('provider', () => original(input, { ...init,
          signal: AbortSignal.any([controller.signal, dispatchController.signal, ...(init.signal ? [init.signal] : [])]) }));
      } });
    return async (input, init) => {
      let destination;
      try { destination = gatewayBatchDestination(input, init, providerUrl); }
      catch (error) { denied.push({ kind: 'external-fetch' }); throw stopCase(error); }
      if (destination === 'loopback') return original(input, init);
      if (destination === 'blocked-startup-metadata') {
        blockedStartupMetadata.push({ origin: new URL(typeof input === 'string' ? input : input.url ?? input).origin, method: 'GET' });
        throw new Error('GATEWAY_STARTUP_METADATA_BLOCKED');
      }
      const execute = async () => {
        boundaryPending = false;
        try {
          controller.signal.throwIfAborted(); dispatchController.signal.throwIfAborted(); init?.signal?.throwIfAborted();
          boundaryPending = true;
          return await fetchProvider(input, init);
        }
        catch (error) {
          dispatchController.abort(error);
          if (boundaryPending) stopCase(error);
          throw error;
        }
        finally { await checkpoint(); }
      };
      const job = queue.then(execute); queue = job.catch(() => {}); return job;
    };
  };
  globalThis.fetch = wrapped(oldFetch); globalThis[port] = { ...undici, fetch: wrapped(undici.fetch) };
  net.Socket.prototype.connect = function (...options) {
    const normalized = Array.isArray(options[0]) ? options[0] : options;
    const option = normalized[0], host = typeof option === 'object' ? option.host ?? 'localhost'
      : typeof normalized[1] === 'string' ? normalized[1] : 'localhost';
    if (!(local(host) && !(typeof option === 'object' && option.path) && typeof option !== 'string')
      && (offline || socketScope.getStore() !== 'provider')) {
      denied.push({ kind: 'external-socket', host }); throw stopCase(new Error('GATEWAY_EXTERNAL_SOCKET_DENIED'));
    }
    return oldConnect.apply(this, options);
  };
  return { kind: 'metered_native_gateway_batch', credential: () => credential, signal: controller.signal, metrics,
    abort(reason = new Error('GATEWAY_OWNER_STOPPED')) { stopCase(reason); },
    async close() {
      clearTimeout(timer); await queue; await checkpoint();
      assert.equal(budget.snapshot().inFlightRequests, 0, 'Do not uninstall a boundary with in-flight provider consumption');
      globalThis.fetch = oldFetch; net.Socket.prototype.connect = oldConnect;
      if (oldRuntime === undefined) delete globalThis[port]; else globalThis[port] = oldRuntime;
      await fs.writeFile(path.join(outputRoot, 'gateway-batch-result.json'), JSON.stringify(metrics(), null, 2));
    } };
}
