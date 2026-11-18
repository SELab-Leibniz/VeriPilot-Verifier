import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkArtifact, loadConfig } from '../lib/runtime-corrector.mjs';
import { loadProjectPolicySource } from '../lib/policy/project-policy.mjs';
import { installOriginalBasisPolicy, readOpenSpecCheckpoint } from '../scripts/bench/original-basis-workflow.mjs';
import { loadRcConfigOverrides } from '../scripts/bench/rc-config-overrides.mjs';
import { fileURLToPath } from 'node:url';

test('OpenSpec checkpoint distinguishes valid planning, applied tasks, and foreign or missing evidence', async () => {
  const changeName = 'benchmark-change';
  const artifacts = ['proposal', 'specs', 'design', 'tasks'].map(id => ({ id, status: 'done' }));
  const status = { changeName, isComplete: true, artifacts };
  const apply = { changeName, state: 'ready', progress: { total: 2, complete: 0, remaining: 2 } };
  const validation = { items: [{ id: changeName, type: 'change', valid: true }] };
  const calls = [];
  const check = replacements => readOpenSpecCheckpoint({}, changeName, { invoke: async (_options, args) => {
    calls.push(args);
    const data = { status, instructions: apply, validate: validation, ...replacements }[args[0]];
    if (data instanceof Error) throw data;
    return { stdout: JSON.stringify(data) };
  } });
  const plan = await check({});
  assert.deepEqual(calls, [['status', '--change', changeName, '--json'], ['instructions', 'apply', '--change', changeName, '--json'],
    ['validate', changeName, '--type', 'change', '--strict', '--json']]);
  assert(plan.planVerified && plan.readyToApply && !plan.applyComplete);
  const completed = { ...apply, state: 'all_done', progress: { total: 2, complete: 2, remaining: 0 } };
  assert((await check({ instructions: completed })).applyComplete);
  for (const changes of [
    { status: { ...status, artifacts: artifacts.filter(item => item.id !== 'specs') } },
    { status: { ...status, changeName: 'other' } },
    { instructions: { ...completed, changeName: 'other' } },
    { instructions: { ...completed, progress: { total: 2, complete: 0, remaining: 0 } } },
    { validate: { items: [{ id: changeName, type: 'spec', valid: true }] } },
    { validate: Object.assign(new Error('Failed validation'), { code: 1, stdout: JSON.stringify(validation) }) },
  ]) assert.equal((await check({ instructions: completed, ...changes })).applyComplete, false);
});

test('new project template enables original document review and B12 behind the two project controls', async t => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-original-basis-'));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.cp(new URL('../.runtime-corrector-default/', import.meta.url), path.join(projectRoot, '.runtime-corrector'), { recursive: true });
  const plan = await loadConfig({ cwd: projectRoot });
  const { runtimeV2: runtime } = plan;
  const controls = await loadProjectPolicySource(projectRoot);
  assert.equal(controls.enabled, false);
  assert.equal(controls.sessionDefaults.enabled, false);
  assert.deepEqual(runtime.artifactCorrection, { originalRequirementsEnabled: true, groundTruthReviewEnabled: false, stageMetricsEnabled: false });
  assert.equal(runtime.stopCorrection.enabled, true);
  assert.equal(runtime.stopCorrection.originalRequirementsBasis, true);
  assert.equal(runtime.stopCorrection.deviationOnly, true);
  assert.equal(runtime.stopCorrection.waitMode, 'until_pass');
  assert.equal(runtime.stopCorrection.assessmentTimeoutMs, 1_800_000);
  assert.equal(runtime.stopCorrection.maxCorrectionsPerSession, 2);
  assert.deepEqual(runtime.stopCorrection.regressionCheck, { enabled: false, cwd: '.', timeoutMs: 600_000, maxOutputBytes: 65_536 });
  assert.equal(runtime.dynamicGroundTruth.enabled, false);
  assert.equal(runtime.skillCorrection.enabled, false);
  assert.equal(runtime.implementationCorrection.enabled, false);
  assert.notEqual(runtime.compactionRestore?.enabled, true);
  assert.equal(controls.reviewers.defaults.model, 'custom/deepseek-v4-flash');
  assert.deepEqual(plan.reviewGraph.edges.map(({ from, to }) => [from, to]), [
    ['proposal', 'specs'], ['proposal', 'design'], ['proposal', 'tasks'], ['specs', 'tasks'], ['design', 'tasks'],
  ]);
  assert.deepEqual(plan.configuredArtifacts.map(item => item.nodeId), ['proposal', 'specs', 'design', 'tasks']);
});

test('the ArkTS treatment enables task-start public verification alongside OpenSpec document review', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-arkts-treatment-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, 'project');
  await fs.mkdir(projectRoot);
  const outputRoot = root;
  const artifact = fileURLToPath(new URL('../', import.meta.url));
  const overrideFile = path.join(artifact, 'config', 'arkts-openspec-correction.json');
  const policy = await installOriginalBasisPolicy({ artifact, projectRoot, outputRoot,
    overrides: await loadRcConfigOverrides(overrideFile), variables: { projectRoot, outputRoot, harnessRoot: artifact,
      node: process.execPath, toolRoot: path.join(root, 'clt'), javaHome: path.join(root, 'jbr') } });
  const check = policy.runtimeV2.stopCorrection.regressionCheck;
  assert.equal(policy.runtimeV2.artifactCorrection.originalRequirementsEnabled, true);
  assert.equal(check.enabled, true);
  assert.equal(check.baselineFile, `${outputRoot}/baseline-local-tests.json`);
  assert.deepEqual(check.command.slice(-2), [`--baseline=${check.baselineFile}`, '--original-tests']);
  assert.equal(policy.regressionCheck.honoredByProduct, true);
});

test('OpenSpec delta and tasks reviews use only same-change workflow evidence', async t => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-openspec-specs-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  await fs.cp(new URL('../.runtime-corrector-default/', import.meta.url), path.join(cwd, '.runtime-corrector'), { recursive: true });
  const configPath = path.join(cwd, '.runtime-corrector', 'config.yaml');
  const template = await fs.readFile(configPath, 'utf8');
  await fs.writeFile(configPath, template.replace(/^enabled: false$/mu, 'enabled: true'));

  const proposal = 'openspec/changes/main/proposal.md';
  const design = 'openspec/changes/main/design.md';
  const tasks = 'openspec/changes/main/tasks.md';
  const noSpecsTasks = 'openspec/changes/no-specs/tasks.md';
  const flat = 'openspec/changes/main/specs/permissions/spec.md';
  const nested = 'openspec/changes/main/specs/account/roles/groups/spec.md';
  const canonical = 'openspec/specs/permissions/spec.md';
  const archived = 'openspec/changes/archive/2026-11-13-main/specs/permissions/spec.md';
  for (const file of [proposal, design, tasks, flat, nested, canonical, archived, 'openspec/changes/other/proposal.md',
    'openspec/changes/other/specs/permissions/spec.md', 'openspec/changes/no-specs/proposal.md',
    'openspec/changes/no-specs/design.md', noSpecsTasks]) {
    await fs.mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
    await fs.writeFile(path.join(cwd, file), '# OpenSpec artifact\n');
  }

  const plan = await loadConfig({ cwd });
  const check = (filePath, config = plan) => checkArtifact({ cwd, filePath, config, deferPersistence: true });
  const { matched, reviewContext } = await check(nested);
  assert.equal(matched, true);
  assert.equal(reviewContext.artifact.nodeId, 'specs');
  assert.deepEqual(reviewContext.workflow.incomingEdges.map(({ sourceFiles, targetFiles }) => ({
    sourceFiles, targetFiles: [...targetFiles].sort(),
  })), [{ sourceFiles: [proposal], targetFiles: [nested, flat] }]);
  assert.equal((await check(canonical)).matched, false);
  assert.equal((await check(archived)).matched, false);

  const tasksReview = await check(tasks);
  assert.deepEqual(tasksReview.reviewContext.workflow.editableArtifactFiles, [tasks]);
  assert.deepEqual(tasksReview.reviewContext.workflow.incomingEdges.map(({ from, status, sourceFiles }) => ({
    from, status, sourceFiles: [...sourceFiles].sort(),
  })), [
    { from: 'proposal', status: 'ready', sourceFiles: [proposal] },
    { from: 'specs', status: 'ready', sourceFiles: [nested, flat] },
    { from: 'design', status: 'ready', sourceFiles: [design] },
  ]);
  const pending = await check(noSpecsTasks);
  assert.equal(pending.result.status, 'pending');
  assert(pending.result.diagnostics.some(diagnostic => diagnostic.ruleId === 'WORKFLOW-EDGE-SOURCE-MISSING'
    && diagnostic.evidence.includes('from=specs')));

  const customPolicy = template.replace(/^enabled: false$/mu, 'enabled: true')
    .replace(/(^    - from: specs\r?\n      to: tasks\r?\n      review:\r?\n        enabled: )true$/mu, '$1false');
  await fs.writeFile(configPath, customPolicy);
  const customReview = await check(noSpecsTasks, await loadConfig({ cwd }));
  assert.equal(customReview.result.status, 'passed');
  assert.deepEqual(customReview.reviewContext.workflow.incomingEdges.map(({ from }) => from), ['proposal', 'design']);

  await fs.writeFile(configPath, template.replace(/^enabled: false$/mu, 'enabled: true').replace(/^  - specs\r?\n/mu, ''));
  const withoutSpecReview = await loadConfig({ cwd });
  assert.equal((await check(flat, withoutSpecReview)).matched, false);
  const tasksWithoutSpecReview = await check(tasks, withoutSpecReview);
  assert.deepEqual(tasksWithoutSpecReview.reviewContext.workflow.incomingEdges.find(edge => edge.from === 'specs').sourceFiles.sort(), [nested, flat]);
});
