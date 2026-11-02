// Evaluation-only native hook. No tool execution, synthetic history or RC publication.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { currentReviewerProgress } from '../../lib/openclaw/internal-context.mjs';

export const integratedDeliverables = ['app.mjs', 'docs/guide.md'];
export const integratedInputs = ['requirements/original-contract.md', 'skills/delivery-verifier/SKILL.md', 'tools/verify.mjs'];
export const integratedHash = bytes => createHash('sha256').update(bytes).digest('hex');
const deny = reason => ({ block: true, blockReason: `INTEGRATED_FIXTURE_DENIED: ${reason}` });

async function checkPath(projectRoot, relative) {
  const target = path.resolve(projectRoot, relative);
  if (target !== path.join(projectRoot, relative)) throw new Error('Non-canonical fixture path');
  let cursor = target;
  while (cursor !== projectRoot) {
    const stat = await fs.lstat(cursor);
    if (stat.isSymbolicLink()) throw new Error('Fixture symlink denied');
    cursor = path.dirname(cursor);
  }
  if (await fs.realpath(projectRoot) !== projectRoot || await fs.realpath(target) !== target)
    throw new Error('Fixture path alias denied');
  return target;
}

async function actualPrivateOwner(projectRoot, ctx) {
  const bindings = globalThis[Symbol.for('runtime-corrector.openclaw.task-tools.v1')];
  const binding = bindings?.get(ctx.sessionKey) ?? [...bindings?.values() ?? []].find(item => item.sessionId === ctx.sessionId);
  if (binding) {
    // An existing owner is authoritative. A stale run must not fall through
    // into a session-only ALS match after failing this stronger identity.
    if (binding.sessionId !== ctx.sessionId || binding.sessionKey !== ctx.sessionKey || binding.runId !== ctx.runId) return false;
    try { binding.active(); return true; } catch { return false; }
  }
  const document = globalThis[Symbol.for('runtime-corrector.document-tools.v1')]?.get(ctx.sessionId);
  if (document) {
    if (document.runId !== ctx.runId) return false;
    try { document.active(); return true; } catch { return false; }
  }
  const progress = currentReviewerProgress(ctx);
  if (!progress || progress.sessionId !== ctx.sessionId || !progress.role
    || !/^[A-Za-z0-9_.-]{1,200}$/u.test(ctx.runId ?? '')) return false;
  // ALS identifies a reviewer but survives in late descendants. Reuse the
  // production factory's existing dispatch/settlement record as liveness;
  // never create a lease or publish a native-run record from the fence.
  const directory = path.join(projectRoot, '.runtime-correction/openclaw/native-runs');
  try {
    if ((await fs.lstat(directory)).isSymbolicLink()) return false;
    const matches = [];
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/u.test(entry.name)) continue;
      const file = path.join(directory, entry.name, `${ctx.runId}.json`);
      const stat = await fs.lstat(file).catch(() => null);
      if (!stat) continue;
      if (stat.isSymbolicLink() || !stat.isFile()) return false;
      const record = JSON.parse(await fs.readFile(file, 'utf8'));
      matches.push({ record, taskHash: entry.name });
    }
    if (matches.length !== 1) return false;
    const { record, taskHash } = matches[0];
    return record.runId === ctx.runId && record.sessionId === ctx.sessionId && record.role === progress.role
      && record.ownerPid === process.pid && record.status === 'DISPATCH_COMMITTED'
      && typeof record.taskId === 'string' && integratedHash(record.taskId) === taskHash;
  } catch { return false; }
}

export async function integratedFixtureFence({ fixture, business }, event, ctx = {}) {
  const name = event.toolName, args = event.params ?? {};
  const sessionId = ctx.sessionId ?? event.sessionId, sessionKey = ctx.sessionKey ?? event.sessionKey;
  const businessMatch = sessionId === business.sessionId || sessionKey === business.sessionKey;
  if (!businessMatch) {
    // Private tools retain their real owning-task gates. No substring-based
    // exemption, replaced private tools, fake source binding or generic exec.
    if (['exec', 'write', 'edit', 'apply_patch'].includes(name)) return deny('business tool outside its owning session');
    if (name === 'read' && !await actualPrivateOwner(fixture.projectRoot, { ...ctx, sessionId, sessionKey })) return deny('unbound native read');
    return;
  }
  if (sessionId !== business.sessionId || sessionKey !== business.sessionKey) return deny('session identity mismatch');
  if (!['read', 'write', 'edit', 'exec'].includes(name)) return deny('use the four public business tools');
  try {
    for (const [relative, sha] of Object.entries(fixture.immutableHashes))
      if (integratedHash(await fs.readFile(await checkPath(fixture.projectRoot, relative))) !== sha)
        return deny('a supplied input changed');
    if (name === 'exec') {
      if (fixture.deadlineAt !== null && fixture.deadlineAt - Date.now() < 10000)
        return deny('insufficient shared stage time for the finite verifier');
      const keys = new Set(['command', 'workdir', 'timeout', 'yieldMs', 'background']);
      if (Object.keys(args).some(key => !keys.has(key)) || args.command !== fixture.command
        || args.workdir !== fixture.projectRoot || args.timeout !== 10 || args.yieldMs !== 10000 || args.background !== false)
        return deny('only the exact public verifier command and finite execution options are allowed');
      for (const file of integratedDeliverables) await checkPath(fixture.projectRoot, file);
      if (await fs.realpath(fixture.nodeBinary) !== fixture.nodeBinary
        || integratedHash(await fs.readFile(fixture.nodeBinary)) !== fixture.nodeSha256)
        return deny('pinned Node executable changed');
      return;
    }
    if (args.path && args.file_path && args.path !== args.file_path) return deny('ambiguous file path');
    const selected = args.path ?? args.file_path;
    if (typeof selected !== 'string') return deny('an exact public file is required');
    const relative = path.relative(fixture.projectRoot, path.resolve(fixture.projectRoot, selected)).replaceAll(path.sep, '/');
    const allowed = name === 'read' ? [...integratedDeliverables, ...integratedInputs] : integratedDeliverables;
    if (!allowed.includes(relative)) return deny('path outside public inputs/deliverables');
    await checkPath(fixture.projectRoot, relative);
  } catch { return deny('fixture integrity/path check failed'); }
}

