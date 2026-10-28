// Child exit and closed inherited pipes are different events on Windows.
// A detached tool descendant must not hold an already-ended command forever.
import { spawn } from 'node:child_process';
import path from 'node:path';
export function runBoundedProcess(command, args, { cwd, signal, timeoutMs = 180000, exitDrainMs = 1000, maxTail = 6000, onOutput = () => {} } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('A finite process timeout is required');
  if (signal?.aborted) return Promise.resolve({ exitCode: null, interrupted: true, reason: 'cancelled-before-launch', outputComplete: false, tail: '' });
  return new Promise(resolve => {
    const startedAt = Date.now(), child = spawn(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '', settled = false, drain, exitCode = null;
    const finish = extra => {
      if (settled) return; settled = true; clearTimeout(timer); clearTimeout(drain); signal?.removeEventListener('abort', cancel);
      child.stdout.destroy(); child.stderr.destroy();
      resolve({ exitCode, tail, durationMs: Date.now() - startedAt, ...extra });
    };
    const stop = reason => {
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        if (process.platform === 'win32') {
          const killer = spawn(path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.once('error', () => child.kill());
        } else child.kill();
      }
      finish({ interrupted: true, reason, outputComplete: false });
    };
    const cancel = () => stop('cancelled'), timer = setTimeout(() => stop('deadline'), timeoutMs);
    signal?.addEventListener('abort', cancel, { once: true });
    const output = value => { tail = (tail + value).slice(-maxTail); onOutput(value); };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', output);
    child.stderr.on('data', output);
    child.once('error', error => finish({ interrupted: true, reason: error.code ?? error.name, outputComplete: false }));
    child.once('exit', code => { if (settled) return; exitCode = code; drain = setTimeout(() => finish({ interrupted: false, reason: 'inherited-pipe-drain-limit', outputComplete: false }), exitDrainMs); });
    child.once('close', code => { exitCode = code; finish({ interrupted: false, reason: 'closed', outputComplete: true }); });
    if (signal?.aborted) cancel();
  });
}
