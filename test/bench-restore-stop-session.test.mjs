import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { restoreStopSessionLedger } from '../scripts/bench/restore-stop-session.mjs';
import { createStopCorrectionStore } from '../lib/runtime-v2/stop-correction-store.mjs';
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-session-restore-'));
  t.after(async () => {
    if (!path.resolve(root).startsWith(path.join(path.resolve(os.tmpdir()), 'rc-session-restore-'))) throw new Error('Unsafe cleanup path');
    await fs.rm(root, { recursive: true, force: true });
  });
  const projectRoot = path.join(root, 'project'), targetStateDirectory = path.join(root, 'target');
  await fs.mkdir(projectRoot);
  async function run(name, parent) {
    const directory = path.join(root, name); await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ instanceId: 'case', datasetDigest: 'digest', preparedHead: 'head', projectRoot, resumedFrom: parent }));
    return directory;
  }
  const original = await run('original'), resumed = await run('resumed', original), sessionId = 'session';
  const source = createStopCorrectionStore({ directory: path.join(original, 'native-host/state/runtime-corrector-stop-sessions') });
  return { root, source, params: { sourceRun: resumed, targetStateDirectory, sessionId, projectRoot } };
}
test('authentic history and used budget are restored byte for byte across a missing intermediate ledger', async t => {
  const f = await fixture(t);
  await f.source.initializeSession({ sessionId: 'session', initialize: { kind: 'VERIFIED_HISTORY',
    starts: [{ executionId: 'prior-correction', flowId: 'prior-flow', startedAt: 1 }], evidence: { fixture: true } } });
  const result = await restoreStopSessionLedger(f.params);
  assert.equal(result.used, 1); assert.equal(result.budgetReset, false);
  assert.deepEqual(await fs.readFile(result.source), await fs.readFile(result.target));
  assert.equal((await restoreStopSessionLedger(f.params)).status, 'ALREADY_IDENTICAL');
});
test('missing history is explicit and never becomes a fabricated zero-used ledger', async t => {
  const f = await fixture(t), result = await restoreStopSessionLedger(f.params);
  assert.equal(result.status, 'NO_AUTHENTIC_LEDGER_FOUND');
  await assert.rejects(fs.stat(f.params.targetStateDirectory), { code: 'ENOENT' });
});
test('conflicting targets and unresolved admissions are refused without resetting budgets', async t => {
  const f = await fixture(t);
  await f.source.initializeSession({ sessionId: 'session', initialize: { kind: 'VERIFIED_HISTORY', starts: [], evidence: { fixture: true } } });
  const result = await restoreStopSessionLedger(f.params);
  await fs.writeFile(result.target, '{}');
  await assert.rejects(restoreStopSessionLedger(f.params), /overwrite a different/u);
  const state = await f.source.inspect('session'); state.admissions.pending = { accounting: 'RESERVED' };
  await fs.writeFile(f.source.fileFor('session'), JSON.stringify(state));
  await assert.rejects(restoreStopSessionLedger(f.params), /require reconciliation/u);
});
