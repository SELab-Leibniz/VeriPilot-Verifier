import test from 'node:test';
import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { sharedBasisFixture as createSharedBasisFixture, operation, user } from './helpers/runtime-v2-shared-basis-fixture.mjs';
import { scriptedCoverageReport, scriptedSourceInventory } from './helpers/baseline-coverage-native.mjs';
import { verifyBaselineCoverageProof, coverageIdentity, validateBaselineAuditReport, validateBaselineSourceInventory, baselineAuditSourceUnits, decodeBaselineAuditView, BASELINE_COVERAGE_INSTRUCTIONS, BASELINE_AUDIT_VIEW_PROTOCOL } from '../lib/runtime-v2/baseline-coverage-audit.mjs';
import { registerCitation } from '../lib/review-task/evidence-utils.mjs';
import { sourcePage } from '../lib/review-task/source-tools.mjs';
import { planGroundTruthDelta, groundTruthPlanDigest, applyGroundTruthDelta, freezeGroundTruth } from '../lib/runtime-v2/ground-truth-ledger.mjs';
import { ObservationJournal } from '../lib/review-task/observation-journal.mjs';
import { createBaselineWorker, BASELINE_EXTRACTION_PROTOCOL } from '../lib/review-task/baseline-task.mjs';
import { sourceUnits } from '../lib/review-task/baseline-selection.mjs';
import { withTaskState, ensureTask } from '../lib/runtime-v2/task-store.mjs';
import { sha256 } from '../lib/runtime-v2/utils.mjs';
import { refreshRuntimeRequirements } from '../lib/runtime-v2/orchestrator.mjs';
import { GROUND_TRUTH_REVIEW_SCHEMA } from '../lib/runtime-v2/reviewer.mjs';
import { STOP_TASK_LIMITS } from '../lib/review-task/stop-policy.mjs';
import { listNativeRuns } from '../lib/openclaw/native-runs.mjs';
import { coveredImplementationClaims } from '../lib/runtime-v2/baseline-coverage-audit.mjs';
import { TASK_SCOPE_INSTRUCTIONS } from '../lib/runtime-v2/ground-truth-provenance.mjs';

import { sharedBasisFixture, scratch, refreshCapturingAuditFailure, twoClaimFixture, missingReadReport, nativeAuditAttempt } from './helpers/baseline-coverage-fixture.mjs';

test('proof verification rejects rehashed report, source, candidate and ACK mutations without repairing raw evidence', async t => {
  const f = await twoClaimFixture(t, true); await f.refresh();
  const proof = (await f.task()).groundTruth.sharedBasis.coverageAudit;
  const original = JSON.parse(await fs.readFile(proof.pointer.path, 'utf8'));
  const cases = [
    ['missing tuple', bundle => bundle.report.sources.pop(), /omitted or duplicated/u],
    ['duplicate tuple', bundle => { bundle.report.sources[1] = structuredClone(bundle.report.sources[0]); }, /omitted or duplicated/u],
    ['foreign ref', bundle => { bundle.report.sources[0].ref = 'transcript:foreign'; }, /source denominator/u],
    ['foreign kind', bundle => { bundle.report.sources[0].kind = bundle.report.sources[0].kind === 'USER_MESSAGE' ? 'MATERIAL' : 'USER_MESSAGE'; }, /source denominator/u],
    ['wrong top identity', bundle => { bundle.report.identityDigest = 'foreign'; }, /Foreign or malformed semantic/u],
    ['legacy model hash', bundle => { bundle.report.sources[0].sha256 = bundle.input.identity.sources[0].sha256; }, /Foreign or malformed/u],
    ['grouped targets', bundle => {
      const row = bundle.report.sources.find(source => source.kind === 'USER_MESSAGE');
      row.mappings = [{ ...row.mappings[0], claimIds: row.mappings.flatMap(mapping => mapping.claimIds) }];
    }, /at most one effective claim/u],
    ['wrong owner', bundle => { bundle.report.sources.find(source => source.kind === 'USER_MESSAGE').mappings[0].owner = 'PROCESS'; }, /ownership does not match/u],
    ['wrong condition', bundle => { bundle.report.sources.find(source => source.kind === 'USER_MESSAGE').mappings[0].condition = 'invented trigger'; }, /condition mapping differs/u],
    ['private source hash', bundle => {
      bundle.input.identity.sources[0].sha256 = '0'.repeat(64);
      bundle.identity = coverageIdentity(bundle.input); bundle.report.identityDigest = sha256(bundle.identity);
    }, /[Uu]nit original source identity changed|Original source identity changed/u],
    ['candidate disclosure', bundle => { bundle.files.find(file => file.path === 'candidate-0.txt').text += ' '; }, /Effective candidate disclosure changed/u],
    ['program-only input bytes', bundle => { bundle.auxiliaryFiles[0].text += ' '; }, /Audit program-only input proof changed/u],
    ['program-only input with rewritten hashes', bundle => {
      const file = bundle.auxiliaryFiles[0]; file.text += ' '; file.sha256 = sha256(Buffer.from(file.text));
      bundle.input.fileHashes[file.path] = file.sha256;
      bundle.identity = coverageIdentity(bundle.input); bundle.report.identityDigest = sha256(bundle.identity);
    }, /Source inventory changed or belongs to another/u],
    ['candidate index gap', bundle => { bundle.files.find(file => file.path === 'candidate-0.txt').path = 'candidate-2.txt'; }, /Effective candidate fragment changed/u],
    ['extra empty candidate fragment', bundle => {
      const count = bundle.files.filter(file => file.path.startsWith('candidate-')).length;
      bundle.files.push({ path: `candidate-${count}.txt`, text: '', sha256: sha256(Buffer.alloc(0)), lines: 1 });
    }, /Effective candidate fragment changed/u],
    ['repacked candidate fragments', bundle => {
      const index = bundle.files.findIndex(file => file.path === 'candidate-0.txt'), old = bundle.files[index];
      // Concatenated bytes are unchanged: exact original per-fragment identity must still reject this.
      const pieces = [old.text.slice(0, 1), old.text.slice(1)].map((text, offset) => ({ ...old,
        path: `candidate-${offset}.txt`, text, sha256: sha256(Buffer.from(text)), lines: text.split('\n').length }));
      bundle.files.splice(index, 1, ...pieces);
    }, /Effective candidate fragment changed/u],
    ['missing candidate definition read', bundle => {
      const file = bundle.files.find(file => file.path === 'candidate-0.txt');
      bundle.reads = bundle.reads.filter(read => read.path !== file.path);
    }, /incomplete original\/candidate disclosure/u],
    ['missing candidate definition ACK', bundle => {
      const index = bundle.journalEntries.findIndex(entry => entry.message?.details?.citation?.path === 'candidate-0.txt');
      assert(index > 0); bundle.journalEntries.splice(index, 1);
    }, /not a genuine successful native disclosure/u],
    ['missing owned ACK', bundle => {
      const index = bundle.journalEntries.findIndex(entry => entry.message?.details?.citation);
      assert(index > 0); bundle.journalEntries.splice(index, 1);
    }, /not a genuine successful native disclosure/u],
    ['old protocol', bundle => { bundle.protocol = 'baseline-original-effective-coverage-v2-finish-retention'; }, /Stale or foreign/u],
  ];
  for (const [name, mutate, expected] of cases) {
    const bundle = structuredClone(original); mutate(bundle);
    if (['missing tuple', 'duplicate tuple', 'foreign ref', 'foreign kind', 'wrong top identity', 'legacy model hash', 'grouped targets', 'wrong owner', 'wrong condition'].includes(name))
      assert.throws(() => validateBaselineAuditReport(bundle.report, bundle.input, bundle.files, bundle.citations, bundle.inventory.record.inventory),
        error => error.code === 'BASELINE_COVERAGE_UNVERIFIED' && expected.test(error.message), `${name} reaches the report guard directly`);
    const bytes = Buffer.from(JSON.stringify(bundle)), file = path.join(path.dirname(proof.pointer.path), `${sha256(bundle)}.json`);
    await fs.writeFile(file, bytes, { flag: 'wx' });
    if (['candidate index gap', 'extra empty candidate fragment', 'repacked candidate fragments',
      'missing candidate definition read', 'missing candidate definition ACK'].includes(name))
      await assert.rejects(verifyBaselineCoverageProof({ path: file, digest: sha256(bundle), bytesDigest: sha256(bytes) }),
        error => error.code === 'BASELINE_COVERAGE_UNVERIFIED' && expected.test(error.message), `${name} reaches its specific disclosure guard`);
    await assert.rejects(verifyBaselineCoverageProof({ path: file, digest: sha256(bundle), bytesDigest: sha256(bytes) }),
      error => error.code === 'BASELINE_COVERAGE_UNVERIFIED', name);
  }
  const rawMismatch = structuredClone(original); rawMismatch.report.sources[0].reason += ' Changed return only.';
  const bytes = Buffer.from(JSON.stringify(rawMismatch)), file = path.join(path.dirname(proof.pointer.path), `${sha256(rawMismatch)}.json`);
  await fs.writeFile(file, bytes, { flag: 'wx' });
  await assert.rejects(verifyBaselineCoverageProof({ path: file, digest: sha256(rawMismatch), bytesDigest: sha256(bytes) }),
    error => error.code === 'BASELINE_COVERAGE_UNVERIFIED');
  assert.deepEqual(JSON.parse(await fs.readFile(proof.pointer.path, 'utf8')), original, 'Original evidence is never rewritten');
  await verifyBaselineCoverageProof(proof.pointer, { identity: proof.identity, truth: await f.truth() });
});

test('above6000-byte native text blocks match the exact one-block durable ACK without normalization', async t => {
  const f = await sharedBasisFixture(t);
  await fs.writeFile(f.transcript, JSON.stringify({ ...user(), message: { role: 'user',
    content: 'Preserve the requested feature. ' + 'x'.repeat(7000) } }) + '\n');
  await f.refresh();
  const proof = (await f.task()).groundTruth.sharedBasis.coverageAudit;
  const bundle = await verifyBaselineCoverageProof(proof.pointer, { truth: await f.truth() });
  const results = bundle.nativeTranscript.split('\n').filter(Boolean).map(JSON.parse)
    .filter(row => row.message?.role === 'toolResult' && row.message.toolName === 'source_read');
  const multi = results.filter(row => row.message.content.length > 1 && Buffer.byteLength(row.message.content.map(block => block.text).join('')) > 6000);
  assert(multi.length > 0, 'the production source tool must really emit multiple blocks');
  for (const row of multi) {
    assert(row.message.content.every(block => block.type === 'text' && typeof block.text === 'string'));
    const ack = bundle.journalEntries.find(entry => entry.message?.toolCallId === row.message.toolCallId)?.message;
    assert.equal(ack.content.length, 1);
    assert.equal(ack.content[0].text, row.message.content.map(block => block.text).join(''));
  }
  assert.equal((await f.truth()).version, 1);
});

for (const mixed of [false, true]) test(`an independently detected original omission repairs within one shared allowance (${mixed ? 'mixed verdict' : 'repair verdict'})`, async t => {
  const f = await sharedBasisFixture(t);
  await fs.writeFile(f.transcript, JSON.stringify({ ...user(), message: { role: 'user',
    content: 'Preserve the requested feature. Read and follow skills/demo/SKILL.md.' } }) + '\n');
  f.state.sourceFrom = true; f.state.deltaOperations = [operation()];
  f.state.coverageReport = context => {
    if (context.view.effectiveLedger.claims.some(claim => claim.text === 'Read and follow skills/demo/SKILL.md.')) return scriptedCoverageReport(context);
    const duty = { ...operation(), text: 'Read and follow skills/demo/SKILL.md.', verificationTarget: 'PROCESS' };
    delete duty.implementationRole;
    f.state.deltaOperations = [operation(), duty];
    const report = missingReadReport(context);
    if (mixed) {
      // The wire protocol permits omission when the sealed duty identifies one unit.
      delete report.sources.find(source => source.kind === 'USER_MESSAGE').issues[0].unitId;
      const row = report.sources.find(source => source.kind === 'MATERIAL');
      const [mapping] = row.mappings;
      report.verdict = 'UNRESOLVED';
      row.disposition = 'UNRESOLVED';
      row.mappings = [];
      row.issues = [{ ...mapping, issueKind: 'SOURCE_INVENTORY', owner: 'UNKNOWN',
        expectedDuty: 'Determine the role of this material.', reason: 'Controlled disputed inventory marker.' }];
    }
    return report;
  };
  await f.refresh();
  assert.equal((await f.truth()).claims.length, 2);
  assert.equal(f.audits().length, 2); assert.equal(f.globals().length, 1);
  assert.equal(f.state.baselinePrompts.length, 2);
  if (mixed) {
    const prompt = JSON.stringify(f.state.baselinePrompts[1]);
    assert.match(prompt, /The original read\/follow duty is absent/);
    assert.doesNotMatch(prompt, /Controlled disputed inventory marker/);
  }
  const proof = (await f.task()).groundTruth.sharedBasis.coverageAudit;
  const bundle = await verifyBaselineCoverageProof(proof.pointer, { truth: await f.truth() });
  assert.equal(bundle.budget.externalRepairs, 1); assert.equal(bundle.budget.repairs, 1);
  assert.equal(bundle.budget.auditCalls, 2);
  assert.equal(bundle.budget.maxTurns, STOP_TASK_LIMITS.maxTurns);
});

test('a repeated semantic omission leaves no staged truth, cursor or certificate', async t => {
  const f = await sharedBasisFixture(t);
  await fs.writeFile(f.transcript, JSON.stringify({ ...user(), message: { role: 'user',
    content: 'Preserve the requested feature. Read and follow skills/demo/SKILL.md.' } }) + '\n');
  f.state.coverageReport = missingReadReport;
  await assert.rejects(f.refresh());
  assert.equal(f.audits().length, 2);
  assert.equal(f.state.baselinePrompts.length, 2, 'do not dispatch another repair after the final audit');
  assert.equal((await f.truth()).version, 0);
  assert.equal((await f.task()).groundTruth.sharedBasis, undefined);
  assert.equal((await f.task()).groundTruth.sourceCursors['shared-original-basis'], undefined);
});

test('a settled truncated extractor resumes its acknowledged reads within the same generation', async t => {
  const f = await sharedBasisFixture(t);
  const calls = [];
  f.state.replayBaseline = async ({ call, readAll, params }) => {
    calls.push({ sessionId: params.sessionId, ...JSON.parse(params.prompt) });
    if (calls.length === 1) {
      await readAll();
      throw Object.assign(new Error('Controlled native output limit'), { code: 'REVIEWER_OUTPUT_LIMIT' });
    }
    const { source, ...claim } = operation();
    await call('save_baseline_batch', { batchId: 1, operations: [{ ...claim, sourceFrom: { unitId: 'S0L1' } }] });
    await call('finish_baseline', { batchIds: [1], taskClassification: 'CONTINUATION', summary: 'Finished the resumed candidate.' });
  };
  await f.refresh();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].sessionId, calls[0].sessionId);
  assert.equal(calls[1].generation, calls[0].generation);
  assert.match(calls[1].promptAppend, /output was truncated/);
  const proof = (await f.task()).groundTruth.sharedBasis.coverageAudit;
  const bundle = await verifyBaselineCoverageProof(proof.pointer, { truth: await f.truth() });
  assert.equal(bundle.budget.repairs, 1);
  assert.equal(bundle.budget.auditCalls, 1);
});

test('a frozen omission without new user authority does not dispatch an impossible candidate repair', async t => {
  const f = await sharedBasisFixture(t);
  await fs.writeFile(f.transcript, JSON.stringify({ ...user(), message: { role: 'user',
    content: 'Preserve the requested feature. Read and follow skills/demo/SKILL.md.' } }) + '\n');
  const { taskId } = await f.task();
  await applyGroundTruthDelta({ projectRoot: f.root, taskId, delta: { operations: [operation()] } });
  await freezeGroundTruth({ projectRoot: f.root, taskId });
  const before = await f.truth();
  f.state.coverageReport = missingReadReport;
  await assert.rejects(f.refresh(), error => error.code === 'BASELINE_FROZEN_AUTHORIZATION_REQUIRED');
  assert.equal(f.audits().length, 1);
  assert.equal(f.state.baselinePrompts.length, 1);
  assert.deepEqual(await f.truth(), before);
  assert.equal((await f.task()).groundTruth.sharedBasis, undefined);
});

test('NO_CHANGE with seen input and a missing certificate is independently audited again', async t => {
  const f = await sharedBasisFixture(t); await f.refresh();
  const before = await f.truth(), task = await f.task();
  await withTaskState({ projectRoot: f.root, taskId: task.taskId }, state => { delete state.groundTruth.sharedBasis.acceptedSourceCertificate; });
  await f.refresh();
  assert.equal(f.audits().length, 2);
  assert.deepEqual(f.state.auditInputs.at(-1).delta.operations, []);
  assert.equal((await f.truth()).digest, before.digest);
  assert((await f.task()).groundTruth.sharedBasis.acceptedSourceCertificate);
});

test('actual finish remains in program proof while complete KEEP_EXISTING semantics are disclosed and identity-bound', async t => {
  const f = await sharedBasisFixture(t); await f.refresh();
  await fs.appendFile(f.material, ' Additional controlled unadopted context.');
  await f.refresh();
  const input = f.state.auditInputs.at(-1);
  assert.equal(input.finish.receipt.status, 'NO_CHANGE');
  assert(input.retainedSourceUnits.length > 0, 'exercise actual retained groups, not an empty placeholder');
  assert(input.retainedSourceUnits.every(row => row.action === 'KEEP_EXISTING'));
  assert(input.retainedSourceUnits[0].claims.length > 0, 'retain a real ACTIVE target');
  const finish = JSON.parse(await fs.readFile(path.join(input.directory, `candidates-${input.generation}/finish.json`), 'utf8'));
  const checkpoint = JSON.parse(await fs.readFile(path.join(input.directory, 'review-checkpoint.json'), 'utf8'));
  assert.deepEqual(input.finish, finish);
  assert.deepEqual(input.retainedSourceUnits, checkpoint.taskState.retainedSourceUnits);
  const proof = (await f.task()).groundTruth.sharedBasis.coverageAudit;
  const bundle = await verifyBaselineCoverageProof(proof.pointer, { truth: await f.truth() });
  const view = decodeBaselineAuditView(JSON.parse(bundle.files.filter(file => /^candidate-\d+\.txt$/u.test(file.path))
    .sort((a, b) => Number(a.path.slice(10, -4)) - Number(b.path.slice(10, -4))).map(file => file.text).join('')));
  assert(!Object.hasOwn(view, 'finish'));
  assert.deepEqual(bundle.input.finish, input.finish);
  assert(bundle.auxiliaryFiles.some(file => /^baseline-/.test(file.path)));
  assert(!bundle.files.some(file => /^original-(?:baseline|request)-/.test(file.path)));
  assert.deepEqual(view.retainedSourceUnits, input.retainedSourceUnits);
  const originalIdentity = coverageIdentity(input);
  const changedFinish = structuredClone(input);
  changedFinish.finish.receipt.annotation = 'changed durable control metadata';
  assert.notEqual(coverageIdentity(changedFinish).candidateDigest, originalIdentity.candidateDigest);
  await assert.rejects(verifyBaselineCoverageProof(proof.pointer, { identity: coverageIdentity(changedFinish) }),
    error => error.code === 'BASELINE_COVERAGE_UNVERIFIED' && /Stale or foreign audit proof/u.test(error.message));
  const changedRetained = structuredClone(input);
  changedRetained.retainedSourceUnits[0].claims[0].digest = 'changed retained target';
  assert.throws(() => coverageIdentity(changedRetained), error => error.code === 'BASELINE_COVERAGE_UNVERIFIED'
    && /retained decisions differ from the original identity/u.test(error.message));
  changedRetained.identity.retainedSourcesDigest = sha256(changedRetained.retainedSourceUnits);
  assert.notEqual(coverageIdentity(changedRetained).candidateDigest, originalIdentity.candidateDigest);
  await assert.rejects(verifyBaselineCoverageProof(proof.pointer, { identity: coverageIdentity(changedRetained) }),
    error => error.code === 'BASELINE_COVERAGE_UNVERIFIED' && /Stale or foreign audit proof/u.test(error.message));
});

test('multipart originals with no sourceUnits retain the full audit denominator', async t => {
  const f = await sharedBasisFixture(t);
  await fs.writeFile(f.transcript, JSON.stringify({ ...user(), message: { role: 'user',
    content: 'Preserve the requested feature.\r\n' + '说明：该段为背景上下文。\r\n'.repeat(1500) } }) + '\n');
  await f.refresh();
  const input = f.state.auditInputs[0];
  assert.equal(sourceUnits(input.identity).length, 0);
  assert(input.identity.sources.find(source => source.kind === 'USER_MESSAGE').parts.length > 1);
  const proof = (await f.task()).groundTruth.sharedBasis.coverageAudit;
  const bundle = await verifyBaselineCoverageProof(proof.pointer, { truth: await f.truth() });
  assert.equal(bundle.report.sources.length, input.identity.sources.length);
});

for (const mutation of ['one-byte', 'non-text', 'non-string-text']) test(`multiblock ${mutation} evidence is rejected for its exact proof failure`, async t => {
  const f = await sharedBasisFixture(t);
  const errors = [];
  f.state.coverageMutation = async ({ params }) => {
    const records = (await fs.readFile(params.sessionFile, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
    const row = records.find(row => row.message?.role === 'toolResult' && row.message.toolName === 'source_read'
      && row.message.content.length > 1 && Buffer.byteLength(row.message.content.map(block => block.text).join('')) > 6000);
    assert(row, 'mutation requires an actual above6000-byte multiblock result');
    if (mutation === 'one-byte') row.message.content[0].text = (row.message.content[0].text[0] === '[' ? '{' : '[') + row.message.content[0].text.slice(1);
    if (mutation === 'non-text') row.message.content.push({ type: 'image', data: 'controlled-non-text-block' });
    if (mutation === 'non-string-text') row.message.content.push({ type: 'text', text: 42 });
    await fs.writeFile(params.sessionFile, records.map(row => JSON.stringify(row)).join('\n') + '\n');
  };
  await assert.rejects(refreshCapturingAuditFailure(f, errors, `bad-native-${mutation}`));
  assert.equal(errors.length, 1, 'reach the independent audit proof gate, not an earlier fixture error');
  assert.equal(errors[0].code, 'BASELINE_COVERAGE_UNVERIFIED');
  assert.match(errors[0].message, mutation === 'one-byte'
    ? /Audit ACK does not match the same native transcript call\/result/u : /Audit native result contains non-text content/u);
  assert.equal(f.audits().length, 1);
  assert.equal((await f.truth()).version, 0);
});
