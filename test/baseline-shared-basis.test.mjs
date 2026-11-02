import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createBaselineWorker, BASELINE_EXTRACTION_PROTOCOL } from '../lib/review-task/baseline-task.mjs';
import { GROUND_TRUTH_REVIEW_SCHEMA } from '../lib/runtime-v2/reviewer.mjs';
import { acknowledgedSharedProof, sharedOriginalBasis, sharedBasisMatches } from '../lib/runtime-v2/baseline-shared-basis.mjs';
import { ensureTask, withTaskState, taskDirectory } from '../lib/runtime-v2/task-store.mjs';
import { compileRuntimeV2Config } from '../lib/runtime-v2/config.mjs';
import { materialManifest } from '../lib/runtime-v2/onboarding.mjs';
import { atomicWriteJson, readJson, sha256 } from '../lib/runtime-v2/utils.mjs';

async function workspace(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-shared-basis-')));
  t.after(() => fs.rm(root, { recursive: true, force: true })); return root;
}

// Exercise the actual bounded worker/tools/acknowledgement journal. No model,
// provider, host process, checkpoint fabrication or completion shortcut.
async function finishedWorker(t, { receipt = 'genuine', partial = false } = {}) {
  const directory = await workspace(t), root = path.join(directory, 'frozen-source');
  await fs.mkdir(root);
  const bytes = Buffer.from('Preserve the requested feature.\nVerify before completion.');
  const file = 'source-0000-0000.txt', requiredFiles = ['request-0000.txt', 'baseline-0000.txt', file];
  await Promise.all([fs.writeFile(path.join(root, requiredFiles[0]), '{}'),
    fs.writeFile(path.join(root, requiredFiles[1]), '{}'), fs.writeFile(path.join(root, file), bytes)]);
  const identity = { requestId: 'bounded-request', taskId: 'real-task', protocol: BASELINE_EXTRACTION_PROTOCOL,
    baselineVersion: 0, baselineDigest: 'empty', sourceCatalog: [{ ref: 'transcript:U1', kind: 'USER_MESSAGE' }],
    sources: [{ ref: 'transcript:U1', kind: 'USER_MESSAGE', bytes: bytes.length, sha256: sha256(bytes),
      parts: [{ file, startByte: 0, endByte: bytes.length, sha256: sha256(bytes) }] }] };
  let count = 0;
  const worker = await createBaselineWorker({ root, outputDir: directory, identity, requiredFiles,
    schema: GROUND_TRUTH_REVIEW_SCHEMA, active() {}, assertCurrent: async () => {}, bindOperations: async ops => ops,
    initialWireMode: 'full', deadlineAt: Date.now() + 20000, maxRepairs: 0,
    nativeRun: async run => {
      const call = async (name, args) => {
        const id = `real-call-${++count}`; run.onAssistantMessageStart();
        const result = await run.tools.find(tool => tool.name === name).execute(id, args);
        if (name === 'source_read' && receipt !== 'missing') run.observeReceipt({ toolName: name,
          toolCallId: receipt === 'wrong-call' ? `${id}-foreign` : id, isSynthetic: receipt === 'synthetic',
          message: { role: 'toolResult', toolName: name, toolCallId: id, isError: false, content: result.content, details: result.details } });
        return result;
      };
      for (const name of requiredFiles) {
        let offset = 1;
        do { const result = await call('source_read', { path: name, offset, ...(partial && name === file ? { limit: 1 } : {}) });
          offset = partial && name === file ? null : result.details.page.nextOffset;
        } while (offset);
      }
      await call('finish_baseline', { batchIds: [], taskClassification: 'NO_CHANGE', summary: 'All original obligations retained.' });
    } });
  if (receipt !== 'genuine' || partial) {
    await assert.rejects(worker.execute(), { code: 'BASELINE_REPAIR_LIMIT' });
    assert.equal(worker.result, null);
    const checkpoint = await readJson(path.join(directory, 'review-checkpoint.json'));
    assert(checkpoint.taskState.pending.length > 0); assert.notEqual(checkpoint.taskState.phase, 'CANDIDATE_COMPLETE');
    assert.match(await fs.readFile(checkpoint.sessionFile, 'utf8'), /BASELINE_INCOMPLETE/u);
    await worker.close(); return;
  }
  await worker.execute();
  await worker.close();
  return { directory, identity, requiredFiles, result: worker.result };
}

test('bounded acknowledgement/finish alone cannot certify semantic completeness', async t => {
  const f = await finishedWorker(t), proof = await acknowledgedSharedProof(f);
  const basis = { taskId: f.identity.taskId, rootSessionId: 'root', digest: 'basis', adoptedSkills: [],
    sources: f.identity.sources.map(({ ref, kind, sha256 }) => ({ ref, kind, sha256 })) };
  const truth = { taskId: f.identity.taskId, version: 1, digest: 'formal-truth' };
  const record = proof.bind(basis, f.result, truth);
  assert.equal(record, null, 'actual read receipts cannot self-sign semantic completeness');
  assert.equal(proof.requiresSemanticAudit, true);
  const snapshot = proof.auditSnapshot();
  assert.equal(snapshot.checkpoint.taskState.phase, 'CANDIDATE_COMPLETE');
  assert.equal(snapshot.requiredFiles.length, f.requiredFiles.length);
  assert.throws(() => proof.attachAudit({ complete: true }), { code: 'BASELINE_SHARED_BASIS_UNVERIFIED' });
  assert.equal(proof.bind(basis, { ...f.result, summary: 'Suppressed candidate.' }, truth), null);
  assert.equal(proof.bind({ ...basis, sources: [] }, f.result, truth), null);
  assert.equal(proof.bind({ ...basis, taskId: 'foreign' }, f.result, truth), null);
  assert.equal(proof.bind(basis, f.result, { ...truth, taskId: 'foreign' }), null);
  const task = { taskId: basis.taskId, rootSessionId: 'root', groundTruth: {}, control: {} };
  assert.equal(await sharedBasisMatches(record, basis, truth, task), false);
  assert.equal(await sharedBasisMatches(record, basis, { ...truth, version: 2 }, task), false);
  assert.equal(await sharedBasisMatches(record, basis, { ...truth, taskId: 'foreign' }, task), false);
  assert.equal(await sharedBasisMatches(record, { ...basis, digest: 'changed-policy-or-original' }, truth, task), false);
  assert.equal(await sharedBasisMatches(record, basis, truth, { ...task, groundTruth: { pendingUserCursor: 'U2' } }), false);
  assert.equal(await sharedBasisMatches({ ...record, sources: [] }, basis, truth, task), false);
  assert.equal(await sharedBasisMatches({ ...record, proof: { finishDigest: null } }, basis, truth, task), false);
});

test('portable real-worker proof rejects independent task, source, finish and receipt substitutions', async t => {
  const f = await finishedWorker(t), checkpointFile = path.join(f.directory, 'review-checkpoint.json');
  const checkpoint = await readJson(checkpointFile), finishFile = path.join(f.directory, 'candidates-0/finish.json');
  const finish = await readJson(finishFile), journalFile = checkpoint.sessionFile, journal = await fs.readFile(journalFile, 'utf8');
  const cases = {
    'ranges without acknowledged citations': cp => { cp.citations = []; cp.receiptEntries = []; },
    'foreign task state and identity': cp => { cp.taskState.taskId = 'foreign'; cp.taskState.identity.taskId = 'foreign'; },
    'foreign original source identity': cp => { cp.taskState.identity.sources[0].ref = 'transcript:other'; },
    'foreign baseline identity': cp => { cp.taskState.baselineDigest = 'foreign'; },
    'foreign finish generation': (_cp, done) => { done.receipt.generation++; },
    'foreign finish request': (_cp, done) => { done.receipt.requestId = 'foreign'; },
    'different candidate delta': (_cp, done) => { done.delta.summary = 'foreign'; },
    'different completion input': (_cp, done) => { done.hash = 'foreign'; },
    'missing receipt reference': cp => { cp.receiptEntries.pop(); },
    'wrong receipt call identity': cp => { cp.receiptEntries[0].toolCallId = 'foreign'; },
    'wrong receipt entry identity': cp => { cp.receiptEntries[0].entryId = 'foreign'; },
    'partial acknowledged original': cp => { const last = cp.citations.pop(); cp.receiptEntries = cp.receiptEntries.filter(r => r.citeId !== last.citeId); cp.reads = cp.reads.filter(r => r.path !== last.path); },
    'foreign session': cp => { cp.sessionId = 'foreign'; },
    'changed snapshot hash': cp => { cp.files[0][1].sha256 = 'foreign'; },
  };
  for (const [name, mutate] of Object.entries(cases)) await t.test(name, async () => {
    const cp = structuredClone(checkpoint), done = structuredClone(finish); mutate(cp, done);
    await fs.writeFile(checkpointFile, JSON.stringify(cp)); await atomicWriteJson(finishFile, done);
    try { await assert.rejects(acknowledgedSharedProof(f)); }
    finally { await fs.writeFile(checkpointFile, JSON.stringify(checkpoint)); await atomicWriteJson(finishFile, finish); }
  });
  for (const [name, mutate] of Object.entries({
    'unrecognized acknowledgement boundary': entry => { entry.message.details.receiptBoundary = 'synthetic'; },
    'acknowledged text changed': entry => { entry.message.content[0].text += ' changed'; },
    'failed original read': entry => { entry.message.isError = true; },
  })) await t.test(name, async () => {
    const entries = journal.trim().split('\n').map(JSON.parse), entry = entries.find(e => e.message?.role === 'toolResult'); mutate(entry);
    await fs.writeFile(journalFile, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
    try { await assert.rejects(acknowledgedSharedProof(f)); } finally { await fs.writeFile(journalFile, journal); }
  });
  await acknowledgedSharedProof(f);
});

test('missing, synthetic, wrong-call and partial actual read receipts cannot finish a baseline', async t => {
  for (const receipt of ['missing', 'synthetic', 'wrong-call']) await t.test(receipt, async t => { await finishedWorker(t, { receipt }); });
  await t.test('partial', async t => { await finishedWorker(t, { partial: true }); });
});

test('all adopted authority remains in the basis, including legacy PASS watchers and graph-only adoption', async t => {
  const projectRoot = await workspace(t), skillRoot = path.join(projectRoot, 'skills'), skillFile = path.join(skillRoot, 'demo/SKILL.md');
  await fs.mkdir(path.dirname(skillFile), { recursive: true }); await fs.writeFile(skillFile, 'Verify before completion.');
  const material = path.join(projectRoot, 'requirements.md'); await fs.writeFile(material, 'Original material.');
  const task = await ensureTask({ projectRoot, sessionId: 'authority-test' });
  const runtimeV2 = compileRuntimeV2Config({ version: 2, dynamicGroundTruth: { enabled: true, materialRoots: [material] },
    skillCorrection: { enabled: true, skillRoots: [skillRoot] } }, { policyRoot: path.join(projectRoot, '.runtime-corrector') });
  const snapshot = { entries: [{ type: 'user', uuid: 'U1', message: { content: 'Preserve the feature.' } }] };
  const options = async state => ({ projectRoot, task: state, runtimeV2, snapshot, materials: await materialManifest([material]) });
  const plain = await sharedOriginalBasis(await options(task));
  const legacy = { ...task, watchers: { real: { skillId: 'demo', status: 'PASS' } } };
  const adopted = await sharedOriginalBasis(await options(legacy));
  assert.notEqual(adopted.digest, plain.digest); assert.deepEqual(adopted.adoptedSkills.map(s => s.skillId), ['demo']);
  const carried = { ...task, groundTruth: { ...task.groundTruth, sharedBasis: { sources: adopted.sources, adoptedSkills: adopted.adoptedSkills } } };
  assert.equal((await sharedOriginalBasis(await options(carried))).digest, adopted.digest);
  await fs.writeFile(skillFile, 'Verify before completion, including errors.');
  assert.notEqual((await sharedOriginalBasis(await options(carried))).digest, adopted.digest);
  await fs.rm(skillFile); await assert.rejects(sharedOriginalBasis(await options(carried)));
  await fs.rm(path.dirname(skillFile), { recursive: true });
  await assert.rejects(sharedOriginalBasis(await options(legacy)), { code: 'BASELINE_SHARED_BASIS_UNVERIFIED' });
  const graphFile = path.join(taskDirectory(projectRoot, task.taskId), 'skills/demo/skill-ground-truth.json');
  await fs.mkdir(path.dirname(graphFile), { recursive: true });
  await atomicWriteJson(graphFile, { taskId: task.taskId, skillId: 'demo', sourceRef: '/untrusted/model/path' });
  await assert.rejects(sharedOriginalBasis(await options(task)), { code: 'BASELINE_SHARED_BASIS_UNVERIFIED' });
  await fs.mkdir(path.dirname(skillFile), { recursive: true }); await fs.writeFile(skillFile, 'Verify before completion.');
  assert.deepEqual((await sharedOriginalBasis(await options(task))).adoptedSkills.map(s => s.skillId), ['demo']);
});

test('real user identity, original bytes and PROJECT_FILE discovery invalidate independently of output activity', async t => {
  const projectRoot = await workspace(t), task = await ensureTask({ projectRoot, sessionId: 'basis-test' });
  const runtimeV2 = compileRuntimeV2Config({ version: 2 }, { policyRoot: path.join(projectRoot, '.runtime-corrector') });
  const user = { type: 'user', uuid: 'U1', message: { content: 'Preserve the feature.' } };
  const options = { projectRoot, task, runtimeV2, snapshot: { entries: [user] }, materials: { entries: [] } };
  const original = await sharedOriginalBasis(options);
  await fs.writeFile(path.join(projectRoot, 'app.mjs'), 'export const result = 1;');
  assert.equal((await sharedOriginalBasis({ ...options, snapshot: { entries: [user,
    { type: 'assistant', message: { content: 'Done.' } }, { type: 'user', isMeta: true, message: { content: 'Internal.' } }] } })).digest, original.digest);
  assert.notEqual((await sharedOriginalBasis({ ...options, snapshot: { entries: [{ ...user, uuid: 'U2' }] } })).digest, original.digest);
  assert.notEqual((await sharedOriginalBasis({ ...options, snapshot: { entries: [{ ...user, message: { content: 'Changed real user text.' } }] } })).digest, original.digest);
  await assert.rejects(sharedOriginalBasis({ ...options, snapshot: { entries: [user, { ...user, message: { content: 'Different bytes under the same identity.' } }] } }), { code: 'BASELINE_SHARED_BASIS_UNVERIFIED' });
  assert.notEqual((await sharedOriginalBasis({ ...options, pluginRoot: projectRoot })).digest, original.digest);
  const instructions = path.join(projectRoot, 'AGENTS.md'); await fs.writeFile(instructions, 'Original project requirement.');
  const withInstructions = await sharedOriginalBasis(options); assert.notEqual(withInstructions.digest, original.digest);
  await fs.writeFile(instructions, 'Changed project requirement.'); assert.notEqual((await sharedOriginalBasis(options)).digest, withInstructions.digest);
  await withTaskState({ projectRoot, taskId: task.taskId }, state => { state.groundTruth.sharedBasis = { sources: withInstructions.sources }; });
  await fs.rm(instructions);
  await assert.rejects(sharedOriginalBasis({ ...options, task: await readJson(path.join(taskDirectory(projectRoot, task.taskId), 'task.json')) }), { code: 'BASELINE_SHARED_BASIS_UNVERIFIED' });
});
