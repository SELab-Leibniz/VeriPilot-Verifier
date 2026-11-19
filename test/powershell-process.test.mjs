import test from 'node:test';
import assert from 'node:assert/strict';
import { skillVerifierCommand } from '../scripts/evaluate-skill-e2e.mjs';
import { withPowerShellVerifierDiagnostics, powerShellVerifierPhases, POWERSHELL_TEST_TIMEOUT_MS } from './helpers/powershell-process.mjs';

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
