// One serial extractor identity per canonical project and execution policy.
// Idle identities retain native context, never tools, leases or a model loop.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { sha256 } from '../runtime-v2/utils.mjs';

const owners = new WeakMap();
export const BASELINE_IDLE_MS = 10 * 60 * 1000;
// A cache bound, not a tokenizer estimate. Large completed histories stay on
// disk as evidence; the next extraction receives a fresh native context.
export const BASELINE_REUSE_BYTES = 128 * 1024;
export async function acquireBaselineAgent({ owner, projectRoot, agentId, selection, signal, deadlineAt,
  dispose = async () => {}, idleMs = BASELINE_IDLE_MS }) {
  if (!Number.isFinite(deadlineAt) || !Number.isFinite(idleMs) || idleMs < 1) throw new Error('Finite baseline deadlines are required');
  const root = await fs.realpath(projectRoot);
  const key = sha256({ root: process.platform === 'win32' ? root.toLowerCase() : root, agentId, selection });
  let pool = owners.get(owner);
  if (!pool) owners.set(owner, pool = new Map());
  let entry = pool.get(key);
  if (!entry) {
    const sessionId = randomUUID();
    entry = { sessionId, sessionKey: `agent:${agentId}:runtime-corrector:${sessionId}`, busy: false, waiters: new Set(), uses: 0 };
    entry.sessionFile = path.join(root, '.runtime-correction', 'baseline-agent', sessionId, 'host-session.jsonl');
    pool.set(key, entry);
    entry.ready = fs.mkdir(path.dirname(entry.sessionFile), { recursive: true });
  }
  try { await entry.ready; } catch (error) { if (pool.get(key) === entry) pool.delete(key); throw error; }
  while (entry.busy) {
    signal?.throwIfAborted();
    if (Date.now() >= deadlineAt) throw Object.assign(new Error('Baseline agent wait deadline'), { code: 'REVIEWER_DEADLINE' });
    await new Promise((resolve, reject) => {
      const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); entry.waiters.delete(done); resolve(); };
      const abort = () => { done(); reject(signal.reason); };
      const timer = setTimeout(done, Math.max(1, deadlineAt - Date.now()));
      entry.waiters.add(done); signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
  if (entry.retired) return acquireBaselineAgent({ owner, projectRoot, agentId, selection, signal, deadlineAt, dispose, idleMs });
  signal?.throwIfAborted();
  if (Date.now() >= deadlineAt) throw Object.assign(new Error('Baseline agent deadline'), { code: 'REVIEWER_DEADLINE' });
  // A cancelled/expired acquisition must leave an idle identity's cleanup
  // armed. Only a successful acquisition takes ownership of that timer.
  clearTimeout(entry.timer);
  entry.busy = true;
  const reused = entry.uses++ > 0;
  let released = false;
  return { sessionId: entry.sessionId, sessionKey: entry.sessionKey, sessionFile: entry.sessionFile, reused,
    workspace(cwd) { return entry.cwd ??= cwd; },
    async release({ ran = false, healthy = true } = {}) {
      if (released) return;
      released = true;
      const transcript = await fs.readFile(entry.sessionFile, 'utf8').catch(() => null);
      if (!healthy || ran || transcript !== null) {
        const assistant = transcript?.split(/\r?\n/u).some(line => {
          try { const value = JSON.parse(line); return value.type === 'message' && value.message?.role === 'assistant'; } catch { return false; }
        });
        // MA clears existing no-assistant logs before its next run, invalidating
        // any prefix bound before dispatch. Never pool that native identity.
        if (!healthy || !assistant || Buffer.byteLength(transcript ?? '') > BASELINE_REUSE_BYTES) {
          entry.retired = true;
          if (pool.get(key) === entry) pool.delete(key);
          await dispose(entry.sessionKey, entry.sessionId).catch(() => {});
        }
      }
      entry.busy = false;
      for (const wake of [...entry.waiters]) wake();
      if (entry.retired) return;
      entry.timer = setTimeout(async () => {
        if (entry.busy || entry.waiters.size || pool.get(key) !== entry) return;
        pool.delete(key);
        await dispose(entry.sessionKey, entry.sessionId).catch(() => {});
      }, idleMs);
      entry.timer.unref?.();
    } };
}
