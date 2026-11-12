import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const processAlive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
// An owner file being written reads as no owner yet; the orphan age then applies.
const readOwner = file => fs.readFile(file, 'utf8').then(text => { try { return JSON.parse(text); } catch { return null; } }, () => null);
// Cross-process exclusion by atomic directory creation. A lock left by an exited
// owner is reclaimed; a live owner is waited for until the timeout.
export async function withFileLock(lockPath, action, { timeoutMs = 600000, pollMs = 100, orphanMs = 30000, alive = processAlive } = {}) {
  const owner = path.join(lockPath, 'owner.json'), deadline = Date.now() + timeoutMs, token = randomUUID();
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  for (;;) {
    try { await fs.mkdir(lockPath); break; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const holder = await readOwner(owner);
    const created = holder ? null : await fs.stat(lockPath).then(stat => stat.mtimeMs, () => null);
    if (holder && !alive(holder.pid) || !holder && created !== null && Date.now() - created > orphanMs) {
      const stale = `${lockPath}.stale-${token}`;
      if (await fs.rename(lockPath, stale).then(() => true, () => false)) await fs.rm(stale, { recursive: true, force: true });
      continue;
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${lockPath}${holder ? ` held by pid ${holder.pid}` : ''}`);
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  try {
    await fs.writeFile(owner, JSON.stringify({ pid: process.pid, token, acquiredAt: new Date().toISOString() }));
    return await action();
  } finally {
    const current = await readOwner(owner);
    if (current?.token === token) await fs.rm(lockPath, { recursive: true, force: true });
  }
}
export const worktreeLockPath = cache => `${path.resolve(cache)}.worktree-lock`;
