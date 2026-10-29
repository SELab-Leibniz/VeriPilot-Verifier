// Capture a dead experiment from persisted observations. This never stops a
// process, manufactures a host terminal, or turns interrupted work into PASS.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { businessMutationPaths } from './bench/business-mutations.mjs';
import { findTask } from '../lib/runtime-v2/task-store.mjs';
import { listNativeRuns } from '../lib/openclaw/native-runs.mjs';
import { providerUsageCoverage } from './bench/provider-usage-coverage.mjs';
const arg = key => process.argv.find(value => value.startsWith(`${key}=`))?.slice(key.length + 1);
if (!arg('--run') || !arg('--reason')) throw new Error('--run and --reason required');
const directory = await fs.realpath(arg('--run'));
const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
const progress = JSON.parse(await fs.readFile(path.join(directory, 'progress.json'), 'utf8'));
if (!Number.isSafeInteger(manifest.ownerPid) || manifest.ownerPid < 1 || progress.ownerPid !== manifest.ownerPid
  || !progress.sessionId || !progress.runId || progress.actualBusinessStart !== true) throw new Error('Missing persisted business-owner observations');
try { process.kill(manifest.ownerPid, 0); throw new Error('Experiment owner is still alive'); }
catch (error) { if (error.code !== 'ESRCH') throw error; }
async function captureNativeBinding() {
  const resultBytes = await fs.readFile(path.join(directory, 'result.json'));
  const result = JSON.parse(resultBytes);
  if (result.operatorInterrupted !== true || result.actualBusinessStart !== true || result.sessionId !== progress.sessionId
    || result.sessionKey !== progress.sessionKey) throw new Error('Native binding capture requires this interrupted business identity');
  const identity = { agentId: 'main', sessionId: result.sessionId, sessionKey: result.sessionKey };
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  const hash = sha(JSON.stringify(identity));
  const source = path.join(directory, 'native-host/state/plugins/runtime-corrector/session-projects', hash, 'scope.json');
  const bytes = await fs.readFile(source).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!bytes) return { status: 'NO_NATIVE_SCOPE_FOUND' };
  const scope = JSON.parse(bytes);
  if (scope.source !== 'host' || !scope.taskId || scope.inactive || (result.taskId && result.taskId !== scope.taskId)
    || path.relative(path.resolve(manifest.projectRoot), path.resolve(scope.projectRoot)) !== '') throw new Error('Native binding capture authority mismatch');
  const proof = { kind: 'captured-native-task-binding', identity, projectRoot: manifest.projectRoot, taskId: scope.taskId,
    sourceScopeSha256: sha(bytes), resultSha256: sha(resultBytes) };
  const file = path.join(directory, 'native-binding-capture.json');
  const existing = await fs.readFile(file, 'utf8').then(JSON.parse, error => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing && JSON.stringify(existing) !== JSON.stringify(proof)) throw new Error('Existing native binding capture conflicts');
  if (!existing) await fs.writeFile(file, JSON.stringify(proof, null, 2), { flag: 'wx' });
  return { status: existing ? 'ALREADY_IDENTICAL' : 'CAPTURED_AUTHENTIC_BINDING', ...proof };
}
if (process.argv.includes('--capture-binding-only')) {
  console.log(JSON.stringify(await captureNativeBinding())); process.exit(0);
}
if (await fs.stat(path.join(directory, 'result.json')).catch(() => null)) throw new Error('Preserve existing result.json');
const git = arg('--git') ?? (process.platform === 'win32' ? 'C:/Program Files/Git/cmd/git.exe' : 'git');
const projectRoot = await fs.realpath(manifest.projectRoot);
const execute = argv => execFileSync(git, ['--literal-pathspecs', '-C', projectRoot, ...argv], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
if (execute(['rev-parse', 'HEAD']).toString().trim() !== manifest.preparedHead) throw new Error('Prepared source HEAD changed');
const transcript = await fs.readFile(path.join(directory, 'native-host', `${progress.sessionId}.jsonl`));
const records = transcript.toString('utf8').split('\n').filter(Boolean).map(JSON.parse);
const inherited = JSON.parse(await fs.readFile(path.join(directory, 'inherited-business-scope.json'), 'utf8'));
const mutationPaths = [...new Set([...inherited.mutationPaths, ...businessMutationPaths(records, projectRoot)])].sort();
if (mutationPaths.length) execute(['add', '--intent-to-add', '--', ...mutationPaths]);
await fs.writeFile(path.join(directory, 'workspace.patch'), execute(['diff', '--binary', 'HEAD']), { flag: 'wx' });
const patch = mutationPaths.length ? execute(['diff', '--binary', 'HEAD', '--', ...mutationPaths]) : Buffer.alloc(0);
await fs.writeFile(path.join(directory, 'candidate.patch'), patch, { flag: 'wx' });
await fs.writeFile(path.join(directory, 'candidate-scope.json'), JSON.stringify({ mutationPaths, inheritedScope: inherited,
  basis: 'Persisted successful native write/edit/apply_patch receipts after experiment-owner death; no host terminal is inferred.' }, null, 2), { flag: 'wx' });
const task = await findTask({ projectRoot, sessionId: progress.sessionId });
const runs = task ? await listNativeRuns(projectRoot, task.taskId) : [];
const assistants = records.filter(row => row.message?.role === 'assistant').map(row => row.message);
const recordedUsage = Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'].map(key =>
  [key, assistants.reduce((sum, row) => sum + (typeof row.usage?.[key] === 'number' ? row.usage[key] : 0), 0)]));
const timing = (await fs.readFile(path.join(directory, 'native-host/provider-fetch-timing.jsonl'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
const requestCount = new Set(timing.filter(row => row.event === 'request').map(row => row.id)).size;
const nonzeroUsageRecords = assistants.filter(row => row.usage && ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'].some(key => row.usage[key] > 0)).length;
const interruption = { kind: 'captured-dead-arkts-experiment', capturedAt: new Date().toISOString(), ownerPid: manifest.ownerPid,
  reason: arg('--reason'), transcriptSha256: createHash('sha256').update(transcript).digest('hex'), recordCount: records.length,
  lastControllerObservation: progress, recordedUsage, nonzeroUsageRecords, providerRequests: requestCount,
  providerUsageCoverage: providerUsageCoverage(requestCount, nonzeroUsageRecords), completeUsageKnown: false,
  qualification: 'Reported usage only. Interrupted or in-flight provider work may have consumed unreported tokens. No official host terminal was captured.' };
await fs.writeFile(path.join(directory, 'interruption.json'), JSON.stringify(interruption, null, 2), { flag: 'wx' });
const result = { ...manifest, state: 'INCOMPLETE', operatorInterrupted: true, sessionId: progress.sessionId,
  sessionKey: progress.sessionKey, originalRunId: progress.runId, finalBusinessRunId: progress.selectedBusinessRunId,
  actualBusinessStart: true, businessCompleted: false, infrastructureComplete: false, taskId: task?.taskId,
  privateRuns: runs, elapsedMs: Date.now() - progress.startedAt, postPhase: progress.postPhase,
  endReason: 'HARNESS_DIAGNOSTIC_INTERRUPTION', officialBusinessTerminal: null, patchBytes: patch.length,
  interruption: 'interruption.json', score: 'NOT_YET_GRADED; interrupted lifecycle is separate from functional score.' };
await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
const nativeBinding = await captureNativeBinding();
await fs.writeFile(path.join(directory, 'progress.json'), JSON.stringify({ ...progress, state: 'INTERRUPTED', endedAt: Date.now(), reason: arg('--reason') }, null, 2));
console.log(JSON.stringify({ state: result.state, mutationPaths, patchBytes: patch.length, nonzeroUsageRecords, requestCount, completeUsageKnown: false, nativeBinding }));
