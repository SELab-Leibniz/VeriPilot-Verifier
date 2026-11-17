// Deadline guardian owns no model/session allocation. It survives an observer
// exit, and adopts the original run only when its controller lock is available.
import path from 'node:path';
import { json, writeJson } from '../lib/files.mjs';
import { resume } from '../lib/runner.mjs';
import { startSampleSupervisor } from '../lib/process-scope.mjs';
import { publishExperimentStatus } from '../lib/experiment-status.mjs';

const runDir = path.resolve(process.argv[2]);
let firstAttempt;
try {
  for (;;) {
    const record = await json(path.join(runDir, 'run.json'));
    await publishExperimentStatus(runDir, { role: 'deadline-watchdog' }).catch(() => {});
    if (record.gatewayStoppedAt || ['ARCHIVED', 'TIMED_OUT'].includes(record.phase)) break;
    const remaining = record.experimentDeadlineAt - Date.now();
    if (remaining > 0) {
      const heartbeat = await json(path.join(runDir, 'rc-status/process-scope-heartbeat.json')).catch(() => null);
      if (!heartbeat || Date.now() - heartbeat.at > 15000) await startSampleSupervisor(record);
      await new Promise(resolve => setTimeout(resolve, Math.min(1000, remaining))); continue;
    }
    firstAttempt ??= Date.now();
    try {
      const result = await resume(runDir);
      console.log(JSON.stringify({ at: Date.now(), status: result.result.status, reason: result.result.reason }));
      if (result.result.status !== 'TIMED_OUT') process.exitCode = 5;
      break;
    } catch (e) {
      if (!/already observed by PID/.test(e.message) || Date.now() - firstAttempt > 60000) throw e;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
} catch (e) { console.error(String(e.message)); process.exitCode = 2; }
finally {
  await publishExperimentStatus(runDir, { role: 'deadline-watchdog' }).catch(() => {});
  await writeJson(path.join(runDir, 'rc-status/deadline-watchdog-exit.json'), { pid: process.pid, at: Date.now(), exitCode: process.exitCode ?? 0 });
}
