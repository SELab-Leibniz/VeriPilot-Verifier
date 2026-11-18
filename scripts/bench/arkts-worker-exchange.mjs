import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { digest } from './arkts-dataset.mjs';

const protocol = 'arkts-test-worker-v1';
const jobName = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u;
const maxJobMs = 60 * 60_000;
const exists = file => fs.stat(file).then(() => true, error => {
  if (error.code === 'ENOENT') return false;
  throw error;
});

export class ArktsWorkerJobError extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}

async function publish(directory, name, data) {
  const temporary = path.join(directory, `.${name}-${randomUUID()}`);
  await fs.writeFile(temporary, JSON.stringify(data), { flag: 'wx' });
  try {
    await fs.rename(temporary, path.join(directory, name));
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function submitArktsWorkerJob(exchange, action, input, { timeoutMs, signal, prepare, pollMs = 250 } = {}) {
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= maxJobMs, 'Invalid ArkTS worker timeout');
  const deadline = Date.now() + timeoutMs;
  const id = randomUUID();
  const directory = path.join(exchange, id);
  await fs.mkdir(directory);
  let published = false, settled = false;
  try {
    signal?.throwIfAborted();
    await prepare?.(directory);
    signal?.throwIfAborted();
    assert(Date.now() < deadline, 'ArkTS worker payload preparation exceeded its deadline');
    const request = { protocol, id, action, input, deadline };
    await publish(directory, 'request.json', request);
    published = true;
    const responsePath = path.join(directory, 'response.json');
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      if (await exists(responsePath)) {
        const response = JSON.parse(await fs.readFile(responsePath, 'utf8'));
        assert(response.protocol === protocol && response.id === id && response.requestSha256 === digest(JSON.stringify(request)),
          'ArkTS worker response differs from its submitted request');
        settled = true;
        if (response.failed) throw new ArktsWorkerJobError('rejected', `ArkTS worker job ${id} failed. See the worker log.`);
        return response.result;
      }
      await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())), undefined, { signal });
    }
    throw new ArktsWorkerJobError('deadline', `ArkTS worker job ${id} exceeded its deadline`);
  } finally {
    if (published && !settled) await fs.writeFile(path.join(directory, 'cancelled'), '', { flag: 'wx' });
    if (!published) await fs.rm(directory, { recursive: true, force: true });
  }
}

export async function serveArktsWorkerJobs(exchange, handle, { signal, pollMs = 250, onError = console.error } = {}) {
  while (!signal?.aborted) {
    const entries = await fs.readdir(exchange, { withFileTypes: true });
    for (const entry of entries) {
      if (signal?.aborted) break;
      if (!entry.isDirectory() || !jobName.test(entry.name)) continue;
      const id = entry.name, directory = path.join(exchange, id);
      const requestFile = path.join(directory, 'request.json');
      if (!await exists(requestFile) || await exists(path.join(directory, 'cancelled')) || await exists(path.join(directory, 'claimed'))) continue;
      // The claim is permanent. A lost connection or a stopped worker cannot
      // cause a previously accepted evaluation to run twice.
      try { await fs.mkdir(path.join(directory, 'claimed')); }
      catch (error) { if (error.code === 'EEXIST') continue; throw error; }
      let bytes, request;
      try {
        bytes = await fs.readFile(requestFile, 'utf8');
        request = JSON.parse(bytes);
        if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Expected a request object');
      } catch (error) {
        onError(`ArkTS worker job ${id}: invalid request (${error.code ?? error.name})`);
        await publish(directory, 'response.json', { protocol, id, requestSha256: digest(bytes ?? ''), failed: true });
        continue;
      }
      const response = { protocol, id, requestSha256: digest(JSON.stringify(request)) };
      const remainingMs = request.deadline - Date.now();
      if (request.protocol !== protocol || request.id !== id || !Number.isSafeInteger(remainingMs) || remainingMs <= 0 || remainingMs > maxJobMs) {
        await publish(directory, 'response.json', { ...response, failed: true });
        continue;
      }
      const controller = new AbortController();
      const cancel = () => controller.abort();
      signal?.addEventListener('abort', cancel, { once: true });
      const timeout = setTimeout(cancel, remainingMs);
      const check = setInterval(() => {
        exists(path.join(directory, 'cancelled')).then(cancelled => { if (cancelled) cancel(); }).catch(cancel);
      }, pollMs);
      try {
        if (signal?.aborted || await exists(path.join(directory, 'cancelled'))) cancel();
        controller.signal.throwIfAborted();
        response.result = await handle(request.action, request.input, { id, directory, deadline: request.deadline, signal: controller.signal });
        controller.signal.throwIfAborted();
      } catch (error) {
        onError(`ArkTS worker job ${id}: ${error.message}`);
        delete response.result;
        response.failed = true;
      } finally {
        clearTimeout(timeout);
        clearInterval(check);
        signal?.removeEventListener('abort', cancel);
      }
      await publish(directory, 'response.json', response);
    }
    await delay(pollMs, undefined, { signal }).catch(error => { if (!signal?.aborted) throw error; });
  }
}
