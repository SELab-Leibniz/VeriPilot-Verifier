import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { digest } from '../scripts/bench/arkts-dataset.mjs';
import { arktsInstrumentRuntime } from '../scripts/bench/arkts-instrument-results.mjs';
import { copyArktsPublicTestSnapshot } from '../scripts/bench/arkts-public-test-snapshot.mjs';
import { loadArktsQualifiedAcceptance } from '../scripts/bench/arkts-qualified-acceptance.mjs';
import { serveArktsWorkerJobs } from '../scripts/bench/arkts-worker-exchange.mjs';
import { createPairedPlan, verifyPublicPairedPlan } from '../scripts/run-arkts-paired-campaign.mjs';
import { runArktsWorkerPublicTest } from '../scripts/run-arkts-public-test-worker.mjs';
import { runArktsPublicWorkerSmoke } from '../scripts/run-arkts-public-worker-smoke.mjs';

const id = 'security_tool_1';
const releaseCommit = 'a'.repeat(40);
const toolchainSha256 = 'b'.repeat(64);
const compileOutput = 'Finished :entry:default@UnitTestArkTS';
const reportWithoutEnd = [
  "[Hypium]start running case 'keeps_order'",
  'OHOS_REPORT_STATUS: class=Local',
  '[Hypium][pass]keeps_order ; consuming 1ms',
  'OHOS_REPORT_STATUS: class=Local',
  'OHOS_REPORT_STATUS: test=keeps_order',
  'OHOS_REPORT_STATUS_CODE: 0',
  '',
].join('\n');
const completeReport = `${reportWithoutEnd}[Hypium][end] run suites end\n`;
const listFile = path.join('entry', 'src', 'test', 'List.test.ets');
const originalList = "import localTest from './Local.test'\nexport default function testsuite(): void { localTest() }\n";
const productionFile = 'entry/src/main/ets/Answer.ets';
const baseProduction = 'export const answer: number = 1;\n';
const positiveProduction = 'export const answer: number = 2;\n';

function instrumentReport(name, failed = false) {
  const frame = ['class=Local', 'current=1', 'id=JS', 'numtests=1', `test=${name}`]
    .map(field => 'OHOS_REPORT_STATUS: ' + field).join('\n');
  return [frame, 'OHOS_REPORT_STATUS_CODE: 1', frame, `OHOS_REPORT_STATUS_CODE: ${failed ? -2 : 0}`,
    `OHOS_REPORT_RESULT: stream=Tests run: 1, Failure: ${Number(failed)}, Error: 0, Pass: ${Number(!failed)}, Ignore: 0`,
    `OHOS_REPORT_CODE: ${failed ? -1 : 0}`, 'TestFinished-ResultCode: 0', 'user test finished.', ''].join('\n');
}

async function assertCompileOutput(outputRoot, assay, expectedFile) {
  assert.deepEqual(assay.compileOutput, { file:`${id}/${expectedFile}`, sha256:digest(compileOutput) });
  assert.equal(assay.execution.compileOutputSha256, assay.compileOutput.sha256);
  assert.equal(await fs.readFile(path.join(outputRoot, assay.compileOutput.file), 'utf8'), compileOutput);
}

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pc-smoke-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const gitRoot = path.join(root, 'base');
  const dataset = path.join(root, 'private-fixture-dataset');
  const planDirectory = path.join(root, 'plan');
  const cacheRoot = path.join(root, 'cache');
  const workspaceRoot = path.join(root, 'w');
  const workerRoot = path.join(root, 'pw');
  const exchange = path.join(root, 'e');
  const parser = path.join(root, 'parser');
  const moduleRoot = path.join(parser, 'node_modules', 'json5');
  const publicTest = path.join('entry', 'src', 'test', 'Local.test.ets');
  await Promise.all([dataset, cacheRoot, workspaceRoot, workerRoot, exchange, moduleRoot,
    path.join(gitRoot, path.dirname(publicTest)), path.join(gitRoot, path.dirname(productionFile))]
    .map(dir => fs.mkdir(dir, { recursive: true })));
  const json5Package = path.join(parser, 'package.json');
  await fs.writeFile(json5Package, '{}');
  await fs.writeFile(path.join(moduleRoot, 'index.js'), 'module.exports = { parse: JSON.parse };\n');
  const publicTestSource = "import { describe, expect, it } from '@ohos/hypium';\n"
    + "export default function localTest() { describe('Local', () => { it('keeps_order', 0, () => { expect(1).assertEqual(1); }); }); }\n";
  await fs.writeFile(path.join(gitRoot, publicTest), publicTestSource);
  await fs.writeFile(path.join(gitRoot, listFile), originalList);
  await fs.writeFile(path.join(gitRoot, productionFile), baseProduction);
  await fs.writeFile(path.join(gitRoot, 'build-profile.json5'), JSON.stringify({ app: {
    signingConfigs: [{ name: 'fixture' }], products: [{ name: 'default', signingConfig: 'fixture' }],
  } }));
  const git = (...args) => execFileSync('git', ['-C', gitRoot, ...args], { encoding: 'utf8', windowsHide: true }).trim();
  git('init', '--quiet');
  git('config', 'core.autocrlf', 'false');
  git('add', 'build-profile.json5', publicTest, listFile, productionFile);
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
    '-c', 'core.hooksPath=nonexistent', 'commit', '--quiet', '-m', 'public task base');
  const baseCommit = git('rev-parse', 'HEAD');
  const baseTree = git('rev-parse', 'HEAD^{tree}');
  git('clone', '--quiet', '--bare', '.', path.join(cacheRoot, 'test--example.git'));
  // Checkout must preserve byte-bound source even when the host/cache enables
  // Windows line-ending conversion.
  git('--git-dir', path.join(cacheRoot, 'test--example.git'), 'config', 'core.autocrlf', 'true');
  const patch = 'FIXTURE_PRIVATE_GOLD', testPatch = 'FIXTURE_PRIVATE_TEST';
  await fs.writeFile(path.join(dataset, `${id}.json`), JSON.stringify({
    instance_id: id, repo: 'test/example', base_commit: baseCommit, problem_statement: 'Return 2 from Answer while preserving ordering.', hints_text: '',
    patch, patch_sha256: digest(patch), test_patch: testPatch, test_patch_sha256: digest(testPatch),
    FAIL_TO_PASS: ['entry::Private::fixture'], PASS_TO_PASS: ['entry::Private::control'],
  }));
  await createPairedPlan(planDirectory, dataset, 1, undefined, { selectedCases: [id] });
  const planSha256 = digest(await fs.readFile(path.join(planDirectory, 'plan.json')));
  await fs.rm(dataset, { recursive: true });
  const options = { planDirectory, planSha256, releaseCommit, cacheRoot, workspaceRoot, json5Package, selectedCases: [id], timeoutMs: 10_000 };
  return { root, exchange, workerRoot, baseCommit, baseTree, publicTest, publicTestSource, options };
}

function assertPublicCase(report, { baseCommit, baseTree }, state, caseState) {
  assert.equal(report.status, state);
  assert.equal(report.formalPairsAdded, 0);
  assert.equal(report.cases.length, 1);
  const row = report.cases[0];
  assert.equal(row.id, id);
  assert.equal(row.status, caseState);
  assert.equal(row.baseCommit, baseCommit);
  assert.match(row.preparedTree, /^[a-f0-9]{40}$/u);
  assert.notEqual(row.preparedTree, baseTree);
  assert.match(row.snapshotSha256, /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(report), /FIXTURE_PRIVATE_|entry::Private::/u);
  return row;
}

test('prepares the exact public PC checkout without starting a worker job', async t => {
  const context = await fixture(t);
  const { root, exchange, options } = context;
  const report = await runArktsPublicWorkerSmoke({ ...options, outputRoot: path.join(root, 'prepared') });
  assertPublicCase(report, context, 'SNAPSHOTS_PREPARED', 'SNAPSHOT_PREPARED');
  assert.deepEqual(await fs.readdir(exchange), []);
});

test('observes a bound fresh Hypium report and marks an incomplete one unverified through the public exchange', async t => {
  const context = await fixture(t);
  const { root, exchange, workerRoot, publicTest, publicTestSource, options } = context;
  const controller = new AbortController();
  const errors = [], calls = [];
  let raw = completeReport;
  let exitCode = 0;
  const done = serveArktsWorkerJobs(exchange, async (action, input, job) => {
    calls.push({ action, input });
    assert.equal(input.releaseCommit, releaseCommit);
    if (action === 'identity') return { toolchainSha256 };
    assert.equal(action, 'test');
    assert.equal(input.toolchainSha256, toolchainSha256);
    return runArktsWorkerPublicTest(input, job, {
      workspaceRoot: workerRoot,
      async measure({ projectRoot, install, timeoutMs }) {
        assert.equal(install, true);
        assert(timeoutMs > 0);
        assert.equal(await fs.readFile(path.join(projectRoot, publicTest), 'utf8'), publicTestSource);
        assert.deepEqual(await fs.readdir(projectRoot).then(files => files.sort()), ['build-profile.json5', 'entry']);
        const { app } = JSON.parse(await fs.readFile(path.join(projectRoot, 'build-profile.json5'), 'utf8'));
        assert.deepEqual(app.signingConfigs, []);
        assert.deepEqual(app.products, [{ name: 'default', targetSdkVersion: '6.1.1(24)', compatibleSdkVersion: '6.1.1(24)' }]);
        return { execution: { exitCode, interrupted: false, outputComplete: true }, output: compileOutput, raw, freshReport: true };
      },
    });
  }, { signal: controller.signal, pollMs: 5, onError: error => errors.push(error) });
  try {
    const input = { ...options, exchange, toolchainSha256 };
    const observedRoot = path.join(root, 'observed');
    const observed = await runArktsPublicWorkerSmoke({ ...input, outputRoot: observedRoot });
    const complete = assertPublicCase(observed, context, 'PUBLIC_TESTS_OBSERVED', 'PUBLIC_TEST_OBSERVED');
    assert.deepEqual(complete.tests.counts, { PASS: 1 });
    assert.equal(complete.execution.completeRuntime, true);
    assert.equal(complete.execution.snapshotSha256, complete.snapshotSha256);
    assert.equal(complete.coverage.sha256, digest(completeReport));
    await assertCompileOutput(observedRoot, complete, 'compile-output.log');
    assert.equal(await fs.readFile(path.join(observedRoot, complete.coverage.file), 'utf8'), completeReport);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(observedRoot, 'report.json'), 'utf8')), observed);
    raw = reportWithoutEnd;
    const unverified = await runArktsPublicWorkerSmoke({ ...input, outputRoot: path.join(root, 'unverified') });
    const incomplete = assertPublicCase(unverified, context, 'INCOMPLETE', 'PUBLIC_TEST_UNVERIFIED');
    assert.equal(incomplete.execution.completeRuntime, false);
    assert.equal(incomplete.preparedTree, complete.preparedTree);
    assert.equal(incomplete.snapshotSha256, complete.snapshotSha256);

    raw = completeReport;
    exitCode = null;
    const signalled = await runArktsPublicWorkerSmoke({ ...input, outputRoot: path.join(root, 'signalled') });
    const incompleteProcess = assertPublicCase(signalled, context, 'INCOMPLETE', 'PUBLIC_TEST_UNVERIFIED');
    assert.equal(incompleteProcess.execution.exitCode, null);
    assert.equal(incompleteProcess.coverage.sha256, digest(completeReport));

    const mismatchedRoot = path.join(root, 'mismatched');
    await assert.rejects(runArktsPublicWorkerSmoke({ ...input, outputRoot: mismatchedRoot, toolchainSha256: 'c'.repeat(64) }),
      /worker differs from the independently measured toolchain/u);
    await assert.rejects(fs.stat(mismatchedRoot), { code: 'ENOENT' });
    assert.deepEqual(calls.map(({ action }) => action), ['identity', 'test', 'identity', 'test', 'identity', 'test', 'identity']);
    assert.deepEqual(calls.filter(({ action }) => action === 'test').map(({ input }) => input.snapshotSha256),
      [complete.snapshotSha256, complete.snapshotSha256, complete.snapshotSha256]);
    assert.deepEqual(await fs.readdir(workerRoot), []);
    assert.deepEqual(errors, []);
  } finally {
    controller.abort();
    await done;
  }
});

test('qualifies a pinned public probe with separate task-start and repaired snapshots', async t => {
  const context = await fixture(t);
  const { root, exchange, workerRoot, baseCommit, publicTest, publicTestSource, options } = context;
  const manifestPath = path.join(root, 'probe-manifest.json');
  const positiveManifestPath = path.join(root, 'positive-manifest.json');
  const patchFile = 'positive.patch';
  const patchPath = path.join(root, patchFile);
  const probe = 'setting.ets';
  const probePath = path.join(root, probe);
  const probeSource = "import { describe, expect, it } from '@ohos/hypium';\n"
    + "import { answer } from '../main/ets/Answer';\n"
    + "export default function probe(): void { describe('Local', () => { it('probe_case', 0, () => { expect(answer).assertEqual(2); }); }); }\n";
  const testId = 'entry::Local::probe_case';
  const manifest = JSON.stringify({ kind:'arkts-public-probe-qualification-v1', sourceCommit:'c'.repeat(40), planSha256:options.planSha256,
    probes:{ [id]:{ file:probe, sha256:digest(probeSource), testIds:[testId], expectedBase:['FAIL'] } } });
  const patch = [
    `diff --git a/${productionFile} b/${productionFile}`, `--- a/${productionFile}`, `+++ b/${productionFile}`,
    '@@ -1 +1 @@', '-' + baseProduction.trimEnd(), '+' + positiveProduction.trimEnd(), '',
  ].join('\n');
  const patchSha256 = digest(patch);
  const positiveManifest = JSON.stringify({ kind:'arkts-public-positive-controls-v1', planSha256:options.planSha256,
    controls:{ [id]:{ file:patchFile, baseCommit, patchSha256 } } });
  await Promise.all([fs.writeFile(probePath, probeSource), fs.writeFile(manifestPath, manifest), fs.writeFile(patchPath, patch),
    fs.writeFile(positiveManifestPath, positiveManifest)]);

  const invalidManifest = JSON.parse(manifest);
  invalidManifest.probes[id].requirementBindings = [{ testId, quote:'Return two from Answer while preserving ordering.' }];
  const invalidManifestBytes = JSON.stringify(invalidManifest);
  const invalidManifestPath = path.join(root, 'invalid-manifest.json');
  const invalidOutputRoot = path.join(root, 'invalid-smoke');
  await fs.writeFile(invalidManifestPath, invalidManifestBytes);
  await assert.rejects(runArktsPublicWorkerSmoke({ ...options, exchange, toolchainSha256, outputRoot:invalidOutputRoot,
    probeManifest:invalidManifestPath, probeManifestSha256:digest(invalidManifestBytes), signal:AbortSignal.timeout(5000) }),
  /requires an exact quote from security_tool_1/u);
  assert.deepEqual(await fs.readdir(exchange), []);
  await assert.rejects(fs.stat(invalidOutputRoot), { code:'ENOENT' });

  const registeredProbe = path.join(path.dirname(listFile), '__rc_contract_probe.test.ets');
  const originalListBackup = path.join(path.dirname(listFile), '__rc_original_list.test.ets');
  const passingProbeReport = completeReport.replaceAll('keeps_order', 'probe_case');
  const completedProbeReport = passingProbeReport.replace('[pass]', '[fail]').replace('STATUS_CODE: 0', 'STATUS_CODE: -2');
  let probeReport = completedProbeReport;
  let positiveReport = passingProbeReport;
  let probeExitCode = 0;
  let instrumented = false;
  let positiveSuiteSha256 = 'e'.repeat(64);
  let positiveTarget = '127.0.0.1:12001';
  const device = { server:'127.0.0.1:8710', target:'127.0.0.1:12001', api:24, type:'2in1', image:'6.1.0.125', bootReady:true };
  const controller = new AbortController();
  const calls = [], errors = [];
  const done = serveArktsWorkerJobs(exchange, async (action, input, job) => {
    assert.equal(input.releaseCommit, releaseCommit);
    if (action === 'identity') {
      calls.push({ action });
      return { toolchainSha256, ...(instrumented ? { runtime:arktsInstrumentRuntime } : {}) };
    }
    assert.equal(action, 'test');
    assert.equal(input.toolchainSha256, toolchainSha256);
    return runArktsWorkerPublicTest(input, job, { workspaceRoot:workerRoot,
      async measure({ projectRoot }) {
        assert.equal(await copyArktsPublicTestSnapshot(projectRoot), input.snapshotSha256);
        assert.equal(await fs.readFile(path.join(projectRoot, publicTest), 'utf8'), publicTestSource);
        const list = await fs.readFile(path.join(projectRoot, listFile), 'utf8');
        const candidate = list !== originalList;
        const production = await fs.readFile(path.join(projectRoot, productionFile), 'utf8');
        assert([baseProduction, positiveProduction].includes(production));
        const positive = production === positiveProduction;
        assert(!positive || candidate, 'the stock runner must keep the exact task-start source');
        calls.push({ action:positive ? 'positive' : candidate ? 'probe' : 'stock', snapshotSha256:input.snapshotSha256 });
        if (candidate) {
          assert.match(list, /^import contractProbe from '.\/__rc_contract_probe.test'$/mu);
          assert.match(list, /testsuite\(\): void \{ contractProbe\(\) \}/u);
          assert.equal(await fs.readFile(path.join(projectRoot, registeredProbe), 'utf8'), probeSource);
          assert.equal(await fs.readFile(path.join(projectRoot, originalListBackup), 'utf8'), originalList);
        } else {
          await assert.rejects(fs.access(path.join(projectRoot, registeredProbe)), { code:'ENOENT' });
        }
        if (instrumented) return { execution:{ exitCode:0, interrupted:false, outputComplete:true,
          runtime:arktsInstrumentRuntime, snapshotSha256:input.snapshotSha256, compileSucceeded:true,
          device:{ ...device, ...(positive ? { target:positiveTarget } : {}) }, runnerSha256:'a'.repeat(64),
          suiteSha256:positive ? positiveSuiteSha256 : (candidate ? 'e' : 'd').repeat(64), appBuildMode:'test' },
        output:compileOutput, raw:instrumentReport(candidate ? 'probe_case' : 'keeps_order', candidate && !positive), freshReport:true };
        return { execution:{ exitCode:candidate ? probeExitCode : 0, interrupted:false, outputComplete:true }, output:compileOutput,
          raw:positive ? positiveReport : candidate ? probeReport : completeReport, freshReport:true };
      },
    });
  }, { signal:controller.signal, pollMs:5, onError: error => errors.push(error) });
  try {
    const input = { ...options, exchange, toolchainSha256, probeManifest:manifestPath, probeManifestSha256:digest(manifest) };
    const checkedRoot = path.join(root, 'checked');
    const checked = await runArktsPublicWorkerSmoke({ ...input, outputRoot:checkedRoot });
    const row = assertPublicCase(checked, context, 'PUBLIC_TESTS_OBSERVED', 'PUBLIC_TEST_OBSERVED');
    assert.deepEqual(checked.probeManifest, { sha256:digest(manifest), authoredAgainstCommit:'c'.repeat(40) });
    const acceptance = row.acceptance;
    assert.equal(acceptance.source, 'CANDIDATE_MANIFEST');
    assert.equal(acceptance.status, 'FAIL');
    assert.equal(acceptance.matchesExpectedBase, true);
    assert.deepEqual(acceptance.checks, [{ id:testId, status:'FAIL' }]);
    assert.equal(acceptance.probeSha256, digest(probeSource));
    assert.equal(acceptance.coverage.sha256, digest(completedProbeReport));
    assert.deepEqual(acceptance.execution, { exitCode:0, interrupted:false, outputComplete:true, freshReport:true,
      completeRuntime:true, snapshotSha256:acceptance.snapshotSha256, compileOutputSha256:digest(compileOutput) });
    await assertCompileOutput(checkedRoot, acceptance, 'acceptance-compile-output.log');
    assert.equal(await fs.readFile(path.join(checkedRoot, acceptance.coverage.file), 'utf8'), completedProbeReport);
    assert.deepEqual(calls.map(call => call.action), ['identity', 'stock', 'probe']);
    assert.equal(row.snapshotSha256, calls[1].snapshotSha256);
    assert.equal(acceptance.snapshotSha256, calls[2].snapshotSha256);
    assert.notEqual(acceptance.snapshotSha256, row.snapshotSha256);

    probeReport = completeReport;
    const incomplete = await runArktsPublicWorkerSmoke({ ...input, outputRoot:path.join(root, 'missing-probe') });
    assert.equal(incomplete.status, 'INCOMPLETE');
    assert.equal(incomplete.formalPairsAdded, 0);
    assert.equal(incomplete.cases[0].acceptance.status, 'INCOMPLETE');
    assert.equal(incomplete.cases[0].acceptance.matchesExpectedBase, false);
    assert.deepEqual(calls.map(call => call.action), ['identity', 'stock', 'probe', 'identity', 'stock', 'probe']);
    assert.equal(calls[1].snapshotSha256, calls[4].snapshotSha256);
    assert.equal(calls[2].snapshotSha256, calls[5].snapshotSha256);

    probeReport = completedProbeReport;
    probeExitCode = null;
    const signalled = await runArktsPublicWorkerSmoke({ ...input, outputRoot:path.join(root, 'signalled-probe') });
    const badAcceptance = signalled.cases[0].acceptance;
    assert.equal(signalled.status, 'INCOMPLETE');
    assert.equal(badAcceptance.reason, 'REQUIREMENT_PROBE_RUNTIME_INCOMPLETE');
    assert.equal(badAcceptance.coverage.sha256, digest(completedProbeReport));
    assert.equal(badAcceptance.snapshotSha256, null);
    assert.equal(badAcceptance.execution.exitCode, null);
    assert.equal(badAcceptance.execution.snapshotSha256, calls.at(-1).snapshotSha256);
    assert.deepEqual(badAcceptance.checks, [{ id:testId, status:'UNAVAILABLE' }]);

    const positiveOptions = { ...input, positiveManifest:positiveManifestPath, positiveManifestSha256:digest(positiveManifest) };
    probeExitCode = 0;
    const qualifiedRoot = path.join(root, 'qualified');
    const qualified = await runArktsPublicWorkerSmoke({ ...positiveOptions, outputRoot:qualifiedRoot });
    const repaired = assertPublicCase(qualified, context, 'PUBLIC_TESTS_OBSERVED', 'PUBLIC_TEST_OBSERVED');
    assert.equal(repaired.qualification, 'BASE_AND_POSITIVE_MATCHED');
    assert.equal(repaired.acceptance.status, 'FAIL');
    assert.equal(repaired.positive.status, 'PASS');
    assert.equal(repaired.positive.patchSha256, patchSha256);
    assert.deepEqual(repaired.positive.paths, [productionFile]);
    assert.match(repaired.positive.tree, /^[a-f0-9]{40}$/u);
    assert.notEqual(repaired.positive.tree, repaired.preparedTree);
    assert.deepEqual(repaired.positive.checks, [{ id:testId, status:'PASS' }]);
    assert.equal(repaired.positive.execution.snapshotSha256, repaired.positive.snapshotSha256);
    await assertCompileOutput(qualifiedRoot, repaired.positive, 'positive-compile-output.log');
    assert.deepEqual(calls.slice(-4).map(call => call.action), ['identity', 'stock', 'probe', 'positive']);
    assert.deepEqual(calls.slice(-3).map(call => call.snapshotSha256),
      [repaired.snapshotSha256, repaired.acceptance.snapshotSha256, repaired.positive.snapshotSha256]);
    assert.equal(new Set(calls.slice(-3).map(call => call.snapshotSha256)).size, 3);
    const publicCache = path.join(options.cacheRoot, 'test--example.git');
    const repairedBlob = execFileSync('git', ['--git-dir', publicCache, 'hash-object', '--stdin'],
      { input:positiveProduction, encoding:'utf8', windowsHide:true }).trim();
    assert.throws(() => execFileSync('git', ['--git-dir', publicCache, 'cat-file', '-e', repairedBlob],
      { stdio:'pipe', windowsHide:true }), { status:1 }, 'the original public cache must not learn repaired control objects');

    positiveReport = completeReport;
    const invalidPositive = await runArktsPublicWorkerSmoke({ ...positiveOptions, outputRoot:path.join(root, 'missing-positive') });
    assert.equal(invalidPositive.status, 'INCOMPLETE');
    assert.equal(invalidPositive.cases[0].acceptance.status, 'FAIL');
    assert.equal(invalidPositive.cases[0].positive.status, 'INCOMPLETE');
    assert.notEqual(invalidPositive.cases[0].qualification, 'BASE_AND_POSITIVE_MATCHED');

    instrumented = true;
    const instrumentedRoot = path.join(root, 'qualified-instrumented');
    const native = await runArktsPublicWorkerSmoke({ ...positiveOptions, outputRoot:instrumentedRoot });
    const nativeCase = assertPublicCase(native, context, 'PUBLIC_TESTS_OBSERVED', 'PUBLIC_TEST_OBSERVED');
    assert.equal(native.runtime, arktsInstrumentRuntime);
    assert.equal(nativeCase.qualification, 'BASE_AND_POSITIVE_MATCHED');
    for (const [assay, prefix] of [[nativeCase, ''], [nativeCase.acceptance, 'acceptance-'], [nativeCase.positive, 'positive-']]) {
      assert.equal(assay.execution.runtime, native.runtime);
      assert.deepEqual(assay.execution.device, device);
      assert.equal(assay.execution.runnerSha256, 'a'.repeat(64));
      assert.equal(assay.execution.appBuildMode, 'test');
      assert.equal(assay.execution.compileSucceeded, true);
      assert.equal(assay.execution.completeRuntime, true);
      assert.equal(assay.execution.snapshotSha256, assay.snapshotSha256);
      const raw = await fs.readFile(path.join(instrumentedRoot, assay.coverage.file));
      assert.equal(assay.coverage.sha256, digest(raw));
      await assertCompileOutput(instrumentedRoot, assay, prefix + 'compile-output.log');
    }
    assert.notEqual(nativeCase.execution.suiteSha256, nativeCase.acceptance.execution.suiteSha256);
    assert.equal(nativeCase.acceptance.execution.suiteSha256, nativeCase.positive.execution.suiteSha256);
    const { inputs } = await verifyPublicPairedPlan(options.planDirectory, options.planSha256);
    const reportFile = path.join(instrumentedRoot, 'report.json');
    const registry = await loadArktsQualifiedAcceptance({ reportFile, reportSha256:digest(await fs.readFile(reportFile)),
      probeManifest:manifestPath, probeManifestSha256:digest(manifest), positiveManifest:positiveManifestPath,
      positiveManifestSha256:digest(positiveManifest), planSha256:options.planSha256, releaseCommit, toolchainSha256,
      runtime:arktsInstrumentRuntime, inputs });
    assert.equal(registry.checks.get(id).sha256, digest(probeSource));
    assert.deepEqual(registry.checks.get(id).testIds, [testId]);

    positiveSuiteSha256 = 'f'.repeat(64);
    const suiteChanged = await runArktsPublicWorkerSmoke({ ...positiveOptions, outputRoot:path.join(root, 'changed-suite') });
    assert.equal(suiteChanged.status, 'INCOMPLETE');
    assert.equal(suiteChanged.cases[0].positive.status, 'PASS');
    assert.equal(suiteChanged.cases[0].qualification, 'POSITIVE_CONTROL_UNVERIFIED');
    positiveSuiteSha256 = 'e'.repeat(64);

    positiveTarget = '127.0.0.1:12002';
    const deviceChanged = await runArktsPublicWorkerSmoke({ ...positiveOptions, outputRoot:path.join(root, 'changed-device') });
    assert.equal(deviceChanged.status, 'INCOMPLETE');
    assert.equal(deviceChanged.cases[0].positive.status, 'INCOMPLETE');
    assert.equal(deviceChanged.cases[0].positive.reason, 'PUBLIC_TEST_WORKER_EXECUTION_UNVERIFIED');
    assert.equal(deviceChanged.cases[0].positive.execution.device.target, positiveTarget);

    const originalTestPath = listFile.split(path.sep).join('/');
    const testPatch = [
      `diff --git a/${originalTestPath} b/${originalTestPath}`, `--- a/${originalTestPath}`, `+++ b/${originalTestPath}`,
      '@@ -1,2 +1,2 @@', " import localTest from './Local.test'",
      '-export default function testsuite(): void { localTest() }', '+export default function testsuite(): void {}', '',
    ].join('\n');
    const testPatchManifest = JSON.stringify({ kind:'arkts-public-positive-controls-v1', planSha256:options.planSha256,
      controls:{ [id]:{ file:patchFile, baseCommit, patchSha256:digest(testPatch) } } });
    await Promise.all([fs.writeFile(patchPath, testPatch), fs.writeFile(positiveManifestPath, testPatchManifest)]);
    const callsBeforeTestPatch = calls.length;
    await assert.rejects(runArktsPublicWorkerSmoke({ ...positiveOptions, positiveManifestSha256:digest(testPatchManifest),
      outputRoot:path.join(root, 'test-patch') }), /positive patch.*entry\/src\/main\//iu);
    assert(calls.slice(callsBeforeTestPatch).every(call => call.action !== 'positive'));
    await Promise.all([fs.writeFile(patchPath, patch), fs.writeFile(positiveManifestPath, positiveManifest)]);

    const tamperedRoot = path.join(root, 'tampered');
    const dispatchCount = calls.length;
    await fs.appendFile(patchPath, '\n');
    await assert.rejects(runArktsPublicWorkerSmoke({ ...positiveOptions, outputRoot:tamperedRoot }), /positive.*(?:trusted|SHA-256|digest)/iu);
    await fs.appendFile(manifestPath, '\n');
    await assert.rejects(runArktsPublicWorkerSmoke({ ...input, outputRoot:tamperedRoot }),
      /probe manifest differs from its trusted digest/u);
    await fs.writeFile(manifestPath, manifest);
    await fs.appendFile(probePath, '\n');
    await assert.rejects(runArktsPublicWorkerSmoke({ ...input, outputRoot:tamperedRoot }),
      /Public probe differs from its trusted digest/u);
    assert.equal(calls.length, dispatchCount);
    await assert.rejects(fs.stat(tamperedRoot), { code:'ENOENT' });
    assert.deepEqual(await fs.readdir(options.workspaceRoot), []);
    assert.deepEqual(await fs.readdir(workerRoot), []);
    assert.deepEqual(errors, []);
  } finally {
    controller.abort();
    await done;
  }
});
