import path from 'node:path';
import { openSync, closeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export async function startDeadlineWatchdog(record) {
  if (record.deadlineWatchdog) return;
  const script = fileURLToPath(new URL('../scripts/deadline-watchdog.mjs', import.meta.url));
  const log = openSync(path.join(record.runDir, 'logs/deadline-watchdog.log'), 'a');
  let child;
  try {
    child = spawn(record.input.paths.node, [script, record.runDir], { cwd: record.runDir,
      detached: true, windowsHide: true, stdio: ['ignore', log, log] });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  } finally { closeSync(log); }
  child.unref(); record.deadlineWatchdog = { pid: child.pid, script, deadlineAt: record.experimentDeadlineAt };
}
