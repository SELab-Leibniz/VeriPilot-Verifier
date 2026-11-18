#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs, promisify } from 'node:util';
import { digest } from './bench/arkts-dataset.mjs';
import { arktsInstrumentRuntime } from './bench/arkts-instrument-results.mjs';
import { runArktsLocalTest } from './bench/arkts-local-test.mjs';
import { loadArktsPublicAcceptance, loadArktsPublicPositiveManifest, loadArktsPublicProbeManifest,
  qualifiedProbeBindings } from './bench/arkts-public-acceptance.mjs';
import { copyArktsPublicTestSnapshot } from './bench/arkts-public-test-snapshot.mjs';
import { runArktsRequirementProbe } from './bench/arkts-regression-check.mjs';
import { submitArktsWorkerJob } from './bench/arkts-worker-exchange.mjs';
import { withFileLock, worktreeLockPath } from './bench/file-lock.mjs';
import { localTestEvidence } from './bench/local-test-evidence.mjs';
import { prepareArktsModelWorkspace } from './bench/prepare-arkts-model-workspace.mjs';
import { shortArktsWorkspace } from './bench/short-workspace.mjs';
import { assertFrozenCampaignHarness, preflightPairedBaseCache, verifyPublicPairedPlan } from './run-arkts-paired-campaign.mjs';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const run = promisify(execFile);
const sha256 = /^[a-f0-9]{64}$/u;
const commit = /^[a-f0-9]{40}$/u;
const gitExecutable = process.platform === 'win32' ? 'C:/Program Files/Git/cmd/git.exe' : 'git';
const git = (...args) => run(gitExecutable, ['-c', 'core.longpaths=true', ...args], {
  encoding:'utf8', windowsHide:true, timeout:30_000, env:{ ...process.env, GIT_NO_LAZY_FETCH:'1' },
}).then(({ stdout }) => stdout.trim());
const writeNew = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag:'wx' });
const isWorktree = file => fs.lstat(path.join(file, '.git')).then(stat => stat.isFile(), error => {
  if (error.code === 'ENOENT') return false;
  throw error;
});

async function archiveMeasurement(directory, id, role, { execution, output, raw, freshReport }) {
  const evidence = localTestEvidence(raw, execution, { freshReport, compileOutput:output });
  const prefix = role === 'stock' ? '' : role + '-';
  const archive = async (filename, bytes) => {
    const name = prefix + filename;
    await fs.writeFile(path.join(directory, name), bytes, { flag:'wx' });
    return { file:`${id}/${name}`, sha256:digest(bytes) };
  };
  const compileOutput = await archive('compile-output.log', output);
  const coverage = freshReport && raw ? await archive('coverage.log', raw) : undefined;
  const { exitCode, interrupted, outputComplete, snapshotSha256, compileSucceeded, runtime,
    device, suiteSha256, runnerSha256, appBuildMode, reason } = execution;
  const deviceIdentity = device && { server:device.server, target:device.target, api:device.api,
    type:device.type, image:device.image, bootReady:device.bootReady };
  return { evidence, receipt: { compileOutput, ...(coverage ? { coverage } : {}),
    execution:{ exitCode, interrupted, outputComplete, freshReport, completeRuntime:evidence.completeRuntime,
      snapshotSha256:snapshotSha256 ?? null, compileOutputSha256:compileOutput.sha256,
      ...(reason ? { reason } : {}), ...(typeof compileSucceeded === 'boolean' ? { compileSucceeded } : {}),
      ...(runtime ? { runtime } : {}), ...(deviceIdentity ? { device:deviceIdentity } : {}),
      ...(typeof runnerSha256 === 'string' ? { runnerSha256 } : {}),
      ...(typeof suiteSha256 === 'string' ? { suiteSha256 } : {}),
      ...(typeof appBuildMode === 'string' ? { appBuildMode } : {}) } } };
}

function measuredExecution(execution, runtime) {
  if (!execution || execution.runtime !== runtime || !execution.completeRuntime
    || !Number.isInteger(execution.exitCode) || execution.exitCode < 0
    || !sha256.test(execution.snapshotSha256 ?? '')) return false;
  if (runtime !== arktsInstrumentRuntime) return true;
  return execution.compileSucceeded === true && execution.device?.bootReady === true && execution.device.api === 24
    && ['server', 'target', 'type', 'image'].every(key => typeof execution.device[key] === 'string' && execution.device[key])
    && sha256.test(execution.suiteSha256 ?? '') && sha256.test(execution.runnerSha256 ?? '')
    && ['test', 'debug'].includes(execution.appBuildMode);
}

function sameExecutionRoute(left, right) {
  return left.runtime === right.runtime && isDeepStrictEqual(left.device, right.device)
    && left.runnerSha256 === right.runnerSha256 && left.appBuildMode === right.appBuildMode;
}

async function observeAcceptance({ project, scratch, directory, row, definition, publicTestWorker, timeoutMs, signal, role = 'acceptance' }) {
  const { sha256: expectedSha256, testIds, expectedBase, probeBytes } = definition;
  const probe = probeBytes ? path.join(scratch, `${role}-probe.ets`) : definition.probe;
  if (probeBytes) await fs.writeFile(probe, probeBytes, { flag:'wx' });
  const result = await runArktsRequirementProbe({ project, probe, sha256:expectedSha256, testIds, publicTestWorker, timeoutMs, signal,
    includeExecutionEvidence:true });
  const measured = result.executionEvidence && await archiveMeasurement(directory, row.id, role, result.executionEvidence);
  const { runtime } = publicTestWorker;
  const execution = measured?.receipt.execution;
  const snapshot = result.snapshotSha256;
  const observed = ['PASS', 'FAIL'].includes(result.status) && result.sha256 === expectedSha256
    && measuredExecution(execution, runtime) && snapshot === execution.snapshotSha256 && snapshot !== row.snapshotSha256
    && (!measuredExecution(row.execution, runtime) || sameExecutionRoute(row.execution, execution));
  return { source:probeBytes ? 'CANDIDATE_MANIFEST' : 'REGISTERED',
    status:observed ? result.status : 'INCOMPLETE', probeSha256:expectedSha256, checks:result.checks,
    snapshotSha256:observed ? snapshot : null,
    ...(!observed ? { reason:result.reason ?? 'PUBLIC_TEST_WORKER_EXECUTION_UNVERIFIED' } : {}),
    ...measured?.receipt,
    ...(expectedBase ? { expectedBase, matchesExpectedBase:observed && expectedBase.every((expected, index) => result.checks[index].status === expected) } : {}) };
}

async function applyPositiveControl(project, scratch, { patchBytes }) {
  const file = path.join(scratch, 'positive.patch');
  await fs.writeFile(file, patchBytes, { flag:'wx' });
  await git('-C', project, 'apply', '--index', '--binary', '--', file);
  const fields = (await git('-C', project, 'diff', '--cached', '--raw', '--no-abbrev', '--no-renames', '-z', 'HEAD')).split('\0');
  assert(fields.pop() === '' && fields.length > 0 && fields.length % 2 === 0, 'Public positive patch must change production');
  const paths = [];
  for (let index = 0; index < fields.length; index += 2) {
    const [record, name] = fields.slice(index, index + 2);
    const match = /^:(?:100644|100755|000000) (?:100644|100755|000000) ([a-f0-9]+) ([a-f0-9]+) [AMD]$/u.exec(record);
    assert(match && match[1] !== match[2] && /^entry\/src\/main\/.+/u.test(name),
      'Public positive patch may change only contents of regular files under entry/src/main/');
    paths.push(name);
  }
  const tree = await git('-C', project, 'write-tree');
  assert.match(tree, commit);
  return { tree, paths };
}

async function observePositiveControl({ project, scratch, preparedHead, row, positive, ...options }) {
  const positiveProject = path.join(scratch, 'positive-project');
  // The task-start worktree shares the campaign's Git objects. A clone with an
  // alternate reads those objects but keeps repaired blobs and trees local.
  await git('clone', '--quiet', '--no-checkout', '--shared', '--', project, positiveProject);
  await git('-C', positiveProject, 'checkout', '--quiet', '--detach', preparedHead);
  assert.equal(await copyArktsPublicTestSnapshot(positiveProject, undefined, { signal:options.signal }), row.snapshotSha256,
    'Public positive control did not start at the same prepared source');
  const { tree, paths } = await applyPositiveControl(positiveProject, scratch, positive);
  assert.notEqual(tree, row.preparedTree, 'Public positive patch did not change the prepared tree');
  const result = await observeAcceptance({ ...options, project:positiveProject, scratch, row,
    definition:{ ...options.definition, expectedBase:undefined }, role:'positive' });
  return { ...result, tree, paths, patchSha256:positive.patchSha256 };
}

export async function runArktsPublicWorkerSmoke({ planDirectory, planSha256, releaseCommit, cacheRoot, workspaceRoot,
  json5Package, outputRoot, exchange, toolchainSha256, selectedCases, publicAcceptance = false,
  probeManifest, probeManifestSha256, positiveManifest, positiveManifestSha256, timeoutMs = 900_000, signal }) {
  assert(sha256.test(planSha256) && commit.test(releaseCommit), 'Provide the frozen plan digest and exact release commit');
  assert(exchange ? sha256.test(toolchainSha256) : toolchainSha256 === undefined, 'Provide the verified worker toolchain digest with its exchange');
  assert(Boolean(probeManifest) === Boolean(probeManifestSha256) && (!probeManifest || sha256.test(probeManifestSha256)),
    'Provide the candidate probe manifest and its trusted SHA-256 together');
  assert(Boolean(positiveManifest) === Boolean(positiveManifestSha256) && (!positiveManifest || sha256.test(positiveManifestSha256)),
    'Provide the positive control manifest and its trusted SHA-256 together');
  assert(exchange || !publicAcceptance && !probeManifest && !positiveManifest, 'Public acceptance measurement requires a test worker exchange');
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60 * 60_000, 'Invalid public test timeout');
  const { inputs } = await verifyPublicPairedPlan(planDirectory, planSha256);
  const selected = selectedCases ?? inputs.map(input => input.id);
  assert(selected.length && new Set(selected).size === selected.length && selected.every(id => inputs.some(input => input.id === id)),
    'Select distinct cases from the frozen plan');
  const cases = inputs.filter(input => selected.includes(input.id));
  const manifest = probeManifest && await loadArktsPublicProbeManifest(probeManifest, probeManifestSha256, planSha256, inputs.map(input => input.id));
  const acceptanceChecks = new Map();
  if (publicAcceptance || manifest) {
    for (const { id, task, publicBytes } of cases) {
      const registered = publicAcceptance && await loadArktsPublicAcceptance(task, digest(publicBytes));
      const candidate = manifest?.probes.get(id);
      assert(!registered || !candidate, `Choose one public acceptance definition for ${id}`);
      if (candidate) qualifiedProbeBindings(task, candidate.testIds, candidate.requirementBindings);
      if (registered || candidate) acceptanceChecks.set(id, registered || candidate);
    }
    assert(acceptanceChecks.size, 'No public acceptance definitions apply to the selected tasks');
  }
  const positiveControls = positiveManifest && await loadArktsPublicPositiveManifest(positiveManifest, positiveManifestSha256, planSha256,
    new Map(inputs.map(({ id, task }) => [id, task.base_commit])));
  if (positiveControls) {
    const selectedControls = selected.filter(id => positiveControls.has(id));
    assert(selectedControls.length && selectedControls.every(id => acceptanceChecks.has(id)),
      'Each selected positive control requires an applicable acceptance probe');
  }
  const bases = await preflightPairedBaseCache(cases, cacheRoot, { gitExecutable });
  let runtime;
  if (exchange) {
    const identity = await submitArktsWorkerJob(exchange, 'identity', { releaseCommit }, { timeoutMs:120_000, signal });
    assert.equal(identity?.toolchainSha256, toolchainSha256, 'Public worker differs from the independently measured toolchain');
    runtime = identity.runtime;
    assert(runtime === undefined || runtime === arktsInstrumentRuntime, 'Unknown public worker backend');
  }
  await fs.mkdir(outputRoot);
  const rows = [];
  for (const [index, { id, task, publicBytes }] of cases.entries()) {
    signal?.throwIfAborted();
    const directory = path.join(outputRoot, id);
    await fs.mkdir(directory);
    const scratch = await fs.mkdtemp(path.join(workspaceRoot, 'sm-'));
    const prepareOutput = path.join(directory, 'prepare');
    const cache = bases[index].cache;
    let project;
    try {
      project = shortArktsWorkspace(prepareOutput, 'biz', sourceRoot, scratch);
      const prepared = await prepareArktsModelWorkspace({ task, outputRoot:prepareOutput, cacheRoot, workspaceRoot:scratch, json5Package, gitExecutable });
      assert.equal(prepared.projectRoot, project);
      assert.equal(prepared.baseCommit, task.base_commit);
      const preparedTree = await git('-C', project, 'rev-parse', 'HEAD^{tree}');
      assert.match(preparedTree, commit);
      const changes = await git('-C', project, 'diff', '--name-only', task.base_commit, 'HEAD');
      assert(changes === '' || changes === 'build-profile.json5', 'Public smoke preparation changed more than the common build profile');
      assert.equal(await git('-C', project, 'status', '--porcelain'), '', 'The prepared public worktree is dirty');
      const snapshotSha256 = await copyArktsPublicTestSnapshot(project, undefined, { signal });
      const row = { id, baseCommit:task.base_commit, publicInputSha256:digest(publicBytes), preparedTree, snapshotSha256,
        status:'SNAPSHOT_PREPARED' };
      if (exchange) {
        const publicTestWorker = { exchange, releaseCommit, toolchainSha256, runtime, caseId:id };
        const measurement = await runArktsLocalTest({ projectRoot:project, timeoutMs, signal, publicTestWorker });
        const { evidence, receipt } = await archiveMeasurement(directory, id, 'stock', measurement);
        const statuses = Object.values(evidence.statuses);
        const observed = measuredExecution(receipt.execution, runtime) && receipt.execution.snapshotSha256 === snapshotSha256
          && statuses.some(status => ['PASS', 'FAIL', 'ERROR'].includes(status));
        Object.assign(row, { status:observed ? 'PUBLIC_TEST_OBSERVED' : 'PUBLIC_TEST_UNVERIFIED',
          tests:{ observed:statuses.length, counts:evidence.counts, allObservedPassed:evidence.allObservedPassed,
            publicInventorySha256:digest(JSON.stringify(Object.keys(evidence.statuses).sort())) },
          ...receipt });
        const definition = acceptanceChecks.get(id);
        const acceptanceOptions = { project, scratch, directory, row, definition, publicTestWorker, timeoutMs, signal };
        if (definition) row.acceptance = await observeAcceptance(acceptanceOptions);
        const positive = positiveControls?.get(id);
        if (positive) {
          row.positive = await observePositiveControl({ ...acceptanceOptions, preparedHead:prepared.preparedHead, positive });
          row.qualification = observed && row.acceptance.status === 'FAIL' && row.acceptance.matchesExpectedBase !== false
            && row.positive.status === 'PASS' && row.positive.snapshotSha256 !== row.acceptance.snapshotSha256
            && (runtime !== arktsInstrumentRuntime || row.acceptance.execution.suiteSha256 === row.positive.execution.suiteSha256)
            ? 'BASE_AND_POSITIVE_MATCHED' : 'POSITIVE_CONTROL_UNVERIFIED';
        }
      }
      await writeNew(path.join(directory, 'result.json'), row);
      rows.push(row);
    } finally {
      if (project && await isWorktree(project))
        await withFileLock(worktreeLockPath(cache), () => git('--git-dir', cache, 'worktree', 'remove', '--force', project));
      await fs.rm(scratch, { recursive:true, force:true });
    }
  }
  const complete = rows.every(row => row.status === 'PUBLIC_TEST_OBSERVED'
    && row.acceptance?.status !== 'INCOMPLETE' && row.acceptance?.matchesExpectedBase !== false
    && (!row.positive || row.qualification === 'BASE_AND_POSITIVE_MATCHED'));
  const status = !exchange ? 'SNAPSHOTS_PREPARED' : complete ? 'PUBLIC_TESTS_OBSERVED' : 'INCOMPLETE';
  const report = { kind:'arkts-public-test-worker-smoke-v1', status, releaseCommit, planSha256,
    ...(manifest ? { probeManifest:{ sha256:manifest.sha256, authoredAgainstCommit:manifest.authoredAgainstCommit } } : {}),
    ...(positiveManifest ? { positiveManifest:{ sha256:positiveManifestSha256 } } : {}),
    ...(exchange ? { toolchainSha256, ...(runtime ? { runtime } : {}) } : {}), cases:rows, formalPairsAdded:0 };
  await writeNew(path.join(outputRoot, 'report.json'), report);
  return report;
}

const required = ['plan', 'plan-sha256', 'release-commit', 'cache', 'workspace-root', 'json5-package', 'output'];
const usage = `node scripts/run-arkts-public-worker-smoke.mjs --plan=<public plan> --plan-sha256=<sha256> --release-commit=<git commit>
  --cache=<preseeded public Git cache> --workspace-root=<existing short directory> --json5-package=<resolving package.json> --output=<new directory>
  (--prepare-only | --exchange=<public worker share> --toolchain-sha256=<verified worker digest>) [--cases=<comma-separated task IDs>] [--timeout-ms=900000]
  With an exchange, add --public-acceptance for registered probes and/or --probe-manifest=<file> --probe-manifest-sha256=<sha256> for candidate controls.
  Add --positive-manifest=<file> --positive-manifest-sha256=<sha256> to compare probes with reviewed public repair patches.
The default selection covers every task in the supplied plan. This command uses public data only and adds no formal benchmark pairs.`;

async function main() {
  const { values } = parseArgs({ options:{ ...Object.fromEntries([...required, 'cases', 'exchange', 'toolchain-sha256', 'timeout-ms', 'probe-manifest', 'probe-manifest-sha256',
    'positive-manifest', 'positive-manifest-sha256']
    .map(name => [name, { type:'string' }])), 'prepare-only':{ type:'boolean' }, 'public-acceptance':{ type:'boolean' }, help:{ type:'boolean' } } });
  if (values.help) { console.log(usage); return; }
  assert(required.every(name => values[name]) && (values['prepare-only'] ? !values.exchange && !values['toolchain-sha256'] : values.exchange), usage);
  await assertFrozenCampaignHarness(sourceRoot, values['release-commit']);
  const directory = name => fs.realpath(values[name]);
  const [planDirectory, cacheRoot, workspaceRoot, json5Package, exchange] = await Promise.all([
    directory('plan'), directory('cache'), directory('workspace-root'), directory('json5-package'), values.exchange && directory('exchange'),
  ]);
  const controller = new AbortController();
  for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => controller.abort());
  const report = await runArktsPublicWorkerSmoke({ planDirectory, planSha256:values['plan-sha256'], releaseCommit:values['release-commit'],
    cacheRoot, workspaceRoot, json5Package, outputRoot:path.resolve(values.output), exchange, toolchainSha256:values['toolchain-sha256'],
    publicAcceptance:values['public-acceptance'], probeManifest:values['probe-manifest'], probeManifestSha256:values['probe-manifest-sha256'],
    positiveManifest:values['positive-manifest'], positiveManifestSha256:values['positive-manifest-sha256'],
    selectedCases:values.cases?.split(','), timeoutMs:values['timeout-ms'] === undefined ? undefined : Number(values['timeout-ms']), signal:controller.signal });
  console.log(JSON.stringify({ status:report.status, cases:report.cases.length, output:path.resolve(values.output, 'report.json') }));
  if (report.status === 'INCOMPLETE') process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main().catch(error => { console.error(error.message); process.exitCode = 1; });
