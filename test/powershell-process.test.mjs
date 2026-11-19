import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { skillVerifierCommand } from '../scripts/evaluate-skill-e2e.mjs';
import { withPowerShellVerifierDiagnostics, powerShellVerifierPhases, POWERSHELL_TEST_TIMEOUT_MS, runPowerShellTestCommand } from './helpers/powershell-process.mjs';

test('Windows verifier diagnostics preserve every executable statement and timeout', () => {
  for (const fixture of [
    { projectRoot: '/fixture/project with space', nodeBinary: '/fixture/node' },
    { projectRoot: "/fixture/project's notes/文档", nodeBinary: "/fixture/node's binary" },
  ]) {
    const command = skillVerifierCommand(fixture, 'win32');
    const instrumented = withPowerShellVerifierDiagnostics(command);
    const marker = /\[Console\]::Error\.WriteLine\(\('RC_TEST_VERIFIER_PHASE:[a-z-]+'(?: \+ ' pid=' \+ \[string\]\$rcVerifyChild\.Id)?\)\); /gu;
    assert.equal([...instrumented.matchAll(marker)].length, 12);
    assert.equal(instrumented.replace(marker, ''), command);
    assert.equal(POWERSHELL_TEST_TIMEOUT_MS, 60000);
    assert.throws(() => withPowerShellVerifierDiagnostics(command.replace('$rcVerifyChild.Kill()', 'changed-child-command')));
  }
});

test('PowerShell phase diagnostics retain only bounded, well-formed stage and child PID records', () => {
  const log = ['unrelated verifier stderr', 'RC_TEST_VERIFIER_PHASE:invalid pid=foreign',
    ...Array.from({ length: 30 }, (_, index) => `RC_TEST_VERIFIER_PHASE:wait pid=${index + 100}`)].join('\r\n');
  const phases = powerShellVerifierPhases(log);
  assert.equal(phases.length, 24);
  assert.deepEqual(phases[0], { phase: 'wait', pid: 106 });
  assert.deepEqual(phases.at(-1), { phase: 'wait', pid: 129 });
  assert.deepEqual(powerShellVerifierPhases('RC_TEST_VERIFIER_PHASE:start\nRC_TEST_VERIFIER_PHASE:stdout-read pid=222'),
    [{ phase: 'start' }, { phase: 'stdout-read', pid: 222 }]);
});

test('PowerShell callback failures retain verifier stdout, stderr and the original nonzero exit', async () => {
  const output = { codePassed: false, detail: 'expected verification failure' };
  const runFile = (file, args, options, callback) => {
    assert.equal(file, 'powershell.exe');
    assert.equal(options.timeout, POWERSHELL_TEST_TIMEOUT_MS);
    assert.equal(options.windowsHide, true);
    const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    const marker = /RC_TEST_POWERSHELL_STARTED:[a-f0-9-]+/u.exec(script)?.[0];
    assert(marker);
    // Use a real callback child on every platform. It waits for the launcher's
    // stdin EOF, emits the verifier result and then exits unsuccessfully.
    return execFile(process.execPath, ['-e', `
      process.stderr.write(${JSON.stringify(marker + '\nRC_TEST_VERIFIER_PHASE:done\nverification failed\n')});
      process.stdin.resume();
      process.stdin.once('end', () => {
        process.stdout.write(${JSON.stringify(JSON.stringify(output) + '\n')});
        process.exitCode = 3;
      });
    `], options, callback);
  };
  await assert.rejects(runPowerShellTestCommand('exit 3', {}, { execFile: runFile }), error => {
    assert.equal(error.code, 3);
    assert.deepEqual(JSON.parse(error.stdout.trim()), output);
    assert.equal(error.stderr, 'RC_TEST_VERIFIER_PHASE:done\nverification failed\n');
    assert.equal(error.powershellDiagnostics.startupObserved, true);
    assert.equal(error.powershellDiagnostics.killed, false);
    assert.deepEqual(error.powershellDiagnostics.verifierPhases, [{ phase: 'done' }]);
    return true;
  });
});
