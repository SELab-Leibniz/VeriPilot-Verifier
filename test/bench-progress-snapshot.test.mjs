import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { inspectArktsProgress } from '../scripts/bench/progress-snapshot.mjs';
const execute = promisify(execFile);
const git = process.platform === 'win32' ? 'C:/Program Files/Git/cmd/git.exe' : 'git';
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-progress-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, 'project'), run = path.join(root, 'run');
  await fs.mkdir(projectRoot); await fs.mkdir(path.join(run, 'native-host'), { recursive: true });
  const runGit = args => execute(git, ['-C', projectRoot, ...args], { windowsHide: true });
  await runGit(['init', '--quiet']);
  await fs.writeFile(path.join(projectRoot, 'app.ets'), 'before\n');
  await runGit(['add', '.']);
  await runGit(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=nonexistent', 'commit', '--quiet', '-m', 'fixture']);
  const save = (name, value) => fs.writeFile(path.join(run, name), JSON.stringify(value));
  await save('manifest.json', { projectRoot, ownerPid: process.pid });
  await save('progress.json', { state: 'RUNNING', ownerPid: process.pid, sessionId: 'session' });
  await save('inherited-business-scope.json', { mutationPaths: [] });
  await fs.writeFile(path.join(projectRoot, 'app.ets'), 'after\n');
  await fs.writeFile(path.join(projectRoot, '新 helper.ets'), 'new source\n');
  await fs.writeFile(path.join(projectRoot, 'USER.md'), 'unattributed bootstrap\n');
  const rows = [
    { message: { role: 'assistant', content: [{ type: 'toolCall', id: '1', name: 'edit', arguments: { path: 'app.ets' } }] } },
    { message: { role: 'toolResult', toolCallId: '1', toolName: 'edit', isError: false } },
    { message: { role: 'assistant', content: [{ type: 'toolCall', id: '2', name: 'write', arguments: { path: '新 helper.ets' } }] } },
    { message: { role: 'toolResult', toolCallId: '2', toolName: 'write', isError: false } }
  ];
  const transcript = path.join(run, 'native-host/session.jsonl');
  await fs.writeFile(transcript, rows.map(JSON.stringify).join('\n') + '\n');
  return { run, transcript, projectRoot, save, rows };
}

test('progress includes attributed new files without staging or counting bootstrap files', async t => {
  const f = await fixture(t), indexFile = path.join(f.projectRoot, '.git/index');
  const index = await fs.readFile(indexFile), transcript = await fs.readFile(f.transcript);
  const result = await inspectArktsProgress(f.run);
  assert.equal(result.ownerAlive, true);
  assert.deepEqual(result.mutationPaths, ['app.ets', '新 helper.ets']);
  assert.deepEqual(result.untrackedMutationPaths, ['新 helper.ets']);
  assert.match(result.trackedDiffStat, /app\.ets/);
  assert.doesNotMatch(JSON.stringify(result), /unattributed bootstrap/);
  assert.equal(result.result, null);
  assert((await fs.readFile(indexFile)).equals(index));
  assert((await fs.readFile(f.transcript)).equals(transcript));
});

test('active partial append is flagged but corruption in a complete prefix is rejected', async t => {
  const f = await fixture(t);
  await fs.appendFile(f.transcript, '{"message":');
  const result = await inspectArktsProgress(f.run);
  assert.equal(result.transcriptPartialTail, true);
  assert.equal(result.mutationPaths.length, 2);
  await fs.appendFile(f.transcript, '\n');
  await assert.rejects(inspectArktsProgress(f.run), SyntaxError);
});

test('preparation and missing inherited attribution are explicit unknown states', async t => {
  const f = await fixture(t);
  await fs.rm(path.join(f.run, 'inherited-business-scope.json'));
  const result = await inspectArktsProgress(f.run);
  assert.equal(result.sourceScopeAvailable, false);
  assert.equal(result.mutationPaths, null);
  await fs.rm(path.join(f.run, 'manifest.json'));
  assert.equal((await inspectArktsProgress(f.run)).preparing, true);
});

test('active continuation uses the restored prefix boundary and rejects owner mismatch', async t => {
  const f = await fixture(t);
  await f.save('manifest.json', { projectRoot: f.projectRoot, ownerPid: process.pid, resumedFrom: 'previous-run' });
  const history = [
    { message: { role: 'assistant', content: [{ type: 'toolCall', id: 'old', name: 'write', arguments: { path: 'USER.md' } }] } },
    { message: { role: 'toolResult', toolCallId: 'old', toolName: 'write', isError: false } }
  ];
  await fs.writeFile(f.transcript, [...history, ...f.rows].map(JSON.stringify).join('\n') + '\n');
  assert.equal((await inspectArktsProgress(f.run)).sourceScopeAvailable, false);
  await f.save('resume-evidence.json', { restoredRecordCount: 2 });
  assert.deepEqual((await inspectArktsProgress(f.run)).mutationPaths, ['app.ets', '新 helper.ets']);
  await f.save('progress.json', { ownerPid: process.pid + 1, sessionId: 'session' });
  await assert.rejects(inspectArktsProgress(f.run), /owner identity changed/);
});
