import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { isolateInterruptedBenchmarkOwner } from '../scripts/helpers/benchmark-resume-control.mjs';

async function fixture(t, changes = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stop-resume-owner-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const previous = path.join(root, 'previous'), restored = path.join(root, 'restored');
  await fs.mkdir(previous);
  const control = path.join(restored, 'native-host/state/runtime-corrector-stop-sessions/post-run');
  await fs.mkdir(control, { recursive: true });
  await fs.writeFile(path.join(control, 'owner.json'), '{"phase":"RUNNING"}');
  for (const [name, value] of Object.entries({ 'process-exit.json': { relayClosed: true },
    'closure.json': { gatewayClosed: true }, 'result.json': { complete: false, corrections: 0, privateRuns: [], ...changes } }))
    await fs.writeFile(path.join(previous, name), JSON.stringify(value));
  return { previous, restored, control };
}

test('closed interrupted original owner is archived without deleting its evidence', async t => {
  const f = await fixture(t);
  assert.equal(await isolateInterruptedBenchmarkOwner(f.previous, f.restored), true);
  assert.equal(await fs.readFile(path.join(f.restored, 'prior-interrupted-post-run-control/owner.json'), 'utf8'), '{"phase":"RUNNING"}');
  assert.equal(await fs.stat(f.control).catch(() => null), null);
});

test('completed review, admitted repairs and private review work retain their control', async t => {
  for (const change of [{ complete: true }, { sessionCorrections: 1 }, { privateRuns: [{ role: 'stop-reviewer' }] }]) {
    const f = await fixture(t, change);
    assert.equal(await isolateInterruptedBenchmarkOwner(f.previous, f.restored), false);
    assert(await fs.stat(f.control));
  }
});

test('an unclosed prior host cannot lose its control owner', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.previous, 'process-exit.json'), '{"relayClosed":false}');
  await assert.rejects(isolateInterruptedBenchmarkOwner(f.previous, f.restored), /not confirmed closed/);
  assert(await fs.stat(f.control));
});
