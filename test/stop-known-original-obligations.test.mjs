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

async function finish(tools, value) {
  const first = await tools.submit('finish_stop_review', value);
  if (!first.complete) {
    assert(first.pendingKnownOriginalCount > 0);
    return tools.submit('finish_stop_review', value);
  }
  return first;
}

async function fixture(t, { conditional = false, external = false, internal = false, advisory = false, oversized = false, empty = false } = {}) {
  const f = await stopProtocolFixture(t, 'findings');
  f.input.request.reviewScope = { kind: 'workspace-stop' }; delete f.input.request.fixedStopClassification;
  f.input.request.classificationContract = 2;
  f.input.request.workflowStages = ['proposal'];
  f.input.request.population.reviewPolicy = resolveStopReviewPolicy({ deviationOnly: true, metrics: { M11: true, M16: true } });
  f.requirement = internal ? 'Preserve ordering for empty and non-empty inputs.' : advisory ? 'Consider preserving stream ordering.' : external ? 'If the user later requests publishing, run the release audit.' : conditional ? 'Preserve ordering when streaming is enabled.' : 'Preserve stream ordering.';
  f.input.evidence.snapshot.entries[0].message.content = f.requirement;
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
  if (oversized) { const row = f.observation.receipt.rows[0];
    f.observation.receipt.rows = Array.from({ length: 49 }, (_, index) => ({ ...row, requirement: `${row.requirement} Observation ${index}.` })); }
  if (!empty) assert.equal(await observeKnownOriginalObligations(f.owner, f.observation), true);
  f.owner.nativeRunId = 'apply-run'; f.owner.reviewController = new AbortController();
  f.input.readKnownOriginalObligations = knownOriginalObligationReader(f.owner);
  f.candidate = knownOriginalObligations(f.owner)?.items[0];
  f.production = path.join(f.root, 'stream.mjs');
  await fs.writeFile(f.production, 'export const streaming = true;\nexport const ordered = values => [...values];\n');
  f.prepare = async ({ brief, readAll, read, submit }, { stage = false, include = true, metricId = 'M16', target = 'IMPLEMENTATION' } = {}) => {
    await readAll();
    const originalFile = brief.task.basisFiles.find(file => path.basename(file).startsWith('user-original-0'));
    const originalId = (await read(originalFile)).details.citation.citeId;
    const page = await submit('set_original_checklist', { items: include ? [{ metricId, verificationTarget: target, text: f.requirement,
      ...(conditional ? { applicability: external ? 'A later user requests publishing.' : 'Streaming is enabled.' } : {}), citeId: originalId, lineStart: 1, lineEnd: 1 }] : [],
      scope: { stopClassification: stage ? 'STAGE_COMPLETE' : 'TASK_COMPLETE', ...(stage ? { stage: stage === true ? 'proposal' : stage } : {}), completionClaim: true, limit: 20 } });
    const object = page.items?.find(item => item.description === f.requirement);
    return { originalId, object, originalFile };
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

for (const mode of ['missing', 'checked', 'over-limit']) test(`actual host settlement ${mode}`, async t => {
  const checked = mode === 'checked';
  const f = await fixture(t, { oversized: mode === 'over-limit' }), transcript = path.join(f.root, 'session.jsonl');
  await fs.writeFile(transcript, f.input.evidence.snapshot.entries.map(JSON.stringify).join('\n') + '\n');
  const runtimeV2 = compileRuntimeV2Config({ version: 2, dynamicGroundTruth: { enabled: false },
    stopCorrection: { enabled: true, originalRequirementsBasis: true, deviationOnly: true } });
  const reader = f.input.readKnownOriginalObligations;
  const reviewerFactory = input => {
    Object.assign(f.input, input);
    return f.run(async tools => {
      const { object } = await f.prepare(tools);
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
