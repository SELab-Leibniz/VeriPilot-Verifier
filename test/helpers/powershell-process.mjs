import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// A test launcher allowance includes PowerShell cold startup under CI load.
// It does not change any timeout inside the command being tested.
export const POWERSHELL_TEST_TIMEOUT_MS = 60_000;

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

export function runPowerShellTestCommand(command, options = {}) {
  const invocation = powershellTestInvocation(command), startedAt = Date.now();
  let startupMs = null, observedStderr = '';
  return new Promise((resolve, reject) => {
    const child = execFile('powershell.exe', invocation.args,
      { ...options, windowsHide: true, timeout: invocation.timeoutMs }, (error, stdout, stderr) => {
        const diagnostics = { elapsedMs: Date.now() - startedAt, timeoutMs: invocation.timeoutMs, startupMs,
          startupObserved: stderr.includes(invocation.startupMarker), killed: error?.killed ?? false,
          code: error?.code ?? 0, signal: error?.signal ?? null };
        const cleaned = stripPowerShellStartup(stderr, invocation.startupMarker);
        if (error) {
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
