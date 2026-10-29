import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { restoreNativeProjectScope } from '../scripts/bench/restore-project-scope.mjs';
import { readSessionSetting, setSessionSetting } from '../lib/openclaw/session-settings.mjs';
async function fixture(t, enabled = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-scope-restore-'));
  t.after(async () => {
    if (!path.resolve(root).startsWith(path.join(path.resolve(os.tmpdir()), 'rc-scope-restore-'))) throw new Error('Unsafe cleanup path');
    await fs.rm(root, { recursive: true, force: true });
  });
  const projectRoot = path.join(root, 'project'), sourceRun = path.join(root, 'source'), targetStateDirectory = path.join(root, 'target');
  await fs.mkdir(projectRoot); await fs.mkdir(sourceRun);
  const identity = { agentId: 'main', sessionId: 'session', sessionKey: 'key' };
  await fs.writeFile(path.join(sourceRun, 'manifest.json'), JSON.stringify({ projectRoot }));
  await fs.writeFile(path.join(sourceRun, 'result.json'), JSON.stringify({ actualBusinessStart: true, sessionId: 'session', sessionKey: 'key', taskId: 'original-task' }));
  const sourceState = path.join(sourceRun, 'native-host/state');
  await setSessionSetting({ projectRoot, namespace: sourceState, identity, enabled });
  const hash = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  const source = path.join(sourceState, 'plugins/runtime-corrector/session-projects', hash, 'scope.json');
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, JSON.stringify({ projectRoot, source: 'host', taskId: 'original-task', fingerprint: 'fingerprint', startAt: null }));
  return { source, params: { sourceRun, targetStateDirectory, identity, projectRoot } };
}
test('native task identity and both enabled/disabled choices survive isolated profile recovery', async t => {
  for (const enabled of [true, false]) {
    const f = await fixture(t, enabled), restored = await restoreNativeProjectScope(f.params);
    assert.equal(restored.taskId, 'original-task');
    assert.deepEqual(await fs.readFile(f.source), await fs.readFile(restored.target));
    assert.equal((await readSessionSetting({ projectRoot: f.params.projectRoot, namespace: f.params.targetStateDirectory, identity: f.params.identity })).enabled, enabled);
  }
});
test('different target scopes are never replaced and inactive sources are never reactivated', async t => {
  const f = await fixture(t), restored = await restoreNativeProjectScope(f.params);
  await fs.writeFile(restored.target, '{}');
  await assert.rejects(restoreNativeProjectScope(f.params), /overwrite a different/u);
  const other = await fixture(t), scope = JSON.parse(await fs.readFile(other.source, 'utf8'));
  await fs.writeFile(other.source, JSON.stringify({ ...scope, inactive: true }));
  assert.equal((await restoreNativeProjectScope(other.params)).status, 'SOURCE_INACTIVE_NO_REACTIVATION');
});

test('an interrupted host allocation needs exact independent capture of the result, identity and scope bytes', async t => {
  const f = await fixture(t);
  const resultFile = path.join(f.params.sourceRun, 'result.json');
  const original = JSON.parse(await fs.readFile(resultFile, 'utf8'));
  delete original.taskId;
  await fs.writeFile(resultFile, JSON.stringify({ ...original, operatorInterrupted: true }));
  await assert.rejects(restoreNativeProjectScope(f.params), /no verified capture/);
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  const resultBytes = await fs.readFile(resultFile), scopeBytes = await fs.readFile(f.source);
  const proof = { kind: 'captured-native-task-binding', identity: f.params.identity, projectRoot: f.params.projectRoot,
    taskId: 'original-task', resultSha256: sha(resultBytes), sourceScopeSha256: sha(scopeBytes) };
  const proofFile = path.join(f.params.sourceRun, 'native-binding-capture.json');
  await fs.writeFile(proofFile, JSON.stringify(proof));
  const restored = await restoreNativeProjectScope(f.params);
  assert.equal(restored.taskId, 'original-task'); assert.match(restored.bindingAuthority, /host allocation/);
  assert((await fs.readFile(restored.target)).equals(scopeBytes));
  await fs.appendFile(resultFile, ' ');
  await assert.rejects(restoreNativeProjectScope(f.params), /no verified capture/);
  await fs.writeFile(resultFile, resultBytes); await fs.appendFile(f.source, ' ');
  await assert.rejects(restoreNativeProjectScope(f.params), /no verified capture/);
  await fs.writeFile(f.source, scopeBytes);
  await fs.writeFile(proofFile, JSON.stringify({ ...proof, identity: { ...proof.identity, sessionKey: 'another-session' } }));
  await assert.rejects(restoreNativeProjectScope(f.params), /no verified capture/);
});
