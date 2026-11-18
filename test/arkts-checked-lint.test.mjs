import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runArktsCheckedLint } from '../scripts/bench/arkts-checked-lint.mjs';
import { copyArktsPublicTestSnapshot } from '../scripts/bench/arkts-public-test-snapshot.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const exited = (exitCode = 0) => ({ exitCode, interrupted: false, outputComplete: true, reason: 'closed', durationMs: 1,
  tail: 'Finished...[=======================]100%\nWrite finished.\n' });
const fixtureFile = 'entry/app.ets', original = 'export function value(): number { return 1; }\n';

async function fixture(t, mode) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'rc-lint-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, 'project'), toolRoot = path.join(root, 'tools'), javaHome = path.join(root, 'java');
  const config = '{ // JSON5 comments are valid\n  "files": ["**/*.ets"]\n}\n', vendor = 'trusted test tool\n';
  const write = async (file, contents = '', mode) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents, { mode });
  };
  const node = path.join(toolRoot, 'tool/node/bin/node');
  await write(path.join(projectRoot, fixtureFile), original);
  await write(path.join(projectRoot, 'code-linter.json5'), config);
  await write(path.join(projectRoot, 'build-profile.json5'), '{"modules":[{"srcPath":"entry"}]}');
  await write(path.join(projectRoot, 'entry/build-profile.json5'), '{}');
  await write(path.join(projectRoot, '.env'), 'FAKE_CREDENTIAL=fixture-only');
  await write(path.join(toolRoot, 'codelinter/index.js'), vendor);
  await write(path.join(toolRoot, 'codelinter/linter/performanceAgent/index.js'), 'trusted agent');
  await write(path.join(toolRoot, 'codelinter/linter/performanceAgent/hpaudit'), 'trusted binary');
  await write(path.join(toolRoot, 'codelinter/linter/result/hpauditor.log'), 'stale vendor state');
  await write(path.join(toolRoot, 'hvigor/hvigor-ohos-plugin/node_modules/json5/index.js'), 'exports.parse = JSON.parse;');
  await write(node, '', 0o700);
  await write(path.join(javaHome, 'bin/java'), '', 0o700);
  await fs.mkdir(path.join(toolRoot, 'sdk'));
  const output = path.join(root, 'receipt.json'), calls = [];
  const invoke = async (executable, args, options) => {
    calls.push({ executable, args, cwd: options.cwd });
    assert.equal(options.processGroup, true);
    assert(options.timeoutMs > 0 && options.timeoutMs <= 60_000);
    if (executable === '/bin/cp') {
      assert.deepEqual(args.slice(0, 2), ['-cRP', path.join(toolRoot, 'codelinter')]);
      assert.deepEqual(options.env, { PATH: '/usr/bin:/bin' });
      await fs.cp(args[1], args[2], { recursive: true });
      return exited();
    }
    assert.equal(executable, node);
    assert.deepEqual(args.slice(1, 8), [path.join(toolRoot, 'sdk'), '-c', './code-linter.json5', '.', '--fix', '--format', 'json']);
    assert.deepEqual(args.slice(8).filter((_arg, index) => index !== 1), ['--output', '--exit-on', 'error']);
    assert.equal(path.dirname(options.cwd), path.dirname(args[9]));
    assert.notEqual(options.cwd, projectRoot);
    assert(!Object.keys(options.env).some(key => /API_KEY|TOKEN|PROXY|NODE_OPTIONS/iu.test(key)));
    await assert.rejects(fs.stat(path.join(options.cwd, '.env')), { code: 'ENOENT' });
    const logs = path.join(path.dirname(args[0]), 'linter/result');
    await assert.rejects(fs.stat(logs), { code: 'ENOENT' });
    const translated = path.join(options.cwd, fixtureFile);
    if (mode === 'fix') await fs.writeFile(translated, '// corrected on disposable copy\n');
    const severity = mode === 'warn' ? 'warn' : 'error';
    const message = { line: 1, column: 2, severity, rule: 'fixture-lint', message: 'Diagnostic from public source.' };
    const findings = ['error', 'warn', 'outside'].includes(mode) ? [{ filePath: mode === 'outside' ? path.join(projectRoot, fixtureFile) : translated,
      messages: [message] }] : [];
    if (mode !== 'missing') await fs.writeFile(args[9], mode === 'empty' ? '' : mode === 'malformed' ? '{}' : JSON.stringify(findings));
    if (mode === 'stale') await fs.utimes(args[9], 1, 1);
    const errors = ['error', 'mismatch'].includes(mode) ? 1 : 0, warnings = mode === 'warn' ? 1 : 0;
    if (mode !== 'missing-auditor') await write(path.join(logs, 'hpauditor.log'),
      `Executing on: ${translated}\n-Defects:${errors + warnings};Errors:${errors} Warns:${warnings};Infos:0;\nhpauditor completed, exitCode:0\n`);
    if (mode === 'bad-terminal') return { ...exited(), tail: '' };
    return exited(mode === 'error' ? 1 : 0);
  };
  const inputs = { projectRoot, toolRoot, javaHome, configSha256: sha256(config), output };
  return { ...inputs, calls, vendorSha256: sha256(vendor), invoke,
    run: overrides => runArktsCheckedLint({ ...inputs, ...overrides }, { invoke, platform: 'darwin' }) };
}

test('checked lint seals a fresh empty report after real scan evidence with the unmodified public snapshot', async t => {
  const f = await fixture(t, 'clean');
  const receipt = await f.run();
  assert.equal(receipt.status, 'PASS');
  assert.equal(receipt.confirmed, true);
  assert.equal(receipt.sourceChanged, false);
  assert.equal(receipt.diagnosticCount, 0);
  assert.equal(receipt.freshReport, true);
  assert.equal(receipt.reportSha256, sha256('[]'));
  assert.equal(receipt.vendorIndexSha256, f.vendorSha256);
  assert.equal(receipt.hpauditorIndexSha256, sha256('trusted agent'));
  assert.equal(receipt.hpauditorBinarySha256, sha256('trusted binary'));
  assert.equal(receipt.snapshotSha256, await copyArktsPublicTestSnapshot(f.projectRoot));
  assert.deepEqual(JSON.parse(await fs.readFile(f.output, 'utf8')), receipt);
  assert.equal(f.calls.length, 2);
  await assert.rejects(fs.stat(f.calls[0].cwd), { code: 'ENOENT' });
});

test('checked lint refuses module or resource paths outside the disposable snapshot', async t => {
  for (const [file, value] of [
    ['build-profile.json5', { modules: [{ srcPath: '../outside' }] }],
    ['entry/build-profile.json5', { targets: [{ resource: { directories: ['../../outside'] } }] }],
  ]) await t.test(file, async t => {
    const f = await fixture(t, 'clean');
    await fs.writeFile(path.join(f.projectRoot, file), JSON.stringify(value));
    const receipt = await f.run();
    assert.equal(receipt.reason, 'LINTER_PROJECT_SCOPE_UNVERIFIED');
    assert.equal(receipt.confirmed, false);
    assert.deepEqual(f.calls, []);
  });
});

test('checked lint cannot certify missing, empty, stale, malformed, unbound or silently incomplete output', async t => {
  for (const [mode, reason] of [
    ...['empty', 'missing', 'stale', 'malformed', 'outside', 'bad-terminal'].map(mode => [mode, 'LINTER_REPORT_UNVERIFIED']),
    ['mismatch', 'LINTER_AGGREGATE_MISMATCH'], ['missing-auditor', 'LINTER_AUDITOR_UNVERIFIED'],
  ]) await t.test(mode, async t => {
    const f = await fixture(t, mode);
    const receipt = await f.run();
    assert.equal(receipt.status, 'INCOMPLETE');
    assert.equal(receipt.confirmed, false);
    assert.equal(receipt.reason, reason);
    if (mode === 'mismatch') assert.equal(receipt.auditorErrorCount, 1);
  });
});

test('checked lint exposes source-bound warnings/errors and keeps fixes out of the live project', async t => {
  for (const [mode, expected, reason] of [['error', 'FAIL', 'LINTER_ERRORS'], ['warn', 'PASS', null], ['fix', 'FAIL', 'LINTER_FIXES_REQUIRED']])
    await t.test(mode, async t => {
      const f = await fixture(t, mode);
      const receipt = await f.run();
      assert.equal(receipt.status, expected);
      assert.equal(receipt.confirmed, true);
      assert.equal(receipt.reason, reason);
      assert.equal(receipt.sourceChanged, mode === 'fix');
      assert.equal(receipt.errorCount, mode === 'error' ? 1 : 0);
      assert.equal(receipt.warningCount, mode === 'warn' ? 1 : 0);
      if (mode !== 'fix') assert.equal(receipt.issues[0].file, fixtureFile);
      assert.equal(await fs.readFile(path.join(f.projectRoot, fixtureFile), 'utf8'), original);
    });
});

test('checked lint refuses config drift and pre-cancellation before starting vendor code', async t => {
  for (const [reason, overrides] of [['LINTER_CONFIG_UNVERIFIED', { configSha256: '0'.repeat(64) }],
    ['LINTER_CANCELLED', { signal: AbortSignal.abort() }]]) await t.test(reason, async t => {
    const f = await fixture(t, 'clean');
    const receipt = await f.run(overrides);
    assert.equal(receipt.reason, reason);
    assert.equal(receipt.confirmed, false);
    assert.deepEqual(f.calls, []);
  });
});
