import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { promisify } from 'node:util';
import { buildArktsInstrumentHaps } from '../scripts/bench/arkts-instrument-build.mjs';
import { arktsToolchainCommand } from '../scripts/bench/arkts-toolchain-runner.mjs';
import { runBoundedProcess } from '../scripts/bench/bounded-process.mjs';

const execute = promisify(execFile);
const darwinOnly = { skip: process.platform !== 'darwin' };

test('Windows uses the same PowerShell tool phases and Java argument', () => {
  const env = { SystemRoot: 'D:/Windows' };
  const launch = arktsToolchainCommand({ platform: 'win32', projectRoot: 'C:/work tree', toolRoot: 'C:/Huawei',
    javaHome: 'C:/jbr', phase: 'test', env });
  assert.equal(launch.command, 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.deepEqual(launch.args.slice(0, 4), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File']);
  assert.match(launch.args[4], /run-arkts-toolchain\.ps1$/u);
  assert.deepEqual(launch.args.slice(5), ['-Project', 'C:/work tree', '-ToolRoot', 'C:/Huawei', '-Phase', 'test', '-JavaHome', 'C:/jbr']);
  assert.equal(launch.env, env);
  assert.throws(() => arktsToolchainCommand({ platform: 'linux', projectRoot: '/work', toolRoot: '/tool', phase: 'build' }), /Unsupported/u);
  assert.throws(() => arktsToolchainCommand({ platform: 'win32', projectRoot: 'C:/work', toolRoot: 'C:/Huawei', phase: '--unsafe' }), /phase/u);
  assert.throws(() => arktsToolchainCommand({ platform: 'win32', projectRoot: 'C:/work', toolRoot: 'C:/Huawei', phase: 'instrument-test' }), /require macOS/u);
  assert.throws(() => arktsToolchainCommand({ platform: 'darwin', projectRoot: '/work', toolRoot: '/tool',
    phase: 'instrument-app', appBuildMode: 'release' }), /mode must be debug or test/u);
});

async function fixture(t) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'arkts-runner-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const bases = { toolRoot: path.join(directory, 'tool chain'), javaHome: path.join(directory, 'java home'), projectRoot: path.join(directory, 'work tree') };
  const fixturePaths = ['tool/node/bin', 'ohpm/bin', 'hvigor/bin', 'sdk', 'bin'].map(name => path.join(bases.toolRoot, name));
  await Promise.all([...fixturePaths, path.join(bases.javaHome, 'bin'), bases.projectRoot].map(name => fs.mkdir(name, { recursive: true })));
  const mock = `const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
console.log(JSON.stringify({args, cwd: process.cwd(), executable: fs.realpathSync(process.argv[0]),
  sdk: process.env.DEVECO_SDK_HOME, node: process.env.DEVECO_NODE_HOME, nodeHome: process.env.NODE_HOME,
  java: process.env.JAVA_HOME, firstPathEntries: process.env.PATH.split(':').slice(0, 3)}));
if (process.env.TEST_ARKTS_WAIT) {
  const poll = setInterval(() => {
    if (fs.existsSync(process.env.TEST_ARKTS_WAIT)) clearInterval(poll);
  }, 10);
}
if (process.env.TEST_ARKTS_EXIT) process.exitCode = Number(process.env.TEST_ARKTS_EXIT);
if (args.includes('isOhosTest=true')) {
  const target = args.find(arg => arg.startsWith('module=entry@')).split('@')[1];
  if (!fs.existsSync('omit-' + target + '-hap')) {
    const directory = path.join('entry', 'build', 'default', 'outputs', target);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'entry-' + target + '-unsigned.hap'), 'fresh unsigned');
    if (target === 'default') fs.writeFileSync(path.join(directory, 'entry-' + target + '-signed.hap'), 'fresh signed');
  }
  if (target === 'ohosTest' && fs.existsSync('replace-app-hap'))
    fs.writeFileSync('entry/build/default/outputs/default/entry-default-signed.hap', 'changed by test build');
}
`;
  await Promise.all([
    fs.symlink(process.execPath, path.join(bases.toolRoot, 'tool/node/bin/node')),
    fs.writeFile(path.join(bases.toolRoot, 'hvigor/bin/hvigorw.js'), mock),
    fs.writeFile(path.join(bases.toolRoot, 'ohpm/bin/pm-cli.js'), mock),
    fs.writeFile(path.join(bases.javaHome, 'bin/java'), '#!/bin/sh\nprintf "java %s\\n" "$1" >&2\n', { mode: 0o700 }),
  ]);
  return { ...bases, directory };
}

test('macOS launches exact bundled Node entrypoints with the matched phase arguments and Java', darwinOnly, async t => {
  const paths = await fixture(t);
  const phases = {
    install: ['install'],
    test: ['test', '-p', 'module=entry', '-p', 'coverage=false', '--no-daemon'],
    build: ['--mode', 'module', '-p', 'module=entry@default', '-p', 'product=default', '-p', 'buildMode=debug', 'assembleHap', '--no-daemon'],
  };
  const env = { ...process.env, DEVECO_SDK_HOME: '/wrong', NODE_HOME: '/wrong', NODE_OPTIONS: '--nonexistent' };
  for (const [phase, args] of Object.entries(phases)) {
    const launch = arktsToolchainCommand({ ...paths, phase, env });
    const { stdout } = await execute(launch.command, launch.args, { env: launch.env, timeout: 5000 });
    assert.match(stdout, new RegExp(`\\[RC_ARKTS_LOCK\\] \\{"phase":"${phase}",`, 'u'));
    const row = JSON.parse(stdout.split('\n').find(line => line.startsWith('{')));
    assert.deepEqual(row, { args, cwd: paths.projectRoot, executable: await fs.realpath(process.execPath),
      sdk: path.join(paths.toolRoot, 'sdk'), node: path.join(paths.toolRoot, 'tool/node'), nodeHome: path.join(paths.toolRoot, 'tool/node'),
      java: paths.javaHome, firstPathEntries: [path.join(paths.javaHome, 'bin'), path.join(paths.toolRoot, 'tool/node/bin'), path.join(paths.toolRoot, 'bin')] });
  }
  const java = arktsToolchainCommand({ ...paths, phase: 'java', env });
  const version = await execute(java.command, java.args, { env: java.env, timeout: 5000 });
  assert.match(version.stdout, /\[RC_ARKTS_JAVA\] /u);
  assert.match(version.stdout, /^java -version$/mu);
  assert.equal(version.stderr, '');
  assert.doesNotMatch(version.stdout, /RC_ARKTS_LOCK/u);

  const invalid = arktsToolchainCommand({ ...paths, phase: 'test', javaHome: '/missing-java', env });
  await assert.rejects(execute(invalid.command, invalid.args, { env: invalid.env, timeout: 5000 }), {
    code: 3, stdout: /\[RC_ARKTS_JAVA\] .*bin\/java unavailable/u,
  });
});

test('macOS builds and selects fresh app and instrumentation HAPs with independently bound modes', darwinOnly, async t => {
  const paths = await fixture(t);
  const staleTest = path.join(paths.projectRoot, 'entry/build/default/outputs/ohosTest/entry-ohosTest-signed.hap');
  await fs.mkdir(path.dirname(staleTest), { recursive: true });
  await fs.writeFile(staleTest, 'stale signed');
  const result = await buildArktsInstrumentHaps({ ...paths, deadline: Date.now() + 5000, appBuildMode: 'debug' });
  assert.equal(result.execution.compileSucceeded, true);
  assert.equal(result.execution.appBuildMode, 'debug');
  assert.deepEqual(result.haps.map(file => path.basename(file)), ['entry-default-signed.hap', 'entry-ohosTest-unsigned.hap']);
  assert.deepEqual(await Promise.all(result.haps.map(file => fs.readFile(file, 'utf8'))), ['fresh signed', 'fresh unsigned']);
  const args = result.output.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line).args);
  assert.deepEqual(args, [
    ['install'],
    ['--mode', 'module', '-p', 'module=entry@default', '-p', 'product=default', '-p', 'buildMode=debug', '-p', 'isOhosTest=true', 'assembleHap', '--no-daemon'],
    ['--mode', 'module', '-p', 'module=entry@ohosTest', '-p', 'product=default', '-p', 'buildMode=test', '-p', 'isOhosTest=true', 'assembleHap', '--no-daemon'],
  ]);

  await fs.writeFile(path.join(paths.projectRoot, 'omit-ohosTest-hap'), '');
  const missing = await buildArktsInstrumentHaps({ ...paths, deadline: Date.now() + 5000, appBuildMode: 'test' });
  assert.equal(missing.execution.compileSucceeded, false);
  assert.equal(missing.execution.code, 1);
  assert.deepEqual(missing.haps, []);
  assert.match(missing.output, /No fresh ArkTS HAP for entry@ohosTest/u);
  assert.match(missing.output, /"module=entry@default","-p","product=default","-p","buildMode=test"/u);

  await fs.unlink(path.join(paths.projectRoot, 'omit-ohosTest-hap'));
  await fs.writeFile(path.join(paths.projectRoot, 'replace-app-hap'), '');
  const replaced = await buildArktsInstrumentHaps({ ...paths, deadline: Date.now() + 5000, appBuildMode: 'debug' });
  assert.equal(replaced.execution.compileSucceeded, false);
  assert.equal(replaced.execution.reason, 'instrument-app-hap-changed');
  assert.deepEqual(replaced.haps, []);
});

function waitForLine(child, prefix) {
  return new Promise((resolve, reject) => {
    let output = '';
    const onClose = () => reject(new Error(`Tool output did not include ${prefix}`));
    const onData = value => {
      output += value;
      if (!output.split('\n').slice(0, -1).some(line => line.startsWith(prefix))) return;
      child.stdout.off('data', onData);
      child.off('close', onClose);
      resolve();
    };
    child.stdout.on('data', onData);
    child.once('close', onClose);
  });
}

test('macOS serializes ohpm and Hvigor across worktrees and preserves vendor exit status', darwinOnly, async t => {
  const paths = await fixture(t);
  const otherProject = path.join(paths.directory, 'other project');
  const release = path.join(paths.directory, 'finish ohpm');
  await fs.mkdir(otherProject);
  const first = arktsToolchainCommand({ ...paths, phase: 'install', env: { ...process.env, TEST_ARKTS_WAIT: release } });
  const running = execute(first.command, first.args, { env: first.env, timeout: 5000 });
  const firstStarted = waitForLine(running.child, '{"args"');
  let outcome;
  try {
    await firstStarted;
    const second = arktsToolchainCommand({ ...paths, projectRoot: otherProject, phase: 'test', env: { ...process.env, TEST_ARKTS_EXIT: '17' } });
    const queued = execute(second.command, second.args, { env: second.env, timeout: 5000 });
    outcome = assert.rejects(queued, { code: 17, stdout: /\[RC_ARKTS_LOCK\] .*"phase":"test"/u });
    const secondStarted = waitForLine(queued.child, '[RC_ARKTS_JAVA]');
    await Promise.race([secondStarted, outcome]);
    assert.equal(await Promise.race([outcome.then(() => 'finished'), delay(120, 'waiting')]), 'waiting');
  } finally {
    await fs.writeFile(release, 'done');
    await Promise.all([running, outcome]);
  }
});

test('macOS campaign cancellation terminates a running vendor process and releases the lock', darwinOnly, async t => {
  const paths = await fixture(t);
  const release = path.join(paths.directory, 'finish ohpm');
  const first = arktsToolchainCommand({ ...paths, phase: 'install', env: { ...process.env, TEST_ARKTS_WAIT: release } });
  const controller = new AbortController();
  let output = '';
  const cancelled = runBoundedProcess(first.command, first.args, { env: first.env, processGroup: true,
    timeoutMs: 5000, signal: controller.signal, onOutput(chunk) {
      output += chunk;
      if (output.includes('{"args"')) controller.abort();
    } });
  try {
    assert.equal((await cancelled).reason, 'cancelled');
    const next = arktsToolchainCommand({ ...paths, phase: 'test' });
    const result = await runBoundedProcess(next.command, next.args, { env: next.env, processGroup: true, timeoutMs: 5000 });
    assert.equal(result.exitCode, 0);
    assert.match(result.tail, /\[RC_ARKTS_LOCK\] .*"phase":"test"/u);
  } finally {
    await fs.writeFile(release, 'done');
  }
});
