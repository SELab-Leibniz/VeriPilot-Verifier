import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { buildSecurityTool2Demo } from '../lib/demo-bundle.mjs';
import { json, writeJson, hash, manifest } from '../lib/files.mjs';
import { collectSecurityTool2Result } from '../demos/security-tool-2/collect-result.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url))), execute = promisify(execFile);
test('SecurityTool demo retains the original public source and task, has no injected fault, and plans a two-hour run after relocation',
  { skip: process.platform !== 'win32' || !existsSync(path.join(root, '.git')), timeout: 180000 }, async () => {
    const folder = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'VP 权限 Demo ')));
    const outDir = path.join(folder, 'portable copy'), packageFile = path.join(folder, 'rc-fixture.tgz');
    await fs.writeFile(packageFile, 'packaging fixture only');
    const git = execFileSync('where.exe', ['git'], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/)[0];
    await buildSecurityTool2Demo({ packageFile, outDir, git });
    const source = await json(path.join(outDir, 'SOURCE.json')), publicInput = await json(path.join(outDir, 'PUBLIC-INPUT.json'));
    assert.equal(source.baseCommit, 'd72abe27c935b878363f4e849bd370b017abf3ea');
    assert.equal(hash(await fs.readFile(path.join(outDir, source.archive))), source.archiveSha256);
    assert.equal(Object.keys(await manifest(path.join(outDir, 'project'))).length, source.originalFileCount + 2);
    assert.equal(publicInput.instance_id, 'security_tool_2');
    for (const key of ['patch', 'test_patch', 'FAIL_TO_PASS', 'PASS_TO_PASS', 'oracle']) assert.equal(publicInput[key], undefined);
    await fs.access(path.join(outDir, 'project/docs/03-模块设计/权限管理组件设计说明.md'));
    assert.doesNotMatch(await fs.readFile(path.join(outDir, 'run-demo.mjs'), 'utf8'), /correctionFixture|install-correction-fixture/);
    for (const dir of ['host', 'profile']) await fs.mkdir(path.join(folder, dir));
    await writeJson(path.join(folder, 'host/package.json'), { name: 'openclaw', version: '2026.7.1-2' });
    await fs.writeFile(path.join(folder, 'host/openclaw.mjs'), '');
    await writeJson(path.join(folder, 'profile/openclaw.json'), { agents: { defaults: { model: 'p/m' } },
      models: { providers: { p: { models: [{ id: 'm' }], apiKey: 'private-key-not-in-bundle' } } },
      plugins: { entries: { 'runtime-corrector': { config: { reviewerModel: 'p/m' } } } } });
    const quote = value => JSON.stringify(value.replaceAll('\\', '/'));
    const machineFile = path.join(folder, 'external-machine.yaml');
    await fs.writeFile(machineFile, `version: 1\npaths:\n  node: ${quote(process.execPath)}\n  git: ${quote(git)}\n  openclawRoot: ./host\n  rcPluginPackage: ${quote(path.join(outDir, 'packages/runtime-corrector-ma-1.11.0.tgz'))}\n  hostConfig: ./profile/openclaw.json\n  hostState: ./profile\n  outputRoot: ./private-runs\n`);
    const { stdout } = await execute(process.execPath, [path.join(outDir, 'run-demo.mjs'), '--machine', machineFile, '--plan'], { cwd: os.tmpdir(), windowsHide: true, timeout: 20000 });
    const plan = JSON.parse(stdout);
    assert.equal(plan.projectDir, path.join(outDir, 'project')); assert.equal(plan.execution.maxRuntimeMs, 7200000);
    assert.equal(plan.execution.observerTimeoutMs, 7200000); assert.equal(plan.execution.businessTimeoutMs, 0);
    assert.doesNotMatch(stdout, /private-key-not-in-bundle/);
  });

test('PowerShell 5.1 project checks preserve a failed native tool exit code and write UTF-8 evidence in a spaced path',
  { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
    const folder = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'VP 工具 故障 ')));
    for (const dir of ['hvigor/bin', 'ohpm/bin', 'java/bin', 'sdk']) await fs.mkdir(path.join(folder, dir), { recursive: true });
    await fs.copyFile(path.join(root, 'demos/security-tool-2/project/demo-checks.ps1'), path.join(folder, 'demo-checks.ps1'));
    await fs.writeFile(path.join(folder, 'hvigor/bin/hvigorw.js'), 'console.log("真实工具故障夹具"); process.exit(17);');
    await fs.writeFile(path.join(folder, 'ohpm/bin/pm-cli.js'), ''); await fs.writeFile(path.join(folder, 'java/bin/java.exe'), '');
    const env = { ...process.env, HVIGOR_HOME: path.join(folder, 'hvigor'), OHPM_HOME: path.join(folder, 'ohpm'), JAVA_HOME: path.join(folder, 'java'),
      DEVECO_SDK_HOME: path.join(folder, 'sdk'), DEVECO_NODE_HOME: path.dirname(process.execPath) };
    await assert.rejects(() => execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(folder, 'demo-checks.ps1'), '-Phase', 'test'],
      { env, windowsHide: true, timeout: 20000 }), error => error.code === 17);
    const receipt = await json(path.join(folder, 'demo-output/test.json'));
    assert.equal(receipt.exitCode, 17); assert.equal(receipt.phase, 'test');
    assert.match(await fs.readFile(path.join(folder, 'demo-output/test.log'), 'utf8'), /真实工具故障夹具/);
    await fs.writeFile(path.join(folder, 'hvigor/bin/hvigorw.js'), 'console.log("No actual tests executed");');
    await assert.rejects(() => execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(folder, 'demo-checks.ps1'), '-Phase', 'test'],
      { env, windowsHide: true, timeout: 20000 }), error => error.code === 1);
    const empty = await json(path.join(folder, 'demo-output/test.json'));
    assert.equal(empty.localTests.freshReport, false); assert.equal(empty.localTests.reportedTotal, 0); assert.equal(empty.exitCode, 1);
  });

test('SecurityTool export preserves FAILED/UNVERIFIED, includes new public source, and omits private receipt fields', async () => {
  const folder = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'vp-st2-export-'))), runDir = path.join(folder, 'run'), outDir = path.join(folder, 'shared');
  const identity = { projectRoot: path.join(runDir, 'project'), agentId: 'main', sessionKey: 'agent:main:test', sessionId: 's' };
  const scope = { jobName: 'Local\\RCExperiment-st2-test', root: { pid: 123, startedAt: '2026-01-01T00:00:00.0000000Z' } }, deadlineAt = Date.now() + 7200000;
  const canary = 'private-profile-canary-4d4af';
  await writeJson(path.join(runDir, 'run.json'), { id: 'st2-failed', runDir, stateDir: path.join(runDir, 'state'), phase: 'ARCHIVED', identity, gatewayPid: 123, processScope: scope,
    experimentDeadlineAt: deadlineAt, firstRunId: 'first', input: { models: { business: 'p/m' }, execution: { maxRuntimeMs: 7200000 }, fingerprint: { project: {} } } });
  await writeJson(path.join(runDir, 'result.json'), { status: 'ARCHIVED', identity, artifacts: 'artifacts/project', host: { first: { runId: 'first', status: 'error', error: canary } },
    rc: { ...identity, status: 'ENDED', outcome: 'UNVERIFIED', reasonCode: 'HOST_RUN_NOT_COMPLETED', owner: { token: canary } } });
  await writeJson(path.join(runDir, 'rc-status/sample-stop-receipt.json'), { ...scope, reason: 'NORMAL_CLEANUP', deadlineAt,
    requestedAt: Date.now(), confirmedAt: Date.now(), activeProcesses: 0 });
  await writeJson(path.join(runDir, 'artifacts/project/demo-output/test.json'), { phase: 'test', exitCode: 1, privateData: canary,
    localTests: { reportedTotal: 3, reportedFailures: 1, secret: canary } });
  const source = path.join(runDir, 'artifacts/project/entry/src/test/Demo.test.ets');
  await fs.mkdir(path.dirname(source), { recursive: true }); await fs.writeFile(source, '// new public test\n');
  await fs.writeFile(path.join(runDir, 'artifacts/project/private.txt'), canary);
  const { summary } = await collectSecurityTool2Result({ runDir, outDir, runnerRoot: root });
  assert.equal(summary.status, 'FAILED'); assert.equal(summary.workflowCompleted, false); assert.equal(summary.rc.outcome, 'UNVERIFIED');
  assert.equal(summary.independentEvaluation, null); assert.equal(summary.publicChecks[0].exitCode, 1);
  assert.deepEqual(summary.changedFiles, ['entry/src/test/Demo.test.ets']);
  assert.equal(await fs.readFile(path.join(outDir, 'project-changes/entry/src/test/Demo.test.ets'), 'utf8'), '// new public test\n');
  assert.doesNotMatch(await fs.readFile(path.join(outDir, 'summary.json'), 'utf8'), new RegExp(canary));
  assert.doesNotMatch(await fs.readFile(path.join(outDir, 'experiment-status.json'), 'utf8'), new RegExp(canary));
  await assert.rejects(() => fs.stat(path.join(outDir, 'private.txt')), { code: 'ENOENT' });
});
