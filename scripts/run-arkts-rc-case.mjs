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
import { createNativeGatewayEvaluation } from './helpers/native-gateway-evaluation.mjs';
import { businessMutationPaths } from './bench/business-mutations.mjs';
import { readBusinessTerminal, knownBusinessTerminal, businessCompleted, latestBusinessRunId } from './bench/business-completion.mjs';
import { validateArtifactSkills } from './bench/validate-artifact-skills.mjs';
import { arktsRunProfile, renderArktsRunConfig } from './bench/arkts-run-profile.mjs';
const arg = key => process.argv.find(value => value.startsWith(`${key}=`))?.slice(key.length + 1);
const profile = arktsRunProfile(arg('--phase-timeout-ms'), { hostNoTimeout: process.argv.includes('--host-no-timeout') });
const gitExecutable = arg('--git') ?? (process.platform === 'win32' ? 'C:/Program Files/Git/cmd/git.exe' : 'git');
const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const outputRoot = path.resolve(arg('--output') ?? `.runtime-correction/system-optimization/agent-runs/${arg('--case') ?? 'happyword_12'}-${Date.now()}`);
const dataset = arg('--dataset') ?? 'C:/Users/user/workspace/program_workspace/Experiments/swe-arkts-bench';
const { task, datasetDigest } = await loadArktsTask(dataset, arg('--case') ?? 'happyword_12');
const cacheRoot = path.resolve('.runtime-correction/system-optimization/source-cache');
await fs.mkdir(path.dirname(outputRoot), { recursive: true });
const resumeRoot = arg('--resume-run') ? await fs.realpath(arg('--resume-run')) : null;
let resumeManifest, resumeEntry, resumeSessionKey;
if (resumeRoot) {
  resumeManifest = JSON.parse(await fs.readFile(path.join(resumeRoot, 'manifest.json'), 'utf8'));
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
if (artifact) {
  const validatedSkills = await validateArtifactSkills(artifact, arg('--host-root') ?? 'C:/Users/user/workspace/program_workspace/MatrixAssistant/resources/openclaw');
  await fs.writeFile(path.join(outputRoot, 'skill-validation.json'), JSON.stringify(validatedSkills, null, 2));
  const modules = JSON.parse(execFileSync(gitExecutable, ['show', `${baselineRef}:packaging/runtime-modules.json`], { encoding: 'utf8' }));
  const checks = [];
  for (const file of [...modules.common, ...modules.openclaw]) {
    const expected = execFileSync(gitExecutable, ['show', `${baselineRef}:${file}`], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
    const actual = await fs.readFile(path.join(artifact, file), 'utf8');
    if (expected.replaceAll('\r\n', '\n') !== actual.replaceAll('\r\n', '\n')) throw new Error(`Prebuilt artifact differs from baseline: ${file}`);
    checks.push({ file, actualSha256: createHash('sha256').update(actual).digest('hex') });
  }
  await fs.writeFile(path.join(outputRoot, 'baseline-artifact-validation.json'), JSON.stringify({ baselineRef, checks }, null, 2));
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
const extra = await createArktsBenchTools({ outputRoot, projectRoot, toolRoot, stableNavigationRoot, checkTimeoutMs: profile.checkTimeoutMs });
const manifest = { kind: 'real-native-arkts-rc-run', instanceId: task.instance_id, datasetDigest, ...prepared,
  rcSource: artifact ? baselineRef : execFileSync(gitExecutable, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  prebuiltArtifact: artifact, commonNavigationRoot: stableNavigationRoot,
  businessModel: `anthropic/${model}`, privateModel: `anthropic/${model}`, businessTools: ['read', 'write', 'edit', 'bench_nav', 'bench_check'],
  limits: { ...profile, correctionAdmissions: 1 },
  inputPolicy: 'Only public input and original base source; evaluator test_patch/gold not installed in business workspace.',
  state: 'PREPARED', ownerPid: process.pid };
await fs.writeFile(path.join(outputRoot, 'manifest.json'), JSON.stringify(manifest, null, 2));
if (!process.argv.includes('--live')) { console.log(JSON.stringify({ state: 'PREPARED_NO_MODEL', outputRoot, baselineArtifactVerified: Boolean(artifact) })); process.exit(0); }
const hostRoot = arg('--host-root'); if (!hostRoot) throw new Error('--host-root=<read-only-openclaw> required for --live');
let gateway, result;
try {
  gateway = await createNativeGatewayEvaluation({ hostRoot, projectRoot, outputRoot, sourceRoot, prebuiltPluginRoot: artifact,
    extraPluginPaths: [extra], businessToolNames: ['read', 'write', 'edit', 'bench_nav', 'bench_check'], confineBusinessFiles: true,
    phaseTimeoutMs: profile.explicit ? profile.phaseTimeoutMs : null, unlimitedBusiness: profile.hostNoTimeout === true });
  const key = resumeSessionKey ?? `agent:main:arkts-${randomUUID()}`;
  if (resumeEntry) {
    const original = resumeEntry.sessionFile ?? path.join(resumeRoot, 'native-host', `${resumeEntry.sessionId}.jsonl`);
    const restored = path.join(gateway.root, `${resumeEntry.sessionId}.jsonl`);
    await fs.copyFile(original, restored);
    await gateway.runtime.agent.session.upsertSessionEntry({ agentId: 'main', sessionKey: key, storePath: gateway.config.session.store,
      entry: { ...resumeEntry, sessionFile: restored, spawnedCwd: projectRoot, updatedAt: Date.now() } });
    await fs.writeFile(path.join(outputRoot, 'resume-evidence.json'), JSON.stringify({ source: original, sourceSha256: createHash('sha256').update(await fs.readFile(original)).digest('hex'), restored,
      sessionKey: key, sessionId: resumeEntry.sessionId, originalRecordsUnmodified: true, priorPreparedHead: prepared.preparedHead }, null, 2));
  }
  const created = resumeEntry ? { ok: true, key } : await gateway.request('sessions.create', { key, agentId: 'main', label: `ArkTS task ${task.instance_id}` });
  const sessionKey = created.key;
  if (!created.ok || !sessionKey) throw new Error('Native session was not created');
  const scope = { agentId: 'main', sessionKey, storePath: gateway.config.session.store };
  await gateway.runtime.agent.session.patchSessionEntry({ ...scope, update: entry => ({ ...entry, spawnedCwd: projectRoot }) });
  const entry = await gateway.runtime.agent.session.getSessionEntry({ ...scope, readConsistency: 'latest' }), sessionId = entry.sessionId;
  const runId = randomUUID(), startedAt = Date.now();
  const prompt = resumeEntry ? `Continue the original ${task.instance_id} task in this genuine session and existing workspace. Complete the implementation and actual checks, rather than stopping at analysis. Preserve and use the existing progress and compaction notes. The human has removed the host task completion deadline; RC review phases remain limited to 30 minutes. No new implementation hints or hidden evaluation data are supplied.`
    : `${input.problem_statement}\n\n${input.hints_text}\nWork in the current repository. API24 and unsigned local preparation are provided. Use available workspace navigation and project checks; keep the change focused on this issue. Report actual checks and any remaining uncertainty.`;
  await gateway.request('chat.send', { sessionKey, sessionId, message: prompt, idempotencyKey: runId, deliver: false, thinking: 'off', timeoutMs: profile.mainTimeoutMs });
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
    const state = { state: 'RUNNING', ownerPid: process.pid, sessionId, sessionKey, runId, startedAt,
      taskStatus: currentTask?.status, verification: currentTask?.verification?.status, postPhase: post?.phase,
      privateStarts: runs.length, privateSettled: runs.filter(run => run.status === 'SETTLED').length, modelStarts: gateway.metrics().modelStarts.length };
    if (JSON.stringify(state) !== last) { last = JSON.stringify(state); await fs.writeFile(path.join(outputRoot, 'progress.json'), last); console.log(last); }
    if (manifest.limits.mainTimeoutMs > 0 && !businessBudgetAbortRequested && !runs.length && post?.phase === 'RUNNING' && Date.now() - startedAt >= manifest.limits.mainTimeoutMs) {
      businessBudgetAbortRequested = true;
      const aborted = await gateway.request('chat.abort', { sessionKey, runId, preserveSideRuns: true }).then(response => ({ response }), error => ({ error: error.message }));
      await fs.writeFile(path.join(outputRoot, 'business-budget-abort.json'), JSON.stringify({ runId, sessionKey, requestedAt: Date.now(), ...aborted }, null, 2));
    }
    const activeBusinessRunId = latestBusinessRunId(gateway.metrics().modelStarts, sessionId, runId);
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
  const finalBusinessRunId = latestBusinessRunId(gateway.metrics().modelStarts, sessionId, runId);
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
  const mutationPaths = businessMutationPaths(nativeTranscript.split('\n').filter(Boolean).map(line => JSON.parse(line)), projectRoot);
  if (mutationPaths.length) execFileSync(gitExecutable, ['--literal-pathspecs', '-C', projectRoot, 'add', '--intent-to-add', '--', ...mutationPaths], { windowsHide: true });
  await fs.writeFile(path.join(outputRoot, 'workspace.patch'), execFileSync(gitExecutable, ['-C', projectRoot, 'diff', '--binary', 'HEAD'], { maxBuffer: 4 * 1024 * 1024 }));
  const patch = mutationPaths.length ? execFileSync(gitExecutable, ['--literal-pathspecs', '-C', projectRoot, 'diff', '--binary', 'HEAD', '--', ...mutationPaths], { maxBuffer: 4 * 1024 * 1024 }) : Buffer.alloc(0);
  await fs.writeFile(path.join(outputRoot, 'candidate.patch'), patch);
  await fs.writeFile(path.join(outputRoot, 'candidate-scope.json'), JSON.stringify({ mutationPaths,
    basis: 'Successful native write/edit tool receipts; fixed checks and host bootstrap are environment producers. Full workspace.patch retained.' }, null, 2));
  const infrastructureComplete = ['IDLE', 'CLOSED'].includes(post?.phase) && runs.every(run => run.status === 'SETTLED')
    && knownBusinessTerminal(officialBusinessTerminal, finalBusinessRunId);
  result = { ...manifest, state: infrastructureComplete ? 'SETTLED' : 'INCOMPLETE', sessionId, sessionKey, originalRunId: runId, elapsedMs: Date.now() - startedAt,
    verification: currentTask?.verification?.status, taskId: currentTask?.taskId, postPhase: post?.phase,
    endReason: currentTask?.verification?.status ? 'RC_REVIEW_SETTLED' : 'HOST_ENDED_WITHOUT_REVIEW',
    privateRuns: runs.map(({ runId, sessionId, role, status }) => ({ runId, sessionId, role, status })), metrics: gateway.metrics(),
    patchBytes: patch.length, actualBusinessStart: gateway.metrics().modelStarts.some(event => event.runId === runId && event.sessionId === sessionId),
    infrastructureComplete,
    businessBudgetAbortRequested,
    businessTerminal, officialBusinessTerminal, finalBusinessRunId,
    businessCompleted: businessCompleted(officialBusinessTerminal, finalBusinessRunId),
    runtimeReason: currentTask?.verification?.reasonCode ?? post?.reason ?? null,
    score: 'NOT_YET_GRADED: evaluate candidate.patch with hidden tests in an independent evaluator worktree' };
  await fs.writeFile(path.join(outputRoot, 'result.json'), JSON.stringify(result, null, 2));
  await fs.writeFile(path.join(outputRoot, 'progress.json'), JSON.stringify({ state: 'SETTLED', ownerPid: process.pid, sessionId, endedAt: Date.now() }));
} finally { await gateway?.close(); }
// Native host singletons may retain observers; only awaited settled runs are
// eligible for a normal result. This development process owns no desktop host.
console.log(JSON.stringify({ state: result.state, actualBusinessStart: result.actualBusinessStart, verification: result.verification,
  infrastructureComplete: result.infrastructureComplete, patchBytes: result.patchBytes, outputRoot }));
process.exit(result.infrastructureComplete && result.actualBusinessStart ? 0 : 1);
