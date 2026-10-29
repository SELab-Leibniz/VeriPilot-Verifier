import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const execute = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/capture-arkts-interruption.mjs', import.meta.url));
const git = process.platform === 'win32' ? 'C:/Program Files/Git/cmd/git.exe' : 'git';
async function fixture(t, ownerPid) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-interruption-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, 'project'); await fs.mkdir(projectRoot);
  const manifest = { ownerPid, projectRoot, instanceId: 'fixture', datasetDigest: 'fixture', preparedHead: 'unused-before-git' };
  const progress = { ownerPid, sessionId: 'session', sessionKey: 'agent:main:fixture', runId: 'business',
    selectedBusinessRunId: 'business', startedAt: Date.now() - 1000, actualBusinessStart: true };
  const save = (name, value) => fs.writeFile(path.join(root, name), JSON.stringify(value));
  await save('manifest.json', manifest); await save('progress.json', progress);
  return { root, projectRoot, manifest, save, run: () => execute(process.execPath, [script, `--run=${root}`, '--reason=Controlled fixture interruption']) };
}
async function deadOwner() {
  const child = (await import('node:child_process')).spawn(process.execPath, ['-e', ''], { windowsHide: true });
  const pid = child.pid; await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  return pid;
}
test('a live experiment cannot be captured as interrupted', async t => {
  const f = await fixture(t, process.pid);
  await assert.rejects(f.run(), /owner is still alive/);
  assert.equal(await fs.stat(path.join(f.root, 'result.json')).catch(() => null), null);
});
test('an existing settled result is preserved byte for byte', async t => {
  const f = await fixture(t, await deadOwner());
  await f.save('result.json', { state: 'SETTLED', marker: 'original' });
  const before = await fs.readFile(path.join(f.root, 'result.json'));
  await assert.rejects(f.run(), /Preserve existing result/);
  assert((await fs.readFile(path.join(f.root, 'result.json'))).equals(before));
});
test('a dead-owner capture exports only real mutation receipts and never fabricates completion or complete usage', async t => {
  const f = await fixture(t, await deadOwner());
  const runGit = args => execute(git, ['-C', f.projectRoot, ...args], { windowsHide: true });
  await runGit(['init', '--quiet']);
  await fs.writeFile(path.join(f.projectRoot, 'app.mjs'), 'export const value = 0;\n');
  await runGit(['add', 'app.mjs']);
  await runGit(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=nonexistent', 'commit', '--quiet', '-m', 'fixture']);
  f.manifest.preparedHead = (await runGit(['rev-parse', 'HEAD'])).stdout.trim();
  await f.save('manifest.json', f.manifest); await f.save('inherited-business-scope.json', { mutationPaths: [] });
  await fs.writeFile(path.join(f.projectRoot, 'app.mjs'), 'export const value = 1;\n');
  await fs.writeFile(path.join(f.projectRoot, 'bootstrap.txt'), 'unattributed host output');
  await fs.mkdir(path.join(f.root, 'native-host'));
  const records = [{ message: { role: 'assistant', usage: { input: 1, output: 2, totalTokens: 3 },
    content: [{ type: 'toolCall', id: 'write-1', name: 'edit', arguments: { path: 'app.mjs' } }] } },
  { message: { role: 'toolResult', toolName: 'edit', toolCallId: 'write-1', content: [{ type: 'text', text: 'Success' }] } }];
  const transcript = records.map(JSON.stringify).join('\n') + '\n';
  await fs.writeFile(path.join(f.root, 'native-host/session.jsonl'), transcript);
  await fs.writeFile(path.join(f.root, 'native-host/provider-fetch-timing.jsonl'), '{"id":1,"event":"request"}\n');
  const identity = { agentId: 'main', sessionId: 'session', sessionKey: 'agent:main:fixture' };
  const hash = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  const scopeFile = path.join(f.root, 'native-host/state/plugins/runtime-corrector/session-projects', hash, 'scope.json');
  await fs.mkdir(path.dirname(scopeFile), { recursive: true });
  await fs.writeFile(scopeFile, JSON.stringify({ source: 'host', taskId: 'allocated-before-task-state', projectRoot: f.projectRoot }));
  await f.run();
  const result = JSON.parse(await fs.readFile(path.join(f.root, 'result.json')));
  assert.equal(result.state, 'INCOMPLETE'); assert.equal(result.businessCompleted, false);
  assert.equal(result.infrastructureComplete, false); assert.equal(result.officialBusinessTerminal, null);
  const patch = await fs.readFile(path.join(f.root, 'candidate.patch'), 'utf8');
  assert.match(patch, /app\.mjs/); assert.doesNotMatch(patch, /bootstrap\.txt/);
  assert.equal(await fs.readFile(path.join(f.root, 'native-host/session.jsonl'), 'utf8'), transcript);
  const interruption = JSON.parse(await fs.readFile(path.join(f.root, 'interruption.json')));
  assert.equal(interruption.completeUsageKnown, false); assert.equal(interruption.recordedUsage.totalTokens, 3);
  const proof = JSON.parse(await fs.readFile(path.join(f.root, 'native-binding-capture.json')));
  assert.equal(proof.taskId, 'allocated-before-task-state');
  const resultBytes = await fs.readFile(path.join(f.root, 'result.json'));
  assert.equal(proof.resultSha256, createHash('sha256').update(resultBytes).digest('hex'));
  await execute(process.execPath, [script, `--run=${f.root}`, '--reason=Capture binding only', '--capture-binding-only']);
  assert((await fs.readFile(path.join(f.root, 'result.json'))).equals(resultBytes));
});
