import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { stopProtocolFixture } from './helpers/stop-protocol.mjs';
import { loadStopOriginalRequirements } from '../lib/runtime-v2/production-stop.mjs';
import { resolveStopReviewPolicy } from '../lib/runtime-v2/metric-policy.mjs';
import { readOpenSpecPlan } from '../lib/openspec-plan.mjs';
import { createOriginalSourceAnchor } from '../lib/runtime-v2/original-source-anchor.mjs';
import { observeKnownOriginalObligations, knownOriginalObligations, knownOriginalObligationReader }
  from '../lib/runtime-v2/known-original-obligations.mjs';

const assessment = { activation: 'ACTIVE', evidenceKind: 'TARGET_FACTS', reason: 'Current source exposes the requested streaming activation facts.' };
async function fixture(t, { count = 1, conditional = true, long = false, amendment = false } = {}) {
  const f = await stopProtocolFixture(t, 'findings');
  f.input.request.reviewScope = { kind: 'workspace-stop' }; delete f.input.request.fixedStopClassification;
  f.input.request.classificationContract = 2;
  f.input.request.population.reviewPolicy = resolveStopReviewPolicy({ deviationOnly: true, metrics: { M11: true, M16: true } });
  const requirements = Array.from({ length: count }, (_, i) => `Preserve segment ordering for channel ${i}${conditional ? ' when streaming is enabled' : ''}.${long ? ' Keep each observed segment in its original sequence, including empty and repeated segments, without dropping either boundary or changing the surrounding stream contract.' : ''}`);
  if (amendment) requirements[1] = 'Do not modify the stream until the operator explicitly approves the work.';
  f.input.evidence.snapshot.entries[0].message.content = ['# Stream duties', ...requirements].join('\n') + '\n';
  let original = await loadStopOriginalRequirements({ projectRoot: f.root, snapshot: f.input.evidence.snapshot });
  const source = original.userMessages[0], dir = path.join(f.root, 'openspec/changes/stream-order');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'proposal.md'), '# Proposed ordering\n' + requirements.join('\n') + '\n');
  await fs.writeFile(path.join(dir, 'tasks.md'), '- [ ] Preserve ordering.\n');
  const snapshot = await readOpenSpecPlan(f.root, 'stream-order');
  f.owner = { projectRoot: f.root, sessionId: 'protocol-host', sessionKey: 'agent:main:s', scopeTaskId: f.input.taskId,
    projectScope: { fingerprint: 'scope' }, nativeRunId: 'proposal-run', reviewController: new AbortController() };
  const rows = requirements.map((requirement, i) => ({ source: createOriginalSourceAnchor({ ref: source.ref, sha256: source.sha256,
    bytes: Buffer.from(source.text), start: i + 2, end: i + 2 }), requirement, disposition: 'COVERED',
    reason: 'The exact original duty has a reviewed plan range.', targets: [{ ...snapshot.documents[0], start: 1, end: 2 }] }));
  assert.equal(await observeKnownOriginalObligations(f.owner, { file: 'openspec/changes/stream-order/tasks.md', sources: original.userMessages,
    receipt: { schemaVersion: 1, runId: 'proposal-run', taskId: f.input.taskId, sessionId: 'protocol-host', scope: snapshot.documents, rows },
    publication: { runId: 'proposal-run', taskId: f.input.taskId, sessionId: 'protocol-host', result: { status: 'passed',
      metadata: { inputs: snapshot.documents, semanticReview: { status: 'completed' } } } } }), true);
  f.owner.nativeRunId = 'apply-run'; f.owner.reviewController = new AbortController();
  f.candidates = knownOriginalObligations(f.owner).items;
  if (amendment) {
    f.input.evidence.snapshot.entries.push({ type: 'user', uuid: 'U2', message: { content: 'I approve the work. You may modify the stream now.' } });
    original = await loadStopOriginalRequirements({ projectRoot: f.root, snapshot: f.input.evidence.snapshot });
  }
  f.input.evidence.originalRequirements = original;
  f.input.readKnownOriginalObligations = knownOriginalObligationReader(f.owner);
  f.production = path.join(f.root, 'stream.mjs');
  await fs.writeFile(f.production, 'export const streaming = true;\nexport const ordered = values => [...values];\n');
  f.prepare = async tools => {
    await tools.readAll();
    const originalFile = tools.brief.task.basisFiles.find(file => path.basename(file).startsWith('user-original-0'));
    const originalId = (await tools.read(originalFile)).details.citation.citeId;
    const page = await tools.submit('set_original_checklist', { items: requirements.map((text, i) => ({ metricId: 'M16', verificationTarget: 'IMPLEMENTATION', text,
      ...(conditional && !(amendment && i === 1) ? { applicability: 'Streaming is enabled.' } : {}), knownCandidateId: f.candidates[i].id,
      knownDutyReason: long ? 'The exact original duty line is the complete retained stream obligation, including all boundary and ordering cases. '.repeat(3) : 'The original line states the complete retained duty.',
      citeId: originalId, lineStart: i + 2, lineEnd: i + 2 })), scope: { stopClassification: 'TASK_COMPLETE', completionClaim: true, limit: 20 } });
    return requirements.map(text => page.items.find(item => item.description === text));
  };
  f.rows = objects => f.candidates.map((candidate, i) => ({ id: candidate.id, disposition: 'CURRENT', objectId: objects[i].objectId,
    verdict: 'NO_CONFIRMED_DEVIATION', reason: 'Current acknowledged source establishes this original stream duty.' }));
  const run = f.run;
  f.run = async script => {
    let failure, completed = false;
    const handle = await run(async tools => {
      try { await script(tools); completed = true; }
      catch (error) { failure = error; throw error; }
    });
    if (failure) { await handle.close(); throw failure; }
    assert.equal(completed, true, 'The actual reviewer callback must finish.');
    return handle;
  };
  return f;
}

test('known conditional feedback lists both context-required fields without losing large pending items', async t => {
  const f = await fixture(t, { count: 5, long: true });
  const handle = await f.run(async tools => {
    const objects = await f.prepare(tools), rows = f.rows(objects);
    const first = await tools.submit('finish_stop_review', { summary: 'Current scan complete.', knownObligations: rows });
    assert.equal(first.complete, false); assert.equal(first.pendingKnownOriginalCount, 5);
    assert(first.pendingKnownOriginals.length > 0, 'A nonzero pending count must carry actionable compact entries.');
    assert(Buffer.byteLength(JSON.stringify(first.pendingKnownOriginals)) <= 1401);
    for (const item of first.pendingKnownOriginals) {
      assert(item.diagnostic.missingFields.includes('citeIds'));
      assert(item.diagnostic.missingFields.includes('conditionAssessment'));
    }
    const page = await tools.submit('review_checklist', { offset: 0, limit: 20 });
    assert.equal(page.knownObligations.items.length, 5);
    for (const item of page.knownObligations.items) assert(item.currentAssessment.diagnostic.missingFields.includes('conditionAssessment'));
    const current = (await tools.read(f.production)).details.citation.citeId;
    assert.equal((await tools.submit('finish_stop_review', { summary: 'Explicit activation and current proof supplied.', knownObligations:
      rows.map(row => ({ ...row, citeIds: [current], conditionAssessment: assessment })) })).complete, true);
  });
  assert.equal(handle.result.unverifiedItems.length, 0); assert.equal(f.calls.length, 1);
  assert(handle.result.knownOriginalCoverage.items.every(item => item.disposition === 'CURRENT')); await handle.close();
});

test('known conditional feedback exposes the actual validator code before its same-worker repair', async t => {
  const f = await fixture(t);
  const handle = await f.run(async tools => {
    const objects = await f.prepare(tools), current = (await tools.read(f.production)).details.citation.citeId;
    const row = { ...f.rows(objects)[0], citeIds: [current], conditionAssessment: { activation: 'UNKNOWN', evidenceKind: 'TARGET_FACTS', reason: 'Activation is not established.' } };
    const first = await tools.submit('finish_stop_review', { summary: 'Initial current proposal.', knownObligations: [row] });
    assert.equal(first.complete, false); assert.equal(first.pendingKnownOriginals[0].diagnostic.code, 'REVIEW_CONDITION_VERDICT_CONFLICT');
    assert.equal((await tools.submit('finish_stop_review', { summary: 'Current activation is explicit.', knownObligations: [{ ...row, conditionAssessment: assessment }] })).complete, true);
  });
  assert.equal(handle.result.unverifiedItems.length, 0); assert.equal(f.calls.length, 1); await handle.close();
});

for (const proof of ['missing-assessment', 'unacknowledged-current', 'foreign-current']) test(`known current ${proof} remains unverified after its one accounting repair`, async t => {
  const f = await fixture(t);
  const handle = await f.run(async tools => {
    const objects = await f.prepare(tools), row = f.rows(objects)[0];
    assert.equal((await tools.submit('finish_stop_review', { summary: 'Initial incomplete proof.', knownObligations: [row] })).complete, false);
    const read = await tools.read(f.production, { receipt: proof !== 'unacknowledged-current' });
    row.citeIds = [proof === 'foreign-current' ? 'not-a-host-citation' : read.details.citation.citeId];
    if (proof !== 'missing-assessment') row.conditionAssessment = assessment;
    assert.equal((await tools.submit('finish_stop_review', { summary: 'Only the actual available evidence.', knownObligations: [row] })).complete, true);
  });
  assert.equal(handle.result.knownOriginalCoverage.items[0].disposition, 'UNVERIFIED'); assert.equal(f.calls.length, 1); await handle.close();
});

test('known unconditional CURRENT keeps its valid proof path without a conditional assessment', async t => {
  const f = await fixture(t, { conditional: false });
  const handle = await f.run(async tools => {
    const objects = await f.prepare(tools), current = (await tools.read(f.production)).details.citation.citeId;
    assert.equal((await tools.submit('finish_stop_review', { summary: 'Current unconditional proof.', knownObligations: [{ ...f.rows(objects)[0], citeIds: [current] }] })).complete, true);
  });
  assert.equal(handle.result.unverifiedItems.length, 0); await handle.close();
});

test('mixed known CURRENT and source-grounded SUPERSEDED preserve separate evidence paths', async t => {
  const f = await fixture(t, { count: 2, amendment: true });
  const handle = await f.run(async tools => {
    const objects = await f.prepare(tools), current = (await tools.read(f.production)).details.citation.citeId;
    const laterFile = tools.brief.task.basisFiles.find(file => path.basename(file).startsWith('user-original-1'));
    const later = (await tools.read(laterFile)).details.citation.citeId, rows = f.rows(objects);
    assert.equal((await tools.submit('finish_stop_review', { summary: 'Current duty and later approval.', knownObligations: [
      { ...rows[0], citeIds: [current], conditionAssessment: assessment },
      { id: rows[1].id, disposition: 'SUPERSEDED', reason: 'The later original approval replaces only the pre-approval restriction.', citeIds: [later] },
    ] })).complete, true);
  });
  assert.deepEqual(handle.result.knownOriginalCoverage.items.map(item => item.disposition), ['CURRENT', 'SUPERSEDED']);
  assert.equal(handle.result.unverifiedItems.length, 0); await handle.close();
});

test('known CURRENT partial-read feedback exposes exact witness predicates and full read repairs in the same worker', async t => {
  const f = await fixture(t);
  const handle = await f.run(async tools => {
    const objects = await f.prepare(tools), rows = f.rows(objects);
    const partial = (await tools.read(f.production, { offset: 2 })).details.citation.citeId;
    const first = await tools.submit('finish_stop_review', { summary: 'Initial partial source observation.', knownObligations:
      [{ ...rows[0], citeIds: [partial], conditionAssessment: assessment }] });
    assert.equal(first.complete, false);
    const diagnostic = first.pendingKnownOriginals[0].diagnostic;
    assert.equal(diagnostic.code, 'REVIEW_CONDITION_EVIDENCE_UNAVAILABLE');
    assert.equal(diagnostic.witnessReadiness.citations[0].citeId, partial);
    assert.deepEqual(diagnostic.witnessReadiness.citations[0].targetFactsMissing, ['fullFile']);
    const pending = await tools.submit('review_checklist', first.pendingNavigation.arguments);
    const item = pending.items.find(item => item.id === rows[0].id);
    assert(item.diagnostic.witnessReadiness.citations[0].targetFactsMissing.includes('fullFile'));
    assert.equal(pending.readProofGranted, false); assert.equal(pending.semanticsVerified, false);
    const current = (await tools.read(f.production)).details.citation.citeId;
    assert.equal((await tools.submit('finish_stop_review', { summary: 'Complete current activation source disclosed.', knownObligations:
      [{ ...rows[0], citeIds: [current], conditionAssessment: assessment }] })).complete, true);
  });
  assert.equal(f.calls.length, 1); assert.equal(handle.result.unverifiedItems.length, 0); await handle.close();
});

test('pending pagination retains every conditional witness diagnostic without granting proof or another repair', async t => {
  const f = await fixture(t, { count: 3 });
  const handle = await f.run(async tools => {
    const objects = await f.prepare(tools), partial = (await tools.read(f.production, { offset: 2 })).details.citation.citeId;
    const rows = f.rows(objects).map(row => ({ ...row, citeIds: [partial], conditionAssessment: assessment }));
    const first = await tools.submit('finish_stop_review', { summary: 'Partial sources remain uncertain.', knownObligations: rows });
    assert.equal(first.complete, false); assert.equal(first.pendingKnownOriginalCount, 3);
    assert(Buffer.byteLength(JSON.stringify(first.pendingKnownOriginals)) <= 1401);
    let request = { ...first.pendingNavigation.arguments, limit: 1 }, seen = [];
    while (request) {
      const page = await tools.submit('review_checklist', request); assert(Buffer.byteLength(JSON.stringify(page)) <= 8192);
      for (const item of page.items) {
        if (item.type !== 'KNOWN_ORIGINAL_OBLIGATION') continue;
        assert(item.diagnostic.witnessReadiness.citations[0].targetFactsMissing.includes('fullFile')); seen.push(item.id);
      }
      request = page.next?.arguments ?? null;
    }
    assert.deepEqual(new Set(seen), new Set(rows.map(row => row.id)));
    assert.equal((await tools.submit('finish_stop_review', { summary: 'No complete activation witness was disclosed.', knownObligations: rows })).complete, true);
  });
  assert.equal(f.calls.length, 1); assert.equal(handle.result.knownOriginalCoverage.items.filter(row => row.disposition === 'UNVERIFIED').length, 3);
  await handle.close();
});
