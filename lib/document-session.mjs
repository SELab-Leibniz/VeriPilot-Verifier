import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWriteJson, readJson, sha256 } from './runtime-v2/utils.mjs';

// A project has one execution slot, even across plugin registries/processes.
// Only our own live process may reuse a native identity. Crash recovery rotates
// the identity; durable notes survive, but never constitute current evidence.
const registryKey = Symbol.for('runtime-corrector.document-sessions.v1');
const sessions = globalThis[registryKey] ??= new Map();
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };
export const DOCUMENT_IDLE_MS = 30 * 60 * 1000;

export async function acquireDocumentSession({ projectRoot, identity, deadlineAt = Date.now() + 30000,
  signal, idleMs = DOCUMENT_IDLE_MS, maxRounds = 32, transport = null, closeNative = async () => {} }) {
  const root = await fs.realpath(projectRoot);
  const directory = path.join(root, '.runtime-correction', 'document-agent');
  await fs.mkdir(directory, { recursive: true });
  const lockPath = path.join(directory, 'active.lock');
  const token = randomUUID();
  const active = () => { signal?.throwIfAborted(); if (Date.now() >= deadlineAt) throw new Error('DOCUMENT_REVIEW_DEADLINE'); };
  // Bakery claims have unique filenames. Reclaiming a dead claim can never
  // unlink a replacement owner's lock (the shared-path ABA race).
  await fs.mkdir(lockPath, { recursive: true });
  const claimPath = path.join(lockPath, `${token}.json`);
  const claims = async () => {
    const values = [];
    for (const name of await fs.readdir(lockPath)) {
      if (!/^[a-f0-9-]+[.]json$/u.test(name)) continue;
      const file = path.join(lockPath, name), value = await readJson(file).catch(() => null);
      if (!value) continue; // Atomic publishers expose only complete claims.
      if (!alive(value.pid)) { await fs.rm(file, { force: true }); continue; }
      values.push(value);
    }
    return values;
  };
  try {
    active();
    await atomicWriteJson(claimPath, { pid: process.pid, token, ticket: null });
    const ticket = 1 + Math.max(0, ...(await claims()).map(claim => claim.ticket ?? 0));
    await atomicWriteJson(claimPath, { pid: process.pid, token, ticket });
    for (;;) {
      active();
      const others = (await claims()).filter(claim => claim.token !== token);
      if (!others.some(claim => claim.ticket === null || claim.ticket < ticket || claim.ticket === ticket && claim.token < token)) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  } catch (error) { await fs.rm(claimPath, { force: true }); throw error; }
  let entry, released = false;
  const unlock = () => fs.rm(claimPath, { force: true });
  try {
    active();
    entry = sessions.get(root);
    const signature = sha256(identity);
    if (entry && (entry.disposal || entry.signature !== signature || entry.rounds >= maxRounds || Date.now() - entry.lastUsed > idleMs)) {
      await entry.dispose(); entry = null;
    }
    if (!entry) {
      const sessionId = randomUUID(), sessionDirectory = path.join(directory, sessionId);
      await fs.mkdir(sessionDirectory, { recursive: true });
      entry = { root, signature, sessionId, sessionDirectory, transport, rounds: 0, lastUsed: Date.now(), busy: false,
        dispose() {
          clearTimeout(this.timer);
          return this.disposal ??= (async () => {
            try {
              await closeNative(this.sessionId);
              await fs.rm(this.sessionDirectory, { recursive: true, force: true });
              const statusPath = path.join(directory, 'status.json');
              if ((await readJson(statusPath))?.sessionId === this.sessionId)
                await atomicWriteJson(statusPath, { phase: 'released', label: '文档·已释放', sessionId: this.sessionId, updatedAt: Date.now() });
            } finally { if (sessions.get(root) === this) sessions.delete(root); }
          })();
        } };
      sessions.set(root, entry);
    }
    clearTimeout(entry.timer); entry.busy = true;
    await atomicWriteJson(path.join(directory, 'status.json'), { phase: 'reviewing', label: '文档·评审', sessionId: entry.sessionId,
      round: entry.rounds + 1, pid: process.pid, startedAt: Date.now(), deadlineAt });
    return { sessionId: entry.sessionId, sessionDirectory: entry.sessionDirectory, transport: entry.transport, reused: entry.rounds > 0,
      cached(key) { return entry.cache?.key === key ? structuredClone(entry.cache.value) : null; },
      rememberResult(key, value) { entry.cache = value ? { key, value: structuredClone(value) } : null; },
      async release({ healthy = true } = {}) {
        if (released) return; released = true;
        try {
          entry.busy = false; entry.rounds++; entry.lastUsed = Date.now();
          await atomicWriteJson(path.join(directory, 'status.json'), { phase: healthy ? 'idle' : 'interrupted', label: healthy ? '文档·就绪' : '文档·中断',
            sessionId: entry.sessionId, round: entry.rounds, updatedAt: entry.lastUsed });
          if (!healthy) await entry.dispose();
          else { entry.timer = setTimeout(() => { if (!entry.busy) void entry.dispose().catch(() => {}); }, idleMs); entry.timer.unref?.(); }
        } finally { await unlock(); }
      } };
  } catch (error) { await unlock(); throw error; }
}

export async function releaseDocumentSessions(projectRoot) {
  const root = projectRoot ? await fs.realpath(projectRoot).catch(() => projectRoot) : null;
  await Promise.all([...sessions.values()].filter(entry => (!root || entry.root === root) && !entry.busy).map(entry => entry.dispose()));
}
