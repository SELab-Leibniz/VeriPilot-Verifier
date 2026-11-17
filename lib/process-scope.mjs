import { openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { optionalJson, writeJson } from './files.mjs';

const execute = promisify(execFile), pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function inspectProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid process ID');
  const command = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if($p){$d=[System.Diagnostics.Process]::GetProcessById(${pid}); try{[pscustomobject]@{pid=[int]$p.ProcessId;parentPid=[int]$p.ParentProcessId;startedAt=$d.StartTime.ToUniversalTime().ToString('o');exe=$p.ExecutablePath;commandLine=$p.CommandLine}|ConvertTo-Json -Compress}finally{$d.Dispose()}}`;
  const result = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 10000 });
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}
export function validateStopReceipt(record, receipt) {
  if (!record.processScope || receipt?.jobName !== record.processScope.jobName || receipt.root?.pid !== record.processScope.root.pid
    || receipt.root?.startedAt !== record.processScope.root.startedAt || receipt.deadlineAt !== record.experimentDeadlineAt
    || receipt.activeProcesses !== 0 || !['NORMAL_CLEANUP', 'EXPERIMENT_DEADLINE_EXPIRED'].includes(receipt.reason)
    || !Number.isSafeInteger(receipt.requestedAt) || !Number.isSafeInteger(receipt.confirmedAt)
    || receipt.confirmedAt < receipt.requestedAt) throw new Error('Sample process-scope shutdown proof is missing or mismatched');
  if (receipt.reason === 'EXPERIMENT_DEADLINE_EXPIRED' && receipt.requestedAt < record.experimentDeadlineAt) throw new Error('Premature hard stop receipt');
  return receipt;
}
export async function startSampleSupervisor(record) {
  if (process.platform !== 'win32') throw new Error('Sample process containment requires Windows');
  if (!record.processScope) {
    const root = await inspectProcess(record.gatewayPid);
    const expected = path.join(record.input.paths.openclawRoot, 'openclaw.mjs').replaceAll('\\', '/').toLowerCase();
    if (!root || !root.commandLine.replaceAll('\\', '/').toLowerCase().includes(expected)) throw new Error('Gateway process identity could not be established');
    record.processScope = { jobName: `Local\\RCExperiment-${randomUUID()}`, root };
    await writeJson(path.join(record.runDir, 'runtime/process-scope.json'), { ...record.processScope, runDir: record.runDir, deadlineAt: record.experimentDeadlineAt });
    await writeJson(path.join(record.runDir, 'run.json'), record);
  }
  const script = fileURLToPath(new URL('../scripts/supervise-sample.ps1', import.meta.url));
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  const command = `& ${quote(script)} -RunDir ${quote(record.runDir)}`;
  const log = openSync(path.join(record.runDir, 'logs/process-supervisor.log'), 'a');
  let child;
  try {
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
      // Windows PowerShell 5.1 exits without running its command under Node's
      // DETACHED_PROCESS flag. Unref plus file stdio permits independent life.
      { windowsHide: true, stdio: ['ignore', log, log] });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  } finally { closeSync(log); }
  child.unref();
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const ready = await optionalJson(path.join(record.runDir, 'rc-status/process-scope-ready.json'));
    if (ready?.guardianPid === child.pid && ready.jobName === record.processScope.jobName) return ready;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Sample supervisor failed (${child.exitCode}/${child.signalCode}); inspect ${record.runDir}/logs/process-supervisor.log`);
    await pause(50);
  }
  throw new Error('Sample supervisor setup deadline expired; no model work may be submitted');
}
export async function waitForSampleStop(record, { normal = false, timeoutMs = 35000 } = {}) {
  if (!record.processScope) throw new Error('Run has no contained sample process scope');
  const receiptFile = path.join(record.runDir, 'rc-status/sample-stop-receipt.json');
  if (normal) await writeJson(path.join(record.runDir, 'rc-status/normal-stop-request.json'), { jobName: record.processScope.jobName, at: Date.now() });
  else if (Date.now() < record.experimentDeadlineAt) throw new Error('Whole-sample hard stop is not authorized before its deadline');
  const end = Date.now() + timeoutMs;
  let recovered = false;
  while (Date.now() < end) {
    const receipt = await optionalJson(receiptFile);
    if (receipt) return validateStopReceipt(record, receipt);
    const heartbeat = await optionalJson(path.join(record.runDir, 'rc-status/process-scope-heartbeat.json'));
    if (!recovered && (!heartbeat || Date.now() - heartbeat.at > 2000)) {
      recovered = true;
      // Reopen only the original named Job. Its previous supervisor may have
      // finished during setup, so recheck its receipt before reporting failure.
      try { await startSampleSupervisor(record); }
      catch (error) {
        const completed = await optionalJson(receiptFile);
        if (completed) return validateStopReceipt(record, completed);
        throw error;
      }
    }
    await pause(50);
  }
  throw new Error('Sample process group stop is not confirmed');
}
