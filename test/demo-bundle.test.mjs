import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { buildQuicksortDemo, archiveDemoBundle } from '../lib/demo-bundle.mjs';
import { json, writeJson, hash } from '../lib/files.mjs';
import { collectDemoResult } from '../demos/python-quicksort/collect-result.mjs';
import { extractPackage } from '../lib/files.mjs';
import { pathToFileURL } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
test('portable demo contains frozen program and package, runs its plan from another cwd, and excludes private setup',
  { skip: process.platform !== 'win32' || !existsSync(path.join(root, '.git')), timeout: 120000 }, async () => {
    const folder = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'VP 演示 包 ')));
    const outDir = path.join(folder, 'demo with spaces'), packageFile = path.join(folder, 'rc-fixture.tgz');
    await fs.writeFile(packageFile, 'opaque package bytes for packaging-only test');
    const git = execFileSync('where.exe', ['git'], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/)[0];
    const bundle = await buildQuicksortDemo({ packageFile, outDir, git });
    const metadata = await json(path.join(outDir, 'BUNDLE.json'));
    assert.equal(metadata.runnerCommit, execFileSync(git, ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim());
    const frozen = metadata.runnerWorktreeOverrides.includes('lib/runner.mjs') ? await fs.readFile(path.join(root, 'lib/runner.mjs'))
      : execFileSync(git, ['show', `${metadata.runnerCommit}:lib/runner.mjs`], { cwd: root, windowsHide: true });
    assert.equal(hash(await fs.readFile(path.join(outDir, 'runner/lib/runner.mjs'))), hash(frozen));
    assert.equal(metadata.plugin.sha256, hash(await fs.readFile(packageFile)));
    assert.equal(metadata.files['machine.yaml'], undefined); assert.equal(metadata.files['runs/run.json'], undefined);
    await fs.access(bundle.zip); await fs.access(path.join(outDir, 'runner/scripts/windows-sample-job.cs'));
    for (const file of ['lib/demo-bundle.mjs', 'scripts/build-quicksort-demo.mjs', 'test/demo-bundle.test.mjs',
      'demos/python-quicksort/collect-result.mjs', 'demos/python-quicksort/README.md']) {
      assert.equal(hash(await fs.readFile(path.join(outDir, 'runner', file))), hash(await fs.readFile(path.join(root, file))));
    }
    const host = path.join(folder, 'host'), state = path.join(folder, 'profile');
    await fs.mkdir(host); await fs.mkdir(state);
    await writeJson(path.join(host, 'package.json'), { name: 'openclaw', version: '2026.7.1-2' });
    await fs.writeFile(path.join(host, 'openclaw.mjs'), '');
    const secret = `not-distributable-${randomUUID()}`;
    await writeJson(path.join(state, 'openclaw.json'), { agents: { defaults: { model: 'p/m' } },
      models: { providers: { p: { models: [{ id: 'm' }], apiKey: secret } } },
      plugins: { entries: { 'runtime-corrector': { config: { reviewerModel: 'p/m' } } } } });
    const quote = value => JSON.stringify(value.replaceAll('\\', '/'));
    const machineFile = path.join(folder, 'private-machine.yaml');
    await fs.writeFile(machineFile, `version: 1\npaths:\n  node: ${quote(process.execPath)}\n  git: ${quote(git)}\n  python: ${quote(process.execPath)}\n  openclawRoot: ${quote(host)}\n  rcPluginPackage: ${quote(path.join(outDir, metadata.plugin.file))}\n  hostConfig: ${quote(path.join(state, 'openclaw.json'))}\n  hostState: ${quote(state)}\n  outputRoot: ${quote(path.join(folder, 'private-runs'))}\n`);
    const { stdout } = await promisify(execFile)(process.execPath, [path.join(outDir, 'run-demo.mjs'), '--machine', machineFile, '--plan'],
      { cwd: os.tmpdir(), windowsHide: true, timeout: 20000 });
    const plan = JSON.parse(stdout);
    assert.equal(plan.projectDir, path.join(outDir, 'project')); assert.equal(plan.execution.maxRuntimeMs, 1800000);
    assert.equal(plan.models.agentId, 'main'); assert.doesNotMatch(stdout, new RegExp(secret));
    const originalZip = hash(await fs.readFile(bundle.zip));
    await assert.rejects(() => buildQuicksortDemo({ packageFile, outDir, git }), { code: 'EEXIST' });
    assert.equal(hash(await fs.readFile(bundle.zip)), originalZip);
    await fs.writeFile(path.join(outDir, 'machine.yaml'), 'private local setup');
    await assert.rejects(() => archiveDemoBundle(outDir), /Do not distribute private machine.yaml/);
    assert.equal(hash(await fs.readFile(bundle.zip)), originalZip);
  });
test('demo builder rejects recursive output inside its source template', { skip: process.platform !== 'win32' }, async () => {
  await assert.rejects(() => buildQuicksortDemo({ packageFile: 'unused', outDir: path.join(root, 'demos/python-quicksort/build'), git: 'git' }),
    /outside the demo source template/);
});
test('a green native/RC result without an injected defect cannot be exported as a successful correction demo', async () => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'vp-demo-no-defect-'))), outDir = path.join(dir, 'shared');
  const runDir = path.join(dir, 'run'), deadlineAt = Date.now() + 60000;
  const identity = { projectRoot: path.join(runDir, 'project'), sessionId: 's', sessionKey: 'agent:main:s', agentId: 'main' };
  const scope = { jobName: 'Local\\RCExperiment-demo-test', root: { pid: 123, startedAt: '2026-01-01T00:00:00.0000000Z' } };
  await writeJson(path.join(runDir, 'run.json'), { id: 'demo-no-defect', runDir, phase: 'ARCHIVED', identity,
    gatewayPid: 123, experimentDeadlineAt: deadlineAt, processScope: scope, firstRunId: 'first', terminals: {} });
  await writeJson(path.join(runDir, 'result.json'), { status: 'ARCHIVED', identity, host: { first: { runId: 'first', status: 'ok' } },
    rc: { ...identity, status: 'ENDED', outcome: 'NO_DEVIATION_FOUND' } });
  await writeJson(path.join(runDir, 'rc-status/sample-stop-receipt.json'), { ...scope, reason: 'NORMAL_CLEANUP',
    deadlineAt, requestedAt: Date.now(), confirmedAt: Date.now(), activeProcesses: 0 });
  await assert.rejects(() => collectDemoResult({ runDir, outDir, runnerRoot: root }), /did not demonstrate correction/);
  await assert.rejects(() => fs.stat(outDir), /ENOENT/);
});
test('demo output obligations resolve uniquely using the actual packaged RC expected-file checker',
  { skip: !process.env.RC_TEST_PACKAGE }, async () => {
    const plugin = await fs.mkdtemp(path.join(os.tmpdir(), 'vp-demo-rc-paths-'));
    await extractPackage(process.env.RC_TEST_PACKAGE, plugin);
    const { resolveExpectedFilePath } = await import(pathToFileURL(path.join(plugin, 'payload/runtime-corrector/lib/runtime-v2/expected-files.mjs')));
    const text = await fs.readFile(path.join(root, 'demos/python-quicksort/project/requirements.md'), 'utf8');
    for (const file of ['quicksort.py', 'test_quicksort.py', 'test-output.txt']) {
      const originalLine = text.split(/\r?\n/).find(line => line.includes('./' + file));
      const resolved = resolveExpectedFilePath(file, originalLine);
      assert.equal(resolved.status, 'RESOLVED'); assert.equal(resolved.path, file);
    }
  });
