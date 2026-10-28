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
import { validateArtifactSkills } from './bench/validate-artifact-skills.mjs';
const arg = key => process.argv.find(value => value.startsWith(`${key}=`))?.slice(key.length + 1);
const gitExecutable = arg('--git') ?? (process.platform === 'win32' ? 'C:/Program Files/Git/cmd/git.exe' : 'git');
const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const outputRoot = path.resolve(arg('--output') ?? `.runtime-correction/system-optimization/agent-runs/${arg('--case') ?? 'happyword_12'}-${Date.now()}`);
const dataset = arg('--dataset') ?? 'C:/Users/user/workspace/program_workspace/Experiments/swe-arkts-bench';
const { task, datasetDigest } = await loadArktsTask(dataset, arg('--case') ?? 'happyword_12');
const cacheRoot = path.resolve('.runtime-correction/system-optimization/source-cache');
await fs.mkdir(path.dirname(outputRoot), { recursive: true });
const prepared = await prepareArktsModelWorkspace({ task, outputRoot, cacheRoot, gitExecutable });
const input = arktsAgentInput(task), projectRoot = prepared.projectRoot;
await fs.writeFile(path.join(outputRoot, 'public-input.json'), JSON.stringify(input, null, 2));
const toolRoot = arg('--tool-root') ?? 'C:/Program Files/Huawei/command-line-tools';
const setupScript = fileURLToPath(new URL('./bench/run-arkts-toolchain.ps1', import.meta.url));
try {
  const installed = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', setupScript,
    '-Project', projectRoot, '-ToolRoot', toolRoot, '-Phase', 'install'], { windowsHide: true, timeout: 240000, maxBuffer: 2 * 1024 * 1024 });
  await fs.writeFile(path.join(outputRoot, 'install.log'), installed);
} catch (error) {
  await fs.writeFile(path.join(outputRoot, 'install.log'), String(error.stdout ?? '') + String(error.stderr ?? ''));
  throw new Error('Business-workspace dependency preparation failed; no model should start');
}
const lockfiles = ['oh-package-lock.json5', 'entry/oh-package-lock.json5'];
for (const file of lockfiles) if (await fs.stat(path.join(projectRoot, file)).catch(() => null))
  execFileSync(gitExecutable, ['-C', projectRoot, 'add', '--force', '--', file], { windowsHide: true });
execFileSync(gitExecutable, ['-C', projectRoot, '-c', 'user.name=RC Benchmark', '-c', 'user.email=rc@example.invalid', '-c', 'core.hooksPath=nonexistent',
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
await fs.writeFile(path.join(projectRoot, '.runtime-corrector/config.yaml'), `version: 2
artifacts: []
dynamicGroundTruth:
  enabled: true
  materialRoots: []
  panel:
    size: 0
skillCorrection:
  enabled: false
artifactCorrection:
  groundTruthReviewEnabled: false
implementationCorrection:
  enabled: false
stopCorrection:
  enabled: true
  waitMode: until_pass
  maxCorrectionsPerSession: 1
  maxCorrectionsPerFlow: 1
  assessmentTimeoutMs: 210000
  feedbackReserveMs: 30000
  metrics:
${Array.from({ length: 16 }, (_, i) => `    M${String(i + 1).padStart(2, '0')}: ${i === 15}`).join('\n')}
reviewers:
  defaults:
    model: anthropic/${model}
    effort: low
    timeoutMs: 180000
    maxOutputTokens: 32768
`);
// Freeze common business navigation to the baseline artifact in both arms.
const stableNavigationRoot = path.resolve(arg('--navigation-artifact') ?? artifact ?? 'dist/runtime-corrector-openclaw');
const extra = await createArktsBenchTools({ outputRoot, projectRoot, toolRoot, stableNavigationRoot });
const manifest = { kind: 'real-native-arkts-rc-run', instanceId: task.instance_id, datasetDigest, ...prepared,
  rcSource: artifact ? baselineRef : execFileSync(gitExecutable, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  prebuiltArtifact: artifact, commonNavigationRoot: stableNavigationRoot,
  businessModel: `anthropic/${model}`, privateModel: `anthropic/${model}`, businessTools: ['read', 'write', 'edit', 'bench_nav', 'bench_check'],
  limits: { mainTimeoutMs: 600000, totalTimeoutMs: 960000, correctionAdmissions: 1, privateTimeoutMs: 180000 },
  inputPolicy: 'Only public input and original base source; evaluator test_patch/gold not installed in business workspace.',
  state: 'PREPARED', ownerPid: process.pid };
await fs.writeFile(path.join(outputRoot, 'manifest.json'), JSON.stringify(manifest, null, 2));
if (!process.argv.includes('--live')) { console.log(JSON.stringify({ state: 'PREPARED_NO_MODEL', outputRoot, baselineArtifactVerified: Boolean(artifact) })); process.exit(0); }
const hostRoot = arg('--host-root'); if (!hostRoot) throw new Error('--host-root=<read-only-openclaw> required for --live');
let gateway, result;
try {
  gateway = await createNativeGatewayEvaluation({ hostRoot, projectRoot, outputRoot, sourceRoot, prebuiltPluginRoot: artifact,
    extraPluginPaths: [extra], businessToolNames: ['read', 'write', 'edit', 'bench_nav', 'bench_check'], confineBusinessFiles: true });
  const key = `agent:main:arkts-${randomUUID()}`;
  const created = await gateway.request('sessions.create', { key, agentId: 'main', label: `ArkTS task ${task.instance_id}` });
  const sessionKey = created.key;
  if (!created.ok || !sessionKey) throw new Error('Native session was not created');
  const scope = { agentId: 'main', sessionKey, storePath: gateway.config.session.store };
  await gateway.runtime.agent.session.patchSessionEntry({ ...scope, update: entry => ({ ...entry, spawnedCwd: projectRoot }) });
  const entry = await gateway.runtime.agent.session.getSessionEntry({ ...scope, readConsistency: 'latest' }), sessionId = entry.sessionId;
  const runId = randomUUID(), startedAt = Date.now();
  const prompt = `${input.problem_statement}\n\n${input.hints_text}\nWork in the current repository. API24 and unsigned local preparation are provided. Use available workspace navigation and project checks; keep the change focused on this issue. Report actual checks and any remaining uncertainty.`;
  await gateway.request('chat.send', { sessionKey, sessionId, message: prompt, idempotencyKey: runId, deliver: false, thinking: 'off', timeoutMs: 600000 });
  const load = file => import(pathToFileURL(path.join(gateway.pluginRoot, file)).href);
  const { findTask } = await load('lib/runtime-v2/task-store.mjs');
  const { listNativeRuns } = await load('lib/openclaw/native-runs.mjs');
  const postDirectory = path.join(gateway.runtime.state.resolveStateDir(), 'runtime-corrector-stop-sessions/post-run');
  let currentTask, post, runs = [], last, businessBudgetAbortRequested = false;
  while (Date.now() - startedAt < manifest.limits.totalTimeoutMs) {
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
    if (!businessBudgetAbortRequested && !runs.length && Date.now() - startedAt >= manifest.limits.mainTimeoutMs) {
      businessBudgetAbortRequested = true;
      const aborted = await gateway.request('chat.abort', { sessionKey, runId, preserveSideRuns: true }).then(response => ({ response }), error => ({ error: error.message }));
      await fs.writeFile(path.join(outputRoot, 'business-budget-abort.json'), JSON.stringify({ runId, sessionKey, requestedAt: Date.now(), ...aborted }, null, 2));
    }
    if (['IDLE', 'CLOSED'].includes(post?.phase) && gateway.metrics().modelStarts.some(event => event.runId === runId && event.sessionId === sessionId)
      && runs.every(run => run.status === 'SETTLED')) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const session = await gateway.runtime.subagent.getSession({ sessionKey });
  await fs.writeFile(path.join(outputRoot, 'business-session.json'), JSON.stringify(session, null, 2));
  const nativeTranscript = await fs.readFile(path.join(gateway.root, `${sessionId}.jsonl`), 'utf8');
  const mutationPaths = businessMutationPaths(nativeTranscript.split('\n').filter(Boolean).map(line => JSON.parse(line)), projectRoot);
  if (mutationPaths.length) execFileSync(gitExecutable, ['--literal-pathspecs', '-C', projectRoot, 'add', '--intent-to-add', '--', ...mutationPaths], { windowsHide: true });
  await fs.writeFile(path.join(outputRoot, 'workspace.patch'), execFileSync(gitExecutable, ['-C', projectRoot, 'diff', '--binary', 'HEAD'], { maxBuffer: 4 * 1024 * 1024 }));
  const patch = mutationPaths.length ? execFileSync(gitExecutable, ['--literal-pathspecs', '-C', projectRoot, 'diff', '--binary', 'HEAD', '--', ...mutationPaths], { maxBuffer: 4 * 1024 * 1024 }) : Buffer.alloc(0);
  await fs.writeFile(path.join(outputRoot, 'candidate.patch'), patch);
  await fs.writeFile(path.join(outputRoot, 'candidate-scope.json'), JSON.stringify({ mutationPaths,
    basis: 'Successful native write/edit tool receipts; fixed checks and host bootstrap are environment producers. Full workspace.patch retained.' }, null, 2));
  result = { ...manifest, state: 'SETTLED', sessionId, sessionKey, originalRunId: runId, elapsedMs: Date.now() - startedAt,
    verification: currentTask?.verification?.status, taskId: currentTask?.taskId, postPhase: post?.phase,
    endReason: currentTask?.verification?.status ? 'RC_REVIEW_SETTLED' : 'HOST_ENDED_WITHOUT_REVIEW',
    privateRuns: runs.map(({ runId, sessionId, role, status }) => ({ runId, sessionId, role, status })), metrics: gateway.metrics(),
    patchBytes: patch.length, actualBusinessStart: gateway.metrics().modelStarts.some(event => event.runId === runId && event.sessionId === sessionId),
    infrastructureComplete: ['IDLE', 'CLOSED'].includes(post?.phase) && runs.every(run => run.status === 'SETTLED'),
    businessBudgetAbortRequested,
    score: 'NOT_YET_GRADED: evaluate candidate.patch with hidden tests in an independent evaluator worktree' };
  await fs.writeFile(path.join(outputRoot, 'result.json'), JSON.stringify(result, null, 2));
  await fs.writeFile(path.join(outputRoot, 'progress.json'), JSON.stringify({ state: 'SETTLED', ownerPid: process.pid, sessionId, endedAt: Date.now() }));
} finally { await gateway?.close(); }
// Native host singletons may retain observers; only awaited settled runs are
// eligible for a normal result. This development process owns no desktop host.
console.log(JSON.stringify({ state: result.state, actualBusinessStart: result.actualBusinessStart, verification: result.verification,
  infrastructureComplete: result.infrastructureComplete, patchBytes: result.patchBytes, outputRoot }));
process.exit(result.infrastructureComplete && result.actualBusinessStart ? 0 : 1);
