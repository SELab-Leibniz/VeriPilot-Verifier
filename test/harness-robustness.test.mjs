import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { digest } from '../scripts/bench/arkts-dataset.mjs';
import { withFileLock, worktreeLockPath } from '../scripts/bench/file-lock.mjs';
import { seedReleaseRoot } from '../scripts/bench/seed-release-root.mjs';
import { bindWithRetry, reservePort } from '../scripts/helpers/native-gateway-evaluation.mjs';
import { installSimplifyProfileBoundary } from '../scripts/helpers/simplify-native-evaluation.mjs';

const temporary = async (t, prefix) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
};

test('worktree additions on one bare cache are serialized and a dead owner is reclaimed', async t => {
  const directory = await temporary(t, 'rc-file-lock-');
  const lock = worktreeLockPath(path.join(directory, 'repo.git'));
  assert.equal(lock, path.join(directory, 'repo.git.worktree-lock'));
  const order = [];
  const step = name => withFileLock(lock, async () => { order.push(`${name}+`); await new Promise(resolve => setTimeout(resolve, 30)); order.push(`${name}-`); return name; }, { pollMs: 5 });
  assert.deepEqual(await Promise.all([step('a'), step('b'), step('c')]), ['a', 'b', 'c']);
  for (let index = 0; index < order.length; index += 2) assert.equal(order[index].slice(0, -1), order[index + 1].slice(0, -1));
  await fs.mkdir(lock);
  await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: 999999, token: 'dead' }));
  assert.equal(await withFileLock(lock, async () => 'reclaimed', { pollMs: 5, alive: () => false }), 'reclaimed');
  await fs.mkdir(lock);
  await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, token: 'live' }));
  await assert.rejects(withFileLock(lock, async () => 'never', { pollMs: 5, timeoutMs: 50 }), /Timed out waiting/u);
  await assert.rejects(withFileLock(lock + '-2', async () => { throw new Error('action failed'); }), /action failed/u);
  await assert.rejects(fs.stat(lock + '-2'), { code: 'ENOENT' });
});

test('a Gateway port taken between reservation and bind is replaced instead of failing the run', async t => {
  const reserved = await reservePort(), squatter = net.createServer();
  t.after(() => squatter.close());
  let ports = [];
  const start = port => new Promise((resolve, reject) => {
    ports.push(port);
    if (ports.length === 1) {
      squatter.listen(port, '127.0.0.1', () => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve(server));
      });
    } else {
      const server = net.createServer();
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve(server));
    }
  });
  const rebinds = [];
  const bound = await bindWithRetry(start, reserved, { onRebind: async port => { rebinds.push(port); } });
  t.after(() => bound.server.close());
  assert.equal(bound.attempts, 2);
  assert.equal(ports[0], reserved.port);
  assert.deepEqual(rebinds, [bound.port]);
  assert.notEqual(bound.port, reserved.port);
  ports = [];
  await assert.rejects(bindWithRetry(() => Promise.reject(new Error('other failure')), await reservePort()), /other failure/u);
});

test('with a pause window a peer 429 delays the next dispatch instead of failing the run', async t => {
  const hostRoot = await temporary(t, 'rc-pair-pause-');
  await fs.mkdir(path.join(hostRoot, 'node_modules/undici'), { recursive: true });
  await fs.writeFile(path.join(hostRoot, 'node_modules/undici/index.js'), 'exports.fetch = globalThis.fetch;');
  const credential = () => 'test-only-credential-never-dispatched';
  const provider = { baseUrl: 'https://example.invalid/v1', model: 'deepseek-v4-flash' };
  const pairRateLimitFile = path.join(hostRoot, 'rate.txt');
  const send = () => fetch(`${provider.baseUrl}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${credential()}` }, body: JSON.stringify({ model: provider.model }) });
  const previous = globalThis.fetch;
  let dispatches = 0;
  globalThis.fetch = async () => { dispatches++; return new Response(null, { status: 200 }); };
  t.after(() => { globalThis.fetch = previous; });
  const strict = installSimplifyProfileBoundary({ hostRoot, provider, credential, pairRateLimitFile });
  try {
    await fs.writeFile(pairRateLimitFile, `${Date.now()}\n`);
    await assert.rejects(send, /PROFILE_PAIR_RATE_LIMIT/u);
    assert.equal(dispatches, 0);
  } finally { strict.close(); }
  const paused = installSimplifyProfileBoundary({ hostRoot, provider, credential, pairRateLimitFile, pairRateLimitPauseMs: 300 });
  try {
    const started = Date.now();
    await fs.writeFile(pairRateLimitFile, `${started}\n`);
    assert.equal((await send()).status, 200);
    assert.ok(Date.now() - started >= 250);
    await fs.writeFile(pairRateLimitFile, `${Date.now() - 10_000}\n`);
    assert.equal((await send()).status, 200);
    const snapshot = paused.snapshot();
    assert.equal(snapshot.requests, 2);
    assert.equal(snapshot.failure, null);
    assert.equal(snapshot.pairPauses, 1);
    assert.ok(snapshot.pairPausedMs >= 250);
    assert.equal(dispatches, 2);
  } finally { paused.close(); }
});

test('seeding from a shallow cache carries frozen commits that no ref reaches and leaves the old root unchanged', async t => {
  const directory = await temporary(t, 'rc-seed-');
  const git = (...args) => execFileSync('git', ['-c', 'user.name=rc', '-c', 'user.email=rc@example.invalid', ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  const origin = path.join(directory, 'origin'), old = path.join(directory, 'old'), cache = path.join(old, 'cache', 'o--r.git');
  git('init', '-q', origin);
  for (const name of ['first', 'base']) { await fs.writeFile(path.join(origin, 'file.txt'), name); git('-C', origin, 'add', 'file.txt'); git('-C', origin, 'commit', '-qm', name); }
  const base = git('-C', origin, 'rev-parse', 'HEAD');
  git('clone', '-q', '--bare', '--depth=1', pathToFileURL(origin).href, cache);
  const tree = git('--git-dir', cache, 'rev-parse', 'HEAD^{tree}');
  const preparedHead = git('--git-dir', cache, 'commit-tree', tree, '-p', base, '-m', 'prepared');
  const commit = git('--git-dir', cache, 'commit-tree', tree, '-p', preparedHead, '-m', 'frozen');
  await fs.mkdir(path.join(old, 'workflow', 'nested'), { recursive: true });
  await fs.writeFile(path.join(old, 'workflow', 'nested', 'policy.yaml'), 'pinned\n');
  const dataset = path.join(directory, 'dataset'), sample = path.join(directory, 'sample');
  await fs.mkdir(dataset); await fs.mkdir(sample);
  await fs.writeFile(path.join(dataset, 'fixture_1.json'), JSON.stringify({ instance_id: 'fixture_1', repo: 'o/r', base_commit: base, patch: '', patch_sha256: digest(''), test_patch: '', test_patch_sha256: digest(''), FAIL_TO_PASS: ['a::b::c'], PASS_TO_PASS: ['a::b::d'] }));
  await fs.writeFile(path.join(sample, 'freeze.json'), JSON.stringify({ preparedHead, commit }));
  const refsBefore = git('--git-dir', cache, 'for-each-ref');
  const root = path.join(directory, 'new');
  const frozen = [{ id: 'sample', case: 'fixture_1', root: sample }];
  const record = await seedReleaseRoot({ from: old, root, frozen, dataset });
  const seeded = path.join(root, 'cache', 'o--r.git');
  assert.deepEqual(record.caches, ['o--r.git']);
  assert.deepEqual(record.pinned.map(entry => entry.commit), [preparedHead, commit]);
  assert.equal(record.workflow, true);
  assert.equal(git('--git-dir', seeded, 'rev-parse', `refs/rc-bench/frozen/${commit}`), commit);
  assert.equal(git('--git-dir', seeded, 'rev-parse', `${commit}^`), preparedHead);
  assert.equal(await fs.readFile(path.join(root, 'workflow', 'nested', 'policy.yaml'), 'utf8'), 'pinned\n');
  assert.equal(git('--git-dir', cache, 'for-each-ref'), refsBefore);
  const again = await seedReleaseRoot({ from: old, root, frozen, dataset });
  assert.deepEqual([again.caches, again.workflow], [[], false]);
  await assert.rejects(seedReleaseRoot({ from: old, root: old, frozen, dataset }), /different run root/u);
});
