import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { json, optionalJson, writeJson } from '../lib/files.mjs';
import { startSampleSupervisor, waitForSampleStop, inspectProcess } from '../lib/process-scope.mjs';
import { startDeadlineWatchdog } from '../lib/deadline-watchdog.mjs';
import { saveRunRecord, queryExperimentStatus } from '../lib/experiment-status.mjs';

const enabled = process.platform === 'win32' && Boolean(process.env.RC_TEST_HOST_ROOT);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const fixture = `import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const [role, dir] = process.argv.slice(2);
fs.writeFileSync(path.join(dir, role + '.json'), JSON.stringify({pid:process.pid}));
if(role==='root') {
  const timer=setInterval(()=>{
    if(fs.existsSync(path.join(dir,'rc-status/process-scope-ready.json'))) {
      clearInterval(timer);
      spawn(process.execPath,[fileURLToPath(import.meta.url),'child',dir],{detached:true,windowsHide:true,stdio:'ignore'}).unref();
    }
  },20);
} else if(role==='child') {
  spawn(process.execPath,[fileURLToPath(import.meta.url),'grandchild',dir],{detached:true,windowsHide:true,stdio:'ignore'}).unref();
}
setInterval(()=>{},1000);
`;
async function waitFor(read, predicate, timeoutMs = 10000) {
  const end = Date.now() + timeoutMs;
  do { const value = await read(); if (predicate(value)) return value; await pause(50); } while (Date.now() < end);
  throw new Error('Fixture condition deadline expired');
}
async function launch() {
  const runDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'RC 进程边界 ')));
  for (const dir of ['runtime', 'logs', 'rc-status']) await fs.mkdir(path.join(runDir, dir));
  const file = path.join(runDir, 'openclaw.mjs'); await fs.writeFile(file, fixture);
  const start = role => spawn(process.execPath, [file, role, runDir], { detached: true, windowsHide: true, stdio: 'ignore' });
  const root = start('root'), sibling = start('external');
  await Promise.all([root, sibling].map(child => new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); })));
  const at = Date.now();
  const record = { version: 2, id: path.basename(runDir), runDir, gatewayPid: root.pid, phase: 'NEEDS_ATTENTION',
    createdAt: new Date(at).toISOString(), experimentStartedAt: at, experimentDeadlineAt: at + 14000,
    input: { id: 'process-scope-fixture', execution: { maxRuntimeMs: 14000 }, paths: { node: process.execPath, openclawRoot: runDir } } };
  return { record, root, sibling, async dispose() {
    root.kill(); sibling.kill();
    if (await optionalJson(path.join(runDir, 'rc-status/process-scope-ready.json')))
      await waitFor(() => optionalJson(path.join(runDir, 'rc-status/sample-stop-receipt.json')), v => v?.activeProcesses === 0, 20000);
    if (record.deadlineWatchdog) await waitFor(() => optionalJson(path.join(runDir, 'rc-status/deadline-watchdog-exit.json')), Boolean, 15000);
  } };
}

test('Windows kernel Job: premature normal stop is ignored; hard limit kills detached descendants only in this sample',
  { skip: !enabled, timeout: 45000 }, async () => {
    const f = await launch(); const { record, root, sibling } = f;
    try {
      await startSampleSupervisor(record);
      await startDeadlineWatchdog(record); await saveRunRecord(record);
      const firstStatus = await queryExperimentStatus(record.runDir);
      assert.equal(firstStatus.canScheduleNext, false); assert.equal(firstStatus.terminal, false);
      const grandchild = await waitFor(() => optionalJson(path.join(record.runDir, 'grandchild.json')), Boolean);
      await writeJson(path.join(record.runDir, 'rc-status/normal-stop-request.json'), { jobName: record.processScope.jobName });
      await pause(700);
      assert.equal(root.exitCode, null); assert.equal(root.signalCode, null);
      assert.ok(await inspectProcess(grandchild.pid));
      await pause(Math.max(0, record.experimentDeadlineAt - Date.now()));
      const receipt = await waitForSampleStop(record);
      assert.equal(receipt.reason, 'EXPERIMENT_DEADLINE_EXPIRED'); assert.equal(receipt.activeProcesses, 0);
      assert.ok(receipt.totalProcesses >= 3); assert.ok(receipt.requestedAt >= record.experimentDeadlineAt);
      assert.equal(await inspectProcess(grandchild.pid), null);
      assert.equal(sibling.exitCode, null); assert.equal(sibling.signalCode, null);
      const finalStatus = await waitFor(() => json(path.join(record.runDir, 'experiment-status.json')), s => s.status === 'TIMED_OUT' && s.resultFinalized);
      assert.equal(finalStatus.canScheduleNext, true); assert.equal(finalStatus.resourcesReleased, true);
      console.log(`Native hard-limit scope proof: ${record.runDir}`);
    } finally { await f.dispose(); }
  });

test('Windows kernel Job: supervisor loss does not kill healthy RC; recovery preserves the same Job and deadline',
  { skip: !enabled, timeout: 45000 }, async () => {
    const f = await launch(); const { record, root, sibling } = f;
    try {
      const ready = await startSampleSupervisor(record);
      const grandchild = await waitFor(() => optionalJson(path.join(record.runDir, 'grandchild.json')), Boolean);
      const guardian = await inspectProcess(ready.guardianPid);
      assert.match(guardian.commandLine, /powershell\.exe/i);
      process.kill(ready.guardianPid, 'SIGTERM'); await pause(400);
      assert.equal(root.exitCode, null); assert.equal(root.signalCode, null);
      assert.ok(await inspectProcess(grandchild.pid));
      const jobName = record.processScope.jobName, deadline = record.experimentDeadlineAt;
      await startSampleSupervisor(record);
      assert.equal(record.processScope.jobName, jobName); assert.equal(record.experimentDeadlineAt, deadline);
      await pause(Math.max(0, deadline - Date.now()));
      const receipt = await waitForSampleStop(record);
      assert.equal(receipt.activeProcesses, 0); assert.ok(receipt.totalProcesses >= 3);
      assert.equal(sibling.exitCode, null); assert.equal(sibling.signalCode, null);
      console.log(`Native supervisor recovery proof: ${record.runDir}`);
    } finally { await f.dispose(); }
  });

test('Windows kernel Job: a retained handle to a dead Gateway does not block normal cleanup or kill an unrelated process',
  { skip: !enabled, timeout: 35000 }, async () => {
    const f = await launch(); const { record, root, sibling } = f;
    let holder;
    try {
      await startSampleSupervisor(record);
      await waitFor(() => optionalJson(path.join(record.runDir, 'grandchild.json')), Boolean);
      const heldFile = path.join(record.runDir, 'held-root.json');
      const quote = value => "'" + value.replaceAll("'", "''") + "'";
      const command = `$held=[System.Diagnostics.Process]::GetProcessById(${root.pid}); $handle=$held.Handle; [System.IO.File]::WriteAllText(${quote(heldFile)},'{"held":true}'); Start-Sleep -Seconds 25; $held.Dispose()`;
      holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
        { windowsHide: true, stdio: 'ignore' });
      await new Promise((resolve, reject) => { holder.once('spawn', resolve); holder.once('error', reject); });
      await waitFor(() => optionalJson(heldFile), Boolean);
      root.kill();
      const receipt = await waitForSampleStop(record, { normal: true, timeoutMs: 5000 });
      assert.equal(receipt.reason, 'NORMAL_CLEANUP'); assert.equal(receipt.activeProcesses, 0);
      assert.equal(holder.exitCode, null); assert.equal(holder.signalCode, null);
      assert.equal(sibling.exitCode, null); assert.equal(sibling.signalCode, null);
      console.log(`Native retained-process-handle cleanup proof: ${record.runDir}`);
    } finally { holder?.kill(); await f.dispose(); }
  });
