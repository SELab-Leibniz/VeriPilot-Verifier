// RC-owned development transport. Only the external controller receives real
// upstream authentication. Container-visible tickets contain a disposable cap.
import http from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { createProviderRequestBudget } from './provider-request-budget.mjs';
import { syntheticOpenAiSseUsage } from './synthetic-calibration-fetch.mjs';

export const CODING_CHAT_ENDPOINT = 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions';
const fail = code => Object.assign(new Error(code), { code });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const integer = value => Number.isSafeInteger(value) && value > 0;
const equal = (a, b) => Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Explicit controller-only construction; no environment lookup or CLI secret.
export function codingPlanRelayUpstream(credential, { fetchImpl = globalThis.fetch } = {}) {
  if (typeof credential !== 'string' || !credential.trim()) throw fail('RELAY_UPSTREAM_AUTH_MISSING');
  return ({ body, signal, onWireDispatch }) => {
    signal?.throwIfAborted();
    const init = { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` }, body, signal, redirect: 'error' };
    onWireDispatch?.();
    return fetchImpl(CODING_CHAT_ENDPOINT, init);
  };
}

function jsonUsage(bytes) {
  let response;
  try { response = JSON.parse(bytes.toString('utf8')); } catch { throw fail('BUDGET_USAGE_UNKNOWN'); }
  const usage = response.usage, input = usage?.prompt_tokens, output = usage?.completion_tokens;
  if (response.error || !response.choices?.some(choice => choice.finish_reason)
    || [input, output].some(value => !Number.isSafeInteger(value) || value < 0)
    || !Number.isSafeInteger(input + output) || usage.total_tokens !== undefined && usage.total_tokens !== input + output)
    throw fail('BUDGET_USAGE_UNKNOWN');
  return { input, output, cacheRead: 0, cacheWrite: 0 };
}

export async function createHarborProviderRelay({ upstream, limits, prices = { input: 7, output: 22, cacheRead: 7, cacheWrite: 7 },
  payloadBytes = 131072, responseBytes = 16 * 1024 * 1024, bind = '127.0.0.1', advertisedHost = '127.0.0.1',
  now = Date.now, onRecord = async () => {} }) {
  if (typeof upstream !== 'function') throw fail('RELAY_EXPLICIT_UPSTREAM_REQUIRED');
  if (!integer(payloadBytes) || !integer(responseBytes) || !limits || !integer(limits.wallMs)
    || !integer(limits.inputPerRequest) || limits.inputPerRequest < payloadBytes + 8192)
    throw fail('RELAY_INPUT_RESERVATION_INVALID');
  if (!['127.0.0.1', '0.0.0.0'].includes(bind) || !/^[a-zA-Z0-9.-]+$/u.test(advertisedHost)) throw fail('RELAY_BIND_INVALID');
  const placeholder = `rc-placeholder-${randomBytes(32).toString('hex')}`;
  const startedAt = now(), deadlineAt = startedAt + limits.wallMs;
  const budget = createProviderRequestBudget({ origin: new URL(CODING_CHAT_ENDPOINT).origin, limits, prices, now });
  const controller = new AbortController(), records = [], sockets = new Set();
  const maxConcurrent = limits.maxConcurrent ?? 1;
  if (!integer(maxConcurrent) || maxConcurrent > 4) throw fail('RELAY_CONCURRENCY_INVALID');
  let queued = 0, closed = false, upstreamInvocations = 0, wireDispatchAttempts = 0, running = 0, closing, preAdmissionCancelled = 0;
  const waiting = [], jobs = new Set();
  const pump = () => {
    while (running < maxConcurrent && waiting.length) {
      const { execute, resolve, reject } = waiting.shift(); running++;
      const job = Promise.resolve().then(execute).then(resolve, reject).finally(() => {
        running--; jobs.delete(job); pump();
      });
      jobs.add(job);
    }
  };
  const schedule = execute => new Promise((resolve, reject) => { waiting.push({ execute, resolve, reject }); pump(); });
  const timer = setTimeout(() => controller.abort(fail('BUDGET_WALL_LIMIT')), limits.wallMs);
  timer.unref?.();
  const snapshot = () => ({ startedAt, deadlineAt, queued, running, maxConcurrent, preAdmissionCancelled, closed, budget: budget.snapshot(),
    scope: hash(placeholder), admittedRequests: budget.snapshot().requests, upstreamInvocations, wireDispatchAttempts, records: structuredClone(records),
    dispatchCounting: 'Admission is not API traffic. wireDispatchAttempts counts the explicit trusted fetch boundary, not confirmed provider receipt or billing.',
    credentialKind: 'disposable_container_placeholder_only', actualAccountBill: 'unknown', model: 'openai/glm-5.3' });
  const server = http.createServer(async (request, response) => {
    if (closed || controller.signal.aborted) { response.writeHead(503); response.end(); return; }
    const authorization = request.headers.authorization ?? '';
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions'
      || !equal(authorization, `Bearer ${placeholder}`)) { response.writeHead(403); response.end(); return; }
    const local = new AbortController();
    const disconnected = () => { if (!response.writableEnded) local.abort(fail('RELAY_CLIENT_DISCONNECTED')); };
    request.once('aborted', disconnected); response.once('close', disconnected);
    const signal = AbortSignal.any([controller.signal, local.signal]);
    let body;
    try {
      const chunks = []; let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length; if (bytes > payloadBytes) throw fail('RELAY_BODY_LIMIT'); chunks.push(chunk);
      }
      body = Buffer.concat(chunks); const payload = JSON.parse(body.toString('utf8'));
      if (!Buffer.from(body.toString('utf8')).equals(body) || payload.model !== 'glm-5.3'
        || !Array.isArray(payload.messages) || !payload.messages.length
        || !integer(payload.max_tokens) || payload.max_tokens > limits.outputPerRequest
        || Object.hasOwn(payload, 'max_completion_tokens')
        || payload.stream === true && payload.stream_options?.include_usage !== true
        || payload.stream !== undefined && typeof payload.stream !== 'boolean') throw fail('RELAY_PAYLOAD_DENIED');
      // Reject multimodal data: this qualification's conservative byte bound
      // covers textual envelopes and tool definitions, not image/audio tokens.
      for (const message of payload.messages) if (!['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role)
        || Array.isArray(message.content) && message.content.some(part => part.type !== 'text')) throw fail('RELAY_MULTIMODAL_UNQUALIFIED');
      queued++;
      const execute = async () => {
        queued--;
        if (signal.aborted) { preAdmissionCancelled++; await onRecord(snapshot()); signal.throwIfAborted(); }
        const record = { request: budget.snapshot().requests + 1, requestSha256: hash(body), requestBytes: body.length,
          model: payload.model, stream: payload.stream === true, outputLimit: payload.max_tokens, admittedAt: now() };
        try {
          return await budget.run({ origin: new URL(CODING_CHAT_ENDPOINT).origin,
            inputTokensUpperBound: limits.inputPerRequest, maxOutputTokens: payload.max_tokens }, async ({ signal: admittedSignal }) => {
            records.push(record); await onRecord(snapshot());
            upstreamInvocations++;
            const upstreamResponse = await upstream({ body, signal: AbortSignal.any([signal, admittedSignal]), endpoint: CODING_CHAT_ENDPOINT,
              onWireDispatch() {
                if (record.wireAttemptedAt !== undefined) throw fail('RELAY_WIRE_DISPATCH_DUPLICATE');
                record.wireAttemptedAt = now(); wireDispatchAttempts++;
              } });
            record.httpStatus = upstreamResponse.status;
            response.statusCode = upstreamResponse.status;
            for (const name of ['content-type', 'x-request-id', 'retry-after']) {
              const value = upstreamResponse.headers.get(name); if (value) response.setHeader(name, value);
            }
            response.setHeader('cache-control', 'no-store');
            const chunks = []; let bytes = 0;
            for await (const chunk of upstreamResponse.body ?? []) {
              signal.throwIfAborted(); bytes += chunk.length;
              if (bytes > responseBytes) throw fail('RELAY_RESPONSE_LIMIT');
              chunks.push(Buffer.from(chunk)); if (!response.destroyed) response.write(chunk);
            }
            const complete = Buffer.concat(chunks);
            record.responseSha256 = hash(complete); record.responseBytes = complete.length;
            if (!response.destroyed) response.end();
            if (!upstreamResponse.ok) throw fail('BUDGET_USAGE_UNKNOWN');
            const usage = payload.stream === true ? syntheticOpenAiSseUsage(complete.toString('utf8')).usage : jsonUsage(complete);
            record.usage = usage;
            return { value: true, usage };
          });
        } catch (error) {
          record.failureCode = typeof error.code === 'string' ? error.code : 'RELAY_DISPATCH_FAILED';
          if (budget.snapshot().halted) controller.abort(fail(budget.snapshot().halted));
          if (!response.headersSent) { response.writeHead(502, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { type: 'relay_boundary', code: record.failureCode } })); }
          else if (!response.writableEnded) response.destroy();
        } finally { record.settledAt = now(); await onRecord(snapshot()); }
      };
      await schedule(execute);
    } catch {
      if (!response.headersSent) { response.writeHead(400); response.end(); }
      else if (!response.writableEnded) response.destroy();
    } finally { request.removeListener('aborted', disconnected); response.removeListener('close', disconnected); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, bind, resolve); });
  const port = server.address().port;
  return { ticket: () => ({ kind: 'rc-harbor-relay-ticket-v1', model: 'openai/glm-5.3',
    relayBaseUrl: `http://${advertisedHost}:${port}/v1`, placeholderCredential: placeholder, deadlineAt, officialWallMs: limits.wallMs,
    tokenLimits: { inputPerRequest: limits.inputPerRequest, outputPerRequest: limits.outputPerRequest,
      totalInput: limits.totalInput, totalOutput: limits.totalOutput, requests: limits.requests } }), snapshot,
    close() { return closing ??= (async () => {
      closed = true; clearTimeout(timer); controller.abort(fail('RELAY_CLOSED'));
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
      while (jobs.size || waiting.length) await Promise.all([...jobs]);
      if (budget.snapshot().inFlightRequests !== 0) throw fail('RELAY_UPSTREAM_STILL_IN_FLIGHT');
    })(); } };
}
