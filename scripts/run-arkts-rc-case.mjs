// Real business run + real RC hooks in an isolated native Gateway. Hidden
// scoring is deliberately a later evaluator process, never a host tool.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { loadArktsTask, arktsAgentInput, digest } from './bench/arkts-dataset.mjs';
import { prepareArktsModelWorkspace } from './bench/prepare-arkts-model-workspace.mjs';
import { createArktsBenchTools } from './bench/native-arkts-tools.mjs';
import { createNativeGatewayEvaluation, nativeModelContextWindow } from './helpers/native-gateway-evaluation.mjs';
import { businessMutationPaths, inheritedBusinessMutationScope } from './bench/business-mutations.mjs';
import { knownBusinessTerminal, businessCompleted, createBusinessRunTracker, createBusinessTerminalObserver } from './bench/business-completion.mjs';
import { validateArtifactSkills } from './bench/validate-artifact-skills.mjs';
import { arktsRunProfile, renderArktsRunConfig } from './bench/arkts-run-profile.mjs';
import { verifyFrozenArtifact } from './bench/frozen-artifact-verification.mjs';
import { restoreStopSessionLedger } from './bench/restore-stop-session.mjs';
import { restoreNativeProjectScope } from './bench/restore-project-scope.mjs';
import { runBoundedProcess } from './bench/bounded-process.mjs';
import { localTestEvidence } from './bench/local-test-evidence.mjs';
import { createBusinessCheckpointObserver } from './bench/business-checkpoint.mjs';
import { assertBusinessSessionIdentity, EXPERIMENT_SESSION_RESET } from './bench/session-continuity.mjs';
import { createSimplifyGateway, redactEvaluationText, resolveSimplifyProvider, summarizeProviderUsage } from './helpers/simplify-native-evaluation.mjs';
import { STOP_ARMS } from './simplify-experiment-schedule.mjs';
import { prepareFrozenArktsWorkspace, reviewFrozenArktsDraft } from './bench/simplify-arkts-frozen.mjs';
import { prepareJava } from './bench/arkts-java.mjs';
import { applyRcConfigOverrides, deepMerge, emitSimpleYaml, loadRcConfigOverrides, regressionCheckPolicy } from './bench/rc-config-overrides.mjs';
import { parseSimpleYaml as parseHarnessYaml } from '../lib/simple-yaml.mjs';
const parseConfiguredStop = text => parseHarnessYaml(text, { source: 'project config' }).stopCorrection ?? {};
const arg = key => process.argv.find(value => value.startsWith(`${key}=`))?.slice(key.length + 1);
const rcOverrides = await loadRcConfigOverrides(arg('--rc-config-overrides'));
let stopPolicy = null;
const profile = arktsRunProfile(arg('--phase-timeout-ms'), { hostNoTimeout: process.argv.includes('--host-no-timeout') });
const simplifyArm = arg('--simplify-arm');
const hostProfileProvider = arg('--provider') === 'host-profile';
const reviewerModel = arg('--reviewer-model');
const s0 = simplifyArm === 'S0';
const frozenRoot = arg('--frozen');
const originalPackageSha256 = 'ec358bfbd52df682ca921a185195293682ee470630f1be011c147e11a480fa9a';
const replacementPackageSha256 = 'a678d55b6f58ede1ff686afc02c6438a6ba943158d6e642d38cfe4806a53b059';
const packageSha256 = arg('--package-sha256') ?? originalPackageSha256;
const packageSources = { [originalPackageSha256]: 'b6700c1f2f056949d35b5bacb763334ebe7a15cf',
  [replacementPackageSha256]: '0bbf9e3c5ff91e2a4018a09a751a96a6d0392520' };
const frozenPackageSha256 = arg('--frozen-package-sha256') ?? packageSha256;
const planSha256 = arg('--plan-sha256');
const arm = s0 ? { enabled: false, baseline: false, originalRequirementsBasis: false, deviationOnly: false }
  : simplifyArm ? { ...STOP_ARMS[simplifyArm], enabled: true } : null;
const contextWindowTokens = nativeModelContextWindow(arg('--context-window-tokens'));
const pagedReads = process.argv.includes('--paged-reads');
const businessToolNames = [pagedReads ? 'bench_read' : 'read', 'write', 'edit', 'apply_patch', 'bench_nav', 'bench_check'];
if (process.argv.includes('--verify-pending-rc') && !arg('--resume-run')) throw new Error('--verify-pending-rc requires a genuine captured continuation');
const gitExecutable = arg('--git') ?? (process.platform === 'win32' ? 'C:/Program Files/Git/cmd/git.exe' : 'git');
const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const stopProfile = arg('--stop-profile') ?? 'assessment';
const reviewOnly = process.argv.includes('--review-only');
if (reviewOnly && (!frozenRoot || stopProfile !== 'assessment')) throw new Error('--review-only requires a frozen assessment.');
const priorFeedback = arg('--prior-feedback-task') ? { sourceTask: arg('--prior-feedback-task'), evaluationId: arg('--prior-feedback-evaluation') } : null;
if (priorFeedback && (!reviewOnly || !priorFeedback.evaluationId)) throw new Error('Prior feedback requires a review-only replay and a historical evaluation ID.');
if (!['assessment', 'release'].includes(stopProfile) || stopProfile === 'release' && !frozenRoot) throw new Error('--stop-profile is assessment or release (frozen replays only).');
if (process.argv.includes('--release-build')) {
  // A new package is identified by its digest and exact source commit; the
  // artifact is still verified file by file against that commit below.
  const release = JSON.parse(await fs.readFile(path.join(sourceRoot, 'docs/original-basis-release-inputs.json'), 'utf8'));
  const releaseCommit = arg('--source-commit') ?? (packageSha256 === release.packageSha256 ? release.sourceCommit : null);
  if (!frozenRoot || simplifyArm !== 'B12' || !/^[0-9a-f]{40}$/u.test(releaseCommit ?? '')) throw new Error('Use a release build and its exact source commit for the frozen B12 checks.');
  packageSources[packageSha256] = releaseCommit;
  if (arg('--frozen-source-release')) {
    const origin = JSON.parse(await fs.readFile(arg('--frozen-source-release'), 'utf8'));
    if (origin.packageSha256 !== frozenPackageSha256 || !/^[0-9a-f]{40}$/u.test(origin.sourceCommit ?? '')
      || digest(await fs.readFile(origin.archive)) !== frozenPackageSha256)
      throw new Error('The frozen source release identity changed.');
    execFileSync(gitExecutable, ['-C', sourceRoot, 'cat-file', '-e', `${origin.sourceCommit}^{commit}`], { windowsHide: true });
    packageSources[frozenPackageSha256] = origin.sourceCommit;
  }
} else if (arg('--source-commit')) throw new Error('--source-commit requires --release-build.');
const hostRoot = arg('--host-root');
const toolRoot = arg('--tool-root') ?? 'C:/Program Files/Huawei/command-line-tools';
let providerIdentity, archive;
if (simplifyArm) {
  if (!s0 && !Object.hasOwn(STOP_ARMS, simplifyArm) || Boolean(frozenRoot) === s0 || profile.hostNoTimeout !== s0
    || arg('--resume-run') || arg('--artifact') || !hostRoot || !arg('--output') || !arg('--cache') || !arg('--workspace-root')
    || !arg('--dataset') || !arg('--tool-root') || !arg('--package') || !profile.explicit || arg('--provider') !== 'host-profile'
    || digest(await fs.readFile(path.join(sourceRoot, 'docs/simplify-experiment-plan.md'))) !== planSha256)
    throw new Error('Supply pinned ArkTS plan, local paths, DeepSeek provider, and the appropriate S0 or frozen Stop mode.');
  if (!Object.hasOwn(packageSources, packageSha256) || !Object.hasOwn(packageSources, frozenPackageSha256)
    || digest(await fs.readFile(archive = await fs.realpath(arg('--package')))) !== packageSha256)
    throw new Error('Pinned ArkTS integration package SHA256 changed.');
  ({ identity: providerIdentity } = await resolveSimplifyProvider('host-profile', arg('--model'), arg('--openclaw-profile'), reviewerModel));
}
if (!simplifyArm && hostProfileProvider)
  ({ identity: providerIdentity } = await resolveSimplifyProvider('host-profile', arg('--model'), arg('--openclaw-profile'), reviewerModel));
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
  if (head !== (resumeManifest.resumeHead ?? resumeManifest.preparedHead)) throw new Error('Prior prepared business HEAD changed.');
  if (resumeManifest.resumeHead) execFileSync(gitExecutable, ['-C', resumeManifest.projectRoot, 'merge-base', '--is-ancestor', resumeManifest.preparedHead, head], { windowsHide: true });
  await fs.mkdir(outputRoot, { recursive: false });
}
const prepared = resumeRoot ? { projectRoot: resumeManifest.projectRoot, preparedHead: resumeManifest.preparedHead,
  baseCommit: resumeManifest.baseCommit, environmentAdapted: true, resumedFrom: resumeRoot }
  : frozenRoot ? await prepareFrozenArktsWorkspace({ frozenRoot, freezeSha256: arg('--freeze-sha256'), task, datasetDigest,
    artifactSha256: frozenPackageSha256, planSha256, git: gitExecutable, cacheRoot, outputRoot, workspaceRoot: arg('--workspace-root') })
  : await prepareArktsModelWorkspace({ task, outputRoot, cacheRoot, gitExecutable,
  ...(arg('--workspace-base') ? { workspaceBase: path.resolve(arg('--workspace-base')) } : {}),
  workspaceRoot: arg('--workspace-root'), json5Package: arg('--json5-package'),
  ...(profile.explicit ? { preparationTimeoutMs: profile.setupTimeoutMs } : {}) });
const input = arktsAgentInput(task), projectRoot = prepared.projectRoot;
const inheritedScope = resumeRoot ? await inheritedBusinessMutationScope(resumeRoot, projectRoot)
  : { mutationPaths: [], sourceRun: null, skippedStartupRuns: [] };
await fs.writeFile(path.join(outputRoot, 'inherited-business-scope.json'), JSON.stringify(inheritedScope, null, 2));
await fs.writeFile(path.join(outputRoot, 'public-input.json'), JSON.stringify(input, null, 2));
const setupScript = fileURLToPath(new URL('./bench/run-arkts-toolchain.ps1', import.meta.url));
const java = prepareJava({ explicit: arg('--java-home'), projectRoot, toolRoot });
await fs.writeFile(path.join(outputRoot, 'java.json'), JSON.stringify(java, null, 2));
if (!resumeRoot) try {
  const installed = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', setupScript,
    '-Project', projectRoot, '-ToolRoot', toolRoot, '-Phase', 'install'], { windowsHide: true, timeout: profile.setupTimeoutMs, maxBuffer: 2 * 1024 * 1024 });
  await fs.writeFile(path.join(outputRoot, 'install.log'), simplifyArm ? redactEvaluationText(installed) : installed);
} catch (error) {
  await fs.writeFile(path.join(outputRoot, 'install.log'), String(error.stdout ?? '') + String(error.stderr ?? ''));
  throw new Error('Business-workspace dependency preparation failed; no model should start');
}
const lockfiles = ['oh-package-lock.json5', 'entry/oh-package-lock.json5'];
for (const file of resumeRoot || frozenRoot ? [] : lockfiles) if (await fs.stat(path.join(projectRoot, file)).catch(() => null))
  execFileSync(gitExecutable, ['-C', projectRoot, 'add', '--force', '--', file], { windowsHide: true });
if (!resumeRoot && !frozenRoot) execFileSync(gitExecutable, ['-C', projectRoot, '-c', 'user.name=RC Benchmark', '-c', 'user.email=rc@example.invalid', '-c', 'core.hooksPath=nonexistent',
  'commit', '--quiet', '--allow-empty', '-m', 'Common benchmark dependency preparation'], { windowsHide: true });
if (frozenRoot) {
  const changed = execFileSync(gitExecutable, ['-C', projectRoot, 'diff', '--name-only', '-z', 'HEAD']).toString().split('\0').filter(Boolean);
  if (changed.some(file => !lockfiles.includes(file))) throw new Error('Dependency setup changed the frozen implementation.');
  if (changed.length) execFileSync(gitExecutable, ['-C', projectRoot, 'restore', '--source=HEAD', '--', ...changed], { windowsHide: true });
} else if (!resumeRoot) prepared.preparedHead = execFileSync(gitExecutable, ['-C', projectRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (archive) execFileSync('tar', ['-xf', archive, '-C', outputRoot], { windowsHide: true, stdio: 'pipe' });
const artifact = archive ? path.join(outputRoot, 'package') : arg('--artifact') ? await fs.realpath(arg('--artifact')) : null;
const baselineRef = simplifyArm ? packageSources[packageSha256] : arg('--baseline-ref') ?? 'c33bae6';
let verifiedRcCommit = execFileSync(gitExecutable, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (artifact) {
  const validatedSkills = await validateArtifactSkills(artifact, arg('--host-root') ?? 'C:/Users/user/workspace/program_workspace/MatrixAssistant/resources/openclaw');
  await fs.writeFile(path.join(outputRoot, 'skill-validation.json'), JSON.stringify(validatedSkills, null, 2));
  const validation = await verifyFrozenArtifact({ gitExecutable, cwd: sourceRoot, reference: baselineRef, artifact });
  verifiedRcCommit = validation.baselineCommit;
  await fs.writeFile(path.join(outputRoot, 'baseline-artifact-validation.json'), JSON.stringify(validation, null, 2));
}
const model = simplifyArm || hostProfileProvider ? arg('--model') : process.env.RC_EVAL_NATIVE_MODEL ?? process.env.ANTHROPIC_MODEL;
if (!model) throw new Error('Configured native model is required');
if (s0) {
  await fs.writeFile(path.join(outputRoot, 's0-policy.json'), JSON.stringify({ pluginInstalled: true, enabled: false, ...arm }, null, 2));
} else {
  await fs.mkdir(path.join(projectRoot, '.runtime-corrector'), { recursive: true });
  let rendered = renderArktsRunConfig(simplifyArm ? `openai/${model}` : model, profile, arm), releaseStop = null;
  if (stopProfile === 'release') {
    const { parseSimpleYaml } = await import(pathToFileURL(path.join(artifact, 'lib/simple-yaml.mjs')).href);
    releaseStop = parseSimpleYaml(await fs.readFile(path.join(artifact, '.runtime-corrector-default/config.yaml'), 'utf8')).stopCorrection;
    rendered = emitSimpleYaml(deepMerge(parseSimpleYaml(rendered), { stopCorrection: releaseStop }));
  }
  if (reviewOnly) rendered = emitSimpleYaml(deepMerge(parseHarnessYaml(rendered), { shadowMode: true }));
  const configured = applyRcConfigOverrides(rendered, rcOverrides, { projectRoot, toolRoot, javaHome: java.javaHome, node: process.execPath,
    harnessRoot: path.resolve(sourceRoot), outputRoot });
  await fs.writeFile(path.join(projectRoot, '.runtime-corrector/config.yaml'), configured.text);
  await fs.copyFile(path.join(projectRoot, '.runtime-corrector/config.yaml'), path.join(outputRoot, 'project-config.yaml'));
  // Validate actual generated policy before starting the native Gateway/model.
  const { loadConfig } = await import(pathToFileURL(path.join(artifact ?? sourceRoot, 'lib/runtime-corrector.mjs')).href);
  const effective = await loadConfig({ cwd: projectRoot, pluginRoot: artifact ?? sourceRoot });
  if (reviewOnly && effective.runtimeV2.shadowMode !== true) throw new Error('Frozen review-only mode must suppress correction starts.');
  if (arm) {
    const { stopCorrection, dynamicGroundTruth, skillCorrection, artifactCorrection } = effective.runtimeV2;
    if (stopCorrection.enabled !== arm.enabled || dynamicGroundTruth.enabled !== arm.baseline
      || Boolean(stopCorrection.originalRequirementsBasis) !== arm.originalRequirementsBasis || Boolean(stopCorrection.deviationOnly) !== arm.deviationOnly
      || skillCorrection.enabled || artifactCorrection.groundTruthReviewEnabled
      || releaseStop && !configured.applied?.value?.stopCorrection?.waitMode && stopCorrection.waitMode !== releaseStop.waitMode)
      throw new Error('Effective ArkTS correction policy differs from the assigned arm.');
  }
  stopPolicy = { profile: stopProfile, waitMode: effective.runtimeV2.stopCorrection.waitMode, maxCorrectionsPerSession: effective.runtimeV2.stopCorrection.maxCorrectionsPerSession,
    overrides: configured.applied, regressionCheck: regressionCheckPolicy(parseConfiguredStop(configured.text).regressionCheck, effective.runtimeV2.stopCorrection.regressionCheck) };
  await fs.writeFile(path.join(outputRoot, 'stop-policy.json'), JSON.stringify(stopPolicy, null, 2));
}
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
  baselineLocalTests.baseCommit = prepared.preparedHead;
}
if (baselineLocalTests) await fs.writeFile(path.join(outputRoot, 'baseline-local-tests.json'), JSON.stringify(baselineLocalTests, null, 2));
const extra = await createArktsBenchTools({ outputRoot, projectRoot, toolRoot, stableNavigationRoot, checkTimeoutMs: profile.checkTimeoutMs, baselineLocalTests, pagedReads,
  javaHome: java.javaHome });
const checkpointObserver = resumeRoot ? await createBusinessCheckpointObserver({ outputRoot, projectRoot, preparedHead: prepared.preparedHead }) : null;
const { transcript: _frozenTranscript, frozen: _frozen, ...preparedSummary } = prepared;
const manifest = { kind: 'real-native-arkts-rc-run', instanceId: task.instance_id, datasetDigest, ...preparedSummary,
  ...(arm ? { simplifyArm, planSha256, artifactSha256: packageSha256, providerIdentity,
    ...(frozenRoot ? { freezeSha256: arg('--freeze-sha256'), frozenPackageSha256 } : {}) } : {}),
  rcSource: verifiedRcCommit, java: { javaHome: java.javaHome, source: java.source, version: java.version }, stopPolicy,
  harnessSha256: Object.fromEntries(await Promise.all(['run-arkts-rc-case.mjs', 'helpers/native-gateway-evaluation.mjs', 'helpers/provider-fetch-timing.mjs',
    'bench/native-arkts-tools.mjs', 'bench/local-test-evidence.mjs', 'bench/hypium-results.mjs', 'bench/arkts-run-profile.mjs',
    'bench/business-completion.mjs', 'bench/business-mutations.mjs', 'bench/session-continuity.mjs', 'bench/bounded-process.mjs', 'bench/prepare-arkts-model-workspace.mjs',
    'bench/run-arkts-toolchain.ps1', 'bench/arkts-java.mjs', 'bench/rc-config-overrides.mjs', 'bench/simplify-arkts-frozen.mjs']
    .map(async file => [file, createHash('sha256').update(await fs.readFile(new URL(file, import.meta.url))).digest('hex')]))),
  prebuiltArtifact: artifact, commonNavigationRoot: stableNavigationRoot,
  businessModel: providerIdentity?.modelRef ?? `anthropic/${model}`, privateModel: reviewerModel ? `custom/${reviewerModel}` : providerIdentity?.modelRef ?? `anthropic/${model}`, businessTools: businessToolNames,
  businessReads: { paged: pagedReads, ...(pagedReads ? { defaultLines: 120, maximumLines: 250 } : {}) },
  modelCapacity: { contextWindowTokens, maximumOutputTokens: 32768, appliedToCustomProvider: Boolean(process.env.ANTHROPIC_BASE_URL),
    source: arg('--context-window-tokens') ? 'explicit CLI declaration' : 'legacy benchmark default' },
  modelThinkingPolicy: { businessRequested: 'off', customModelReasoningCapability: process.env.ANTHROPIC_BASE_URL ? false : null,
    providerThinkingDisabledVerified: false, qualification: process.env.ANTHROPIC_BASE_URL
      ? 'Pinned native transport omits the thinking field for this non-reasoning custom-model declaration. Requested off does not prove remote thinking is disabled; no request override or effort change is applied.'
      : 'The installed provider model definition is used. Requested off alone does not prove the emitted request or remote thinking policy; no request override or effort change is applied.' },
  limits: { ...profile, correctionAdmissions: stopPolicy?.maxCorrectionsPerSession ?? 1 },
  hostMaintenance: { memoryFlushEnabled: false, automaticCompaction: 'host default', sessionReset: EXPERIMENT_SESSION_RESET },
  originalLocalBaseline: baselineLocalTests ? { completeRuntime: baselineLocalTests.completeRuntime, counts: baselineLocalTests.counts, failures: baselineLocalTests.failures } : null,
  recoveryIntent: process.argv.includes('--verify-pending-rc') ? 'pending-rc-acceptance' : 'complete-business-task',
  inputPolicy: 'Only public input and original base source; evaluator test_patch/gold not installed in business workspace.',
  state: 'PREPARED', ownerPid: process.pid };
await fs.writeFile(path.join(outputRoot, 'manifest.json'), JSON.stringify(manifest, null, 2));
if (!process.argv.includes('--live')) { console.log(JSON.stringify({ state: 'PREPARED_NO_MODEL', outputRoot, baselineArtifactVerified: Boolean(artifact) })); process.exit(0); }
if (!hostRoot) throw new Error('--host-root=<read-only-openclaw> required for --live');
let gateway, result, restoredRecordCount = 0;
try {
  const options = { hostRoot, projectRoot, outputRoot, sourceRoot, prebuiltPluginRoot: artifact,
    extraPluginPaths: [extra, ...(checkpointObserver ? [checkpointObserver] : [])], businessToolNames, confineBusinessFiles: true,
    phaseTimeoutMs: profile.explicit && !s0 ? profile.phaseTimeoutMs : null, unlimitedBusiness: profile.hostNoTimeout === true,
    ...(hostProfileProvider ? { hookTimeoutMs: 30000 } : {}),
    disableRuntimeCorrection: s0,
    disableMemoryFlush: true, preserveSessionHistory: true, ...(arg('--context-window-tokens') ? { contextWindowTokens } : {}) };
  gateway = arm || hostProfileProvider ? await createSimplifyGateway({ ...options, providerKind: 'host-profile', openclawProfile: arg('--openclaw-profile'), model, reviewerModel,
    ...(reviewerModel ? { nativeCustomProvider: true } : {}),
    pairRateLimitFile: arg('--pair-rate-limit-file'), pairRateLimitPauseMs: arg('--pair-rate-limit-pause-ms') ? Number(arg('--pair-rate-limit-pause-ms')) : null })
    : await createNativeGatewayEvaluation(options);
  if (hostProfileProvider) {
    const definition = gateway.config.models.providers.custom.models.find(value => value.id === model);
    manifest.modelCapacity = { contextWindowTokens: definition.contextWindow, maximumOutputTokens: definition.maxTokens,
      appliedToCustomProvider: true, source: 'actual pinned native host-profile definition' };
    await fs.writeFile(path.join(outputRoot, 'manifest.json'), JSON.stringify(manifest, null, 2));
  }
  if (s0 && gateway.config.plugins.entries['runtime-corrector'].config.enabled !== false)
    throw new Error('S0 Gateway must disable correction before business admission.');
  if (frozenRoot) {
    result = await reviewFrozenArktsDraft({ gateway, prepared, manifest, profile, git: gitExecutable, outputRoot, reviewOnly, priorFeedback,
      maxCorrections: stopPolicy?.maxCorrectionsPerSession ?? 1 });
  } else {
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
  const businessTerminalObserver = createBusinessTerminalObserver();
  async function observeBusinessTerminal(force = false, phase = post?.phase) {
    const terminal = await businessTerminalObserver.poll(gateway.request, businessRun.runId,
      () => gateway.metrics().modelStarts, phase, { force });
    for (const event of businessTerminalObserver.drainEvents()) await fs.appendFile(path.join(outputRoot, 'business-terminal-observations.jsonl'), JSON.stringify(event) + '\n');
    return terminal;
  }
  const continuationLimits = `Host business timeout: ${profile.mainTimeoutMs === 0 ? 'none' : `${profile.mainTimeoutMs}ms`}; RC assessment timeout: ${profile.assessmentTimeoutMs}ms; private review timeout: ${profile.privateTimeoutMs}ms.`;
  const prompt = resumeEntry && process.argv.includes('--verify-pending-rc')
    ? `Continue the original ${task.instance_id} task in this genuine session and existing workspace. Its final RC acceptance remains pending. Give a truthful status based on existing work; normal automatic post-run RC review will execute after your response. Preserve the implementation and address only genuine remaining blockers. ${continuationLimits} No evaluator results, hidden tests, implementation hints or expected answers are supplied.`
    : resumeEntry ? `Continue the original ${task.instance_id} task in this genuine session and existing workspace. Complete the implementation and actual checks, rather than stopping at analysis. Preserve and use the existing progress and compaction notes. ${continuationLimits} No new implementation hints or hidden evaluation data are supplied.`
    : `${input.problem_statement}\n\n${input.hints_text}\nWork in the current repository. API24 and unsigned local preparation are provided. Use available workspace navigation and project checks; keep the change focused on this issue. Report actual checks and any remaining uncertainty.${baselineLocalTests ? `\nThe unmodified original local tests were executed before your changes: ${JSON.stringify({ counts: baselineLocalTests.counts, failures: baselineLocalTests.failures })}. bench_check test compares against this baseline. Preserve unrelated passing behavior and distinguish existing failures from regressions; a baseline match does not establish the requested fix. If an original test directly codifies the reported bug, update it to assert the requested behavior and explain the change. Do not weaken or bypass assertions merely to obtain a pass.` : ''}`;
  const readGuidance = pagedReads ? '\nUse bench_read for bounded source pages. Locate relevant symbols with bench_nav grep before reading their line ranges; follow nextOffset only when additional context is needed.' : '';
  await gateway.request('chat.send', { sessionKey, sessionId, message: prompt + readGuidance, idempotencyKey: runId, deliver: false, thinking: 'off', timeoutMs: profile.mainTimeoutMs });
  const load = file => import(pathToFileURL(path.join(gateway.pluginRoot, file)).href);
  const { findTask } = await load('lib/runtime-v2/task-store.mjs');
  const { listNativeRuns } = await load('lib/openclaw/native-runs.mjs');
  const postDirectory = path.join(gateway.runtime.state.resolveStateDir(), 'runtime-corrector-stop-sessions/post-run');
  let currentTask, post, runs = [], last, businessBudgetAbortRequested = false, officialBusinessTerminal;
  while (manifest.limits.totalTimeoutMs === null || Date.now() - startedAt < manifest.limits.totalTimeoutMs) {
    if (gateway.providerStatus?.()?.failure) break;
    await gateway.drain();
    const admittedEntry = await gateway.runtime.agent.session.getSessionEntry({ ...scope, readConsistency: 'latest' });
    assertBusinessSessionIdentity({ sessionId, sessionKey, runId }, admittedEntry, gateway.metrics().modelStarts);
    currentTask = await findTask({ projectRoot, sessionId });
    const names = await fs.readdir(postDirectory).catch(() => []);
    for (const name of names.filter(name => name.endsWith('.json'))) {
      const record = await fs.readFile(path.join(postDirectory, name), 'utf8').then(JSON.parse, () => null);
      if (record?.sessionId === sessionId) post = record;
    }
    runs = currentTask ? await listNativeRuns(projectRoot, currentTask.taskId) : [];
    businessRun.observe(post);
    officialBusinessTerminal = await observeBusinessTerminal(false, s0 ? 'OBSERVE' : post?.phase);
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
    if (s0 && knownBusinessTerminal(officialBusinessTerminal, activeBusinessRunId)) break;
    if (['IDLE', 'CLOSED'].includes(post?.phase) && gateway.metrics().modelStarts.some(event => event.runId === runId && event.sessionId === sessionId)
      && runs.every(run => run.status === 'SETTLED')) {
      if (knownBusinessTerminal(officialBusinessTerminal, activeBusinessRunId) || !profile.hostNoTimeout) break;
    }
    if (profile.explicit && post?.reason === 'HOST_RUN_RECONCILIATION_REQUIRED' && runs.every(run => run.status === 'SETTLED')) {
      if (!profile.hostNoTimeout) break;
      if (knownBusinessTerminal(officialBusinessTerminal, activeBusinessRunId) && officialBusinessTerminal.status === 'error') break;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const finalBusinessRunId = businessRun.runId;
  if (!knownBusinessTerminal(officialBusinessTerminal, finalBusinessRunId))
    officialBusinessTerminal = await observeBusinessTerminal(true);
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
    basis: 'Captured business write/edit/apply_patch receipts plus prior genuine business scope. Maintenance-only startup attempts excluded; full workspace.patch and notes retained.' }, null, 2));
  const infrastructureComplete = (s0 || ['IDLE', 'CLOSED'].includes(post?.phase)) && runs.every(run => run.status === 'SETTLED')
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
  if (s0) {
    const boundary = gateway.providerStatus();
    result.modelRequests = boundary.requests;
    result.usage = summarizeProviderUsage(boundary.requests, receiptRecords.filter(row => row.message?.role === 'assistant').map(row => row.message.usage));
    result.frameworkError = Boolean(boundary.failure);
    if (boundary.failure) Object.assign(result, { state: boundary.failure === 'PROFILE_RATE_LIMIT' ? 'rate-limited' : 'INCOMPLETE', endReason: boundary.failure });
  }
  await fs.writeFile(path.join(outputRoot, 'result.json'), JSON.stringify(result, null, 2));
  await fs.writeFile(path.join(outputRoot, 'progress.json'), JSON.stringify({ state: result.state, ownerPid: process.pid, sessionId,
    businessCompleted: result.businessCompleted, infrastructureComplete, officialBusinessStatus: officialBusinessTerminal?.status, endedAt: Date.now() }));
  }
} catch (error) {
  if (error.code === 'ARKTS_SESSION_IDENTITY_DRIFT') {
    const evidence = { kind: 'native-business-session-identity-failure', observedAt: new Date().toISOString(), ...error.evidence };
    await fs.writeFile(path.join(outputRoot, 'session-identity-failure.json'), JSON.stringify(evidence, null, 2), { flag: 'wx' });
    await gateway.request('chat.abort', { sessionKey: evidence.sessionKey, runId: evidence.runId }).catch(() => {});
    result = { ...manifest, state: 'INCOMPLETE', ...error.evidence, businessCompleted: false, infrastructureComplete: false,
      endReason: error.code, officialBusinessTerminal: null, qualification: 'Replacement session activity cannot establish genuine business continuation.' };
    await fs.writeFile(path.join(outputRoot, 'result.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
    await fs.writeFile(path.join(outputRoot, 'progress.json'), JSON.stringify({ ...result, endedAt: Date.now() }, null, 2));
  }
  throw simplifyArm ? new Error(redactEvaluationText(error.message)) : error;
} finally { await gateway?.close(); }
// Native host singletons may retain observers; only awaited settled runs are
// eligible for a normal result. This development process owns no desktop host.
console.log(JSON.stringify({ state: result.state, actualBusinessStart: result.actualBusinessStart, verification: result.verification,
  infrastructureComplete: result.infrastructureComplete, patchBytes: result.patchBytes, outputRoot }));
process.exit((frozenRoot ? result.completedInBudget : result.infrastructureComplete && result.actualBusinessStart) ? 0 : 1);
