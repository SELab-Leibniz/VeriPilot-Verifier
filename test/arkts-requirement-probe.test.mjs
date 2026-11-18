import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { runArktsRequirementProbe } from '../scripts/bench/arkts-regression-check.mjs';
import { serveArktsWorkerJobs } from '../scripts/bench/arkts-worker-exchange.mjs';
import { createArktsBenchTools } from '../scripts/bench/native-arkts-tools.mjs';

const run = promisify(execFile);
const wrapper = fileURLToPath(new URL('../scripts/bench/arkts-stop-contract-check.mjs', import.meta.url));
const sha = data => createHash('sha256').update(data).digest('hex');
const p2pId = 'entry::Example::existing';
const reqIds = ['entry::Example::required success', 'entry::Example::required failure'];

function runtimeReport(cases) {
  return cases.flatMap(([title, status]) => [
    `[Hypium]start running case '${title}'`, 'OHOS_REPORT_STATUS: class=Example',
    `[Hypium][${status}]${title} ; consuming 1ms`, 'OHOS_REPORT_STATUS: class=Example',
    `OHOS_REPORT_STATUS: test=${title}`, `OHOS_REPORT_STATUS_CODE: ${status === 'pass' ? 0 : -2}`,
  ]).concat('[Hypium][end] run suites end').join('\n');
}

function receipts(output, kind) {
  return output.split(/\r?\n/u).filter(line => line.startsWith(`${kind} `)).map(line => JSON.parse(line.slice(kind.length + 1)));
}

test('the pinned requirement runs independently of the original inventory, and triage only runs P2P', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'arkts-requirement-probe-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project'), exchange = path.join(root, 'exchange');
  const baseline = path.join(root, 'baseline.json'), javaHome = path.join(root, 'java');
  const probe = path.join(root, 'probe.ets'), originalList = path.join('entry', 'src', 'test', 'List.test.ets');
  const probeBytes = Buffer.from('export default function contractCase(): void {}\n');
  await Promise.all([path.join(project, path.dirname(originalList)), exchange, path.join(javaHome, 'bin')]
    .map(dir => fs.mkdir(dir, { recursive: true })));
  await Promise.all([fs.writeFile(path.join(project, originalList), probeBytes), fs.writeFile(probe, probeBytes),
    fs.writeFile(path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'), '')]);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
    '-c', 'commit.gpgsign=false', ...args], { cwd: project, encoding: 'utf8', windowsHide: true });
  git('init', '-q'); git('add', '--', originalList); git('commit', '-qm', 'original');
  await fs.writeFile(baseline, JSON.stringify({ completeRuntime: true, baseCommit: git('rev-parse', 'HEAD').trim(), statuses: { [p2pId]: 'PASS' } }));
  const publicTestWorker = { exchange, toolchainSha256: 'a'.repeat(64), releaseCommit: 'b'.repeat(40) };
  const mismatch = await runArktsRequirementProbe({ project, probe, sha256: '0'.repeat(64), testIds: reqIds, publicTestWorker });
  assert.deepEqual(mismatch, { sha256: '0'.repeat(64), status: 'INCOMPLETE', exitCode: 2,
    checks: reqIds.map(id => ({ id, status: 'UNAVAILABLE' })), reason: 'REQUIREMENT_PROBE_SHA_MISMATCH' });
  assert.deepEqual(await fs.readdir(exchange), []);

  const jobs = [], requirementSnapshots = [], errors = [], controller = new AbortController();
  let compileOutput, passesRequirement = false;
  const worker = serveArktsWorkerJobs(exchange, async (action, input, job) => {
    assert.equal(action, 'test');
    const runner = await fs.readFile(path.join(job.directory, 'source', originalList), 'utf8');
    const requirement = runner.includes('__rc_contract_probe');
    jobs.push(requirement ? 'requirement' : 'p2p');
    if (requirement) {
      const supplied = path.join(job.directory, 'source', path.dirname(originalList), '__rc_contract_probe.test.ets');
      assert.equal(sha(await fs.readFile(supplied)), sha(probeBytes));
      requirementSnapshots.push(input.snapshotSha256);
    }
    if (requirement && compileOutput !== undefined) return { input,
      execution: { interrupted: false, exitCode: 255, outputComplete: false, compileSucceeded: false },
      output: compileOutput, raw: '', freshReport: false };
    const cases = requirement ? [['required success', 'pass'], ['required failure', passesRequirement ? 'pass' : 'fail']] : [['existing', 'pass']];
    return { input, execution: { interrupted: false, exitCode: 0, outputComplete: true },
      output: 'Finished :entry:default@UnitTestArkTS', raw: runtimeReport(cases), freshReport: true };
  }, { signal: controller.signal, pollMs: 5, onError: error => errors.push(error) });

  const invoke = (args, extraEnv = {}) => run(process.execPath, [wrapper, `--project=${project}`,
    `--tool-root=${root}`, `--java-home=${javaHome}`, ...args], { windowsHide: true, env: { ...process.env,
    RC_REGRESSION_DEADLINE_AT: '', RC_ARKTS_INSTRUMENT: '', RC_ARKTS_TEST_EXCHANGE: exchange,
    RC_ARKTS_TEST_TOOLCHAIN_SHA256: publicTestWorker.toolchainSha256, RC_ARKTS_TEST_RELEASE_COMMIT: publicTestWorker.releaseCommit,
    ...extraEnv } });
  const probeArgs = (ids, pin = sha(probeBytes)) => [`--requirement-probe=${probe}`, `--requirement-probe-sha256=${pin}`,
    ...ids.map(id => `--requirement-test=${id}`)];
  const cli = (ids, mode = [], extraEnv = {}) => invoke([`--baseline=${baseline}`, '--max-names=0', ...probeArgs(ids), ...mode], extraEnv);
  try {
    const { stdout } = await cli(reqIds);
    assert.deepEqual(receipts(stdout, 'RC_REGRESSION_INVENTORY'), [{ complete: true, failures: [] }]);
    assert.deepEqual(receipts(stdout, 'RC_REQUIREMENT_PROBE'), [{ sha256: sha(probeBytes), status: 'FAIL',
      checks: [{ id: reqIds[0], status: 'PASS' }, { id: reqIds[1], status: 'FAIL' }], snapshotSha256: requirementSnapshots[0] }]);
    assert.match(requirementSnapshots[0], /^[a-f0-9]{64}$/u);
    const incomplete = await cli([reqIds[1]]);
    assert.deepEqual(receipts(incomplete.stdout, 'RC_REQUIREMENT_PROBE'), [{ sha256: sha(probeBytes), status: 'INCOMPLETE',
      checks: [{ id: reqIds[1], status: 'FAIL' }] }]);
    for (const mode of [[`--isolate-test=${p2pId}`], ['--exclude-cases=absent.json']]) {
      await assert.rejects(cli(reqIds, mode, { RC_REGRESSION_DEADLINE_AT: String(Date.now() - 5000) }), error => {
        assert.equal(error.code, 2);
        assert.deepEqual(receipts(error.stdout, 'RC_REQUIREMENT_PROBE'), []);
        const kind = mode[0].startsWith('--isolate') ? 'RC_REGRESSION_CASE' : 'RC_REGRESSION_INVENTORY';
        assert.equal(receipts(error.stdout, kind).length, 1);
        return true;
      });
    }
    assert.deepEqual(jobs, ['p2p', 'requirement', 'p2p', 'requirement']);

    await t.test('requirement-only launches just the pinned case inventory and reports the probe exit code', async () => {
      const jobStart = jobs.length;
      const only = args => invoke(['--requirement-only', ...args]);
      const singleReceipt = async (args, expectedExit) => {
        let output;
        if (expectedExit === 0) ({ stdout: output } = await only(args));
        else await assert.rejects(only(args), error => {
          assert.equal(error.code, expectedExit, error.stderr);
          output = error.stdout;
          return true;
        });
        const reports = receipts(output, 'RC_REQUIREMENT_PROBE');
        assert.equal(reports.length, 1);
        assert.equal(output.trimEnd().split('\n').length, 1, 'no original-suite or legacy report');
        return reports[0];
      };
      passesRequirement = true;
      const pass = await singleReceipt(probeArgs(reqIds), 0);
      assert.deepEqual(pass, { sha256: sha(probeBytes), status: 'PASS', checks: reqIds.map(id => ({ id, status: 'PASS' })),
        snapshotSha256: requirementSnapshots.at(-1) });
      assert.match(pass.snapshotSha256, /^[a-f0-9]{64}$/u);
      passesRequirement = false;
      const absentBaseline = path.join(root, 'absent-baseline.json');
      const fail = await singleReceipt([...probeArgs(reqIds), `--baseline=${absentBaseline}`], 1);
      assert.deepEqual(fail, { sha256: sha(probeBytes), status: 'FAIL',
        checks: [{ id: reqIds[0], status: 'PASS' }, { id: reqIds[1], status: 'FAIL' }], snapshotSha256: pass.snapshotSha256 });
      const incomplete = await singleReceipt(probeArgs([reqIds[1]]), 2);
      assert.deepEqual(incomplete, { sha256: sha(probeBytes), status: 'INCOMPLETE', checks: [{ id: reqIds[1], status: 'FAIL' }] });
      const stalePin = '0'.repeat(64);
      assert.deepEqual(await singleReceipt(probeArgs(reqIds, stalePin), 2), { sha256: stalePin, status: 'INCOMPLETE',
        checks: reqIds.map(id => ({ id, status: 'UNAVAILABLE' })) });

      for (const args of [
        probeArgs(reqIds).filter(arg => !arg.startsWith('--requirement-probe-sha256=')),
        probeArgs([]),
        ...[`--isolate-test=${p2pId}`, '--exclude-cases=absent.json', `--contract-probe=${probe}`, `--contract-baseline=${baseline}`]
          .map(mode => [...probeArgs(reqIds), mode]),
      ]) await assert.rejects(only(args), error => {
        assert.equal(receipts(error.stdout, 'RC_REQUIREMENT_PROBE').length, 0);
        assert.equal(receipts(error.stdout, 'RC_REGRESSION_INVENTORY').length, 0);
        return true;
      });
      assert.deepEqual(jobs.slice(jobStart), ['requirement', 'requirement', 'requirement']);
    });

    await t.test('regression-only runs the original suite and ignores the supplied pinned probe', async () => {
      const jobStart = jobs.length;
      const only = args => invoke(['--regression-only', ...args]);
      const pinned = probeArgs(reqIds);
      const original = [`--baseline=${baseline}`, ...pinned];
      const { stdout: regression } = await only(original);
      assert.match(regression, /^RC_REGRESSION_CHECK PASS\b/mu);
      assert.deepEqual(receipts(regression, 'RC_REGRESSION_INVENTORY'), [{ complete: true, failures: [] }]);
      assert.doesNotMatch(regression, /^RC_(REQUIREMENT_(?:PROBE|CHECK)|CONTRACT_CHECK)\b/mu);

      const absentBaseline = path.join(root, 'absent-baseline.json');
      for (const args of [
        pinned,
        [`--baseline=${absentBaseline}`, ...pinned],
        ...['--requirement-only', `--isolate-test=${p2pId}`, '--exclude-cases=absent.json',
          `--contract-probe=${probe}`, `--contract-baseline=${baseline}`].map(mode => [...original, mode]),
      ]) await assert.rejects(only(args), error => {
        assert.equal(receipts(error.stdout, 'RC_REQUIREMENT_PROBE').length, 0);
        assert.equal(receipts(error.stdout, 'RC_REGRESSION_INVENTORY').length, 0);
        return true;
      });
      assert.deepEqual(jobs.slice(jobStart), ['p2p']);
    });

    const typeError = "Argument of type 'GenerationOutcome' is not assignable to parameter of type 'GeneratedPuzzle'.";
    compileOutput = [`\x1b[31mError Message: ${typeError} At File: /tmp/worker/probe.ets:12:5\x1b[0m`,
      ...Array.from({ length: 14 }, () => 'ERROR: unrelated build summary')].join('\n');
    const acceptance = { probe, sha256: sha(probeBytes), testIds: reqIds };
    const probeOptions = { project, toolRoot: root, javaHome, ...acceptance, publicTestWorker };
    const failedBuild = await runArktsRequirementProbe(probeOptions);
    assert.equal(failedBuild.status, 'INCOMPLETE');
    assert.equal(failedBuild.reason, 'REQUIREMENT_PROBE_COMPILE_FAILED');
    assert.deepEqual(failedBuild.observed, []);
    assert.deepEqual(failedBuild.checks, reqIds.map(id => ({ id, status: 'UNAVAILABLE' })));
    assert.deepEqual(failedBuild.diagnostics, [typeError]);
    compileOutput = 'ERROR: dependency installation failed';
    const incompleteBuild = await runArktsRequirementProbe(probeOptions);
    assert.equal(incompleteBuild.reason, 'REQUIREMENT_PROBE_BUILD_INCOMPLETE');
    assert.equal(incompleteBuild.diagnostics, undefined);

    const token = 'fixture-local-value-for-redaction';
    const existing = process.env.RC_EVAL_API_KEY;
    process.env.RC_EVAL_API_KEY = token;
    t.after(() => { if (existing === undefined) delete process.env.RC_EVAL_API_KEY; else process.env.RC_EVAL_API_KEY = existing; });
    const prefix = 'x'.repeat(298);
    compileOutput = [`Error Message: ${prefix} ${token}`, ...Array.from({ length: 6 }, () => `Error Message: ${typeError}`)].join('\n');
    const plugin = await createArktsBenchTools({ outputRoot: root, projectRoot: project, toolRoot: root, javaHome,
      stableNavigationRoot: process.cwd(), publicAcceptance: acceptance, publicTestWorker });
    const tools = [];
    (await import(pathToFileURL(path.join(plugin.path, 'index.mjs')).href)).default.register({
      registerTool: factory => tools.push(factory({ sessionKey: 'agent:main:business' })),
    });
    const tool = tools.find(tool => tool.name === 'bench_check');
    const { content } = await tool.execute('public', { action: 'acceptance' });
    const payload = JSON.parse(content[0].text);
    assert.equal(payload.status, 'INCOMPLETE');
    assert.equal(payload.reason, 'REQUIREMENT_PROBE_COMPILE_FAILED');
    assert.deepEqual(payload.diagnostics, [`${prefix} [REDACTED_CREDENTIAL]`, typeError, typeError, typeError]);
    assert.deepEqual(errors, []);
  } finally {
    controller.abort();
    await worker;
  }
});
