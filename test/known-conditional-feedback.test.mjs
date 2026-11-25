import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { stopProtocolFixture } from './helpers/stop-protocol.mjs';
import { loadStopOriginalRequirements } from '../lib/runtime-v2/production-stop.mjs';
import { resolveStopReviewPolicy } from '../lib/runtime-v2/metric-policy.mjs';
import { readOpenSpecPlan } from '../lib/openspec-plan.mjs';
import { createOriginalSourceAnchor } from '../lib/runtime-v2/original-source-anchor.mjs';
import { ORIGINAL_PROOF_SUBJECT_GUIDANCE } from '../lib/runtime-v2/review-result-validation.mjs';
import { observeKnownOriginalObligations, knownOriginalObligations, knownOriginalObligationReader }
  from '../lib/runtime-v2/known-original-obligations.mjs';

const assessment = { activation: 'ACTIVE', evidenceKind: 'TARGET_FACTS', reason: 'Current source exposes the requested streaming activation facts.' };
async function checklistPages(tools, first) {
  const items = [], known = [], pages = [];
  let page = first;
  const restore = async pointer => {
    let args = pointer.arguments, text = '';
    do {
      const detail = await tools.submit('review_checklist', args);
      assert.equal(detail.readProofGranted, false); assert.equal(detail.assessmentGranted, false);
      assert(Buffer.byteLength(JSON.stringify(detail)) <= 8192);
      text += detail.jsonText; args = detail.next?.arguments;
    } while (args);
    return JSON.parse(text);
  };
  do {
    assert(Buffer.byteLength(JSON.stringify(page)) <= 8192); pages.push(page);
    for (const row of page.items) items.push(row.fullContentDeferred ? await restore(row.readWith) : row);
    for (const row of page.knownObligations?.items ?? []) known.push(row.fullContentDeferred ? await restore(row.readWith) : row);
    const next = page.next?.arguments ?? (page.nextOffset !== null ? { offset: page.nextOffset, limit: 20 } : null);
    page = next ? await tools.submit('review_checklist', next) : null;
  } while (page);
  return { items, known, pages };
}
async function fixture(t, { count = 1, conditional = true, long = false, amendment = false, execution = false, sharedResult = false, windowTrigger = false } = {}) {
  const f = await stopProtocolFixture(t, 'findings');
  f.input.request.reviewScope = { kind: 'workspace-stop' }; delete f.input.request.fixedStopClassification;
  f.input.request.classificationContract = 2;
  f.input.request.population.reviewPolicy = resolveStopReviewPolicy({ deviationOnly: true, metrics: { M11: true, M16: true } });
  const requirements = Array.from({ length: count }, (_, i) => `${execution ? 'Run the declared verification command for channel' : 'Preserve segment ordering for channel'} ${i}${conditional ? windowTrigger ? ' after a later operation' : ' when streaming is enabled' : ''}.${long ? ' Keep each observed segment in its original sequence, including empty and repeated segments, without dropping either boundary or changing the surrounding stream contract.' : ''}`);
  if (amendment) requirements[1] = 'Do not modify the stream until the operator explicitly approves the work.';
  f.input.evidence.snapshot.entries[0].message.content = ['# Stream duties', ...requirements].join('\n') + '\n';
  if (execution) f.input.evidence.snapshot.entries.push(
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'verify-a', name: 'Bash', input: { command: 'verify-a' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'verify-a', content: 'Verification A passed.' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'verify-b', name: 'Bash', input: { command: 'verify-b' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'verify-b', content: 'Verification B passed.' }] } },
  );
  if (execution && sharedResult) {
    f.input.evidence.snapshot.entries.splice(1, 4,
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'verify-a', name: 'Bash', input: { command: 'verify-a' } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'verify-b', name: 'Bash', input: { command: 'verify-b' } }] } },
      { type: 'user', message: { content: [
        { type: 'tool_result', tool_use_id: 'verify-a', content: 'Verification A passed.' },
        { type: 'tool_result', tool_use_id: 'verify-b', content: 'Verification B passed.' },
      ] } });
  }
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
  f.prepare = async (tools, take = requirements.length) => {
    await tools.readAll();
    const originalFile = tools.brief.task.basisFiles.find(file => path.basename(file).startsWith('user-original-0'));
    const originalId = (await tools.read(originalFile)).details.citation.citeId;
    const page = await tools.submit('set_original_checklist', { items: requirements.slice(0, take).map((text, i) => ({ metricId: execution ? 'M12' : 'M16', verificationTarget: execution ? 'PROCESS' : 'IMPLEMENTATION', text,
      ...(conditional && !(amendment && i === 1) ? { applicability: windowTrigger ? 'A later operation occurred.' : 'Streaming is enabled.' } : {}), knownCandidateId: f.candidates[i].id,
      knownDutyReason: long ? 'The exact original duty line is the complete retained stream obligation, including all boundary and ordering cases. '.repeat(3) : 'The original line states the complete retained duty.',
      citeId: originalId, lineStart: i + 2, lineEnd: i + 2 })), scope: { stopClassification: 'TASK_COMPLETE', completionClaim: true, limit: 20 } });
    f.initialChecklistPage = page;
    const complete = await checklistPages(tools, page);
    return requirements.slice(0, take).map(text => complete.items.find(item => item.description === text));
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
    const page = await checklistPages(tools, await tools.submit('review_checklist', { offset: 0, limit: 20 }));
    assert.equal(page.known.length, 5);
    for (const item of page.known) assert(item.currentAssessment.diagnostic.missingFields.includes('conditionAssessment'));
    const current = (await tools.read(f.production)).details.citation.citeId;
    assert.equal((await tools.submit('finish_stop_review', { summary: 'Explicit activation and current proof supplied.', knownObligations:
      rows.map(row => ({ ...row, citeIds: [current], conditionAssessment: assessment })) })).complete, true);
  });
  assert.equal(handle.result.unverifiedItems.length, 0); assert.equal(f.calls.length, 1);
  assert(handle.result.knownOriginalCoverage.items.every(item => item.disposition === 'CURRENT')); await handle.close();
});

test('native checklist accepts legacy known-only offsets while explicit independent cursors stay strict', async t => {
  const f = await fixture(t, { count: 3 });
  const handle = await f.run(async tools => {
    await f.prepare(tools, 1);
    const first = await tools.submit('review_checklist', { offset: 0, limit: 1 });
    assert.equal(first.nextOffset, null); assert.equal(first.knownObligations.nextOffset, 1);
    const legacy = await tools.submit('review_checklist', { offset: 2, limit: 1 });
    assert.deepEqual(legacy.items, []); assert.equal(legacy.knownObligations.items[0].id, f.candidates[2].id);
    await assert.rejects(tools.submit('review_checklist', { offset: 2, knownOffset: 2, limit: 1 }), { code: 'REVIEW_NAVIGATION_RANGE' });
    await assert.rejects(tools.submit('review_checklist', { offset: 4, limit: 1 }), { code: 'REVIEW_NAVIGATION_RANGE' });
    const complete = await checklistPages(tools, first);
    assert.deepEqual(complete.known.map(item => item.id), f.candidates.map(item => item.id));
    const finish = await tools.submit('finish_stop_review', { summary: 'All retained duties remain explicitly unresolved.',
      knownObligations: f.candidates.map(candidate => ({ id: candidate.id, disposition: 'UNVERIFIED', reason: 'Navigation supplies no current verdict.' })) });
    assert.equal(finish.complete, true);
  });
  assert(handle.result.knownOriginalCoverage.items.every(item => item.disposition === 'UNVERIFIED')); await handle.close();
});

test('native checklist details preserve auxiliary content without granting source reads or assessments', async t => {
  const f = await fixture(t);
  f.input.request.artifactCandidates = Array.from({ length: 48 }, (_, i) => ({ artifactId: `generic-artifact-${i}`,
    path: `generic/${i}/` + 'delivery/'.repeat(30), description: 'Full generic navigation text. '.repeat(10) }));
  const handle = await f.run(async tools => {
    assert(tools.params.extraSystemPrompt.includes(ORIGINAL_PROOF_SUBJECT_GUIDANCE));
    const originalTool = tools.tools.get('set_original_checklist');
    assert(originalTool.description.includes(ORIGINAL_PROOF_SUBJECT_GUIDANCE));
    assert.equal(originalTool.parameters.properties.items.items.properties.verificationTarget.description, ORIGINAL_PROOF_SUBJECT_GUIDANCE);
    const objects = await f.prepare(tools), page = f.initialChecklistPage;
    assert(page.checklistDetails.fields.includes('artifactCandidates'));
    let args = page.checklistDetails.readWith.arguments, content = '';
    do {
      const detail = await tools.submit('review_checklist', args);
      assert.equal(detail.readProofGranted, false); assert.equal(detail.assessmentGranted, false);
      assert.equal(detail.citation, undefined); assert(Buffer.byteLength(JSON.stringify(detail)) <= 8192);
      content += detail.jsonText; args = detail.next?.arguments;
    } while (args);
    assert.deepEqual(JSON.parse(content).artifactCandidates, f.input.request.artifactCandidates);
    await assert.rejects(tools.submit('review_checklist', { ...page.checklistDetails.readWith.arguments,
      stopClassification: 'TASK_COMPLETE' }), { code: 'REVIEW_NAVIGATION_SCOPE' });
    const first = await tools.submit('finish_stop_review', { summary: 'Details alone do not satisfy current proof.', knownObligations: f.rows(objects) });
    assert.equal(first.complete, false); assert.equal(first.pendingKnownOriginalCount, 1);
    assert(first.pendingKnownOriginals[0].diagnostic.missingFields.includes('citeIds'));
    const final = await tools.submit('finish_stop_review', { summary: 'The missing proof remains explicitly unresolved.',
      knownObligations: [{ id: f.candidates[0].id, disposition: 'UNVERIFIED', reason: 'Read-only details grant no source proof.' }] });
    assert.equal(final.complete, true);
  });
  assert.equal(handle.result.knownOriginalCoverage.items[0].disposition, 'UNVERIFIED'); await handle.close();
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


test('the first checklist guides optional readiness and genuine missing-range reads before first finish', async t => {
  const f = await fixture(t);
  const handle = await f.run(async tools => {
    const objects = await f.prepare(tools), page = f.initialChecklistPage;
    assert.match(page.evidenceReadinessInstruction, /Before first finish.*review_checklist with evidenceReadiness/);
    assert.match(page.evidenceReadinessInstruction, /actual objectId.*current source_read citation IDs/);
    assert.match(page.evidenceReadinessInstruction, /optional query grants no assessment or read proof/);
    assert.match(page.evidenceReadinessInstruction, /unsupported process-window conclusions UNVERIFIED/);
    assert.equal(JSON.stringify(page).split('evidenceReadinessInstruction').length - 1, 1);
    assert(objects.every(item => item.readinessNavigation === undefined), 'No per-item empty-citation call is added.');
    const { evidenceReadinessInstruction, ...priorShape } = page;
    const bytes = Buffer.byteLength(JSON.stringify(page)) - Buffer.byteLength(JSON.stringify(priorShape));
    t.diagnostic(`CHECKLIST_READINESS_GUIDANCE_BYTES ${JSON.stringify({ addedBytes: bytes, itemCount: page.items.length })}`);
    assert(bytes < 640, 'One shared guide has constant bounded transport cost.');
    const partial = (await tools.read(f.production, { offset: 2 })).details.citation.citeId;
    const query = { evidenceReadiness: { objectId: objects[0].objectId, citeIds: [partial], conditionAssessment: assessment } };
    const preview = await tools.submit('review_checklist', query);
    assert.equal(preview.readProofGranted, false); assert.equal(preview.assessmentGranted, false);
    assert.deepEqual(preview.witnessReadiness.citations[0].targetFactsMissing, ['fullFile']);
    assert.equal((await tools.submit('review_checklist', query)).citations[0].fullFile, false,
      'Guidance and repeated preview do not acknowledge the missing source.');
    for (const action of preview.readPlan) {
      tools.advance(); const toolCallId = crypto.randomUUID();
      const result = await tools.tools.get(action.tool).execute(toolCallId, action.arguments);
      tools.params.onAgentToolResult({ toolName: action.tool, result, isError: false });
      tools.hooks.get('tool_result_persist')({ toolName: action.tool, toolCallId, isSynthetic: false,
        message: { role: 'toolResult', toolName: action.tool, toolCallId, isError: false, content: result.content } }, tools.params);
    }
    const repaired = await tools.submit('review_checklist', query);
    assert.equal(repaired.citations[0].fullFile, true); assert.equal(repaired.readPlan.length, 0);
    assert.equal(repaired.assessmentGranted, false);
    assert.equal((await tools.submit('finish_stop_review', { summary: 'The first finish follows genuine source receipts.',
      knownObligations: [{ ...f.rows(objects)[0], citeIds: [partial], conditionAssessment: assessment }] })).complete, true);
  });
  assert.equal(handle.result.unverifiedItems.length, 0); await handle.close();
});

test('early readiness exposes exact missing ranges and cumulative disclosure without granting an assessment', async t => {
  const f = await fixture(t);
  const handle = await f.run(async tools => {
    const objects = await f.prepare(tools), row = f.rows(objects)[0];
    assert.equal(objects[0].evidenceRequirements.conditionalWitness.targetFacts.fullFile, true);
    const partial = (await tools.read(f.production, { offset: 2 })).details.citation.citeId;
    const query = { evidenceReadiness: { objectId: objects[0].objectId, citeIds: [partial], conditionAssessment: assessment } };
    const preview = await tools.submit('review_checklist', query);
    for (const key of ['readProofGranted', 'assessmentGranted', 'semanticsVerified']) assert.equal(preview[key], false);
    assert.deepEqual(preview.witnessReadiness.citations[0].targetFactsMissing, ['fullFile']);
    assert.deepEqual(preview.readPlan.map(read => [read.arguments.offset, read.arguments.limit]), [[1, 1]]);
    assert.equal((await tools.submit('review_checklist', query)).citations[0].fullFile, false, 'A second preview cannot acknowledge missing ranges.');
    const proposed = { ...row, citeIds: [partial], conditionAssessment: assessment };
    const rejected = await tools.submit('finish_stop_review', { summary: 'Navigation grants no proof.', knownObligations: [proposed] });
    assert.equal(rejected.complete, false);
    const pending = await tools.submit('review_checklist', rejected.pendingNavigation.arguments);
    assert.deepEqual(pending.items.find(item => item.id === row.id).readinessNavigation.arguments, query);
    await tools.read(f.production);
    const repaired = await tools.submit('review_checklist', query);
    assert.equal(repaired.citations[0].fullFile, true);
    assert.equal(repaired.readPlan.length, 0);
    assert.equal(repaired.assessmentGranted, false);
    await assert.rejects(tools.submit('finish_stop_review', { summary: 'A preview is not a finish receipt.', knownObligations: [proposed], evidenceReadiness: repaired }), { code: 'TASK_SUBMISSION_INVALID' });
    assert.equal((await tools.submit('finish_stop_review', { summary: 'Genuine cumulative reads support the original relevant citation.', knownObligations: [proposed] })).complete, true);
  });
  assert.equal(handle.result.unverifiedItems.length, 0); await handle.close();
});

test('early navigation cannot acknowledge an unpersisted read', async t => {
  const f = await fixture(t);
  const handle = await f.run(async tools => {
    const objects = await f.prepare(tools), row = f.rows(objects)[0];
    const unacknowledged = (await tools.read(f.production, { receipt: false })).details.citation.citeId;
    const query = { evidenceReadiness: { objectId: objects[0].objectId, citeIds: [unacknowledged], conditionAssessment: assessment } };
    // A pending native citation may be available for diagnostics, never as an acknowledged read.
    try {
      const preview = await tools.submit('review_checklist', query);
      assert.equal(preview.citations[0].acknowledged, false); assert.equal(preview.citations[0].requiredOwnerReady, false);
    } catch (error) { assert.equal(error.code, 'REVIEW_READINESS_CITATION_INVALID'); }
    const proposed = { ...row, citeIds: [unacknowledged], conditionAssessment: assessment };
    await tools.submit('finish_stop_review', { summary: 'Unpersisted reads stay uncertain.', knownObligations: [proposed] });
    await tools.submit('finish_stop_review', { summary: 'Navigation did not manufacture evidence.', knownObligations: [proposed] });
  });
  assert.equal(handle.result.knownOriginalCoverage.items[0].disposition, 'UNVERIFIED'); await handle.close();
});

test('early readiness preserves owner, actual scope, issued-citation and freshness boundaries', async t => {
  const f = await fixture(t);
  const handle = await f.run(async tools => {
    const objects = await f.prepare(tools), row = f.rows(objects)[0];
    const originalFile = tools.brief.task.basisFiles.find(file => path.basename(file).startsWith('user-original-0'));
    const basis = (await tools.read(originalFile)).details.citation.citeId;
    const wrongOwner = await tools.submit('review_checklist', { evidenceReadiness: { objectId: objects[0].objectId, citeIds: [basis], conditionAssessment: assessment } });
    assert.equal(wrongOwner.citations[0].requiredOwnerReady, false); assert.equal(wrongOwner.citations[0].owner, 'BASIS');
    assert.equal(wrongOwner.witnessReadiness.citations[0].requiredOwnerReady, false);
    await assert.rejects(tools.submit('review_checklist', { evidenceReadiness: { objectId: 'foreign-object', citeIds: [basis] } }), { code: 'REVIEW_READINESS_SCOPE' });
    await assert.rejects(tools.submit('review_checklist', { evidenceReadiness: { objectId: objects[0].objectId, citeIds: ['not-issued'] } }), { code: 'REVIEW_READINESS_CITATION_INVALID' });
    const proposed = { ...row, citeIds: [basis], conditionAssessment: assessment };
    const first = await tools.submit('finish_stop_review', { summary: 'Original input is not production proof.', knownObligations: [proposed] });
    assert.equal(first.complete, false);
    await tools.submit('finish_stop_review', { summary: 'Cross-owner evidence remains uncertain.', knownObligations: [proposed] });
  });
  assert.equal(handle.result.knownOriginalCoverage.items[0].disposition, 'UNVERIFIED'); await handle.close();
});

test('early readiness rejects stale current bytes rather than refreshing a citation through navigation', async t => {
  const f = await fixture(t);
  await assert.rejects(f.run(async tools => {
    const objects = await f.prepare(tools), current = (await tools.read(f.production)).details.citation.citeId;
    await fs.appendFile(f.production, '// changed after the actual read\n');
    await tools.submit('review_checklist', { evidenceReadiness: { objectId: objects[0].objectId, citeIds: [current], conditionAssessment: assessment } });
  }), { code: 'BASELINE_INPUT_CHANGED' });
});

test('early execution navigation names the real companion and rejects a mismatched invocation until genuine repair', async t => {
  const f = await fixture(t, { execution: true, conditional: false });
  const handle = await f.run(async tools => {
    const objects = await f.prepare(tools), row = f.rows(objects)[0];
    assert.equal(objects[0].evidenceRequirements.execution.everyInvocationPartRead, true);
    const listing = await tools.submit('review_checklist', { view: 'process', offset: 0, limit: 20 });
    assert.equal(listing.items.length, 2);
    const selected = await tools.submit('review_checklist', listing.items[0].readWith.arguments);
    const other = await tools.submit('review_checklist', listing.items[1].readWith.arguments);
    const resultFile = selected.items.find(item => item.kind === 'result').file;
    const actualInvocation = selected.items.find(item => item.kind === 'invocation').file;
    const unrelatedInvocation = other.items.find(item => item.kind === 'invocation').file;
    const current = (await tools.read(path.join(f.root, resultFile))).details.citation.citeId;
    await tools.read(path.join(f.root, unrelatedInvocation));
    // Preserve the original full-part rule even for an omitted terminal logical line.
    tools.advance();
    const partialCall = crypto.randomUUID(), partialInvocation = await tools.tools.get('source_read').execute(partialCall,
      { path: path.join(f.root, actualInvocation), offset: 1, limit: 1 });
    tools.params.onAgentToolResult({ toolName: 'source_read', result: partialInvocation, isError: false });
    tools.hooks.get('tool_result_persist')({ toolName: 'source_read', toolCallId: partialCall, isSynthetic: false,
      message: { role: 'toolResult', toolName: 'source_read', toolCallId: partialCall, isError: false, content: partialInvocation.content } }, tools.params);
    assert.equal(partialInvocation.details.page.nextOffset, 2);
    const query = { evidenceReadiness: { objectId: objects[0].objectId, citeIds: [current] } };
    const preview = await tools.submit('review_checklist', query);
    assert.equal(preview.executionPairs[0].executionEvidenceReady, false);
    assert.deepEqual(preview.executionPairs[0].alternatives[0].invocationFiles, [actualInvocation]);
    assert(preview.readPlan.some(read => read.arguments.path === actualInvocation && read.arguments.offset === 2 && read.arguments.limit === 1));
    const proposed = { ...row, citeIds: [current] };
    const rejected = await tools.submit('finish_stop_review', { summary: 'An unrelated invocation cannot complete this original execution proof.', knownObligations: [proposed] });
    assert.equal(rejected.complete, false);
    await tools.read(path.join(f.root, actualInvocation));
    assert.equal((await tools.submit('review_checklist', query)).executionPairs[0].executionEvidenceReady, true);
    assert.equal((await tools.submit('finish_stop_review', { summary: 'The actual original invocation and selected result are acknowledged.', knownObligations: [proposed] })).complete, true);
  });
  assert.equal(handle.result.unverifiedItems.length, 0); await handle.close();
});

test('early read planning bounds materialization and leaves undisclosed pages pending', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.production, 'export const streaming = true;\n' + '// original source line\n'.repeat(5000));
  const handle = await f.run(async tools => {
    const objects = await f.prepare(tools), partial = (await tools.read(f.production, { offset: 2 })).details.citation.citeId;
    const query = { evidenceReadiness: { objectId: objects[0].objectId, citeIds: [partial], conditionAssessment: assessment } };
    const preview = await tools.submit('review_checklist', query);
    assert(preview.readPlan.length <= 8); assert(Buffer.byteLength(JSON.stringify(preview.readPlan)) <= 4097);
    assert.equal(preview.readPlanComplete, false); assert(preview.remainingReadCount > 0);
    assert(preview.readPlan.every(read => read.arguments.limit <= 400));
    assert.equal((await tools.submit('review_checklist', query)).citations[0].fullFile, false);
    const proposed = { ...f.rows(objects)[0], citeIds: [partial], conditionAssessment: assessment };
    await tools.submit('finish_stop_review', { summary: 'A bounded plan does not read its remaining pages.', knownObligations: [proposed] });
    await tools.submit('finish_stop_review', { summary: 'Unobserved pages remain uncertain.', knownObligations: [proposed] });
  });
  assert.equal(handle.result.knownOriginalCoverage.items[0].disposition, 'UNVERIFIED'); await handle.close();
});


test('an already complete matching invocation alternative does not create unnecessary read obligations', async t => {
  const f = await fixture(t, { execution: true, conditional: false, sharedResult: true });
  const handle = await f.run(async tools => {
    const objects = await f.prepare(tools);
    const listing = await tools.submit('review_checklist', { view: 'process', offset: 0, limit: 20 });
    const pair = await tools.submit('review_checklist', listing.items[0].readWith.arguments);
    const result = pair.items.find(item => item.kind === 'result').file;
    const invocation = pair.items.find(item => item.kind === 'invocation').file;
    const current = (await tools.read(path.join(f.root, result))).details.citation.citeId;
    const query = { evidenceReadiness: { objectId: objects[0].objectId, citeIds: [current] } };
    const before = await tools.submit('review_checklist', query);
    assert.equal(before.executionPairs[0].alternativeCount, 2);
    assert.equal(before.executionPairs[0].executionEvidenceReady, false);
    assert(before.readPlan.length > 0);
    assert.equal(new Set(before.readPlan.map(read => read.arguments.path)).size, 1, 'Only one sufficient invocation alternative is scheduled.');
    await tools.read(path.join(f.root, invocation));
    const preview = await tools.submit('review_checklist', query);
    assert.equal(preview.executionPairs[0].executionEvidenceReady, true);
    assert.equal(preview.readPlan.length, 0, 'One fully read matching invocation is enough under the unchanged predicate.');
    assert.equal(preview.executionPairs[0].alternatives.filter(row => row.everyInvocationPartRead).length, 1);
    assert.equal((await tools.submit('finish_stop_review', { summary: 'The existing matching-alternative contract is preserved.', knownObligations: [{ ...f.rows(objects)[0], citeIds: [current] }] })).complete, true);
  });
  assert.equal(handle.result.unverifiedItems.length, 0); await handle.close();
});


test('an unavailable original process-window receipt stays explicit even when all named reads are complete', async t => {
  const f = await fixture(t, { execution: true, conditional: true, windowTrigger: true });
  const handle = await f.run(async tools => {
    const objects = await f.prepare(tools);
    const listing = await tools.submit('review_checklist', { view: 'process', offset: 0, limit: 20 });
    const pair = await tools.submit('review_checklist', listing.items[0].readWith.arguments);
    const result = pair.items.find(item => item.kind === 'result').file;
    const invocation = pair.items.find(item => item.kind === 'invocation').file;
    const current = (await tools.read(path.join(f.root, result))).details.citation.citeId;
    await tools.read(path.join(f.root, invocation));
    const conditionAssessment = { activation: 'INACTIVE_AT_CURRENT_BOUNDARY', evidenceKind: 'PROCESS_WINDOW',
      afterCallId: 'verify-b', reason: 'Absence of a later operation needs the complete attributable original process window.' };
    const query = { evidenceReadiness: { objectId: objects[0].objectId, citeIds: [current], conditionAssessment } };
    const preview = await tools.submit('review_checklist', query);
    assert.equal(preview.readPlan.length, 0); assert.equal(preview.executionPairs[0].executionEvidenceReady, true);
    assert.equal(preview.evidenceRequirements.conditionalWitness.processWindowSupport, 'UNAVAILABLE_IN_THIS_HOST');
    assert.equal(preview.witnessReadiness.effectiveContext.processWindowRequired, true);
    assert.equal(preview.witnessReadiness.effectiveContext.processWindowComplete, false);
    assert.equal(preview.unavailableEvidence.code, 'PROCESS_WINDOW_UNAVAILABLE_IN_THIS_HOST');
    assert.equal(preview.unavailableEvidence.readPlanCanEstablishWindow, false);
    assert.equal(preview.assessmentGranted, false);
    const proposed = { ...f.rows(objects)[0], verdict: 'NOT_APPLICABLE', citeIds: [current], conditionAssessment };
    const rejected = await tools.submit('finish_stop_review', { summary: 'Completed file reads do not invent an unavailable original window.', knownObligations: [proposed] });
    assert.equal(rejected.complete, false);
    assert.equal(rejected.pendingKnownOriginals[0].diagnostic.code, 'REVIEW_CONDITION_EVIDENCE_UNAVAILABLE');
    assert.equal((await tools.submit('finish_stop_review', { summary: 'The unsupported condition remains uncertain.', knownObligations: [proposed] })).complete, true);
  });
  assert.equal(handle.result.knownOriginalCoverage.items[0].disposition, 'UNVERIFIED'); await handle.close();
});


test('many long current paths keep the entire readiness transport bounded without reading or discharging omitted evidence', async t => {
  const f = await fixture(t);
  const directory = path.join(f.root, ...Array.from({ length: 6 }, (_, i) => 'source-segment-' + String(i) + '-'.repeat(30)));
  await fs.mkdir(directory, { recursive: true });
  const files = Array.from({ length: 16 }, (_, i) => path.join(directory, 'current-' + String(i).padStart(2, '0') + '-'.repeat(40) + '.mjs'));
  for (const file of files) await fs.writeFile(file, 'export const streaming = true;\nexport const ordered = values => [...values];\n');
  const handle = await f.run(async tools => {
    const objects = await f.prepare(tools), ids = [];
    for (const file of files) ids.push((await tools.read(file, { offset: 2 })).details.citation.citeId);
    const query = { evidenceReadiness: { objectId: objects[0].objectId, citeIds: ids, conditionAssessment: assessment } };
    const preview = await tools.submit('review_checklist', query);
    assert(Buffer.byteLength(JSON.stringify(preview)) <= 8192);
    assert.equal(preview.navigationByteLimit, 8192); assert.equal(preview.navigationTruncated, true);
    assert.equal(preview.citationCount, files.length);
    assert.equal(preview.citations.length + preview.omittedCitationCount, files.length);
    assert.equal(preview.witnessReadiness.citations.length + preview.witnessReadiness.omittedCitationCount, files.length);
    assert(preview.remainingReadCount > 0); assert.equal(preview.assessmentGranted, false);
    assert(preview.instruction.includes('query fewer citation IDs'));
    const smaller = await tools.submit('review_checklist', { evidenceReadiness: { ...query.evidenceReadiness, citeIds: [ids.at(-1)] } });
    assert.equal(smaller.citationCount, 1); assert.equal(smaller.omittedCitationCount, 0);
    assert.equal(smaller.citations[0].fullFile, false, 'Transport omission and a smaller query cannot acknowledge missing ranges.');
    const proposed = { ...f.rows(objects)[0], citeIds: ids, conditionAssessment: assessment };
    assert.equal((await tools.submit('finish_stop_review', { summary: 'Omitted navigation is still unobserved evidence.', knownObligations: [proposed] })).complete, false);
    await tools.submit('finish_stop_review', { summary: 'Every original obligation and current proof requirement stays intact.', knownObligations: [proposed] });
  });
  assert.equal(handle.result.knownOriginalCoverage.items[0].disposition, 'UNVERIFIED'); await handle.close();
});
