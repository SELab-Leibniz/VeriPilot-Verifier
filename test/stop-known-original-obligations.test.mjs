import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { stopProtocolFixture } from './helpers/stop-protocol.mjs';
import { loadStopOriginalRequirements } from '../lib/runtime-v2/production-stop.mjs';
import { resolveStopReviewPolicy } from '../lib/runtime-v2/metric-policy.mjs';
import { readOpenSpecPlan } from '../lib/openspec-plan.mjs';
import { createOriginalSourceAnchor } from '../lib/runtime-v2/original-source-anchor.mjs';
import { sha256 } from '../lib/runtime-v2/utils.mjs';
import { compileRuntimeV2Config } from '../lib/runtime-v2/config.mjs';
import { handleRuntimeV2Event } from '../lib/runtime-v2/orchestrator.mjs';
import { createStopCorrectionStore } from '../lib/runtime-v2/stop-correction-store.mjs';
import { taskDirectory } from '../lib/runtime-v2/task-store.mjs';
import { observeKnownOriginalObligations, knownOriginalObligations, knownOriginalObligationReader } from '../lib/runtime-v2/known-original-obligations.mjs';
import { loadPublicToolArgumentsValidator } from '../lib/openclaw/compat-2026.7.1-2.mjs';

async function finish(tools, value) {
  const first = await tools.submit('finish_stop_review', value);
  if (!first.complete) {
    assert(first.pendingKnownOriginalCount > 0);
    return tools.submit('finish_stop_review', value);
  }
  return first;
}

async function fixture(t, { conditional = false, external = false, internal = false, advisory = false, oversized = false, empty = false, title = false, compound = false, distinct = false, third = false, large = false } = {}) {
  const f = await stopProtocolFixture(t, 'findings');
  f.input.request.reviewScope = { kind: 'workspace-stop' }; delete f.input.request.fixedStopClassification;
  f.input.request.classificationContract = 2;
  f.input.request.workflowStages = ['proposal'];
  f.input.request.population.reviewPolicy = resolveStopReviewPolicy({ deviationOnly: true, metrics: { M11: true, M16: true } });
  f.requirement = compound ? 'Preserve stream ordering and run the declared validation command.' : internal ? 'Preserve ordering for empty and non-empty inputs.' : advisory ? 'Consider preserving stream ordering.' : external ? 'If the user later requests publishing, run the release audit.' : conditional ? 'Preserve ordering when streaming is enabled.' : 'Preserve stream ordering.';
  f.secondRequirement = 'Preserve diagnostic labels.';
  f.thirdRequirement = 'Preserve retained segment counts.';
  f.input.evidence.snapshot.entries[0].message.content = title ? `# Stream contract\n${large ? 'Background context. '.repeat(1000) + '\n' : ''}${f.requirement}\n${f.secondRequirement}\n${third ? f.thirdRequirement + '\n' : ''}` : f.requirement;
  const original = await loadStopOriginalRequirements({ projectRoot: f.root, snapshot: f.input.evidence.snapshot });
  f.input.evidence.originalRequirements = original;
  const source = original.userMessages[0];
  const anchor = createOriginalSourceAnchor({ ref: source.ref, sha256: source.sha256, bytes: Buffer.from(source.text), start: 1, end: 1 });
  const directory = path.join(f.root, 'openspec/changes/add-stream');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'proposal.md'), '# Why\n' + f.requirement + '\n');
  await fs.writeFile(path.join(directory, 'tasks.md'), '- [ ] Preserve ordering.\n');
  const snapshot = await readOpenSpecPlan(f.root, 'add-stream');
  f.owner = { projectRoot: f.root, sessionId: 'protocol-host', sessionKey: 'agent:main:s', scopeTaskId: f.input.taskId,
    projectScope: { fingerprint: 'scope' }, nativeRunId: 'proposal-run', reviewController: new AbortController() };
  f.observation = { file: 'openspec/changes/add-stream/tasks.md', sources: original.userMessages,
    receipt: { schemaVersion: 1, runId: 'proposal-run', taskId: f.input.taskId, sessionId: 'protocol-host', scope: snapshot.documents,
      rows: [{ source: anchor, requirement: f.requirement, disposition: 'COVERED', reason: 'Reviewed plan range.',
        targets: [{ ...snapshot.documents[0], start: 1, end: 2 }] }] },
    publication: { runId: 'proposal-run', taskId: f.input.taskId, sessionId: 'protocol-host', result: { status: 'passed',
      metadata: { inputs: snapshot.documents, semanticReview: { status: 'completed' } } } } };
  if (distinct) f.observation.receipt.rows.push({ ...f.observation.receipt.rows[0], requirement: f.secondRequirement });
  if (third) f.observation.receipt.rows.push({ ...f.observation.receipt.rows[0], requirement: f.thirdRequirement });
  if (oversized) { const row = f.observation.receipt.rows[0];
    f.observation.receipt.rows = Array.from({ length: 49 }, (_, index) => ({ ...row, requirement: `${row.requirement} Observation ${index}.` })); }
  if (!empty) assert.equal(await observeKnownOriginalObligations(f.owner, f.observation), true);
  f.owner.nativeRunId = 'apply-run'; f.owner.reviewController = new AbortController();
  f.input.readKnownOriginalObligations = knownOriginalObligationReader(f.owner);
  f.candidate = knownOriginalObligations(f.owner)?.items[0];
  f.candidates = knownOriginalObligations(f.owner)?.items;
  f.production = path.join(f.root, 'stream.mjs');
  await fs.writeFile(f.production, 'export const streaming = true;\nexport const ordered = values => [...values];\n');
  f.prepare = async ({ brief, readAll, read, submit }, { stage = false, include = true, metricId = 'M16', target = 'IMPLEMENTATION', formed = false, currentText = f.requirement, line = title ? 2 : 1 } = {}) => {
    await readAll();
    const originalFile = brief.task.basisFiles.find(file => path.basename(file).startsWith('user-original-0'));
    const originalId = (await read(originalFile)).details.citation.citeId;
    const page = await submit('set_original_checklist', { items: include ? [{ metricId, verificationTarget: target, text: currentText,
      ...(conditional ? { applicability: external ? 'A later user requests publishing.' : 'Streaming is enabled.' } : {}),
      ...(formed ? { knownCandidateId: f.candidate.id, knownDutyReason: 'This original duty line states the complete retained obligation.' } : {}),
      citeId: originalId, lineStart: line, lineEnd: line }] : [],
      scope: { stopClassification: stage ? 'STAGE_COMPLETE' : 'TASK_COMPLETE', ...(stage ? { stage: stage === true ? 'proposal' : stage } : {}), completionClaim: true, limit: 20 } });
    const object = page.items?.find(item => item.description === (formed ? f.requirement : currentText));
    return { originalId, object, originalFile, page };
  };
  return f;
}

for (const mode of ['missing-disposition', 'missing-current-read', 'unacknowledged-read', 'plan-only-proof', 'healthy-current', 'approved-apply-current', 'unobserved-input-branch', 'unconditional-not-applicable', 'unconditional-not-yet-applicable', 'stale-original', 'conditional-active', 'conditional-process-unavailable'])
  test(`known candidate ${mode} uses the actual default Stop protocol`, async t => {
    const conditional = mode.startsWith('conditional-'), f = await fixture(t, { conditional, external: mode === 'conditional-process-unavailable', internal: mode === 'unobserved-input-branch' });
    if (mode === 'approved-apply-current') {
      f.input.evidence.snapshot.entries.push({ type: 'user', uuid: 'U2', message: { content: 'Approved. Apply.' } });
      f.input.evidence.originalRequirements = await loadStopOriginalRequirements({ projectRoot: f.root, snapshot: f.input.evidence.snapshot });
    }
    if (mode === 'stale-original') {
      const message = f.input.evidence.originalRequirements.userMessages[0];
      message.text += ' Revised.'; message.sha256 = sha256(message.text);
    }
    const handle = await f.run(async tools => {
      const { object } = await f.prepare(tools, mode === 'conditional-process-unavailable' ? { metricId: 'M11', target: 'PROCESS' } : {});
      assert(object);
      const row = { id: f.candidate.id, disposition: 'CURRENT', objectId: object.objectId,
        verdict: mode === 'conditional-process-unavailable' || mode === 'unconditional-not-applicable' ? 'NOT_APPLICABLE'
          : mode === 'unconditional-not-yet-applicable' ? 'NOT_YET_APPLICABLE' : 'NO_CONFIRMED_DEVIATION', reason: 'Reviewed the current applicable implementation.' };
      if (!['missing-disposition', 'missing-current-read'].includes(mode)) {
        const source = mode === 'plan-only-proof' ? path.join(f.root, 'openspec/changes/add-stream/proposal.md') : f.production;
        const result = await tools.read(source, { receipt: mode !== 'unacknowledged-read' });
        row.citeIds = [result.details.citation.citeId];
      }
      if (conditional) row.conditionAssessment = { activation: mode === 'conditional-active' ? 'ACTIVE' : 'INACTIVE_AT_CURRENT_BOUNDARY',
        evidenceKind: mode === 'conditional-active' ? 'TARGET_FACTS' : 'PROCESS_WINDOW', reason: 'Current source establishes the original activation facts.' };
      const final = { summary: 'Current assessment complete.',
        ...(mode === 'missing-disposition' ? {} : { knownObligations: [row] }) };
      if (mode === 'stale-original') assert.equal((await tools.submit('finish_stop_review', final)).complete, true,
        'A stale original has no repairable accounting action; preserve U without an impossible retry.');
      else await finish(tools, final);
    });
    const healthy = ['healthy-current', 'approved-apply-current', 'unobserved-input-branch', 'conditional-active'].includes(mode);
    assert.equal(handle.result.knownOriginalCoverage.items[0].disposition, healthy ? 'CURRENT' : 'UNVERIFIED');
    assert.equal(handle.result.unverifiedItems.some(item => item.type === 'KNOWN_ORIGINAL_OBLIGATION'), !healthy);
    assert.equal(handle.result.knownOriginalCoverage.exhaustive, false);
    if (!healthy) assert(handle.result.knownOriginalCoverage.items[0].reason.includes(f.requirement));
    assert.equal(f.input.request.population.reviewPolicy.requireCurrentProductionCoverage, false);
    assert.equal(f.input.request.approvedProposalInventory, undefined);
    await handle.close();
  });

test('empty ordinary route keeps its prior default result shape', async t => {
  const f = await fixture(t, { empty: true });
  const handle = await f.run(async tools => {
    await f.prepare(tools);
    await finish(tools, { summary: 'No confirmed deviation.' });
  });
  assert.equal(handle.result.knownOriginalCoverage, undefined);
  assert.equal(handle.result.unverifiedItems.some(item => item.type === 'KNOWN_ORIGINAL_OBLIGATION'), false);
  await handle.close();
});

test('ordinary appended approval does not erase or stale the known candidate', async t => {
  const f = await fixture(t);
  f.input.evidence.snapshot.entries.push({ type: 'user', uuid: 'U2', message: { content: 'Approved. Apply.' } });
  f.input.evidence.originalRequirements = await loadStopOriginalRequirements({ projectRoot: f.root, snapshot: f.input.evidence.snapshot });
  const handle = await f.run(async tools => {
    await f.prepare(tools);
    await finish(tools, { summary: 'A generic approval alone grants no current assessment.' });
  });
  assert.equal(handle.result.knownOriginalCoverage.items[0].id, f.candidate.id);
  assert.equal(handle.result.knownOriginalCoverage.items[0].disposition, 'UNVERIFIED');
  await handle.close();
});

test('serialized model navigation cannot mint a known-obligation cohort', async t => {
  const f = await fixture(t);
  f.input.evidence.knownOriginalObligations = knownOriginalObligations(f.owner);
  delete f.input.readKnownOriginalObligations;
  const handle = await f.run(async tools => {
    await f.prepare(tools);
    await finish(tools, { summary: 'No host authority was supplied.' });
  });
  assert.equal(handle.result.knownOriginalCoverage, undefined);
  await handle.close();
});

test('missing-accounting feedback lets the same worker supply fresh proof within its existing run', async t => {
  const f = await fixture(t);
  const handle = await f.run(async tools => {
    const { object } = await f.prepare(tools);
    const pending = await tools.submit('finish_stop_review', { summary: 'Initial scan.' });
    assert.equal(pending.complete, false);
    assert.equal(pending.pendingKnownOriginals[0].id, f.candidate.id);
    const current = (await tools.read(f.production)).details.citation.citeId;
    const complete = await tools.submit('finish_stop_review', { summary: 'Current evidence now supplied.', knownObligations: [
      { id: f.candidate.id, disposition: 'CURRENT', objectId: object.objectId, verdict: 'NO_CONFIRMED_DEVIATION',
        reason: 'Current source preserves the ordering obligation.', citeIds: [current] }] });
    assert.equal(complete.complete, true);
  });
  assert.equal(f.calls.length, 1);
  assert.equal(handle.result.unverifiedItems.length, 0);
  await handle.close();
});

for (const malformed of ['unknown', 'duplicate']) test(`known ${malformed} identities cannot finish`, async t => {
  const f = await fixture(t);
  const handle = await f.run(async tools => {
    await f.prepare(tools);
    const row = { id: malformed === 'unknown' ? 'foreign-known-id' : f.candidate.id,
      disposition: 'UNVERIFIED', reason: 'Explicit uncertainty.' };
    await assert.rejects(tools.submit('finish_stop_review', { summary: 'Rejected identity accounting.',
      knownObligations: malformed === 'duplicate' ? [row, row] : [row] }), { code: 'KNOWN_ORIGINAL_DISPOSITION_INVALID' });
    await finish(tools, { summary: 'Honest uncertainty.', knownObligations: [
      { id: f.candidate.id, disposition: 'UNVERIFIED', reason: 'Current evidence is incomplete.' }] });
  });
  assert.equal(handle.result.knownOriginalCoverage.items[0].disposition, 'UNVERIFIED');
  await handle.close();
});

test('a new first cohort during Stop invalidates the old empty capture', async t => {
  const f = await fixture(t, { empty: true });
  await assert.rejects(f.run(async tools => {
    await f.prepare(tools);
    const value = structuredClone(f.observation);
    value.publication.runId = 'apply-run'; value.receipt.runId = 'apply-run';
    assert.equal(await observeKnownOriginalObligations(f.owner, value), true);
    await tools.submit('finish_stop_review', { summary: 'An old empty capture cannot accept the new cohort.' });
  }), { code: 'STOP_TASK_INPUT_CHANGED' });
});

test('foreign task ownership cannot import an otherwise valid observation cohort', async t => {
  const f = await fixture(t);
  const reader = f.input.readKnownOriginalObligations;
  f.input.readKnownOriginalObligations = () => { const cohort = reader();
    return { ...cohort, owner: { ...cohort.owner, taskId: 'foreign-task' } }; };
  await assert.rejects(f.run(async () => assert.fail('No worker may start with foreign observation ownership.')),
    { code: 'STOP_TASK_INPUT_CHANGED' });
});

for (const stage of [true, false]) test(`known implementation phase deferral ${stage ? 'matches actual planning scope' : 'cannot exclude task completion'}`, async t => {
  const f = await fixture(t);
  const handle = await f.run(async tools => {
    await f.prepare(tools, { stage });
    const page = await tools.submit('review_checklist', { offset: 0, limit: 5 });
    const binding = page.knownObligations.items[0].bindings[0];
    assert.equal(binding.selected, !stage);
    await finish(tools, { summary: 'Original duty retains its phase.', knownObligations: [{ id: f.candidate.id,
      disposition: 'PHASE_DEFERRED', objectId: binding.objectId, reason: 'Implementation belongs to the subsequent implementation phase.' }] });
  });
  assert.equal(handle.result.knownOriginalCoverage.items[0].disposition, stage ? 'PHASE_DEFERRED' : 'UNVERIFIED');
  await handle.close();
});

for (const superseded of [false, true]) test(`explicit ${superseded ? 'later user amendment' : 'nonbinding interpretation'} needs current original evidence`, async t => {
  const f = await fixture(t, { advisory: !superseded });
  if (superseded) {
    f.input.evidence.snapshot.entries.push({ type: 'user', uuid: 'U2', message: { content: 'Change the requirement: order may now be sorted.' } });
    f.input.evidence.originalRequirements = await loadStopOriginalRequirements({ projectRoot: f.root, snapshot: f.input.evidence.snapshot });
  }
  const handle = await f.run(async tools => {
    const { originalId } = await f.prepare(tools, { include: superseded });
    const later = superseded ? tools.brief.task.basisFiles.find(file => path.basename(file).startsWith('user-original-1')) : null;
    const citeId = later ? (await tools.read(later)).details.citation.citeId : originalId;
    await finish(tools, { summary: 'Current semantic interpretation is explicit.', knownObligations: [{ id: f.candidate.id,
      disposition: superseded ? 'SUPERSEDED' : 'NOT_BINDING', reason: 'Current original evidence supports this explicit interpretation.', citeIds: [citeId] }] });
  });
  assert.equal(handle.result.knownOriginalCoverage.items[0].interpretation, 'REVIEWER_SOURCE_GROUNDED');
  assert.equal(handle.result.unverifiedItems.length, 0);
  await handle.close();
});

for (const mode of ['missing', 'checked', 'over-limit', 'corroborated', 'corroborated-missing']) test(`actual host settlement ${mode}`, async t => {
  const checked = ['checked', 'corroborated'].includes(mode), corroborated = mode.startsWith('corroborated');
  const f = await fixture(t, { oversized: mode === 'over-limit', title: corroborated }), transcript = path.join(f.root, 'session.jsonl');
  await fs.writeFile(transcript, f.input.evidence.snapshot.entries.map(JSON.stringify).join('\n') + '\n');
  const runtimeV2 = compileRuntimeV2Config({ version: 2, dynamicGroundTruth: { enabled: false },
    stopCorrection: { enabled: true, originalRequirementsBasis: true, deviationOnly: true } });
  const reader = f.input.readKnownOriginalObligations;
  const reviewerFactory = input => {
    Object.assign(f.input, input);
    return f.run(async tools => {
      const { object } = await f.prepare(tools, { formed: corroborated, ...(corroborated ? { currentText: 'A model paraphrase.' } : {}) });
      const citeId = checked ? (await tools.read(f.production)).details.citation.citeId : null;
      const final = { summary: 'The host receives explicit current evidence or unresolved retention.',
        ...(checked ? { knownObligations: [{ id: f.candidate.id, disposition: 'CURRENT', objectId: object.objectId,
          verdict: 'NO_CONFIRMED_DEVIATION', reason: 'Current production source retains the original order.', citeIds: [citeId] }] } : {}) };
      if (mode === 'over-limit') assert.equal((await tools.submit('finish_stop_review', final)).complete, true,
        'Unsupported retention remains U directly; no candidate IDs exist for a repair turn.');
      else await finish(tools, final);
    });
  };
  reviewerFactory.supportsStopTasks = true;
  const event = hook_event_name => handleRuntimeV2Event({ projectRoot: f.root, plan: { runtimeV2, artifacts: [] }, reviewerFactory,
    stopHost: { directory: path.join(f.root, 'host'), stopId: 'known-stop', startProtocol: { version: 1 }, readKnownOriginalObligations: reader }, input: { hook_event_name, session_id: 'protocol-host', cwd: f.root,
      transcript_path: transcript, prompt: f.requirement, last_assistant_message: 'The implementation is complete.' } });
  await event('SessionStart');
  await createStopCorrectionStore({ directory: path.join(f.root, 'host') }).initializeSession({ sessionId: 'protocol-host',
    initialize: { kind: 'NEW_SESSION', evidence: { fixture: true } } });
  await event('UserPromptSubmit');
  const result = await event('Stop');
  assert.equal(result.stop.status, checked ? 'NO_DEVIATION_FOUND' : 'UNVERIFIED', JSON.stringify(result.stop));
  assert.equal(result.stop.review.knownOriginalCoverage.items.length, 1);
  if (!checked) assert.equal(result.stop.reasonCode, 'STOP_KNOWN_ORIGINAL_OBLIGATION_UNVERIFIED');
  const saved = JSON.parse(await fs.readFile(path.join(taskDirectory(f.root, f.input.taskId), 'task.json'), 'utf8'));
  assert.equal(saved.verification.status, checked ? 'NO_DEVIATION_FOUND' : 'UNVERIFIED');
  assert.equal(runtimeV2.stopCorrection.requireCurrentProductionCoverage, false);
});

test('same-stop cached acceptance cannot bypass a newly admitted host cohort', async t => {
  const f = await fixture(t, { empty: true }), transcript = path.join(f.root, 'session.jsonl');
  await fs.writeFile(transcript, f.input.evidence.snapshot.entries.map(JSON.stringify).join('\n') + '\n');
  const runtimeV2 = compileRuntimeV2Config({ version: 2, dynamicGroundTruth: { enabled: false },
    stopCorrection: { enabled: true, originalRequirementsBasis: true, deviationOnly: true } });
  let calls = 0;
  const reviewerFactory = input => {
    calls++; Object.assign(f.input, input);
    return f.run(async tools => { await f.prepare(tools); await finish(tools, { summary: 'Original empty known-minimum route.' }); });
  };
  reviewerFactory.supportsStopTasks = true;
  const host = { directory: path.join(f.root, 'host'), stopId: 'cached-known-stop', startProtocol: { version: 1 },
    readKnownOriginalObligations: f.input.readKnownOriginalObligations };
  const event = hook_event_name => handleRuntimeV2Event({ projectRoot: f.root, plan: { runtimeV2, artifacts: [] }, reviewerFactory,
    stopHost: host, input: { hook_event_name, session_id: 'protocol-host', cwd: f.root, transcript_path: transcript,
      prompt: f.requirement, last_assistant_message: 'The implementation is complete.' } });
  await event('SessionStart');
  await createStopCorrectionStore({ directory: host.directory }).initializeSession({ sessionId: 'protocol-host',
    initialize: { kind: 'NEW_SESSION', evidence: { fixture: true } } });
  await event('UserPromptSubmit');
  const first = await event('Stop');
  assert.equal(first.stop.status, 'NO_DEVIATION_FOUND');
  const evaluation = path.join(taskDirectory(f.root, f.input.taskId), 'evaluations', `${first.stop.evaluationId}.json`);
  const historical = await fs.readFile(evaluation);
  const observation = structuredClone(f.observation);
  observation.receipt.runId = 'apply-run'; observation.publication.runId = 'apply-run';
  assert.equal(await observeKnownOriginalObligations(f.owner, observation), true);
  host.readKnownOriginalObligations = knownOriginalObligationReader(f.owner);
  const second = await event('Stop');
  assert.equal(second.stop.reused, true);
  assert.equal(second.stop.status, 'UNVERIFIED');
  assert.equal(second.stop.reasonCode, 'STOP_REVIEW_STALE');
  assert.equal(calls, 1, 'Existing stale-cache behavior preserves history rather than dispatching a new review implicitly.');
  assert.deepEqual(await fs.readFile(evaluation), historical);
  const saved = JSON.parse(await fs.readFile(path.join(taskDirectory(f.root, f.input.taskId), 'task.json'), 'utf8'));
  assert.equal(saved.verification.status, 'UNVERIFIED');
});

const knownCurrent = (f, object, citeIds, extra = {}) => ({ id: f.candidate.id, disposition: 'CURRENT',
  objectId: object.objectId, verdict: 'NO_CONFIRMED_DEVIATION', reason: 'Reviewed the complete retained duty against current evidence.', citeIds, ...extra });

test('host knownCandidateId keeps the whole duty while associating an acknowledged atomic source span', async t => {
  const f = await fixture(t, { title: true });
  const handle = await f.run(async tools => {
    const { object } = await f.prepare(tools, { formed: true, currentText: 'Return records in arrival order.' });
    assert.equal(object.description, f.requirement);
    assert.notEqual(object.originalSourceAnchor.anchorId, f.candidate.source.anchorId);
    const source = (await tools.read(f.production)).details.citation.citeId;
    await finish(tools, { summary: 'Current full-duty proof.', knownObligations: [knownCurrent(f, object, [source])] });
  });
  const row = handle.result.knownOriginalCoverage.items[0];
  assert.equal(row.disposition, 'CURRENT'); assert.equal(row.association.requirement, f.requirement);
  assert.equal(row.association.kind, 'REVIEWER_ASSERTED_DUTY_CORRESPONDENCE');
  assert.notEqual(row.association.retainedSource.anchorId, row.association.corroboratingSource.anchorId);
  assert.deepEqual(row.association.proofSubject.proofOwners, ['SOURCE']);
  assert.equal(handle.result.unverifiedItems.length, 0); await handle.close();
});

test('finish corroboration repairs a frozen paraphrase in the same worker without rebuilding the checklist', async t => {
  const f = await fixture(t, { title: true });
  const handle = await f.run(async tools => {
    const { object, originalId } = await f.prepare(tools, { currentText: 'Return records in arrival order.' });
    const directory = path.dirname(path.dirname(tools.brief.task.basisFiles.find(file => path.basename(file).startsWith('known-original-observations'))));
    const before = await fs.readFile(path.join(directory, 'original-checklist.json'));
    const source = (await tools.read(f.production)).details.citation.citeId;
    const pending = await tools.submit('finish_stop_review', { summary: 'Initial accounting.', knownObligations: [knownCurrent(f, object, [source])] });
    assert.equal(pending.complete, false); assert.equal(pending.pendingKnownOriginalCount, 1);
    const result = await tools.submit('finish_stop_review', { summary: 'Explicit current duty correspondence.', knownObligations: [
      knownCurrent(f, object, [source], { corroboration: { citeId: originalId, start: 2, end: 2,
        reason: 'This original atomic duty is the full retained ordering requirement.' } })] });
    assert.equal(result.complete, true);
    assert.deepEqual(await fs.readFile(path.join(directory, 'original-checklist.json')), before);
  });
  const row = handle.result.knownOriginalCoverage.items[0]; assert.equal(row.disposition, 'CURRENT');
  assert.equal(row.association.requirement, f.requirement); assert.equal(f.calls.length, 1);
  await handle.close();
});

for (const mode of ['same-message-only', 'wrong-current-span', 'missing-current-proof', 'plan-only-proof', 'unacknowledged-original', 'conditional-without-assessment', 'unconditional-exclusion'])
  test(`explicit known duty association ${mode} cannot manufacture a clean assessment`, async t => {
    const f = await fixture(t, { title: true, conditional: mode === 'conditional-without-assessment' });
    const handle = await f.run(async tools => {
      const { object, originalId, originalFile } = await f.prepare(tools, { currentText: 'A shorter model description.' });
      let original = originalId;
      if (mode === 'unacknowledged-original') original = (await tools.read(originalFile, { receipt: false })).details.citation.citeId;
      const source = mode === 'missing-current-proof' ? null : (await tools.read(mode === 'plan-only-proof'
        ? path.join(f.root, 'openspec/changes/add-stream/proposal.md') : f.production)).details.citation.citeId;
      const row = knownCurrent(f, object, source ? [source] : [], {
        ...(mode === 'same-message-only' ? {} : { corroboration: { citeId: original,
          start: mode === 'wrong-current-span' ? 3 : 2, end: mode === 'wrong-current-span' ? 3 : 2,
          reason: 'Explicit claimed duty correspondence, not a proof by source identity.' } }),
        ...(mode === 'unconditional-exclusion' ? { verdict: 'NOT_APPLICABLE' } : {}) });
      await finish(tools, { summary: 'Preserve uncertainty.', knownObligations: [row] });
    });
    assert.equal(handle.result.knownOriginalCoverage.items[0].disposition, 'UNVERIFIED');
    assert(handle.result.unverifiedItems.some(item => item.type === 'KNOWN_ORIGINAL_OBLIGATION'));
    await handle.close();
  });

for (const invalid of ['unknown-id', 'duplicate-id', 'missing-reason', 'path-without-ack'])
  test(`invalid formed association ${invalid} is rejected before freeze and the same worker can correct it`, async t => {
    const f = await fixture(t, { title: true });
    const handle = await f.run(async tools => {
      await tools.readAll();
      const file = tools.brief.task.basisFiles.find(value => path.basename(value).startsWith('user-original-0'));
      const originalId = (await tools.read(file)).details.citation.citeId;
      const item = { metricId: 'M16', verificationTarget: 'IMPLEMENTATION', text: 'A narrow paraphrase.',
        knownCandidateId: invalid === 'unknown-id' ? 'foreign-known-candidate' : f.candidate.id,
        ...(invalid === 'missing-reason' ? {} : { knownDutyReason: 'The full retained duty is supported by this original line.' }),
        ...(invalid === 'path-without-ack' ? { path: file } : { citeId: originalId }), lineStart: 2, lineEnd: 2 };
      await assert.rejects(tools.submit('set_original_checklist', { items: invalid === 'duplicate-id' ? [item, item] : [item] }),
        { code: 'KNOWN_ORIGINAL_BINDING_INVALID' });
      const { object } = await f.prepare(tools, { formed: true });
      const source = (await tools.read(f.production)).details.citation.citeId;
      await finish(tools, { summary: 'Corrected before scope freeze.', knownObligations: [knownCurrent(f, object, [source])] });
    });
    assert.equal(handle.result.knownOriginalCoverage.items[0].disposition, 'CURRENT'); await handle.close();
  });

test('an identical original message under a foreign user ref cannot corroborate the retained duty', async t => {
  const f = await fixture(t, { title: true });
  f.input.evidence.snapshot.entries.push({ type: 'user', uuid: 'U2', message: { content: f.input.evidence.snapshot.entries[0].message.content } });
  f.input.evidence.originalRequirements = await loadStopOriginalRequirements({ projectRoot: f.root, snapshot: f.input.evidence.snapshot });
  const handle = await f.run(async tools => {
    const { object } = await f.prepare(tools, { currentText: 'A shorter model description.' });
    const foreign = tools.brief.task.basisFiles.find(file => path.basename(file).startsWith('user-original-1'));
    const original = (await tools.read(foreign)).details.citation.citeId;
    const source = (await tools.read(f.production)).details.citation.citeId;
    await finish(tools, { summary: 'Source identity remains distinct.', knownObligations: [knownCurrent(f, object, [source], {
      corroboration: { citeId: original, start: 2, end: 2, reason: 'A same-hash later message cannot replace the retained source.' } })] });
  });
  assert.equal(handle.result.knownOriginalCoverage.items[0].disposition, 'UNVERIFIED'); await handle.close();
});

test('canonical compound duty is not narrowed to source-only proof when its declared full subject requires execution', async t => {
  const f = await fixture(t, { title: true, compound: true });
  const handle = await f.run(async tools => {
    const { object } = await f.prepare(tools, { formed: true, currentText: 'Preserve stream ordering.', metricId: 'M12', target: 'PROCESS' });
    assert.equal(object.description, f.requirement); assert.equal(object.verificationTarget, 'PROCESS');
    const source = (await tools.read(f.production)).details.citation.citeId;
    await finish(tools, { summary: 'Source code is only part of this compound duty.', knownObligations: [knownCurrent(f, object, [source])] });
  });
  const row = handle.result.knownOriginalCoverage.items[0]; assert.equal(row.disposition, 'UNVERIFIED');
  assert.equal(row.association.requirement, f.requirement); assert.deepEqual(row.association.proofSubject.proofOwners, ['PROCESS']);
  await handle.close();
});

for (const saved of ['DEVIATION', 'UNVERIFIED']) test(`finish association cannot erase an already saved ${saved}`, async t => {
  const f = await fixture(t, { title: true });
  if (saved === 'DEVIATION') await fs.writeFile(f.production, 'export const ordered = values => values.reverse();\n');
  const handle = await f.run(async tools => {
    const { object, originalId } = await f.prepare(tools, { currentText: 'Return records in arrival order.' });
    const source = (await tools.read(f.production)).details.citation.citeId;
    await tools.submit('submit_review', { taskId: object.objectId, verdict: saved,
      reason: saved === 'DEVIATION' ? 'Current code reverses the required order.' : 'A required current dependency remains unavailable.', citeIds: [source] });
    await finish(tools, { summary: 'An association is not a saved-result override.', knownObligations: [knownCurrent(f, object, [source], {
      corroboration: { citeId: originalId, start: 2, end: 2, reason: 'This is the full original ordering duty.' } })] });
  });
  assert.equal(handle.result.knownOriginalCoverage.items[0].disposition, 'UNVERIFIED');
  assert(handle.result.metricObjectJudgements.some(row => row.judgement === saved)); await handle.close();
});

for (const collision of [false, true]) test(`distinct same-message duties ${collision ? 'cannot borrow one formed object' : 'retain separate host ID accounting'}`, async t => {
  const f = await fixture(t, { title: true, distinct: true });
  const handle = await f.run(async tools => {
    await tools.readAll();
    const file = tools.brief.task.basisFiles.find(value => path.basename(value).startsWith('user-original-0'));
    const originalId = (await tools.read(file)).details.citation.citeId;
    const page = await tools.submit('set_original_checklist', { items: f.candidates.map((candidate, index) => ({
      metricId: 'M16', verificationTarget: 'IMPLEMENTATION', text: 'A model paraphrase.', knownCandidateId: candidate.id,
      knownDutyReason: 'This distinct current original line supports the whole named candidate.',
      citeId: originalId, lineStart: index + 2, lineEnd: index + 2 })),
      scope: { stopClassification: 'TASK_COMPLETE', completionClaim: true, limit: 20 } });
    const objects = f.candidates.map(candidate => page.items.find(value => value.description === candidate.requirement));
    assert.notEqual(objects[0].objectId, objects[1].objectId);
    const source = (await tools.read(f.production)).details.citation.citeId;
    const rows = f.candidates.map((candidate, index) => ({ id: candidate.id, disposition: 'CURRENT',
      objectId: objects[collision ? 0 : index].objectId, verdict: 'NO_CONFIRMED_DEVIATION',
      reason: 'Explicit separate current duty assessment.', citeIds: [source] }));
    if (collision) {
      await assert.rejects(tools.submit('finish_stop_review', { summary: 'Rejected cross-ID borrowing.', knownObligations: rows }),
        { code: 'KNOWN_ORIGINAL_BINDING_INVALID' });
      await finish(tools, { summary: 'The remaining candidate stays visible.', knownObligations: [rows[0],
        { id: f.candidates[1].id, disposition: 'UNVERIFIED', reason: 'No separate current assessment supplied.' }] });
    } else await finish(tools, { summary: 'Both IDs independently assessed.', knownObligations: rows });
  });
  assert.equal(handle.result.knownOriginalCoverage.items.length, 2);
  assert.deepEqual(handle.result.knownOriginalCoverage.items.map(value => value.disposition), collision ? ['CURRENT', 'UNVERIFIED'] : ['CURRENT', 'CURRENT']);
  await handle.close();
});

test('a fresh source hash does not make an old retained anchor current', async t => {
  const f = await fixture(t, { title: true });
  const message = f.input.evidence.originalRequirements.userMessages[0];
  message.text += 'An actual later amendment.\n'; message.sha256 = sha256(message.text);
  const handle = await f.run(async tools => {
    await assert.rejects(f.prepare(tools, { formed: true }), { code: 'KNOWN_ORIGINAL_BINDING_INVALID' });
    await f.prepare(tools);
    const complete = await tools.submit('finish_stop_review', { summary: 'Stale retained source remains unverified.' });
    assert.equal(complete.complete, true);
  });
  assert.equal(handle.result.knownOriginalCoverage.items[0].disposition, 'UNVERIFIED'); await handle.close();
});

test('corroborating original bytes remain part of final source freshness validation', async t => {
  const f = await fixture(t, { title: true });
  await assert.rejects(f.run(async tools => {
    const { object, originalFile } = await f.prepare(tools, { formed: true });
    const source = (await tools.read(f.production)).details.citation.citeId;
    await fs.appendFile(originalFile, '\nChanged after acknowledged association.');
    await tools.submit('finish_stop_review', { summary: 'Cannot seal stale current correspondence.', knownObligations: [knownCurrent(f, object, [source])] });
  }), error => /INPUT_CHANGED|STALE/u.test(error.code));
});

test('formed association alone never supplies a current verdict', async t => {
  const f = await fixture(t, { title: true });
  const handle = await f.run(async tools => {
    await f.prepare(tools, { formed: true });
    await finish(tools, { summary: 'Association is not proof or a verdict.' });
  });
  assert.equal(handle.result.knownOriginalCoverage.items[0].disposition, 'UNVERIFIED'); await handle.close();
});

test('formed canonical implementation duty can remain explicitly phase deferred', async t => {
  const f = await fixture(t, { title: true });
  const handle = await f.run(async tools => {
    const { page } = await f.prepare(tools, { formed: true, stage: true });
    const binding = page.knownObligations.items[0].formedAssociation;
    assert(binding.objectId);
    await finish(tools, { summary: 'Implementation is outside this actual Proposal stage.', knownObligations: [
      { id: f.candidate.id, disposition: 'PHASE_DEFERRED', objectId: binding.objectId,
        reason: 'This recognized Proposal stage excludes implementation review.' }] });
  });
  assert.equal(handle.result.knownOriginalCoverage.items[0].disposition, 'PHASE_DEFERRED'); await handle.close();
});

test('known source corroboration preserves actual chunk byte offsets instead of treating a part hash as the whole source', async t => {
  const f = await fixture(t, { title: true, large: true });
  const handle = await f.run(async tools => {
    await tools.readAll();
    const parts = tools.brief.task.basisFiles.filter(file => path.basename(file).startsWith('user-original-0'));
    assert(parts.length > 1);
    let original, localLine;
    for (const file of parts) {
      const text = await fs.readFile(file, 'utf8'), index = text.split('\n').indexOf(f.requirement);
      if (index >= 0) { original = (await tools.read(file)).details.citation.citeId; localLine = index + 1; break; }
    }
    const page = await tools.submit('set_original_checklist', { items: [{ metricId: 'M16', verificationTarget: 'IMPLEMENTATION',
      text: 'A shorter wording.', knownCandidateId: f.candidate.id, knownDutyReason: 'The complete duty is on this current part-local line.',
      citeId: original, lineStart: localLine, lineEnd: localLine }],
      scope: { stopClassification: 'TASK_COMPLETE', completionClaim: true, limit: 20 } });
    const object = page.items.find(item => item.description === f.requirement);
    assert(object.originalSourceAnchor.byteStart > 16384);
    assert.equal(object.originalSourceAnchor.sha256, f.candidate.source.sha256);
    const source = (await tools.read(f.production)).details.citation.citeId;
    await finish(tools, { summary: 'Current duty retains global original-source identity.', knownObligations: [knownCurrent(f, object, [source])] });
  });
  assert.equal(handle.result.knownOriginalCoverage.items[0].disposition, 'CURRENT'); await handle.close();
});

test('formed conditional duty retains its original condition assessment contract', async t => {
  const f = await fixture(t, { title: true, conditional: true });
  const handle = await f.run(async tools => {
    const { object } = await f.prepare(tools, { formed: true, currentText: 'Preserve ordering.' });
    const source = (await tools.read(f.production)).details.citation.citeId;
    await finish(tools, { summary: 'Current full condition is explicitly active.', knownObligations: [knownCurrent(f, object, [source], {
      conditionAssessment: { activation: 'ACTIVE', evidenceKind: 'TARGET_FACTS', reason: 'The current source explicitly enables streaming.' } })] });
  });
  const row = handle.result.knownOriginalCoverage.items[0];
  assert.equal(row.disposition, 'CURRENT'); assert.equal(row.association.proofSubject.applicabilityKind, 'CONDITIONAL');
  assert.equal(row.association.requirement, f.requirement); await handle.close();
});

test('a fresh canonical known item cannot erase a delivered carried deviation with another frozen object ID', async t => {
  const f = await fixture(t, { title: true }), transcript = path.join(f.root, 'session.jsonl');
  await fs.writeFile(f.production, 'export const ordered = values => values.reverse();\n');
  await fs.writeFile(transcript, f.input.evidence.snapshot.entries.map(JSON.stringify).join('\n') + '\n');
  const runtimeV2 = compileRuntimeV2Config({ version: 2, dynamicGroundTruth: { enabled: false },
    stopCorrection: { enabled: true, originalRequirementsBasis: true, deviationOnly: true } });
  const reader = f.input.readKnownOriginalObligations; let phase = 1, oldId, freshId;
  const reviewerFactory = input => { Object.assign(f.input, input); return f.run(async tools => {
    const { object, originalId, page } = await f.prepare(tools, { formed: phase === 2,
      currentText: phase === 1 ? 'Return records in arrival order.' : 'A different model shorthand.' });
    const source = (await tools.read(f.production)).details.citation.citeId;
    if (phase === 1) {
      oldId = object.objectId;
      await tools.submit('submit_review', { taskId: oldId, verdict: 'DEVIATION', reason: 'The current reverse operation violates ordering.', citeIds: [source] });
    } else {
      freshId = object.objectId; assert.notEqual(freshId, oldId);
      assert(page.items.some(item => item.objectId === oldId && item.previousDeviation), 'The original delivered deviation remains carried.');
    }
    await finish(tools, { summary: 'Known association cannot stand in for prior-deviation closure.', knownObligations: [
      knownCurrent(f, object, [source], phase === 1 ? { verdict: 'DEVIATION',
        corroboration: { citeId: originalId, start: 2, end: 2, reason: 'The same full ordering duty has this current atomic source.' } } : {})] });
  }); };
  reviewerFactory.supportsStopTasks = true;
  const event = name => handleRuntimeV2Event({ projectRoot: f.root, plan: { runtimeV2, artifacts: [] }, reviewerFactory,
    stopHost: { directory: path.join(f.root, 'host'), stopId: `carry-known-${phase}`, startProtocol: { version: 1 }, readKnownOriginalObligations: reader },
    input: { hook_event_name: name, session_id: 'protocol-host', cwd: f.root, transcript_path: transcript,
      prompt: f.requirement, last_assistant_message: 'The implementation is complete.' } });
  await event('SessionStart');
  await createStopCorrectionStore({ directory: path.join(f.root, 'host') }).initializeSession({ sessionId: 'protocol-host', initialize: { kind: 'NEW_SESSION', evidence: { fixture: true } } });
  await event('UserPromptSubmit');
  const first = await event('Stop'); assert.equal(first.stop.status, 'DEVIATION');
  phase = 2;
  await fs.appendFile(transcript, JSON.stringify({ type: 'assistant', uuid: 'A2', message: { content: 'A later completion claim.' } }) + '\n');
  const second = await event('Stop'); assert.notEqual(second.stop.status, 'NO_DEVIATION_FOUND');
  assert(freshId, 'The second actual host assessment ran and created the distinct canonical item.');
  const saved = JSON.parse(await fs.readFile(path.join(taskDirectory(f.root, f.input.taskId), 'task.json'), 'utf8'));
  assert(Object.values(saved.deviations).some(family => family.status === 'OPEN'));
});

test('finish repair cannot replace a formed whole-duty PROCESS subject with a narrower SOURCE item', async t => {
  const f = await fixture(t, { title: true, compound: true });
  const handle = await f.run(async tools => {
    await tools.readAll();
    const file = tools.brief.task.basisFiles.find(value => path.basename(value).startsWith('user-original-0'));
    const originalId = (await tools.read(file)).details.citation.citeId;
    const sourceItem = { metricId: 'M16', verificationTarget: 'IMPLEMENTATION', text: 'Preserve stream ordering.',
      citeId: originalId, lineStart: 2, lineEnd: 2 };
    const page = await tools.submit('set_original_checklist', { items: [
      { ...sourceItem, metricId: 'M12', verificationTarget: 'PROCESS', knownCandidateId: f.candidate.id,
        knownDutyReason: 'The complete retained duty includes the declared validation execution.' }, sourceItem],
      scope: { stopClassification: 'TASK_COMPLETE', completionClaim: true, limit: 20 } });
    const narrowed = page.items.find(item => item.metricId === 'M16');
    const source = (await tools.read(f.production)).details.citation.citeId;
    await finish(tools, { summary: 'A shorter source-only subject cannot replace the formed duty.', knownObligations: [knownCurrent(f, narrowed, [source], {
      corroboration: { citeId: originalId, start: 2, end: 2, reason: 'Claimed correspondence cannot change the formed proof subject.' } })] });
  });
  const row = handle.result.knownOriginalCoverage.items[0]; assert.equal(row.disposition, 'UNVERIFIED');
  assert.match(row.reason, /formed object/u); await handle.close();
});

async function checkedRun(f, script) {
  let failure, completed = false;
  const handle = await f.run(async tools => {
    try { await script(tools); completed = true; }
    catch (error) { failure = error; throw error; }
  });
  if (failure) { await handle.close(); throw failure; }
  assert.equal(completed, true, 'The actual handler callback must reach its final assertions.');
  return handle;
}

async function sdkFinish(tools, value) {
  const sdk = await loadPublicToolArgumentsValidator(), tool = tools.tools.get('finish_stop_review');
  const before = structuredClone(value), accepted = sdk.validateToolArguments(tool, { name: tool.name, arguments: value });
  assert.deepEqual(value, before, 'Public argument validation preserves the submitted factual fields.');
  return tools.submit(tool.name, accepted);
}

for (const formed of [false, true]) test(`known missing objectId returns actual host IDs before ${formed ? 'formed' : 'corroborated'} same-worker repair`, async t => {
  const f = await fixture(t, { title: true });
  const handle = await checkedRun(f, async tools => {
    const { object, originalId } = await f.prepare(tools, { formed, currentText: 'Return records in arrival order.' });
    const source = (await tools.read(f.production)).details.citation.citeId;
    const row = { id: f.candidate.id, disposition: 'CURRENT', verdict: 'NO_CONFIRMED_DEVIATION',
      reason: 'Current source establishes the complete retained ordering duty.', citeIds: [source],
      ...(!formed ? { corroboration: { citeId: originalId, start: 2, end: 2,
        reason: 'This exact current original span states the entire retained ordering duty.' } } : {}) };
    const pending = await sdkFinish(tools, { summary: 'Initial current accounting omits its object identity.', knownObligations: [row] });
    assert.equal(pending.complete, false); assert.equal(pending.pendingKnownOriginalCount, 1);
    assert.equal(pending.pendingKnownOriginals[0].diagnostic.code, 'KNOWN_ORIGINAL_OBJECT_REQUIRED');
    assert.deepEqual(pending.pendingKnownOriginals[0].diagnostic.missingFields, ['objectId']);
    assert.equal(pending.currentOriginalObjects.navigationOnly, true);
    assert.equal(pending.currentOriginalObjects.associationsInferred, false);
    const hostObject = pending.currentOriginalObjects.items.find(item => item.objectId === object.objectId);
    assert(hostObject, 'Repair feedback exposes the actual selected object ID, not a guessed candidate alias.');
    assert.equal(hostObject.knownCandidateId, formed ? f.candidate.id : undefined);
    assert(pending.currentOriginalObjects.items.length <= 5);
    assert(Buffer.byteLength(JSON.stringify(pending.currentOriginalObjects.items)) <= 1801);
    assert.match(pending.instruction, /every CURRENT row.*objectId/u);
    const final = await sdkFinish(tools, { summary: 'Explicit actual host object and current proof supplied.',
      knownObligations: [{ ...row, objectId: hostObject.objectId }] });
    assert.equal(final.complete, true);
  });
  assert.equal(handle.result.knownOriginalCoverage.items[0].disposition, 'CURRENT');
  assert.equal(handle.result.unverifiedItems.length, 0); assert.equal(f.calls.length, 1);
  await handle.close();
});

for (const invalid of ['missing-id', 'foreign-id', 'missing-proof']) test(`known object guidance cannot manufacture ${invalid} authority`, async t => {
  const f = await fixture(t);
  const handle = await checkedRun(f, async tools => {
    const { object } = await f.prepare(tools, { formed: true });
    const current = (await tools.read(f.production)).details.citation.citeId;
    const row = { id: f.candidate.id, disposition: 'CURRENT', verdict: 'NO_CONFIRMED_DEVIATION',
      reason: 'Only actual source and identity may establish this assessment.',
      ...(invalid === 'missing-id' ? {} : { objectId: invalid === 'foreign-id' ? 'M16:foreign-object' : object.objectId }),
      ...(invalid === 'missing-proof' ? {} : { citeIds: [current] }) };
    assert.equal((await sdkFinish(tools, { summary: 'First incomplete assessment.', knownObligations: [row] })).complete, false);
    assert.equal((await sdkFinish(tools, { summary: 'The unresolved assessment remains honest.', knownObligations: [row] })).complete, true);
  });
  assert.equal(handle.result.knownOriginalCoverage.items[0].disposition, 'UNVERIFIED');
  assert.equal(f.calls.length, 1); await handle.close();
});

test('known SUPERSEDED omits current-duty fields and cannot borrow CURRENT association authority', async t => {
  const f = await fixture(t);
  f.input.evidence.snapshot.entries.push({ type: 'user', uuid: 'U2', message: { content: 'Change the original requirement: ordering is no longer required.' } });
  f.input.evidence.originalRequirements = await loadStopOriginalRequirements({ projectRoot: f.root, snapshot: f.input.evidence.snapshot });
  const handle = await checkedRun(f, async tools => {
    const { originalId } = await f.prepare(tools);
    const later = tools.brief.task.basisFiles.find(file => path.basename(file).startsWith('user-original-1'));
    const source = (await tools.read(later)).details.citation.citeId;
    const row = { id: f.candidate.id, disposition: 'SUPERSEDED', reason: 'The later original user amendment replaces this duty.', citeIds: [source] };
    await assert.rejects(sdkFinish(tools, { summary: 'Current-duty corroboration is not exclusion proof.', knownObligations: [{ ...row,
      corroboration: { citeId: originalId, start: 1, end: 1, reason: 'An original span cannot replace the exclusion rules.' } }] }),
      { code: 'KNOWN_ORIGINAL_BINDING_INVALID' });
    const definition = tools.tools.get('finish_stop_review').parameters.properties.knownObligations.items.properties;
    assert.match(definition.objectId.description, /every CURRENT/u);
    assert.match(definition.corroboration.description, /SUPERSEDED.*omit/u);
    assert.equal((await sdkFinish(tools, { summary: 'Only source-grounded exclusion evidence.', knownObligations: [row] })).complete, true);
  });
  assert.equal(handle.result.knownOriginalCoverage.items[0].disposition, 'SUPERSEDED');
  assert.equal(handle.result.knownOriginalCoverage.items[0].objectId, undefined);
  assert.equal(handle.result.unverifiedItems.length, 0); assert.equal(f.calls.length, 1);
  await handle.close();
});

for (const distinctObjects of [false, true]) test(`three known duties ${distinctObjects ? 'resolve through three preformed whole-duty objects' : 'cannot share two frozen unformed objects through corroboration'}`, async t => {
  const f = await fixture(t, { title: true, distinct: true, third: true });
  await fs.writeFile(f.production, 'export const ordered = values => [...values];\nexport const label = value => value.label;\nexport const retainedCount = values => values.length;\n');
  assert.equal(f.candidates.length, 3);
  const handle = await checkedRun(f, async tools => {
    const originalSignal = tools.params.abortSignal;
    await tools.readAll();
    const originalFile = tools.brief.task.basisFiles.find(file => path.basename(file).startsWith('user-original-0'));
    const originalId = (await tools.read(originalFile)).details.citation.citeId;
    const sdk = await loadPublicToolArgumentsValidator(), tool = tools.tools.get('set_original_checklist');
    assert.match(tools.params.extraSystemPrompt, /one distinct original-anchored whole-duty item per known candidate intended CURRENT or PHASE_DEFERRED/u);
    assert.match(tool.description, /Later corroboration cannot add a missing frozen item/u);
    const args = { items: distinctObjects ? f.candidates.map((candidate, index) => ({
      metricId: 'M16', verificationTarget: 'IMPLEMENTATION', text: 'An untrusted shorter paraphrase.',
      knownCandidateId: candidate.id, knownDutyReason: 'This exact current line supports this complete distinct retained duty.',
      citeId: originalId, lineStart: index + 2, lineEnd: index + 2,
    })) : [
      { metricId: 'M16', verificationTarget: 'IMPLEMENTATION', text: f.requirement,
        citeId: originalId, lineStart: 2, lineEnd: 2 },
      { metricId: 'M16', verificationTarget: 'IMPLEMENTATION', text: 'Preserve diagnostic labels and retained segment counts.',
        citeId: originalId, lineStart: 3, lineEnd: 4 },
    ], scope: { stopClassification: 'TASK_COMPLETE', completionClaim: true, limit: 20 } };
    const page = await tools.submit(tool.name, sdk.validateToolArguments(tool, { name: tool.name, arguments: args }));
    const objects = page.items.filter(item => item.originalSourceAnchor);
    assert.equal(objects.length, distinctObjects ? 3 : 2);
    const directory = path.dirname(path.dirname(tools.brief.task.basisFiles.find(file => path.basename(file).startsWith('known-original-observations'))));
    const frozen = await fs.readFile(path.join(directory, 'original-checklist.json'));
    const source = (await tools.read(f.production)).details.citation.citeId;
    const rows = f.candidates.map((candidate, index) => {
      const object = objects.find(object => object.description === (distinctObjects ? candidate.requirement
        : index === 0 ? f.requirement : 'Preserve diagnostic labels and retained segment counts.'));
      assert(object);
      return { id: candidate.id, disposition: 'CURRENT', objectId: object.objectId, verdict: 'NO_CONFIRMED_DEVIATION',
        reason: 'The complete retained duty is assessed from the current acknowledged source.', citeIds: [source],
        ...(!distinctObjects ? { corroboration: { citeId: originalId, start: index === 0 ? 2 : 3, end: index === 0 ? 2 : 4,
          reason: 'This acknowledged original range states the named retained duty; it cannot grant another object identity.' } } : {}) };
    });
    if (!distinctObjects) {
      assert.equal(new Set(rows.map(row => row.objectId)).size, 2);
      await assert.rejects(sdkFinish(tools, { summary: 'Three known IDs cannot reuse two current objects.', knownObligations: rows }),
        { code: 'KNOWN_ORIGINAL_BINDING_INVALID' });
      await assert.rejects(tools.submit('set_original_checklist', args), { code: 'TASK_SUBMISSION_CONFLICT' },
        'The existing frozen checklist cannot be rebuilt during finish repair.');
      const honest = { summary: 'The absent separate original item remains unresolved.', knownObligations: [rows[0], rows[1],
        { id: rows[2].id, disposition: 'UNVERIFIED', reason: 'No separate original-anchored checklist object was prepared for this candidate.' }] };
      const pending = await sdkFinish(tools, { summary: 'A current claim still lacks its separate object.',
        knownObligations: [rows[0], rows[1], { id: rows[2].id, disposition: 'CURRENT', verdict: 'NO_CONFIRMED_DEVIATION',
          reason: 'The missing original object cannot be invented after freeze.', citeIds: [source] }] });
      assert.equal(pending.complete, false); assert.equal(pending.pendingKnownOriginalCount, 1);
      assert.deepEqual(pending.pendingKnownOriginals[0].diagnostic.missingFields, ['objectId']);
      assert.match(pending.instruction, /corroboration cannot add missing objects/u);
      assert.equal((await sdkFinish(tools, honest)).complete, true);
    } else {
      assert.equal(new Set(rows.map(row => row.objectId)).size, 3);
      assert(page.knownObligations.items.every(candidate => candidate.formedAssociation?.objectId));
      assert.equal((await sdkFinish(tools, { summary: 'Three separate complete current assessments.', knownObligations: rows })).complete, true);
    }
    assert.deepEqual(await fs.readFile(path.join(directory, 'original-checklist.json')), frozen);
    assert.strictEqual(tools.params.abortSignal, originalSignal, 'Formation and accounting reuse the same original worker signal.');
  });
  assert.deepEqual(handle.result.knownOriginalCoverage.items.map(item => item.disposition),
    distinctObjects ? ['CURRENT', 'CURRENT', 'CURRENT'] : ['CURRENT', 'CURRENT', 'UNVERIFIED']);
  assert.equal(handle.result.unverifiedItems.filter(item => item.type === 'KNOWN_ORIGINAL_OBLIGATION').length, distinctObjects ? 0 : 1);
  assert.equal(f.calls.length, 1); await handle.close();
});
