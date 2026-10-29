// Development-only, passive Undici diagnostics. Never retain request headers,
// URLs, bodies, response text, tool arguments or model thinking.
import fs from 'node:fs/promises';
import path from 'node:path';
import { channel } from 'node:diagnostics_channel';

const errorType = error => ['AbortError', 'TimeoutError', 'TypeError', 'Error'].includes(error?.name) ? error.name : 'OtherError';

export async function installProviderFetchTiming({ file, origin, progressIntervalMs = 15000 }) {
  if (!Number.isSafeInteger(progressIntervalMs) || progressIntervalMs < 1) throw new Error('A positive stream progress interval is required.');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const selectedOrigin = new URL(origin).origin, active = new Map(), subscriptions = [];
  let phase = 'setup', serial = 0, writes = Promise.resolve(), closed = false;
  const save = row => { writes = writes.then(() => fs.appendFile(file, JSON.stringify(row) + '\n')).catch(() => {}); };
  const finish = (request, event, failure = null, observerStopped = false) => {
    const state = active.get(request);
    if (!state) return;
    active.delete(request);
    save({ ...state.base, event, durationMs: Date.now() - state.started, bytes: state.bytes,
      firstBodyMs: state.firstBodyMs, bodyChunks: state.bodyChunks, failure, observerStopped });
  };
  const subscribe = (name, listener) => {
    // Diagnostics callbacks must never throw into the actual network request.
    const safe = value => { if (!closed) { try { listener(value); } catch { /* Observation only. */ } } };
    const port = channel(`undici:request:${name}`);
    port.subscribe(safe); subscriptions.push([port, safe]);
  };
  subscribe('create', ({ request }) => {
    if (new URL(request.origin).origin !== selectedOrigin) return;
    const base = { id: ++serial, phase, startedAt: new Date().toISOString() };
    const started = Date.now();
    active.set(request, { base, started, lastProgressAt: started, bytes: 0, bodyChunks: 0, firstBodyMs: null });
    save({ ...base, event: 'request' });
  });
  subscribe('headers', ({ request, response }) => {
    const state = active.get(request);
    if (state) save({ ...state.base, event: 'response', headersMs: Date.now() - state.started, status: response.statusCode });
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
  subscribe('error', ({ request, error }) => finish(request, 'request_error', errorType(error)));
  return {
    file, get requestCount() { return serial; }, setPhase(value) { phase = value; },
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
