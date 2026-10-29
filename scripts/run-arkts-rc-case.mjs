// Real business run + real RC hooks in an isolated native Gateway. Hidden
// scoring is deliberately a later evaluator process, never a host tool.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { loadArktsTask, arktsAgentInput } from './bench/arkts-dataset.mjs';
import { prepareArktsModelWorkspace } from './bench/prepare-arkts-model-workspace.mjs';
import { createArktsBenchTools } from './bench/native-arkts-tools.mjs';
import { createNativeGatewayEvaluation, nativeModelContextWindow } from './helpers/native-gateway-evaluation.mjs';
import { businessMutationPaths, inheritedBusinessMutationScope } from './bench/business-mutations.mjs';
import { readBusinessTerminal, knownBusinessTerminal, businessCompleted, createBusinessRunTracker } from './bench/business-completion.mjs';
import { validateArtifactSkills } from './bench/validate-artifact-skills.mjs';
import { arktsRunProfile, renderArktsRunConfig } from './bench/arkts-run-profile.mjs';
import { verifyFrozenArtifact } from './bench/frozen-artifact-verification.mjs';
import { restoreStopSessionLedger } from './bench/restore-stop-session.mjs';
import { restoreNativeProjectScope } from './bench/restore-project-scope.mjs';
import { runBoundedProcess } from './bench/bounded-process.mjs';
import { localTestEvidence } from './bench/local-test-evidence.mjs';
const arg = key => process.argv.find(value => value.startsWith(`${key}=`))?.slice(key.length + 1);
const profile = arktsRunProfile(arg('--phase-timeout-ms'), { hostNoTimeout: process.argv.includes('--host-no-timeout') });
const contextWindowTokens = nativeModelContextWindow(arg('--context-window-tokens'));
const pagedReads = process.argv.includes('--paged-reads');
const businessToolNames = [pagedReads ? 'bench_read' : 'read', 'write', 'edit', 'bench_nav', 'bench_check'];
if (process.argv.includes('--verify-pending-rc') && !arg('--resume-run')) throw new Error('--verify-pending-rc requires a genuine captured continuation');
const gitExecutable = arg('--git') ?? (process.platform === 'win32' ? 'C:/Program Files/Git/cmd/git.exe' : 'git');
const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const outputRoot = path.resolve(arg('--output') ?? `.runtime-correction/system-optimization/agent-runs/${arg('--case') ?? 'happyword_12'}-${Date.now()}`);
const dataset = arg('--dataset') ?? 'C:/Users/user/workspace/program_workspace/Experiments/swe-arkts-bench';
const { task, datasetDigest } = await loadArktsTask(dataset, arg('--case') ?? 'happyword_12');
const cacheRoot = path.resolve(arg('--cache') ?? '.runtime-correction/system-optimization/source-cache');
await fs.mkdir(path.dirname(outputRoot), { recursive: true });
const resumeRoot = arg('--resume-run') ? await fs.realpath(arg('--resume-run')) : null;
let resumeManifest, resumeEntry, resumeSessionKey;
if (resumeRoot) {
  resumeManifest = JSON.parse(await fs.readFile(path.join(resumeRoot, 'manifest.json'), 'utf8'));
  if (process.argv.includes('--verify-pending-rc')) {
    const prior = JSON.parse(await fs.readFile(path.join(resumeRoot, 'result.json'), 'utf8'));
    if (!businessCompleted(prior.officialBusinessTerminal, prior.finalBusinessRunId ?? prior.originalRunId)
      || prior.infrastructureComplete !== true || prior.verification !== 'UNVERIFIED')
      throw new Error('Pending verification requires an authoritative completed business run with unresolved RC acceptance');
  }
  if (resumeManifest.instanceId !== task.instance_id || resumeManifest.datasetDigest !== datasetDigest) throw new Error('Resume task identity changed.');
  try { process.kill(resumeManifest.ownerPid, 0); throw new Error('Prior run owner is still alive.'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
  const sessions = JSON.parse(await fs.readFile(path.join(resumeRoot, 'native-host/sessions.json'), 'utf8'));
  const matches = Object.entries(sessions).filter(([key, entry]) => key.startsWith('agent:main:arkts-') && entry.spawnedCwd === resumeManifest.projectRoot);
  if (matches.length !== 1) throw new Error('Cannot uniquely identify the genuine prior business session.');
  [resumeSessionKey, resumeEntry] = matches[0];
  const transcript = await fs.readFile(resumeEntry.sessionFile ?? path.join(resumeRoot, 'native-host', `${resumeEntry.sessionId}.jsonl`), 'utf8');
  for (const line of transcript.trim().split('\n')) JSON.parse(line);
  const head = execFileSync(gitExecutable, ['-C', resumeManifest.projectRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (head !== resumeManifest.preparedHead) throw new Error('Prior prepared business HEAD changed.');
  await fs.mkdir(outputRoot, { recursive: false });
}
const prepared = resumeRoot ? { projectRoot: resumeManifest.projectRoot, preparedHead: resumeManifest.preparedHead,
  baseCommit: resumeManifest.baseCommit, environmentAdapted: true, resumedFrom: resumeRoot } : await prepareArktsModelWorkspace({ task, outputRoot, cacheRoot, gitExecutable,
  ...(arg('--workspace-base') ? { workspaceBase: path.resolve(arg('--workspace-base')) } : {}),
  ...(profile.explicit ? { preparationTimeoutMs: profile.setupTimeoutMs } : {}) });
const input = arktsAgentInput(task), projectRoot = prepared.projectRoot;
const inheritedScope = resumeRoot ? await inheritedBusinessMutationScope(resumeRoot, projectRoot)
  : { mutationPaths: [], sourceRun: null, skippedStartupRuns: [] };
await fs.writeFile(path.join(outputRoot, 'inherited-business-scope.json'), JSON.stringify(inheritedScope, null, 2));
await fs.writeFile(path.join(outputRoot, 'public-input.json'), JSON.stringify(input, null, 2));
const toolRoot = arg('--tool-root') ?? 'C:/Program Files/Huawei/command-line-tools';
const setupScript = fileURLToPath(new URL('./bench/run-arkts-toolchain.ps1', import.meta.url));
if (!resumeRoot) try {
  const installed = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', setupScript,
    '-Project', projectRoot, '-ToolRoot', toolRoot, '-Phase', 'install'], { windowsHide: true, timeout: profile.setupTimeoutMs, maxBuffer: 2 * 1024 * 1024 });
  await fs.writeFile(path.join(outputRoot, 'install.log'), installed);
} catch (error) {
  await fs.writeFile(path.join(outputRoot, 'install.log'), String(error.stdout ?? '') + String(error.stderr ?? ''));
  throw new Error('Business-workspace dependency preparation failed; no model should start');
}
const lockfiles = ['oh-package-lock.json5', 'entry/oh-package-lock.json5'];
for (const file of resumeRoot ? [] : lockfiles) if (await fs.stat(path.join(projectRoot, file)).catch(() => null))
  execFileSync(gitExecutable, ['-C', projectRoot, 'add', '--force', '--', file], { windowsHide: true });
if (!resumeRoot) execFileSync(gitExecutable, ['-C', projectRoot, '-c', 'user.name=RC Benchmark', '-c', 'user.email=rc@example.invalid', '-c', 'core.hooksPath=nonexistent',
  'commit', '--quiet', '--allow-empty', '-m', 'Common benchmark dependency preparation'], { windowsHide: true });
prepared.preparedHead = execFileSync(gitExecutable, ['-C', projectRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const artifact = arg('--artifact') ? await fs.realpath(arg('--artifact')) : null;
const baselineRef = arg('--baseline-ref') ?? 'c33bae6';
let verifiedRcCommit = execFileSync(gitExecutable, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (artifact) {
  const validatedSkills = await validateArtifactSkills(artifact, arg('--host-root') ?? 'C:/Users/user/workspace/program_workspace/MatrixAssistant/resources/openclaw');
  await fs.writeFile(path.join(outputRoot, 'skill-validation.json'), JSON.stringify(validatedSkills, null, 2));
  const validation = await verifyFrozenArtifact({ gitExecutable, cwd: sourceRoot, reference: baselineRef, artifact });
  verifiedRcCommit = validation.baselineCommit;
  await fs.writeFile(path.join(outputRoot, 'baseline-artifact-validation.json'), JSON.stringify(validation, null, 2));
}
const model = process.env.RC_EVAL_NATIVE_MODEL ?? process.env.ANTHROPIC_MODEL;
if (!model) throw new Error('Configured native model is required');
await fs.mkdir(path.join(projectRoot, '.runtime-corrector'), { recursive: true });
await fs.writeFile(path.join(projectRoot, '.runtime-corrector/config.yaml'), renderArktsRunConfig(model, profile));
await fs.copyFile(path.join(projectRoot, '.runtime-corrector/config.yaml'), path.join(outputRoot, 'project-config.yaml'));
// Validate actual generated policy before starting the native Gateway/model.
const { loadConfig } = await import(pathToFileURL(path.join(artifact ?? sourceRoot, 'lib/runtime-corrector.mjs')).href);
await loadConfig({ cwd: projectRoot, pluginRoot: artifact ?? sourceRoot });
// Freeze common business navigation to the baseline artifact in both arms.
const stableNavigationRoot = path.resolve(arg('--navigation-artifact') ?? artifact ?? 'dist/runtime-corrector-openclaw');
let baselineLocalTests = resumeRoot ? await fs.readFile(path.join(resumeRoot, 'baseline-local-tests.json'), 'utf8').then(JSON.parse, error => {
  if (error.code === 'ENOENT') return null; throw error;
}) : null;
if (!resumeRoot && process.argv.includes('--baseline-local-tests')) {
  const coverage = path.join(projectRoot, 'entry/.test/default/intermediates/test/coverage_data/coverage.log');
  await fs.rm(coverage, { force: true });
  const started = Date.now(); let fullOutput = '';
  const execution = await runBoundedProcess('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', setupScript,
    '-Project', projectRoot, '-ToolRoot', toolRoot, '-Phase', 'test'], { cwd: projectRoot, timeoutMs: profile.checkTimeoutMs, onOutput(value) { fullOutput += value; } });
  await fs.writeFile(path.join(outputRoot, 'baseline-local-test.log'), fullOutput);
  const stat = await fs.stat(coverage).catch(() => null), freshReport = Boolean(stat && stat.mtimeMs >= started - 2000);
  const raw = freshReport ? await fs.readFile(coverage, 'utf8') : '';
  await fs.writeFile(path.join(outputRoot, 'baseline-local-coverage.log'), raw);
  baselineLocalTests = localTestEvidence(raw, execution, { freshReport, compileOutput: fullOutput });
  if (!baselineLocalTests.completeRuntime) throw new Error('Original local-test baseline did not finish; inspect baseline-local-test.log before starting a model.');
}
if (baselineLocalTests) await fs.writeFile(path.join(outputRoot, 'baseline-local-tests.json'), JSON.stringify(baselineLocalTests, null, 2));
const extra = await createArktsBenchTools({ outputRoot, projectRoot, toolRoot, stableNavigationRoot, checkTimeoutMs: profile.checkTimeoutMs, baselineLocalTests, pagedReads });
const manifest = { kind: 'real-native-arkts-rc-run', instanceId: task.instance_id, datasetDigest, ...prepared,
  rcSource: verifiedRcCommit,
  harnessSha256: Object.fromEntries(await Promise.all(['run-arkts-rc-case.mjs', 'helpers/native-gateway-evaluation.mjs', 'helpers/provider-fetch-timing.mjs',
    'bench/native-arkts-tools.mjs', 'bench/local-test-evidence.mjs', 'bench/hypium-results.mjs', 'bench/arkts-run-profile.mjs',
    'bench/business-completion.mjs', 'bench/business-mutations.mjs', 'bench/bounded-process.mjs', 'bench/prepare-arkts-model-workspace.mjs',
    'bench/run-arkts-toolchain.ps1'].map(async file => [file, createHash('sha256').update(await fs.readFile(new URL(file, import.meta.url))).digest('hex')]))),
  prebuiltArtifact: artifact, commonNavigationRoot: stableNavigationRoot,
  businessModel: `anthropic/${model}`, privateModel: `anthropic/${model}`, businessTools: businessToolNames,
  businessReads: { paged: pagedReads, ...(pagedReads ? { defaultLines: 120, maximumLines: 250 } : {}) },
  modelCapacity: { contextWindowTokens, maximumOutputTokens: 32768, appliedToCustomProvider: Boolean(process.env.ANTHROPIC_BASE_URL),
    source: arg('--context-window-tokens') ? 'explicit CLI declaration' : 'legacy benchmark default' },
  limits: { ...profile, correctionAdmissions: 1 },
  hostMaintenance: { memoryFlushEnabled: false, automaticCompaction: 'host default' },
  originalLocalBaseline: baselineLocalTests ? { completeRuntime: baselineLocalTests.completeRuntime, counts: baselineLocalTests.counts, failures: baselineLocalTests.failures } : null,
  recoveryIntent: process.argv.includes('--verify-pending-rc') ? 'pending-rc-acceptance' : 'complete-business-task',
  inputPolicy: 'Only public input and original base source; evaluator test_patch/gold not installed in business workspace.',
  state: 'PREPARED', ownerPid: process.pid };
await fs.writeFile(path.join(outputRoot, 'manifest.json'), JSON.stringify(manifest, null, 2));
if (!process.argv.includes('--live')) { console.log(JSON.stringify({ state: 'PREPARED_NO_MODEL', outputRoot, baselineArtifactVerified: Boolean(artifact) })); process.exit(0); }
const hostRoot = arg('--host-root'); if (!hostRoot) throw new Error('--host-root=<read-only-openclaw> required for --live');
let gateway, result, restoredRecordCount = 0;
try {
  gateway = await createNativeGatewayEvaluation({ hostRoot, projectRoot, outputRoot, sourceRoot, prebuiltPluginRoot: artifact,
    extraPluginPaths: [extra], businessToolNames, confineBusinessFiles: true,
    phaseTimeoutMs: profile.explicit ? profile.phaseTimeoutMs : null, unlimitedBusiness: profile.hostNoTimeout === true,
    disableMemoryFlush: true, ...(arg('--context-window-tokens') ? { contextWindowTokens } : {}) });
  const key = resumeSessionKey ?? `agent:main:arkts-${randomUUID()}`;
  if (resumeEntry) {
    const original = resumeEntry.sessionFile ?? path.join(resumeRoot, 'native-host', `${resumeEntry.sessionId}.jsonl`);
    const restored = path.join(gateway.root, `${resumeEntry.sessionId}.jsonl`);
    const originalBytes = await fs.readFile(original);
    await fs.writeFile(restored, originalBytes, { flag: 'wx' });
    restoredRecordCount = originalBytes.toString('utf8').split('\n').filter(line => line.trim()).length;
    const targetStateDirectory = gateway.runtime.state.resolveStateDir();
    const restoredLedger = await restoreStopSessionLedger({ sourceRun: resumeRoot,
      targetStateDirectory, sessionId: resumeEntry.sessionId, projectRoot });
    await fs.writeFile(path.join(outputRoot, 'stop-session-restore.json'), JSON.stringify(restoredLedger, null, 2));
    if (process.argv.includes('--verify-pending-rc') && !['RESTORED_AUTHENTIC_BYTES', 'ALREADY_IDENTICAL'].includes(restoredLedger.status))
      throw new Error('Pending verification requires an authentic session ledger before model admission');
    if (inheritedScope.sourceRun) {
      const restoredScope = await restoreNativeProjectScope({ sourceRun: inheritedScope.sourceRun, targetStateDirectory,
        identity: { agentId: 'main', sessionId: resumeEntry.sessionId, sessionKey: key }, projectRoot });
      await fs.writeFile(path.join(outputRoot, 'project-scope-restore.json'), JSON.stringify(restoredScope, null, 2));
      if (process.argv.includes('--verify-pending-rc') && !['RESTORED_AUTHENTIC_SCOPE', 'ALREADY_IDENTICAL'].includes(restoredScope.status))
        throw new Error('Pending verification cannot replace the original native task scope');
    }
    await gateway.runtime.agent.session.upsertSessionEntry({ agentId: 'main', sessionKey: key, storePath: gateway.config.session.store,
      entry: { ...resumeEntry, sessionFile: restored, spawnedCwd: projectRoot, updatedAt: Date.now() } });
    await fs.writeFile(path.join(outputRoot, 'resume-evidence.json'), JSON.stringify({ source: original, sourceSha256: createHash('sha256').update(originalBytes).digest('hex'), restored, restoredRecordCount,
      sessionKey: key, sessionId: resumeEntry.sessionId, originalRecordsUnmodified: true, priorPreparedHead: prepared.preparedHead }, null, 2));
  }
  const created = resumeEntry ? { ok: true, key } : await gateway.request('sessions.create', { key, agentId: 'main', label: `ArkTS task ${task.instance_id}` });
  const sessionKey = created.key;
  if (!created.ok || !sessionKey) throw new Error('Native session was not created');
  const scope = { agentId: 'main', sessionKey, storePath: gateway.config.session.store };
  await gateway.runtime.agent.session.patchSessionEntry({ ...scope, update: entry => ({ ...entry, spawnedCwd: projectRoot }) });
  const entry = await gateway.runtime.agent.session.getSessionEntry({ ...scope, readConsistency: 'latest' }), sessionId = entry.sessionId;
  const runId = randomUUID(), startedAt = Date.now();
  const businessRun = createBusinessRunTracker(runId, sessionId);
  const prompt = resumeEntry && process.argv.includes('--verify-pending-rc')
    ? `Continue the original ${task.instance_id} task in this genuine session and existing workspace. Its final RC acceptance remains pending. Give a truthful status based on existing work; normal automatic post-run RC review will execute after your response. Preserve the implementation and address only genuine remaining blockers. The host has no task completion deadline; RC phases remain 30 minutes. No evaluator results, hidden tests, implementation hints or expected answers are supplied.`
    : resumeEntry ? `Continue the original ${task.instance_id} task in this genuine session and existing workspace. Complete the implementation and actual checks, rather than stopping at analysis. Preserve and use the existing progress and compaction notes. The human has removed the host task completion deadline; RC review phases remain limited to 30 minutes. No new implementation hints or hidden evaluation data are supplied.`
    : `${input.problem_statement}\n\n${input.hints_text}\nWork in the current repository. API24 and unsigned local preparation are provided. Use available workspace navigation and project checks; keep the change focused on this issue. Report actual checks and any remaining uncertainty.${baselineLocalTests ? `\nThe unmodified original local tests were executed before your changes: ${JSON.stringify({ counts: baselineLocalTests.counts, failures: baselineLocalTests.failures })}. bench_check test compares against this baseline. Preserve unrelated passing behavior and distinguish existing failures from regressions; a baseline match does not establish the requested fix. If an original test directly codifies the reported bug, update it to assert the requested behavior and explain the change. Do not weaken or bypass assertions merely to obtain a pass.` : ''}`;
  const readGuidance = pagedReads ? '\nUse bench_read for bounded source pages. Locate relevant symbols with bench_nav grep before reading their line ranges; follow nextOffset only when additional context is needed.' : '';
  await gateway.request('chat.send', { sessionKey, sessionId, message: prompt + readGuidance, idempotencyKey: runId, deliver: false, thinking: 'off', timeoutMs: profile.mainTimeoutMs });
  const load = file => import(pathToFileURL(path.join(gateway.pluginRoot, file)).href);
  const { findTask } = await load('lib/runtime-v2/task-store.mjs');
  const { listNativeRuns } = await load('lib/openclaw/native-runs.mjs');
  const postDirectory = path.join(gateway.runtime.state.resolveStateDir(), 'runtime-corrector-stop-sessions/post-run');
  let currentTask, post, runs = [], last, businessBudgetAbortRequested = false, officialBusinessTerminal;
  while (manifest.limits.totalTimeoutMs === null || Date.now() - startedAt < manifest.limits.totalTimeoutMs) {
    await gateway.drain(); currentTask = await findTask({ projectRoot, sessionId });
    const names = await fs.readdir(postDirectory).catch(() => []);
    for (const name of names.filter(name => name.endsWith('.json'))) {
      const record = await fs.readFile(path.join(postDirectory, name), 'utf8').then(JSON.parse, () => null);
      if (record?.sessionId === sessionId) post = record;
    }
    runs = currentTask ? await listNativeRuns(projectRoot, currentTask.taskId) : [];
    businessRun.observe(post);
    const state = { state: 'RUNNING', ownerPid: process.pid, sessionId, sessionKey, runId, startedAt,
      selectedBusinessRunId: businessRun.runId,
      actualBusinessStart: gateway.metrics().modelStarts.some(event => event.runId === runId && event.sessionId === sessionId),
      taskStatus: currentTask?.status, verification: currentTask?.verification?.status, postPhase: post?.phase,
      privateStarts: runs.length, privateSettled: runs.filter(run => run.status === 'SETTLED').length, modelStarts: gateway.metrics().modelStarts.length };
    if (JSON.stringify(state) !== last) { last = JSON.stringify(state); await fs.writeFile(path.join(outputRoot, 'progress.json'), last); console.log(last); }
    if (manifest.limits.mainTimeoutMs > 0 && !businessBudgetAbortRequested && !runs.length && post?.phase === 'RUNNING' && Date.now() - startedAt >= manifest.limits.mainTimeoutMs) {
      businessBudgetAbortRequested = true;
      const aborted = await gateway.request('chat.abort', { sessionKey, runId, preserveSideRuns: true }).then(response => ({ response }), error => ({ error: error.message }));
      await fs.writeFile(path.join(outputRoot, 'business-budget-abort.json'), JSON.stringify({ runId, sessionKey, requestedAt: Date.now(), ...aborted }, null, 2));
    }
    const activeBusinessRunId = businessRun.runId;
    if (['IDLE', 'CLOSED'].includes(post?.phase) && gateway.metrics().modelStarts.some(event => event.runId === runId && event.sessionId === sessionId)
      && runs.every(run => run.status === 'SETTLED')) {
      officialBusinessTerminal = await readBusinessTerminal(gateway.request, activeBusinessRunId);
      if (knownBusinessTerminal(officialBusinessTerminal, activeBusinessRunId) || !profile.hostNoTimeout) break;
    }
    if (profile.explicit && post?.reason === 'HOST_RUN_RECONCILIATION_REQUIRED' && runs.every(run => run.status === 'SETTLED')) {
      if (!profile.hostNoTimeout) break;
      officialBusinessTerminal = await readBusinessTerminal(gateway.request, activeBusinessRunId);
      if (knownBusinessTerminal(officialBusinessTerminal, activeBusinessRunId) && officialBusinessTerminal.status === 'error') break;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const finalBusinessRunId = businessRun.runId;
  if (!knownBusinessTerminal(officialBusinessTerminal, finalBusinessRunId))
    officialBusinessTerminal = await readBusinessTerminal(gateway.request, finalBusinessRunId);
  await fs.writeFile(path.join(outputRoot, 'official-business-terminal.json'), JSON.stringify(officialBusinessTerminal, null, 2));
  const session = await gateway.runtime.subagent.getSession({ sessionKey });
  await fs.writeFile(path.join(outputRoot, 'business-session.json'), JSON.stringify(session, null, 2));
  const nativeTranscript = await fs.readFile(path.join(gateway.root, `${sessionId}.jsonl`), 'utf8');
  const trajectory = await fs.readFile(path.join(gateway.root, `${sessionId}.trajectory.jsonl`), 'utf8').then(text => text.trim().split('\n').filter(Boolean).map(JSON.parse), () => []);
  const terminalEvent = trajectory.filter(event => event.type === 'session.ended' && event.runId === runId).at(-1);
  const businessTerminal = terminalEvent ? { status: terminalEvent.data?.status, aborted: terminalEvent.data?.aborted,
    timedOut: terminalEvent.data?.timedOut, ts: terminalEvent.ts } : null;
  const actualBusinessStart = gateway.metrics().modelStarts.some(event => event.runId === runId && event.sessionId === sessionId);
  const receiptRecords = nativeTranscript.split('\n').filter(Boolean).map(line => JSON.parse(line)).slice(restoredRecordCount);
  const mutationPaths = [...new Set([...inheritedScope.mutationPaths,
    ...(actualBusinessStart ? businessMutationPaths(receiptRecords, projectRoot) : [])])].sort();
  if (mutationPaths.length) execFileSync(gitExecutable, ['--literal-pathspecs', '-C', projectRoot, 'add', '--intent-to-add', '--', ...mutationPaths], { windowsHide: true });
  await fs.writeFile(path.join(outputRoot, 'workspace.patch'), execFileSync(gitExecutable, ['-C', projectRoot, 'diff', '--binary', 'HEAD'], { maxBuffer: 4 * 1024 * 1024 }));
  const patch = mutationPaths.length ? execFileSync(gitExecutable, ['--literal-pathspecs', '-C', projectRoot, 'diff', '--binary', 'HEAD', '--', ...mutationPaths], { maxBuffer: 4 * 1024 * 1024 }) : Buffer.alloc(0);
  await fs.writeFile(path.join(outputRoot, 'candidate.patch'), patch);
  await fs.writeFile(path.join(outputRoot, 'candidate-scope.json'), JSON.stringify({ mutationPaths, inheritedScope, restoredRecordCount,
    basis: 'Captured business write/edit receipts plus prior genuine business scope. Maintenance-only startup attempts excluded; full workspace.patch and notes retained.' }, null, 2));
  const infrastructureComplete = ['IDLE', 'CLOSED'].includes(post?.phase) && runs.every(run => run.status === 'SETTLED')
    && knownBusinessTerminal(officialBusinessTerminal, finalBusinessRunId);
  result = { ...manifest, state: infrastructureComplete ? 'SETTLED' : 'INCOMPLETE', sessionId, sessionKey, originalRunId: runId, elapsedMs: Date.now() - startedAt,
    verification: currentTask?.verification?.status, taskId: currentTask?.taskId, postPhase: post?.phase,
    endReason: currentTask?.verification?.status ? 'RC_REVIEW_SETTLED' : 'HOST_ENDED_WITHOUT_REVIEW',
    privateRuns: runs.map(({ runId, sessionId, role, status }) => ({ runId, sessionId, role, status })), metrics: gateway.metrics(),
    patchBytes: patch.length, actualBusinessStart,
    infrastructureComplete,
    businessBudgetAbortRequested,
    businessTerminal, officialBusinessTerminal, finalBusinessRunId,
    businessCompleted: businessCompleted(officialBusinessTerminal, finalBusinessRunId),
    runtimeReason: currentTask?.verification?.reasonCode ?? post?.reason ?? null,
    score: 'NOT_YET_GRADED: evaluate candidate.patch with hidden tests in an independent evaluator worktree' };
  await fs.writeFile(path.join(outputRoot, 'result.json'), JSON.stringify(result, null, 2));
  await fs.writeFile(path.join(outputRoot, 'progress.json'), JSON.stringify({ state: result.state, ownerPid: process.pid, sessionId,
    businessCompleted: result.businessCompleted, infrastructureComplete, officialBusinessStatus: officialBusinessTerminal.status, endedAt: Date.now() }));
} finally { await gateway?.close(); }
// Native host singletons may retain observers; only awaited settled runs are
// eligible for a normal result. This development process owns no desktop host.
console.log(JSON.stringify({ state: result.state, actualBusinessStart: result.actualBusinessStart, verification: result.verification,
  infrastructureComplete: result.infrastructureComplete, patchBytes: result.patchBytes, outputRoot }));
process.exit(result.infrastructureComplete && result.actualBusinessStart ? 0 : 1);
