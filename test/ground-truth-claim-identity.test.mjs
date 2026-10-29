import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureTask } from '../lib/runtime-v2/task-store.mjs';
import { applyGroundTruthDelta, loadCurrentGroundTruth } from '../lib/runtime-v2/ground-truth-ledger.mjs';

const claim = overrides => ({ operation: 'ADD', category: 'requirements', authority: 'USER_EXPLICIT', severity: 'HARD',
  text: 'Preserve passing checks and deliver app.mjs and report.md when requested.',
  source: { kind: 'USER_MESSAGE', subject: 'MAIN_TASK', ref: 'transcript:identity-user#L1-L1' },
  applicabilityKind: 'CURRENT_TASK', verificationTarget: 'PROCESS', ...overrides });
async function fixture(t, name) {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-claim-identity-'));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  const task = await ensureTask({ projectRoot, sessionId: name });
  return { projectRoot, taskId: task.taskId };
}

test('implicit IDs preserve process and implementation obligations from the same original paragraph in either order', async t => {
  const process = claim();
  const implementation = claim({ verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION', applicabilityKind: 'CONDITIONAL' });
  const ids = [];
  for (const operations of [[process, implementation], [implementation, process]]) {
    const f = await fixture(t, 'typed-pair');
    const result = await applyGroundTruthDelta({ ...f, delta: { operations } });
    assert.equal(result.accepted.length, 2);
    assert.equal(result.current.claims.length, 2, 'Neither proof owner may silently replace the other.');
    assert.deepEqual(new Set(result.current.claims.map(c => c.verificationTarget)), new Set(['PROCESS', 'IMPLEMENTATION']));
    ids.push(Object.fromEntries(result.current.claims.map(c => [c.verificationTarget, c.claimId])));
  }
  assert.deepEqual(ids[0], ids[1], 'Generated identity must not depend on extraction order.');
});

test('implicit identity retains distinct applicability, implementation roles and explicit output obligations', async t => {
  const f = await fixture(t, 'typed-scope');
  const variants = [
    claim({ verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION' }),
    claim({ verificationTarget: 'IMPLEMENTATION', implementationRole: 'TEST' }),
    claim({ verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION', applicabilityKind: 'CONDITIONAL' }),
    claim({ verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION', expectedFiles: ['app.mjs'] }),
    claim({ verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION', expectedFiles: ['report.md'] }),
  ];
  const result = await applyGroundTruthDelta({ ...f, delta: { operations: variants } });
  assert.equal(result.current.claims.length, variants.length);
  assert.equal(new Set(result.current.claims.map(c => c.claimId)).size, variants.length);
});

test('repeated implicit ADD keeps an existing legacy ID and revision', async t => {
  const f = await fixture(t, 'legacy-identity');
  const first = await applyGroundTruthDelta({ ...f, delta: { operations: [claim({ claimId: 'legacy-stable-id' })] } });
  const duplicate = await applyGroundTruthDelta({ ...f, delta: { operations: [claim()] } });
  assert.equal(duplicate.current.claims.length, 1);
  assert.equal(duplicate.current.claims[0].claimId, 'legacy-stable-id');
  assert.equal(duplicate.current.claims[0].revisionId, first.current.claims[0].revisionId);
  assert.equal(duplicate.changed, false);
});

test('capability bindings with different production modules are not deduplicated as one obligation', async t => {
  const f = await fixture(t, 'capability-identity');
  const result = await applyGroundTruthDelta({ ...f, delta: { operations: ['ModuleA', 'ModuleB'].map(module => claim({
    category: 'capabilityChecklist', verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION',
    capability: { name: 'query', module },
  })) } });
  assert.equal(result.current.claims.length, 2);
  assert.deepEqual(new Set(result.current.claims.map(c => c.capability.module)), new Set(['ModuleA', 'ModuleB']));
});

test('ADD cannot implicitly resurrect a retracted identity or replace an explicit ID', async t => {
  const f = await fixture(t, 'no-implicit-replacement');
  const first = await applyGroundTruthDelta({ ...f, delta: { operations: [claim()] } });
  const id = first.current.claims[0].claimId;
  await assert.rejects(applyGroundTruthDelta({ ...f, delta: { operations: [claim({ claimId: id, verificationTarget: 'ARTIFACT' })] } }), /ADD cannot replace/u);
  await applyGroundTruthDelta({ ...f, delta: { operations: [claim({ operation: 'RETRACT', claimId: id })] } });
  const before = await loadCurrentGroundTruth(f.projectRoot, f.taskId);
  await assert.rejects(applyGroundTruthDelta({ ...f, delta: { operations: [claim()] } }), /ADD.*existing.*identity/u);
  const after = await loadCurrentGroundTruth(f.projectRoot, f.taskId);
  assert.deepEqual(after, before, 'Rejected implicit replacement must leave the ledger unchanged.');
});
