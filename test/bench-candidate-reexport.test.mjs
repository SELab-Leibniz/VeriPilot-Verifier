import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { arktsGradingRevisions } from '../scripts/bench/arkts-grading-revisions.mjs';
const execute = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/reexport-arkts-candidate.mjs', import.meta.url));
const git = process.platform === 'win32' ? 'C:/Program Files/Git/cmd/git.exe' : 'git';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-reexport-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, 'project'), run = path.join(root, 'run'), output = path.join(run, 'candidate-exports/export-001');
  await fs.mkdir(projectRoot); await fs.mkdir(path.join(run, 'native-host'), { recursive: true });
  const runGit = async args => (await execute(git, ['--literal-pathspecs', '-C', projectRoot, ...args], { windowsHide: true })).stdout;
  await runGit(['init', '--quiet']);
  await fs.writeFile(path.join(projectRoot, 'app.ets'), 'const color = 0;\n');
  await fs.writeFile(path.join(projectRoot, 'old file.ets'), 'old\n');
  await fs.writeFile(path.join(projectRoot, 'bootstrap.ets'), 'bootstrap = 0;\n');
  await runGit(['add', '.']);
  await runGit(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=nonexistent', 'commit', '--quiet', '-m', 'fixture']);
  const child = spawn(process.execPath, ['-e', ''], { windowsHide: true }), ownerPid = child.pid;
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.notEqual(ownerPid, process.pid);
  // This export fixture observes its original owner as exited. The OS may reuse
  // that numeric PID before another CLI call; other owners still use real kill(0).
  const closedOwnerObservation = path.join(root, 'closed-owner-observation.cjs');
  await fs.writeFile(closedOwnerObservation, `const originalKill = process.kill;
process.kill = function (pid, signal) {
  if (pid === ${ownerPid} && signal === 0)
    throw Object.assign(new Error('The fixture original owner has exited'), { code: 'ESRCH' });
  return originalKill.call(this, pid, signal);
};\n`);
  const manifest = { projectRoot, ownerPid, preparedHead: (await runGit(['rev-parse', 'HEAD'])).trim(), instanceId: 'fixture', datasetDigest: 'fixture' };
  const result = { ...manifest, state: 'SETTLED', actualBusinessStart: true, sessionId: 'session', patchBytes: 0, verification: 'PASS' };
  const save = (name, value) => fs.writeFile(path.join(run, name), JSON.stringify(value));
  await save('manifest.json', manifest); await save('result.json', result); await save('inherited-business-scope.json', { mutationPaths: [] });
  await fs.writeFile(path.join(projectRoot, 'app.ets'), 'const color = 1;\n');
  await fs.rm(path.join(projectRoot, 'old file.ets'));
  await fs.writeFile(path.join(projectRoot, 'new file.ets'), Buffer.from([0, 1, 2, 3, 0, 255]));
  await fs.writeFile(path.join(projectRoot, 'bootstrap.ets'), 'bootstrap = 1;\n');
  await runGit(['add', '--intent-to-add', '--', 'new file.ets']);
  await fs.writeFile(path.join(run, 'workspace.patch'), await runGit(['diff', '--binary', 'HEAD']));
  await fs.writeFile(path.join(run, 'candidate.patch'), '');
  const records = [
    { message: { role: 'assistant', content: [{ type: 'toolCall', name: 'apply_patch', id: 'mutation', arguments: { input: 'fixture' } }] } },
    { message: { role: 'toolResult', toolName: 'apply_patch', toolCallId: 'mutation', isError: false,
      details: { summary: { added: ['new file.ets'], modified: ['app.ets'], deleted: ['old file.ets'] } } } }
  ];
  await fs.writeFile(path.join(run, 'native-host/session.jsonl'), records.map(JSON.stringify).join('\n') + '\n');
  return { run, output, manifest, result, save, projectRoot, runGit,
    invoke: () => execute(process.execPath, ['--require', closedOwnerObservation, script, `--run=${run}`, `--output=${output}`], { windowsHide: true }) };
}

test('reexport uses frozen diff and successful receipts, preserves originals and excludes bootstrap changes', async t => {
  const f = await fixture(t);
  const originals = new Map(await Promise.all(['result.json', 'workspace.patch', 'candidate.patch', 'native-host/session.jsonl']
    .map(async name => [name, await fs.readFile(path.join(f.run, name))])));
  // Neither a later working-tree edit nor the real index may affect capture.
  await fs.writeFile(path.join(f.projectRoot, 'app.ets'), 'const color = 999;\n');
  const index = await fs.readFile(path.join(f.projectRoot, '.git/index'));
  await f.invoke();
  const patch = await fs.readFile(path.join(f.output, 'candidate.patch'), 'utf8');
  assert.match(patch, /\+const color = 1;/);
  assert.doesNotMatch(patch, /999|bootstrap/);
  assert.match(patch, /GIT binary patch/);
  assert.match(patch, /deleted file mode/);
  for (const [name, bytes] of originals) assert((await fs.readFile(path.join(f.run, name))).equals(bytes));
  assert((await fs.readFile(path.join(f.projectRoot, '.git/index'))).equals(index));
  const proof = JSON.parse(await fs.readFile(path.join(f.output, 'proof.json')));
  assert.equal(proof.sourceSha256['result.json'], sha(originals.get('result.json')));
  assert.equal(proof.candidateSha256, sha(Buffer.from(patch)));
  assert.deepEqual(proof.mutationPaths, ['app.ets', 'new file.ets', 'old file.ets']);
  await assert.rejects(f.invoke(), /EEXIST/);
});

test('reexport rejects live ownership, changed prepared HEAD and mismatched business identity', async t => {
  const f = await fixture(t);
  await f.save('manifest.json', { ...f.manifest, ownerPid: process.pid });
  await assert.rejects(f.invoke(), /owner is still alive/);
  await f.save('manifest.json', f.manifest);
  await f.save('result.json', { ...f.result, instanceId: 'different' });
  await assert.rejects(f.invoke(), /identity mismatch/);
  await f.save('result.json', f.result);
  await f.runGit(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=nonexistent', 'commit', '--allow-empty', '--quiet', '-m', 'changed']);
  await assert.rejects(f.invoke(), /Prepared business HEAD changed/);
});

test('grading revisions bind frozen originals and select the latest revision rather than the highest score', async t => {
  const f = await fixture(t);
  await f.invoke();
  const proof = JSON.parse(await fs.readFile(path.join(f.output, 'proof.json')));
  const grade = (candidateSha256, resolved) => ({ instanceId: 'fixture', environment: { datasetDigest: 'fixture' }, candidateSha256,
    results: [{ phase: 'candidate', executed: resolved, resolved }] });
  await fs.mkdir(`${f.run}-grade`);
  await fs.writeFile(path.join(`${f.run}-grade`, 'results.json'), JSON.stringify(grade(sha(Buffer.alloc(0)), false)));
  await fs.mkdir(path.join(f.output, 'grade'));
  await fs.writeFile(path.join(f.output, 'grade/results.json'), JSON.stringify(grade(proof.candidateSha256, true)));
  const load = () => arktsGradingRevisions(f.run, { id: 'fixture', datasetDigest: 'fixture' }, f.result);
  const first = await load();
  assert.deepEqual(first.map(row => row.grade.resolved), [false, true]);
  const later = path.join(f.run, 'candidate-exports/export-002');
  await fs.mkdir(path.join(later, 'grade'), { recursive: true });
  for (const file of ['proof.json', 'candidate.patch']) await fs.copyFile(path.join(f.output, file), path.join(later, file));
  await fs.writeFile(path.join(later, 'grade/results.json'), JSON.stringify(grade(proof.candidateSha256, false)));
  assert.equal((await load()).at(-1).grade.resolved, false);
  await fs.writeFile(path.join(f.run, 'workspace.patch'), 'changed frozen source');
  await assert.rejects(load(), /frozen source changed/);
});

test('a new file absent from the frozen patch is rejected instead of being exported from a later workspace', async t => {
  const f = await fixture(t);
  const file = path.join(f.run, 'native-host/session.jsonl');
  const rows = (await fs.readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
  rows[1].message.details.summary.added.push('uncaptured.ets');
  await fs.writeFile(file, rows.map(JSON.stringify).join('\n') + '\n');
  await fs.writeFile(path.join(f.projectRoot, 'uncaptured.ets'), 'late content must not be used\n');
  await assert.rejects(f.invoke(), /Frozen workspace patch does not capture mutation/);
  assert.equal(await fs.stat(path.join(f.output, 'candidate.patch')).catch(() => null), null);
});
