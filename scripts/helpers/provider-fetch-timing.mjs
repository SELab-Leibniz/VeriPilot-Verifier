// Development-only, passive Undici diagnostics. Never retain request headers,
// URLs, bodies, response text, tool arguments or model thinking. Opt-in
// correlation retains only a hash of the native traceparent identifier.
import fs from 'node:fs/promises';
import path from 'node:path';
import { channel } from 'node:diagnostics_channel';
import { createHash } from 'node:crypto';

const errorType = error => ['AbortError', 'TimeoutError', 'TypeError', 'Error'].includes(error?.name) ? error.name : 'OtherError';
const transportCodes = new Set([
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT',
]);

export function providerTraceparentSha256(value) {
  if (typeof value !== 'string') return null;
  const match = /^00-([a-f0-9]{32})-([a-f0-9]{16})-[a-f0-9]{2}$/u.exec(value);
  if (!match || /^0+$/u.test(match[1]) || /^0+$/u.test(match[2])) return null;
  return createHash('sha256').update(value).digest('hex');
}

function traceparentSha256(headers) {
  const values = [];
  if (Array.isArray(headers)) {
    for (let index = 0; index + 1 < headers.length; index += 2) {
      if (typeof headers[index] === 'string' && headers[index].toLowerCase() === 'traceparent') values.push(headers[index + 1]);
    }
  } else if (typeof headers === 'string') {
    for (const match of headers.matchAll(/^traceparent:[ \t]*([^\r\n]*)/gimu)) values.push(match[1].trim());
  }
  return values.length === 1 ? providerTraceparentSha256(values[0]) : null;
}

export async function installProviderFetchTiming({ file, origin, progressIntervalMs = 15000, captureTraceparent = false }) {
  if (!Number.isSafeInteger(progressIntervalMs) || progressIntervalMs < 1) throw new Error('A positive stream progress interval is required.');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const selectedOrigin = new URL(origin).origin, active = new Map(), subscriptions = [], traceRequests = new Map();
  let phase = 'setup', serial = 0, writes = Promise.resolve(), closed = false;
  const save = row => { writes = writes.then(() => fs.appendFile(file, JSON.stringify(row) + '\n')).catch(() => {}); };
  const finish = (request, event, failure = null, observerStopped = false, details = {}) => {
    const state = active.get(request);
    if (!state) return;
    active.delete(request);
    const row = { ...state.base, event, durationMs: Date.now() - state.started, bytes: state.bytes,
      firstBodyMs: state.firstBodyMs, bodyChunks: state.bodyChunks, failure, observerStopped, ...details };
    if (row.traceparentSha256) traceRequests.set(row.id, { ...row, endedAt: state.started + row.durationMs });
    save(row);
  };
  const subscribe = (name, listener) => {
    // Diagnostics callbacks must never throw into the actual network request.
    const safe = value => { if (!closed) { try { listener(value); } catch { /* Observation only. */ } } };
    const port = channel(`undici:request:${name}`);
    port.subscribe(safe); subscriptions.push([port, safe]);
  };
  subscribe('create', ({ request }) => {
    if (new URL(request.origin).origin !== selectedOrigin) return;
    const started = Date.now();
    const traceHash = captureTraceparent ? traceparentSha256(request.headers) : null;
    const base = { id: ++serial, phase, startedAt: new Date(started).toISOString(), ...(traceHash ? { traceparentSha256: traceHash } : {}) };
    active.set(request, { base, started, lastProgressAt: started, bytes: 0, bodyChunks: 0, firstBodyMs: null });
    const row = { ...base, event: 'request' };
    if (traceHash) traceRequests.set(row.id, row);
    save(row);
  });
  subscribe('headers', ({ request, response }) => {
    const state = active.get(request);
    if (!state) return;
    state.responseStatus = response.statusCode;
    save({ ...state.base, event: 'response', headersMs: Date.now() - state.started, status: state.responseStatus });
  });
  subscribe('bodyChunkReceived', ({ request, chunk }) => {
    const state = active.get(request);
    if (!state) return;
    state.firstBodyMs ??= Date.now() - state.started;
    state.bytes += chunk.byteLength; state.bodyChunks++;
    const now = Date.now();
    if (now - state.lastProgressAt >= progressIntervalMs) {
      state.lastProgressAt = now;
      save({ ...state.base, event: 'response_progress', durationMs: now - state.started,
        bytes: state.bytes, bodyChunks: state.bodyChunks, firstBodyMs: state.firstBodyMs });
    }
  });
  subscribe('trailers', ({ request }) => finish(request, 'response_end'));
  subscribe('error', ({ request, error }) => {
    const code = transportCodes.has(error?.code) ? error.code : error?.cause?.code;
    finish(request, 'request_error', errorType(error), false, { responseStatus: active.get(request)?.responseStatus ?? null,
      ...(transportCodes.has(code) ? { transportCode: code } : {}) });
  });
  return {
    file, get requestCount() { return serial; }, setPhase(value) { phase = value; },
    traceRequests: () => structuredClone([...traceRequests.values()]),
    async close() {
      if (!closed) {
        closed = true;
        for (const [port, listener] of subscriptions) port.unsubscribe(listener);
        for (const request of active.keys()) finish(request, 'observation_end', null, true);
      }
      await writes;
    },
  };
}
