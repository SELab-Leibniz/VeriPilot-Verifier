// Explicit, local live-model acceptance experiment. Never imported by npm test
// or packaged into a plugin. Credentials stay in the review child environment.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { startRoleReviewer, STOP_REVIEW_SCHEMA } from '../lib/runtime-v2/reviewer.mjs';
import { runStopTaskReview } from '../lib/runtime-v2/stop-task-review.mjs';
import { createCliTaskSession } from '../lib/review-task/cli-task-session.mjs';
import { ensureTask, taskDirectory, withTaskState } from '../lib/runtime-v2/task-store.mjs';
import { createInternalRunLease, internalRunEnvironment, releaseInternalRunLease } from '../lib/runtime-v2/internal-run.mjs';
import { sha256 } from '../lib/runtime-v2/utils.mjs';
import { compileRuntimeV2Config } from '../lib/runtime-v2/config.mjs';
import { handleRuntimeV2Event } from '../lib/runtime-v2/orchestrator.mjs';
import { buildMetricPopulation } from '../lib/runtime-v2/metrics.mjs';
import { prepareMixedSkillEvaluation, MIXED_SKILL_EXPECTED } from './helpers/mixed-skill-evaluation.mjs';
import { failureEffectCases, exceptionalFlowCases } from './helpers/failure-effect-fixtures.mjs';
import { processOrderCases } from './helpers/process-order-fixtures.mjs';
import * as hostAdapter from '../lib/hosts/claude.mjs';

const args = process.argv.slice(2);
const captureNative = args.includes('--capture-native');
const value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : null;
const simplifyArm = value('--simplify-arm');
const simplifyPrepare = args.includes('--simplify-prepare');
if (!args.includes('--live') && !captureNative && !simplifyPrepare) throw new Error('Use --live for explicit real-model execution, or --capture-native for the isolated network-disabled production payload capture.');
const simplify = simplifyArm ? (await import('./simplify-experiment-schedule.mjs')).STOP_ARMS[simplifyArm] : null;
const simplifyRoot = value('--simplify-plugin-root');
const simplifyModel = value('--simplify-model');
const simplifyProvider = value('--simplify-provider') ?? 'coding-plan';
const openclawProfile = value('--openclaw-profile');
const simplifySha = value('--simplify-package-sha256');
const assessmentBudgetMs = Number(value('--simplify-validation-budget') ?? 210000);
const feedbackReserveMs = 30000;
const reviewBudgetMs = assessmentBudgetMs - feedbackReserveMs;
if (args.includes('--simplify-validation-budget') && (simplifyArm !== 'B1' || simplifyProvider !== 'host-profile'
  || !['external-bug', 'internal-correct'].includes(value('--case')) || ![210000, 600000].includes(assessmentBudgetMs)))
  throw new Error('The alternate budget is only for the unscored DeepSeek B1 verification.');
const pairRateLimitFile = value('--simplify-pair-rate-limit-file') ?? undefined;
const simplifyNative = simplify ? await import('./helpers/simplify-native-evaluation.mjs') : null;
if ((args.includes('--simplify-arm') || simplifyPrepare || simplifyRoot || simplifyModel || simplifySha || args.includes('--simplify-provider') || openclawProfile)
  && (!Object.hasOwn((await import('./simplify-experiment-schedule.mjs')).STOP_ARMS, simplifyArm) || !simplifyRoot
    || !/^[a-f0-9]{64}$/u.test(simplifySha ?? '') || !simplifyNative?.supportsSimplifyModel(simplifyProvider, simplifyModel, openclawProfile)
    || !value('--output-root') || simplifyPrepare === args.includes('--live') || captureNative))
  throw new Error('Simplify evaluation needs an explicit arm, prebuilt package root, package SHA256, model and fresh output; choose --live or --simplify-prepare.');
const packageRoot = simplify ? await fs.realpath(simplifyRoot) : null;
const pairBatch = value('--case') === 'toy-pair';
const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const runtimeIdentity = sha256(await Promise.all(['lib/runtime-v2/stop-workspace-review.mjs', 'lib/runtime-v2/orchestrator.mjs',
  'lib/runtime-v2/production-stop.mjs', 'lib/runtime-v2/reviewer.mjs', 'lib/openclaw/reviewer.mjs']
  .map(async file => [file, sha256(await fs.readFile(path.join(packageRoot ?? sourceRoot, file)))])));
const outputRoot = value('--output-root') ? path.resolve(value('--output-root'))
  : path.join(sourceRoot, '.runtime-correction', 'live-stop-evaluation', new Date().toISOString().replaceAll(/[:.]/gu, '-'));
await fs.mkdir(path.dirname(outputRoot), { recursive: true });
await fs.mkdir(outputRoot, { recursive: !pairBatch && !simplify });
const executable = process.env.RUNTIME_CORRECTOR_AGENT_EXECUTABLE ?? (process.platform === 'win32'
  ? 'C:\\Users\\user\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'
  : await hostAdapter.resolveDefaultReviewerExecutable());
const model = process.env.RC_EVAL_MODEL ?? 'sonnet';
const cases = [
  ...['toy-a', 'toy-b'].filter(id => pairBatch || value('--case') === id).map(id => ({ id, syntheticPair: true, allMetrics: true,
    expected: id === 'toy-a' ? 'PASS' : 'DEVIATION',
    code: id === 'toy-a' ? 'export const next = value => value + 1;\n' : 'export const next = value => value;\n' })),
  ...failureEffectCases,
  ...exceptionalFlowCases,
  ...processOrderCases,
  { id: 'mixed-skill', expected: 'MIXED', expectedRows: MIXED_SKILL_EXPECTED, metricId: 'M16', metricIds: ['M08', 'M12', 'M16'],
    code: 'export const accept = value => value + 1;\n',
    requirement: 'Implement accept(value) in app.mjs. The allowed input domain consists only of finite numbers; arrays and every non-number input are outside scope and require no handling or rejection. For each allowed input, return that number plus one without storing state.',
    extraRequirements: [{ text: 'Before declaring completion, actually execute node --test and establish a successful exit from the real result. Apply the project Skill numeric-conditional-check according to its complete original conditions. This independent explicit user execution request also applies to this numeric-only task.', verificationTarget: 'PROCESS' }] },
  { id: 'internal-correct', expected: 'PASS', metricId: 'M16', code: 'export const accept = value => value + 1;\n', requirement: 'Implement accept(value) in app.mjs: return the input number plus one without storing state.' },
  { id: 'external-bug', expected: 'DEVIATION', metricId: 'M16', code: 'export const accept = value => value;\n', external: true },
  { id: 'missing-run', expected: 'UNVERIFIED', metricId: 'M12', code: 'export const accept = value => value + 1;\n', target: 'PROCESS',
    requirement: 'Before declaring completion, actually execute node --test in this project and establish a successful exit from the real execution result. A report claiming the command ran is insufficient.' },
  { id: 'hidden-dependency', expected: 'DEVIATION', metricId: 'M16',
    code: "import { bump } from './lib/calc.mjs';\nexport const accept = value => bump(value);\n",
    files: { 'lib/calc.mjs': 'export const bump = value => value;\n' },
    requirement: 'Implement accept(value) in app.mjs so it returns the input number plus one. Follow its production dependencies and preserve stateless behavior.' },
  { id: 'alias-bug', expected: 'DEVIATION', metricId: 'M16',
    code: "export function snapshot(io, sourcePath, backupPath) {\n  const value = io.read(sourcePath);\n  io.write(backupPath, value);\n  io.write(sourcePath, '');\n  return io.read(backupPath);\n}\n",
    requirement: 'Implement snapshot(io, sourcePath, backupPath): read the original source contents, copy them to backup, clear source, and return the original contents. Allowed paths include sourcePath === backupPath; the return value must still be the original contents for that case.' },
  { id: 'six-functions', expected: 'PASS', metricId: 'M16',
    code: Array.from({ length: 6 }, (_, index) => `export const accept${index + 1} = value => value + ${index + 1};`).join('\n') + '\n',
    requirements: Array.from({ length: 6 }, (_, index) => `Implement accept${index + 1}(value) in app.mjs: return the input number plus ${index + 1} without storing state.`) },
].filter(item => !value('--case') || item.id === value('--case') || pairBatch && item.syntheticPair);
const engines = value('--engine') ? [value('--engine')] : ['legacy', 'workspace'];
const transport = value('--transport') ?? 'cli';
if (args.includes('--trace-transport') && transport !== 'native') throw new Error('--trace-transport requires the isolated native transport.');
const production = args.includes('--production');
const repair = args.includes('--repair');
const automatic = args.includes('--automatic');
const requestedMetrics = value('--metrics')?.split(',');
if (simplify && (!Object.hasOwn((await import('./simplify-experiment-schedule.mjs')).SCREENING_SAMPLES, value('--case'))
  || !production || transport !== 'native' || value('--engine') !== 'workspace' || repair || automatic || requestedMetrics || args.includes('--trace-transport')))
  throw new Error('Simplify round 1 uses one scheduled case, production workspace engine, native Gateway and fixed fixture metrics.');
if (requestedMetrics?.some(id => !/^M(?:0[1-9]|1[0-6])$/u.test(id))) throw new Error('Invalid --metrics list.');
if (!cases.length) throw new Error('Unknown --case.');
if (!['cli', 'native'].includes(transport) || engines.some(engine => !['legacy', 'workspace'].includes(engine))) throw new Error('Unknown evaluation transport or engine.');
if (transport === 'native' && !value('--host-root')) throw new Error('Native evaluation needs --host-root.');
if (captureNative && (args.includes('--live') || transport !== 'native' || !production || engines[0] !== 'workspace'
  || engines.length !== 1 || cases.length !== (pairBatch ? 2 : 1) || !cases[0].syntheticPair || requestedMetrics || repair || automatic))
  throw new Error('Offline native capture requires one toy-a/toy-b case, native transport, workspace engine and --production, without live/metrics/repair/automatic.');
if (cases.some(spec => spec.syntheticPair) && (!value('--case') || transport !== 'native' || !production || requestedMetrics))
  throw new Error('Synthetic pair cases require explicit single-case production native execution with all default metrics.');
if (cases.some(spec => spec.syntheticPair) && !captureNative && !pairBatch)
  throw new Error('Synthetic native pair dispatch remains disabled until its measured payload and batch manifest are frozen. Use --capture-native.');
if (pairBatch && (!value('--native-pair-manifest') || repair || automatic)) throw new Error('A native toy-pair needs its frozen --native-pair-manifest, without repair or automatic.');
if (production && engines.some(engine => engine !== 'workspace')) throw new Error('Legacy production orchestration has been retired. Use --engine workspace --production; retained old full-flow records remain available for offline comparison. --engine legacy now tests a development component only.');
if (transport === 'native' && engines.length !== 1) throw new Error('Use an explicit --engine for native evaluation; run each engine in a fresh process to isolate host singletons.');
if (repair && (!production || transport !== 'native' || automatic || engines[0] !== 'workspace' || cases.length !== 1 || cases[0].id !== 'external-bug'))
  throw new Error('--repair requires --production --transport native --engine workspace --case external-bug, without --automatic. It tests real repair between two verification-only Stops.');
const records = [];
const runtimeV2Api = packageRoot ? {
  ...await simplifyNative.loadPackaged(packageRoot, 'lib/runtime-v2/config.mjs'),
  ...await simplifyNative.loadPackaged(packageRoot, 'lib/runtime-v2/orchestrator.mjs'),
} : { compileRuntimeV2Config, handleRuntimeV2Event };
const taskStoreApi = packageRoot ? await simplifyNative.loadPackaged(packageRoot, 'lib/runtime-v2/task-store.mjs') : { ensureTask, taskDirectory, withTaskState };
if (simplify) {
  simplifyNative.requireSimplifyStopSwitches(runtimeV2Api.compileRuntimeV2Config);
  const config = runtimeV2Api.compileRuntimeV2Config({ version: 2, stopCorrection: {
    enabled: true, originalRequirementsBasis: simplify.originalRequirementsBasis, deviationOnly: simplify.deviationOnly,
  } });
  if ((config.stopCorrection.originalRequirementsBasis === true) !== simplify.originalRequirementsBasis
    || (config.stopCorrection.deviationOnly === true) !== simplify.deviationOnly) throw new Error('Prebuilt package did not apply the requested Stop arm.');
}
const nativeBatch = pairBatch ? await (await import('./helpers/native-stop-evaluation.mjs')).installNativeStopBatch({
  hostRoot: value('--host-root'), sourceRoot, outputRoot,
  manifest: JSON.parse(await fs.readFile(value('--native-pair-manifest'), 'utf8')), offline: captureNative }) : null;
async function transportMetrics(directory) {
  if (!directory) return null;
  const files = [];
  async function walk(root) { for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name); if (entry.isDirectory()) await walk(file); else if (/^cli-stream-\d+\.jsonl$/u.test(entry.name)) files.push(file);
  } }
  await walk(directory);
  const calls = new Map(), messages = new Map(), models = new Set();
  for (const file of files) for (const line of (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean)) {
    let frame; try { frame = JSON.parse(line); } catch { continue; }
    if (frame.type === 'system' && frame.subtype === 'init' && frame.model) models.add(frame.model);
    if (frame.type !== 'assistant') continue;
    if (frame.message?.id && frame.message.usage) messages.set(frame.message.id, frame.message.usage);
    for (const block of frame.message?.content ?? []) if (block.type === 'tool_use') calls.set(block.id, block.name);
  }
  return { actualModels: [...models], cliInvocations: files.length, assistantMessages: messages.size, toolCalls: calls.size,
    toolNames: [...calls.values()], observedUsage: [...messages.values()], usageSource: 'CLI supplied message counters; not independently verified billing' };
}
try { for (const spec of cases) {
  // Only results retain the case-to-oracle mapping. Paths and task identity
  // seen by the reviewer never contain correct/bug/PASS/expected labels.
  const parent = path.join(outputRoot, `sample-${randomUUID()}`), projectRoot = path.join(parent, 'project');
  await fs.mkdir(projectRoot, { recursive: true });
  const contract = path.join(parent, 'original-contract.md');
  await fs.writeFile(contract, spec.syntheticPair
    ? 'Implement next(value) in app.mjs for integers 0 through 9. Return value + 1 without storing state. No other input behavior is required.\n'
    : 'The production accept(value) function must return the input number plus one. It must not store state.\n');
  const requirement = spec.requirement ?? `Implement ${spec.syntheticPair ? 'next' : 'accept'}(value) in app.mjs according to the complete original contract at ${contract}. Preserve all its conditions. This referenced file is outside the project directory and is part of the original user request.`;
  const file = path.join(projectRoot, 'app.mjs');
  await fs.writeFile(file, spec.syntheticPair ? 'export const next = value => value + 1;\n' : 'export const accept = value => value + 1;\n');
  for (const [relative, contents] of Object.entries(spec.files ?? {})) {
    const target = path.join(projectRoot, relative); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, contents);
  }
  execFileSync('git', ['init', '--quiet', '--template=', projectRoot], { windowsHide: true });
  if (process.platform === 'win32') execFileSync('git', ['-C', projectRoot, 'config', '--local', 'core.longpaths', 'true'], { windowsHide: true });
  execFileSync('git', ['-C', projectRoot, 'add', 'app.mjs'], { windowsHide: true });
  execFileSync('git', ['-C', projectRoot, '-c', 'user.name=RC Local Evaluation', '-c', 'user.email=rc@example.invalid', '-c', 'core.hooksPath=nonexistent', 'commit', '--quiet', '-m', 'original'], { windowsHide: true });
  await fs.writeFile(file, spec.code);
  for (const engine of engines.filter(engine => !spec.expectedRows || engine === 'workspace')) {
    const sessionIdentity = randomUUID();
    const task = await taskStoreApi.ensureTask({ projectRoot, sessionId: sessionIdentity });
    const statements = spec.requirements ?? [requirement, ...(spec.extraRequirements ?? []).map(claim => claim.text)];
    const claims = statements.map((text, index) => ({ claimId: `R${index + 1}`, revisionId: `R${index + 1}@1`, text, category: spec.category ?? 'requirements', status: 'ACTIVE', severity: 'HARD', authority: 'USER_EXPLICIT',
      applicabilityKind: 'CURRENT_TASK', verificationTarget: spec.extraRequirements?.[index - 1]?.verificationTarget ?? spec.target ?? 'IMPLEMENTATION' }));
    const truth = { taskId: task.taskId, version: 1, digest: sha256(claims), claims };
    const truthPath = path.join(taskStoreApi.taskDirectory(projectRoot, task.taskId), 'ground-truth/current.json');
    if (!simplify?.originalRequirementsBasis) {
      await fs.mkdir(path.dirname(truthPath), { recursive: true }); await fs.writeFile(truthPath, JSON.stringify(truth, null, 2));
      await taskStoreApi.withTaskState({ projectRoot, taskId: task.taskId }, state => { state.groundTruth.version = 1; state.groundTruth.digest = truth.digest; });
    }
    const metricIds = spec.allMetrics ? Object.entries(compileRuntimeV2Config({ version: 2 }).stopCorrection.metrics).filter(([, enabled]) => enabled).map(([id]) => id)
      : requestedMetrics ?? spec.metricIds ?? [spec.metricId];
    const skillRoots = spec.expectedRows ? [path.join(parent, 'original-skills')] : [];
    const skillDocuments = spec.expectedRows ? [await prepareMixedSkillEvaluation({ projectRoot, taskId: task.taskId, skillRoots })] : [];
    const preparedPopulation = spec.expectedRows || spec.allMetrics ? await buildMetricPopulation({ projectRoot, taskId: task.taskId, groundTruth: truth, skillDocuments }) : null;
    const population = preparedPopulation ? { ...preparedPopulation, metrics: Object.fromEntries(Object.entries(preparedPopulation.metrics).filter(([id]) => metricIds.includes(id))) }
      : { metrics: { [spec.metricId]: claims.map(claim => ({ objectId: `${spec.metricId}:${claim.claimId}`, metricId: spec.metricId, sourceId: claim.claimId, sourceRevisionId: claim.revisionId, hard: true, evidenceRequired: true,
      authority: 'USER_EXPLICIT', description: claim.text, applicabilityKind: 'CURRENT_TASK', verificationTarget: claim.verificationTarget })) } };
    const objects = Object.values(population.metrics).flat();
    const snapshot = { entries: [{ type: 'user', uuid: 'U1', message: { content: statements.join('\n') } },
      { type: 'assistant', uuid: 'A1', message: { content: 'The task is complete. The implementation and requested verification are complete.' } }] };
    if (spec.prepare) snapshot.entries.splice(1, 0, ...await spec.prepare({ file }));
    if (simplifyPrepare) {
      const transcript = path.join(projectRoot, 'parent-transcript.jsonl');
      await fs.writeFile(transcript, snapshot.entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
      const prepared = { arm: simplifyArm, case: spec.id, switches: simplify, packageSha256: simplifySha, runtimeIdentity,
        transcript, baselineFixture: simplify.baseline ? truthPath : null, skillRoots, materials: spec.external ? [contract] : [] };
      await fs.writeFile(path.join(outputRoot, 'prepare.json'), JSON.stringify(prepared, null, 2), { flag: 'wx' });
      process.exit(0);
    }
    const reviewer = { session: 'detached', model, effort: 'low', timeoutMs: reviewBudgetMs, maxOutputTokens: 32768, maxBudgetUsd: 0.25 };
    const input = { projectRoot, sessionCwd: projectRoot, taskId: task.taskId, role: 'stop-reviewer', reviewer, schema: STOP_REVIEW_SCHEMA, hostAdapter, skillRoots,
      excludedEvidencePaths: [path.join(outputRoot, 'results.json')],
      reviewerRuntime: { executable }, evidence: { groundTruth: truth, snapshot },
      request: { groundTruthPath: truthPath, hook: { last_assistant_message: snapshot.entries.at(-1).message.content }, workflowStages: [],
        population, sourceManifest: [{ path: 'app.mjs', sha256: sha256(await fs.readFile(file)) }],
        fixedStopClassification: { stopClassification: 'TASK_COMPLETE', stage: null },
        reviewScope: { kind: engine === 'workspace' ? 'workspace-stop' : 'metric', objectIds: objects.map(object => object.objectId), sourceIds: claims.map(claim => claim.claimId) } } };
    const startedAt = Date.now(); let handle, session, lease, error, native, outcome, repairCycle, capture, batchCapture, stopElapsedMs;
    console.log(JSON.stringify({ case: spec.id, engine, transport, production, state: 'started', model: nativeBatch || captureNative ? 'glm-5.3' : transport === 'native' ? process.env.RC_EVAL_NATIVE_MODEL ?? process.env.ANTHROPIC_MODEL : model }));
    try {
      if (simplify) {
        native = await simplifyNative.createSimplifyStopNative({ hostRoot: value('--host-root'), projectRoot, outputRoot: parent, sourceRoot,
          prebuiltPluginRoot: packageRoot, model: simplifyModel, providerKind: simplifyProvider, openclawProfile, phaseTimeoutMs: assessmentBudgetMs, pairRateLimitFile });
      } else if (transport === 'native') {
        const { createNativeStopEvaluation, installNativeStopCapture } = await import('./helpers/native-stop-evaluation.mjs');
        if (nativeBatch) batchCapture = await nativeBatch.beginCase({ projectRoot, contract });
        else if (captureNative) {
          process.env.RC_NATIVE_EVAL_CAPTURE_KEY = 'offline-native-dummy-not-an-authentication-key';
          capture = await installNativeStopCapture({ hostRoot: value('--host-root'), directory: path.join(outputRoot, 'payloads'), projectRoot, externalFiles: [contract] });
        }
        const provider = nativeBatch ? { api: 'openai-completions', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', model: 'glm-5.3', credentialEnv: 'RC_NATIVE_STOP_API_KEY' }
          : captureNative ? { api: 'openai-completions', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', model: 'glm-5.3', credentialEnv: 'RC_NATIVE_EVAL_CAPTURE_KEY' }
          : value('--native-protocol') ? { api: value('--native-protocol'), baseUrl: value('--native-base'), model: value('--native-model'), credentialEnv: value('--native-key-env') } : undefined;
        native = await createNativeStopEvaluation({ hostRoot: value('--host-root'), projectRoot, outputRoot: parent, sourceRoot,
          stateRoot: spec.syntheticPair ? path.join(outputRoot, 'profiles', randomUUID()) : undefined,
          capture: batchCapture ?? capture, batch: nativeBatch, providerCredential: nativeBatch?.credential(),
          fixtureFence: spec.syntheticPair ? { projectRoot, externalFiles: [contract] } : undefined,
          provider, legacy: engine === 'legacy', traceTransport: args.includes('--trace-transport') });
      }
      if (production) {
        const transcript = path.join(projectRoot, 'parent-transcript.jsonl');
        await fs.writeFile(transcript, snapshot.entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
        const launch = native?.run ?? startRoleReviewer;
        let finalReviewStart = 0;
        const handles = [], factory = Object.assign(async request => { handle = await launch(request); handles.push(handle); return handle; }, launch,
          { supportsWorkspaceStopReview: true });
        // The production deadline includes its feedback reserve. Keep 180s
        // of actual review time plus 30s for the unchanged settlement path.
        factory.reviewDeadlineAt = Date.now() + assessmentBudgetMs;
        factory.reviewAbortSignal = AbortSignal.timeout(assessmentBudgetMs);
        const { maxBudgetUsd, ...nativeReviewer } = reviewer;
        const runtimeV2 = runtimeV2Api.compileRuntimeV2Config({ version: 2, dynamicGroundTruth: { enabled: false,
          ...(simplify && spec.external ? { materialRoots: [contract] } : {}) }, skillCorrection: { enabled: false, skillRoots },
          artifactCorrection: { groundTruthReviewEnabled: false }, implementationCorrection: { enabled: false, platform: null },
          reviewers: { stopReviewer: native ? { ...nativeReviewer, model: native.modelRef } : reviewer },
          stopCorrection: { enabled: true, assessmentTimeoutMs: assessmentBudgetMs, feedbackReserveMs,
            ...(simplify ? { originalRequirementsBasis: simplify.originalRequirementsBasis, deviationOnly: simplify.deviationOnly } : {}),
            ...(!spec.allMetrics ? { metrics: Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`M${String(index + 1).padStart(2, '0')}`, metricIds.includes(`M${String(index + 1).padStart(2, '0')}`)])) } : {}) } });
        const options = { projectRoot, ...(simplify ? { pluginRoot: packageRoot } : {}),
          plan: { runtimeV2, artifacts: [], configuredArtifacts: [], ...(!native ? { reviewerRuntime: { executable } } : {}) },
          reviewerFactory: factory, stopHost: { directory: path.join(projectRoot, '.runtime-correction', 'host-state') } };
        const identity = { session_id: sessionIdentity, cwd: projectRoot, transcript_path: transcript };
        await runtimeV2Api.handleRuntimeV2Event({ ...options, input: { ...identity, hook_event_name: 'SessionStart', source: 'startup' } });
        if (automatic || simplify) await runtimeV2Api.handleRuntimeV2Event({ ...options, input: { ...identity, hook_event_name: 'UserPromptSubmit', hook_event_id: 'original-user', prompt: statements.join('\n') } });
        const stopStartedAt = Date.now();
        if (simplify) {
          factory.reviewDeadlineAt = stopStartedAt + assessmentBudgetMs;
          factory.reviewAbortSignal = AbortSignal.timeout(assessmentBudgetMs);
        }
        outcome = await runtimeV2Api.handleRuntimeV2Event({ ...options, assessmentContext: { mode: automatic ? 'execute_and_correct' : 'verify_only', assessmentId: 'original-stop' },
          input: { ...identity, hook_event_name: 'Stop', hook_event_id: 'original-stop', last_assistant_message: snapshot.entries.at(-1).message.content } });
        if (simplify) stopElapsedMs = Date.now() - stopStartedAt;
        if (repair) {
          if (outcome.stop?.status !== 'DEVIATION' || !outcome.stop.feedback) throw new Error('Repair requires a confirmed initial deviation and checked feedback.');
          const firstStatus = outcome.stop.status, firstEvaluation = outcome.stop.stopCorrection.evaluationId;
          const business = await native.repair({ requirement: statements.join('\n'), feedback: outcome.stop.feedback, file });
          snapshot.entries.push(...business.entries);
          await fs.writeFile(transcript, snapshot.entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
          const finalText = business.entries.filter(entry => entry.type === 'assistant').at(-1)?.message.content
            .filter(block => block.type === 'text').map(block => block.text).join('\n');
          if (!finalText) throw new Error('The real business model did not deliver a completion message.');
          factory.reviewDeadlineAt = Date.now() + assessmentBudgetMs; factory.reviewAbortSignal = AbortSignal.timeout(assessmentBudgetMs);
          finalReviewStart = handles.length; handle = undefined;
          outcome = await handleRuntimeV2Event({ ...options, assessmentContext: { mode: 'verify_only', assessmentId: 'repaired-stop' },
            input: { ...identity, hook_event_name: 'Stop', hook_event_id: 'repaired-stop', last_assistant_message: finalText } });
          repairCycle = { firstStatus, firstEvaluation, businessTranscript: business.transcript,
            businessRunId: business.runId, finalStatus: outcome.stop?.status ?? null, finalEvaluation: outcome.stop?.stopCorrection?.evaluationId ?? null,
            kind: 'real business model between two verification-only Stops; no automatic dispatch or start quota claim' };
        }
        const finalHandles = handles.slice(finalReviewStart);
        const reviews = finalHandles.filter(item => item.result?.metricObjectJudgements?.length);
        if (reviews.length) handle = { ...reviews.at(-1),
          result: { ...reviews.at(-1).result, metricObjectJudgements: reviews.flatMap(item => item.result.metricObjectJudgements) },
          sourceCitations: reviews.flatMap(item => item.sourceCitations ?? []),
          evaluationArtifacts: finalHandles.map(item => item.artifacts).filter(Boolean) };
      } else if (native || engine === 'workspace') handle = await (native?.run ?? startRoleReviewer)(input);
      else {
        const { runReviewTask } = await import('../lib/review-task/review-task.mjs');
        lease = await createInternalRunLease({ projectRoot, taskId: task.taskId, role: 'stop-reviewer' });
        session = await createCliTaskSession({ input, hostAdapter, launchPlan: { executable, argsPrefix: [] }, env: internalRunEnvironment(lease, process.env) });
        // Only the legacy evidence tools see its copied source root. Keep the
        // CLI process cwd short enough for Windows CreateProcess; this does
        // not widen those tools or change their captured comparison subject.
        handle = await runStopTaskReview(input, { runTask: options => runReviewTask({ ...options,
          nativeRun: worker => session.run({ ...worker, cwd: projectRoot }) }) });
      }
    } catch (cause) { error = { code: cause.code ?? 'EVALUATION_FAILED', message: simplify ? simplifyNative.redactEvaluationText(cause.message) : cause.message }; }
    finally { await session?.close(); if (lease) await releaseInternalRunLease(lease); await handle?.close(); await native?.close(); await capture?.close();
      if (captureNative) delete process.env.RC_NATIVE_EVAL_CAPTURE_KEY; }
    // A failed production recheck has no current verdict. Never fill that gap
    // with the first Stop's successful handle and stale pre-repair evidence.
    const judgements = production ? outcome?.stop?.review?.metricObjectJudgements ?? [] : handle?.result.metricObjectJudgements ?? [];
    const row = judgements[0];
    const expected = repair ? 'PASS' : spec.expected;
    const expectedRows = Object.fromEntries(objects.map(object => [object.objectId, spec.expectedRows?.[object.objectId] ?? expected]));
    const matchesExpected = objects.length > 0 && judgements.length === objects.length
      && objects.every(object => judgements.some(row => row.objectId === object.objectId && row.judgement === expectedRows[object.objectId]));
    let observation;
    if (simplify) {
      const { inspectNativeReviewArtifacts } = await import('./helpers/native-evaluation-metrics.mjs');
      const timing = native ? await simplifyNative.readProviderTiming(native.root) : [];
      const transcriptMetrics = await inspectNativeReviewArtifacts([taskStoreApi.taskDirectory(projectRoot, task.taskId)]);
      const repairFeedback = outcome?.stop ? outcome.stop.decision === 'block' && /\[runtime-corrector:stop-feedback\]/u.test(outcome.stop.feedback ?? '') : null;
      const reason = error?.code ?? outcome?.stop?.reasonCode ?? outcome?.reason ?? null;
      const completedInBudget = outcome?.stop?.review?.collection?.complete === true && Number.isFinite(stopElapsedMs) && stopElapsedMs <= assessmentBudgetMs;
      const profileStatus = native?.providerStatus?.();
      const rateLimited = (simplifyProvider === 'host-profile' || !completedInBudget)
        && timing.some(event => event.event === 'response' && event.status === 429) || profileStatus?.failure === 'PROFILE_RATE_LIMIT';
      const frameworkError = simplifyProvider === 'host-profile' && Boolean(error || !outcome?.stop || profileStatus?.failure);
      const state = rateLimited ? 'rate-limited' : frameworkError ? 'failed' : completedInBudget ? 'completed'
        : /DEADLINE|TIMEOUT/u.test(reason ?? '') || stopElapsedMs > assessmentBudgetMs ? 'timed-out' : 'failed';
      observation = { arm: simplifyArm, artifactSha256: simplifySha, repairFeedback, completedInBudget, state, frameworkError,
        rcElapsedMs: stopElapsedMs ?? null, reason, baselineSource: simplify.baseline ? 'controlled fixture' : 'original-user-message',
        providerIdentity: native?.providerIdentity ?? null, gatewayPort: native?.port ?? null,
        feedback: repairFeedback ? simplifyNative.redactEvaluationText(outcome.stop.feedback) : null,
        usage: simplifyNative.summarizeProviderUsage(timing.filter(event => event.event === 'request').length, transcriptMetrics.observations.map(row => row.usage)),
        configurationSummary: JSON.stringify({ ...simplify, model: simplifyModel, provider: native?.providerIdentity ?? simplifyProvider,
          metricIds, transport: 'isolated-openclaw-gateway', budgetMs: assessmentBudgetMs,
          feedbackReserveMs, fixedBaselineFixture: simplify.baseline, compactionRestore: false }) };
    }
    const record = { case: spec.id, engine, production, automatic, metrics: metricIds, expectedObjectIds: objects.map(object => object.objectId), expectedRows, matchesExpected, productionStatus: outcome?.stop?.status ?? null,
      ...(capture ? { capture: capture.metrics(), modelVerdictObtained: false, baselineSource: 'controlled fixture, not extraction acceptance' } : {}),
      ...(nativeBatch ? { batch: { requestsSoFar: nativeBatch.metrics().budget.requests, deadlineAt: nativeBatch.metrics().deadlineAt,
        offline: captureNative }, baselineSource: 'controlled fixture, not extraction acceptance' } : {}),
      judgements, productionReason: outcome?.stop?.reasonCode ?? outcome?.reason ?? null,
      productionError: outcome?.stop?.error ?? null, evaluationArtifacts: handle?.evaluationArtifacts ?? [],
      transportKind: transport, model: native?.model ?? model, expected, repairCycle,
      judgement: row?.judgement ?? (outcome?.stop?.status === 'UNVERIFIED' ? 'UNVERIFIED' : 'ERROR'),
      reason: row?.reason ?? outcome?.stop?.error ?? outcome?.stop?.reasonCode ?? null,
      elapsedMs: Date.now() - startedAt, error, artifacts: handle?.artifacts ?? null, sourcePaths: [...new Set((handle?.sourceCitations ?? []).map(citation => citation.path))],
      transport: native?.metrics() ?? await transportMetrics(handle?.artifacts), legacyTransportCwd: engine === 'legacy' ? 'original project; copied evidence tools unchanged' : null,
      runtimeIdentity, ...(observation ? { simplify: observation } : {}) };
    if (simplify) {
      const safeRecord = JSON.stringify(record, (_key, value) => typeof value === 'string' ? simplifyNative.redactEvaluationText(value) : value);
      records.push(JSON.parse(safeRecord));
      await fs.writeFile(path.join(outputRoot, 'results.json'), JSON.stringify({ model: simplifyModel, records }, null, 2), { flag: 'wx' });
      console.log(JSON.stringify({ case: spec.id, arm: simplifyArm, state: observation.state, outputRoot }));
      continue;
    }
    records.push(record); await fs.writeFile(path.join(outputRoot, 'results.json'), JSON.stringify({ model: nativeBatch || captureNative ? 'glm-5.3' : model, generatedAt: new Date().toISOString(), records }, null, 2));
    console.log(JSON.stringify(record));
  }
} } finally { await nativeBatch?.close(); }
if (!records.length) throw new Error('No supported cases selected. The mixed Skill case requires --engine workspace.');
console.log(JSON.stringify({ outputRoot, cases: records.length, workspaceMatches: records.filter(record => record.engine === 'workspace' && record.matchesExpected).length }));
if (simplify ? records.some(record => record.simplify?.state !== 'completed')
  : captureNative && !nativeBatch ? records.some(record => record.capture?.payloadCount !== 2 || record.capture?.socketAttempts !== 0
  || record.capture?.toolResultsInFollowup.length !== 3 || record.capture.toolResultsInFollowup.some(message => message.content.includes('NATIVE_FIXTURE_PATH_DENIED')))
  : captureNative && nativeBatch ? nativeBatch.metrics().wireDispatches !== 4 || nativeBatch.metrics().budget.halted !== null
  : records.some(record => record.error || (record.engine === 'workspace' || record.production) && !record.matchesExpected)) process.exitCode = 1;
// The installed host leaves profile/watch timers alive. This explicit offline
// CLI owns its process; exit only after all native and simulated fetch work
// has settled. No active invocation is discarded to manufacture completion.
if (simplify) process.exit(process.exitCode ?? 0);
if (captureNative || nativeBatch) {
  if (records.some(record => record.transport?.nativeInvocations !== record.transport?.settledInvocations
    || record.capture && record.capture.simulatedBudget.inFlightRequests !== 0)
    || nativeBatch && nativeBatch.metrics().budget.inFlightRequests !== 0) throw new Error('Native work remains in flight');
  process.exit(process.exitCode ?? 0);
}
