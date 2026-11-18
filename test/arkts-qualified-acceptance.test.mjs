import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { digest } from '../scripts/bench/arkts-dataset.mjs';
import { arktsInstrumentRuntime } from '../scripts/bench/arkts-instrument-results.mjs';
import { arktsPublicAcceptanceIdentity, loadArktsPublicAcceptance } from '../scripts/bench/arkts-public-acceptance.mjs';
import { loadArktsQualifiedAcceptance } from '../scripts/bench/arkts-qualified-acceptance.mjs';

const candidateId = 'security_tool_2';
const registeredId = 'security_tool_3';
const patchPath = 'entry/src/main/ets/Example.ets';
const ownProbe = 'export default function acceptance(): void {}\n';
const registeredPublic = {
  instance_id: registeredId,
  repo: 'Deslord319/security_tool',
  base_commit: '04e0d1996cd99b6191f1c17f93a8198008f2f71c',
  problem_statement: 'Log manage page stays "initialized" after a failed initialization\n\n'
    + 'Opening the log manage page initializes its log storage and then loads a\n'
    + 'snapshot of the entries. When the storage fails to initialize, the page still\n'
    + 'latches its initialized state: it keeps activating and refreshing as if\n'
    + "nothing went wrong, and retrying the initialization has no effect, so the\n"
    + 'logs never load.\n\n'
    + 'A failed initialization should leave the page uninitialized and skip loading\n'
    + 'the snapshot, so that initialization can be retried. A retry that succeeds\n'
    + 'should then load the snapshot once, as normal.',
  hints_text: '',
};
const asJson = value => JSON.stringify(value, null, 2) + '\n';
const repeated = (text, size = 64) => text.repeat(size);

function localReport(checks) {
  const cases = checks.flatMap(({ id, status }) => {
    const [, group, name] = id.split('::');
    return ["[Hypium]start running case '" + name + "'", 'OHOS_REPORT_STATUS: class=' + group,
      '[Hypium][' + status.toLowerCase() + ']' + name + ' ; consuming 1ms', 'OHOS_REPORT_STATUS: class=' + group,
      'OHOS_REPORT_STATUS: test=' + name, 'OHOS_REPORT_STATUS_CODE: ' + (status === 'PASS' ? 0 : -2)];
  });
  return [...cases, '[Hypium][end] run suites end', ''].join('\n');
}

function deviceReport(checks) {
  const frames = checks.flatMap(({ id, status }, index) => {
    const [, group, name] = id.split('::');
    const frame = [
      'OHOS_REPORT_STATUS: class=' + group, 'OHOS_REPORT_STATUS: current=' + (index + 1), 'OHOS_REPORT_STATUS: id=JS',
      'OHOS_REPORT_STATUS: numtests=' + checks.length, 'OHOS_REPORT_STATUS: test=' + name,
    ];
    return [...frame, 'OHOS_REPORT_STATUS_CODE: 1', ...frame, 'OHOS_REPORT_STATUS_CODE: ' + (status === 'PASS' ? 0 : -2)];
  });
  const errors = checks.filter(check => check.status === 'FAIL').length;
  const summary = 'OHOS_REPORT_RESULT: stream=Tests run: ' + checks.length + ', Failure: ' + errors
    + ', Error: 0, Pass: ' + (checks.length - errors) + ', Ignore: 0';
  return [...frames, summary, 'OHOS_REPORT_CODE: ' + (errors ? -1 : 0),
    'TestFinished-ResultCode: 0', 'user test finished.', ''].join('\n');
}

async function fixture(t, { runtime, includeRegistered = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'arkts-qualified-probe-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (name, data) => {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, data);
    return { file: name, sha256: digest(data) };
  };
  const planSha256 = repeated('a'), releaseCommit = repeated('b', 40), toolchainSha256 = repeated('c');
  const candidate = { instance_id: candidateId, repo: 'Owner/example', base_commit: repeated('d', 40),
    problem_statement: 'Correct the application while preserving other behavior.', hints_text: '' };
  const inputs = [candidate, ...(includeRegistered ? [registeredPublic] : [])].map(task => ({
    id: task.instance_id, task, publicBytes: Buffer.from(asJson(task)),
  }));
  const probeBytes = await write('probe.ets', ownProbe);
  const registry = { kind: 'arkts-public-probe-qualification-v1', planSha256, sourceCommit: releaseCommit,
    probes: { [candidateId]: { ...probeBytes, testIds: ['entry::Policy::does_write', 'entry::Policy::preserves_unrelated'],
      expectedBase: ['FAIL', 'PASS'] } } };
  const positives = { kind: 'arkts-public-positive-controls-v1', planSha256, controls: {} };
  const cases = [];
  const compileOutput = 'Finished :entry:default@UnitTestArkTS\n';
  for (const { id, task, publicBytes } of inputs) {
    const base = registry.probes[id];
    const registered = await loadArktsPublicAcceptance(task, digest(publicBytes));
    const { sha256, testIds } = base ?? registered;
    const source = base ? 'CANDIDATE_MANIFEST' : 'REGISTERED';
    const snapshots = ['original', 'base', 'positive'].map(phase => digest(id + '/' + phase));
    const phase = async (prefix, slot, checks) => {
      const coverage = await write(id + '/' + prefix + 'coverage.log', (runtime ? deviceReport : localReport)(checks));
      const compile = await write(id + '/' + prefix + 'compile-output.log', compileOutput);
      return { coverage, compileOutput: compile, execution: {
        exitCode: 0, interrupted: false, outputComplete: true, freshReport: true, completeRuntime: true,
        snapshotSha256: snapshots[slot], compileOutputSha256: compile.sha256,
        ...(runtime ? { runtime, compileSucceeded: true, device: { target: 'fixture-device' },
          runnerSha256: repeated('e'), suiteSha256: slot ? repeated('a') : repeated('b'), appBuildMode: 'test' } : {}),
      } };
    };
    const originalId = 'entry::Original::existing_case';
    const original = await phase('', 0, [{ id: originalId, status: 'PASS' }]);
    const failed = testIds.map((id, index) => ({ id, status: index ? 'PASS' : 'FAIL' }));
    const passed = testIds.map(id => ({ id, status: 'PASS' }));
    const patch = await write(id + '.patch', 'Fixture production patch for ' + id);
    positives.controls[id] = { file: patch.file, patchSha256: patch.sha256, baseCommit: task.base_commit };
    cases.push({ id, baseCommit: task.base_commit, publicInputSha256: digest(publicBytes), preparedTree: repeated('b', 40),
      snapshotSha256: snapshots[0], status: 'PUBLIC_TEST_OBSERVED', qualification: 'BASE_AND_POSITIVE_MATCHED', ...original,
      tests: { observed: 1, counts: { PASS: 1 }, allObservedPassed: true, publicInventorySha256: digest(JSON.stringify([originalId])) },
      acceptance: { ...(await phase('acceptance-', 1, failed)), source, status: 'FAIL', probeSha256: sha256,
        checks: failed, snapshotSha256: snapshots[1], ...(base ? { expectedBase: base.expectedBase, matchesExpectedBase: true } : {}) },
      positive: { ...(await phase('positive-', 2, passed)), source, status: 'PASS', probeSha256: sha256,
        checks: passed, snapshotSha256: snapshots[2], tree: repeated('f', 40), paths: [patchPath], patchSha256: patch.sha256 },
    });
  }
  const positiveManifest = await write('positive.json', asJson(positives));
  async function pinned({ changeReport, changeRegistry } = {}) {
    const candidateManifest = structuredClone(registry);
    changeRegistry?.(candidateManifest);
    const probe = await write('probes.json', asJson(candidateManifest));
    const report = { kind: 'arkts-public-test-worker-smoke-v1', status: 'PUBLIC_TESTS_OBSERVED', releaseCommit, planSha256,
      toolchainSha256, ...(runtime ? { runtime } : {}),
      probeManifest: { sha256: probe.sha256, authoredAgainstCommit: candidateManifest.sourceCommit },
      positiveManifest: { sha256: positiveManifest.sha256 }, cases: structuredClone(cases), formalPairsAdded: 0 };
    changeReport?.(report);
    const pinnedReport = await write('report.json', asJson(report));
    return { reportFile: path.join(root, pinnedReport.file), reportSha256: pinnedReport.sha256,
      probeManifest: path.join(root, probe.file), probeManifestSha256: probe.sha256,
      positiveManifest: path.join(root, positiveManifest.file), positiveManifestSha256: positiveManifest.sha256,
      planSha256, releaseCommit, toolchainSha256, runtime, inputs };
  }
  return { root, inputs, pinned, write };
}

test('qualified native Local Test controls project only supplemental authority and permit separate registered rows', async t => {
  const { pinned, inputs } = await fixture(t, { includeRegistered: true });
  const options = await pinned();
  const { qualification, checks } = await loadArktsQualifiedAcceptance(options);
  assert.deepEqual(qualification, { reportSha256: options.reportSha256, probeManifestSha256: options.probeManifestSha256,
    positiveManifestSha256: options.positiveManifestSha256, toolchainSha256: options.toolchainSha256 });
  assert.deepEqual([...checks.keys()], [candidateId]);
  const descriptor = checks.get(candidateId);
  assert.equal(descriptor.probeBytes.toString(), ownProbe);
  assert.deepEqual(descriptor.requirementBindings, []);
  assert.equal(descriptor.identitySha256, arktsPublicAcceptanceIdentity(digest(inputs[0].publicBytes), descriptor));
});

test('qualified probe bindings must name a pinned case and quote the frozen original task', async t => {
  const { pinned, inputs } = await fixture(t);
  const binding = { testId:'entry::Policy::does_write', quote:inputs[0].task.problem_statement };
  const withBindings = bindings => pinned({ changeRegistry: registry => {
    registry.probes[candidateId].requirementBindings = bindings;
  } });
  const qualified = await loadArktsQualifiedAcceptance(await withBindings([binding]));
  const check = qualified.checks.get(candidateId);
  assert.deepEqual(check.requirementBindings, [binding]);
  assert.equal(check.identitySha256, arktsPublicAcceptanceIdentity(digest(inputs[0].publicBytes), check));
  assert.notEqual(check.identitySha256, arktsPublicAcceptanceIdentity(digest(inputs[0].publicBytes), { ...check, requirementBindings:[] }));
  await assert.rejects(loadArktsQualifiedAcceptance(await withBindings([{ ...binding, quote:'Paraphrased requirement.' }])), /exact quote/u);
  await assert.rejects(loadArktsQualifiedAcceptance(await withBindings([{ ...binding, testId:'entry::Policy::unknown' }])), /must uniquely name/u);
  await assert.rejects(loadArktsQualifiedAcceptance(await withBindings([binding, binding])), /must uniquely name/u);
});

test('qualified Instrument Test evidence preserves the exact backend, runner, device, and probe suite', async t => {
  const { pinned } = await fixture(t, { runtime: arktsInstrumentRuntime });
  assert.equal((await loadArktsQualifiedAcceptance(await pinned())).qualification.runtime, arktsInstrumentRuntime);
  for (const [field, value, message] of [
    ['device', { target: 'other-device' }, /different devices/u],
    ['runnerSha256', repeated('d'), /different runners/u],
    ['appBuildMode', 'debug', /different app build modes/u],
    ['suiteSha256', repeated('d'), /different test suites/u],
  ]) {
    const options = await pinned({ changeReport: report => { report.cases[0].positive.execution[field] = value; } });
    await assert.rejects(loadArktsQualifiedAcceptance(options), message);
  }
});

test('unqualified, mismatched, or changed artifacts cannot activate a supplemental probe', async t => {
  const { pinned, write } = await fixture(t);
  for (const [changeReport, message] of [
    [report => { report.status = 'INCOMPLETE'; }, /terminal native/u],
    [report => { report.planSha256 = repeated('e'); }, /different paired plan/u],
    [report => { report.releaseCommit = repeated('e', 40); }, /different release/u],
    [report => { report.toolchainSha256 = repeated('e'); }, /different toolchain/u],
    [report => { report.runtime = arktsInstrumentRuntime; }, /different runtime/u],
    [report => { report.cases[0].baseCommit = repeated('e', 40); }, /different task base/u],
    [report => { report.cases[0].publicInputSha256 = repeated('e'); }, /different public task input/u],
    [report => { report.cases = []; }, /exactly one native result/u],
    [report => { report.cases.push(report.cases[0]); }, /exactly one native result/u],
    [report => { delete report.cases[0].acceptance.execution; }, /complete native execution/u],
    [report => { report.cases[0].positive.snapshotSha256 = report.cases[0].acceptance.snapshotSha256; }, /distinct task-start/u],
    [report => { report.cases[0].positive.patchSha256 = repeated('e'); }, /different positive patch/u],
    [report => { report.cases[0].positive.paths.push('entry/src/test/Probe.ets'); }, /production paths/u],
    [report => { report.cases[0].acceptance.checks.reverse(); }, /differs from its raw test results/u],
    [report => { report.cases[0].acceptance.expectedBase.reverse(); }, /expected base vector/u],
    [report => { report.cases[0].positive.execution.compiled = false; report.cases[0].positive.execution.outputComplete = false; },
      /complete native execution/u],
  ]) {
    await assert.rejects(loadArktsQualifiedAcceptance(await pinned({ changeReport })), message);
  }
  const options = await pinned();
  await assert.rejects(loadArktsQualifiedAcceptance({ ...options, reportSha256: repeated('e') }), /trusted digest/u);
  await write(candidateId + '/positive-coverage.log', 'changed public coverage\n');
  await assert.rejects(loadArktsQualifiedAcceptance(options), /differs from its pinned digest/u);
});

test('native smoke compilation proof is independently parsed and registered probes cannot be replaced', async t => {
  const { pinned, write } = await fixture(t, { includeRegistered: true });
  const options = await pinned({ changeRegistry: manifest => {
    manifest.probes[registeredId] = structuredClone(manifest.probes[candidateId]);
  } });
  await assert.rejects(loadArktsQualifiedAcceptance(options), /cannot replace a registered acceptance check/u);
  const invalid = await write(candidateId + '/acceptance-compile-output.log', 'Build failed\n');
  const invalidCompile = await pinned({ changeReport: report => {
    const phase = report.cases[0].acceptance;
    phase.compileOutput = invalid;
    phase.execution.compileOutputSha256 = invalid.sha256;
  } });
  await assert.rejects(loadArktsQualifiedAcceptance(invalidCompile), /did not compile and finish/u);
});
