
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { digest } from './arkts-dataset.mjs';
import { businessCompleted, knownBusinessTerminal } from './business-completion.mjs';
import { sameProposalRepairScope } from './business-checkpoint.mjs';
import { loadPackaged } from '../helpers/simplify-native-evaluation.mjs';
import { applyRcConfigOverrides, emitSimpleYaml, regressionCheckPolicy } from './rc-config-overrides.mjs';
import { parseSimpleYaml } from '../../lib/simple-yaml.mjs';

const run = promisify(execFile);
const save = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const officialOpenSpecCliSha256 = 'ca136f0e9fd4951dcf93d8ed729ebc97b2d97d3980cd9dc9d42fc80e32e797c6';
const strictChangeArgs = changeName => ['validate', changeName, '--type', 'change', '--strict', '--json'];

export async function loadOriginalBasisWorkflow(root, hostRoot, pinned, { openspecCli } = {}) {
  const official = openspecCli !== undefined;
  const cli = official ? await fs.realpath(openspecCli) : path.join(root, 'cli/bin/openspec.js');
  const pluginRoot = path.join(root, 'sdd-workflow-tool');
  const files = {
    workflow: path.join(root, 'workflow.yaml'),
    cli,
    ...(official ? { cliManifest: path.join(path.dirname(cli), '..', 'package.json') } : {
      archive: path.join(root, 'fission-ai-openspec-1.4.1.tgz'),
      install: path.join(root, 'installPkg.js'),
      pluginManifest: path.join(pluginRoot, 'openclaw.plugin.json'),
      pluginEntry: path.join(pluginRoot, 'dist/index.js'),
    }),
  };
  const bytes = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([key, file]) => [key, await fs.readFile(file)])));
  const digests = Object.fromEntries(Object.entries(bytes).map(([key, value]) => [key, digest(value)]));
  const identity = { mode: official ? 'official-openspec' : 'matrixassistant', cliVersion: pinned.cliVersion, files: digests };
  if (official) {
    assert.equal(digests.workflow, pinned.files.workflow, 'The OpenSpec workflow differs from the archived definition');
    assert.equal(digests.cli, officialOpenSpecCliSha256, 'The OpenSpec CLI entry differs from the published 1.4.1 entry');
    const pkg = JSON.parse(bytes.cliManifest);
    assert.equal(pkg.name, '@fission-ai/openspec');
    assert.equal(pkg.version, '1.4.1');
    assert.equal(pkg.version, pinned.cliVersion);
    assert.equal(typeof pkg.bin?.openspec, 'string');
    assert.equal(path.resolve(path.dirname(files.cliManifest), pkg.bin.openspec), cli);
  } else assert.deepEqual(digests, pinned.files);
  const { parse } = createRequire(path.join(hostRoot, 'package.json'))('yaml');
  const flow = parse(bytes.workflow.toString('utf8'));
  assert.equal(flow.displayName, 'OpenSpec(solo)');
  assert.equal(flow.sessionInit.trim().replace(/\s+/gu, ' '), 'openspec init --tools opencode --force');
  assert.deepEqual(flow.stages.map(stage => stage.id), ['proposal', 'design', 'tasks', 'codeing', 'archive']);
  if (official) return { flow, cli, plugin: null, identity };
  const plugin = JSON.parse(bytes.pluginManifest);
  assert.equal(plugin.id, 'sdd-workflow-tool');
  assert.equal(plugin.version, pinned.pluginVersion);
  return { flow, cli, identity, plugin: { id: plugin.id, path: pluginRoot, config: { workflows: flow.modelTool?.enabled ? [{
    flowId: 'openspec-solo', displayName: flow.displayName, description: flow.modelTool.description ?? '',
    sessionInit: flow.sessionInit, placeholder: flow.placeholder ?? '', firstStageId: 'proposal', firstStagePrompts: [flow.stages[0].prompt],
  }] : [] } } };
}

// Experiment overrides are merged after the release flags; the release
// invariants asserted below still hold for every arm.
export async function installOriginalBasisPolicy({ artifact, projectRoot, outputRoot, overrides = null, variables = {}, reviewerModelRef }) {
  const policyRoot = path.join(projectRoot, '.runtime-corrector');
  const templateRoot = path.join(artifact, '.runtime-corrector-default');
  const template = await fs.readFile(path.join(templateRoot, 'config.yaml'), 'utf8');
  const released = template.replace(/^enabled: false$/mu, 'enabled: true')
    .replace(/(^sessionDefaults:\r?\n(?:  #[^\r\n]*\r?\n)*)  enabled: false$/mu, '$1  enabled: true');
  assert.equal(released.replace(/^enabled: true$/mu, 'enabled: false')
    .replace(/(^sessionDefaults:\r?\n(?:  #[^\r\n]*\r?\n)*)  enabled: true$/mu, '$1  enabled: false'), template);
  assert.notEqual(released, template);
  const { text, applied } = applyRcConfigOverrides(released, overrides, variables);
  const source = parseSimpleYaml(text);
  const configuredModelRef = source.reviewers?.defaults?.model;
  const expectedReviewerModel = reviewerModelRef ?? configuredModelRef;
  assert(typeof expectedReviewerModel === 'string' && expectedReviewerModel.trim() === expectedReviewerModel
    && expectedReviewerModel.length > 0, 'The benchmark reviewer needs an explicit OpenClaw model reference.');
  const changedModel = expectedReviewerModel !== configuredModelRef;
  if (changedModel) source.reviewers = { ...source.reviewers,
    defaults: { ...source.reviewers?.defaults, model: expectedReviewerModel } };
  const configured = changedModel ? emitSimpleYaml(source) : text;
  await fs.mkdir(policyRoot);
  for (const file of ['README.md', 'example.reviewer.md', 'example.rules.yaml', 'config.reference.yaml'])
    await fs.copyFile(path.join(templateRoot, file), path.join(policyRoot, file));
  await fs.writeFile(path.join(policyRoot, 'config.yaml'), configured, { flag: 'wx' });
  await fs.writeFile(path.join(outputRoot, 'project-config.yaml'), configured, { flag: 'wx' });
  const { loadConfig } = await loadPackaged(artifact, 'lib/runtime-corrector.mjs');
  const { loadProjectPolicySource } = await loadPackaged(artifact, 'lib/policy/project-policy.mjs');
  const loaded = await loadConfig({ cwd: projectRoot, pluginRoot: artifact });
  const raw = await loadProjectPolicySource(projectRoot);
  const effective = loaded.runtimeV2;
  assert.equal(raw.enabled, true);
  assert.equal(raw.sessionDefaults.enabled, true);
  assert.equal(raw.reviewers.defaults.model, expectedReviewerModel);
  for (const role of ['artifactReviewer', 'stopReviewer']) {
    const reviewer = effective.reviewers[role];
    assert.equal(reviewer.model, expectedReviewerModel, `Benchmark ${role} must use the requested reviewer model.`);
    assert.notEqual(reviewer.session, 'independent', `Benchmark ${role} must use the selected OpenClaw provider model.`);
  }
  const artifactOverride = applied?.value?.artifactCorrection;
  const strictProposal = artifactOverride?.requireOpenSpecProposalCoverage === true;
  assert.deepEqual(effective.artifactCorrection, {
    originalRequirementsEnabled: strictProposal || (artifactOverride?.originalRequirementsEnabled ?? true),
    groundTruthReviewEnabled: false, stageMetricsEnabled: false,
    ...(strictProposal ? { requireOpenSpecProposalCoverage: true } : {}),
  });
  assert.equal(effective.stopCorrection.enabled, true);
  assert.equal(effective.stopCorrection.originalRequirementsBasis, true);
  assert.equal(effective.stopCorrection.deviationOnly, true);
  assert.equal(effective.dynamicGroundTruth.enabled, false);
  assert.equal(effective.implementationCorrection.enabled, false);
  assert.equal(effective.skillCorrection.enabled, false);
  assert.notEqual(effective.compactionRestore?.enabled, true);
  const evidence = { templateSha256: digest(template), configuredSha256: digest(configured),
    overrides: { enabled: true, 'sessionDefaults.enabled': true,
      ...(changedModel ? { 'reviewers.defaults.model': expectedReviewerModel } : {}) }, experimentOverrides: applied, runtimeV2: effective,
    regressionCheck: regressionCheckPolicy(applied && source.stopCorrection?.regressionCheck, effective.stopCorrection.regressionCheck) };
  await save(path.join(outputRoot, 'effective-policy.json'), evidence);
  return evidence;
}

export async function runOpenSpecCli({ cli, projectRoot, cliState }, args, signal) {
  const env = { ...process.env, APPDATA: cliState, XDG_CONFIG_HOME: cliState, OPENSPEC_TELEMETRY: '0', DO_NOT_TRACK: '1' };
  for (const key of Object.keys(env)) if (/(?:TOKEN|SECRET|API_KEY|PASSWORD|AUTH_TOKEN)/iu.test(key)) delete env[key];
  return run(process.execPath, [cli, ...args], { cwd: projectRoot, env, signal, windowsHide: true, timeout: 90_000, maxBuffer: 2 * 1024 * 1024 });
}

function completePlanningArtifacts(status, changeName) {
  const artifacts = status?.value?.artifacts;
  return status?.exitCode === 0 && status.value?.changeName === changeName && status.value?.isComplete === true
    && Array.isArray(artifacts) && ['proposal', 'specs', 'design', 'tasks'].every(id => artifacts.some(item => item?.id === id && item.status === 'done'));
}

function verifiedTaskProgress(apply, changeName) {
  const progress = apply?.value?.progress;
  return apply?.exitCode === 0 && apply.value?.changeName === changeName
    && [progress?.total, progress?.complete, progress?.remaining].every(value => Number.isSafeInteger(value) && value >= 0)
    && progress.total > 0 && progress.total === progress.complete + progress.remaining ? progress : null;
}

function strictChangeReport(validation, changeName) {
  const reports = validation?.value?.items;
  return Array.isArray(reports) && reports.length === 1 && reports[0]?.id === changeName && reports[0]?.type === 'change'
    ? reports[0] : null;
}

export async function readOpenSpecCheckpoint(options, changeName, { deadlineAt, invoke = runOpenSpecCli } = {}) {
  const signal = deadlineAt === undefined ? undefined : AbortSignal.timeout(Math.max(1, deadlineAt - Date.now()));
  const json = async args => {
    let stdout, exitCode = 0;
    try { ({ stdout } = await invoke(options, args, signal)); }
    catch (error) { stdout = error.stdout; exitCode = Number.isInteger(error.code) ? error.code : null; }
    try { return { exitCode, value: JSON.parse(stdout) }; }
    catch { return { exitCode, value: null }; }
  };
  const status = await json(['status', '--change', changeName, '--json']);
  const apply = await json(['instructions', 'apply', '--change', changeName, '--json']);
  const validation = await json(strictChangeArgs(changeName));
  const progress = verifiedTaskProgress(apply, changeName);
  const planVerified = completePlanningArtifacts(status, changeName) && validation.exitCode === 0
    && strictChangeReport(validation, changeName)?.valid === true;
  return { changeName, planVerified, readyToApply: planVerified && progress !== null && apply.value.state === 'ready' && progress.remaining > 0,
    applyComplete: planVerified && progress !== null && apply.value.state === 'all_done' && progress.remaining === 0,
    checkedAt: new Date().toISOString(), status, apply, validation };
}

export function openSpecProposalScope(checkpoint, changeName, businessCheckpoint) {
  const businessPatchSha256 = businessCheckpoint?.businessPatchSha256 ?? null;
  const progress = verifiedTaskProgress(checkpoint?.apply, changeName);
  const tasks = checkpoint?.apply?.value?.tasks;
  const taskListVerified = Boolean(progress && Array.isArray(tasks) && tasks.length === progress.total
    && tasks.every(task => typeof task?.done === 'boolean') && tasks.filter(task => task.done).length === progress.complete);
  const businessChanged = /^[a-f0-9]{64}$/u.test(businessPatchSha256 ?? '')
    ? businessPatchSha256 !== digest('') : null;
  const completedTasks = taskListVerified ? progress.complete : null;
  const status = businessChanged === true || completedTasks > 0 ? 'VIOLATED'
    : businessChanged === false && completedTasks === 0 ? 'PASS' : 'UNVERIFIED';
  return { status, businessChanged, businessPatchSha256, completedTasks };
}

export function compareOpenSpecApplyProgress(before, after, changeName) {
  const tasksOf = checkpoint => {
    if (!changeName || checkpoint?.changeName !== changeName || checkpoint.planVerified !== true) return null;
    const progress = verifiedTaskProgress(checkpoint.apply, changeName), tasks = checkpoint.apply?.value?.tasks;
    if (!progress || checkpoint.readyToApply !== (progress.remaining > 0) || checkpoint.applyComplete !== (progress.remaining === 0)
      || !Array.isArray(tasks) || tasks.length !== progress.total
      || tasks.some(task => typeof task?.id !== 'string' || !task.id || typeof task.done !== 'boolean'
        || typeof task.description !== 'string' || !task.description.trim())
      || tasks.filter(task => task.done).length !== progress.complete
      || new Set(tasks.map(task => task.id)).size !== tasks.length) return null;
    return tasks;
  };
  const prior = tasksOf(before), current = tasksOf(after);
  if (!prior || !current) return null;
  return prior.length === current.length
    && prior.every((task, index) => task.id === current[index].id && task.description === current[index].description
      && (!task.done || current[index].done));
}

export function openSpecApplyRecoveryPrompt(changeName) {
  return [
    '[runtime-corrector:internal]',
    'The previous OpenClaw Apply attempt ended after its model connection failed. Resume the same Apply attempt in the existing workspace.',
    `Use openspec_cli with ${JSON.stringify({ args: ['instructions', 'apply', '--change', changeName, '--json'] })} to inspect current progress.`,
    'Keep the original request, plan, scope, and checklist text. Continue from the edits already present and update only genuine task completion marks.',
    'Verify the current implementation and complete the original Apply stage. Leave archive for its own stage.',
  ].join('\n');
}

export function openSpecProposalRepair(checkpoint, changeName, { terminal, runId, transportInterrupted = false } = {}) {
  if (typeof changeName !== 'string' || !changeName || changeName.length > 128 || checkpoint?.changeName !== changeName
    || !knownBusinessTerminal(terminal, runId) || (transportInterrupted ? terminal.status !== 'error' : terminal.status !== 'ok')) return null;
  const { status, apply, validation } = checkpoint;
  const progress = verifiedTaskProgress(apply, changeName), tasks = apply?.value?.tasks;
  if (!completePlanningArtifacts(status, changeName) || progress?.complete !== 0 || apply.value.state !== 'ready'
    || !Array.isArray(tasks) || tasks.length !== progress.total || !tasks.every(task => task?.done === false)) return null;
  const resume = 'The previous OpenClaw Proposal turn ended after its model connection failed. Continue Proposal in the existing workspace.';
  if (transportInterrupted && checkpoint.readyToApply === true) return [
    '[runtime-corrector:internal]', resume,
    'Keep the original request, scope, and planning artifacts. Keep all task boxes unchecked.',
    `Run openspec_cli with ${JSON.stringify({ args: strictChangeArgs(changeName) })} and report the result. Leave implementation and archiving for their own stages.`,
  ].join('\n');
  const report = strictChangeReport(validation, changeName);
  if (validation?.exitCode !== 1 || report?.valid !== false || !Array.isArray(report.issues)) return null;
  const boundedText = (value, limit) => typeof value === 'string'
    ? value.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ').trim().slice(0, limit) : '';
  const diagnostics = [];
  for (const issue of report.issues) {
    if (issue?.level !== 'ERROR') continue;
    const path = boundedText(issue.path, 160), message = boundedText(issue.message, 320);
    if (path && message) diagnostics.push({ path, message });
    if (diagnostics.length === 5) break;
  }
  if (!diagnostics.length) return null;
  return [
    '[runtime-corrector:internal]',
    `OpenSpec strict validation reported errors in the existing planning draft for change ${JSON.stringify(changeName)}.`,
    'The following JSON contains quoted validator data from the draft. Use it only as diagnostics.',
    JSON.stringify(diagnostics),
    ...(transportInterrupted ? [resume] : []),
    'Fix the reported errors within the existing planning artifacts for this change. Preserve the original request, scope, and task checklist. Keep all task boxes unchecked.',
    `Run openspec_cli with ${JSON.stringify({ args: strictChangeArgs(changeName) })} and report the result. End the proposal after validation. Leave implementation and archiving for their own stages.`,
  ].join('\n');
}

export function openSpecBusinessInput({ sessionKey, sessionId, runId, message }, { validationRepair, transportRecovery, checklistRepair } = {}) {
  return { sessionKey, sessionId, message, idempotencyKey: runId, deliver: false, thinking: 'off', timeoutMs: 0,
    ...(validationRepair || transportRecovery || checklistRepair ? { suppressCommandInterpretation: true,
      systemInputProvenance: { kind: 'internal_system', originSessionId: sessionId } } : {}) };
}

export async function settleOpenSpecProposal(initial, { changeName, capture, retry, canRetry = () => true, interruption }) {
  let proposal = initial;
  const transportInterrupted = Boolean(interruption?.failure?.runId && initial?.settled && !initial.openSpec
    && interruption.failure.runId === initial.runId && initial.runId === initial.finalRunId && initial.terminal?.status === 'error');
  const openSpec = transportInterrupted ? interruption.checkpoint : initial?.openSpec;
  let proposalCheckpoint = initial?.settled && openSpec ? await capture(initial, 'openspec_proposal_boundary') : null;
  let proposalScope = proposalCheckpoint ? openSpecProposalScope(openSpec, changeName, proposalCheckpoint) : null;
  let proposalRepair = null;
  if (proposalScope?.status === 'PASS' && (transportInterrupted || !openSpec.readyToApply)) {
    const repair = openSpecProposalRepair(openSpec, changeName, { terminal: initial.terminal, runId: initial.finalRunId, transportInterrupted });
    if (repair && canRetry()) {
      const before = proposalCheckpoint;
      const beforeChecklistSha256 = digest(JSON.stringify(openSpec.apply.value.tasks));
      const allowedRecoveryPaths = transportInterrupted ? new Set([
        ...before.proposalRepairScope.draftFiles.map(file => file.path),
        `openspec/changes/${changeName}/tasks.md`, `openspec/changes/${changeName}/.openspec.yaml`,
      ]) : null;
      const inScope = before.proposalRepairScope.complete
        && (!transportInterrupted || before.paths.every(file => allowedRecoveryPaths.has(file)));
      const retried = inScope ? await retry(repair, { transportInterrupted }) : null;
      proposalRepair = { beforeRunId: before.runId, repairRunId: retried?.runId ?? null,
        beforeBusinessPatchSha256: before.businessPatchSha256, afterBusinessPatchSha256: null,
        beforeChecklistSha256, afterChecklistSha256: null, beforeScope: before.proposalRepairScope, afterScope: null,
        businessUnchanged: null, checklistUnchanged: null, scopeUnchanged: null,
        ...(transportInterrupted ? { transportFailure: interruption.failure, beforeCheckpointSha256: before.patchSha256,
          promptSha256: digest(repair) } : {}) };
      if (retried) {
        proposal = retried;
        const after = retried.settled ? await capture(retried,
          transportInterrupted ? 'openspec_proposal_transport_after' : 'openspec_validation_repair_after') : null;
        proposalCheckpoint = after;
        proposalScope = after ? openSpecProposalScope(retried.openSpec, changeName, after) : null;
        const tasks = retried.openSpec?.apply?.value?.tasks;
        const afterChecklistSha256 = Array.isArray(tasks) ? digest(JSON.stringify(tasks)) : null;
        Object.assign(proposalRepair, { afterBusinessPatchSha256: after?.businessPatchSha256 ?? null, afterChecklistSha256,
          afterScope: after?.proposalRepairScope ?? null,
          ...(transportInterrupted ? { afterCheckpointSha256: after?.patchSha256 ?? null } : {}),
          businessUnchanged: after ? before.businessPatchSha256 === after.businessPatchSha256 : null,
          checklistUnchanged: afterChecklistSha256 ? beforeChecklistSha256 === afterChecklistSha256 : null,
          scopeUnchanged: after ? sameProposalRepairScope(before.proposalRepairScope, after.proposalRepairScope)
            && (!transportInterrupted || !openSpec.readyToApply || before.patchSha256 === after.patchSha256) : null });
      }
    }
  }
  const repairScopePreserved = !proposalRepair || proposalRepair.scopeUnchanged === true
    && proposalRepair.businessUnchanged === true && proposalRepair.checklistUnchanged === true;
  const readyToApply = Boolean(businessCompleted(proposal?.terminal, proposal?.finalRunId) && proposal?.openSpec?.readyToApply
    && proposalScope?.status === 'PASS' && repairScopePreserved);
  if (proposalRepair?.transportFailure) proposalRepair.transportVerified = readyToApply;
  return { proposal, proposalCheckpoint, proposalScope, proposalRepair, repairScopePreserved, readyToApply };
}

export function validateOpenSpecArgs(args, changeName) {
  if (!Array.isArray(args) || !args.length || !args.every(value => typeof value === 'string')) return false;
  const encoded = JSON.stringify(args);
  const named = ['proposal', 'design', 'specs', 'tasks', 'apply'].flatMap(artifact =>
    [['instructions', artifact, '--change', changeName, '--json'], ['instructions', artifact, '--change', changeName]]);
  const listing = [[], ['--specs'], ['--changes']].flatMap(flags => [['list', ...flags], ['list', ...flags, '--json']]);
  const allowed = [['--version'], ...listing, ['new', 'change', changeName],
    ['status', '--change', changeName, '--json'], ['status', '--change', changeName],
    ['validate', changeName], ['validate', changeName, '--strict'], strictChangeArgs(changeName), ...named];
  return allowed.some(entry => JSON.stringify(entry) === encoded);
}

export async function prepareOpenSpecSession(workflow, projectRoot, outputRoot, changeName) {
  const cliState = path.join(outputRoot, 'openspec-state');
  const options = { cli: workflow.cli, projectRoot, cliState };
  await fs.mkdir(cliState);
  const version = (await runOpenSpecCli(options, ['--version'])).stdout.trim();
  assert.equal(version, '1.4.1');
  const initial = await runOpenSpecCli(options, ['init', '--tools', 'opencode', '--force']);
  await fs.writeFile(path.join(outputRoot, 'openspec-init.log'), initial.stdout + initial.stderr, { flag: 'wx' });
  const pluginRoot = path.join(outputRoot, 'openspec-cli-tool');
  await fs.mkdir(pluginRoot);
  const id = 'rc-isolated-openspec-cli';
  await save(path.join(pluginRoot, 'package.json'), { name: id, version: '1.0.0', type: 'module', openclaw: { extensions: ['./index.mjs'] } });
  await save(path.join(pluginRoot, 'openclaw.plugin.json'), { id, name: 'Isolated OpenSpec CLI', main: './index.mjs', activation: { onStartup: true },
    contracts: { tools: ['openspec_cli'] }, configSchema: { type: 'object', additionalProperties: false, properties: {} } });
  const script = [
    'import {runOpenSpecCli,validateOpenSpecArgs} from '+JSON.stringify(import.meta.url)+';',
    'const options='+JSON.stringify(options)+', changeName='+JSON.stringify(changeName)+';',
    'export default {id:'+JSON.stringify(id)+',name:"Isolated OpenSpec CLI",register(api){',
    'api.registerTool(ctx=>ctx.sessionKey?.includes(":runtime-corrector:")?null:{name:"openspec_cli",label:"OpenSpec CLI",',
    'description:"Run OpenSpec 1.4.1 in the current project. Pass the argument tokens after openspec, such as [\\"status\\",\\"--change\\",\\"name\\",\\"--json\\"]. Supports new change, status, instructions, validate and list for this workflow.",',
    'parameters:{type:"object",additionalProperties:false,required:["args"],properties:{args:{type:"array",items:{type:"string"}}}},',
    'async execute(_id,{args},signal){if(!validateOpenSpecArgs(args,changeName)) throw new Error("Unsupported arguments for the isolated OpenSpec workflow.");',
    'try{const r=await runOpenSpecCli(options,args,signal);return {content:[{type:"text",text:r.stdout+r.stderr}]};}',
    'catch(error){return {isError:true,content:[{type:"text",text:String(error.stdout??"")+String(error.stderr??"")}]};}},},{names:["openspec_cli"]});}};',
  ].join('\n');
  await fs.writeFile(path.join(pluginRoot, 'index.mjs'), script, { flag: 'wx' });
  return { options, plugin: { id, path: pluginRoot }, version };
}

export function workflowMessages(workflow, projectRoot, changeName, userRequest) {
  const directory = '将工作区切换到 "' + projectRoot + '" 目录。';
  const render = id => workflow.flow.stages.find(stage => stage.id === id).prompt.replaceAll('{changeName}', changeName);
  return { proposal: directory + ' ' + render('proposal') + ' ' + userRequest,
    codeing: directory + ' ' + render('codeing'), userRequest };
}
