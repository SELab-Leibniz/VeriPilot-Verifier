
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { arktsAgentInput, digest, loadArktsTask, validateArktsAgentInput } from './bench/arkts-dataset.mjs';
import { prepareArktsModelWorkspace } from './bench/prepare-arkts-model-workspace.mjs';
import { arktsVerificationInstructions, createArktsBenchTools } from './bench/native-arkts-tools.mjs';
import { readArktsLintRequirement, runArktsRequiredLint } from './bench/arkts-build-lint-check.mjs';
import { runBoundedProcess } from './bench/bounded-process.mjs';
import { verifyFrozenArtifact } from './bench/frozen-artifact-verification.mjs';
import { assertBusinessSessionIdentity } from './bench/session-continuity.mjs';
import { businessMutationPaths, sealableMutationPaths } from './bench/business-mutations.mjs';
import { businessCompleted, createBusinessRunTracker, createBusinessTerminalObserver, pairedBusinessWorkflowFailure, retainedBusinessTransportError } from './bench/business-completion.mjs';
import { compareOpenSpecApplyProgress, installOriginalBasisPolicy, loadOriginalBasisWorkflow, openSpecApplyRecoveryPrompt, openSpecBusinessInput, prepareOpenSpecSession, readOpenSpecCheckpoint, runOpenSpecCli, settleOpenSpecProposal, workflowMessages } from './bench/original-basis-workflow.mjs';
import { pinOpenSpecApplyChecklist, settleOpenSpecApplyChecklist } from './bench/openspec-apply-checklist.mjs';
import { armNativeOpenSpecApply, observeNativeOpenSpecApply, prepareNativeOpenSpecProposal } from './bench/native-openspec-approval.mjs';
import { bindOpenSpecRequirementInventory, loadOpenSpecRequirementInventory, prepareOpenSpecRequirementInventory,
  validateOpenSpecRequirementInventoryCase } from './bench/openspec-requirement-inventory.mjs';
import { collectAutomaticDocumentEvidence } from './evaluate-openclaw-document-e2e.mjs';
import { prepareJava } from './bench/arkts-java.mjs';
import { arktsToolchainCommand } from './bench/arkts-toolchain-runner.mjs';
import { runArktsLocalTest } from './bench/arkts-local-test.mjs';
import { loadRcConfigOverrides } from './bench/rc-config-overrides.mjs';
import { arktsAcceptancePolicy, loadArktsPublicAcceptance, loadArktsQualifiedProbeDescriptor } from './bench/arkts-public-acceptance.mjs';
import { arktsInstrumentRuntime } from './bench/arkts-instrument-results.mjs';
import { localTestEvidence } from './bench/local-test-evidence.mjs';
import { arktsBusinessDiffScope, captureBusinessCheckpoint, compareOpenSpecApplyScope, createBusinessCheckpointObserver, isArktsCheckpointPath, sameApplyRecoveryScope } from './bench/business-checkpoint.mjs';
import { completedToolWarningTerminal } from '../lib/openclaw/post-run-host.mjs';
import { isPathInside } from '../lib/path-utils.mjs';
import { codeChanged, collectReleaseEvidence, finalStopOf, tokenSplit } from './bench/release-evidence.mjs';
import { directProposalStopSettled, readNativeStopRecords, waitNativeStopSettled } from './bench/native-stop-settlement.mjs';
import { createSimplifyGateway, deepseekCodingModel, deepseekModel, deepseekReviewerModel, loadPackaged,
  readProviderTiming, redactEvaluationText, summarizeProviderUsage } from './helpers/simplify-native-evaluation.mjs';
import { measureSimplifyBenchmark } from './helpers/simplify-stop-benchmark.mjs';

const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const write = (file, data) => fs.writeFile(file, JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
const jsonl = text => text.split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const cases = ['security_tool_1', 'security_tool_2', 'security_tool_6', 'security_tool_7', 'security_tool_9', 'soduku-harmony_11'];
const configFile = path.join(sourceRoot, 'docs/original-basis-release-inputs.json');
const timeoutMs = 120 * 60_000;
const { values: args } = parseArgs({ options: Object.fromEntries([
  ...['case','output','host-root','package','package-sha256','source-commit','workflow-root','openspec-cli','openclaw-profile','dataset','tool-root',
    'cache','workspace-root','json5-package','pair-rate-limit-file','pair-rate-limit-pause-ms','provider','model','reviewer-model','deadline-at','java-home','rc-config-overrides',
    'public-input','public-input-sha256','dataset-sha256','public-test-exchange','public-test-toolchain-sha256','instrument-config','instrument-toolchain-sha256',
    'public-acceptance-sha256','public-acceptance-descriptor','public-test-runtime','openspec-requirement-inventory','openspec-requirement-inventory-sha256']
    .map(name => [name, { type: 'string' }]),
  ['offline', { type: 'boolean' }], ['live', { type: 'boolean' }], ['baseline-local-tests', { type: 'boolean' }], ['rc-off', { type: 'boolean' }],
  ['native-openspec-approval', { type: 'boolean' }],
]) });
const offline = args.offline === true;
const model = args.model;
const paired = Boolean(args['public-input']);
const rcEnabled = !args['rc-off'];
const nativeOpenSpecApproval = args['native-openspec-approval'] === true;
const sha256 = value => /^[a-f0-9]{64}$/u.test(value ?? '');
const inventoryFile = args['openspec-requirement-inventory'];
const inventorySha256 = args['openspec-requirement-inventory-sha256'];
if (inventoryFile !== undefined || inventorySha256 !== undefined)
  assert(nativeOpenSpecApproval && inventoryFile && sha256(inventorySha256),
    'The strict OpenSpec inventory requires both pinned inventory options and native OpenSpec approval.');
if (nativeOpenSpecApproval && (!paired || offline || !rcEnabled))
  throw new Error('Native OpenSpec approval requires a live paired RC-on run.');
if (offline === (args.live === true) || args.provider !== 'host-profile' || ![deepseekCodingModel, deepseekModel].includes(model)
  || !['output','host-root','package','package-sha256','workflow-root','openclaw-profile'].every(key => args[key])
  || !rcEnabled && (!paired || args['rc-config-overrides'] || args['reviewer-model'])
  || paired && (offline || args.dataset || !args.case || !sha256(args['dataset-sha256']) || !sha256(args['public-input-sha256']))
  || args['public-acceptance-sha256'] !== undefined && (!paired || !args['baseline-local-tests'] || !sha256(args['public-acceptance-sha256']))
  || args['public-acceptance-descriptor'] !== undefined && (!args['public-acceptance-descriptor'] || !args['public-acceptance-sha256'])
  || !paired && (args['dataset-sha256'] || args['public-input-sha256'] || !offline && (!args.dataset || !cases.includes(args.case)))
  || !offline && !['tool-root','cache','workspace-root','json5-package'].every(key => args[key]))
  throw new Error('Supply the pinned release package, local workflow and host profile, and choose offline preflight or a live ArkTS case.');

const inputs = await read(configFile);
const outputRoot = path.resolve(args.output);
const archive = path.resolve(args.package);
const deadline = Math.min(Date.now() + timeoutMs, args['deadline-at'] ? Number(args['deadline-at']) : Infinity);
assert(Number.isFinite(deadline) && deadline > Date.now());
// A new package names its exact commit; the archive digest, the plugin version
// at that commit and every runtime module are still verified below.
const packageSha256 = args['package-sha256'], sourceCommit = args['source-commit'] ?? inputs.sourceCommit;
if (!args['source-commit']) assert.equal(packageSha256, inputs.packageSha256);
assert.match(sourceCommit, /^[0-9a-f]{40}$/u);
assert.equal(digest(await fs.readFile(archive)), packageSha256);
const testExchange = args['public-test-exchange'], testToolchainSha256 = args['public-test-toolchain-sha256'];
const testRuntime = args['public-test-runtime'];
assert(testRuntime === undefined || testExchange && testRuntime === arktsInstrumentRuntime && paired && /^[a-z0-9_-]+$/u.test(args.case),
  'Instrument Test worker requires the paired case and public exchange');
let publicTestWorker;
if (testExchange !== undefined || testToolchainSha256 !== undefined) {
  assert(!offline && testExchange && sha256(testToolchainSha256), 'Supply both public test worker options for a live run.');
  publicTestWorker = { exchange:path.resolve(testExchange), toolchainSha256:testToolchainSha256, releaseCommit:sourceCommit,
    ...(testRuntime ? { runtime:testRuntime, caseId:args.case } : {}) };
  process.env.RC_ARKTS_TEST_EXCHANGE = publicTestWorker.exchange;
  process.env.RC_ARKTS_TEST_TOOLCHAIN_SHA256 = publicTestWorker.toolchainSha256;
  process.env.RC_ARKTS_TEST_RELEASE_COMMIT = publicTestWorker.releaseCommit;
  if (testRuntime) {
    process.env.RC_ARKTS_TEST_RUNTIME = testRuntime;
    process.env.RC_ARKTS_TEST_CASE = args.case;
  }
}
let instrument;
if (args['instrument-config'] !== undefined || args['instrument-toolchain-sha256'] !== undefined) {
  assert(paired && !offline && !publicTestWorker && args['instrument-config'] && sha256(args['instrument-toolchain-sha256']),
    'Instrument Test requires a pinned device configuration and a live paired run');
  const { arktsInstrumentRoute, captureArktsInstrumentIdentity, loadArktsInstrumentConfig } = await import('./bench/arkts-instrument-runtime.mjs');
  const config = await loadArktsInstrumentConfig(path.resolve(args['instrument-config']));
  const route = arktsInstrumentRoute(config, args.case);
  const runtime = await captureArktsInstrumentIdentity({ config, toolRoot: args['tool-root'], javaHome: args['java-home'] });
  assert.equal(runtime.sha256, args['instrument-toolchain-sha256'], 'Instrument Test toolchain changed after preflight');
  instrument = { route, expectedDevice: runtime.devices.find(device => device.target === route.target), json5Package: path.resolve(args['json5-package']) };
  process.env.RC_ARKTS_INSTRUMENT = JSON.stringify(instrument);
}
const expectedVersion = args['source-commit'] ? JSON.parse(execFileSync('git', ['show', `${sourceCommit}:packaging/hosts/openclaw/openclaw.plugin.json`],
  { cwd: sourceRoot, windowsHide: true, encoding: 'utf8' })).version : inputs.version;
let rcOverrides = await loadRcConfigOverrides(args['rc-config-overrides']);
const reviewerModel = args['reviewer-model'] ?? (model === deepseekCodingModel ? deepseekReviewerModel : model);
const reviewerModelRef = `custom/${reviewerModel}`;
const hostRoot = path.resolve(args['host-root']);
const workflow = await loadOriginalBasisWorkflow(path.resolve(args['workflow-root']), hostRoot, inputs.workflow,
  { openspecCli: args['openspec-cli'] && path.resolve(args['openspec-cli']) });
const git = (cwd, ...params) => execFileSync('git', ['-c', 'core.longpaths=true', '-C', cwd, ...params],
  { windowsHide: true, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore','pipe','pipe'] });
const commit = (cwd, message) => git(cwd, '-c', 'user.name=RC Benchmark', '-c', 'user.email=rc@example.invalid',
  '-c', 'core.hooksPath=nonexistent', 'commit', '--quiet', '--allow-empty', '-m', message);
let projectRoot, preparedHead, preparedTree, instance, publicInput, publicInputSha256, publicAcceptance, proposalInventory;
const startedAt = Date.now();
if (offline) {
  await fs.mkdir(outputRoot);
  projectRoot = path.join(outputRoot, 'project');
  await fs.mkdir(projectRoot);
  publicInput = { problem_statement: 'Offline preflight. Keep the proposed importer entirely local.' };
} else {
  if (paired) {
    const bytes = await fs.readFile(args['public-input']);
    publicInputSha256 = digest(bytes);
    assert.equal(publicInputSha256, args['public-input-sha256'], 'The public task projection changed after planning.');
    publicInput = validateArktsAgentInput(JSON.parse(bytes), args.case);
    if (inventoryFile) {
      const inventory = await loadOpenSpecRequirementInventory(inventoryFile, inventorySha256);
      proposalInventory = inventory.cases.get(args.case);
      validateOpenSpecRequirementInventoryCase(proposalInventory, { publicInputSha256, problemStatement: publicInput.problem_statement });
    }
    instance = { id: publicInput.instance_id, baseCommit: publicInput.base_commit, datasetDigest: args['dataset-sha256'] };
    if (args['public-acceptance-sha256']) {
      publicAcceptance = args['public-acceptance-descriptor']
        ? await loadArktsQualifiedProbeDescriptor(args['public-acceptance-descriptor'], publicInput, publicInputSha256, args['public-acceptance-sha256'])
        : await loadArktsPublicAcceptance(publicInput, publicInputSha256);
      assert.equal(publicAcceptance?.identitySha256, args['public-acceptance-sha256'], 'Public acceptance changed after campaign preflight');
      if (rcEnabled) {
        rcOverrides ??= await loadRcConfigOverrides(path.join(sourceRoot, 'config', 'arkts-openspec-correction.json'));
        rcOverrides = arktsAcceptancePolicy(rcOverrides, publicAcceptance);
      }
    }
  } else {
    const { task, datasetDigest } = await loadArktsTask(args.dataset, args.case);
    instance = { id: task.instance_id, baseCommit: task.base_commit, datasetDigest };
    publicInput = arktsAgentInput(task);
  }
  ({ projectRoot } = await prepareArktsModelWorkspace({ task: publicInput, outputRoot, cacheRoot: args.cache,
    workspaceRoot: args['workspace-root'], json5Package: args['json5-package'] }));
  if (proposalInventory) assert(!isPathInside(projectRoot, await fs.realpath(inventoryFile)),
    'Keep the OpenSpec inventory outside the business worktree.');
}
const changeName = offline ? 'release-preflight' : paired ? 'benchmark-change' : 'arkts-permission-update';
const applyVerificationRunFile = paired ? path.join(outputRoot, 'bench-apply-run.json') : null;
const applyFeedback = { tool: 'bench_check' };
if (paired && rcEnabled) rcOverrides = { ...rcOverrides, value: { ...rcOverrides?.value, acceptanceFeedback: applyFeedback } };
if (proposalInventory) rcOverrides.value.artifactCorrection = { ...rcOverrides.value.artifactCorrection, requireOpenSpecProposalCoverage: true };
const spec = await prepareOpenSpecSession(workflow, projectRoot, outputRoot, changeName);
const artifact = path.join(outputRoot, 'package');
execFileSync('tar', ['-xf', archive, '-C', outputRoot], { windowsHide: true, stdio: 'pipe' });
const artifactManifest = await read(path.join(artifact, 'openclaw.plugin.json'));
assert.equal(artifactManifest.version, expectedVersion);
await write(path.join(outputRoot, 'package-validation.json'), await verifyFrozenArtifact({ cwd: sourceRoot,
  reference: sourceCommit, artifact }));
// The isolated Gateway runs in this process, so business tools inherit the
// resolved JDK; `java -version` must work before any model request.
const java = offline ? null : prepareJava({ explicit: args['java-home'], projectRoot, toolRoot: args['tool-root'] });
if (java) await write(path.join(outputRoot, 'java.json'), java);
const policies = rcEnabled ? await installOriginalBasisPolicy({ artifact, projectRoot, outputRoot, overrides: rcOverrides, reviewerModelRef,
  variables: { projectRoot, outputRoot, harnessRoot: path.resolve(sourceRoot), node: process.execPath,
    ...(args['tool-root'] ? { toolRoot: path.resolve(args['tool-root']) } : {}), ...(java ? { javaHome: java.javaHome } : {}) } }) : null;
if (paired && rcEnabled) assert.deepEqual(policies.runtimeV2.acceptanceFeedback, applyFeedback);
if (paired && rcEnabled) assert.equal(policies.runtimeV2.artifactCorrection.requireOpenSpecProposalCoverage === true,
  Boolean(proposalInventory), 'The strict OpenSpec policy requires a pinned evaluator requirement inventory.');
if (proposalInventory) assert.equal(policies.runtimeV2.stopCorrection.metrics.M16, true,
  'The strict OpenSpec inventory requires Stop production checks (M16).');
const messages = workflowMessages(workflow, projectRoot, changeName,
  [publicInput.problem_statement, publicInput.hints_text].filter(value => value?.trim()).join('\n\n'));
const lintRequirement = paired && process.platform === 'darwin' ? await readArktsLintRequirement(projectRoot) : null;
if (paired) {
  const verification = { lintRequirement, publicAcceptance };
  messages.proposal += '\n' + arktsVerificationInstructions({ ...verification, stage: 'proposal' });
  messages.codeing += '\n' + arktsVerificationInstructions(verification);
}
if (lintRequirement) {
  messages.proposal += '\nPreserve the repository instructions for HAP build and CodeLinter as a verification step.';
  messages.codeing += '\nRun bench_check with action "lint" for the repository-required HAP build followed by CodeLinter. Check off that step only when its result has success:true after the final source changes.';
}
const proposalReviewInput = proposalInventory && prepareOpenSpecRequirementInventory(proposalInventory, {
  publicInputSha256, problemStatement: publicInput.problem_statement, proposalMessage: messages.proposal });
await write(path.join(outputRoot, 'public-input.json'), publicInput);
await write(path.join(outputRoot, 'workflow-messages.json'), { flow: 'OpenSpec(solo)', version: spec.version, changeName,
  workflow: workflow.identity, dispatch: 'OpenSpec(solo) sequential-stage text and workspace prefix, selected by the isolated controller',
  ...(paired ? { proposalValidationRepair: { maxAttempts: 1 } } : {}), ...messages });
const extraPluginPaths = workflow.plugin ? [workflow.plugin, spec.plugin] : [spec.plugin];
const businessToolNames = ['read', 'write', 'edit', 'apply_patch', 'openspec_cli', ...(workflow.plugin ? ['sdd_next_step'] : [])];
if (!offline) {
  const runTool = (phase, options) => {
    const tool = arktsToolchainCommand({ toolRoot: args['tool-root'], javaHome: java.javaHome, projectRoot, phase });
    return runBoundedProcess(tool.command, tool.args, { cwd: projectRoot, env: tool.env, processGroup: true, ...options });
  };
  const installed = await runTool('install', { timeoutMs: 600_000, maxTail: 40_000 });
  await fs.writeFile(path.join(outputRoot, 'install.log'), redactEvaluationText(installed.tail));
  if (installed.exitCode !== 0 || installed.interrupted) throw new Error('Business dependency preparation failed.');
  const setup = git(projectRoot,'status','--porcelain','--untracked-files=all','-z').toString('utf8').split('\0').filter(Boolean);
  const paths = setup.map(entry => entry.slice(3)).filter(file => !file.startsWith('.runtime-corrector/'));
  assert(paths.every(file=>/^(?:\.opencode\/|openspec\/|(?:entry\/)?oh-package-lock\.json5$)/u.test(file)), JSON.stringify(paths));
  if (paths.length) git(projectRoot,'add','--',...paths);
  commit(projectRoot,'Prepare shared ArkTS and OpenSpec environment');
  preparedHead = git(projectRoot,'rev-parse','HEAD').toString().trim();
  preparedTree = git(projectRoot,'rev-parse','HEAD^{tree}').toString().trim();
  let baselineLocalTests = null;
  if (args['baseline-local-tests']) {
    // The workspace's own original tests, before any model request; never the hidden oracle.
    const { execution, output, raw, freshReport } = await runArktsLocalTest({ projectRoot, toolRoot: args['tool-root'],
      javaHome: java.javaHome, timeoutMs: 900_000, publicTestWorker, instrument });
    await fs.writeFile(path.join(outputRoot, 'baseline-local-test.log'), redactEvaluationText(output));
    baselineLocalTests = localTestEvidence(raw, execution, { freshReport, compileOutput: output });
    if (!baselineLocalTests.completeRuntime) throw new Error('Original local-test baseline did not finish; inspect baseline-local-test.log before starting a model.');
    baselineLocalTests.baseCommit = preparedHead;
    await write(path.join(outputRoot, 'baseline-local-tests.json'), baselineLocalTests);
  }
  extraPluginPaths.push(await createArktsBenchTools({ outputRoot, projectRoot, toolRoot: args['tool-root'],
    stableNavigationRoot: artifact, checkTimeoutMs: paired ? 1_800_000 : policies.runtimeV2.stopCorrection.assessmentTimeoutMs,
    deadlineAt: deadline, baselineLocalTests, javaHome: java.javaHome, publicTestWorker, instrument, publicAcceptance, lintRequirement,
    applyVerificationRunFile }));
  businessToolNames.push('bench_nav','bench_check');
  extraPluginPaths.push(await createBusinessCheckpointObserver({ outputRoot, projectRoot, preparedHead, includeBusinessPatch: paired }));
}
await write(path.join(outputRoot, 'manifest.json'), { instance, projectRoot, preparedHead, preparedTree, changeName, rcEnabled, publicInputSha256,
  packageSha256, sourceCommit, version: artifactManifest.version, modelRef: 'custom/'+model, reviewerModelRef: rcEnabled ? reviewerModelRef : null,
  java: java ? { javaHome: java.javaHome, source: java.source, version: java.version } : null,
  rcConfigOverrides: policies?.experimentOverrides ?? null, regressionCheck: policies?.regressionCheck ?? null,
  ...(instrument ? { publicInstrumentSha256: args['instrument-toolchain-sha256'] } : {}),
  ...(publicAcceptance ? { publicAcceptanceSha256: publicAcceptance.identitySha256 } : {}),
  ...(lintRequirement ? { lintRequirement } : {}),
  startedAt, deadline, offline });
let gateway, sessionId, sessionKey, transcriptFile;
async function findFiles(root, match) {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  const nested = await Promise.all(entries.map(async entry => {
    const file = path.join(root, entry.name);
    return entry.isDirectory() ? findFiles(file, match) : entry.isFile() && match(file) ? [file] : [];
  }));
  return nested.flat();
}
async function completedBusinessTerminal(observed) {
  if (observed?.status !== 'error') return observed;
  const completions = [];
  for (const file of await findFiles(path.join(outputRoot, 'checkpoints'), file => path.basename(file) === 'checkpoint.json')) {
    const completion = await read(file);
    if (completion.runId === observed.runId) completions.push(completion);
  }
  completions.sort((a, b) => String(b.completedAt ?? b.capturedAt).localeCompare(String(a.completedAt ?? a.capturedAt)));
  return completedToolWarningTerminal(observed, completions[0]);
}
try {
  gateway = await createSimplifyGateway({ hostRoot, projectRoot, outputRoot, sourceRoot,
    ...(rcEnabled ? { prebuiltPluginRoot: artifact, reviewerModel } : { omitRuntimeCorrection: true }),
    extraPluginPaths, businessToolNames, unlimitedBusiness: true, nativeCustomProvider: true, disableMemoryFlush: true,
    captureBusinessTransport: paired,
    preserveSessionHistory: true, model, providerKind: 'host-profile', openclawProfile: args['openclaw-profile'],
    ...(paired && !offline ? { preResponseRetryDeadlineAt: deadline } : {}),
    ...(offline ? { maxRequests: 0 } : {}), pairRateLimitFile: args['pair-rate-limit-file'],
    pairRateLimitPauseMs: args['pair-rate-limit-pause-ms'] ? Number(args['pair-rate-limit-pause-ms']) : null });
  assert.equal(gateway.modelRef, 'custom/'+model);
  const created = await gateway.request('sessions.create', { key: 'agent:main:arkts-'+randomUUID(), agentId: 'main', label: 'OpenSpec(solo)' });
  assert(created.ok && created.key);
  sessionKey = created.key;
  const scope = { agentId: 'main', sessionKey, storePath: gateway.config.session.store };
  await gateway.runtime.agent.session.patchSessionEntry({ ...scope, update: entry => ({ ...entry, spawnedCwd: projectRoot }) });
  const entry = await gateway.runtime.agent.session.getSessionEntry({ ...scope, readConsistency: 'latest' });
  sessionId = entry.sessionId;
  transcriptFile = path.join(gateway.root, sessionId+'.jsonl');
  if (offline) {
    await runOpenSpecCli(spec.options, ['new','change',changeName]);
    const runId = randomUUID(), toolCallId = randomUUID();
    await gateway.runtime.agent.session.upsertSessionEntry({ ...scope,
      entry: { ...entry, sessionFile: transcriptFile, spawnedCwd: projectRoot, updatedAt: Date.now() } });
    const seed = jsonl(await fs.readFile(transcriptFile, 'utf8'));
    assert(seed.length === 1 && seed[0].type === 'session' && seed[0].id === sessionId);
    await fs.writeFile(transcriptFile, JSON.stringify({ ...seed[0], cwd: projectRoot })+'\n');
    let parentId = null;
    const append = async message => {
      const id = randomUUID().slice(0,8);
      await fs.appendFile(transcriptFile, JSON.stringify({type:'message',id,parentId,timestamp:new Date().toISOString(),message})+'\n');
      parentId = id;
    };
    const ctx = { agentId:'main',sessionKey,sessionId,runId,workspaceDir:projectRoot,trigger:'user',
      modelProviderId:'custom',provider:'custom',modelId:model,abortSignal:new AbortController().signal };
    const user = { role:'user',content:messages.proposal };
    await gateway.hooks.runSessionStart({ sessionId,source:'startup' },ctx);
    await gateway.hooks.runBeforeAgentRun({ sessionId,sessionKey,prompt:messages.proposal },ctx);
    await gateway.hooks.runBeforePromptBuild({ prompt:messages.proposal,messages:[user] },ctx);
    await append(user);
    const params = { path:'openspec/changes/'+changeName+'/proposal.md',content:'# Local import proposal\n\nKeep all imports local.\n' };
    await append({ role:'assistant',content:[{type:'toolCall',id:toolCallId,name:'write',arguments:params}] });
    const gate = await gateway.hooks.runBeforeToolCall({ toolName:'write',toolCallId,params },ctx);
    assert(!gate?.block);
    await fs.writeFile(path.join(projectRoot,params.path),params.content);
    const result = { content:[{type:'text',text:'written'}],details:{status:'completed'} };
    await append({role:'toolResult',toolName:'write',toolCallId,isError:false,content:result.content});
    const middleware = gateway.registry.agentToolResultMiddlewares.find(item=>item.pluginId==='runtime-corrector');
    assert(middleware);
    const bound = [];
    let settled = false;
    const deliver = middleware.handler({toolName:'write',toolCallId,args:params,result},ctx).finally(()=>{settled=true;});
    while (!settled && !bound.length) {
      const files = await findFiles(path.join(projectRoot,'.runtime-correction','.semantic-review'),
        file => path.basename(file)==='request.json');
      for (const file of files) try {
        const request = await read(file);
        assert(!/(test_patch|evaluator-gold|f2p_passed|rollback)/u.test(JSON.stringify(request)));
        for (const reference of request.originalRequirements?.userMessages ?? []) {
          const text = await fs.readFile(reference.path,'utf8');
          if (text !== messages.proposal) continue;
          await write(path.join(outputRoot,'proposal-review-request.json'),request);
          bound.push({file,userMessageSha256:digest(text),artifact:params.path});
          break;
        }
      } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      if (!settled && !bound.length) await sleep(40);
    }
    await deliver;
    assert(bound.length, 'No proposal review request binds the original user message.');
    assert.equal(gateway.providerStatus().requests,0);
    assert.equal(gateway.providerStatus().failure,'PROFILE_REQUEST_LIMIT');
    const { OPENCLAW_TOOL_NAMES } = await loadPackaged(artifact,'lib/openclaw/tool-contracts.mjs');
    assert.deepEqual(artifactManifest.contracts.tools,OPENCLAW_TOOL_NAMES);
    assert(artifactManifest.contracts.tools.includes('set_original_checklist'));
    await write(path.join(outputRoot,'result.json'),{ state:'PREPARED_NO_MODEL',projectRoot,sessionId,
      pluginVersion:artifactManifest.version,workflow:workflow.flow.displayName,openSpecVersion:spec.version,
      proposalRequests:bound,requests:0,wireBlocked:true,registeredTools:artifactManifest.contracts.tools });
  } else await runBusinessWorkflow();

  async function runBusinessWorkflow() {
    const [{ findTask } = {}, { listNativeRuns } = {}, { createStopCorrectionStore } = {}] = rcEnabled ? await Promise.all([
      loadPackaged(artifact,'lib/runtime-v2/task-store.mjs'),loadPackaged(artifact,'lib/openclaw/native-runs.mjs'),
      loadPackaged(artifact,'lib/runtime-v2/stop-correction-store.mjs'),
    ]) : [];
    const state = gateway.runtime.state.resolveStateDir();
    const postRoot = path.join(state,'runtime-corrector-stop-sessions/post-run');
    const store = createStopCorrectionStore?.({directory:path.join(state,'runtime-corrector-stop-sessions')});
    const turns = [];
    const docNames = ['proposal.md','design.md','tasks.md'];
    const change = path.join(projectRoot,'openspec','changes',changeName);
    const runStage = async (stage, message = messages[stage], {
      runId = randomUUID(), proposalSourceRunId = runId, validationRepair = false, transportRecovery = false, checklistRepair = false,
    } = {}) => {
      if (Date.now() >= deadline || gateway.providerStatus().failure) return null;
      const turnStartedAt = Date.now(), tracker = createBusinessRunTracker(runId, sessionId);
      const observer = createBusinessTerminalObserver();
      gateway.setPhase(validationRepair ? 'business-proposal-validation-repair'
        : checklistRepair ? 'business-apply-checklist-repair'
        : transportRecovery ? `business-${stage === 'proposal' ? 'proposal' : 'apply'}-transport-recovery` : 'business-'+stage);
      let terminal, originalTerminal, post, settled = false;
      const original = createBusinessTerminalObserver();
      const markApplyRun = stage === 'codeing' && applyVerificationRunFile;
      const proposalPreparation = stage === 'proposal' && proposalReviewInput ? await prepareNativeOpenSpecProposal({
        request: gateway.request, sessionKey, sessionId, runId, sourceRunId: proposalSourceRunId, changeName, deadlineAt: deadline,
        ...proposalReviewInput,
      }) : null;
      if (proposalPreparation && proposalPreparation.status !== 'PREPARED') {
        const turn = { stage, runId, finalRunId: runId, startedAt: turnStartedAt, finishedAt: Date.now(),
          settled: false, openSpec: null, proposalPreparation };
        turns.push(turn);
        return turn;
      }
      if (markApplyRun) await write(applyVerificationRunFile, { runId, sessionKey });
      try {
        await gateway.request('chat.send', openSpecBusinessInput({ sessionKey, sessionId, runId, message },
          { validationRepair, transportRecovery, checklistRepair }));
        while (Date.now() < deadline && !gateway.providerStatus().failure) {
          await gateway.drain();
          const entry = () => gateway.runtime.agent.session.getSessionEntry({ ...scope,readConsistency:'latest' });
          let latest = await entry();
          // The host rewrites its session store at run end; one missing read is not yet a replacement.
          if (!latest) { await sleep(650); latest = await entry(); }
          try { assertBusinessSessionIdentity({sessionId,sessionKey,runId},latest,gateway.metrics().modelStarts); }
          catch (error) {
            if (error.code==='ARKTS_SESSION_IDENTITY_DRIFT') await write(path.join(outputRoot,'session-identity-drift.json'),{stage,...error.evidence});
            throw error;
          }
          let privateRuns = [], verification;
          if (rcEnabled) {
            post = undefined;
            const posts = await findFiles(postRoot,file=>file.endsWith('.json'));
            for (const file of posts) {
              const value = await read(file);
              if (value.sessionId===sessionId && (value.runId===runId || value.completedRuns?.includes(runId))) post=value;
            }
            tracker.observe(post);
            const task = await findTask({projectRoot,sessionId});
            if (task) privateRuns = await listNativeRuns(projectRoot,task.taskId);
            verification = task?.verification;
          }
          const starts=()=>gateway.metrics().modelStarts;
          originalTerminal = await original.poll(gateway.request,runId,starts,post?.phase ?? 'OBSERVE');
          terminal = tracker.runId===runId ? originalTerminal
            : await observer.poll(gateway.request,tracker.runId,starts,post?.phase);
          for (const event of [...original.drainEvents(), ...observer.drainEvents()])
            await fs.appendFile(path.join(outputRoot,'business-terminal-observations.jsonl'), JSON.stringify({stage,...event})+'\n');
          if (!paired) {
            originalTerminal = await completedBusinessTerminal(originalTerminal);
            terminal = await completedBusinessTerminal(terminal);
          }
          if (terminal && privateRuns.every(worker => worker.status === 'SETTLED')) {
            const directProposal = rcEnabled && paired && stage === 'proposal' && !post && businessCompleted(terminal, runId)
              && directProposalStopSettled(await readNativeStopRecords({ projectRoot, sessionKey, sessionId }),
                { sessionKey, sessionId, runId, verification });
            if (!rcEnabled || ['IDLE','CLOSED'].includes(post?.phase) || directProposal) {
              settled = true;
              break;
            }
          }
          await sleep(650);
        }
      } finally {
        if (markApplyRun) await fs.rm(applyVerificationRunFile, { force: true });
      }
      const inspectedOpenSpec = paired && settled && businessCompleted(terminal, tracker.runId) && Date.now() < deadline
        ? await readOpenSpecCheckpoint(spec.options, changeName, { deadlineAt: deadline }) : null;
      const finishedAt = Date.now();
      const openSpec = finishedAt < deadline ? inspectedOpenSpec : null;
      const turn = {stage,runId,startedAt:turnStartedAt,finishedAt,finalRunId:tracker.runId,
        originalTerminal,terminal,post:post ?? null, ...(paired ? { settled, openSpec } : {}),
        ...(proposalPreparation ? { proposalPreparation } : {}),
        ...(transportRecovery ? { transportRecovery: true } : {}),
        ...(checklistRepair ? { checklistRepair: true } : {}),
        ...(validationRepair ? { validationRepair: true, validationRepairPromptSha256: digest(message) } : {}) };
      turns.push(turn);
      return turn;
    };
    const completeTurn = turn => Boolean(turn && businessCompleted(turn.terminal,turn.finalRunId));
    const captureProposal = (turn, stopReason) => captureBusinessCheckpoint({ outputRoot, projectRoot, preparedHead, sessionId,
      runId: turn.finalRunId, stopReason, success: completeTurn(turn), includeBusinessPatch: true,
      proposalRepairChange: changeName, requireProposalPolicy: rcEnabled });
    const canContinue = () => Date.now() < deadline && !gateway.providerStatus().failure;
    async function findTransportInterruption(turn) {
      if (!paired || !turn?.settled || turn.runId !== turn.finalRunId || turn.terminal?.status !== 'error' || !canContinue()) return null;
      await gateway.drain();
      const assistantError = await fs.readFile(transcriptFile, 'utf8').then(bytes => retainedBusinessTransportError(jsonl(bytes),
        { runId: turn.runId, sessionId })).catch(() => null);
      const failure = assistantError && gateway.businessTransportFailure({
        runId: turn.runId, sessionId, sessionKey, terminal: turn.terminal, assistantError,
      });
      if (!failure) return null;
      const stops = rcEnabled ? await readNativeStopRecords({ projectRoot, sessionKey, sessionId }) : [];
      const ledger = await store?.inspect(sessionId);
      return !ledger?.used && !stops.some(row => row.status !== 'SETTLED' || row.runId === turn.runId)
        ? { failure, ...(assistantError.retainedTextBytes ? { retainedTextBytes: assistantError.retainedTextBytes } : {}) } : null;
    }
    const firstProposal = await runStage('proposal');
    const proposalInterruption = await findTransportInterruption(firstProposal);
    const interruption = proposalInterruption && canContinue()
      ? { ...proposalInterruption, checkpoint: await readOpenSpecCheckpoint(spec.options, changeName, { deadlineAt: deadline }) } : null;
    const { proposal, proposalCheckpoint, proposalScope, proposalRepair, repairScopePreserved, readyToApply } =
      await settleOpenSpecProposal(firstProposal, { changeName, capture: captureProposal, interruption, canRetry: canContinue,
        retry: (repair, { transportInterrupted }) => runStage('proposal', repair,
          { proposalSourceRunId: firstProposal.runId, validationRepair: !transportInterrupted, transportRecovery: transportInterrupted }) });
    const approvedWorkflowAvailable = proposalCheckpoint?.proposalRepairScope?.complete === true;
    const approval = paired && rcEnabled && readyToApply && approvedWorkflowAvailable
      ? await pinOpenSpecApplyChecklist({ projectRoot, changeName, proposal, proposalCheckpoint }) : null;
    const applyReady = completeTurn(proposal) && !gateway.providerStatus().failure && (paired ? readyToApply && approvedWorkflowAvailable
      : (await Promise.all(docNames.map(file=>fs.stat(path.join(change,file)).then(stat=>stat.isFile(),()=>false)))).every(Boolean));
    let nativeApplyApproval = null;
    if (nativeOpenSpecApproval) {
      nativeApplyApproval = { status: 'NOT_ATTEMPTED' };
      if (applyReady && canContinue()) {
        const proposalRunId = proposal.finalRunId, applyRunId = randomUUID();
        let requiredAtoms;
        if (proposalInventory) {
          try {
            requiredAtoms = bindOpenSpecRequirementInventory(proposalInventory, { publicInputSha256,
              problemStatement: publicInput.problem_statement, proposalMessage: messages.proposal, proposalRunId: firstProposal.runId,
              sessionId, records: jsonl(await fs.readFile(transcriptFile, 'utf8')) });
          } catch {
            nativeApplyApproval = { status: 'UNVERIFIED', step: 'source-binding', sessionId, sessionKey, changeName, proposalRunId, applyRunId };
          }
        }
        if (nativeApplyApproval.status !== 'UNVERIFIED') nativeApplyApproval = await armNativeOpenSpecApply({ request: gateway.request,
          sessionKey, sessionId, proposalRunId, applyRunId, changeName, proposalCheckpoint,
          taskCount: proposal.openSpec.apply.value.progress.total, deadlineAt: deadline, requiredAtoms });
      }
    }
    const firstApply = applyReady && (!nativeOpenSpecApproval || nativeApplyApproval.status === 'ARMED')
      ? await runStage('codeing', undefined, { runId: nativeApplyApproval?.applyRunId }) : null;
    let codeing = firstApply, applyTransportRecovery = null;
    const applyInterruption = await findTransportInterruption(firstApply);
    if (applyInterruption) {
      const progress = await readOpenSpecCheckpoint(spec.options, changeName, { deadlineAt: deadline });
      if (compareOpenSpecApplyProgress(proposal.openSpec, progress, changeName) === true && Date.now() < deadline) {
        const before = await captureProposal(firstApply, 'openspec_apply_transport_before');
        if (sameApplyRecoveryScope(proposalCheckpoint?.proposalRepairScope, before.proposalRepairScope) && Date.now() < deadline) {
          const message = openSpecApplyRecoveryPrompt(changeName);
          const source = { ...applyInterruption, sourceRunId: firstApply.runId, checkpointSha256: before.patchSha256,
            businessPatchSha256: before.businessPatchSha256, promptSha256: digest(message) };
          await write(path.join(outputRoot, 'openspec-apply-transport-recovery.json'), source);
          const retry = await runStage('codeing', message, { transportRecovery: true });
          if (retry) codeing = retry;
          const after = retry?.openSpec && await captureProposal(retry, 'openspec_apply_transport_after');
          const verified = Boolean(after && after.success && Date.now() < deadline
            && compareOpenSpecApplyProgress(progress, retry.openSpec, changeName) === true
            && sameApplyRecoveryScope(before.proposalRepairScope, after.proposalRepairScope));
          applyTransportRecovery = { ...source, retryRunId: retry?.runId ?? null, afterCheckpointSha256: after?.patchSha256 ?? null, verified };
        }
      }
    }
    const { apply, applyChecklistCorrection } = await settleOpenSpecApplyChecklist(codeing, { approval, changeName, canRetry: canContinue,
      capture: captureProposal, retry: instruction => runStage('codeing', instruction, { checklistRepair: true }) });
    codeing = apply;
    // Closing the Gateway cancels unsettled native Stop jobs, and the freeze
    // commit below would move HEAD under a review that is still reading it.
    const nativeStop = rcEnabled ? await waitNativeStopSettled({projectRoot,sessionKey,sessionId,deadlineAt:deadline,beforePoll:()=>gateway.drain(),
      abandon:()=>Boolean(gateway.providerStatus().failure),readVerification:async()=>(await findTask({projectRoot,sessionId}))?.verification??null})
      : { nativeStopSettled: null, nativeStopRecords: [] };
    const ledger = await store?.inspect(sessionId);
    const nativeApplyVerdict = nativeApplyApproval?.status === 'ARMED'
      ? observeNativeOpenSpecApply(nativeApplyApproval, await readNativeStopRecords({ projectRoot, sessionKey, sessionId }),
        { finalRunId: codeing?.finalRunId, ledger, projectRoot }) : null;
    const boundary = gateway.providerStatus();
    const final = turns.at(-1), approvedPlan = proposal?.openSpec ?? null, finalApply = codeing?.openSpec ?? null;
    const finalApplyCheckpoint = paired && readyToApply && finalApply && nativeStop.nativeStopSettled !== false
      && turns.every(turn => turn.settled) && completeTurn(codeing)
      ? await captureProposal(codeing, 'openspec_apply_boundary').catch(() => null) : null;
    const openSpec = paired ? { proposal: approvedPlan, codeing: finalApply, proposalScope,
      applyChecklistPreserved: compareOpenSpecApplyProgress(approvedPlan, finalApply, changeName),
      applyWorkflowScope: compareOpenSpecApplyScope(proposalCheckpoint, finalApplyCheckpoint, {
        changeName, sessionId, preparedHead, proposalRunId: proposal?.finalRunId, applyRunId: codeing?.finalRunId,
      }),
      ...(nativeOpenSpecApproval ? { nativeApplyApproval, nativeApplyVerdict } : {}),
      ...(applyChecklistCorrection ? { applyChecklistCorrection } : {}),
      ...(proposalRepair ? { proposalRepair } : {}), ...(applyTransportRecovery ? { applyTransportRecovery } : {}) } : null;
    const nativeInventoryFailure = proposalInventory && codeing && nativeApplyVerdict?.inventory?.status !== 'OBSERVED'
      ? 'NATIVE_OPENSPEC_INVENTORY_STOP_UNVERIFIED' : null;
    const pairedWorkflowFailure = paired ? pairedBusinessWorkflowFailure(final, openSpec) ?? nativeInventoryFailure : null;
    const frameworkError = Boolean(boundary.failure && boundary.failure!=='PROFILE_RATE_LIMIT' && boundary.failure!=='PROFILE_PAIR_RATE_LIMIT');
    const workflowComplete = Boolean(proposal && codeing) && turns.every(turn => completeTurn(turn)
      || turn === firstProposal && proposalRepair?.transportVerified === true
      || turn === firstApply && applyTransportRecovery?.verified === true)
      && (!paired || !boundary.failure && repairScopePreserved && pairedWorkflowFailure === null);
    const requiredLint = lintRequirement && workflowComplete && codeing.settled && nativeStop.nativeStopSettled !== false
      ? await runArktsRequiredLint({ projectRoot, toolRoot: args['tool-root'], javaHome: java.javaHome,
        outputRoot, requirement: lintRequirement, timeoutMs: Math.min(120_000, deadline - Date.now()) }) : null;
    const businessNatural = workflowComplete && (!lintRequirement || requiredLint?.success === true);
    const pairedCompletedInBudget = paired && businessNatural && nativeStop.nativeStopSettled !== false;
    const stateName = boundary.failure?.includes('RATE_LIMIT') ? 'rate-limited' : frameworkError ? 'framework-error'
      : Date.now() >= deadline && !pairedCompletedInBudget ? 'timed-out' : 'finished';
    const publicAcceptancePin = publicAcceptance && { sha256: publicAcceptance.sha256, testIds: publicAcceptance.testIds,
      ...(publicAcceptance.requirementBindings ? { requirementBindings: publicAcceptance.requirementBindings } : {}) };
    const identity = { instance, projectRoot, sessionId, sessionKey, rcEnabled, publicInputSha256, preparedTree, packageSha256,
      providerIdentity: gateway.providerIdentity, ...(paired ? { openSpec } : {}),
      ...(proposalInventory ? { openSpecRequirementInventorySha256: inventorySha256 } : {}),
      ...(publicAcceptancePin ? { publicAcceptancePin } : {}),
      ...(lintRequirement ? { requiredChecks: { lint: requiredLint } } : {}) };
    const repairScopeChanged = proposalRepair?.scopeUnchanged === false || proposalRepair?.businessUnchanged === false || proposalRepair?.checklistUnchanged === false;
    const planRepairFailure = repairScopeChanged ? 'OPENSPEC_PROPOSAL_REPAIR_SCOPE_CHANGED'
      : proposalRepair?.beforeScope?.complete === false ? 'OPENSPEC_PROPOSAL_REPAIR_SCOPE_UNVERIFIED'
      : null;
    const proposalScopeFailure = proposalScope?.status === 'VIOLATED' ? 'OPENSPEC_PROPOSAL_STAGE_INTEGRITY_CHANGED'
      : paired && openSpec.proposal?.readyToApply === true && (proposalScope?.status !== 'PASS' || !approvedWorkflowAvailable)
        ? 'OPENSPEC_PROPOSAL_SCOPE_UNVERIFIED'
      : null;
    const workflowFailure = pairedWorkflowFailure !== 'OPENSPEC_APPLY_WORKFLOW_CHANGED' && !pairedWorkflowFailure?.startsWith('OPENSPEC_APPLY_CHECKLIST_')
      && applyTransportRecovery?.retryRunId && completeTurn(codeing) && !applyTransportRecovery.verified
      ? 'OPENSPEC_APPLY_RECOVERY_SCOPE_UNVERIFIED' : pairedWorkflowFailure;
    const nativeApplyApprovalFailure = nativeApplyApproval?.status === 'UNVERIFIED' ? 'NATIVE_OPENSPEC_APPLY_ARM_UNVERIFIED' : null;
    const proposalPreparationFailure = turns.some(turn => turn.proposalPreparation?.status === 'UNVERIFIED')
      ? 'NATIVE_OPENSPEC_PROPOSAL_PREPARE_UNVERIFIED' : null;
    const lintFailure = lintRequirement && !requiredLint?.success ? requiredLint?.reason ?? 'REQUIRED_LINT_UNAVAILABLE' : null;
    const reason = boundary.failure ?? proposalPreparationFailure ?? planRepairFailure ?? proposalScopeFailure ?? nativeApplyApprovalFailure
      ?? workflowFailure ?? lintFailure ?? final?.post?.reason ?? null;
    if (paired && (!turns.length || nativeStop.nativeStopSettled === false || turns.some(turn => !turn.settled))) {
      // Closing the actual Gateway in finally fences late writes. An active
      // workspace has no sealable candidate and must not be sent to grading.
      await write(path.join(outputRoot,'result.json'), { ...identity, state: stateName, reason, frameworkError, businessNatural: false,
        elapsedMs: Date.now()-startedAt, turns, ...nativeStop, frozen: null, modelRequests: boundary.requests, gateway: gateway.metrics() });
      return;
    }
    const task = await findTask?.({projectRoot,sessionId});
    const session = await gateway.runtime.subagent.getSession({sessionKey});
    const bytes = await fs.readFile(transcriptFile);
    const records = jsonl(bytes.toString('utf8'));
    const frozenRoot = path.join(outputRoot,'freeze');
    await fs.mkdir(frozenRoot);
    const observedPaths = new Set(businessMutationPaths(records,projectRoot));
    const changeFiles = await findFiles(change,()=>true);
    for (const file of changeFiles) observedPaths.add(path.relative(projectRoot,file).replaceAll('\\','/'));
    const paths = await sealableMutationPaths({ projectRoot, paths: [...observedPaths].filter(file => !paired || isArktsCheckpointPath(file)),
      trackedPaths: git(projectRoot,'ls-files','--cached','-z').toString().split('\0') });
    if (paths.length) git(projectRoot,'--literal-pathspecs','add','--all','--',...paths);
    commit(projectRoot,'Freeze release end-to-end result');
    const head=git(projectRoot,'rev-parse','HEAD').toString().trim();
    const workspacePatch = git(projectRoot,'diff','--binary',preparedHead,head);
    const patch = paired ? git(projectRoot,'diff','--binary',preparedHead,head,'--',...arktsBusinessDiffScope) : workspacePatch;
    await fs.writeFile(path.join(frozenRoot,'session.jsonl'),bytes,{flag:'wx'});
    await fs.writeFile(path.join(frozenRoot,'candidate.patch'),patch,{flag:'wx'});
    if (paired) await fs.writeFile(path.join(frozenRoot,'workspace.patch'),workspacePatch,{flag:'wx'});
    const frozen = {commit:head,commitSha256:digest(git(projectRoot,'cat-file','commit',head)),
      sessionSha256:digest(bytes),patchSha256:digest(patch),preparedHead,mutationPaths:paths,
      ...(paired ? { workspacePatchSha256: digest(workspacePatch) } : {})};
    await write(path.join(frozenRoot,'freeze.json'),frozen);
    const evidence = await collectReleaseEvidence({projectRoot,sessionId,nativeRoot:gateway.root,turns,
      includePublicAcceptance: Boolean(rcEnabled && publicAcceptance)});
    const documents = rcEnabled ? await collectAutomaticDocumentEvidence(projectRoot,session,sessionId) : { reviews: [], receipts: [] };
    const scopeIds = [...new Set([task?.taskId,...evidence.taskIds,...documents.reviews.map(review=>review.scopeTaskId)].filter(Boolean))];
    const privateRuns = [...new Map((await Promise.all(scopeIds.map(id=>listNativeRuns(projectRoot,id)))).flat().map(run=>[run.runId,run])).values()];
    const docRuns = privateRuns.filter(run=>run.role==='artifact-reviewer');
    const stopRuns = privateRuns.filter(run=>run.role==='stop-reviewer');
    const [documentCost,stopCost] = await Promise.all([
      measureSimplifyBenchmark({nativeRoot:gateway.root,privateRuns:docRuns}),
      measureSimplifyBenchmark({nativeRoot:gateway.root,privateRuns:stopRuns,ledger}),
    ]);
    const businessUsage = summarizeProviderUsage(Math.max(0,boundary.requests-documentCost.usage.observedCalls-stopCost.usage.observedCalls),
      records.filter(row=>row.message?.role==='assistant').map(row=>row.message.usage));
    const finalStops = Object.values(ledger?.stops ?? {}).filter(stop=>stop.id.startsWith(final?.runId ?? 'missing:'));
    const firstStop = finalStops[0], admission = ledger?.admissions?.[firstStop?.admissionId];
    const finalStop = finalStopOf(evidence.stopReviews,turns);
    const stopSettled = rcEnabled ? Boolean(finalStop && ['PASS','NO_DEVIATION_FOUND','DEVIATION'].includes(finalStop.status)
      || finalStop?.status==='SKIPPED' && finalStop.reasonCode==='STOP_DOCUMENT_ONLY_CHANGES') : null;
    const docs = Object.fromEntries(await Promise.all(docNames.map(async file=>[file,
      await fs.readFile(path.join(change,file)).then(data=>({sha256:digest(data),bytes:data.length}),error=>{if(error.code==='ENOENT')return null;throw error;})])));
    const reviewedFiles = new Set(documents.reviews.map(item => item.result.metadata.triggerFile));
    const currentDocumentHashes = new Map();
    for (const file of changeFiles) {
      const relative = path.relative(projectRoot,file).replaceAll('\\','/');
      if (reviewedFiles.has(relative)) currentDocumentHashes.set(relative, digest(await fs.readFile(file)));
    }
    const documentFeedback=documents.reviews.map((item,index)=>{
      const meta=item.result.metadata;
      const relative=meta.triggerFile;
      const receipt=documents.receipts.find(row=>row.toolCallId===item.toolCallId);
      const native=docRuns.find(run=>run.sessionId===meta.semanticReview?.forkSessionId);
      const firstHash=meta.inputs?.find(input=>input.path===relative)?.sha256;
      const next=documents.reviews.slice(index+1).find(row=>row.result.metadata.triggerFile===relative
        && row.result.metadata.inputs?.some(input=>input.path===relative&&input.sha256!==firstHash));
      const finalHash = currentDocumentHashes.get(relative);
      const changedAfterFeedback=receipt && firstHash && (next || finalHash) ? Boolean(next || finalHash!==firstHash) : null;
      return {result:item.result,relative,file:item.file,toolCallId:item.toolCallId,
        semanticMs:native?.startedAt&&native?.settledAt ? native.settledAt-native.startedAt : null,
        feedback:receipt ? redactEvaluationText(receipt.text) : null,changedAfterFeedback,
        laterRound:next?.result.metadata.roundId??null,laterStatus:next?.result.status??null};
    });
    const timings = await readProviderTiming(gateway.root);
    await write(path.join(outputRoot,'result.json'),{
      ...identity, state:stateName, reason, frameworkError,
      elapsedMs:Date.now()-startedAt,businessNatural,turns,documents:docs,documentReviews:evidence.documentReviews,documentFeedback,
      stopReviews:evidence.stopReviews,materialBasis:evidence.materialBasis,evidenceCounts:evidence.counts,finalStop,
      codeChanged:codeChanged(frozen.mutationPaths),documentCost,
      firstStop:firstStop??null,admission:admission??null,stopSettled,stopCost,corrections:ledger?.used??0,...nativeStop,
      stopFeedback:admission?.hostRequest?.gate ? redactEvaluationText((admission.currentDeviations??[]).map(item=>
        [item.result?.reason,...(item.result?.evidence??[])].join('\n')).join('\n\n')) : null,
      frozen,privateRuns,modelRequests:boundary.requests,businessUsage,
      tokenSplit:tokenSplit({documentCost,stopCost,businessUsage}),
      requestTimingCount:timings.filter(row=>row.event==='request').length,gateway:gateway.metrics(),
    });
  }
} catch (error) {
  throw new Error(redactEvaluationText(error.message));
} finally {
  await gateway?.close();
}

// The isolated host may retain singleton timers after its close and provider teardown.
process.exit(0);
