import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { digest } from './arkts-dataset.mjs';
import { shortArktsWorkspace } from './short-workspace.mjs';
import { withFileLock, worktreeLockPath } from './file-lock.mjs';
import { businessMutationPaths, validateBusinessMutationPaths } from './business-mutations.mjs';
import { nativeStopGrace as createNativeStopGrace, nativeStopSettlement, readNativeStopRecords } from './native-stop-settlement.mjs';
import { loadPackaged, redactEvaluationText, summarizeProviderUsage, waitSimplifyRunTerminal } from '../helpers/simplify-native-evaluation.mjs';
import { measureSimplifyBenchmark } from '../helpers/simplify-stop-benchmark.mjs';

const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const save = (file, value) => fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
const gitAt = (executable, root, ...args) => execFileSync(executable, ['-c', 'core.longpaths=true', '-C', root, ...args],
  { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });

export async function freezeArktsDraft({ git, sourceRun, output, variantWorkspace, rollback }) {
  const manifest = await read(path.join(sourceRun, 'manifest.json'));
  const result = await read(path.join(sourceRun, 'result.json'));
  if (manifest.simplifyArm !== 'S0' || !result.actualBusinessStart || !result.businessCompleted || !result.infrastructureComplete
    || result.originalRunId !== result.officialBusinessTerminal?.runId || result.officialBusinessTerminal?.status !== 'ok')
    throw new Error('Frozen review requires the authenticated natural S0 terminal.');
  const source = variantWorkspace ?? manifest.projectRoot;
  const scope = await read(path.join(sourceRun, 'candidate-scope.json'));
  const mutationPaths = validateBusinessMutationPaths(scope.mutationPaths, source);
  if (!mutationPaths.length || !variantWorkspace && !result.patchBytes) throw new Error('No business implementation patch to freeze.');
  if (variantWorkspace && !rollback?.trim()) throw new Error('Record which changes were withdrawn from the draft.');
  const runGit = (...args) => gitAt(git, source, ...args);
  const base = manifest.preparedHead;
  if (!variantWorkspace && runGit('rev-parse', 'HEAD').toString().trim() !== base) throw new Error('S0 prepared HEAD changed.');
  if (!variantWorkspace) {
    const captured = await fs.readFile(path.join(sourceRun, 'candidate.patch'));
    if (!captured.equals(runGit('diff', '--binary', base, '--', ...mutationPaths))) throw new Error('S0 worktree differs from its candidate capture.');
    runGit('--literal-pathspecs', 'add', '--all', '--', ...mutationPaths);
    runGit('-c', 'user.name=RC Benchmark', '-c', 'user.email=rc@example.invalid', '-c', 'core.hooksPath=nonexistent', 'commit', '--quiet', '-m', 'Freeze ArkTS S0 candidate');
  }
  const commit = runGit('rev-parse', 'HEAD').toString().trim();
  runGit('merge-base', '--is-ancestor', base, commit);
  const patch = runGit('diff', '--binary', base, commit);
  const changed = runGit('diff', '--name-only', '-z', base, commit).toString().split('\0').filter(Boolean);
  if (changed.some(file => !mutationPaths.includes(file))) throw new Error('Frozen commit changes files outside the attributable business patch.');
  const sourceTranscript = path.join(sourceRun, 'native-host', `${result.sessionId}.jsonl`);
  const transcript = await fs.readFile(sourceTranscript);
  await fs.mkdir(output);
  await fs.writeFile(path.join(output, 'session.jsonl'), transcript, { flag: 'wx' });
  await fs.writeFile(path.join(output, 'candidate.patch'), patch, { flag: 'wx' });
  await save(path.join(output, 'freeze.json'), {
    instanceId: manifest.instanceId, datasetDigest: manifest.datasetDigest, artifactSha256: manifest.artifactSha256,
    planSha256: manifest.planSha256, sourceRun: path.resolve(sourceRun), sessionId: result.sessionId, sessionKey: result.sessionKey,
    originalRunId: result.originalRunId, terminal: result.officialBusinessTerminal, preparedHead: base, commit,
    commitSha256: digest(runGit('cat-file', 'commit', commit)), patchSha256: digest(patch), sessionSha256: digest(transcript), mutationPaths,
    ...(variantWorkspace ? { rollback } : {}),
  });
}

export async function prepareFrozenArktsWorkspace({ frozenRoot, freezeSha256, task, datasetDigest, artifactSha256, planSha256,
  git, cacheRoot, outputRoot, workspaceRoot }) {
  const bytes = await fs.readFile(path.join(frozenRoot, 'freeze.json'));
  const frozen = JSON.parse(bytes);
  if (digest(bytes) !== freezeSha256 || frozen.instanceId !== task.instance_id || frozen.datasetDigest !== datasetDigest
    || frozen.artifactSha256 !== artifactSha256 || frozen.planSha256 !== planSha256
    || frozen.terminal?.status !== 'ok' || frozen.terminal.runId !== frozen.originalRunId
    || ![frozen.commit, frozen.preparedHead].every(value => /^[a-f0-9]{40}$/u.test(value))) throw new Error('Frozen ArkTS manifest identity changed.');
  const transcript = await fs.readFile(path.join(frozenRoot, 'session.jsonl'));
  const patch = await fs.readFile(path.join(frozenRoot, 'candidate.patch'));
  const cache = path.join(cacheRoot, `${task.repo.replace('/', '--')}.git`);
  const cacheGit = (...args) => gitAt(git, cache, ...args);
  if (digest(transcript) !== frozen.sessionSha256 || digest(patch) !== frozen.patchSha256
    || digest(cacheGit('cat-file', 'commit', frozen.commit)) !== frozen.commitSha256
    || !cacheGit('diff', '--binary', frozen.preparedHead, frozen.commit).equals(patch)) throw new Error('Frozen ArkTS bytes changed.');
  // Dependencies are installed on the prepared tree before the candidate exists.
  if (frozen.mutationPaths?.some(file => /(?:^|\/)oh-package(?:-lock)?\.json5$/u.test(file)))
    throw new Error('Frozen replay cannot apply a candidate that changes oh-package dependencies after installation.');
  const projectRoot = shortArktsWorkspace(outputRoot, 'biz', undefined, workspaceRoot);
  await fs.mkdir(outputRoot);
  await fs.mkdir(path.dirname(projectRoot), { recursive: true });
  // The task-start manifest must see the prepared tree; the candidate is applied
  // as uncommitted changes only after the replayed pre-mutation hooks.
  await withFileLock(worktreeLockPath(cache), () => cacheGit('worktree', 'add', '--detach', projectRoot, frozen.preparedHead));
  return { projectRoot, preparedHead: frozen.preparedHead, baseCommit: task.base_commit, environmentAdapted: true,
    frozenRoot, frozen, transcript, patch };
}

export async function assertFrozenTaskStart({ taskStartManifestPath, projectRoot, taskId, preparedHead }) {
  const file = taskStartManifestPath(projectRoot, taskId);
  const start = await fs.readFile(file, 'utf8').then(JSON.parse, error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!start) throw new Error(`Frozen replay: the pre-mutation hooks did not capture task-start.json for task ${taskId}.`);
  if (start.complete !== true || start.head !== preparedHead)
    throw new Error(`Frozen replay: task-start.json recorded head ${start.head ?? start.reasonCode ?? 'unknown'}, expected prepared HEAD ${preparedHead}.`);
  return { file, start };
}

// Working-tree bytes must be what a checkout of the frozen commit produces
// (git cat-file --filters applies the same eol/smudge conversion as git apply);
// the clean blob id must equal the frozen commit's blob.
export async function applyFrozenCandidate({ git, projectRoot, patch, commit, mutationPaths }) {
  execFileSync(git, ['-c', 'core.longpaths=true', '-C', projectRoot, 'apply', '--binary', '--whitespace=nowarn', '-'],
    { input: patch, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const run = (...args) => gitAt(git, projectRoot, ...args);
  const blob = spec => { try { return run('rev-parse', '--verify', '-q', spec).toString().trim(); } catch { return null; } };
  for (const file of mutationPaths) {
    const spec = `${commit}:${file}`, expected = blob(spec);
    const actual = await fs.readFile(path.join(projectRoot, file)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (expected === null ? actual !== null : actual === null || !actual.equals(run('cat-file', '--filters', spec))
      || run('hash-object', `--path=${file}`, '--', file).toString().trim() !== expected)
      throw new Error(`Frozen replay: ${file} differs from the frozen commit after applying candidate.patch.`);
  }
}

export async function reviewFrozenArktsDraft({ gateway, prepared, manifest, profile, git, outputRoot, maxCorrections = 1 }) {
  const { projectRoot, frozen, transcript } = prepared;
  const { sessionId, sessionKey, originalRunId } = frozen;
  const sessionFile = path.join(gateway.root, `${sessionId}.jsonl`);
  const records = transcript.toString('utf8').split(/\r?\n/u).filter(Boolean).map(JSON.parse);
  const messages = records.filter(record => record.type === 'message').map(record => record.message);
  const user = messages.find(message => message.role === 'user');
  const last = messages.findLast(message => message.role === 'assistant');
  const text = message => typeof message?.content === 'string' ? message.content : message?.content?.filter(item => item.type === 'text').map(item => item.text).join('\n');
  if (!text(user) || !text(last) || records[0]?.id !== sessionId) throw new Error('Frozen business conversation is incomplete.');
  const mutationPaths = validateBusinessMutationPaths(frozen.mutationPaths, projectRoot);
  await fs.writeFile(sessionFile, transcript, { flag: 'wx' });
  await gateway.runtime.agent.session.upsertSessionEntry({ agentId: 'main', sessionKey, storePath: gateway.config.session.store,
    entry: { sessionId, sessionFile, spawnedCwd: projectRoot, updatedAt: Date.now() } });
  const context = { agentId: 'main', sessionId, sessionKey, runId: originalRunId, workspaceDir: projectRoot, trigger: 'user',
    modelProviderId: gateway.modelRef.split('/')[0], modelId: gateway.model };
  const load = file => loadPackaged(gateway.pluginRoot, file);
  const [{ findTask }, { createStopCorrectionStore }, { listNativeRuns }, { taskStartManifestPath }] = await Promise.all([
    load('lib/runtime-v2/task-store.mjs'), load('lib/runtime-v2/stop-correction-store.mjs'), load('lib/openclaw/native-runs.mjs'),
    load('lib/runtime-v2/task-changes.mjs'),
  ]);
  const store = createStopCorrectionStore({ directory: path.join(gateway.runtime.state.resolveStateDir(), 'runtime-corrector-stop-sessions') });
  const startedAt = Date.now();
  const deadline = startedAt + profile.totalTimeoutMs;
  gateway.setPhase('arkts-frozen-stop-and-repair');
  await gateway.hooks.runSessionStart({ sessionId, source: 'startup' }, context);
  await gateway.hooks.runBeforePromptBuild({ prompt: text(user), messages }, context);
  // Replay the original pre-mutation hooks on the prepared tree (this creates the
  // task and its start manifest), then write the verified candidate as the
  // business turn did, uncommitted, before the terminal hooks.
  for (const file of mutationPaths) await gateway.hooks.runBeforeToolCall({ toolName: 'write', toolCallId: `frozen-${randomUUID()}`,
    params: { path: path.join(projectRoot, file) } }, context);
  const registered = globalThis[Symbol.for('runtime-corrector.openclaw.session-project-state')];
  const active = [...(registered?.values() ?? [])].flatMap(value => [...(value.states?.values() ?? [])])
    .find(value => value.sessionId === sessionId && path.relative(value.projectRoot, projectRoot) === '');
  if (!active?.projectScope.enabled || !active.nativeNeedsStop) throw new Error('The isolated native hooks did not arm the frozen Stop.');
  const startedTask = await findTask({ projectRoot, sessionId });
  if (!startedTask) throw new Error('Frozen replay: the pre-mutation hooks did not create the RC task.');
  const taskStart = await assertFrozenTaskStart({ taskStartManifestPath, projectRoot, taskId: startedTask.taskId, preparedHead: prepared.preparedHead });
  await applyFrozenCandidate({ git, projectRoot, patch: prepared.patch, commit: frozen.commit, mutationPaths });
  await gateway.hooks.runBeforeAgentFinalize({ sessionId, runId: originalRunId, lastAssistantMessage: text(last) }, context);
  await gateway.hooks.runAgentEnd({ sessionId, runId: originalRunId, success: true, messages }, context);
  let task, ledger, initial, admission, runs = [], terminal, nativeStop, nativeStopReason = null;
  const nativeStopGrace = createNativeStopGrace();
  const terminals = new Map();
  // Assessment mode releases Stop when feedback is prepared. The host can
  // still be between that handoff and its trusted business model start.
  const settled = item => item.accounting === 'RELEASED' && !item.startedAt
    || terminals.get(item.hostRequest?.runId) && (item.finalReview || terminals.get(item.hostRequest.runId).status === 'error');
  while (Date.now() < deadline && !gateway.providerStatus()?.failure) {
    await gateway.drain();
    task = await findTask({ projectRoot, sessionId });
    ledger = await store.inspect(sessionId);
    initial = Object.values(ledger?.stops ?? {}).find(stop => stop.id.startsWith(originalRunId));
    admission = initial?.admissionId ? ledger.admissions[initial.admissionId] : null;
    runs = task ? await listNativeRuns(projectRoot, task.taskId) : [];
    for (const item of maxCorrections > 1 ? Object.values(ledger?.admissions ?? {}) : [admission].filter(Boolean)) {
      const runId = item.hostRequest?.runId;
      if (!runId || terminals.has(runId)) continue;
      const observed = await waitSimplifyRunTerminal(gateway, runId, Math.min(deadline, Date.now() + 1500));
      if (observed) terminals.set(runId, observed);
    }
    terminal = terminals.get(admission?.hostRequest?.runId);
    const finished = initial && initial.reviewStatus !== 'PENDING' && initial.control === 'ALLOW'
      && (!initial.admissionId || settled(admission))
      && (maxCorrections === 1 || Object.values(ledger.admissions ?? {}).every(settled)
        && Object.values(ledger.stops ?? {}).every(stop => stop.reviewStatus !== 'PENDING' && stop.control === 'ALLOW'));
    nativeStop = nativeStopSettlement(await readNativeStopRecords({ projectRoot, sessionKey, sessionId }), task?.verification);
    const ready = finished && runs.every(run => run.status === 'SETTLED');
    nativeStopReason = nativeStopGrace(nativeStop, ready);
    if (ready && (nativeStop.settled || nativeStopReason)) break;
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  const businessStarts = gateway.metrics().modelStarts.filter(row => row.sessionId === sessionId);
  const repairs = Object.values(ledger?.admissions ?? {}), allowedRuns = new Set(maxCorrections === 1 ? [admission?.hostRequest?.runId]
    : repairs.map(item => item.hostRequest?.runId));
  if (businessStarts.some(row => !allowedRuns.has(row.runId)) || (ledger?.used ?? 0) > maxCorrections) {
    const persisted = await store.inspect(sessionId);
    await save(path.join(outputRoot, 'business-run-identity-failure.json'), { sessionId, sessionKey, originalRunId,
      expectedRunId: admission?.hostRequest?.runId ?? null, used: ledger?.used ?? null, businessStarts,
      persistedUsed: persisted?.used ?? null, persistedAdmissions: Object.values(persisted?.admissions ?? {})
        .map(item => ({ id: item.id, runId: item.hostRequest?.runId ?? null, accounting: item.accounting })) });
    throw new Error('Frozen Stop started an unauthorized business run.');
  }
  const receiptRecords = (await fs.readFile(sessionFile, 'utf8')).split(/\r?\n/u).filter(Boolean).map(JSON.parse).slice(records.length);
  const changed = [...new Set([...mutationPaths, ...businessMutationPaths(receiptRecords, projectRoot)])];
  const existing = (await Promise.all(changed.map(async file => await fs.stat(path.join(projectRoot, file)).then(() => file, error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  })))).filter(Boolean);
  if (existing.length) gitAt(git, projectRoot, '--literal-pathspecs', 'add', '--intent-to-add', '--', ...existing);
  const patch = gitAt(git, projectRoot, '--literal-pathspecs', 'diff', '--binary', prepared.preparedHead, '--', ...changed);
  await fs.writeFile(path.join(outputRoot, 'candidate.patch'), patch, { flag: 'wx' });
  const { rcElapsedMs, usage, baselineCost } = await measureSimplifyBenchmark({ nativeRoot: gateway.root, privateRuns: runs, ledger });
  const repairFeedback = Boolean(admission?.hostRequest?.gate && businessStarts.length);
  const feedback = repairFeedback ? redactEvaluationText(admission.currentDeviations.map(item =>
    `${item.objectId} (${item.revisionId}): ${item.result.reason}\n${item.result.evidence.join('\n')}`).join('\n\n')) : null;
  const boundary = gateway.providerStatus();
  const businessUsage = summarizeProviderUsage(Math.max(0, boundary.requests - usage.observedCalls),
    receiptRecords.filter(row => row.message?.role === 'assistant').map(row => row.message.usage));
  const completeCalls = usage.completeCalls + businessUsage.completeCalls;
  const totalUsage = { observedCalls: boundary.requests, completeCalls,
    tokens: completeCalls ? (usage.tokens ?? 0) + (businessUsage.tokens ?? 0) : null };
  const frameworkError = Boolean(boundary?.failure || !initial);
  const started = repairs.filter(item => item.startedAt);
  const completedInBudget = Date.now() < deadline && initial?.progress?.complete === true && nativeStop?.settled === true
    && (!repairFeedback || terminal?.status === 'ok' && Boolean(admission.finalReview))
    && (maxCorrections === 1 || started.every(item => terminals.get(item.hostRequest?.runId)?.status === 'ok' && item.finalReview));
  const reason = boundary?.failure ?? initial?.reasonCode ?? initial?.progress?.reasonCode ?? initial?.releaseReason
    ?? (!initial ? 'FROZEN_STOP_NOT_REGISTERED' : null);
  const state = boundary?.failure === 'PROFILE_RATE_LIMIT' ? 'rate-limited' : frameworkError ? 'failed' : completedInBudget ? 'completed'
    : Date.now() >= deadline || /TIMEOUT|DEADLINE/u.test(reason ?? '') ? 'timed-out' : 'failed';
  const result = { ...manifest, state, completedInBudget, frameworkError, sessionId, sessionKey, originalRunId,
    reason, rcElapsedMs, usage, totalUsage, baselineCost, repairFeedback, feedback,
    startHead: taskStart.start.head, patchApplied: true, taskStartManifest: taskStart.file,
    nativeStopSettled: nativeStop?.settled === true, nativeStopReason, nativeStopRecords: nativeStop?.records ?? [], nativeStopPending: nativeStop?.pending ?? [],
    nativeStopRequired: nativeStop?.required ?? null, nativeStopVerification: nativeStop?.carrier ?? null,
    elapsedMs: Date.now() - startedAt, patchBytes: patch.length, terminal, firstStop: initial, corrections: ledger?.used ?? 0, maxCorrections,
    repairs: repairs.map(item => ({ id: item.id, stopId: item.stopId, runId: item.hostRequest?.runId ?? null, accounting: item.accounting,
      finalReview: item.finalReview?.status ?? null, terminal: terminals.get(item.hostRequest?.runId)?.status ?? null })),
    actualBusinessStart: businessStarts.length > 0, infrastructureComplete: !frameworkError,
    modelRequests: boundary?.requests ?? null, gatewayPort: gateway.port, metrics: gateway.metrics() };
  await save(path.join(outputRoot, 'result.json'), result);
  return result;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const { values } = parseArgs({ options: { 'source-run': { type: 'string' }, output: { type: 'string' },
    'variant-workspace': { type: 'string' }, rollback: { type: 'string' }, git: { type: 'string', default: 'git' } } });
  if (!values['source-run'] || !values.output) throw new Error('Supply --source-run and --output to freeze an ArkTS draft.');
  await freezeArktsDraft({ git: values.git, sourceRun: values['source-run'], output: values.output,
    variantWorkspace: values['variant-workspace'], rollback: values.rollback });
}
