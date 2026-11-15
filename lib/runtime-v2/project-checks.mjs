import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runConfiguredProjectCommand, projectWorkspaceDigest } from './regression-evidence.mjs';
import { outsideDecision } from './decision-scope.mjs';
import { atomicWriteJson, readJson, sha256 } from './utils.mjs';

const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};
const unavailable = (check, reason) => ({ id: check.id, source: check.source, metrics: check.metrics,
  command: check.command, cwd: check.cwd, status: 'UNAVAILABLE', reason, executionConfirmed: false });

/** Execute only explicit trusted configuration for selected acceptance items.
 * A command result never creates an obligation or proves overall acceptance. */
export async function runProjectChecks({ projectRoot, checks = [], population, deadlineAt = Infinity,
  signal, cacheDirectory, excluded = [], now = Date.now }) {
  const selected = checks.filter(check => check.enabled && check.metrics.some(id => population?.reviewPolicy?.metrics?.[id] !== false
    && population?.metrics?.[id]?.length));
  if (!selected.length) return null;
  signal?.throwIfAborted();
  const root = await fs.realpath(projectRoot), digest = await projectWorkspaceDigest(root, excluded, signal);
  const results = [];
  let drift = false;
  for (const check of selected) {
    signal?.throwIfAborted();
    if (drift || !digest) { results.push(unavailable(check, drift ? 'INPUT_CHANGED' : 'INPUT_IDENTITY_UNAVAILABLE')); continue; }
    let source, cwd;
    try {
      const sourcePath = await fs.realpath(path.resolve(root, check.source.path));
      cwd = await fs.realpath(path.resolve(root, check.cwd));
      if (!inside(root, sourcePath) || !inside(root, cwd)) throw new Error('PATH_OUTSIDE_PROJECT');
      source = await fs.readFile(sourcePath);
      if (sha256(source) !== check.source.sha256) throw new Error('SOURCE_CHANGED');
      if (check.source.end > source.toString('utf8').split(/\r?\n/u).length) throw new Error('SOURCE_RANGE_UNAVAILABLE');
    } catch (error) {
      signal?.throwIfAborted();
      results.push(unavailable(check, ['PATH_OUTSIDE_PROJECT', 'SOURCE_CHANGED', 'SOURCE_RANGE_UNAVAILABLE'].includes(error.message)
        ? error.message : 'SOURCE_OR_CWD_UNAVAILABLE')); continue;
    }
    if (await projectWorkspaceDigest(root, excluded, signal) !== digest) {
      drift = true; results.push(unavailable(check, 'INPUT_CHANGED')); continue;
    }
    const identity = { id: check.id, source: check.source, metrics: check.metrics, command: check.command,
      cwd: check.cwd, timeoutMs: check.timeoutMs, maxOutputBytes: check.maxOutputBytes, workspaceDigest: digest };
    const key = sha256(identity), file = cacheDirectory && path.join(cacheDirectory, key + '.json');
    const cached = file && await outsideDecision(() => readJson(file)).catch(() => null);
    if (cached?.key === key && cached.workspaceDigest === digest && cached.executionConfirmed === true
      && ['PASSED', 'FAILED'].includes(cached.status)) {
      results.push({ ...cached, cached: true }); continue;
    }
    const budget = Math.min(check.timeoutMs, Math.floor(deadlineAt - now()));
    if (budget < 1000) { results.push(unavailable(check, 'STOP_DEADLINE')); continue; }
    const startedAt = now();
    const execution = await runConfiguredProjectCommand(check.command, { cwd, timeoutMs: budget,
      maxOutputBytes: check.maxOutputBytes, signal });
    const cancelled = signal?.aborted === true;
    drift = cancelled ? false : await projectWorkspaceDigest(root, excluded, signal) !== digest;
    const status = cancelled || drift || execution.reason || !Number.isInteger(execution.exitCode) ? 'UNAVAILABLE'
      : execution.exitCode === 0 ? 'PASSED' : 'FAILED';
    const result = { kind: 'runtime-corrector.project-check.v1', origin: 'PROGRAM_VERIFICATION', ...identity, key,
      startedAt, endedAt: now(), effectiveTimeoutMs: budget, ...execution, status,
      ...(status === 'UNAVAILABLE' ? { reason: cancelled ? 'CANCELLED' : drift ? 'INPUT_CHANGED' : execution.reason ?? 'NO_EXIT_STATUS' } : {}),
      executionConfirmed: status !== 'UNAVAILABLE', cached: false };
    results.push(result);
    if (cacheDirectory) await outsideDecision(() => atomicWriteJson(path.join(cacheDirectory,
      `attempt-${check.id}-${randomUUID()}.json`), result));
    signal?.throwIfAborted();
    if (file && result.executionConfirmed) await outsideDecision(() => atomicWriteJson(file, result)).catch(() => {});
  }
  // A later command must not leave an earlier result looking current after it
  // changes the candidate. Keep real exits/output, invalidate their binding.
  drift ||= await projectWorkspaceDigest(root, excluded, signal) !== digest;
  if (drift) for (const result of results) Object.assign(result, {
    status: 'UNAVAILABLE', reason: 'INPUT_CHANGED', executionConfirmed: false });
  return { kind: 'runtime-corrector.project-checks.v1', origin: 'PROGRAM_VERIFICATION', workspaceDigest: digest,
    checks: results, notice: 'Explicit configured command observations only. Match the original source and scope before judging an acceptance item. Missing, changed, interrupted or unavailable evidence remains UNVERIFIED. Passing commands do not prove untested behavior or overall acceptance; failed commands alone are not a business deviation.' };
}
