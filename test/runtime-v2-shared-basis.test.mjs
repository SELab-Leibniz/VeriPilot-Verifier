import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createOpenClawReviewerFactory } from '../lib/openclaw/reviewer.mjs';
import { skillGraphQuoteCandidate as skillGraphCandidate, interpretSkillUnit } from './helpers/skill-source-interpretation.mjs';
import { applyGroundTruthDelta, freezeGroundTruth } from '../lib/runtime-v2/ground-truth-ledger.mjs';
import { ensureTask, taskDirectory, withTaskState, withTaskDecision, decisionGuard, appendTaskJournal } from '../lib/runtime-v2/task-store.mjs';
import { outsideDecision, decisionScope } from '../lib/runtime-v2/decision-scope.mjs';
import { readJson, sha256 } from '../lib/runtime-v2/utils.mjs';
import { runSemanticReview } from '../lib/semantic-review.mjs';
import { invalidateCurrentStopVerification } from '../lib/runtime-v2/production-stop.mjs';
import { scanSkillDirectory } from '../lib/runtime-v2/skill-source.mjs';
import { sharedBasisFixture as fixture, user, operation } from './helpers/runtime-v2-shared-basis-fixture.mjs';

async function mixedRetainedOriginal(f) {
  const original = 'Create app.mjs and a short usage guide. Follow the selected demo Skill.';
  await fs.writeFile(f.transcript, JSON.stringify({ ...user(), message: { role: 'user', content: original } }) + '\n');
  const common = operation();
  f.state.deltaOperations = [{ ...common, text: 'Create app.mjs.', expectedFiles: ['app.mjs'] },
    { ...common, text: 'Write a short usage guide.', verificationTarget: 'ARTIFACT', implementationRole: undefined },
    { ...common, text: 'Follow the selected demo Skill.', verificationTarget: 'PROCESS', implementationRole: undefined }];
  // Actual wire JSON omits undefined optional role fields; clone the scripted
  // arguments similarly, rather than supplying forbidden roles on other owners.
  f.state.deltaOperations = JSON.parse(JSON.stringify(f.state.deltaOperations));
}

// Decoded closed live006 response17/18. The first replay preserves the
// original source selectors, metadata, obligations AND NEW_TASK classification.
const closedMixedSave = { batchId: 1, defaults: { authority: 'MATERIAL_DERIVED', category: 'requirements', severity: 'HARD' },
  exclude: [{ reason: 'Unadopted MATERIAL heading-only context with no imperative content.', units: ['S1L1'] }],
  operations: [
    { expectedFiles: ['app.mjs'], implementationRole: 'PRODUCTION', sourceFrom: { unitId: 'S1L3' }, text: 'Create app.mjs (delivery-verifier Skill requirement).', verificationTarget: 'IMPLEMENTATION', applicabilityKind: 'CURRENT_TASK' },
    { applicability: 'If a later correction changes app.mjs', sourceFrom: { unitId: 'S1L3' }, text: 'If a later correction changes app.mjs, run verification again before completion.', verificationTarget: 'PROCESS', applicabilityKind: 'CONDITIONAL' },
  ] };
const closedMixedFinish = { batchIds: [1], summary: 'New delivery-verifier SKILL.md material: adopted "Create app.mjs" as IMPLEMENTATION/PRODUCTION requirement (expectedFiles app.mjs) and the conditional re-verification duty ("If a later correction changes app.mjs, run verification again before completion", PROCESS, CONDITIONAL). Permissive "You may inspect examples if useful" recorded as non-obligatory. S1L1 heading excluded as unadopted context. S0L1 preserved by program.', taskClassification: 'NEW_TASK' };

async function closedMixedFixture(t, materialAlongside = false) {
  const f = await fixture(t, { wireMode: 'draft', closedMixed: true, materialAlongside });
  const original = 'Create app.mjs and a short usage guide for a stateless numeric validation module. Follow the selected delivery-verifier Skill in this workspace.';
  await fs.writeFile(f.transcript, JSON.stringify({ ...user(), message: { role: 'user', content: original } }) + '\n');
  f.state.sourceFrom = true; f.state.draftActual = true;
  f.state.deltaOperations = [
    { ...operation(), text: 'Create app.mjs implementing a stateless numeric validation module.', expectedFiles: ['app.mjs'] },
    { ...operation(), text: 'Write a short usage guide for the stateless numeric validation module.', verificationTarget: 'ARTIFACT' },
    { ...operation(), text: 'Follow the selected delivery-verifier Skill in this workspace.', verificationTarget: 'PROCESS' },
  ].map(op => { if (op.verificationTarget !== 'IMPLEMENTATION') delete op.implementationRole; return op; });
  const initial = await ensureTask({ projectRoot: f.root, sessionId: 'basis-session' });
  await withTaskState({ projectRoot: f.root, taskId: initial.taskId }, state => { state.control ??= {}; });
  await f.refresh();
  assert.equal((await f.truth()).version, 1);
  assert.equal((await f.truth()).claims.length, 3);
  assert((await f.task()).groundTruth.sharedBasis.acceptedSourceCertificate);
  return f;
}

async function publicationDiagnostic(t, f) {
  const task = await f.task(), truth = await f.truth(), td = taskDirectory(f.root, task.taskId);
  const receipts = await Promise.all((await fs.readdir(path.join(td, 'ground-truth/baseline-applied')))
    .map(name => readJson(path.join(td, 'ground-truth/baseline-applied', name))));
  t.diagnostic(JSON.stringify({ formalVersion: truth.version, formalMaterial: truth.claims.filter(c => c.source.kind === 'MATERIAL').length,
    receipts, sourceCursors: task.groundTruth.sourceCursors, sharedBasisSources: task.groundTruth.sharedBasis.sources,
    journal: await fs.readFile(path.join(td, 'journal/events.jsonl'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; }) }));
}

test('closed live006 Mixed NEW_TASK repairs its field before formal publication without consuming an empty delta', async t => {
  const f = await closedMixedFixture(t), original = await f.truth();
  let rejected = false;
  f.state.replayBaseline = async ({ call, readAll, params, sourceRoot, requestDirectory, requestIdentity }) => {
    assert.notEqual(sourceRoot, params.cwd, 'The reused native cwd must remain anchored to the first task');
    const promptIdentity = JSON.parse(params.prompt).identity;
    assert.equal(requestIdentity.requestId, promptIdentity.requestId);
    assert.equal((await readJson(path.join(requestDirectory, 'request.json'))).identity.requestId, promptIdentity.requestId);
    await readAll(); await call('save_baseline_batch', structuredClone(closedMixedSave));
    const state = async () => JSON.parse((await call('review_history', { mode: 'state' })).content[0].text).taskState;
    const before = await state(), candidateDirectory = path.join(path.dirname(sourceRoot), `candidates-${before.generation}`),
      candidate = path.join(candidateDirectory, 'batch-1.json'), bytes = await fs.readFile(candidate);
    try { await call('finish_baseline', structuredClone(closedMixedFinish)); }
    catch (error) {
      assert.equal(error.code, 'BASELINE_CLASSIFICATION_INVALID'); rejected = true;
      assert.match(error.message, /taskClassification.*NEW_TASK.*new.*user/iu);
      await assert.rejects(fs.access(path.join(candidateDirectory, 'finish.json')), { code: 'ENOENT' });
      const after = await state();
      for (const key of ['generation', 'deadlineAt', 'maxRepairs', 'nextBatchId', 'batches']) assert.deepEqual(after[key], before[key]);
      assert.equal(after.repairs, before.repairs + 1); assert.equal(after.metrics.readBytes, before.metrics.readBytes);
      assert.deepEqual(await fs.readFile(candidate), bytes);
      await call('finish_baseline', { ...closedMixedFinish, taskClassification: 'CONTINUATION' });
    }
  };
  await f.select();
  const current = await f.truth();
  if (!rejected) await publicationDiagnostic(t, f);
  assert.equal(current.claims.filter(c => c.source.kind === 'MATERIAL').length, 2, 'actual original candidate must reach formal admission, never be silently filtered into a successful empty application');
  assert(rejected, 'classification error must be returned before durable completion');
  assert.deepEqual(current.claims.filter(c => c.source.kind === 'USER_MESSAGE'), original.claims);
  assert.equal(current.version, original.version + 1);
  assert.equal((await f.task()).groundTruth.sharedBasis.baselineDigest, current.digest);
  assert.equal((await readJson((await f.task()).groundTruth.sharedBasis.acceptedSourceCertificate.path)).baselineVersion, current.version);
});

test('legitimate new USER plus MATERIAL NEW_TASK publishes both sources and their matching formal certificate', async t => {
  const f = await closedMixedFixture(t, true), original = await f.truth();
  await fs.writeFile(f.material, await fs.readFile(f.skillFile));
  await fs.appendFile(f.transcript, JSON.stringify({ ...user('U2'), message: { role: 'user', content: 'Also expose a status endpoint.' } }) + '\n');
  f.state.replayBaseline = async ({ call, readAll, request }) => {
    await readAll();
    const skillIndex = request.sourceCatalog.findIndex(s => s.ref === f.material), userIndex = request.sourceCatalog.findIndex(s => s.ref === 'transcript:U2');
    const material = closedMixedSave.operations.map(op => ({ ...structuredClone(op), sourceFrom: { unitId: `S${skillIndex}L3` } }));
    await call('save_baseline_batch', { batchId: 1, exclude: [{ units: [`S${skillIndex}L1`], reason: closedMixedSave.exclude[0].reason }],
      operations: [{ ...operation('transcript:U2'), authority: 'USER_EXPLICIT', text: 'Expose a status endpoint.', source: undefined,
        sourceFrom: { unitId: `S${userIndex}L1` } }, ...material.map(op => ({ ...op, authority: 'MATERIAL_DERIVED', category: 'requirements', severity: 'HARD' }))]
        .map(({ source, ...op }) => op) });
    await call('finish_baseline', { batchIds: [1], taskClassification: 'NEW_TASK', summary: 'New real USER obligation and supported current/conditional Skill materials together.' });
  };
  try { await f.refresh(); } catch (error) { await publicationDiagnostic(t, f); throw error; }
  await publicationDiagnostic(t, f);
  const current = await f.truth();
  assert.equal(current.claims.filter(c => c.source.kind === 'MATERIAL').length, 2, 'NEW_TASK must not remove legal material alongside a real new USER');
  assert(current.claims.some(c => c.text === 'Expose a status endpoint.'));
  assert(original.claims.every(old => current.claims.some(c => sha256(c) === sha256(old))));
  const record = (await f.task()).groundTruth.sharedBasis;
  assert.equal(record.baselineDigest, current.digest);
  assert.equal((await readJson(record.acceptedSourceCertificate.path)).baselineVersion, current.version);
});

function originalMaterialOperations(f) {
  return closedMixedSave.operations.map(({ sourceFrom, ...op }) => ({ ...op, operation: 'ADD', category: 'requirements',
    authority: 'MATERIAL_DERIVED', severity: 'HARD', source: { ref: `${f.material}#L3-L3`, kind: 'MATERIAL', subject: 'MAIN_TASK' } }));
}

test('legacy classifier feedback repairs the unchanged material delta before any empty publication', async t => {
  const f = await closedMixedFixture(t, true), before = await f.truth();
  await fs.writeFile(f.material, await fs.readFile(f.skillFile));
  const delta = { ...closedMixedFinish, operations: originalMaterialOperations(f) }; delete delta.batchIds;
  const original = structuredClone(delta); let repairs = 0;
  f.state.overrideBaseline = async (_options, requestDirectory) => ({ result: delta, requestDirectory, async close() {},
    async followUp() {
      repairs++;
      const request = await readJson(path.join(requestDirectory, 'ground-truth-repair-request.json'));
      assert.deepEqual(request.rejectedDelta, original); assert.equal((await f.truth()).digest, before.digest);
      assert.match(request.validationError, /NEW_TASK.*new.*user/iu);
      return { ...delta, taskClassification: 'CONTINUATION' };
    } });
  await f.refresh(); assert.equal(repairs, 1); assert.deepEqual(delta, original);
  assert.equal((await f.truth()).claims.filter(c => c.source.kind === 'MATERIAL').length, 2);
  assert.equal((await f.truth()).version, before.version + 1);
});

test('domain repaired legitimate NEW_TASK keeps both new USER and material authority', async t => {
  const f = await closedMixedFixture(t, true);
  await fs.writeFile(f.material, await fs.readFile(f.skillFile));
  await fs.appendFile(f.transcript, JSON.stringify({ ...user('U2'), message: { role: 'user', content: 'Also expose a status endpoint.' } }) + '\n');
  let repairs = 0;
  f.state.overrideBaseline = async (_options, requestDirectory) => ({ requestDirectory, async close() {},
    result: { summary: 'An invalid reference must be repaired.', taskClassification: 'CONTINUATION',
      operations: [{ ...originalMaterialOperations(f)[0], operation: 'SUPERSEDE', claimId: 'unknown-claim' }] },
    async followUp() { repairs++; return { summary: 'Authorized new request plus its materials.', taskClassification: 'NEW_TASK',
      operations: [{ ...operation('transcript:U2'), text: 'Expose a status endpoint.' }, ...originalMaterialOperations(f)] }; } });
  await f.refresh(); assert.equal(repairs, 1);
  assert.equal((await f.truth()).claims.filter(c => c.source.kind === 'MATERIAL').length, 2);
  assert((await f.truth()).claims.some(c => c.text === 'Expose a status endpoint.'));
});

for (const invalid of ['old-user', 'frozen-material', 'unknown-source', 'internal-source']) {
  test(`source admission rejects ${invalid} consistently on first and domain-repaired answers without consuming input`, async t => {
    for (const repaired of [false, true]) await t.test(repaired ? 'repaired answer' : 'first answer', async t => {
      const f = await closedMixedFixture(t, true);
      if (invalid === 'frozen-material') await freezeGroundTruth({ projectRoot: f.root, taskId: (await f.task()).taskId });
      const before = await f.truth(), record = structuredClone((await f.task()).groundTruth);
      const receiptDir = path.join(taskDirectory(f.root, (await f.task()).taskId), 'ground-truth/baseline-applied');
      const receiptFiles = await fs.readdir(receiptDir);
      await fs.writeFile(f.material, await fs.readFile(f.skillFile));
      let op = originalMaterialOperations(f)[0], classification = 'CONTINUATION';
      if (invalid === 'old-user') { op = { ...operation(), text: 'Invented scope from an already consumed user source.' }; classification = 'NEW_TASK'; }
      if (invalid === 'unknown-source') op.source.ref = path.join(f.root, 'unlisted.md');
      if (invalid === 'internal-source') op.source.ref = path.join(f.root, '.runtime-correction/internal-role.md');
      const bad = { summary: 'Actual source admission negative.', taskClassification: classification, operations: [op] }; let repairs = 0;
      f.state.overrideBaseline = async (_options, requestDirectory) => ({ requestDirectory, async close() {}, result: repaired
        ? { summary: 'Trigger existing domain repair.', taskClassification: 'CONTINUATION', operations: [{ ...originalMaterialOperations(f)[0], operation: 'SUPERSEDE', claimId: 'unknown-claim' }] }
        : bad, async followUp() { repairs++; return bad; } });
      await assert.rejects(f.refresh(), /baseline extraction failed/);
      assert.equal(repairs, 1, 'the existing single domain follow-up is bounded, never an added retry loop');
      assert.deepEqual(await f.truth(), before);
      const after = (await f.task()).groundTruth;
      assert.deepEqual(after.sourceCursors, record.sourceCursors); assert.deepEqual(after.sharedBasis, record.sharedBasis);
      assert.deepEqual(await fs.readdir(receiptDir), receiptFiles);
    });
  });
}

test('frozen exact new USER remains legal while old accepted claims and material authority stay frozen', async t => {
  const f = await closedMixedFixture(t, true), taskId = (await f.task()).taskId;
  await freezeGroundTruth({ projectRoot: f.root, taskId });
  const before = await f.truth();
  await fs.appendFile(f.transcript, JSON.stringify({ ...user('U2'), message: { role: 'user', content: 'Also expose a status endpoint.' } }) + '\n');
  f.state.overrideBaseline = async (_options, requestDirectory) => ({ requestDirectory, async close() {},
    result: { summary: 'Only new real USER scope changes frozen truth.', taskClassification: 'NEW_TASK', operations: [{ ...operation('transcript:U2'), text: 'Expose a status endpoint.' }] } });
  await f.refresh(); const current = await f.truth();
  assert.equal(current.version, before.version + 1); assert.equal(current.frozenAtVersion, before.frozenAtVersion);
  assert(before.claims.every(c => current.claims.some(row => sha256(row) === sha256(c))));
  assert.equal(current.claims.filter(c => c.source.kind === 'MATERIAL').length, 0);
});

test('new formal source certificate survives rolling close and retains the whole original without covering new Skill material', async t => {
  const f = await fixture(t, { wireMode: 'draft' }); f.state.sourceFrom = true; f.state.draftActual = true;
  await mixedRetainedOriginal(f);
  const initial = await ensureTask({ projectRoot: f.root, sessionId: 'basis-session' });
  await withTaskState({ projectRoot: f.root, taskId: initial.taskId }, state => { state.control ??= {}; });
  await f.refresh();
  const before = await f.truth(), task = await f.task(), pointer = task.groundTruth.sharedBasis.acceptedSourceCertificate;
  assert(pointer, 'Only an acknowledged complete original, independently audited effective ledger and actual commit may issue this certificate');
  const certificate = await readJson(pointer.path), immutableBytes = await fs.readFile(certificate.origin.snapshot.path);
  assert.equal(certificate.schemaVersion, 'runtime-corrector.accepted-user-sources.v2');
  assert.equal(certificate.groups.length, 1); assert.equal(certificate.groups[0].ref, 'transcript:U1');
  assert.equal(certificate.groups[0].scope, 'FULL_ORIGINAL');
  const audit = await readJson(certificate.coverageAudit.pointer.path);
  const original = audit.report.sources.find(source => source.ref === 'transcript:U1' && source.kind === 'USER_MESSAGE');
  assert.equal(Object.hasOwn(original, 'sha256'), false, 'The semantic report never supplies or receives a patched source hash');
  const frozenSource = audit.input.identity.sources.find(source => source.ref === original.ref && source.kind === original.kind);
  assert.match(frozenSource.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(certificate.groups[0].sha256, frozenSource.sha256, 'The certificate retains the full verified private source hash');
  assert.deepEqual(new Set(original.mappings.flatMap(mapping => mapping.claimIds)), new Set(before.claims.map(claim => claim.claimId)));
  assert.deepEqual(new Set(before.claims.map(claim => claim.verificationTarget)), new Set(['IMPLEMENTATION', 'ARTIFACT', 'PROCESS']));
  assert.deepEqual(certificate.groups[0].claims, before.claims);
  const rolling = path.join(path.dirname(path.dirname(certificate.origin.snapshot.path)), 'review-checkpoint.json');
  assert.equal((await readJson(rolling)).reason, 'task_closed');
  await f.select();
  const after = await f.truth();
  assert.deepEqual(after.claims.filter(claim => before.claims.some(old => old.claimId === claim.claimId)), before.claims, 'No old obligation, owner or revision is regenerated');
  const added = after.claims.filter(claim => !before.claims.some(old => old.claimId === claim.claimId));
  assert.equal(added.length, 1); assert.equal(added[0].verificationTarget, 'PROCESS'); assert.equal(added[0].source.kind, 'MATERIAL');
  assert.match(added[0].source.ref, /SKILL\.md#L2-L2$/); assert.equal(after.version, before.version + 1);
  const prompt = f.state.baselinePrompts.at(-1);
  assert.equal(prompt.wireMode, 'draft');
  assert.deepEqual(prompt.preservedSourceUnits.flatMap(row => row.units), ['S0L1']);
  assert.equal(prompt.preservedSourceUnits[0].claims[0].claimId, before.claims[0].claimId);
  assert(prompt.requiredFiles.some(file => file.startsWith('source-0002')), 'New adopted Skill is still actually read');
  assert.equal(f.graphs().length, 1, 'New Skill is independently interpreted, not covered by old USER_MESSAGE proof');
  assert.deepEqual(await fs.readFile(certificate.origin.snapshot.path), immutableBytes);
});

