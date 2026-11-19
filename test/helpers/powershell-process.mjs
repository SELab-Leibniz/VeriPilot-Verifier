import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

// A test launcher allowance includes PowerShell cold startup under CI load.
// It does not change any timeout inside the command being tested.
export const POWERSHELL_TEST_TIMEOUT_MS = 60_000;

// Test-only stderr markers leave the generated verifier's executable statements
// intact. In particular, its cleared child environment and deadlines stay exact.
export function withPowerShellVerifierDiagnostics(command) {
  for (const [phase, anchor, child] of [
    ['setup', '$rcVerifyStart = [System.Diagnostics.ProcessStartInfo]::new()'],
    ['start', '$rcVerifyChild = [System.Diagnostics.Process]::Start($rcVerifyStart)'],
    ['stdout-read', '$rcVerifyOut = $rcVerifyChild.StandardOutput.ReadToEndAsync()', true],
    ['stderr-read', '$rcVerifyErr = $rcVerifyChild.StandardError.ReadToEndAsync()', true],
    ['wait', 'try { if (-not ($rcVerifyChild.WaitForExit(10000)))', true],
    ['kill', '$rcVerifyChild.Kill()', true],
    ['stdout-drain', '[void]$rcVerifyOut.Wait(1000)', true],
    ['stderr-drain', '[void]$rcVerifyErr.Wait(1000)', true],
    ['stdout-forward', '[Console]::Out.Write($rcVerifyOut.Result)', true],
    ['stderr-forward', '[Console]::Error.Write($rcVerifyErr.Result)', true],
    ['dispose', '$rcVerifyChild.Dispose()', true],
    ['done', 'exit $rcVerifyCode'],
  ]) {
    assert.equal(command.split(anchor).length, 2, `Expected one verifier diagnostic anchor: ${phase}`);
    const marker = `[Console]::Error.WriteLine(('RC_TEST_VERIFIER_PHASE:${phase}'${child ? " + ' pid=' + [string]$rcVerifyChild.Id" : ''})); `;
    command = command.replace(anchor, marker + anchor);
  }
  return command;
}

export function powerShellVerifierPhases(stderr) {
  return stderr.split(/\r?\n/u).flatMap(line => {
    const match = /^RC_TEST_VERIFIER_PHASE:([a-z-]{1,32})(?: pid=(\d{1,10}))?$/u.exec(line);
    return match ? [{ phase: match[1], ...(match[2] ? { pid: Number(match[2]) } : {}) }] : [];
  }).slice(-24);
}

export function powershellTestInvocation(command, { forwardInput = false } = {}) {
  const startupMarker = `RC_TEST_POWERSHELL_STARTED:${randomUUID()}`;
  const body = forwardInput ? `$input | & { ${command} }; exit $LASTEXITCODE` : command;
  const script = `$ErrorActionPreference = 'Stop'; [Console]::Error.WriteLine('${startupMarker}'); ${body}`;
  return { args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    startupMarker, timeoutMs: POWERSHELL_TEST_TIMEOUT_MS };
}

export function stripPowerShellStartup(stderr, marker) {
  return stderr.split(/\r?\n/u).filter(line => line !== marker).join('\n');
}

export function runPowerShellTestCommand(command, options = {}, { execFile: runFile = execFile } = {}) {
  const invocation = powershellTestInvocation(command), startedAt = Date.now();
  let startupMs = null, observedStderr = '';
  return new Promise((resolve, reject) => {
    const child = runFile('powershell.exe', invocation.args,
      { ...options, windowsHide: true, timeout: invocation.timeoutMs }, (error, stdout, stderr) => {
        const diagnostics = { elapsedMs: Date.now() - startedAt, timeoutMs: invocation.timeoutMs, startupMs,
          startupObserved: stderr.includes(invocation.startupMarker), killed: error?.killed ?? false,
          code: error?.code ?? 0, signal: error?.signal ?? null, verifierPhases: powerShellVerifierPhases(stderr) };
        const cleaned = stripPowerShellStartup(stderr, invocation.startupMarker);
        if (error) {
          error.stdout = stdout;
          error.stderr = cleaned;
          error.message += `\nPowerShell test diagnostics: ${JSON.stringify(diagnostics)}`;
          error.powershellDiagnostics = diagnostics;
          reject(error);
        } else if (!diagnostics.startupObserved) {
          reject(new Error(`PowerShell startup marker missing: ${JSON.stringify(diagnostics)}`));
        } else resolve({ stdout, stderr: cleaned, diagnostics });
      });
    child.stderr.on('data', chunk => {
      observedStderr += chunk;
      if (startupMs === null && observedStderr.includes(invocation.startupMarker)) startupMs = Date.now() - startedAt;
    });
    // This verifier has no input. Close the pipe explicitly so the shell
    // receives EOF instead of an unused open stdin handle.
    child.stdin.end();
  });
}
