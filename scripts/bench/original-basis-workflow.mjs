
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { digest } from './arkts-dataset.mjs';
import { loadPackaged } from '../helpers/simplify-native-evaluation.mjs';
import { applyRcConfigOverrides, regressionCheckPolicy } from './rc-config-overrides.mjs';
import { parseSimpleYaml } from '../../lib/simple-yaml.mjs';

const run = promisify(execFile);
const save = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });

export async function loadOriginalBasisWorkflow(root, hostRoot, pinned) {
  const cli = path.join(root, 'cli/bin/openspec.js');
  const pluginRoot = path.join(root, 'sdd-workflow-tool');
  const files = {
    workflow: path.join(root, 'workflow.yaml'),
    archive: path.join(root, 'fission-ai-openspec-1.4.1.tgz'),
    install: path.join(root, 'installPkg.js'),
    cli,
    pluginManifest: path.join(pluginRoot, 'openclaw.plugin.json'),
    pluginEntry: path.join(pluginRoot, 'dist/index.js'),
  };
  const bytes = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([key, file]) => [key, await fs.readFile(file)])));
  assert.deepEqual(Object.fromEntries(Object.entries(bytes).map(([key, value]) => [key, digest(value)])), pinned.files);
  const { parse } = createRequire(path.join(hostRoot, 'package.json'))('yaml');
  const flow = parse(bytes.workflow.toString('utf8'));
  const plugin = JSON.parse(bytes.pluginManifest);
  assert.equal(flow.displayName, 'OpenSpec(solo)');
  assert.equal(flow.sessionInit.trim().replace(/\s+/gu, ' '), 'openspec init --tools opencode --force');
  assert.deepEqual(flow.stages.map(stage => stage.id), ['proposal', 'design', 'tasks', 'codeing', 'archive']);
  assert.equal(plugin.id, 'sdd-workflow-tool');
  assert.equal(plugin.version, pinned.pluginVersion);
  return { flow, cli, plugin: { id: plugin.id, path: pluginRoot, config: { workflows: flow.modelTool?.enabled ? [{
    flowId: 'openspec-solo', displayName: flow.displayName, description: flow.modelTool.description ?? '',
    sessionInit: flow.sessionInit, placeholder: flow.placeholder ?? '', firstStageId: 'proposal', firstStagePrompts: [flow.stages[0].prompt],
  }] : [] } } };
}

// Experiment overrides are merged after the release flags; the release
// invariants asserted below still hold for every arm.
export async function installOriginalBasisPolicy({ artifact, projectRoot, outputRoot, overrides = null, variables = {}, reviewerModelRef = 'custom/deepseek-v4-flash' }) {
  const policyRoot = path.join(projectRoot, '.runtime-corrector');
  const templateRoot = path.join(artifact, '.runtime-corrector-default');
  const template = await fs.readFile(path.join(templateRoot, 'config.yaml'), 'utf8');
  const released = template.replace(/^enabled: false$/mu, 'enabled: true')
    .replace(/(^sessionDefaults:\r?\n(?:  #[^\r\n]*\r?\n)*)  enabled: false$/mu, '$1  enabled: true');
  assert.equal(released.replace(/^enabled: true$/mu, 'enabled: false')
    .replace(/(^sessionDefaults:\r?\n(?:  #[^\r\n]*\r?\n)*)  enabled: true$/mu, '$1  enabled: false'), template);
  assert.notEqual(released, template);
  const { text: configured, applied } = applyRcConfigOverrides(released, overrides, variables);
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
  assert.equal(raw.reviewers.defaults.model, reviewerModelRef);
  assert.equal(effective.reviewers.stopReviewer.model, reviewerModelRef);
  assert.deepEqual(effective.artifactCorrection, {
    originalRequirementsEnabled: applied?.value?.artifactCorrection?.originalRequirementsEnabled ?? true, groundTruthReviewEnabled: false, stageMetricsEnabled: false,
  });
  assert.equal(effective.stopCorrection.enabled, true);
  assert.equal(effective.stopCorrection.originalRequirementsBasis, true);
  assert.equal(effective.stopCorrection.deviationOnly, true);
  assert.equal(effective.dynamicGroundTruth.enabled, false);
  assert.equal(effective.implementationCorrection.enabled, false);
  assert.equal(effective.skillCorrection.enabled, false);
  assert.notEqual(effective.compactionRestore?.enabled, true);
  const evidence = { templateSha256: digest(template), configuredSha256: digest(configured),
    overrides: { enabled: true, 'sessionDefaults.enabled': true }, experimentOverrides: applied, runtimeV2: effective,
    regressionCheck: regressionCheckPolicy(applied && parseSimpleYaml(configured).stopCorrection?.regressionCheck, effective.stopCorrection.regressionCheck) };
  await save(path.join(outputRoot, 'effective-policy.json'), evidence);
  return evidence;
}

export async function runOpenSpecCli({ cli, projectRoot, cliState }, args, signal) {
  const env = { ...process.env, APPDATA: cliState, XDG_CONFIG_HOME: cliState, OPENSPEC_TELEMETRY: '0', DO_NOT_TRACK: '1' };
  for (const key of Object.keys(env)) if (/(?:TOKEN|SECRET|API_KEY|PASSWORD|AUTH_TOKEN)/iu.test(key)) delete env[key];
  return run(process.execPath, [cli, ...args], { cwd: projectRoot, env, signal, windowsHide: true, timeout: 90_000, maxBuffer: 2 * 1024 * 1024 });
}

export function validateOpenSpecArgs(args, changeName) {
  if (!Array.isArray(args) || !args.length || !args.every(value => typeof value === 'string')) return false;
  const encoded = JSON.stringify(args);
  const named = ['proposal', 'design', 'specs', 'tasks', 'apply'].flatMap(artifact =>
    [['instructions', artifact, '--change', changeName, '--json'], ['instructions', artifact, '--change', changeName]]);
  const allowed = [['--version'], ['list'], ['list', '--json'], ['new', 'change', changeName],
    ['status', '--change', changeName, '--json'], ['status', '--change', changeName],
    ['validate', changeName], ['validate', changeName, '--strict'], ...named];
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
