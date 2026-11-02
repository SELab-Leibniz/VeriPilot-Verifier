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

for (const invalid of ['missing-mapping', 'snapshot-tamper', 'snapshot-rehashed', 'claim-revision', 'policy', 'partial-group',
  'receipt-path', 'origin-path', 'receipt-identity', 'origin-identity', 'receipt-targets', 'receipt-disposition', 'source-bytes', 'owner']) test(`source retention conservatively misses ${invalid}`, async t => {
  const f = await fixture(t, { wireMode: invalid === 'missing-mapping' ? 'full' : 'draft' }); f.state.sourceFrom = invalid !== 'missing-mapping';
  f.state.draftActual = invalid !== 'missing-mapping';
  if (invalid === 'partial-group') await mixedRetainedOriginal(f);
  const initial = await ensureTask({ projectRoot: f.root, sessionId: 'basis-session' });
  await withTaskState({ projectRoot: f.root, taskId: initial.taskId }, state => { state.control ??= {}; });
  await f.refresh();
  const task = await f.task(), pointer = task.groundTruth.sharedBasis.acceptedSourceCertificate;
  assert(pointer, 'The unmodified setup must first produce a genuine v2 independently audited source certificate');
  const replaceCertificate = async certificate => {
    await fs.writeFile(pointer.path, JSON.stringify(certificate));
    await withTaskState({ projectRoot: f.root, taskId: task.taskId }, state => {
      state.groundTruth.sharedBasis.acceptedSourceCertificate.digest = sha256(certificate);
      state.groundTruth.sharedBasis.acceptedSourceCertificate.bytesDigest = sha256(Buffer.from(JSON.stringify(certificate)));
    });
  };
  if (invalid === 'missing-mapping') {
    const certificate = await readJson(pointer.path), audit = await readJson(certificate.coverageAudit.pointer.path);
    assert.equal(f.state.baselinePrompts[0].wireMode, 'full');
    assert.equal(certificate.schemaVersion, 'runtime-corrector.accepted-user-sources.v2');
    assert.equal(certificate.groups[0].scope, 'FULL_ORIGINAL');
    assert(audit.report.sources.find(source => source.ref === 'transcript:U1').mappings.some(mapping => mapping.claimIds.length),
      'Full wire can certify through its real independent original-to-effective-claim mapping');
    // A legacy source/excerpt and current claim group cannot replace the missing independent mapping authority.
    delete certificate.coverageAudit;
    await replaceCertificate(certificate);
  }
  if (invalid === 'snapshot-tamper') {
    const certificate = await readJson(pointer.path), input = await readJson(certificate.origin.snapshot.path);
    input.checkpoint.savedAt = 'forged'; await fs.writeFile(certificate.origin.snapshot.path, JSON.stringify(input));
  }
  if (invalid === 'snapshot-rehashed') {
    const certificate = await readJson(pointer.path), ref = certificate.origin.snapshot, input = await readJson(ref.path);
    input.checkpoint.savedAt = 'forged';
    ref.digest = sha256(input); ref.bytesDigest = sha256(Buffer.from(JSON.stringify(input)));
    ref.path = path.join(path.dirname(ref.path), `${ref.digest}.json`);
    await fs.writeFile(ref.path, JSON.stringify(input)); await replaceCertificate(certificate);
  }
  if (invalid === 'claim-revision') {
    const truth = await f.truth(); truth.claims[0].revision++; truth.claims[0].revisionId += '-changed';
    await fs.writeFile(path.join(taskDirectory(f.root, task.taskId), 'ground-truth/current.json'), JSON.stringify(truth));
  }
  if (invalid === 'policy') {
    const certificate = await readJson(pointer.path); certificate.protocol.version = 'old-v6';
    await replaceCertificate(certificate);
  }
  if (invalid === 'partial-group') {
    const certificate = await readJson(pointer.path);
    certificate.groups[0].claims = certificate.groups[0].claims.slice(0, 1);
    await replaceCertificate(certificate);
  }
  if (invalid === 'receipt-path' || invalid === 'origin-path') {
    const certificate = await readJson(pointer.path);
    const ref = invalid === 'receipt-path' ? certificate.origin.receipt : certificate.origin.snapshot;
    const value = await readJson(ref.path);
    if (invalid === 'receipt-path') value.requestId = 'another-request'; else value.identity.taskId = 'another-task';
    ref.path = path.join(path.dirname(ref.path), `controlled-forged-${sha256(value)}.json`); ref.digest = sha256(value);
    ref.bytesDigest = sha256(Buffer.from(JSON.stringify(value)));
    await fs.writeFile(ref.path, JSON.stringify(value)); await replaceCertificate(certificate);
  }
  if (invalid === 'receipt-identity' || invalid === 'origin-identity' || invalid === 'receipt-targets' || invalid === 'receipt-disposition') {
    const certificate = await readJson(pointer.path);
    const ref = invalid === 'origin-identity' ? certificate.origin.snapshot : certificate.origin.receipt;
    const value = await readJson(ref.path);
    if (invalid === 'origin-identity') value.identity.taskId = 'another-task';
    else if (invalid === 'receipt-identity') value.requestId = 'another-request';
    else if (invalid === 'receipt-targets') {
      assert(value.result.accepted.length > 0);
      value.result.accepted[0].claim.verificationTarget = 'PROCESS';
    } else {
      assert(value.result.operationDispositions.length > 0);
      value.result.operationDispositions[0].effectiveTarget.digest = 'forged';
    }
    ref.digest = sha256(value); ref.bytesDigest = sha256(Buffer.from(JSON.stringify(value)));
    // Keep the actual owned receipt path; snapshots retain their canonical content-addressed name.
    if (invalid === 'origin-identity') ref.path = path.join(path.dirname(ref.path), `${ref.digest}.json`);
    await fs.writeFile(ref.path, JSON.stringify(value)); await replaceCertificate(certificate);
  }
  if (invalid === 'source-bytes') {
    const original = user(); original.message.content += ' Do not change other files.';
    await fs.writeFile(f.transcript, JSON.stringify(original) + '\n');
  }
  if (invalid === 'owner') {
    const certificate = await readJson(pointer.path); certificate.rootSessionId = 'foreign-owner'; await replaceCertificate(certificate);
  }
  if (invalid === 'source-bytes') await assert.rejects(f.select(), /exact current claimIds|BASELINE_SCOPE/u);
  else await f.select();
  assert.equal(f.state.baselinePrompts.at(-1).preservedSourceUnits, undefined);
});

test('retained old claims still require current acknowledged original reads before any new Skill alignment', async t => {
  const f = await fixture(t, { wireMode: 'draft' }); f.state.sourceFrom = true; f.state.draftActual = true;
  await mixedRetainedOriginal(f);
  const initial = await ensureTask({ projectRoot: f.root, sessionId: 'basis-session' });
  await withTaskState({ projectRoot: f.root, taskId: initial.taskId }, state => { state.control ??= {}; });
  await f.refresh(); const before = await f.truth(), pointer = (await f.task()).groundTruth.sharedBasis.acceptedSourceCertificate;
  const immutable = await readJson(pointer.path), bytes = await fs.readFile(immutable.origin.snapshot.path);
  f.state.skipCurrentUserRead = true;
  const result = await f.select();
  assert.equal(f.state.baselinePrompts.at(-1).preservedSourceUnits[0].claims.length, 3);
  assert.equal(result.reason, 'SKILL_WATCH_NOT_ESTABLISHED');
  assert.deepEqual((await f.truth()).claims, before.claims);
  assert.equal(f.graphs().length, 0, 'No local graph can hide the missing current USER_MESSAGE read');
  assert.deepEqual(await fs.readFile(immutable.origin.snapshot.path), bytes);
});

