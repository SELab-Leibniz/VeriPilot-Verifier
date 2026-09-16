// Export only selected test task evidence; never read host credentials/config.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { readReport } from '../../lib/openclaw/report.mjs';
import { readJson } from '../../lib/runtime-v2/utils.mjs';
import { findTask, taskDirectory } from '../../lib/runtime-v2/task-store.mjs';
const [workspaceDir, sessionId, sessionKey, outputFile] = process.argv.slice(2);
if (!outputFile) throw new Error('Usage: collect-openclaw-interactions <workspace> <sessionId> <sessionKey> <output.json>');
const binding = { workspaceDir, sessionId, sessionKey };
const task = await findTask({ projectRoot: workspaceDir, sessionId });
if (!task) throw new Error('Test task not found.');
const directory = taskDirectory(workspaceDir, task.taskId);
const report = await readReport(binding);
const events = (await fs.readFile(path.join(directory, 'journal/events.jsonl'), 'utf8')).split(/\n/).filter(Boolean).map(JSON.parse)
  .filter(e => /^OPENCLAW_|STALE_ASSESSMENT|STOP_|CORRECTION_/u.test(e.type));
const snapshots = [];
for (const name of await fs.readdir(path.join(directory, 'artifact-snapshots')).catch(() => [])) {
  if (name.endsWith('.json')) snapshots.push(await readJson(path.join(directory, 'artifact-snapshots', name)));
}
const decisions = Object.values(task.control?.commands ?? {}).map(c => ({ commandId: c.commandId, actionId: c.actionId, action: c.action,
  status: c.status, receivedAt: c.receivedAt, startedAt: c.startedAt, deadlineAt: c.deadlineAt, windowId: c.windowId,
  guard: c.guard, reason: c.reason, correctionAttempt: c.correctionAttempt,
  assessment: c.outcome ? { decision: c.outcome.decision, status: c.outcome.report?.status, correctionAttempt: c.outcome.correctionAttempt,
    fileAssessments: (c.outcome.review ?? c.outcome.stop?.review)?.fileAssessments } : undefined }));
const output = { capturedAt: new Date().toISOString(), host: '2026.7.1-2', plugin: '1.9.1-openclaw.7', taskId: task.taskId,
  requirements: { version: task.groundTruth.version, digest: task.groundTruth.digest, epoch: task.correctionEpoch.id },
  budget: task.stop, verification: task.verification, report, decisions, events, snapshots };
let text = JSON.stringify(output, (key, value) => ['actor', 'commands', 'commandReceipts'].includes(key) ? undefined : value, 2).split(workspaceDir).join('$WORKSPACE');
if (/\b(?:ark-|sk-)[a-z0-9_-]{25,}/iu.test(text) || /ANTHROPIC_AUTH_TOKEN/u.test(text)) throw new Error('Export contains possible credentials; refusing.');
await fs.writeFile(outputFile, text + '\n');
console.log(JSON.stringify({ taskId: task.taskId, verification: report.verification, files: report.files.map(f => ({ file: f.file, status: f.status })), snapshots: snapshots.length }));
