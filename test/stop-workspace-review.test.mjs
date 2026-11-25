import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { stopProtocolFixture, materializeStopChecklist } from './helpers/stop-protocol.mjs';
import { scriptedWorkspaceReview } from './helpers/scripted-workspace-review.mjs';
import { loadReviewCheckpoint } from '../lib/review-task/history-memory.mjs';
import { atomicWriteJson, sha256 } from '../lib/runtime-v2/utils.mjs';
import { scanSkillDirectory, bindSkillGraph } from '../lib/runtime-v2/skill-source.mjs';
import * as openclawHost from '../lib/hosts/openclaw.mjs';
import { skillGraphCandidate } from './helpers/skill-source-interpretation.mjs';
import { persistSkillGroundTruth } from '../lib/runtime-v2/ground-truth-ledger.mjs';
import { buildMetricPopulation, buildOriginalStopPopulation } from '../lib/runtime-v2/metrics.mjs';
import { recordDeviationFindings } from '../lib/runtime-v2/deviations.mjs';
import { resolveStopReviewPolicy } from '../lib/runtime-v2/metric-policy.mjs';
import { loadStopOriginalRequirements } from '../lib/runtime-v2/production-stop.mjs';
import { createOriginalSourceAnchor } from '../lib/runtime-v2/original-source-anchor.mjs';
import { prepareMixedSkillEvaluation, MIXED_SKILL_EXPECTED } from '../scripts/helpers/mixed-skill-evaluation.mjs';
import { createProductionTraceSchema, validateProductionTrace } from '../lib/review-task/production-trace.mjs';
import { taskDirectory } from '../lib/runtime-v2/task-store.mjs';
import { captureTaskStart } from '../lib/runtime-v2/task-changes.mjs';
import { compileRuntimeV2Config } from '../lib/runtime-v2/config.mjs';
import { handleRuntimeV2Event } from '../lib/runtime-v2/orchestrator.mjs';
import { FRAME_REVIEW_INSTRUCTIONS, frameReproduction } from '../lib/runtime-v2/requirement-frame.mjs';
import { createStopStartProtocol } from '../lib/openclaw/stop-start-protocol.mjs';
import { createStopCorrectionStore } from '../lib/runtime-v2/stop-correction-store.mjs';
import { loadPublicToolArgumentsValidator } from '../lib/openclaw/compat-2026.7.1-2.mjs';

async function expandChecklist(submit, page) {
  assert(Buffer.byteLength(JSON.stringify(page)) <= 8192);
  const restore = async pointer => {
    let args = pointer.arguments, text = '';
    do {
      const detail = await submit('review_checklist', args);
      assert(Buffer.byteLength(JSON.stringify(detail)) <= 8192);
      assert.equal(detail.readProofGranted, false); assert.equal(detail.assessmentGranted, false);
      text += detail.jsonText; args = detail.next?.arguments;
    } while (args);
    return JSON.parse(text);
  };
  const result = { ...page, ...(page.checklistDetails ? await restore(page.checklistDetails.readWith) : {}) };
  if (Array.isArray(page.items)) result.items = await Promise.all(page.items.map(item => item.fullContentDeferred ? restore(item.readWith) : item));
  return result;
}

async function fixture(t) {
  const f = await stopProtocolFixture(t, 'findings');
  f.input.request.reviewScope = { kind: 'workspace-stop' };
  delete f.input.request.fixedStopClassification;
  f.input.evidence.snapshot.entries.push({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'edit-1', name: 'Edit', input: { file_path: f.file, old_string: 'before', new_string: 'after' } }] } });
  const scope = submit => submit('review_scope', { stopClassification: 'TASK_COMPLETE', summary: 'The original response claims completion.' });
  const result = (submit, citeIds = [], verdict = 'PASS') => submit('submit_review', { taskId: 'M01:R1', verdict, reason: 'Checked the current original delivery.', citeIds });
  return { ...f, scope, result };
}

test('workspace review binds a historical process inversion to original calls and persists its proof', async t => {
  const f = await fixture(t), original = f.input.request.population.metrics.M01[0];
  f.input.request.population.metrics = { M11: [{ ...original, objectId: 'M11:R1', metricId: 'M11',
    verificationTarget: 'PROCESS', originalSource: { kind: 'PROJECT_FILE', ref: 'AGENTS.md', sha256: 'original-rule', start: 1, end: 1 } }] };
  f.input.evidence.snapshot.entries.push(
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'created', name: 'openspec_cli', input: { args: ['new', 'change', 'demo'] } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'created', is_error: false, content: 'Created successfully.' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'status', name: 'openspec_cli', input: { args: ['status'] } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'status', is_error: false, content: 'Status returned successfully.' }] } });
  const handle = await f.run(async ({ readAll, read, submit }) => {
    await readAll();
    const checklist = await materializeStopChecklist(await submit('review_checklist', { stopClassification: 'TASK_COMPLETE', includeProcessEvidence: true }), submit);
    const ids = [];
    for (const sample of checklist.processEvidence.executionSamples) {
      for (const file of [...sample.invocationFiles, sample.resultFile]) ids.push((await read(file)).details.citation.citeId);
    }
    await submit('submit_review', { taskId: 'M11:R1', verdict: 'DEVIATION', reason: 'Creation preceded the required status query.', citeIds: ids });
    await submit('finish_stop_review', { summary: 'Only the past order is irreversible.', historicalOrders: [{
      objectId: 'M11:R1', requiredFirstEventId: 'status', requiredSecondEventId: 'created', historicalOnly: true,
      reason: 'The original creation is already complete; future creations still require status first.' }] });
  });
  assert.equal(handle.result.metricObjectJudgements[0].judgement, 'DEVIATION');
  assert.equal(handle.getHistoricalOrders().length, 1);
  assert.equal(handle.getHistoricalOrders()[0].kind, 'IRREVERSIBLE_ORDER');
  await handle.close();
});

test('ordinary and partial process-deviation channels cannot bypass historical classification', async t => {
  for (const mode of ['finished-unclassified', 'overflow-unclassified', 'current-repair', 'finding-unclassified', 'finding-current-repair'])
    await t.test(mode, async t => {
      const f = await fixture(t), original = f.input.request.population.metrics.M01[0];
      f.input.request.population.reviewPolicy = { deviationOnly: true };
      f.input.request.population.metrics = { M11: [{ ...original, objectId: 'M11:R1', metricId: 'M11',
        verificationTarget: 'PROCESS', originalSource: { kind: 'USER_MESSAGE', ref: 'original', sha256: 'rule', start: 1, end: 1 } }] };
      f.input.evidence.snapshot.entries.push(
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'checked-mode', name: 'Bash', input: { command: 'check-active-mode' } }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'checked-mode', is_error: false, content: 'Current active mode is debug.' }] } });
      const finding = mode.startsWith('finding-'), repair = mode.endsWith('current-repair');
      const handle = await f.run(async ({ readAll, read, submit }) => {
        await readAll();
        const checklist = await materializeStopChecklist(await submit('review_checklist', { stopClassification: 'TASK_COMPLETE', includeProcessEvidence: true }), submit);
        const sample = checklist.processEvidence.executionSamples[0], ids = [];
        for (const file of [...sample.invocationFiles, sample.resultFile]) ids.push((await read(file)).details.citation.citeId);
        const receipt = finding ? await submit('submit_finding', { deviationKey: 'process-finding', rootCauseId: 'REQUIREMENT_OMITTED',
          severity: 'warning', reason: 'The active mode is still debug.', expectedConstraint: original.description,
          violatedGroundTruthIds: [original.sourceId], citeIds: ids })
          : await submit('submit_review', { taskId: 'M11:R1', verdict: 'DEVIATION',
            reason: repair ? 'The active mode is still debug.' : 'Only the already completed historical order is wrong; no artifact defect remains.', citeIds: ids });
        assert.equal(receipt.processClassificationRequired, true);
        if (mode === 'overflow-unclassified') throw Object.assign(new Error('Controlled overflow after saving a process candidate.'), { code: 'CONTEXT_OVERFLOW' });
        await submit('finish_stop_review', { summary: 'The process disposition is explicit.', ...(repair ? { processRepairs: [{
          objectId: finding ? 'process-finding' : 'M11:R1', currentResidue: 'Active mode remains debug.',
          repairAction: 'Set mode to release and read back the current setting.' }] } : {}) });
      });
      if (finding) {
        assert.equal(handle.result.findings.length, repair ? 1 : 0);
        if (!repair) assert(handle.result.unverifiedItems.some(item => item.type === 'PROCESS_CLASSIFICATION'));
      } else {
        assert.equal(handle.result.metricObjectJudgements[0].judgement, repair ? 'DEVIATION' : 'UNVERIFIED');
        if (!repair) assert(handle.result.unverifiedItems.length > 0);
      }
      if (repair) assert.equal(JSON.parse(await fs.readFile(path.join(handle.artifacts, 'process-repairs.json'), 'utf8')).length, 1);
    });
});

test('program scope verification runs between native calls and resumes the same checklist once', async t => {
  const f = await fixture(t);
  f.input.deferScopeVerification = true;
  let nativeSettled = false, selections = 0;
  f.input.onScope = async () => {
    assert(nativeSettled, 'program work starts after the selecting native call has settled');
    selections++;
    return { verification: { build: { status: 'passed' } } };
  };
  const handle = await f.run(async ({ brief, readAll, read, submit }) => {
    if (brief.attempt === 1) {
      await readAll();
      const scope = await submit('review_checklist', { stopClassification: 'TASK_COMPLETE' });
      assert.equal(scope.deferred, true);
      assert.equal(selections, 0);
      nativeSettled = true;
      return;
    }
    const checklist = await materializeStopChecklist(await submit('review_checklist', { limit: 20 }), submit);
    assert.equal(checklist.items.length, 1);
    assert.equal(checklist.programEvidenceFiles.length, 1);
    assert.equal((await submit('review_scope', { stopClassification: 'TASK_COMPLETE', summary: 'Same scope.' })).reused, true);
    const actual = await read(f.file);
    await f.result(submit, [actual.details.citation.citeId]);
    await submit('finish_stop_review', { summary: 'Reviewed the prepared evidence.' });
  });
  assert.equal(selections, 1);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].sessionId, f.calls[1].sessionId);
  assert.equal(handle.reviewCompleted, true);
  assert.equal(handle.result.metricObjectJudgements[0].judgement, 'PASS');
});

test('combined original checklist validates scope before saving and resumes its first page with the same review budget', async t => {
  const f = await fixture(t);
  const requirement = 'Deliver the required value.';
  const source = path.join(f.root, 'app.mjs');
  await fs.writeFile(source, 'export const requiredValue = 1;\n');
  f.input.evidence.originalRequirements = await loadStopOriginalRequirements({ projectRoot: f.root, snapshot: f.input.evidence.snapshot });
  f.input.request.classificationContract = 2;
  f.input.request.fixedStopClassification = { stopClassification: 'TASK_COMPLETE', stage: null };
  f.input.deferScopeVerification = true;
  let nativeSettled = false, selections = 0;
  f.input.onScope = async (frame, basis) => {
    assert(nativeSettled, 'program verification waits for the selecting native call to settle');
    selections++;
    assert.equal(frame.stopClassification, 'TASK_COMPLETE');
    assert.equal(basis.population.metrics.M16[0].originalSource.sha256, sha256(requirement));
    return { verification: { build: { status: 'passed' } } };
  };

  const handle = await checkedVersionRun(f, async ({ brief, readAll, read, submit }) => {
    if (brief.attempt === 1) {
      const userSource = brief.task.basisFiles.find(file => path.basename(file).startsWith('user-original-'));
      const citeId = (await read(userSource)).details.citation.citeId;
      const items = [{ metricId: 'M16', text: requirement, verificationTarget: 'IMPLEMENTATION', citeId, lineStart: 1, lineEnd: 1 }];
      const scope = { stopClassification: 'TASK_COMPLETE', completionClaim: true, limit: 1 };
      const save = selection => submit('set_original_checklist', { items, scope: selection });
      await assert.rejects(save(scope), { code: 'TASK_BASIS_UNREAD' });
      await readAll();
      await assert.rejects(save({ ...scope, completionClaim: false }), { code: 'STOP_CLASSIFICATION_INVALID' });
      await assert.rejects(save({ ...scope, stopClassification: 'INTERMEDIATE', completionClaim: false }), { code: 'STOP_STAGE_SCOPE_INVALID' });
      const checklistPath = path.join(path.dirname(path.dirname(userSource)), 'original-checklist.json');
      await assert.rejects(fs.stat(checklistPath), { code: 'ENOENT' });
      assert.deepEqual(await submit('review_checklist', {}), { next: 'set_original_checklist', scopeSelected: false });

      const handoff = await save(scope);
      assert.equal(handoff.deferred, true);
      assert.equal(handoff.scopeSelected, false);
      assert.equal(handoff.next, 'review_checklist');
      assert((await fs.stat(checklistPath)).isFile());
      assert.equal(selections, 0);
      nativeSettled = true;
      return;
    }

    const encoded = /^Current checklist page \(JSON data\):\n([^\r\n]+)$/mu.exec(brief.instruction)?.[1];
    assert(encoded);
    const page = JSON.parse(encoded);
    assert.equal(page.classification.stopClassification, 'TASK_COMPLETE');
    assert.equal(page.nextOffset, null);
    assert.equal(page.items.length, 1);
    const [item] = page.items;
    assert.equal(item.originalSource.sha256, sha256(requirement));
    assert.equal(item.savedResult, null);
    assert.equal(page.evidencePriority, 'CURRENT_SOURCE');
    const finish = () => submit('finish_stop_review', { summary: 'Verified the original delivery.' });
    await assert.rejects(finish(), { code: 'REVIEW_ITEM_INCOMPLETE' });
    const current = await read(source);
    await submit('submit_review', { taskId: item.taskId, verdict: 'PASS', reason: 'The application exports the required value.',
      citeIds: [current.details.citation.citeId] });
    assert.equal((await finish()).complete, true);
  });
  assert.equal(selections, 1);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].sessionId, f.calls[1].sessionId);
  assert(f.calls[1].timeoutMs > 0 && f.calls[1].timeoutMs <= f.calls[0].timeoutMs);
  assert.equal(handle.reviewCompleted, true);
  assert.equal(handle.result.metricObjectJudgements[0].judgement, 'PASS');
  await handle.close();
});

test('cancelling after scope handoff cannot launch its program verification', async t => {
  const f = await fixture(t), abort = new AbortController();
  f.input.abortSignal = abort.signal;
  f.input.deferScopeVerification = true;
  let selections = 0;
  f.input.onScope = async () => { selections++; };
  await assert.rejects(f.run(async ({ readAll, submit }) => {
    await readAll();
    assert.equal((await submit('review_scope', { stopClassification: 'TASK_COMPLETE', summary: 'Complete.' })).deferred, true);
    abort.abort();
  }));
  assert.equal(selections, 0);
});

test('basis drift during deferred program verification cannot publish a completed review', async t => {
  const f = await fixture(t);
  f.input.deferScopeVerification = true;
  f.input.onScope = async () => {
    await fs.writeFile(f.input.request.groundTruthPath, '{}');
    return { verification: { build: { status: 'passed' } } };
  };
  await assert.rejects(f.run(async ({ readAll, submit }) => {
    await readAll();
    assert.equal((await submit('review_checklist', { stopClassification: 'TASK_COMPLETE' })).deferred, true);
  }));
  assert.equal(f.calls.length, 1, 'stale scope never reaches another native call');
});

const versionlessTrace = () => ({ entryPoint: 'accept(value)', actualInput: 'Caller supplied finite number',
  producerToConsumer: 'The numeric value flows through value + 1 and the returned primitive is consumed by the caller.',
  stateful: false, statelessReason: 'This pure function has no stored or shared mutable state.', stateTargets: [], targetRelations: [] });

async function fixedVersionFixture(t, { two = false } = {}) {
  const f = await fixture(t), source = path.join(f.root, 'app.mjs');
  await fs.writeFile(source, 'export const accept = value => value + 1;\n');
  const original = f.input.request.population.metrics.M01[0];
  f.input.request.population.metrics = { M16: (two ? ['R1', 'R2'] : ['R1']).map(id => ({ ...original,
    objectId: `M16:${id}`, sourceId: id, metricId: 'M16', verificationTarget: 'IMPLEMENTATION' })) };
  return { ...f, source };
}

async function checkedVersionRun(f, script) {
  let callbackFailure;
  try {
    const handle = await f.run(async args => { try { await script(args); } catch (error) { callbackFailure = error; throw error; } });
    if (callbackFailure) { await handle.close(); throw callbackFailure; }
    return handle;
  } catch (error) { throw callbackFailure ?? error; }
}

test('deviation-only Stop accepts a cited counterexample without requiring other item results', async t => {
  const f = await fixedVersionFixture(t, { two: true });
  f.input.request.population.reviewPolicy = resolveStopReviewPolicy({ deviationOnly: true });
  const handle = await checkedVersionRun(f, async ({ readAll, read, submit }) => {
    const finish = () => submit('finish_stop_review', { summary: 'Scanned the original requirements.' });
    await readAll();
    await assert.rejects(finish(), { code: 'REVIEW_ITEM_INCOMPLETE' });
    await f.scope(submit);
    const citation = (await read(f.source)).details.citation.citeId;
    const row = { taskId: 'M16:R1', verdict: 'DEVIATION', reason: 'The implementation adds one.', citeIds: [citation] };
    await assert.rejects(submit('submit_review', { ...row, verdict: 'PASS' }), { code: 'TASK_SUBMISSION_INVALID' });
    await assert.rejects(submit('submit_review', { ...row, citeIds: [] }), { code: 'TASK_CITATION_INVALID' });
    assert.equal((await submit('submit_review', row)).saved, true);
    assert.equal((await finish()).complete, true);
  });
  assert.deepEqual(handle.result.metricObjectJudgements.map(row => [row.objectId, row.judgement]), [['M16:R1', 'DEVIATION']]);
  await handle.close();
});

test('Stop prepares a semantic graph before the reviewer starts and still requires source citations', async t => {
  const f = await fixedVersionFixture(t);
  execFileSync('git', ['init', '-q'], { cwd: f.root });
  await fs.writeFile(path.join(f.root, 'entry.ets'), 'export { accept } from "./app.mjs";\n');
  f.input.request.population.reviewPolicy = resolveStopReviewPolicy({ deviationOnly: true });
  const handle = await checkedVersionRun(f, async ({ readAll, read, submit }) => {
    const graph = await submit('semantic_graph', { operation: 'dependencies', file: 'app.mjs' });
    assert.equal(graph.navigationOnly, true);
    assert.deepEqual(graph.hits, [{ from: 'entry.ets', to: 'app.mjs', kind: 'export', line: 1 }]);
    assert.equal((await submit('semantic_graph', { operation: 'definition', symbol: 'accept' })).hits[0].path, 'app.mjs');
    await readAll();
    await f.scope(submit);
    const row = { taskId: 'M16:R1', verdict: 'DEVIATION', reason: 'The implementation adds one.', citeIds: ['app.mjs:1'] };
    assert.equal((await submit('submit_review', row)).saved, true);
    assert.equal((await submit('finish_stop_review', { summary: 'Reviewed the original source.' })).complete, true);
  });
  await handle.close();
});

test('fixed-version omitted metadata persists two M16 PASS traces without mutating original calls', async t => {
  const f = await fixedVersionFixture(t, { two: true }); let callbackFailure, originals;
  const handle = await f.run(async ({ readAll, read, submit, tools }) => {
    try {
      await readAll(); await f.scope(submit);
      const actual = await read(f.source), citeIds = [actual.details.citation.citeId];
      originals = ['M16:R1', 'M16:R2'].map(taskId => Object.freeze({ taskId, verdict: 'PASS',
        reason: 'Checked the actual production input to output flow.', citeIds, productionTrace: Object.freeze(versionlessTrace()) }));
      const outcomes = await Promise.allSettled(originals.map(value => submit('submit_review', value)));
      for (const outcome of outcomes) if (outcome.status === 'rejected') {
        t.diagnostic(JSON.stringify({ target: 'complete trace, only fixed version absent', code: outcome.reason.code, message: outcome.reason.message }));
        throw outcome.reason;
      }
      assert(outcomes.every(outcome => outcome.value.saved));
      assert.equal(outcomes[1].value.pending, 0);
      const wire = tools.get('submit_review').parameters.properties.productionTrace;
      const canonical = createProductionTraceSchema();
      assert.deepEqual(wire.properties, { ...canonical.properties, version: { const: 1 } });
      assert.deepEqual(wire.required, canonical.required.filter(field => field !== 'version'));
      assert.equal(canonical.properties.version.type, 'number'); assert.equal(canonical.properties.version.const, 1);
      assert.equal(canonical.required.includes('version'), true);
      assert.throws(() => validateProductionTrace(versionlessTrace(), citeIds), /missing fields: version/);
      for (const value of originals) assert.equal(Object.hasOwn(value.productionTrace, 'version'), false);
      await assert.rejects(submit('submit_review', originals[0]), /already has a saved result/);
      await submit('finish_stop_review', { summary: 'Both actual M16 source traces are complete.' });
    } catch (error) { callbackFailure = error; throw error; }
  });
  if (callbackFailure) throw callbackFailure;
  assert.equal(f.calls.length, 1);
  for (const value of originals) {
    const expected = { ...value.productionTrace, version: 1 };
    const row = handle.result.metricObjectJudgements.find(row => row.objectId === value.taskId);
    assert.deepEqual(row.productionTrace, expected);
    assert.deepEqual(handle.proofs[value.taskId].productionTrace, expected);
    const persisted = JSON.parse(await fs.readFile(path.join(handle.artifacts, 'items', sha256(value.taskId) + '.json'), 'utf8'));
    assert.deepEqual(persisted.result.productionTrace, expected);
    assert.equal(Object.hasOwn(value.productionTrace, 'version'), false);
  }
  await handle.close();
});

test('fixed-version explicit invalid values and non-JSON prototypes reject while explicit one remains compatible', async t => {
  const f = await fixedVersionFixture(t);
  const handle = await checkedVersionRun(f, async ({ readAll, read, submit }) => {
    await readAll(); await f.scope(submit);
    const actual = await read(f.source), base = { taskId: 'M16:R1', verdict: 'PASS', reason: 'Actual source flow.', citeIds: [actual.details.citation.citeId] };
    for (const version of [0, 2, -1, 1.5, '1', null, undefined, {}, true]) {
      const trace = { ...versionlessTrace(), version };
      await assert.rejects(submit('submit_review', { ...base, productionTrace: trace }), { code: 'TASK_SUBMISSION_INVALID' });
      assert.equal(trace.version, version);
    }
    const inherited = Object.assign(Object.create({ version: 1 }), versionlessTrace());
    const ownOnPrototype = Object.assign(Object.create({ untrusted: true }), versionlessTrace(), { version: 1 });
    const nullPrototype = Object.assign(Object.create(null), versionlessTrace(), { version: 1 });
    for (const trace of [inherited, ownOnPrototype, nullPrototype])
      await assert.rejects(submit('submit_review', { ...base, productionTrace: trace }), { code: 'TASK_SUBMISSION_INVALID' });
    const inheritedTrace = Object.assign(Object.create({ productionTrace: versionlessTrace() }), base);
    await assert.rejects(submit('submit_review', inheritedTrace), { code: 'TASK_SUBMISSION_INVALID' });
    const correct = Object.freeze({ ...versionlessTrace(), version: 1 });
    await submit('submit_review', { ...base, productionTrace: correct });
    await submit('finish_stop_review', { summary: 'Explicit version one preserved.' });
  });
  assert.deepEqual(handle.result.metricObjectJudgements[0].productionTrace, { ...versionlessTrace(), version: 1 }); await handle.close();
});

test('optional production traces validate supplied JSON structure without semantic acceptance gates', async t => {
  const f = await fixedVersionFixture(t), testFile = path.join(f.root, 'app.test.mjs');
  await fs.writeFile(testFile, 'assert.equal(accept(2), 3);\n');
  const handle = await checkedVersionRun(f, async ({ readAll, read, submit }) => {
    await readAll(); await f.scope(submit);
    const actual = await read(f.source), test = await read(testFile), id = actual.details.citation.citeId;
    const base = { taskId: 'M16:R1', verdict: 'PASS', reason: 'Current original source flow.', citeIds: [id] };
    for (const field of Object.keys(versionlessTrace())) {
      const trace = versionlessTrace(); delete trace[field];
      await assert.rejects(submit('submit_review', { ...base, productionTrace: trace }), error => {
        assert.equal(error.code, 'TASK_SUBMISSION_INVALID'); assert(error.message.includes(`/productionTrace/${field}`)); return true;
      });
    }
    await assert.rejects(submit('submit_review', { ...base, productionTrace: { ...versionlessTrace(), invented: 'unknown' } }), /invented/);

    for (const trace of [null, []]) await assert.rejects(submit('submit_review', { ...base, productionTrace: trace }), { code: 'TASK_SUBMISSION_INVALID' });


    const stateful = { ...versionlessTrace(), stateful: true, statelessReason: '', stateTargets: ['left', 'right'].map(name => ({
      id: name, expression: `resolve(input.${name})`, readers: [`read(${name})`], writers: [`write(${name}, values)`], producerValue: 'values', citeIds: [id] })),
      targetRelations: [{ left: 'left', right: 'right', identity: 'UNKNOWN', overlapAttempt: 'No supported exclusion of aliasing.',
        effect: 'UNKNOWN', explanation: 'The required downstream flow remains unproved.', citeIds: [id] }] };


    await submit('submit_review', { ...base, productionTrace: versionlessTrace() });
    await submit('finish_stop_review', { summary: 'Only the complete source-backed trace was accepted.' });
  });
  assert.equal(handle.result.metricObjectJudgements[0].productionTrace.version, 1); await handle.close();
});

test('fixed-version non-M16 trace rejection and trace-free D/U behavior are unchanged', async t => {
  const f = await fixedVersionFixture(t, { two: true }), original = f.input.request.population.metrics.M16[0];
  f.input.request.population.metrics.M12 = [{ ...original, objectId: 'M12:R1', metricId: 'M12' }];
  const handle = await checkedVersionRun(f, async ({ readAll, read, submit }) => {
    await readAll(); await f.scope(submit); const source = await read(f.source), id = source.details.citation.citeId;
    const branches = [{ taskId: 'M16:R1', verdict: 'UNVERIFIED', citeIds: [] },
      { taskId: 'M16:R2', verdict: 'DEVIATION', citeIds: [id] }, { taskId: 'M12:R1', verdict: 'PASS', citeIds: [id] }];
    await assert.rejects(submit('submit_review', { ...branches[2], reason: 'Original branch control.', productionTrace: versionlessTrace() }), /productionTrace\/version/);
    for (const branch of branches) await submit('submit_review', { ...branch, reason: 'Original branch control.' });
    await submit('finish_stop_review', { summary: 'Non-M16 and trace-free negative requirements are unchanged.' });
  });
  assert.equal(handle.result.metricObjectJudgements.length, 3);
  assert(handle.result.metricObjectJudgements.every(row => row.productionTrace === undefined)); await handle.close();
});

test('m16-addendum supplied versionless broken-flow DEVIATION and UNVERIFIED remain negative without fabricated trace proof', async t => {
  const f = await fixedVersionFixture(t, { two: true }); let inputs;
  await fs.writeFile(f.source, 'export const store = new Map();\nexport const save = input => { store.set(input.left, [input.value]); store.set(input.right, {metadata:true}); return store.get(input.left); };\n');
  const handle = await checkedVersionRun(f, async ({ readAll, read, submit }) => {
    await readAll(); await f.scope(submit); const source = await read(f.source), id = source.details.citation.citeId;
    const trace = { entryPoint: 'save(input)', actualInput: 'input.left=input.right="same", input.value=7',
      producerToConsumer: 'The first write stores [7], the second aliasing metadata write replaces it, and the caller consumes a metadata object instead of the requested array.',
      stateful: true, statelessReason: '', stateTargets: [
        { id: 'left', expression: 'store[input.left]', readers: ['store.get(input.left)'], writers: ['store.set(input.left, [input.value])'], producerValue: '[7] before the aliasing overwrite', citeIds: [id] },
        { id: 'right', expression: 'store[input.right]', readers: [], writers: ['store.set(input.right, {metadata:true})'], producerValue: '{metadata:true}', citeIds: [id] }],
      targetRelations: [{ left: 'left', right: 'right', identity: 'SAME', overlapAttempt: 'Both permitted keys equal "same".', effect: 'BREAKS_REQUIRED_FLOW',
        explanation: 'The later metadata write replaces the value actually returned to the caller.', citeIds: [id] }] };
    assert.throws(() => validateProductionTrace({ ...trace, version: 1 }, [id]), /broken required flow/);
    inputs = [Object.freeze({ taskId: 'M16:R1', verdict: 'DEVIATION', reason: 'Concrete aliasing write contradicts the required produced value.', citeIds: [id], productionTrace: Object.freeze(trace) }),
      Object.freeze({ taskId: 'M16:R2', verdict: 'UNVERIFIED', reason: 'No conclusive assessment for this separate obligation.', citeIds: [], productionTrace: Object.freeze(structuredClone(trace)) })];

    for (const input of inputs) {
      for (const version of [2, null, undefined]) await assert.rejects(submit('submit_review', { ...input,
        productionTrace: { ...input.productionTrace, version } }), { code: 'TASK_SUBMISSION_INVALID' });
      const inherited = Object.assign(Object.create({ version: 1 }), input.productionTrace);
      await assert.rejects(submit('submit_review', { ...input, productionTrace: inherited }), { code: 'TASK_SUBMISSION_INVALID' });
    }
    const missing = { ...inputs[0].productionTrace }; delete missing.producerToConsumer;
    await assert.rejects(submit('submit_review', { ...inputs[0], productionTrace: missing }), /productionTrace\/producerToConsumer/);
    await assert.rejects(submit('submit_review', { ...inputs[0], productionTrace: { ...inputs[0].productionTrace, invented: true } }), /invented/);
    for (const input of inputs) await submit('submit_review', input);
    await submit('finish_stop_review', { summary: 'Only original D/U results, no synthesized PASS evidence.' });
  });
  for (const input of inputs) {
    const row = handle.result.metricObjectJudgements.find(row => row.objectId === input.taskId);
    assert.equal(row.judgement, input.verdict); assert.equal(Object.hasOwn(row, 'productionTrace'), false);
    assert.equal(handle.proofs[input.taskId].productionTrace, undefined);
    const saved = JSON.parse(await fs.readFile(path.join(handle.artifacts, 'items', sha256(input.taskId) + '.json'), 'utf8'));
    assert.equal(Object.hasOwn(saved.result, 'productionTrace'), false); assert.equal(Object.hasOwn(input.productionTrace, 'version'), false);
    if (input.verdict === 'UNVERIFIED') {
      assert.deepEqual(row.evidence, []); assert.deepEqual(handle.proofs[input.taskId].sourceCiteIds, []); assert.deepEqual(saved.citations, []);
    }
  }
  await handle.close();
});

test('m16-addendum current-item conditionAssessment stays rejected with exact field and canonical kind feedback', async t => {
  const f = await fixedVersionFixture(t, { two: true });
  f.input.request.population.metrics.M16[1].applicabilityKind = 'CONDITIONAL';
  const handle = await checkedVersionRun(f, async ({ readAll, read, submit, tools }) => {
    await readAll(); await f.scope(submit); const actual = await read(f.source), id = actual.details.citation.citeId;
    const current = { taskId: 'M16:R1', verdict: 'DEVIATION', reason: 'Original implementation finding, not a new external condition.', citeIds: [id],
      productionTrace: { ...versionlessTrace(), version: 1 },
      conditionAssessment: { activation: 'ACTIVE', evidenceKind: 'TARGET_FACTS', reason: 'A supplied input branch does not change the assigned CURRENT_TASK kind.' } };
    const before = structuredClone(current);
    await assert.rejects(submit('submit_review', current), error => {
      assert.equal(error.code, 'REVIEW_ITEM_OWNERSHIP_INVALID'); assert.match(error.message, /\/conditionAssessment/);
      assert(error.message.includes('M16:R1')); assert(error.message.includes('CURRENT_TASK')); assert.match(error.message, /omit/iu); return true;
    });
    assert.deepEqual(current, before);
    const description = tools.get('submit_review').parameters.properties.conditionAssessment.description;
    assert.match(description, /CONDITIONAL/); assert.match(description, /omit/iu);
    const retry = { ...current }; delete retry.conditionAssessment;
    await submit('submit_review', retry);
    const conditional = { activation: 'UNKNOWN', evidenceKind: 'TARGET_FACTS', reason: 'The actual original external trigger remains unproved.' };
    await submit('submit_review', { taskId: 'M16:R2', verdict: 'UNVERIFIED', reason: 'Original conditional uncertainty.', citeIds: [], conditionAssessment: conditional });
    await submit('finish_stop_review', { summary: 'Explicit omission fixed only the rejected current-item field.' });
  });
  const current = handle.result.metricObjectJudgements.find(row => row.objectId === 'M16:R1');
  const conditional = handle.result.metricObjectJudgements.find(row => row.objectId === 'M16:R2');
  assert.equal(current.judgement, 'DEVIATION'); assert.equal(current.conditionAssessment, undefined);
  assert.equal(conditional.judgement, 'UNVERIFIED'); assert.equal(conditional.conditionAssessment.activation, 'UNKNOWN');
  assert.equal(f.input.request.population.metrics.M16[0].applicabilityKind, 'CURRENT_TASK'); await handle.close();
});

for (const mode of ['source-change', 'owner-cancel', 'deadline']) test(`fixed-version program metadata never bypasses ${mode}`, async t => {
  const f = await fixedVersionFixture(t), controller = new AbortController(); f.input.abortSignal = controller.signal;
  let now = Date.now();
  if (mode === 'deadline') { t.mock.method(Date, 'now', () => now); f.input.deadlineAt = now + 20000; }
  await assert.rejects(checkedVersionRun(f, async ({ readAll, read, submit }) => {
    await readAll(); await f.scope(submit); const actual = await read(f.source);
    if (mode === 'source-change') await fs.writeFile(f.source, 'export const accept = value => 0;\n');
    else if (mode === 'owner-cancel') controller.abort(new Error('fixed-version owner cancel'));
    else now += 20001;
    await submit('submit_review', { taskId: 'M16:R1', verdict: 'PASS', reason: 'Stale or revoked source must not save.',
      citeIds: [actual.details.citation.citeId], productionTrace: versionlessTrace() });
  }), /changed|stale|cancel|deadline|exhausted/iu);
  const reviews = path.join(taskDirectory(f.root, f.task.taskId), 'workspace-reviews');
  for (const directory of await fs.readdir(reviews)) {
    const items = await fs.readdir(path.join(reviews, directory, 'items')).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    assert.equal(items.length, 0, 'revoked source scope must not gain a saved PASS from program metadata');
  }
});

test('critical-path Stop plans independent captured process reads within the original raw byte budget', async t => {
  const f = await fixture(t);
  let targetFailure;
  while (f.input.evidence.snapshot.entries.length < 14) f.input.evidence.snapshot.entries.push({ type: 'assistant', message: { content: 'Independent captured original.' } });
  const handle = await f.run(async ({ readAll, read, submit }) => {
    await readAll(); await f.scope(submit);
    const checklist = await expandChecklist(submit, await submit('review_checklist', {})), plan = checklist.processReadPlan;
    try { assert.ok(plan, 'selected checklist has no captured process read plan'); } catch (error) { targetFailure = error; throw error; }
    assert.equal(plan.navigationOnly, true); assert.equal(plan.maxBatchBytes, 32768); assert.equal(plan.maxBatchFiles, 16);
    assert.equal(plan.complete, true); assert(Buffer.byteLength(JSON.stringify(plan)) <= 4096);
    const planned = plan.batches.flatMap(batch => batch.files);
    assert.equal(planned.length, 14); assert(plan.batches.every(batch => batch.bytes <= 32768));
    for (const file of planned) { assert.equal(path.isAbsolute(file), false); await read(file); }

    const current = await read(f.file); await f.result(submit, [current.details.citation.citeId]);
    await submit('finish_stop_review', { summary: 'Original checklist and actual source proof retained.' });
  });
  if (targetFailure) throw targetFailure;
  assert.equal(handle.result.metricObjectJudgements.length, 1); await handle.close();
});

test('separate fresh and reused native scope summaries retain bounded lossless navigation', async t => {
  const f = await fixture(t), artifacts = Array.from({ length: 48 }, (_, i) => ({ artifactId: `generic-artifact-${i}`,
    path: `generic/${i}/` + 'delivery/'.repeat(30), description: 'Retain complete generic artifact navigation. '.repeat(10) }));
  f.input.onScope = async () => ({ artifactCandidates: artifacts, genericPublicNavigation: 'Generic captured observation. '.repeat(18000) });
  const handle = await f.run(async ({ readAll, submit }) => {
    await readAll(); const freshWire = await f.scope(submit);
    assert(Buffer.byteLength(JSON.stringify(freshWire)) <= 8192);
    assert.equal(freshWire.items, 1); assert.equal(freshWire.files, 0); assert.equal(freshWire.next, 'review_checklist');
    assert(freshWire.checklistDetails.fields.includes('artifactCandidates'));
    const fresh = await expandChecklist(submit, freshWire); assert.deepEqual(fresh.artifactCandidates, artifacts);
    assert(fresh.programEvidenceFiles.length > 20);
    const reusedWire = await f.scope(submit);
    assert(Buffer.byteLength(JSON.stringify(reusedWire)) <= 8192);
    assert.equal(reusedWire.reused, true); assert.equal(reusedWire.items, 1); assert.equal(reusedWire.next, 'review_checklist');
    assert(reusedWire.checklistDetails.fields.includes('programEvidenceFiles'));
    const reused = await expandChecklist(submit, reusedWire);
    assert.deepEqual(reused.programEvidenceFiles, fresh.programEvidenceFiles);
    await f.result(submit, [], 'UNVERIFIED');
    assert.equal((await submit('finish_stop_review', { summary: 'Read-only scope details supply no evidence or assessment.' })).complete, true);
  });
  assert.equal(handle.result.metricObjectJudgements[0].judgement, 'UNVERIFIED'); await handle.close();
});

test('critical-path Stop plan truncation preserves inventory recovery and never certifies unread history', async t => {
  const f = await fixture(t); let failure;
  while (f.input.evidence.snapshot.entries.length < 80) f.input.evidence.snapshot.entries.push({ type: 'assistant', message: { content: 'Captured process original.' } });
  const handle = await f.run(async ({ readAll, submit }) => {
    try {
      await readAll(); await f.scope(submit);
      const checklist = await expandChecklist(submit, await submit('review_checklist', {})), plan = checklist.processReadPlan;
      assert.equal(plan.complete, false); assert.equal(plan.totalFiles, 80); assert(Buffer.byteLength(JSON.stringify(plan)) <= 4096);
      assert.equal(plan.recoverWith.tool, 'source_ls'); assert.equal(plan.recoverWith.arguments.offset, 0);
      assert(plan.batches.flatMap(batch => batch.files).length < plan.totalFiles);
      await f.result(submit, [], 'UNVERIFIED');
      await submit('finish_stop_review', { summary: 'Unread originals remain honestly unverified.' });
    } catch (error) { failure = error; throw error; }
  });
  if (failure) throw failure;
  assert.equal(handle.result.metricObjectJudgements[0].judgement, 'UNVERIFIED'); await handle.close();
});

test('one workspace reviewer reads external and linked originals, plans, saves notes and submits a complete checklist without copying source', async t => {
  const f = await fixture(t);
  const external = path.join(path.dirname(f.root), `external-${path.basename(f.root)}.md`);
  await fs.writeFile(external, 'External requirement dependency.\n'); t.after(() => fs.rm(external, { force: true }));
  const externalDir = path.join(path.dirname(f.root), `linked-${path.basename(f.root)}`);
  await fs.mkdir(externalDir); await fs.writeFile(path.join(externalDir, 'linked.md'), 'Linked original requirement.\n');
  t.after(() => fs.rm(externalDir, { recursive: true, force: true }));
  const junction = path.join(f.root, 'reference'); await fs.symlink(externalDir, junction, process.platform === 'win32' ? 'junction' : 'dir');
  const handle = await f.run(async ({ params, brief, tools, readAll, read, submit }) => {
    assert.equal(params.cwd, f.root); assert.equal(params.workspaceDir, f.root);
    await assert.rejects(f.scope(submit), /not fully read/);
    await readAll(); await f.scope(submit);
    await assert.rejects(submit('finish_stop_review', { summary: 'Premature.' }), /incomplete/);
    await submit('review_plan', { steps: [{ text: 'Start with edits, then follow the external contract.', status: 'active' }] });
    await submit('review_notes', { note: 'The original external contract is relevant; this note itself is not proof.' });
    assert.equal((await submit('review_notes', {})).notes.length, 1);
    const changed = await submit('review_changes', {});
    assert(changed.hostEdits.some(edit => edit.path === f.file));
    await read(external); await read(path.join(junction, 'linked.md'));
    const actual = await read(f.file);
    await f.result(submit, [actual.details.citation.citeId]);
    await assert.rejects(f.result(submit, [actual.details.citation.citeId]), /already has/);
    await submit('finish_stop_review', { summary: 'The original checklist is complete.' });
    assert.equal(brief.task.scope, 'workspace-stop');
  });
  assert.equal(f.calls.length, 1);
  assert.equal(handle.result.metricObjectJudgements[0].judgement, 'PASS');
  assert.equal(handle.sourceCitations[0].path, f.file);
  assert.equal(handle.sourceCitations[0].frozen, false);
  assert(handle.reviewEvidence.files.includes(external));
  assert(handle.reviewEvidence.files.includes(path.join(externalDir, 'linked.md')));
  await assert.rejects(fs.stat(path.join(handle.artifacts, 'input', 'project')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(handle.artifacts, 'frozen-source')), { code: 'ENOENT' });
  assert((await fs.readFile(path.join(handle.artifacts, 'review-checkpoint.json'), 'utf8')).includes(f.file.replaceAll('\\', '\\\\')));
  const checkpoint = await loadReviewCheckpoint(path.join(handle.artifacts, 'review-checkpoint.json'));
  assert.equal(checkpoint.sourceMode, 'live');
  assert(checkpoint.files.some(([file]) => file === external));
});

test('combined scope/checklist and final submission preserve original proof and checklist completion', async t => {
  const f = await fixture(t);
  f.input.request.population.metrics.M01.push({ ...f.input.request.population.metrics.M01[0], objectId: 'M01:R2', sourceId: 'R2' });
  let selections = 0;
  f.input.onScope = async () => { selections++; return { verification: { build: { status: 'passed' } } }; };
  const handle = await f.run(async ({ readAll, read, submit }) => {
    const choose = () => submit('review_checklist', { stopClassification: 'TASK_COMPLETE' });
    await assert.rejects(choose(), /not fully read/);
    await readAll();
    const checklist = await choose();
    assert.equal(checklist.items.length, 2); assert.equal(checklist.pending, 2);
    assert.equal(checklist.programEvidenceFiles.length, 1);
    assert(checklist.processFiles.includes(checklist.programEvidenceFiles[0]));

    const actual = await read(f.file), citeIds = [actual.details.citation.citeId];
    const first = await submit('submit_review', { taskId: 'M01:R1', verdict: 'PASS', reason: 'Checked first original obligation.', citeIds, finish: true });
    assert.equal(first.pending, 1); assert.notEqual(first.complete, true);
    assert.deepEqual(first.pendingNavigation.pendingIds, ['M01:R2']);
    assert.equal(first.pendingNavigation.pendingTotal, 1);
    assert.equal(first.pendingNavigation.navigationOnly, true);

    const remaining = await choose();
    assert.equal(selections, 1); assert.equal(remaining.pending, 1);
    assert.deepEqual(remaining.programEvidenceFiles, checklist.programEvidenceFiles);
    assert.equal(remaining.items[0].savedResult.judgement, 'PASS');
    const last = await submit('submit_review', { taskId: 'M01:R2', verdict: 'PASS', reason: 'Checked second original obligation.', citeIds, finish: true });
    assert.equal(last.complete, true); assert.equal(last.pending, 0);
    assert.equal(Object.hasOwn(last, 'pendingNavigation'), false);
  });
  assert.equal(f.calls.length, 1); assert.equal(handle.result.metricObjectJudgements.length, 2);
  assert.equal(handle.collection, undefined);
});

test('receipt navigation excludes saved U/D and automatic rows, includes file quality, and preserves the full result', async t => {
  const f = await fixture(t), original = f.input.request.population.metrics.M01[0], truth = f.input.evidence.groundTruth;
  const missing = { ...truth.claims[0], claimId: 'R3', revisionId: 'R3@1', text: 'Deliver ./missing.txt.',
    applicabilityKind: 'CURRENT_TASK', expectedFiles: ['./missing.txt'] };
  truth.claims.push({ ...truth.claims[0], claimId: 'R2', revisionId: 'R2@1' }, missing);
  truth.version = 2; truth.digest = sha256(truth.claims);
  await fs.writeFile(f.input.request.groundTruthPath, JSON.stringify(truth));
  f.input.request.population.metrics.M01.push({ ...original, objectId: 'M01:R2', sourceId: 'R2', sourceRevisionId: 'R2@1' });
  f.input.request.population.metrics.M12 = [{ ...original, objectId: 'M12:R3', metricId: 'M12', sourceId: 'R3',
    sourceRevisionId: 'R3@1', description: missing.text, expectedFiles: missing.expectedFiles }];
  f.input.request.fileQualityReviewEnabled = true;
  f.input.request.artifactCandidates = [{ artifactId: 'spec', files: [{ path: 'spec.md', sha256: sha256(await fs.readFile(f.file)) }] }];
  const handle = await checkedVersionRun(f, async ({ brief, readAll, read, submit }) => {
    await readAll(); const checklist = await materializeStopChecklist(await submit('review_checklist', { stopClassification: 'TASK_COMPLETE', limit: 20 }), submit);
    assert.equal(checklist.items.find(item => item.taskId === 'M12:R3').savedResult.judgement, 'DEVIATION');
    const first = await f.result(submit, [], 'UNVERIFIED'), nav = first.pendingNavigation;
    assert.equal(first.pending, 2); assert.deepEqual(nav.pendingIds, ['M01:R2', 'file:spec.md']);
    assert.equal(nav.taskId, f.task.taskId); assert.equal(nav.reviewTaskId, brief.task.id);
    assert.equal(nav.groundTruthVersion, 2); assert.deepEqual(nav.classification, { stopClassification: 'TASK_COMPLETE', stage: null });
    const actual = await read(f.file);
    const second = await submit('submit_review', { taskId: 'M01:R2', verdict: 'DEVIATION', reason: 'The delivered value is incorrect.', citeIds: [actual.details.citation.citeId] });
    assert.deepEqual(second.pendingNavigation.pendingIds, ['file:spec.md']);
    await assert.rejects(submit('finish_stop_review', { summary: 'File quality is still missing.' }), /incomplete/);
    const last = await submit('submit_review', { taskId: 'file:spec.md', verdict: 'UNVERIFIED', reason: 'Quality is unresolved.', citeIds: [] });
    assert.equal(last.pending, 0); assert.notEqual(last.complete, true);
    assert.deepEqual(last.pendingNavigation.pendingIds, []); assert.equal(last.pendingNavigation.pendingTotal, 0);
    await submit('finish_stop_review', { summary: 'All original U/D and file-quality results are saved.' });
  });
  assert.deepEqual(handle.result.metricObjectJudgements.map(row => [row.objectId, row.judgement]).sort(),
    [['M01:R1', 'UNVERIFIED'], ['M01:R2', 'DEVIATION'], ['M12:R3', 'DEVIATION']]);
  assert.equal(handle.result.fileAssessments[0].status, 'UNVERIFIED'); await handle.close();
});

test('bounded exact pending IDs retain honest omissions and original pagination without leaking another review scope', async t => {
  let previous;
  for (const many of [true, false]) {
    const f = await fixture(t), original = f.input.request.population.metrics.M01[0];
    const ids = many ? ['M01:R1', 'M01:' + '长'.repeat(1300), ...Array.from({ length: 20 }, (_, index) => `M01:remaining-${index}`)] : ['M01:R1'];
    f.input.request.population.metrics.M01 = ids.map(objectId => ({ ...original, objectId }));
    const handle = await checkedVersionRun(f, async ({ brief, readAll, submit }) => {
      await readAll(); await f.scope(submit);
      const receipt = await f.result(submit, [], 'UNVERIFIED'), nav = receipt.pendingNavigation;
      assert.equal(nav.taskId, f.task.taskId); assert.equal(nav.reviewTaskId, brief.task.id);
      assert.equal(nav.pendingTotal, ids.length - 1); assert(nav.pendingIds.length <= 8);
      assert.equal(nav.omittedCount, nav.pendingTotal - nav.pendingIds.length);
      assert(nav.pendingIds.every(id => ids.slice(1).includes(id)));
      assert(Buffer.byteLength(JSON.stringify(nav)) <= 2048); assert(Buffer.byteLength(JSON.stringify(receipt)) <= 8192);
      assert.deepEqual(nav.checklist, { tool: 'review_checklist', arguments: { offset: 0, limit: 20 }, followNextOffset: true });
      if (many) {
        assert.equal(nav.pendingIds.length, 8); assert.equal(nav.omittedCount, 13);
        assert(!nav.pendingIds.includes(ids[1]));
        const page = await submit(nav.checklist.tool, nav.checklist.arguments);
        const listed = [...(await expandChecklist(submit, page)).items]; let next = page.next?.arguments
          ?? (page.nextOffset === null ? null : { offset: page.nextOffset, limit: 20 });
        while (next) {
          const following = await submit('review_checklist', next);
          assert(Buffer.byteLength(JSON.stringify(following)) <= 8192);
          listed.push(...(await expandChecklist(submit, following)).items); next = following.next?.arguments
            ?? (following.nextOffset === null ? null : { offset: following.nextOffset, limit: 20 });
        }
        assert.deepEqual(listed.map(item => item.taskId), ids);
        previous = nav;
      } else {
        assert.notEqual(nav.taskId, previous.taskId); assert.notEqual(nav.reviewTaskId, previous.reviewTaskId);
        assert.deepEqual(nav.pendingIds, []); assert.equal(nav.omittedCount, 0);
      }
      for (const taskId of ids.slice(1)) await submit('submit_review', { taskId, verdict: 'UNVERIFIED', reason: 'Original evidence remains unresolved.', citeIds: [] });
      await submit('finish_stop_review', { summary: 'The full original collection remains unverified.' });
    });
    assert.equal(handle.result.metricObjectJudgements.length, ids.length); await handle.close();
  }
});

test('navigation construction failure preserves successful save and original invalid-final rejection', async t => {
  const f = await fixture(t), original = f.input.request.population.metrics.M01[0];
  f.input.request.population.metrics.M01.push({ ...original, objectId: 'M01:R2' });
  let injected = false;
  const handle = await checkedVersionRun(f, async ({ readAll, submit }) => {
    await readAll(); await f.scope(submit);
    const byteLength = Buffer.byteLength;
    try {
      Buffer.byteLength = function (value, ...args) {
        if (typeof value === 'string' && value.includes('"kind":"workspace-stop-pending-v1"')) { injected = true; throw new Error('Navigation-only byte accounting unavailable'); }
        return byteLength(value, ...args);
      };
      assert.deepEqual(await f.result(submit, [], 'UNVERIFIED'), { saved: true, itemId: 'M01:R1', pending: 1 });
    } finally { Buffer.byteLength = byteLength; }
    assert.equal(injected, true);

    assert.equal((await submit('review_checklist', {})).pending, 1);
    const last = await submit('submit_review', { taskId: 'M01:R2', verdict: 'UNVERIFIED', reason: 'Proof remains unresolved.', citeIds: [], finish: true });
    assert.equal(last.complete, true); assert.equal(Object.hasOwn(last, 'pendingNavigation'), false);
  });
  assert(handle.result.metricObjectJudgements.every(row => row.judgement === 'UNVERIFIED')); await handle.close();
});

test('navigation cannot overflow an ordinary successful receipt or truncate its original item ID', async t => {
  const f = await fixture(t), original = f.input.request.population.metrics.M01[0], longId = 'M01:' + '长'.repeat(2600);
  f.input.request.population.metrics.M01 = [{ ...original, objectId: longId }, original];
  const handle = await checkedVersionRun(f, async ({ readAll, submit }) => {
    await readAll(); await f.scope(submit);
    const receipt = await submit('submit_review', { taskId: longId, verdict: 'UNVERIFIED', reason: 'Original proof remains unresolved.', citeIds: [] });
    assert.deepEqual(receipt, { saved: true, itemId: longId, pending: 1 });
    assert(Buffer.byteLength(JSON.stringify(receipt)) <= 8192);
    const last = await submit('submit_review', { taskId: 'M01:R1', verdict: 'UNVERIFIED', reason: 'Still unresolved.', citeIds: [], finish: true });
    assert.equal(last.complete, true); assert.equal(last.pending, 0);
  });
  assert.equal(handle.result.metricObjectJudgements[0].objectId, longId); await handle.close();
});

test('unknown citation IDs are rejected, notes stay context-only, and honest UNVERIFIED remains available', async t => {
  const f = await fixture(t);
  const handle = await f.run(async ({ readAll, read, submit, params }) => {
    await readAll(); await f.scope(submit);
    const unobserved = await read(f.file, { receipt: false });
    await assert.rejects(f.result(submit, ['unknown-citation'], 'DEVIATION'), /Unknown citation/);
    await submit('review_notes', { note: 'I claim the code passes.' });
    const notes = path.join(path.dirname(JSON.parse(params.prompt).task.basisFiles[0]), '..', 'notes.json');
    const note = await read(notes);
    assert.equal(note.details.contextOnly, true); assert.equal(note.details.citation, undefined);

    await f.result(submit, [], 'UNVERIFIED');
    await submit('finish_stop_review', { summary: 'Evidence is incomplete.' });
  });
  assert.equal(handle.result.metricObjectJudgements[0].judgement, 'UNVERIFIED');
});

test('a changed read dependency invalidates the review while unrelated edits do not', async t => {
  const f = await fixture(t);
  await assert.rejects(f.run(async ({ readAll, read, submit }) => {
    await readAll(); await f.scope(submit);
    const actual = await read(f.file);
    await fs.writeFile(path.join(f.root, 'unrelated.md'), 'An unrelated concurrent edit.\n');
    await f.result(submit, [actual.details.citation.citeId]);
    await fs.writeFile(f.file, 'The evidence changed after its item receipt.\n');
    await submit('finish_stop_review', { summary: 'A stale claim must not pass.' });
  }));
});

test('Git diff and untracked files are available as entry points without creating evidence receipts', async t => {
  const f = await fixture(t);
  execFileSync('git', ['init', '--quiet', f.root], { windowsHide: true });
  execFileSync('git', ['-C', f.root, 'add', 'spec.md'], { windowsHide: true });
  execFileSync('git', ['-C', f.root, '-c', 'user.name=RC Test', '-c', 'user.email=rc@example.invalid', '-c', 'core.hooksPath=NUL', 'commit', '--quiet', '-m', 'fixture'], { windowsHide: true });
  await fs.writeFile(f.file, 'Updated original value.\n');
  await fs.writeFile(path.join(f.root, 'new.md'), 'New untracked delivery.\n');
  const handle = await f.run(async ({ readAll, submit }) => {
    await readAll(); await f.scope(submit);
    const status = await submit('review_changes', {}); assert.match(status.text, /spec\.md/u); assert.match(status.text, /new\.md/u);
    assert.doesNotMatch(status.text, /\.runtime-correction/u, 'Program-owned notes and logs must not crowd the business change hints.');
    const diff = await submit('review_changes', { path: 'spec.md' }); assert.match(diff.text, /\+Updated original value/u);
    assert.equal(diff.navigationOnly, true);
    await f.result(submit, [], 'UNVERIFIED'); await submit('finish_stop_review', { summary: 'Diff alone is not acceptance evidence.' });
  });
  assert.equal(handle.sourceCitations.length, 0);
});

test('Windows Git change hints do not invent edits for unchanged long original paths', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  const long = path.join(f.root, ...Array.from({ length: 5 }, (_, index) => `${index}-` + 'original'.repeat(6)), 'long-business.md');
  assert(long.length > 300);
  await fs.mkdir(path.dirname(long), { recursive: true }); await fs.writeFile(long, 'Unchanged original document.\n');
  const git = args => execFileSync('git', ['-c', 'core.longpaths=true', '-C', f.root, ...args], { windowsHide: true });
  execFileSync('git', ['init', '--quiet', f.root], { windowsHide: true });
  git(['config', 'core.longpaths', 'false']);
  git(['add', '--', 'spec.md', long]);
  git(['-c', 'user.name=RC Test', '-c', 'user.email=rc@example.invalid', '-c', 'core.hooksPath=NUL', 'commit', '--quiet', '-m', 'original long path']);
  const handle = await f.run(async ({ readAll, submit }) => {
    await readAll(); await f.scope(submit);
    const status = await submit('review_changes', {});
    assert.doesNotMatch(status.text, /long-business\.md/u, 'An unchanged long path is not a source edit.');
    const diff = await submit('review_changes', { path: long }); assert.equal(diff.text, '');
    await f.result(submit, [], 'UNVERIFIED'); await submit('finish_stop_review', { summary: 'Navigation does not grant citations.' });
  });
  assert.equal(handle.sourceCitations.length, 0);
});

test('native batch edits and patch contents remain accessible as paged investigation hints', async t => {
  const f = await fixture(t);
  f.input.evidence.snapshot.entries.push({ type: 'assistant', message: { content: [
    { type: 'tool_use', id: 'native-edit', name: 'edit', input: { path: f.file,
      edits: Array.from({ length: 12 }, (_, index) => ({ oldText: `old ${index}`, newText: `new ${index}` })) } },
    { type: 'tool_use', id: 'native-patch', name: 'apply_patch', input: { input: '*** Begin Patch\n*** Update File: spec.md\n@@\n-before\n+patched value\n*** End Patch'.replaceAll('\n', '\r\n') } },
  ] } });
  const handle = await f.run(async ({ readAll, submit }) => {
    await readAll(); await f.scope(submit);
    const first = await submit('review_changes', {});
    assert.equal(first.navigationOnly, true); assert.equal(first.hostEditCount, 14); assert.equal(first.nextEditOffset, 10);
    const last = await submit('review_changes', { editOffset: first.nextEditOffset });
    assert.equal(last.nextEditOffset, null);
    const edits = [...first.hostEdits, ...last.hostEdits];
    assert.deepEqual(edits.filter(edit => edit.toolCallId === 'native-edit').map(edit => [edit.editIndex, edit.before, edit.after]),
      Array.from({ length: 12 }, (_, index) => [index, `old ${index}`, `new ${index}`]));
    assert(edits.every(edit => edit.path === f.file && edit.processFiles.length > 0));
    assert.match(edits.find(edit => edit.toolCallId === 'native-patch').patch, /\+patched value/u);
    assert.equal(edits[0].before, 'before'); assert.equal(edits[0].after, 'after');
    await f.result(submit, [], 'UNVERIFIED'); await submit('finish_stop_review', { summary: 'Edit hints do not establish acceptance.' });
  });
  assert.equal(handle.sourceCitations.length, 0);
});

test('incomplete review preserves checked items across one continuation and never claims the remaining checklist passed', async t => {
  const f = await fixture(t);
  f.input.request.population.metrics.M01.push({ ...f.input.request.population.metrics.M01[0], objectId: 'M01:R2', sourceId: 'R2' });
  const handle = await f.run(async ({ brief, readAll, read, submit }) => {
    if (brief.attempt === 1) {
      await readAll(); await f.scope(submit);
      const actual = await read(f.file); await f.result(submit, [actual.details.citation.citeId]);
      await submit('review_notes', { note: 'One item is saved, another still needs investigation.' });
    } else {
      const state = await submit('review_checklist', {});
      assert.equal(state.pending, 1); assert.equal(state.items[0].savedResult.judgement, 'PASS');
      assert.equal((await submit('review_notes', {})).notes.length, 1);
    }
  });
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].sessionId, f.calls[1].sessionId);
  assert.equal(handle.collection.complete, false);
  assert.equal(handle.result.metricObjectJudgements.length, 1);
  assert.equal(handle.result.metricObjectJudgements[0].judgement, 'PASS');
});

test('new files after a searched inventory invalidate the review instead of proving the earlier search complete', async t => {
  const f = await fixture(t);
  await assert.rejects(f.run(async ({ readAll, read, submit, tools }) => {
    await readAll(); await f.scope(submit);
    await tools.get('source_find').execute(crypto.randomUUID(), { path: f.root, pattern: 'spec.md' });
    const original = await read(f.file);
    await fs.writeFile(path.join(f.root, 'new-writer.mjs'), 'export const value = 0;\n');
    await f.result(submit, [original.details.citation.citeId]);
  }));
});

test('runtime output ancestors are navigable while original files and other directory inventories stay frozen', async t => {
  for (const [name, runtimeOutput, changeEvidence, rejected] of [
    ['new runtime sibling', true, false, false],
    ['changed external evidence', true, true, true],
    ['changed ordinary external inventory', false, false, true],
  ]) await t.test(name, async t => {
    const f = await fixture(t);
    const shared = path.join(path.dirname(f.root), 'shared-' + path.basename(f.root));
    const runtime = path.join(shared, 'runtime'), reference = path.join(shared, 'reference.md');
    const diagnostic = path.join(shared, 'progress.log');
    await fs.mkdir(runtime, { recursive: true });
    t.after(() => fs.rm(shared, { recursive: true, force: true }));
    await fs.writeFile(reference, 'Original external dependency.\n');
    await fs.writeFile(diagnostic, 'Runtime dependency progress.\n');
    if (runtimeOutput) f.input.excludedEvidencePaths = [runtime];
    const run = f.run(async ({ readAll, read, submit, tools }) => {
      await readAll(); await f.scope(submit);
      await tools.get('source_ls').execute(crypto.randomUUID(), { path: shared });
      await tools.get('source_grep').execute(crypto.randomUUID(), { path: shared, pattern: 'dependency', includeGenerated: true });
      const external = await read(reference);
      assert.notEqual(external.details.contextOnly, true);
      const actual = await read(f.file);
      await fs.writeFile(path.join(shared, 'new-output.json'), '{}\n');
      await fs.appendFile(diagnostic, 'A new observation arrived.\n');
      if (changeEvidence) await fs.writeFile(reference, 'Changed external dependency.\n');
      await f.result(submit, [actual.details.citation.citeId]);
      await submit('finish_stop_review', { summary: 'Current source and original dependencies checked.' });
    });
    if (rejected) await assert.rejects(run, { code: 'BASELINE_INPUT_CHANGED' });
    else assert.equal((await run).result.metricObjectJudgements[0].judgement, 'PASS');
  });
});

test('one session reuses source reads across implementation obligations while retaining M16 tracing', async t => {
  const f = await fixture(t), source = path.join(f.root, 'app.mjs'), testFile = path.join(f.root, 'app.test.mjs');
  await fs.writeFile(source, 'export const accept = value => value;\n'); await fs.writeFile(testFile, 'assert.equal(accept(1), 1);\n');
  const original = f.input.request.population.metrics.M01[0];
  f.input.request.population.metrics = Object.fromEntries(['M09', 'M12', 'M16'].map(id => [id, [{ ...original, objectId: `${id}:R1`, metricId: id, verificationTarget: 'IMPLEMENTATION' }]]));
  f.input.evidence.snapshot.entries.push({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'verify', name: 'Bash', input: { command: 'node --test' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'verify', content: 'Exit code 0; verification passed.' }] } });
  const handle = await f.run(async ({ brief, readAll, read, submit, tools }) => {
    assert.equal(brief.task.evidencePriority, 'CURRENT_SOURCE');
    assert.deepEqual(brief.task.processFiles, []);
    await readAll(); const scope = await f.scope(submit);
    assert.equal(scope.processNavigationOmitted, true);
    assert.deepEqual(scope.processFiles, []);
    const sourceChecklist = await submit('review_checklist', {});
    assert.equal(sourceChecklist.total, 3);
    assert.equal(sourceChecklist.processEvidence, undefined);
    assert.equal(sourceChecklist.processReadPlan, undefined);
    assert(sourceChecklist.items.every(item => item.proofOwners.length === 1 && item.proofOwners[0] === 'SOURCE'));
    assert.deepEqual(tools.get('submit_review').parameters.properties.productionTrace.required,
      ['entryPoint', 'actualInput', 'producerToConsumer', 'stateful', 'statelessReason', 'stateTargets', 'targetRelations']);
    const sourceRead = await read(source), testRead = await read(testFile), id = sourceRead.details.citation.citeId;
    const save = (metricId, ids, extra = {}) => submit('submit_review', { taskId: `${metricId}:R1`, verdict: 'PASS', reason: 'The original value flows directly to the production result.', citeIds: ids, ...extra });


    await assert.rejects(save('M16', [id], { productionTrace: { version: 1, entryPoint: 'accept(value)', actualInput: 'Caller supplied value',
      producerToConsumer: 'The input flows directly to the return.', stateful: false, statelessReason: 'No state.', stateTargets: [] } }), /targetRelations/);

    await save('M09', [id]);
    await save('M16', [id], { productionTrace: { version: 1, entryPoint: 'accept(value)', actualInput: 'Caller supplied value',
      producerToConsumer: 'The input parameter flows unchanged to the arrow return.', stateful: false,
      statelessReason: 'This production function has no state reads or writes.', stateTargets: [], targetRelations: [] } });
    const restored = await submit('review_checklist', { includeProcessEvidence: true });
    assert.equal(restored.processReadPlan.navigationOnly, true);
    assert.equal(restored.total, sourceChecklist.total);
    assert.equal(restored.pending, 1);
    assert.equal(restored.processEvidence.executionResultFileCount, 1);
    const restoredScope = await submit('review_scope', { stopClassification: 'TASK_COMPLETE', summary: 'Recover the same scope for a process-evidence investigation.', includeProcessEvidence: true });
    assert.equal(restoredScope.reused, true);
    assert.deepEqual(restoredScope.processFiles, restored.processFiles);
    await read(restored.processFiles.find(file => file.endsWith('000002-0000.txt')));
    const process = await read(restored.processFiles.find(file => file.endsWith('000003-0000.txt')));

    await save('M12', [id]);
    await submit('finish_stop_review', { summary: 'All three original items have separate checked receipts.' });
  });
  assert.equal(f.calls.length, 1);
  assert.deepEqual(handle.result.metricObjectJudgements.map(row => row.objectId).sort(), ['M09:R1', 'M12:R1', 'M16:R1']);
  assert.equal(handle.sourceCitations.filter(citation => citation.path === source).length, 3);
  assert.equal(handle.proofs['M16:R1'].sourceCiteIds.length, 1);
});

test('missing execution records remain visible for a reviewer to record unresolved execution', async t => {
  const f = await fixture(t), original = f.input.request.population.metrics.M01[0];
  f.input.request.population.metrics = { M12: [{ ...original, objectId: 'M12:R1', metricId: 'M12', verificationTarget: 'PROCESS' }] };
  const handle = await f.run(async ({ readAll, read, submit }) => {
    await readAll(); const scope = await f.scope(submit), process = await read(scope.processFiles[0]);
    const checklist = await materializeStopChecklist(await submit('review_checklist', {}), submit);
    assert.deepEqual(checklist.items[0].executionProof, { forVerdicts: ['PASS', 'DEVIATION'], availableResultFileCount: 0 });
    assert.equal(checklist.processEvidence.navigationOnly, true);
    assert.equal(checklist.processEvidence.executionResultFileCount, 0);


    await submit('submit_review', { taskId: 'M12:R1', verdict: 'UNVERIFIED', reason: 'No attributed execution result is available.', citeIds: [] });
    await submit('finish_stop_review', { summary: 'Execution remains unverified.' });
  });
  assert.equal(handle.result.metricObjectJudgements[0].judgement, 'UNVERIFIED'); assert.deepEqual(handle.result.findings, []);
});

test('a mixed checklist keeps direct late invocation/result navigation without granting proof from the guide', async t => {
  const f = await fixture(t), original = f.input.request.population.metrics.M01[0];
  f.input.request.population.metrics = { M12: [{ ...original, objectId: 'M12:R1', metricId: 'M12', verificationTarget: 'PROCESS' }] };
  f.input.request.population.metrics.M16 = [{ ...original, objectId: 'M16:R1', metricId: 'M16', verificationTarget: 'IMPLEMENTATION' }];
  f.input.evidence.snapshot.entries.push(...Array.from({ length: 25 }, (_, index) => ({ type: 'assistant', message: { content: `Earlier observation ${index}.` } })),
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'late-run', name: 'Bash', input: { command: 'node --test' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'late-run', content: 'Exit code 0; tests passed.' }] } });
  const handle = await f.run(async ({ readAll, read, submit }) => {
    await readAll(); const checklist = await expandChecklist(submit, await submit('review_checklist', { stopClassification: 'TASK_COMPLETE' }));
    assert.equal(checklist.total, 2);
    assert.notEqual(checklist.processNavigationOmitted, true);
    assert.equal(checklist.processEvidence.executionResultFileCount, 1);
    const sample = checklist.processEvidence.executionSamples[0];
    assert(!checklist.processFiles.includes(sample.resultFile), 'The execution lies beyond the first navigation page.');
    assert.equal(sample.invocationFileCount, 1); assert.equal(sample.invocationFiles.length, 1);
    const [pair] = checklist.processEvidence.recentExecutionPairs;
    assert.equal(pair.toolName, 'Bash');
    assert.deepEqual(pair.invocationFiles.map(file => path.resolve(f.root, file)), sample.invocationFiles);
    assert.deepEqual(pair.resultFiles.map(file => path.resolve(f.root, file)), [sample.resultFile]);
    const save = citeIds => submit('submit_review', { taskId: 'M12:R1', verdict: 'PASS', reason: 'The matching original invocation and successful result were read.', citeIds, finish: true });

    const result = await read(pair.resultFiles[0]);

    await read(pair.invocationFiles[0]);
    await submit('submit_review', { taskId: 'M16:R1', verdict: 'UNVERIFIED', reason: 'Current implementation has not been reviewed yet.', citeIds: [] });
    await save([result.details.citation.citeId]);
  });
  assert.equal(f.calls.length, 1);
  assert.equal(handle.result.metricObjectJudgements.find(row => row.objectId === 'M12:R1').judgement, 'PASS');
  assert.equal(handle.result.metricObjectJudgements.find(row => row.objectId === 'M16:R1').judgement, 'UNVERIFIED');
});

test('recent process navigation groups completed calls and leaves ambiguous or older records in the original history', async t => {
  const f = await fixture(t), original = f.input.request.population.metrics.M01[0];
  f.input.request.population.metrics = { M12: [{ ...original, objectId: 'M12:R1', metricId: 'M12', verificationTarget: 'PROCESS' }] };
  const call = (id, name, input = {}) => ({ type: 'tool_use', id, name, input });
  const result = (tool_use_id, content, is_error = false) => ({ type: 'tool_result', tool_use_id, content, is_error });
  const entries = f.input.evidence.snapshot.entries;
  const append = (type, ...content) => {
    entries.push({ type, message: { content } });
    return String(entries.length - 1).padStart(6, '0');
  };
  append('assistant', call('first', 'Check', { action: 'compile' }));
  const firstResult = append('user', result('first', 'Compiled.'));
  for (let index = 0; index < 10; index++) {
    append('assistant', call(`older-${index}`, 'Earlier', { action: `check-${index}` }));
    append('user', result(`older-${index}`, 'Ran.'));
  }
  const recentCall = append('assistant', call('compile', 'Check', { action: 'compile' }), call('test', 'Check', { operation: 'test' }));
  const recentResult = append('user', result('compile', 'Failed to compile.', true), result('test', 'Ran tests.'.repeat(2500)));
  append('assistant', call('open', 'Check', { action: 'compile' }));
  append('assistant', call('duplicate-call', 'AmbiguousCall'), call('duplicate-call', 'AmbiguousCall'), call('duplicate-result', 'AmbiguousResult'));
  append('user', result('duplicate-call', 'One result.'), result('duplicate-result', 'First.'), result('duplicate-result', 'Second.'));
  append('user', result('out-of-order', 'Before invocation.'));
  append('assistant', call('out-of-order', 'OutOfOrder'), call('unsafe-label', 'Inspect', { action: 'arbitrary free text', operation: { name: 'nested' } }));
  const lastResult = append('user', result('out-of-order', 'After invocation.'), result('unsafe-label', 'Inspected.'));

  let navigation;
  const handle = await f.run(async ({ readAll, submit }) => {
    await readAll();
    navigation = (await expandChecklist(submit, await submit('review_checklist', { stopClassification: 'TASK_COMPLETE' }))).processEvidence;
    await submit('submit_review', { taskId: 'M12:R1', verdict: 'UNVERIFIED', reason: 'Navigation alone provides no execution proof.', citeIds: [], finish: true });
  });
  const { executionSamples, recentExecutionPairs } = navigation;
  assert.equal(path.basename(executionSamples[0].resultFile), `${firstResult}-0000.txt`);
  assert(recentExecutionPairs.length >= 3 && recentExecutionPairs.length <= 8);
  assert(Buffer.byteLength(JSON.stringify(recentExecutionPairs)) <= 3072);
  assert.deepEqual(recentExecutionPairs.slice(0, 3).map(pair => [pair.toolName, pair.operation]),
    [['Inspect', undefined], ['Check', 'compile'], ['Check', 'test']]);
  assert(recentExecutionPairs.slice(3).every(pair => pair.toolName === 'Earlier'));
  for (const pair of recentExecutionPairs.slice(1, 3)) {
    assert.deepEqual(pair.invocationFiles.map(file => path.basename(file)), [`${recentCall}-0000.txt`]);
    assert.deepEqual(pair.resultFiles.map(file => path.basename(file)), [`${recentResult}-0000.txt`, `${recentResult}-0001.txt`]);
  }
  assert.equal(path.basename(recentExecutionPairs[0].resultFiles[0]), `${lastResult}-0000.txt`);
  assert.equal(handle.result.metricObjectJudgements[0].judgement, 'UNVERIFIED');
});

test('optional file quality shares the session and requires the actual declared delivery bytes', async t => {
  const f = await fixture(t), other = path.join(f.root, 'other.md'); await fs.writeFile(other, 'An unrelated file.\n');
  f.input.request.fileQualityReviewEnabled = true;
  f.input.request.artifactCandidates = [{ artifactId: 'spec', files: [{ path: 'spec.md', sha256: sha256(await fs.readFile(f.file)) }] }];
  f.input.request.workflowArtifacts = [{ name: 'spec', stage: 'design', metrics: ['M01'] }];
  const handle = await f.run(async ({ readAll, read, submit }) => {
    await readAll(); await submit('review_scope', { stopClassification: 'STAGE_COMPLETE', stage: 'design', summary: 'The design delivery is complete.' });
    const unrelated = await read(other);
    const quality = ids => submit('submit_review', { taskId: 'file:spec.md', verdict: 'PASS', reason: 'The declared document content is correct.', citeIds: ids });
    await assert.rejects(quality([unrelated.details.citation.citeId]), /actual current delivery/);
    const actual = await read(f.file); await quality([actual.details.citation.citeId]); await f.result(submit, [actual.details.citation.citeId]);
    await submit('finish_stop_review', { summary: 'Metric and file quality have independent receipts.' });
  });
  assert.equal(f.calls.length, 1); assert.equal(handle.result.fileAssessments[0].status, 'PASS');
});

test('cancellation rejects late submissions and cannot return a partial success', async t => {
  const f = await fixture(t), controller = new AbortController();
  await assert.rejects(f.run(async ({ readAll, read, submit }) => {
    await readAll(); await f.scope(submit); const actual = await read(f.file);
    controller.abort(new Error('The business input was replaced.'));
    await assert.rejects(f.result(submit, [actual.details.citation.citeId]));
  }, { abortSignal: controller.signal }));
});

test('M08 exposes original Skill conditions and dependencies within the same review session', async t => {
  const f = await fixture(t), skillId = 'verify-original', sourceRoot = path.join(f.root, 'skills', skillId);
  await fs.mkdir(path.join(sourceRoot, 'references'), { recursive: true });
  await fs.writeFile(path.join(sourceRoot, 'SKILL.md'), '# Original Skill\nRun verification before completion. Preserve the original input; see references/conditions.md.\n');
  await fs.writeFile(path.join(sourceRoot, 'references/conditions.md'), 'The original input must remain unchanged even if optional configuration is absent.\n');
  const source = await scanSkillDirectory(sourceRoot);
  const saved = await persistSkillGroundTruth({ projectRoot: f.root, taskId: f.task.taskId, skillId, skillDigest: source.digest,
    constraints: [{ constraintId: 'verify', statement: 'Run verification before completion.', modality: 'MUST', kind: 'STEP', sourceRef: 'SKILL.md#L2', dependsOn: ['preserve'] },
      { constraintId: 'preserve', statement: 'Preserve the original input.', modality: 'MUST', kind: 'CONDITION', sourceRef: 'references/conditions.md#L1' }], taskOverlays: [] });
  f.input.request.population.metrics = { M08: saved.document.constraints.map(constraint => ({ objectId: `M08:${skillId}:${constraint.constraintId}`, metricId: 'M08',
    sourceId: `${skillId}:${constraint.constraintId}`, sourceRevisionId: `${skillId}@${saved.document.version}`, description: constraint.statement,
    skillId, authority: 'MATERIAL_DERIVED', hard: true, verificationTarget: 'PROCESS' })) };
  const handle = await f.run(async ({ readAll, read, submit }) => {
    await readAll(); const scope = await f.scope(submit), process = await read(scope.processFiles[0]);
    const save = item => submit('submit_review', { taskId: item.objectId, verdict: 'PASS', reason: 'Original conditions and attributed process evidence were checked.', citeIds: [process.details.citation.citeId] });
    const checklist = await materializeStopChecklist(await submit('review_checklist', {}), submit);

    const readFiles = new Set();
    for (const item of checklist.items) for (const file of item.originalSkillBasis.requiredFiles) if (!readFiles.has(file)) { await read(file); readFiles.add(file); }
    assert(readFiles.has(path.join(sourceRoot, 'SKILL.md'))); assert(readFiles.has(path.join(sourceRoot, 'references/conditions.md')));
    for (const item of checklist.items) await save(item);
    await submit('finish_stop_review', { summary: 'Both original Skill obligations were separately checked in one session.' });
  });
  assert.equal(f.calls.length, 1); assert.equal(handle.result.metricObjectJudgements.length, 2);
});

test('M08 workspace Stop reads the exact adopted duplicate source instead of a higher-priority short name', async t => {
  const f = await fixture(t), skillId = 'duplicate-skill', workspace = path.join(f.root, 'skills', skillId);
  const extra = path.join(f.root, 'extra-skills'), selected = path.join(extra, skillId);
  await fs.mkdir(workspace, { recursive: true }); await fs.mkdir(selected, { recursive: true });
  await fs.writeFile(path.join(workspace, 'SKILL.md'), 'Follow the different workspace instructions.\n');
  await fs.writeFile(path.join(selected, 'SKILL.md'), 'Verify the selected original delivery.\n');
  const file = await fs.realpath(path.join(selected, 'SKILL.md'));
  const sourceIdentity = { path: file, sha256: sha256(await fs.readFile(file)) };
  const source = await scanSkillDirectory(selected, { sourceIdentity });
  const graph = bindSkillGraph(skillGraphCandidate(source), source);
  const saved = await persistSkillGroundTruth({ projectRoot: f.root, taskId: f.task.taskId, skillId,
    skillDigest: source.digest, ...graph });
  const population = await buildMetricPopulation({ projectRoot: f.root, taskId: f.task.taskId,
    groundTruth: { version: 0, claims: [] }, skillDocuments: [saved.document] });
  assert(population.metrics.M08.length);
  f.input.request.population.metrics = { M08: population.metrics.M08 };
  f.input.skillRoots = [extra]; f.input.hostAdapter = openclawHost;
  const handle = await f.run(async ({ readAll, read, submit }) => {
    await readAll(); const scope = await f.scope(submit), process = await read(scope.processFiles[0]);
    const checklist = await materializeStopChecklist(await submit('review_checklist', {}), submit), disclosed = new Set();
    for (const item of checklist.items) {
      assert.equal(item.originalSkillBasis.error, undefined);
      assert(item.originalSkillBasis.requiredFiles.includes(file));
      assert.equal(item.originalSkillBasis.requiredFiles.includes(path.join(workspace, 'SKILL.md')), false);
      for (const path of item.originalSkillBasis.requiredFiles) if (!disclosed.has(path)) { await read(path); disclosed.add(path); }
      await submit('submit_review', { taskId: item.objectId, verdict: 'PASS',
        reason: 'The exact selected original and its attributed execution were checked.', citeIds: [process.details.citation.citeId] });
    }
    await submit('finish_stop_review', { summary: 'The selected original stayed bound through M08 Stop.' });
  });
  assert.equal(handle.result.metricObjectJudgements.length, population.metrics.M08.length);
  await handle.close();
});

test('mixed Skill applicability, missing execution and real implementation keep independent verdicts and the full denominator', async t => {
  const f = await fixture(t), source = path.join(f.root, 'app.mjs');
  await fs.writeFile(source, 'export const accept = value => value + 1;\n');
  const claims = [
    { claimId: 'R1', text: 'Allowed inputs for accept(value) are finite numbers only; non-number inputs are outside scope. Return each allowed input plus one without state.', verificationTarget: 'IMPLEMENTATION' },
    { claimId: 'R2', text: 'Actually run node --test before completion, independently of Skill applicability.', verificationTarget: 'PROCESS' },
  ].map(claim => ({ ...claim, revisionId: `${claim.claimId}@1`, category: 'requirements', status: 'ACTIVE', severity: 'HARD', authority: 'USER_EXPLICIT', applicabilityKind: 'CURRENT_TASK' }));
  const truth = { version: 1, digest: sha256(claims), claims };
  f.input.evidence.groundTruth = truth;
  await fs.writeFile(f.input.request.groundTruthPath, JSON.stringify(truth));
  f.input.evidence.snapshot.entries = [{ type: 'user', message: { content: claims.map(claim => claim.text).join('\n') } },
    { type: 'assistant', message: { content: 'The implementation and verification are complete.' } }];
  const external = path.join(path.dirname(f.root), `skills-${path.basename(f.root)}`);
  t.after(() => fs.rm(external, { recursive: true, force: true }));
  f.input.skillRoots = [external];
  const skill = await prepareMixedSkillEvaluation({ projectRoot: f.root, taskId: f.task.taskId, skillRoots: [external] });
  const population = await buildMetricPopulation({ projectRoot: f.root, taskId: f.task.taskId, groundTruth: truth, skillDocuments: [skill] });
  f.input.request.population = { ...population, metrics: Object.fromEntries(Object.entries(population.metrics).filter(([id]) => ['M08', 'M12', 'M16'].includes(id))) };
  const conditionAssessment = { activation: 'INACTIVE_AT_CURRENT_BOUNDARY', evidenceKind: 'PROCESS_EVENT',
    reason: 'The complete original user input establishes a numeric-only task outside the array branch.' };
  assert.deepEqual(Object.values(f.input.request.population.metrics).flat().map(item => item.objectId).sort(), Object.keys(MIXED_SKILL_EXPECTED).sort());
  const handle = await f.run(async ({ readAll, read, submit }) => {
    await readAll(); const checklist = await materializeStopChecklist(await submit('review_checklist', { stopClassification: 'TASK_COMPLETE' }), submit);
    assert.equal(checklist.total, 4); assert.equal(checklist.pending, 4);
    const skillItem = checklist.items.find(item => item.metricId === 'M08');
    assert.deepEqual(skillItem.proofOwners, ['PROCESS']);
    assert.deepEqual(checklist.items.find(item => item.metricId === 'M16').proofOwners, ['SOURCE']);
    assert.deepEqual(checklist.items.find(item => item.objectId === 'M12:R1').proofOwners, ['SOURCE']);
    assert.deepEqual(checklist.items.find(item => item.objectId === 'M12:R2').proofOwners, ['PROCESS']);
    assert.equal(checklist.processEvidence.originalUserFiles[0], checklist.processFiles[0]);
    assert.equal(checklist.processEvidence.originalUserFileCount, 1);
    const process = await read(checklist.processFiles[0]), processId = process.details.citation.citeId;

    for (const file of skillItem.originalSkillBasis.requiredFiles) await read(file);
    assert(skillItem.originalSkillBasis.requiredFiles.some(file => file.endsWith(`${path.sep}conditions.md`)), 'The dependent MAY condition remains mandatory source for the MUST step.');
    const actual = await read(source);

    assert.equal((await submit('review_checklist', {})).pending, 4, 'Hints and rejected submissions cannot auto-fill the checklist.');
    await submit('submit_review', { taskId: skillItem.objectId, verdict: 'NOT_APPLICABLE',
      reason: 'The original numeric-only task does not activate the array-only Skill step; the separate user execution request remains mandatory.', citeIds: [processId], conditionAssessment });
    await submit('submit_review', { taskId: 'M12:R1', verdict: 'PASS', reason: 'The explicitly required implementation increments its numeric input without state.', citeIds: [actual.details.citation.citeId] });
    await submit('submit_review', { taskId: 'M12:R2', verdict: 'UNVERIFIED',
      reason: 'No attributable invocation and execution result establish the requested node --test run.', citeIds: [] });
    await submit('submit_review', { taskId: 'M16:R1', verdict: 'PASS', reason: 'The exported numeric input flows through value + 1 directly to its caller without shared state.',
      citeIds: [actual.details.citation.citeId], productionTrace: { version: 1, entryPoint: 'Exported accept(value)', actualInput: 'Numeric caller input',
        producerToConsumer: 'The numeric input is incremented and returned directly to the importing caller.', stateful: false,
        statelessReason: 'The complete module contains only a pure expression and no state reads or writes.', stateTargets: [], targetRelations: [] }, finish: true });
  });
  assert.equal(f.calls.length, 1);
  assert.deepEqual(Object.fromEntries(handle.result.metricObjectJudgements.map(row => [row.objectId, row.judgement])), MIXED_SKILL_EXPECTED);
});

test('reading or searching mutable RC notes and logs neither grants proof nor invalidates original business evidence', async t => {
  const f = await fixture(t);
  const handle = await f.run(async ({ readAll, read, submit, tools, brief }) => {
    await readAll(); await f.scope(submit);
    const directory = path.dirname(path.dirname(brief.task.basisFiles[0])), log = path.join(directory, 'runtime-log.json');
    await fs.writeFile(log, 'This mutable RC log is only context.\n');
    await tools.get('source_grep').execute(crypto.randomUUID(), { path: directory, pattern: 'context', includeGenerated: true });
    const page = await read(log); assert.equal(page.details.contextOnly, true);
    await fs.appendFile(log, 'Another diagnostic arrived.\n');
    const original = await read(f.file); await f.result(submit, [original.details.citation.citeId]);
    await submit('finish_stop_review', { summary: 'Only original business evidence determines this result.' });
  });
  assert.equal(handle.result.metricObjectJudgements[0].judgement, 'PASS');
  assert(handle.reviewEvidence.files.every(file => !/runtime-log|observations\.jsonl|review-checkpoint|history-index/u.test(file)));
});

test('scope recovery is idempotent and rejects irrelevant stage text', async t => {
  const f = await fixture(t); let callbacks = 0;
  f.input.onScope = async () => { callbacks++; return null; };
  f.input.request.fixedStopClassification = { stopClassification: 'TASK_COMPLETE', stage: null };
  const handle = await f.run(async ({ readAll, submit }) => {
    await readAll();
    await assert.rejects(submit('review_scope', { stopClassification: 'TASK_COMPLETE', stage: 'implementation', summary: 'Completion.' }), /Only STAGE_COMPLETE/);
    const scope = await submit('review_scope', { stopClassification: 'TASK_COMPLETE', summary: 'Completion.' });
    assert.equal(scope.stage, null);
    const repeated = await f.scope(submit); assert.equal(repeated.reused, true);
    await assert.rejects(submit('review_scope', { stopClassification: 'INTERMEDIATE', summary: 'Changed scope.' }), /already fixed/);
    await f.result(submit, [], 'UNVERIFIED'); await submit('finish_stop_review', { summary: 'Unverified item saved.' });
  });
  assert.equal(callbacks, 1); assert.equal(handle.result.stopClassification, 'TASK_COMPLETE');
});

const frameBasis = {
  guidance: [{ id: 'G1', statement: 'Keep the public transform signature.', contractCell: 'owner_signature',
    evidence: [{ path: 'app.mjs', startLine: 1, endLine: 1 }], confidence: 0.95 }],
  scenarios: ['S1', 'S2', 'S3'].map(id => ({ id, kind: 'requirement', quote: 'Return the input plus one.',
    given: 'input is a number', when: 'transform is called', then: 'return the input plus one', confidence: 0.9 })),
};
const unverifiedFrame = () => [...frameBasis.guidance, ...frameBasis.scenarios].map(({ id }) =>
  ({ id, disposition: 'UNVERIFIED', reason: 'Could not independently verify the advisory item.' }));
const reproductionText = `For each deviation above:
1. First reproduce it with a minimal public check (an existing test, a command, or a throwaway script in the system temp directory that you delete afterwards) and confirm that it fails.
2. After the fix, rerun the same check and confirm that it passes; also run one nearby existing-behavior check to confirm that nothing else broke.
3. If you cannot reproduce it, explain why and do not change unrelated code just to pass the review.`;
const chineseReproduction = `处理上面每个偏差时：
1. 先用一个最小的公开检查复现它（现有测试、命令，或放在系统临时目录、用完即删的临时脚本），确认它确实失败。
2. 修改后再运行同一个检查，确认通过；再运行一个相邻的已有行为检查，确认原有行为没有被破坏。
3. 如果无法复现，说明原因，不要为了通过评审而改动无关代码。`;

async function frameStopCase(t, { enabled = true, review = true, stored = 'matching', deviation = false, locale = 'en', openClaw = true,
  basis = frameBasis, checks = null, checkSources = {}, metricIds = ['M16'], deviationOnly = true,
  userText = 'Implement transform.\nReturn the input plus one.', processEntries = [], effectiveToolPolicy, sourceText,
  requireCurrentProductionCoverage, requireProductionOriginCoverage, artifacts = [] } = {}) {
  const f = await stopProtocolFixture(t, 'findings');
  const projectRoot = f.root, sessionId = 'protocol-host', directory = path.join(projectRoot, '.runtime-correction', 'host');
  const source = path.join(projectRoot, 'app.mjs'), transcript = path.join(projectRoot, 'session.jsonl');
  await fs.writeFile(source, sourceText ?? `export const transform = input => ${deviation ? 'input' : 'input + 1'};\n`);
  const entries = [
    { type: 'user', uuid: 'user-original', message: { role: 'user', content: userText } },
    ...processEntries,
    { type: 'assistant', uuid: 'assistant-complete', message: { role: 'assistant', content: 'Task complete.' } },
  ];
  await fs.writeFile(transcript, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  const git = (...args) => execFileSync('git', ['-C', projectRoot, ...args], { windowsHide: true, encoding: 'utf8' });
  git('init', '--quiet');
  git('-c', 'core.autocrlf=false', 'add', '--', 'app.mjs');
  git('-c', 'user.name=Frame Test', '-c', 'user.email=frame@example.test', 'commit', '-qm', 'task start');
  const startHead = git('rev-parse', 'HEAD').trim();
  assert.equal(await captureTaskStart({ projectRoot, taskId: f.task.taskId }), true);
  if (stored !== 'missing') {
    const frameDirectory = path.join(projectRoot, '.runtime-correction', 'requirement-frame', sha256(sessionId).slice(0, 24));
    await atomicWriteJson(path.join(frameDirectory, 'frame.json'), { schemaVersion: 1, status: 'ready', reason: null, sessionId,
      startHead: stored === 'mismatch' ? 'another-head' : startHead, ...basis, ...(checks ? { checks } : {}) });
    for (const [name, text] of Object.entries(checkSources)) {
      await fs.mkdir(path.join(frameDirectory, 'sources'), { recursive: true });
      await fs.writeFile(path.join(frameDirectory, 'sources', name), text);
    }
  }
  const runtimeV2 = compileRuntimeV2Config({ version: 2, locale, dynamicGroundTruth: { enabled: false },
    requirementFrame: { enabled, inject: false, review },
    stopCorrection: { enabled: true, originalRequirementsBasis: true, deviationOnly, waitMode: 'until_pass',
      ...(requireCurrentProductionCoverage === undefined ? {} : { requireCurrentProductionCoverage }),
      ...(requireProductionOriginCoverage === undefined ? {} : { requireProductionOriginCoverage }),
      metrics: Object.fromEntries(Array.from({ length: 16 }, (_, i) => `M${String(i + 1).padStart(2, '0')}`).map(id => [id, metricIds.includes(id)])) } });
  return { projectRoot, sessionId, directory, source, runtimeV2, startHead,
    async run(script, beforeStop) {
      let scriptError, handle;
      const reviewerFactory = async input => {
        assert.equal(input.role, 'stop-reviewer');
        assert.equal(input.request.taskChanges.startHead, startHead);
        handle = await scriptedWorkspaceReview(input, { script: async tools => {
          try { await script(tools, input); }
          catch (error) { scriptError = error; throw error; }
        } });
        return handle;
      };
      const event = (hook_event_name, fields) => handleRuntimeV2Event({
        projectRoot, plan: { runtimeV2, artifacts }, reviewerFactory,
        stopHost: { directory, startProtocol: { version: 1 }, stopId: 'frame-stop', openClaw, effectiveToolPolicy },
        input: { hook_event_name, session_id: sessionId, cwd: projectRoot, transcript_path: transcript,
          last_assistant_message: 'Task complete.', ...fields },
      });
      await event('SessionStart', { source: 'startup' });
      await beforeStop?.(f.task.taskId);
      const outcome = await event('Stop');
      if (scriptError) throw scriptError;
      assert(handle?.result || outcome.stop?.reused === true, JSON.stringify(outcome.stop));
      return { stop: outcome.stop, handle };
    },
  };
}

const submitFrameTool = async (call, name, args) => JSON.parse((await call(name, args)).content[0].text);
const frameFinishArgs = frameDispositions => ({
  summary: 'Finished checking the original requirements.',
  ...(frameDispositions === undefined ? {} : { frameDispositions }),
});

test('production Stop writes large semantic navigation as readable JSON before starting its reviewer', async t => {
  const f = await frameStopCase(t, { basis: { guidance: [], scenarios: [] } });
  const functions = Array.from({ length: 6 }, (_, index) => {
    const name = `changed_${index}_${'detail'.repeat(85)}`;
    const caller = `caller_${index}_${'consumer'.repeat(65)}`;
    return `export function ${name}(input) { return input + 1; }\nexport function ${caller}(input) { return ${name}(input); }`;
  }).join('\n');
  await fs.writeFile(f.source, functions + '\n');
  let reviewerStarted = false;
  const { handle } = await f.run(async tools => {
    reviewerStarted = true;
    for (const file of tools.task.basisFiles) await tools.read(file);
    const original = tools.task.basisFiles.find(file => path.basename(file).startsWith('user-original-'));
    const citeId = await tools.read(original);
    await submitFrameTool(tools.call, 'set_original_checklist', { items: [{ metricId: 'M16', verificationTarget: 'IMPLEMENTATION',
      text: 'Return the input plus one.', citeId, lineStart: 2, lineEnd: 2 }] });
    const checklist = await submitFrameTool(tools.call, 'review_checklist', { stopClassification: 'TASK_COMPLETE', completionClaim: true });
    const links = checklist.items.find(item => item.programStanding === 'REGRESSION')?.regressionEvidence?.semanticNavigationFiles;
    assert(links?.length, 'the real graph crosses the navigation size limit');
    const parts = await Promise.all(links.map(file => fs.readFile(file, 'utf8')));
    const navigation = JSON.parse(parts.join(''));
    assert.equal(navigation.currentSemanticLinks.length, 6);
    assert(navigation.currentSemanticLinks.every(link => link.definition && link.caller));
    assert(Buffer.byteLength(parts.join('')) > 8192);
    for (const item of checklist.items) await submitFrameTool(tools.call, 'submit_review', { taskId: item.taskId,
      verdict: 'UNVERIFIED', reason: 'This transport fixture does not supply a semantic verdict.' });
    await submitFrameTool(tools.call, 'finish_stop_review', frameFinishArgs());
  });
  assert.equal(reviewerStarted, true);
  assert.equal(handle.reviewCompleted, true);
});

async function startFrameScan({ task, read, call }, { requireFrame = false } = {}) {
  const submit = (name, args) => submitFrameTool(call, name, args);
  let original;
  const frameFiles = task.basisFiles.filter(file => path.basename(file).startsWith('requirement-frame-'));
  for (const file of task.basisFiles.filter(file => !frameFiles.includes(file))) {
    const citeId = await read(file);
    if (path.basename(file).startsWith('user-original-')) original = citeId;
  }
  if (requireFrame) {
    assert.equal(frameFiles.length, 1);
    assert.deepEqual(JSON.parse(await fs.readFile(frameFiles[0], 'utf8')), frameBasis);
    await assert.rejects(submit('review_scope', { stopClassification: 'TASK_COMPLETE',
      completionClaim: true, summary: 'Review the completed work.' }), { code: 'TASK_BASIS_UNREAD' });
  }
  let frameCite;
  for (const file of frameFiles) frameCite = await read(file);
  if (requireFrame) await assert.rejects(submit('set_original_checklist', { items: [{ metricId: 'M16',
    verificationTarget: 'IMPLEMENTATION', text: 'Treat the advisory hint as a requirement.',
    citeId: frameCite, lineStart: 1, lineEnd: 1 }] }), { code: 'STOP_ORIGINAL_CHECKLIST_INVALID' });
  await submit('set_original_checklist', { items: [{ metricId: 'M16', verificationTarget: 'IMPLEMENTATION',
    text: 'Return the input plus one.', citeId: original, lineStart: 2, lineEnd: 2 }] });
  const { items: [item] } = await submit('review_checklist', { stopClassification: 'TASK_COMPLETE', completionClaim: true });
  return { item, submit, finish: frameDispositions => submit('finish_stop_review', frameFinishArgs(frameDispositions)) };
}

async function saveFrameTestDeviation(submit, item, citeId) {
  await submit('submit_review', { taskId: item.taskId, verdict: 'DEVIATION',
    reason: 'The return expression is the unchanged input.', citeIds: [citeId] });
  return submit('submit_finding', { deviationKey: 'unchanged-value-finding', rootCauseId: 'REQUIREMENT_OMITTED',
    severity: 'warning', reason: 'The function also omits the specified addition at its entry point.',
    expectedConstraint: 'Return the input plus one.', violatedGroundTruthIds: [item.sourceId], citeIds: [citeId] });
}

test('7.4.1–3: a matching frame is mandatory and all dispositions are validated before completing Stop', async t => {
  const f = await frameStopCase(t, { deviation: true });
  const validator = process.env.RC_OPENCLAW_HOST_ROOT ? await loadPublicToolArgumentsValidator() : null;
  const { stop, handle } = await f.run(async tools => {
    assert(tools.worker.systemPrompt.endsWith(FRAME_REVIEW_INSTRUCTIONS));
    const { item, submit, finish } = await startFrameScan(tools, { requireFrame: true });
    const citeId = await tools.read(f.source);
    const checked = { id: 'G1', disposition: 'CHECKED', citeIds: [citeId] };
    const dev = { id: 'S1', disposition: 'DEVIATION', objectId: item.taskId };
    const unsure = unverifiedFrame()[2];
    const finding = { id: 'S3', disposition: 'DEVIATION', objectId: 'unchanged-value-finding' };
    const valid = [checked, dev, unsure, finding], reject = args => assert.rejects(finish(args), { code: 'REVIEW_FRAME_DISPOSITION_REQUIRED' });
    await reject(valid); // The checklist deviation and finding do not exist yet.
    assert.equal((await saveFrameTestDeviation(submit, item, citeId)).deviationKey, finding.objectId);
    await reject();
    await reject(valid.slice(1));
    await reject([checked, dev, unsure, checked]);
    await reject([{ ...checked, id: 'G99' }, dev, unsure, finding]);
    await reject([checked, { ...dev, objectId: 'unsaved' }, unsure, finding]);
    await reject([checked, dev, { id: 'S2', disposition: 'UNVERIFIED' }, finding]);
    await reject([checked, dev, { ...unsure, reason: '  ' }, finding]);
    const invalid = { not: 'an array' };
    if (validator) {
      const tool = tools.worker.tools.find(tool => tool.name === 'finish_stop_review');
      const args = frameFinishArgs(invalid);
      assert.deepEqual(validator.validateToolArguments(tool, { name: tool.name, arguments: args }), args);
    }
    await reject(invalid);
    assert.equal((await finish([{ id: 'G1', disposition: 'CHECKED' }, dev, unsure, finding])).complete, true);
  });
  assert.equal(stop.status, 'DEVIATION');
  assert.equal(stop.decision, 'block');
  const coverage = { status: 'used', reason: null, total: 4, checked: 1, deviation: 2, unverified: 1, items: handle.result.frameCoverage.items };
  assert.deepEqual(coverage.items.map(({id, disposition}) => ({id, disposition})), [
    {id:'G1', disposition:'CHECKED'}, {id:'S1', disposition:'DEVIATION'}, {id:'S2', disposition:'UNVERIFIED'}, {id:'S3', disposition:'DEVIATION'}]);
  assert.equal(coverage.items[0].evidence, undefined, 'CHECKED does not need an evidence attachment');
  assert(coverage.items[2].reason);
  assert.deepEqual(handle.result.frameCoverage, coverage);
  assert.deepEqual(stop.review.frameCoverage, coverage);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(handle.artifacts, 'review.json'), 'utf8')).frameCoverage, coverage);
});

test('7.4.3–4: absent frames preserve the original basis, instructions and finish validation', async t => {
  let original;
  for (const [options, reason] of [
    [{ enabled: false }, null], [{ stored: 'missing' }, 'FRAME_NOT_READY'],
    [{ stored: 'mismatch' }, 'START_HEAD_MISMATCH'], [{ review: false }, 'REVIEW_DISABLED'],
    [{ openClaw: false }, null],
  ]) await t.test(reason ?? JSON.stringify(options), async sub => {
    const f = await frameStopCase(sub, options);
    const { stop } = await f.run(async tools => {
      const profile = { prompt: tools.worker.systemPrompt, parts: tools.task.basisFiles.map(file => path.basename(file)),
        finish: tools.worker.tools.find(tool => tool.name === 'finish_stop_review').parameters };
      const basis = JSON.parse(await fs.readFile(tools.task.basisFiles.find(file => path.basename(file).startsWith('original-basis-')), 'utf8'));
      profile.basis = { ...basis, sources: basis.sources.map(({ file, ...source }) => ({ ...source, file: path.basename(file) })) };
      if (!original) original = profile;
      else assert.deepEqual(profile, original);
      const { finish } = await startFrameScan(tools);
      await assert.rejects(finish([]), { code: 'TASK_SUBMISSION_INVALID' });
      assert.equal((await finish()).complete, true);
    });
    assert.equal(stop.status, 'NO_DEVIATION_FOUND', JSON.stringify(stop));
    assert.equal(stop.feedback, null);
    assert.deepEqual(stop.review.frameCoverage, reason ? { status: 'absent', reason } : undefined);
  });
  const f = await frameStopCase(t);
  const { stop } = await f.run(async tools => {
    const { finish } = await startFrameScan(tools);
    assert.equal((await finish(unverifiedFrame())).complete, true);
  });
  assert.equal(stop.status, 'NO_DEVIATION_FOUND');
  assert.equal(stop.feedback, null);
  assert.deepEqual(stop.review.frameCoverage, { status: 'used', reason: null, total: 4, checked: 0, deviation: 0, unverified: 4, items: stop.review.frameCoverage.items });
  assert.deepEqual(stop.review.frameCoverage.items.map(item => item.id), ['G1','S1','S2','S3']);
  assert.equal(stop.review.unverifiedItems.length, 4);
});

test('a framed full-checklist review cannot bypass dispositions with submit_review.finish', async t => {
  const f = await fixture(t);
  f.input.request.requirementFrame = { basis: frameBasis };
  const handle = await scriptedWorkspaceReview(f.input, { script: async ({ task, read, call }) => {
    for (const file of task.basisFiles) await read(file);
    const submit = (name, args) => submitFrameTool(call, name, args);
    await f.scope(submit);
    const citeId = await read(f.file);
    const saved = await submit('submit_review', { taskId: 'M01:R1', verdict: 'PASS',
      reason: 'Checked the original delivery.', citeIds: [citeId], finish: true });
    assert.equal(saved.pending, 0);
    assert.equal(saved.complete, undefined);
    assert.equal((await submit('finish_stop_review', frameFinishArgs(unverifiedFrame()))).complete, true);
  } });
  assert.equal(handle.result.metricObjectJudgements[0].judgement, 'PASS');
  assert.equal(handle.result.frameCoverage.unverified, 4);
});

test('7.4.5: the reproduction appendix follows existing deviation feedback and native start keeps its validation', async t => {
  for (const { review, locale, expected } of [
    { review: true, locale: 'en', expected: reproductionText },
    { review: true, locale: 'zh', expected: chineseReproduction },
    { review: false, locale: 'en', expected: '' },
  ]) await t.test(`${review}/${locale}`, async sub => {
    // The appendix is controlled by review even when no frame was ready.
    const f = await frameStopCase(sub, { review, stored: 'missing', deviation: true, locale });
    const { stop } = await f.run(async tools => {
      const { item, submit, finish } = await startFrameScan(tools);
      await saveFrameTestDeviation(submit, item, await tools.read(f.source));
      await finish();
    });
    assert.equal(stop.status, 'DEVIATION', JSON.stringify(stop));
    assert.equal(stop.decision, 'block');
    assert.match(stop.feedback, /\[runtime-corrector:stop-feedback\]/u);
    const assertAppendix = message => {
      if (expected) {
        assert(message.endsWith(`\n\n${expected}`));
        assert.equal(message.split(expected).length - 1, 1);
      } else assert(!message.includes(reproductionText) && !message.includes(chineseReproduction));
    };
    assertAppendix(stop.feedback);
    const api = { config: {}, logger: { warn() {} }, runtime: { gateway: { request: async () => ({}) },
      subagent: { run: async ({ idempotencyKey }) => ({ runId: idempotencyKey }) } } };
    const protocol = createStopStartProtocol(api, { directoryFor: () => f.directory, isCurrent: async () => true,
      compatibility: async () => ({ version: 1, onStart: () => () => {}, drain: async () => {}, diagnosticsEnabled: () => true }) });
    sub.after(() => protocol.dispose());
    const state = { projectRoot: f.projectRoot, sessionId: f.sessionId, sessionKey: 'agent:main:frame-stop', agentId: 'main' };
    const source = { runId: 'original-run', usersDigest: 'fixture-user-digest' };
    const reproduction = frameReproduction(f.runtimeV2);
    const revised = await protocol.offerOriginal({ state, source, outcome: stop, isOpen: () => true, reproduction });
    assert.equal(revised.action, 'revise');
    assertAppendix(revised.reason);
    const { runId } = await protocol.submit({ state, source, outcome: stop });
    const { prependContext } = await protocol.prepare({ state, runId, reproduction });
    assertAppendix(prependContext);
    assert.match(prependContext, /The return expression is the unchanged input\./u);
    assert.deepEqual(await protocol.gate({ state, runId, event: { prompt: prependContext } }), { outcome: 'pass' });
  });
});

const rulesText = '# Rules\nExported functions must not return their input unchanged.\nKeep the changelog current.\n';
const rulesCheck = (id, metricId, text = 'Exported functions must not return their input unchanged.', line = 2, hash = sha256(rulesText)) => ({
  id, family: 'projectRules', metricId, text, verificationTarget: 'IMPLEMENTATION', applicability: '',
  activation: 'The request changes the exported transform.', source: { path: 'docs/rules.md', startLine: line, endLine: line, sha256: hash }, confidence: 0.9 });
const rulesSources = { [sha256(rulesText)]: rulesText, [sha256('other')]: 'tampered\n' };

async function readCheckBasis(tools) {
  let original;
  for (const file of tools.task.basisFiles) {
    const citeId = await tools.read(file);
    if (path.basename(file).startsWith('user-original-')) original = citeId;
  }
  const proposedFile = tools.task.basisFiles.find(file => path.basename(file).startsWith('proposed-checks-'));
  return { original, proposed: JSON.parse(await fs.readFile(proposedFile, 'utf8')) };
}
const transformItem = original => ({ metricId: 'M16', verificationTarget: 'IMPLEMENTATION', text: 'Return the input plus one.',
  citeId: original, lineStart: 2, lineEnd: 2 });

test('proposed checks join the original checklist after set_original_checklist and need their own dispositions', async t => {
  const k1 = rulesCheck('K1', 'M09');
  const f = await frameStopCase(t, { deviation: true, metricIds: ['M09', 'M16'], checkSources: rulesSources, checks: [k1,
    rulesCheck('K2', 'M13'), rulesCheck('K3', 'M09', 'Keep the changelog current.', 3, sha256('other'))] });
  let check;
  const { stop, handle } = await f.run(async tools => {
    const submit = (name, args) => submitFrameTool(tools.call, name, args);
    assert(tools.worker.systemPrompt.includes(FRAME_REVIEW_INSTRUCTIONS));
    assert.match(tools.worker.systemPrompt, /Proposed checks \(basis part proposed-checks\)/u);
    const { original, proposed } = await readCheckBasis(tools);
    assert.deepEqual(proposed.map(item => item.id), ['K1']);
    assert.equal(path.basename(path.dirname(proposed[0].sourceFile)), 'proposed-check-sources');
    assert.equal(await fs.readFile(proposed[0].sourceFile, 'utf8'), rulesText);
    await submit('set_original_checklist', { items: [transformItem(original)] });
    const { items } = await submit('review_checklist', { stopClassification: 'TASK_COMPLETE', completionClaim: true, limit: 20 });
    check = items.find(item => item.proposedCheck === 'K1');
    assert.equal(items.length, 2);
    assert.deepEqual([check.metricId, check.description, check.applicabilityKind, check.originalSource],
      ['M09', k1.text, 'CURRENT_TASK', { kind: 'PROJECT_FILE', ref: 'docs/rules.md', sha256: sha256(rulesText), start: 2, end: 2 }]);
    assert.equal(proposed[0].objectId, check.taskId);
    await submit('submit_review', { taskId: check.taskId, verdict: 'DEVIATION',
      reason: 'The exported transform returns its input unchanged.', citeIds: [await tools.read(f.source)] });
    const finish = dispositions => submit('finish_stop_review', frameFinishArgs(dispositions));
    await assert.rejects(finish(unverifiedFrame()), { code: 'REVIEW_FRAME_DISPOSITION_REQUIRED' });
    await assert.rejects(finish([...unverifiedFrame(), { id: 'K1', disposition: 'DEVIATION', objectId: 'unsaved' }]),
      { code: 'REVIEW_FRAME_DISPOSITION_REQUIRED' });
    assert.equal((await finish([...unverifiedFrame(), { id: 'K1', disposition: 'DEVIATION', objectId: check.taskId }])).complete, true);
  });
  assert.equal(stop.status, 'DEVIATION', JSON.stringify(stop));
  assert.deepEqual(handle.result.frameCoverage.items.map(({ id, type, disposition }) => [id, type, disposition]), [
    ['G1', 'FRAME_GUIDANCE', 'UNVERIFIED'], ['S1', 'FRAME_SCENARIO', 'UNVERIFIED'], ['S2', 'FRAME_SCENARIO', 'UNVERIFIED'],
    ['S3', 'FRAME_SCENARIO', 'UNVERIFIED'], ['K1', 'FRAME_CHECK', 'DEVIATION']]);
  assert.equal(handle.result.frameCoverage.items.at(-1).objectId, check.taskId);
  assert.match(stop.feedback, /returns its input unchanged/u);
});

test('an identical reviewer item reuses the proposed check, and a checks-only frame still needs its disposition', async t => {
  const k1 = rulesCheck('K1', 'M09');
  const f = await frameStopCase(t, { metricIds: ['M09', 'M16'], basis: { guidance: [], scenarios: [] }, checks: [k1], checkSources: rulesSources });
  const reason = 'The delivered transform adds one, so it does not return its input unchanged.';
  const { stop } = await f.run(async tools => {
    const submit = (name, args) => submitFrameTool(tools.call, name, args);
    assert(!tools.worker.systemPrompt.includes(FRAME_REVIEW_INSTRUCTIONS));
    assert(!tools.task.basisFiles.some(file => path.basename(file).startsWith('requirement-frame-')));
    const { original, proposed } = await readCheckBasis(tools);
    await submit('set_original_checklist', { items: [transformItem(original), { metricId: 'M09', verificationTarget: 'IMPLEMENTATION',
      text: k1.text, path: proposed[0].sourceFile, lineStart: 2, lineEnd: 2 }] });
    const { items } = await submit('review_checklist', { stopClassification: 'TASK_COMPLETE', completionClaim: true, limit: 20 });
    assert.deepEqual(items.map(item => [item.metricId, item.proposedCheck ?? null]).sort(), [['M09', 'K1'], ['M16', null]]);
    const finish = dispositions => submit('finish_stop_review', frameFinishArgs(dispositions));
    await assert.rejects(finish([]), { code: 'REVIEW_FRAME_DISPOSITION_REQUIRED' });
    assert.equal((await finish([{ id: 'K1', disposition: 'CHECKED', reason }])).complete, true);
  });
  assert.equal(stop.status, 'NO_DEVIATION_FOUND', JSON.stringify(stop));
  assert.deepEqual(stop.review.frameCoverage.items, [{ id: 'K1', type: 'FRAME_CHECK', disposition: 'CHECKED', reason }]);
});

test('a full checklist review gives proposed checks ordinary verdicts without frame dispositions', async t => {
  const f = await frameStopCase(t, { deviation: true, deviationOnly: false, metricIds: ['M09', 'M16'],
    basis: { guidance: [], scenarios: [] }, checks: [rulesCheck('K1', 'M09')], checkSources: rulesSources });
  const { handle } = await f.run(async tools => {
    const submit = (name, args) => submitFrameTool(tools.call, name, args);
    assert.match(tools.worker.systemPrompt, /Give every K item a verdict like any other checklist item\./u);
    const finishTool = tools.worker.tools.find(tool => tool.name === 'finish_stop_review');
    assert.equal(Object.hasOwn(finishTool.parameters.properties, 'frameDispositions'), false);
    const { original } = await readCheckBasis(tools);
    await submit('set_original_checklist', { items: [transformItem(original)] });
    const { items } = await submit('review_checklist', { stopClassification: 'TASK_COMPLETE', completionClaim: true, limit: 20 });
    const check = items.find(item => item.proposedCheck === 'K1'), transform = items.find(item => item.metricId === 'M16');
    await submit('submit_review', { taskId: transform.taskId, verdict: 'UNVERIFIED', reason: 'Not traced in this fixture.' });
    await submit('submit_review', { taskId: check.taskId, verdict: 'DEVIATION',
      reason: 'The exported transform returns its input unchanged.', citeIds: [await tools.read(f.source)] });
    assert.equal((await submit('finish_stop_review', frameFinishArgs())).complete, true);
  });
  assert.deepEqual(handle.result.metricObjectJudgements.map(row => [row.objectId.slice(0, 3), row.judgement]).sort(),
    [['M09', 'DEVIATION'], ['M16', 'UNVERIFIED']]);
  assert.deepEqual(handle.result.frameCoverage, { status: 'absent', reason: 'NO_FRAME_ITEMS' });
});

test('production Stop exempts a command only with program-owned nonexecuting tools and lists it separately', async t => {
  for (const capable of [false, true]) await t.test(capable ? 'fixed build tool retains UNVERIFIED' : 'verified file-only policy', async t => {
    const command = 'python scripts/check.py';
    const f = await frameStopCase(t, { basis: { guidance: [], scenarios: [] }, metricIds: ['M11'], userText: `Run ${command}.`,
      effectiveToolPolicy: async () => ({ source: 'HOST_EFFECTIVE_TOOL_CATALOG', hostVersion: '2026.7.1-2', current: true,
        sessionId: 'protocol-host', policyDigest: 'policy', catalogDigest: 'catalog', tools: capable ? [{ name: 'bench_check' }] : [
          { name: 'read', schemaHash: '134f19bcabe3e29d63c5cebb38f1d2556759fd08adad6bc90a4b4d3cd1fb8441' }] }) });
    const { stop } = await f.run(async tools => {
      const submit = (name, args) => submitFrameTool(tools.call, name, args);
      let original;
      for (const file of tools.task.basisFiles) { const id = await tools.read(file); if (path.basename(file).startsWith('user-original-')) original = id; }
      await submit('set_original_checklist', { items: [{ metricId: 'M11', verificationTarget: 'PROCESS', text: `Run ${command}.`, citeId: original, lineStart: 1, lineEnd: 1 }] });
      const { items } = await submit('review_checklist', { stopClassification: 'TASK_COMPLETE', completionClaim: true });
      await submit('submit_review', { taskId: items[0].taskId, verdict: 'UNVERIFIED', reason: 'The original command has no execution receipt.' });
      await submit('finish_stop_review', { summary: 'Checked the exact original command.', environmentCommands: [{ objectId: items[0].taskId, command }] });
    });
    assert.equal(stop.verificationIncomplete, capable, JSON.stringify(stop));
    assert.equal(stop.environmentUnexecutable.length, capable ? 0 : 1);
    assert.equal(stop.report.unverifiedItems.length, capable ? 1 : 0);
    if (!capable) {
      assert.equal(stop.status, 'NO_DEVIATION_FOUND');
      assert.equal(stop.report.reviewCoverage.items[0].disposition, 'ENVIRONMENT_UNEXECUTABLE');
    }
  });
});

test('one unverified post-build project command makes a completed Stop unverified with no repair admission', async t => {
  const f = await frameStopCase(t, { basis: { guidance: [], scenarios: [] }, metricIds: ['M09', 'M16'], processEntries: [
    { type: 'assistant', uuid: 'build-call', message: { content: [{ type: 'tool_use', id: 'build', name: 'bench_check', input: { phase: 'build' } }] } },
    { type: 'user', uuid: 'build-result', isMeta: true, message: { content: [{ type: 'tool_result', tool_use_id: 'build', is_error: false, content: 'HAP build succeeded.' }] } },
  ] });
  const guide = path.join(f.projectRoot, 'AGENTS.md');
  const requirement = 'After a successful HAP build, run `codelinter -c ./code-linter.json5 . --fix`.';
  await fs.writeFile(guide, `# Project guide\n${requirement}\n`);
  const { stop, handle } = await f.run(async tools => {
    const submit = (name, args) => submitFrameTool(tools.call, name, args);
    let original;
    for (const file of tools.task.basisFiles) { const id = await tools.read(file); if (path.basename(file).startsWith('user-original-')) original = id; }
    await submit('set_original_checklist', { items: [transformItem(original), { metricId: 'M09',
      verificationTarget: 'PROCESS', text: requirement, citeId: await tools.read(guide), lineStart: 2, lineEnd: 2 }] });
    const { items } = await submit('review_checklist', { stopClassification: 'TASK_COMPLETE', completionClaim: true });
    const lint = items.find(item => item.metricId === 'M09');
    assert.equal(lint.originalSource.ref, 'AGENTS.md');
    await submit('submit_review', { taskId: lint.taskId, verdict: 'UNVERIFIED', reason: 'No attributable CodeLinter invocation or result.' });
    assert.equal((await submit('finish_stop_review', frameFinishArgs())).complete, true);
  });
  assert.equal(handle.result.unverifiedItems.length, 1);
  assert.equal(stop.status, 'UNVERIFIED');
  assert.equal(stop.reasonCode, 'STOP_MANDATORY_REQUIREMENT_UNVERIFIED');
  assert.equal(stop.coverage.scanCompleted, true);
  assert.equal(stop.verificationIncomplete, true);
  assert.equal(stop.decision, 'allow');
  assert.equal(stop.admission, null);
  assert.match(stop.feedback, /STOP_MANDATORY_REQUIREMENT_UNVERIFIED/u);
  const ledger = await createStopCorrectionStore({ directory: f.directory }).inspect(f.sessionId);
  assert.equal(ledger.stops['frame-stop'].reviewStatus, 'UNVERIFIED');
  assert.equal(ledger.used, 0);
});

test('production Stop coverage requires current production proof and preserves supported repairs', async t => {
  const requirements = [
    'Return the input plus one from increment.',
    'Return the input doubled from double.',
    'Return zero from reset.',
  ];
  for (const mode of ['missing', 'invalid', 'test-sources', 'producer-only', 'unread-consumer', 'observed', 'cross-file', 'deviation', 'disabled', 'stage']) await t.test(mode, async t => {
    const stage = mode === 'stage', required = mode !== 'disabled' && !stage;
    const f = await frameStopCase(t, { enabled: false, requireCurrentProductionCoverage: mode !== 'disabled',
      ...(stage ? { artifacts: [{ nodeId: 'implementation', stage: 'implementation', metrics: ['M16'], patterns: ['app.mjs'] }] } : {}),
      userText: requirements.join('\n'), sourceText: [
        `export const increment = input => ${mode === 'deviation' ? 'input' : 'input + 1'};`,
        'export const double = input => input * 2;',
        'export const reset = () => 0;',
      ].join('\n') + '\n' });
    const testSource = path.join(f.projectRoot, 'app.test.mjs');
    await fs.writeFile(testSource, 'import assert from "node:assert/strict";\nassert.equal(2 * 2, 4);\n');
    const consumerFile = path.join(f.projectRoot, 'consumer.mjs');
    if (mode === 'cross-file') await fs.writeFile(consumerFile, 'export const report = result => ({ result });\n');
    const testSources = [];
    if (mode === 'test-sources') {
      for (const [relative, body] of [
        ['app/src/androidTest/kotlin/Calculations.kt', 'fun increment(value: Int) = value + 1'],
        ['src/__mocks__/calculations.ts', 'export const double = (value: number) => value * 2;'],
        ['spec/calculations.rb', 'def reset = 0'],
      ]) {
        const file = path.join(f.projectRoot, relative);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, body + '\n');
        testSources.push(file);
      }
    }
    let reviewCalls = 0, obligations;
    const { stop, handle } = await f.run(async tools => {
      reviewCalls++;
      const submit = (name, args) => submitFrameTool(tools.call, name, args);
      let original;
      for (const file of tools.task.basisFiles) {
        const id = await tools.read(file);
        if (path.basename(file).startsWith('user-original-')) original = id;
      }
      const items = requirements.map((text, index) => ({ metricId: 'M16', verificationTarget: 'IMPLEMENTATION',
        implementationRole: 'PRODUCTION', text, citeId: original, lineStart: index + 1, lineEnd: index + 1 }));
      const page = await submit('set_original_checklist', { items, scope: { stopClassification: stage ? 'STAGE_COMPLETE' : 'TASK_COMPLETE',
        ...(stage ? { stage: 'implementation' } : {}), completionClaim: true } });
      obligations = requirements.map(text => page.items.find(item => item.description === text));
      assert(obligations.every(Boolean));
      assert(obligations.every(item => (item.requiresProductionCoverage === true) === required));
      const finish = productionCoverage => submit('finish_stop_review', { ...frameFinishArgs(),
        ...(productionCoverage ? { productionCoverage } : {}) });
      const span = (citeId, line) => ({ citeId, start: line, end: line });
      const record = (index, citeId) => ({ objectId: obligations[index].objectId, reason: requirements[index], citeIds: [citeId],
        flow: { entry: span(citeId, index + 1), consumer: span(citeId, index + 1) } });

      if (mode === 'deviation') {
        assert.equal((await submit('submit_review', { taskId: obligations[0].objectId, verdict: 'DEVIATION',
          reason: 'increment returns the input unchanged, omitting the requested addition.', citeIds: [await tools.read(f.source)] })).saved, true);
        assert.equal((await finish()).complete, true, 'two unresolved siblings do not require another finish before a proven repair');
        return;
      }
      if (!required) {
        assert.equal((await finish()).complete, true);
        return;
      }
      if (mode === 'cross-file') {
        const producer = await tools.read(f.source), consumer = await tools.read(consumerFile);
        const proposals = requirements.map((_, index) => {
          const proposal = record(index, producer);
          proposal.citeIds.push(consumer);
          proposal.flow.consumer = span(consumer, 1);
          return proposal;
        });
        assert.equal((await finish(proposals)).pendingProductionCoverageCount, 3);
        for (const proposal of proposals) proposal.flow.handoff = proposal.flow.entry;
        assert.equal((await finish(proposals)).complete, true);
        return;
      }
      const source = mode === 'observed' ? await tools.read(f.source) : null;
      let firstCoverage = mode === 'invalid' ? [
        record(0, 'unobserved-current-source'), record(1, await tools.read(testSource)), record(2, original),
        { objectId: 'M16:unassigned', reason: 'This source read is genuine, but this item was never assigned.', citeIds: [await tools.read(f.source)] },
      ] : source ? [record(0, source)] : undefined;
      if (mode === 'test-sources') {
        firstCoverage = [];
        for (const [index, file] of testSources.entries()) firstCoverage.push(record(index, await tools.read(file)));
      }
      if (mode === 'producer-only' || mode === 'unread-consumer') {
        const producer = await tools.read(f.source);
        firstCoverage = requirements.map((_, index) => {
          const proposal = record(index, producer);
          if (mode === 'producer-only') delete proposal.flow;
          else proposal.flow.consumer = span(producer, 100);
          return proposal;
        });
      }
      const first = await finish(firstCoverage);
      assert.equal(first.pendingProductionCoverageCount, source ? 2 : 3);
      assert.notEqual(first.complete, true);
      assert.equal((await finish(source ? [record(1, source), record(2, source)] : undefined)).complete, true);
    });
    assert.equal(reviewCalls, 1, 'all coverage settlement uses the existing review');
    if (stage) assert.equal(stop.coverage.classification, 'STAGE_COMPLETE');
    const unresolved = stop.report.unverifiedItems.filter(item => item.type === 'REQUIREMENT').map(item => item.objectId).sort();
    if (mode === 'deviation') {
      assert.equal(stop.status, 'DEVIATION');
      assert.deepEqual(unresolved, obligations.slice(1).map(item => item.objectId).sort());
      assert.equal(stop.decision, 'block');
      assert(stop.admission, 'the supported production deviation still admits repair');
      assert.equal(handle.result.metricObjectJudgements.filter(row => row.judgement === 'DEVIATION').length, 1);
    } else {
      const incomplete = ['missing', 'invalid', 'test-sources', 'producer-only', 'unread-consumer'].includes(mode);
      assert.deepEqual(unresolved, incomplete ? obligations.map(item => item.objectId).sort() : []);
      assert.equal(stop.status, incomplete ? 'UNVERIFIED' : 'NO_DEVIATION_FOUND');
      assert.equal(stop.verificationIncomplete, incomplete);
      if (incomplete) assert.equal(stop.reasonCode, 'STOP_MANDATORY_REQUIREMENT_UNVERIFIED');
      assert.equal(stop.decision, 'allow');
      assert.equal(stop.admission, null);
      if (mode === 'observed') for (const [index, obligation] of obligations.entries()) {
        const row = handle.result.reviewCoverage.items.find(item => item.id === obligation.objectId);
        assert.equal(row.disposition, 'SOURCE_REVIEWED');
        assert.equal(row.flow.entry.path, 'app.mjs');
        assert.equal(row.flow.entry.start, index + 1);
        assert.deepEqual(row.flow.consumer, row.flow.entry, 'one direct statement may prove both roles');
      }
      if (mode === 'cross-file') for (const obligation of obligations) {
        const row = handle.result.reviewCoverage.items.find(item => item.id === obligation.objectId);
        assert.equal(row.disposition, 'SOURCE_REVIEWED');
        assert.equal(row.flow.consumer.path, 'consumer.mjs');
        assert.deepEqual(row.flow.handoff, row.flow.entry, 'the same line may receive and forward the operation');
      }
    }
    const ledger = await createStopCorrectionStore({ directory: f.directory }).inspect(f.sessionId);
    assert.equal(ledger.used, 0, 'the fixture verifies admission without dispatching a native continuation');
  });
});

test('approved Proposal obligations sharing one source anchor require separate current Stop evidence', async t => {
  const requirements = ['Return the input plus one from increment.', 'Return the input doubled from double.'];
  const originalText = requirements.join(' ');
  for (const mode of ['omitted', 'verified', 'origin-verified', 'origin-retained-stale', 'deviation']) await t.test(mode, async t => {
    const verified = mode === 'verified' || mode === 'origin-verified';
    const f = await fixture(t);
    const app = path.join(f.root, 'app.mjs');
    await fs.writeFile(app, [
      `export const increment = input => ${mode === 'deviation' ? 'input' : 'input + 1'};`,
      'export const double = input => input * 2;',
      '',
    ].join('\n'));
    if (mode.startsWith('origin-')) {
      // This lower-level fixture otherwise has no source Git inventory. Give
      // the strict origin index its own disposable project, as real hosts do.
      execFileSync('git', ['init', '--quiet', f.root]);
      execFileSync('git', ['-C', f.root, 'add', '--', 'app.mjs']);
    }
    f.input.request.hook.last_assistant_message = 'Both operations are complete and the tests passed.';
    f.input.request.classificationContract = 2;
    f.input.request.fixedStopClassification = { stopClassification: 'TASK_COMPLETE', stage: null };
    f.input.request.population.reviewPolicy = resolveStopReviewPolicy({ deviationOnly: true, requireCurrentProductionCoverage: false,
      requireProductionOriginCoverage: mode.startsWith('origin-') });
    f.input.evidence.snapshot.entries[0].message.content = originalText;
    const original = await loadStopOriginalRequirements({ projectRoot: f.root, snapshot: f.input.evidence.snapshot });
    f.input.evidence.originalRequirements = original;
    const [message] = original.userMessages;
    assert.equal(message.text, originalText);
    const source = createOriginalSourceAnchor({ ref: message.ref, sha256: message.sha256, bytes: Buffer.from(message.text), start: 1, end: 1 });
    const requiredAtoms = requirements.map(requirement => ({ id: sha256([source.anchorId, requirement]), source, requirement }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const planPath = 'openspec/changes/transform-inputs/specs/transforms/spec.md';
    const plan = path.join(f.root, planPath);
    const planText = requirements.join('\n') + '\n';
    await fs.mkdir(path.dirname(plan), { recursive: true });
    await fs.writeFile(plan, planText);
    const scope = { changeName: 'transform-inputs', proposalRunId: 'proposal-run', applyRunId: 'apply-run',
      approvedRevision: sha256(planText), taskId: f.input.taskId, sessionId: 'protocol-host' };
    f.input.request.approvedProposalInventory = { inventorySha256: sha256(requiredAtoms), requiredAtoms };
    f.input.evidence.approvedPlanCoverage = { ...scope, rows: requirements.map((requirement, index) => ({
      source, requirement, disposition: 'COVERED', reason: 'The approved plan directly states this behavior.',
      targets: [{ path: planPath, sha256: sha256(planText), start: index + 1, end: index + 1 }],
    })) };
    f.input.onScope = async () => ({ regressionCheck: {
      status: 'PASSED', command: ['node', '--test'], cwd: '.', exitCode: 0,
      outputTail: 'RC_REGRESSION_INVENTORY {"complete":true,"executedTests":1,"failures":[]}\n',
      requirementCheck: { sha256: sha256('passing public probe'), workspaceDigest: sha256('candidate'),
        status: 'PASS', checks: [{ id: 'double ordinary input', status: 'PASS' }] },
    } });

    let checked, omitted;
    const handle = await checkedVersionRun(f, async ({ brief, readAll, read, submit }) => {
      await readAll();
      const originalFile = brief.task.basisFiles.find(file => path.basename(file).startsWith('user-original-'));
      const originalRead = (await read(originalFile)).details.citation.citeId;
      const page = await submit('set_original_checklist', { items: [{ metricId: 'M16', verificationTarget: 'IMPLEMENTATION',
        implementationRole: 'PRODUCTION', text: requirements[0], citeId: originalRead, lineStart: 1, lineEnd: 1 }],
      scope: { stopClassification: 'TASK_COMPLETE', completionClaim: true, limit: 20 } });
      assert.equal(page.requirementCheck.status, 'PASS');
      assert.equal(page.approvedProposalCoverage.total, 2);
      [checked, omitted] = requirements.map(text => page.items.find(item => item.description === text));
      assert(checked?.requiresProductionCoverage && omitted?.requiresProductionCoverage);
      assert.notEqual(checked.objectId, omitted.objectId);
      assert.equal(checked.originalSourceAnchor.anchorId, source.anchorId);
      assert.equal(omitted.originalSourceAnchor.anchorId, source.anchorId);
      assert.deepEqual(checked.approvedProposalAtomIds, [sha256([source.anchorId, requirements[0]])]);
      assert.deepEqual(omitted.approvedProposalAtomIds, [sha256([source.anchorId, requirements[1]])]);

      const current = (await read(app)).details.citation.citeId;
      const origins = new Map();
      if (mode.startsWith('origin-')) for (const [item, line] of [[checked, 1], [omitted, 2]]) {
        assert.equal(item.requiresProductionOriginCoverage, true, 'the sealed inventory activates strict origins without the ordinary current-coverage switch');
        const receipt = await submit('review_production_origin', { objectId: item.objectId, entry: { citeId: current, start: line, end: line } });
        assert.equal(receipt.status, 'READY', JSON.stringify(receipt));
        assert.deepEqual(receipt.candidates, []);
        origins.set(item.objectId, receipt.receiptId);
      }
      const coverage = (item, line, citeId = current) => {
        const range = { citeId, start: line, end: line };
        return { objectId: item.objectId, reason: item.description, citeIds: [citeId], flow: { entry: range, consumer: range,
          ...(origins.has(item.objectId) ? { originReceiptId: origins.get(item.objectId), upstream: [] } : {}) } };
      };
      const finish = (productionCoverage = []) => submit('finish_stop_review', {
        summary: 'The existing tests passed and the approved spec names both operations.', productionCoverage,
      });
      if (mode === 'deviation') {
        await submit('submit_review', { taskId: checked.objectId, verdict: 'DEVIATION',
          reason: 'The current increment function returns the unchanged input.', citeIds: [current] });
        assert.equal((await finish()).complete, true);
        return;
      }
      const approvedSpec = (await read(plan)).details.citation.citeId;
      const first = await finish([coverage(checked, 1), coverage(omitted, 2, approvedSpec)]);
      assert.equal(first.complete, false);
      assert.equal(first.pendingProductionCoverageCount, 1);
      assert.equal(first.pendingProductionCoverage[0].objectId, omitted.objectId);
      if (mode === 'origin-retained-stale') await fs.writeFile(path.join(f.root, 'new-caller.mjs'),
        'import { increment } from "./app.mjs";\nexport const another = () => increment(2);\n');
      assert.equal((await finish(verified || mode === 'origin-retained-stale' ? [coverage(omitted, 2)] : [])).complete, true);
    });
    assert.equal(handle.reviewCompleted, true);
    const unverified = handle.result.unverifiedItems.filter(item => item.type === 'REQUIREMENT');
    assert.deepEqual(unverified.map(item => item.objectId).sort(),
      (verified ? [] : mode === 'origin-retained-stale' ? [checked.objectId, omitted.objectId] : [omitted.objectId]).sort());
    assert.deepEqual(handle.result.metricObjectJudgements.filter(item => item.judgement === 'DEVIATION').map(item => item.objectId),
      mode === 'deviation' ? [checked.objectId] : []);
    const omittedCoverage = handle.result.reviewCoverage.items.find(item => item.id === omitted.objectId);
    assert.equal(omittedCoverage.disposition, verified ? 'SOURCE_REVIEWED' : 'UNVERIFIED');
    if (verified) {
      assert.equal(omittedCoverage.flow.consumer.path, 'app.mjs');
      assert.equal(omittedCoverage.flow.consumer.start, 2);
    }
    if (mode === 'origin-retained-stale') for (const item of handle.result.reviewCoverage.items.filter(item => item.type === 'REQUIREMENT')) {
      assert.equal(item.disposition, 'UNVERIFIED');
      assert.equal(item.originCoverage.reason, 'ORIGIN_INDEX_CHANGED');
    }
    await handle.close();
  });
});

test('production Stop coverage accounts for observed sibling dispatches in the same callback', async t => {
  const requirement = 'When the user selects a mode, generate the result in that mode.';
  for (const mode of ['missing', 'unread', 'wrong-entry', 'no-handoff', 'healthy', 'deviation']) await t.test(mode, async t => {
    const broken = mode === 'missing' || mode === 'deviation';
    const f = await frameStopCase(t, { enabled: false, requireCurrentProductionCoverage: true, userText: requirement,
      sourceText: [
        'export function install(register, dispatch, selection, seed, imported, previous) {',
        "  register('resume', () => {",
        "    dispatch({ route: 'result', params: { previous } });",
        '  });',
        "  register('start', () => {",
        '    if (seed) {',
        `      dispatch({ route: 'result', params: { seed${broken ? '' : ', mode: selection'} } });`,
        '      return;',
        '    }',
        '    if (imported) {',
        "      dispatch({ route: 'result', params: { imported } });",
        '      return;',
        '    }',
        "    dispatch({ route: 'result', params: { mode: selection } });",
        '  });',
        '}',
      ].join('\n') + '\n' });
    const consumerFile = path.join(f.projectRoot, 'result.mjs');
    await fs.writeFile(consumerFile, [
      'export function renderResult(params, generate) {',
      '  if (params.previous) return params.previous;',
      '  if (params.imported) return params.imported;',
      "  return generate(params.mode ?? 'standard', params.seed);",
      '}',
    ].join('\n') + '\n');
    let objectId, reviewCalls = 0;
    const { stop, handle } = await f.run(async tools => {
      reviewCalls++;
      const submit = (name, args) => submitFrameTool(tools.call, name, args);
      let original;
      for (const file of tools.task.basisFiles) {
        const id = await tools.read(file);
        if (path.basename(file).startsWith('user-original-')) original = id;
      }
      const page = await submit('set_original_checklist', { items: [{ metricId: 'M16', verificationTarget: 'IMPLEMENTATION',
        implementationRole: 'PRODUCTION', text: requirement, citeId: original, lineStart: 1, lineEnd: 1 }],
      scope: { stopClassification: 'TASK_COMPLETE', completionClaim: true } });
      const item = page.items.find(item => item.description === requirement);
      assert.equal(item.requiresProductionCoverage, true);
      objectId = item.objectId;
      const partial = mode === 'unread'
        ? (await tools.call('source_read', { path: f.source, offset: 11, limit: 4 })).details.citation : null;
      if (partial) assert.deepEqual([partial.start, partial.end], [11, 14]);
      const producer = partial?.citeId ?? await tools.read(f.source);
      const consumer = await tools.read(consumerFile);
      const span = (citeId, line) => ({ citeId, start: line, end: line });
      const ordinary = span(producer, 14), seeded = span(producer, 7), effect = span(consumer, 4);
      const finish = flow => submit('finish_stop_review', { ...frameFinishArgs(), ...(flow && {
        productionCoverage: [{ objectId, reason: 'Traced the selected mode into generation.', citeIds: [producer, consumer], flow }],
      }) });
      if (mode === 'deviation') {
        const saved = await submit('submit_review', { taskId: objectId, verdict: 'DEVIATION',
          reason: 'The seeded launch omits the selected mode, so generation falls back to standard.', citeIds: [producer, consumer] });
        assert.equal(saved.saved, true);
        assert.equal((await finish()).complete, true);
        return;
      }
      const flow = { entry: ordinary, handoff: ordinary, consumer: effect,
        ...(mode === 'missing' ? {} : { branches: [
          { disposition: 'VERIFIED', reason: 'Seeded dispatch also passes the selected mode.', entry: seeded, consumer: effect,
            ...(mode === 'no-handoff' ? {} : { handoff: seeded }) },
          { disposition: 'OUT_OF_SCOPE', reason: 'Import returns a supplied result without generating.',
            entry: span(producer, mode === 'wrong-entry' ? 3 : 11) },
        ] }) };
      const first = await finish(flow);
      if (mode === 'healthy') {
        assert.equal(first.complete, true);
        return;
      }
      assert.equal(first.complete, false);
      assert.equal(first.pendingProductionCoverageCount, 1);
      assert.deepEqual(first.pendingProductionCoverage[0].siblingDispatches,
        [{ path: 'app.mjs', start: 7, end: 7 }, { path: 'app.mjs', start: 11, end: 11 }]);
      assert.equal((await finish(flow)).complete, true);
    });
    assert.equal(reviewCalls, 1);
    const coverage = handle.result.reviewCoverage.items.find(item => item.id === objectId);
    const ledger = await createStopCorrectionStore({ directory: f.directory }).inspect(f.sessionId);
    assert.equal(ledger.used, 0);
    if (mode === 'deviation') {
      assert.equal(stop.status, 'DEVIATION');
      assert.equal(stop.decision, 'block');
      assert(stop.admission);
    } else if (mode === 'healthy') {
      assert.equal(stop.status, 'NO_DEVIATION_FOUND');
      assert.equal(stop.admission, null);
      assert.equal(coverage.disposition, 'SOURCE_REVIEWED');
      assert.equal(coverage.flow.entry.start, 14);
      assert.equal(coverage.flow.branches, undefined);
      assert.deepEqual(coverage.branches.map(branch => [branch.disposition, branch.entry.start]),
        [['VERIFIED', 7], ['OUT_OF_SCOPE', 11]]);
      assert.equal(coverage.branches[0].consumer.path, 'result.mjs');
      assert.equal(coverage.branches[0].handoff.path, 'app.mjs');
    } else {
      assert.equal(stop.status, 'UNVERIFIED');
      assert.equal(stop.reasonCode, 'STOP_MANDATORY_REQUIREMENT_UNVERIFIED');
      assert.equal(stop.admission, null);
      assert.equal(coverage.disposition, 'UNVERIFIED');
    }
  });
});

test('strict production origins leave unresolved entry ranges unverified and accept resolved entries without callers', async t => {
  const requirement = 'The public transform must return the input plus one.';
  for (const mode of ['resolved', 'crossing', 'legacy-crossing']) await t.test(mode, async t => {
    const strict = mode !== 'legacy-crossing';
    const f = await frameStopCase(t, { enabled: false, requireCurrentProductionCoverage: true,
      requireProductionOriginCoverage: strict, userText: requirement, sourceText:
        'export function transform(input) {\n  return input + 1;\n}\n\nexport function inspect(input) {\n  return input;\n}\n' });
    let objectId;
    const { stop, handle } = await f.run(async tools => {
      const submit = (name, args) => submitFrameTool(tools.call, name, args);
      let original;
      for (const file of tools.task.basisFiles) {
        const id = await tools.read(file);
        if (path.basename(file).startsWith('user-original-')) original = id;
      }
      const page = await submit('set_original_checklist', { items: [{ metricId: 'M16', verificationTarget: 'IMPLEMENTATION',
        implementationRole: 'PRODUCTION', text: requirement, citeId: original, lineStart: 1, lineEnd: 1 }],
      scope: { stopClassification: 'TASK_COMPLETE', completionClaim: true } });
      objectId = page.items.find(item => item.description === requirement).objectId;
      const source = await tools.read(f.source);
      const flow = { entry: { citeId: source, start: 1, end: mode === 'resolved' ? 1 : 7 },
        consumer: { citeId: source, start: 2, end: 2 } };
      if (strict) {
        const receipt = await submit('review_production_origin', { objectId, entry: flow.entry });
        assert.equal(receipt.status, mode === 'resolved' ? 'READY' : 'UNKNOWN');
        if (mode === 'crossing') assert.equal(receipt.reason, 'ENTRY_SYMBOL_UNRESOLVED');
        assert.deepEqual(receipt.candidates, []);
        flow.originReceiptId = receipt.receiptId;
        flow.upstream = [];
      }
      const finish = () => submit('finish_stop_review', { ...frameFinishArgs(), productionCoverage: [{ objectId,
        reason: 'The public transform computes the requested result.', citeIds: [source], flow }] });
      const first = await finish();
      if (mode === 'crossing') {
        assert.equal(first.complete, false);
        assert.equal(first.pendingProductionCoverage[0].originIssue, 'ENTRY_SYMBOL_UNRESOLVED');
        assert.equal((await finish()).complete, true);
      } else assert.equal(first.complete, true);
    });
    const coverage = handle.result.reviewCoverage.items.find(row => row.id === objectId);
    assert.equal(stop.status, mode === 'crossing' ? 'UNVERIFIED' : 'NO_DEVIATION_FOUND');
    assert.equal(coverage.disposition, mode === 'crossing' ? 'UNVERIFIED' : 'SOURCE_REVIEWED');
    if (mode === 'resolved') assert.equal(coverage.originCoverage.candidateCount, 0);
    assert.equal(stop.admission, null);
  });
});

test('strict production origins preserve ordinary processing without file-selector dispatch evidence', async t => {
  const requirement = 'Expose the documented transformation through the public transform function.';
  const cases = [
    ['number', 'export function transform(input) { return Number(input) + 1; }', 1],
    ['json', 'export function transform(input) { return JSON.stringify(input); }', 1],
    ['nested-calls', 'export function transform(input) { return Math.max(Number(input), 0); }', 1],
    ['number-peers', 'export function transform(input, flag) { if (flag) { return Number("0"); } return Number(input); }', 1],
    ['json-peers', 'export function transform(input, flag) { if (flag) { return JSON.stringify("fallback"); } return JSON.stringify(input); }', 1],
    ['custom-peers', 'function normalize(value) { return value; }\nexport function transform(input, flag) { if (flag) { return normalize("0"); } return normalize(input); }', 2],
  ];
  for (const [mode, sourceText, line] of cases) await t.test(mode, async t => {
    const f = await frameStopCase(t, { enabled: false, requireCurrentProductionCoverage: true,
      requireProductionOriginCoverage: true, userText: requirement, sourceText: 'export const marker = 0;\n' });
    const sourceFile = path.join(f.projectRoot, 'processing', 'Result.mjs');
    await fs.mkdir(path.dirname(sourceFile), { recursive: true });
    await fs.writeFile(sourceFile, sourceText + '\n');
    let objectId;
    const { stop, handle } = await f.run(async tools => {
      const submit = (name, args) => submitFrameTool(tools.call, name, args);
      let original;
      for (const file of tools.task.basisFiles) {
        const id = await tools.read(file);
        if (path.basename(file).startsWith('user-original-')) original = id;
      }
      const page = await submit('set_original_checklist', { items: [{ metricId: 'M16', verificationTarget: 'IMPLEMENTATION',
        implementationRole: 'PRODUCTION', text: requirement, citeId: original, lineStart: 1, lineEnd: 1 }],
      scope: { stopClassification: 'TASK_COMPLETE', completionClaim: true } });
      objectId = page.items.find(item => item.description === requirement).objectId;
      const source = await tools.read(sourceFile), span = { citeId: source, start: line, end: line };
      const receipt = await submit('review_production_origin', { objectId, entry: span });
      assert.equal(receipt.status, 'READY', receipt.reason);
      assert.deepEqual(receipt.candidates, []);
      assert.equal((await submit('finish_stop_review', { ...frameFinishArgs(), productionCoverage: [{ objectId,
        reason: 'The public function performs the documented transformation.', citeIds: [source],
        flow: { entry: span, consumer: span, originReceiptId: receipt.receiptId, upstream: [] } }] })).complete, true);
    });
    assert.equal(stop.status, 'NO_DEVIATION_FOUND');
    assert.equal(handle.result.reviewCoverage.items.find(row => row.id === objectId).disposition, 'SOURCE_REVIEWED');
    assert.equal(stop.admission, null);
  });
});

test('strict production origins reject incomplete primary dispatch discovery', async t => {
  const requirement = 'Dispatch the selected option to the report consumer.';
  for (const mode of ['dynamic-sibling', 'ambiguous-anchor', 'unsupported-anchor', 'opaque-template', 'optional-call',
    'computed-call', 'parenthesized-call', 'healthy', 'healthy-header', 'legacy-dynamic']) await t.test(mode, async t => {
    const strict = mode !== 'legacy-dynamic';
    const selected = 'emit({ route: "reports/Result", option });';
    const anchor = mode === 'unsupported-anchor' ? 'emit(packet);'
      : mode === 'ambiguous-anchor' ? `${selected} ${selected}` : selected;
    const opaqueAlternates = {
      'opaque-template': '`${emit({ route: "reports/Result", option: "discarded" })}`;',
      'optional-call': 'emit?.({ route: "reports/Result", option: "discarded" });',
      'computed-call': '[emit][0]({ route: "reports/Result", option: "discarded" });',
      'parenthesized-call': '(emit)({ route: "reports/Result", option: "discarded" });',
    };
    const f = await frameStopCase(t, { enabled: false, requireCurrentProductionCoverage: true,
      requireProductionOriginCoverage: strict, userText: requirement, sourceText: mode === 'healthy-header'
        ? 'export function dispatch(emit, option) { emit({ route: "reports/Result", option }); console.info("ready"); }\n' : [
        'export function dispatch(flag, emit, option, packet) {',
        '  if (flag) {',
        `    ${anchor}`,
        '  } else {',
        `    ${opaqueAlternates[mode] ?? (['healthy', 'unsupported-anchor'].includes(mode) ? selected : 'emit(packet);')}`,
        '  }',
        '}',
      ].join('\n') + '\n' });
    if (opaqueAlternates[mode]) {
      const { dispatch } = await import(pathToFileURL(f.source).href);
      let observed;
      dispatch(false, packet => { observed = packet.option; }, 'selected', {});
      assert.equal(observed, 'discarded', 'the omitted alternate really dispatches the wrong option');
    }
    const consumerFile = path.join(f.projectRoot, 'reports', 'Result.mjs');
    await fs.mkdir(path.dirname(consumerFile), { recursive: true });
    await fs.writeFile(consumerFile, 'export function consume(packet) {\n  return packet.option;\n}\n');
    let objectId;
    const { stop, handle } = await f.run(async tools => {
      const submit = (name, args) => submitFrameTool(tools.call, name, args);
      let original;
      for (const file of tools.task.basisFiles) {
        const id = await tools.read(file);
        if (path.basename(file).startsWith('user-original-')) original = id;
      }
      const page = await submit('set_original_checklist', { items: [{ metricId: 'M16', verificationTarget: 'IMPLEMENTATION',
        implementationRole: 'PRODUCTION', text: requirement, citeId: original, lineStart: 1, lineEnd: 1 }],
      scope: { stopClassification: 'TASK_COMPLETE', completionClaim: true } });
      objectId = page.items.find(item => item.description === requirement).objectId;
      const source = await tools.read(f.source), span = line => ({ citeId: source, start: line, end: line });
      const consumer = await tools.read(consumerFile), effect = { citeId: consumer, start: 2, end: 2 };
      const entry = span(mode === 'healthy-header' ? 1 : 3);
      const flow = { entry, handoff: entry, consumer: effect };
      if (mode === 'healthy') flow.branches = [{ disposition: 'VERIFIED', reason: 'The alternate dispatch passes the same option.',
        entry: span(5), handoff: span(5), consumer: effect }];
      if (strict) {
        const receipt = await submit('review_production_origin', { objectId, entry: flow.entry });
        assert.equal(receipt.status, 'READY', receipt.reason);
        assert.deepEqual(receipt.candidates, []);
        flow.originReceiptId = receipt.receiptId;
        flow.upstream = [];
      }
      const finish = () => submit('finish_stop_review', { ...frameFinishArgs(), productionCoverage: [{ objectId,
        reason: 'The dispatch passes the selected option.', citeIds: [source, consumer], flow }] });
      const first = await finish();
      if (['healthy', 'healthy-header', 'legacy-dynamic'].includes(mode)) assert.equal(first.complete, true);
      else {
        const reasons = { 'dynamic-sibling': 'UNRESOLVED_SIBLING', 'ambiguous-anchor': 'AMBIGUOUS_ANCHOR',
          'unsupported-anchor': 'UNSUPPORTED_ARGUMENT', 'opaque-template': 'UNSUPPORTED_EXECUTABLE_SYNTAX',
          'optional-call': 'UNSUPPORTED_EXECUTABLE_SYNTAX', 'computed-call': 'UNSUPPORTED_EXECUTABLE_SYNTAX',
          'parenthesized-call': 'UNSUPPORTED_EXECUTABLE_SYNTAX' };
        assert.equal(first.complete, false);
        assert.equal(first.pendingProductionCoverage[0].originIssue, `PRIMARY_DISPATCH_${reasons[mode]}`);
        assert.equal((await finish()).complete, true);
      }
    });
    const healthy = ['healthy', 'healthy-header', 'legacy-dynamic'].includes(mode);
    const coverage = handle.result.reviewCoverage.items.find(row => row.id === objectId);
    assert.equal(stop.status, healthy ? 'NO_DEVIATION_FOUND' : 'UNVERIFIED');
    assert.equal(coverage.disposition, healthy ? 'SOURCE_REVIEWED' : 'UNVERIFIED');
    assert.equal(stop.admission, null);
  });
});

test('strict production origins account for upstream file-backed callers before accepting downstream-only proof', async t => {
  const requirement = 'Exports requested through the CLI must use the chosen separator, including cached inputs.';
  let foreignReceipt;
  for (const mode of ['legacy', 'healthy', 'out-of-scope', 'non-dispatch-verified', 'missing', 'unread', 'incomplete', 'foreign', 'wrong-entry', 'disconnected', 'stale', 'partial', 'dispatch-unknown', 'opaque-template', 'escaped-selector', 'indirect-call', 'unsupported', 'flag-alone', 'deviation']) await t.test(mode, async t => {
    const broken = ['legacy', 'deviation', 'opaque-template', 'escaped-selector'].includes(mode);
    const f = await frameStopCase(t, { enabled: false, requireCurrentProductionCoverage: mode !== 'flag-alone',
      requireProductionOriginCoverage: mode !== 'legacy', userText: requirement, sourceText: [
        `${mode === 'indirect-call' ? 'import { renderExport } from "./views/ExportView.mjs"; ' : ''}export function install(register, emit, separator, cached) {`,
        `  register("export", () => {${mode === 'indirect-call' ? ' renderExport.call(null, { separator }, []);' : ''}`,
        '    if (cached) {',
        `${mode === 'opaque-template' ? '      `${' : '      '}emit({ view: "${mode === 'escaped-selector' ? 'views/\\u0045xportView' : 'views/ExportView'}", params: { cached${broken ? '' : ', separator'} }${mode === 'dispatch-unknown' ? ', ...{}' : ''} })${mode === 'opaque-template' ? '}`' : ''};`,
        '      return;',
        '    }',
        '    emit({ view: "views/ExportView", params: { separator } });',
        '  });',
        '}',
      ].join('\n') + '\n' });
    const consumerFile = path.join(f.projectRoot, 'views', mode === 'unsupported' ? 'ExportView.py' : 'ExportView.mjs');
    await fs.mkdir(path.dirname(consumerFile), { recursive: true });
    await fs.writeFile(consumerFile, mode === 'unsupported'
      ? 'def render_export(params, rows):\n    return params.get("separator", ",").join(rows)\n'
      : 'export function renderExport(params, rows) {\n  return rows.join(params.separator ?? ",");\n}\n');
    const unrelated = path.join(f.projectRoot, 'help.mjs');
    if (['out-of-scope', 'non-dispatch-verified'].includes(mode)) await fs.writeFile(unrelated, 'export const label = "views/ExportView";\n');
    const auxiliary = path.join(f.projectRoot, 'auxiliary.mjs');
    await fs.writeFile(auxiliary, 'export const marker = 0;\n');
    if (mode === 'partial') await fs.writeFile(path.join(f.projectRoot, 'oversized.mjs'), ' '.repeat(256 * 1024 + 1));
    const { install } = await import(pathToFileURL(f.source).href);
    const { renderExport } = mode === 'unsupported' ? {} : await import(pathToFileURL(consumerFile).href);
    for (const cached of mode === 'unsupported' ? [] : [false, true]) {
      let callback, actual;
      install((name, run) => { callback = run; }, packet => { actual = renderExport(packet.params, ['alpha', 'beta']); }, ';', cached);
      callback();
      assert.equal(actual, broken && cached ? 'alpha,beta' : 'alpha;beta');
    }
    let objectId;
    const { stop, handle } = await f.run(async tools => {
      const submit = (name, args) => submitFrameTool(tools.call, name, args);
      let original;
      for (const file of tools.task.basisFiles) {
        const id = await tools.read(file);
        if (path.basename(file).startsWith('user-original-')) original = id;
      }
      const page = await submit('set_original_checklist', { items: [{ metricId: 'M16', verificationTarget: 'IMPLEMENTATION',
        implementationRole: 'PRODUCTION', text: requirement, citeId: original, lineStart: 1, lineEnd: 1 }],
      scope: { stopClassification: 'TASK_COMPLETE', completionClaim: true } });
      const item = page.items.find(item => item.description === requirement);
      objectId = item.objectId;
      if (mode === 'flag-alone') {
        assert.notEqual(item.requiresProductionCoverage, true);
        assert.equal((await submit('finish_stop_review', frameFinishArgs())).complete, true);
        return;
      }
      assert.equal(item.requiresProductionOriginCoverage === true, mode !== 'legacy');
      const consumer = await tools.read(consumerFile), span = (citeId, line) => ({ citeId, start: line, end: line });
      const flow = { entry: span(consumer, 1), consumer: span(consumer, 2) };
      const finish = () => submit('finish_stop_review', { ...frameFinishArgs(), productionCoverage: [{ objectId,
        reason: 'The formatter consumes the supplied separator.', citeIds: [consumer], flow }] });
      if (mode === 'deviation') {
        const producer = await tools.read(f.source);
        await submit('submit_review', { taskId: objectId, verdict: 'DEVIATION',
          reason: 'Cached export omits the chosen separator, so the formatter defaults to comma.', citeIds: [producer, consumer] });
        assert.equal((await submit('finish_stop_review', frameFinishArgs())).complete, true);
        return;
      }
      if (!['legacy', 'missing'].includes(mode)) {
        const receipt = await submit('review_production_origin', { objectId, entry: flow.entry });
        flow.originReceiptId = mode === 'foreign' ? foreignReceipt : receipt.receiptId;
        if (mode === 'healthy') foreignReceipt = receipt.receiptId;
        if (['partial', 'unsupported', 'opaque-template', 'escaped-selector', 'indirect-call'].includes(mode)) {
          assert.equal(receipt.status, 'UNKNOWN');
          assert.deepEqual(receipt.candidates, []);
          if (['opaque-template', 'escaped-selector', 'indirect-call'].includes(mode)) {
            assert.equal(receipt.reason, 'UNPARSED_POTENTIAL_ORIGIN');
            assert.equal(receipt.unparsedOrigin.path, 'app.mjs');
            assert.equal(receipt.unparsedOrigin.start, mode === 'indirect-call' ? 2 : 4);
            if (mode === 'escaped-selector') assert.equal(receipt.unparsedOrigin.reason, 'ESCAPED_RUNTIME_STRING');
            if (mode === 'indirect-call') assert.equal(receipt.unparsedOrigin.reason, 'INDIRECT_CALLABLE_REFERENCE');
          }
        } else {
          assert.equal(receipt.status, 'READY', receipt.reason);
          assert.equal(receipt.sourceReadAcknowledged, false);
          assert.deepEqual(receipt.candidates.filter(row => row.path === 'app.mjs').map(row => [row.path, row.start]), [['app.mjs', 4], ['app.mjs', 7]]);
        }
        const producer = mode === 'unread' ? 'unacknowledged-index-read' : await tools.read(f.source);
        const disconnected = mode === 'disconnected' ? await tools.read(auxiliary) : null;
        const terminal = span(disconnected ?? consumer, disconnected ? 1 : 2);
        const helpRead = ['out-of-scope', 'non-dispatch-verified'].includes(mode) ? await tools.read(unrelated) : null;
        flow.upstream = receipt.candidates.map(candidate => candidate.path === 'help.mjs'
          ? mode === 'non-dispatch-verified'
            ? { candidateId: candidate.candidateId, disposition: 'VERIFIED', reason: 'This supposed source dispatch is only a label.',
              citeIds: [helpRead, consumer], flow: { entry: span(helpRead, 1), handoff: span(helpRead, 1), consumer: span(consumer, 2) } }
            : { candidateId: candidate.candidateId, disposition: 'OUT_OF_SCOPE', reason: 'This source defines a help label, without dispatching an export.',
              citeIds: [helpRead], entry: span(helpRead, 1) }
          : ({ candidateId: candidate.candidateId,
          disposition: 'VERIFIED', reason: 'The CLI branch forwards the selected separator.', citeIds: [producer, consumer, ...(disconnected ? [disconnected] : [])],
          flow: { entry: span(producer, candidate.start), handoff: span(producer, candidate.start), consumer: terminal,
            branches: receipt.candidates.filter(other => other.path === candidate.path && other.candidateId !== candidate.candidateId).map(other => ({
              disposition: 'VERIFIED', reason: 'The other applicable export also forwards the choice.',
              entry: span(producer, other.start), handoff: span(producer, other.start), consumer: terminal,
            })) } }));
        if (mode === 'incomplete') flow.upstream.pop();
        if (mode === 'wrong-entry') flow.entry = span(consumer, 2);
        if (mode === 'stale') await fs.writeFile(auxiliary, 'export const marker = 1;\n');
      }
      const first = await finish();
      if (['legacy', 'healthy', 'out-of-scope'].includes(mode)) assert.equal(first.complete, true);
      else {
        assert.equal(first.complete, false);
        assert.equal(first.pendingProductionCoverageCount, 1);
        assert.equal((await finish()).complete, true);
      }
    });
    const coverage = handle.result.reviewCoverage.items.find(row => row.id === objectId);
    if (mode === 'deviation') {
      assert.equal(stop.status, 'DEVIATION'); assert.equal(stop.decision, 'block'); assert(stop.admission);
    } else if (['legacy', 'healthy', 'out-of-scope', 'flag-alone'].includes(mode)) {
      assert.equal(stop.status, 'NO_DEVIATION_FOUND'); assert.equal(stop.admission, null);
      if (mode !== 'flag-alone') assert.equal(coverage.disposition, 'SOURCE_REVIEWED');
      if (['healthy', 'out-of-scope'].includes(mode)) {
        assert.equal(coverage.originCoverage.status, 'OBSERVED_CANDIDATES_REVIEWED');
        assert.equal(coverage.originCoverage.candidateCount, mode === 'healthy' ? 2 : 3);
        assert.equal(coverage.upstream.length, mode === 'healthy' ? 2 : 3);
        assert(coverage.upstream.filter(row => row.disposition === 'VERIFIED').every(row => row.flow.entry.path === 'app.mjs'));
      }
    } else {
      assert.equal(stop.status, 'UNVERIFIED'); assert.equal(stop.admission, null);
      assert.equal(coverage.disposition, 'UNVERIFIED');
      assert.equal(coverage.originCoverage.status, 'UNVERIFIED');
      if (mode === 'unsupported') assert.equal(coverage.originCoverage.reason, 'UNSUPPORTED_SOURCE_LANGUAGE');
      if (mode === 'partial') assert.equal(coverage.originCoverage.reason, 'PARTIAL_OR_UNRESOLVED_INDEX');
      if (mode === 'dispatch-unknown') assert.match(coverage.originCoverage.reason, /^UPSTREAM_DISPATCH_/u);
      if (['opaque-template', 'escaped-selector', 'indirect-call'].includes(mode)) assert.equal(coverage.originCoverage.reason, 'UNPARSED_POTENTIAL_ORIGIN');
      if (mode === 'non-dispatch-verified') assert.equal(coverage.originCoverage.reason, 'UPSTREAM_DISPATCH_NO_LITERAL_DISPATCH_AT_ANCHOR');
      if (mode === 'disconnected') assert.equal(coverage.originCoverage.reason, 'UPSTREAM_FLOW_DISCONNECTED');
    }
    assert.equal((await createStopCorrectionStore({ directory: f.directory }).inspect(f.sessionId)).used, 0);
  });
});

test('a current source deviation can finish on submission only when separate review work is settled', async t => {
  const userText = 'Return the input plus one.\nReturn zero from reset.\nSet active mode to release before completion.';
  for (const mode of ['separate', 'combined', 'corrected-citation', 'downgraded-citation', 'pending-citation', 'frame', 'process', 'regression', 'prior-follow-up'])
    await t.test(mode, async t => {
      const f = await frameStopCase(t, { enabled: mode === 'frame', deviation: true, metricIds: ['M16', 'M11'],
        userText,
        ...(mode === 'process' ? { processEntries: [
          { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'mode', name: 'Bash', input: { command: 'check-mode' } }] } },
          { type: 'user', isMeta: true, message: { content: [{ type: 'tool_result', tool_use_id: 'mode', content: 'Active mode is debug.' }] } },
        ] } : {}) });
      if (mode === 'regression') await fs.appendFile(f.source, '// A source change triggers the standing regression check.\n');

      const { stop, handle } = await f.run(async ({ task, read, call, worker }, input) => {
        if (mode === 'regression') {
          const onScope = input.onScope;
          input.onScope = async (...args) => ({ ...await onScope(...args), regressionCheck: { status: 'UNAVAILABLE', reason: 'FIXTURE_RUN_UNAVAILABLE' } });
        }
        const submit = (name, args) => submitFrameTool(call, name, args);
        for (const file of task.basisFiles) await read(file);
        const original = task.basisFiles.find(file => path.basename(file).startsWith('user-original-'));
        const items = ['Return the input plus one.', 'Return zero from reset.'].map((text, index) => ({
          metricId: 'M16', verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION',
          text, path: original, lineStart: index + 1, lineEnd: index + 1,
        }));
        if (mode === 'process') items.push({ metricId: 'M11', verificationTarget: 'PROCESS',
          text: 'Set active mode to release before completion.', path: original, lineStart: 3, lineEnd: 3 });
        const page = await submit('set_original_checklist', { items, scope: { stopClassification: 'TASK_COMPLETE', completionClaim: true } });
        const [first, sibling] = items.slice(0, 2).map(item => page.items.find(row => row.description === item.text).objectId);
        const source = await read(f.source);
        const deviation = { taskId: first, verdict: 'DEVIATION', reason: 'The current transform returns its input unchanged.',
          citeIds: [source], ...(mode === 'separate' ? {} : { finish: true }) };
        const invalid = { ...deviation, taskId: mode === 'pending-citation' ? sibling : first, citeIds: ['unissued-source-citation'] };
        if (mode.endsWith('-citation')) await assert.rejects(submit('submit_review', invalid), { code: 'TASK_CITATION_INVALID' });
        if (mode === 'process') {
          const processId = page.items.find(item => item.metricId === 'M11').objectId;
          const { processEvidence } = await expandChecklist(submit, await submit('review_checklist', { includeProcessEvidence: true }));
          const resultId = await read(processEvidence.executionSamples[0].resultFile);
          assert.equal((await submit('submit_review', { taskId: processId, verdict: 'DEVIATION',
            reason: 'The original process result reports debug mode.', citeIds: [resultId] })).processClassificationRequired, true);
        }
        const receipt = await submit('submit_review', mode === 'downgraded-citation' ? invalid : deviation);
        assert.equal(receipt.saved, true);
        assert.equal(receipt.itemId, first);
        const combined = ['combined', 'corrected-citation'].includes(mode);
        assert.equal(worker.isComplete(), combined);
        assert.equal(receipt.complete === true, combined);
        if (combined) return;
        if (mode === 'downgraded-citation') assert.equal(receipt.verdict, 'UNVERIFIED');
        if (mode !== 'separate' && mode !== 'downgraded-citation') assert.equal(receipt.next, 'finish_stop_review');
        if (mode === 'prior-follow-up') {
          assert(page.items.find(item => item.objectId === sibling).previousDeviation);
          await assert.rejects(submit('finish_stop_review', frameFinishArgs()), { code: 'REVIEW_ITEM_INCOMPLETE' });
          await submit('submit_review', { taskId: sibling, verdict: 'UNVERIFIED', reason: 'The carried item still lacks current evidence.' });
        }
        const finish = await submit('finish_stop_review', { ...frameFinishArgs(mode === 'frame' ? unverifiedFrame() : undefined),
          ...(mode === 'regression' ? { regressionCheck: { status: 'UNVERIFIED', reason: 'The fixture check could not run.' } } : {}) });
        assert.equal(finish.complete, true);
      }, mode === 'prior-follow-up' ? async taskId => {
        const population = await buildMetricPopulation({ projectRoot: f.projectRoot, taskId, groundTruth: { version: 0, claims: [] }, persist: false });
        const [object] = buildOriginalStopPopulation({ population, sourceDigest: 'fixture-original', checklist: [{
          metricId: 'M16', verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION', text: 'Return zero from reset.',
          source: { kind: 'USER_MESSAGE', ref: 'transcript:user-original', part: 1, sha256: sha256(userText), start: 2, end: 2 },
        }] }).population.metrics.M16;
        const evaluationId = 'stop-0123456789abcdef';
        await recordDeviationFindings({ projectRoot: f.projectRoot, taskId, pipeline: 'STOP', evaluationId, delivered: true,
          findings: [{ deviationKey: `metric:M16:${object.sourceId}`, rootCauseId: 'REQUIREMENT_OMITTED', severity: 'error',
            reason: 'The earlier implementation omitted reset.', violatedGroundTruthIds: [object.sourceId] }] });
        await atomicWriteJson(path.join(taskDirectory(f.projectRoot, taskId), 'evaluations', `${evaluationId}.json`), {
          metricReport: { metrics: [{ objects: [{ ...object, judgement: 'DEVIATION' }] }] },
        });
      } : undefined);

      if (mode === 'downgraded-citation') {
        assert.notEqual(stop.status, 'DEVIATION');
        assert.equal(stop.verificationIncomplete, true);
        assert.equal(stop.admission, null);
      } else {
        assert.equal(stop.status, 'DEVIATION');
        assert(stop.admission);
      }
      assert.equal(handle.result.citationDiagnostics.correctedItems, mode === 'corrected-citation' ? 1 : 0);
      assert.equal(handle.result.citationDiagnostics.downgradedItems, ['downgraded-citation', 'pending-citation'].includes(mode) ? 1 : 0);
    });
});

test('production Stop never admits an unclassified process claim, but keeps a real current repair', async t => {
  for (const [repair, finding] of [[false, false], [true, false], [false, true], [true, true]])
    await t.test(`${finding ? 'finding' : 'row'}: ${repair ? 'current residue' : 'unclassified history'}`, async t => {
    const f = await frameStopCase(t, { basis: { guidance: [], scenarios: [] }, metricIds: ['M11'],
      userText: 'Set active mode to release before completion.', processEntries: [
        { type: 'assistant', uuid: 'mode-call', message: { content: [{ type: 'tool_use', id: 'mode', name: 'Bash', input: { command: 'check-active-mode' } }] } },
        { type: 'user', uuid: 'mode-result', isMeta: true, message: { content: [{ type: 'tool_result', tool_use_id: 'mode', is_error: false, content: 'Active mode is debug.' }] } },
      ] });
    const { stop } = await f.run(async tools => {
      const submit = (name, args) => submitFrameTool(tools.call, name, args);
      let original;
      for (const file of tools.task.basisFiles) { const id = await tools.read(file); if (path.basename(file).startsWith('user-original-')) original = id; }
      await submit('set_original_checklist', { items: [{ metricId: 'M11', verificationTarget: 'PROCESS',
        text: 'Set active mode to release before completion.', citeId: original, lineStart: 1, lineEnd: 1 }] });
      const checklist = await materializeStopChecklist(await submit('review_checklist', { stopClassification: 'TASK_COMPLETE', completionClaim: true, includeProcessEvidence: true }), submit);
      const ids = [];
      for (const sample of checklist.processEvidence.executionSamples) for (const file of [...sample.invocationFiles, sample.resultFile]) ids.push(await tools.read(file));
      const objectId = checklist.items[0].taskId;
      if (finding) await submit('submit_finding', { deviationKey: 'active-mode-finding', rootCauseId: 'REQUIREMENT_OMITTED',
        severity: 'warning', reason: 'The original process result was debug.', expectedConstraint: 'Set active mode to release before completion.',
        violatedGroundTruthIds: [checklist.items[0].sourceId], citeIds: ids });
      else await submit('submit_review', { taskId: objectId, verdict: 'DEVIATION', reason: 'The original process result was debug.', citeIds: ids });
      await submit('finish_stop_review', { summary: 'Process classification controls admission.', ...(repair ? { processRepairs: [{
        objectId: finding ? 'active-mode-finding' : objectId, currentResidue: 'The current active mode remains debug.', repairAction: 'Set release mode and verify the current setting.' }] } : {}) });
    });
    assert.equal(stop.status === 'DEVIATION', repair, JSON.stringify(stop));
    if (!repair) {
      assert.equal(stop.admission, null); assert.equal(stop.correctionAttempt, 0);
      assert.equal(stop.verificationIncomplete, true); assert.equal(stop.historicalDeviations?.length ?? 0, 0);
    }
  });
});

test('production Stop closes with historical deviation, keeps the deviation and never redispatches its notice', async t => {
  const processEntries = [
    { type: 'assistant', uuid: 'create-call', message: { content: [{ type: 'tool_use', id: 'created', name: 'openspec_cli', input: { args: ['new', 'change', 'demo'] } }] } },
    { type: 'user', uuid: 'create-result', isMeta: true, message: { content: [{ type: 'tool_result', tool_use_id: 'created', is_error: false, content: 'Created successfully.' }] } },
    { type: 'assistant', uuid: 'status-call', message: { content: [{ type: 'tool_use', id: 'status', name: 'openspec_cli', input: { args: ['status'] } }] } },
    { type: 'user', uuid: 'status-result', isMeta: true, message: { content: [{ type: 'tool_result', tool_use_id: 'status', is_error: false, content: 'Status returned successfully.' }] } },
  ];
  const f = await frameStopCase(t, { basis: { guidance: [], scenarios: [] }, metricIds: ['M11'],
    userText: 'Query status before creating the change.', processEntries });
  const { stop } = await f.run(async tools => {
    const submit = (name, args) => submitFrameTool(tools.call, name, args);
    let original;
    for (const file of tools.task.basisFiles) { const id = await tools.read(file); if (path.basename(file).startsWith('user-original-')) original = id; }
    await submit('set_original_checklist', { items: [{ metricId: 'M11', verificationTarget: 'PROCESS',
      text: 'Query status before creating the change.', citeId: original, lineStart: 1, lineEnd: 1 }] });
    const checklist = await materializeStopChecklist(await submit('review_checklist', { stopClassification: 'TASK_COMPLETE', completionClaim: true, includeProcessEvidence: true }), submit);
    const citations = [];
    for (const sample of checklist.processEvidence.executionSamples) for (const file of [...sample.invocationFiles, sample.resultFile]) citations.push(await tools.read(file));
    const id = checklist.items[0].taskId;
    await submit('submit_review', { taskId: id, verdict: 'DEVIATION', reason: 'The completed creation precedes the required status query.', citeIds: citations });
    await submit('finish_stop_review', { summary: 'Only the proved historical order remains.', historicalOrders: [{
      objectId: id, requiredFirstEventId: 'status', requiredSecondEventId: 'created', historicalOnly: true,
      reason: 'Creation already occurred; future creations still require a prior status query.' }] });
  });
  assert.equal(stop.status, 'COMPLETED_WITH_HISTORICAL_DEVIATIONS', JSON.stringify(stop));
  assert.equal(stop.decision, 'allow'); assert.equal(stop.admission, null); assert.equal(stop.correctionAttempt, 0);
  assert.equal(stop.verificationIncomplete, false); assert.equal(stop.historicalDeviations.length, 1);
  assert.equal(stop.report.judgements?.[0]?.judgement ?? stop.review.metricObjectJudgements[0]?.judgement, 'DEVIATION');
  assert.match(stop.feedback, /historical-notice/);
  const again = (await f.run(async () => assert.fail('An unchanged completed Stop must not invoke a new reviewer.'))).stop;
  assert.equal(again.status, 'COMPLETED_WITH_HISTORICAL_DEVIATIONS'); assert.equal(again.feedback, null);
  assert.equal(again.historicalNotices.length, 0);
});


test('original-path review method reaches the existing worker without changing default verdict rules', async t => {
  for (const mode of ['no-deviation', 'unexamined', 'counterexample', 'new-pass-rejected']) await t.test(mode, async t => {
    const f = await fixedVersionFixture(t);
    f.input.request.population.reviewPolicy = resolveStopReviewPolicy({ deviationOnly: true });
    const handle = await checkedVersionRun(f, async ({ params, readAll, read, submit }) => {
      const prompt = params.extraSystemPrompt;
      assert.equal(typeof prompt, 'string');
      assert.equal(prompt.match(/trace required success\/error paths/gu)?.length, 1);
      assert.match(prompt, /actual entry through deciding predicates to the observable result/u);
      assert.match(prompt, /original allowed inputs and exceptions, even without a runtime example/u);
      assert.match(prompt, /passing tests or full-file read acknowledgments do not prove behavior/u);
      assert.match(prompt, /Judge every original condition in context; keep uncertain activation or unexamined required implementation paths UNVERIFIED/u);
      assert.match(prompt, /This method adds no execution requirement/u);
      assert.match(prompt, /no deviation attachments; existing known CURRENT, carried PASS and enabled coverage requirements still apply/u);
      await readAll(); await f.scope(submit);
      const citeId = (await read(f.source)).details.citation.citeId;
      if (mode === 'new-pass-rejected') await assert.rejects(submit('submit_review', {
        taskId: 'M16:R1', verdict: 'PASS', reason: 'An ordinary new item cannot gain carried-PASS authority.', citeIds: [citeId],
      }), { code: 'TASK_SUBMISSION_INVALID' });
      if (mode === 'unexamined' || mode === 'new-pass-rejected') await submit('submit_review', {
        taskId: 'M16:R1', verdict: 'UNVERIFIED', reason: 'The original input-to-result path was not settled.',
      });
      if (mode === 'counterexample') await submit('submit_review', {
        taskId: 'M16:R1', verdict: 'DEVIATION', reason: 'The current return expression supplies the cited counterexample.', citeIds: [citeId],
      });
      assert.equal((await submit('finish_stop_review', { summary: 'The scripted protocol choices are recorded, not a model accuracy result.' })).complete, true);
    });
    assert.equal(f.calls.length, 1, 'the method adds no worker or retry');
    assert.equal(handle.reviewCompleted, true);
    assert.deepEqual(handle.result.metricObjectJudgements.map(row => row.judgement),
      mode === 'no-deviation' ? [] : [mode === 'counterexample' ? 'DEVIATION' : 'UNVERIFIED']);
    assert.equal(handle.result.findings.length, 0);
    await handle.close();
  });
});

test('original-path method policy makes the preceding same-Stop cache historical without a new worker', async t => {
  const f = await frameStopCase(t, { enabled: false, openClaw: false });
  let taskId, starts = 0;
  const first = await f.run(async (tools, input) => {
    starts++; taskId = input.taskId;
    const { finish } = await startFrameScan(tools);
    assert.equal((await finish()).complete, true);
  });
  assert.equal(first.stop.status, 'NO_DEVIATION_FOUND');
  const file = path.join(taskDirectory(f.projectRoot, taskId), 'evaluations', `${first.stop.evaluationId}.json`);
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  const { CONDITIONAL_REVIEW_POLICY_VERSION } = await import('../lib/review-task/task-evidence.mjs');
  const { SKILL_SOURCE_CONTRACT_VERSION } = await import('../lib/runtime-v2/skill-source.mjs');
  const { EXPECTED_FILE_BINDING_VERSION } = await import('../lib/runtime-v2/expected-files.mjs');
  const precedingPolicy = { conditional: CONDITIONAL_REVIEW_POLICY_VERSION, skillSource: SKILL_SOURCE_CONTRACT_VERSION,
    unverifiedPolicy: 'partial-observations-v2', citationPolicy: 'attachments-v1',
    expectedFileBinding: EXPECTED_FILE_BINDING_VERSION, historicalToolOutcome: 'complete-tool-result-v2',
    nativeProcessClaims: 'native-process-claims-v2-original-parts', deviationOnly: true,
    deviationScope: 'delivered-work-regression-v2', originalRequirementsBasis: true };
  assert.equal(saved.reviewPolicyVersion, sha256({ ...precedingPolicy, implementationReviewMethod: 'contrary-route-v1' }));
  const before = await fs.readFile(file);
  const unchanged = await f.run(() => { throw new Error('same-policy reuse must not start a worker'); });
  assert.equal(unchanged.stop.reused, true);
  assert.equal(unchanged.stop.status, 'NO_DEVIATION_FOUND');
  assert.deepEqual(await fs.readFile(file), before);
  saved.reviewPolicyVersion = sha256({ ...precedingPolicy, implementationReviewMethod: 'entry-predicate-result-v1' });
  await fs.writeFile(file, JSON.stringify(saved));
  const historical = await fs.readFile(file);
  const stale = await f.run(() => { throw new Error('policy invalidation must not start a worker'); });
  assert.equal(stale.stop.reused, true);
  assert.equal(stale.stop.status, 'UNVERIFIED');
  assert.equal(stale.stop.reasonCode, 'STOP_REVIEW_POLICY_STALE');
  assert.equal(stale.stop.admission, null);
  assert.equal(stale.stop.review, null);
  assert.deepEqual(await fs.readFile(file), historical, 'the old receipt is retained rather than rewritten as a current review');
  assert.equal(starts, 1);
  const ledger = await createStopCorrectionStore({ directory: f.directory }).inspect(f.sessionId);
  assert.equal(ledger.used, 0);
});


async function productionPendingNavigationFixture(t, { deviationOnly = false } = {}) {
  const f = await fixture(t);
  const requirements = ['Deliver the required value.', 'Preserve the requested label.'];
  f.input.request.classificationContract = 2;
  f.input.request.population.reviewPolicy = resolveStopReviewPolicy({ deviationOnly,
    requireCurrentProductionCoverage: true });
  f.input.evidence.snapshot.entries[0].message.content = requirements.join('\n');
  f.input.evidence.originalRequirements = await loadStopOriginalRequirements({ projectRoot: f.root,
    snapshot: f.input.evidence.snapshot });
  f.input.request.fileQualityReviewEnabled = !deviationOnly;
  f.input.request.artifactCandidates = [{ artifactId: 'delivery', files: [{ path: 'spec.md',
    sha256: sha256(await fs.readFile(f.file)) }] }];
  f.preparePendingNavigation = async tools => {
    await tools.readAll();
    const original = tools.brief.task.basisFiles.find(file => path.basename(file).startsWith('user-original-'));
    const citeId = (await tools.read(original)).details.citation.citeId;
    const page = await tools.submit('set_original_checklist', {
      items: requirements.map((text, index) => ({ metricId: 'M16', verificationTarget: 'IMPLEMENTATION',
        implementationRole: 'PRODUCTION', text, citeId, lineStart: index + 1, lineEnd: index + 1 })),
      scope: { stopClassification: 'TASK_COMPLETE', completionClaim: true, limit: 20 } });
    const objects = requirements.map(text => page.items.find(item => item.description === text));
    assert(objects.every(item => (item?.requiresProductionCoverage === true) === deviationOnly));
    assert.equal(page.pending, deviationOnly ? undefined : 3, 'full-review numeric pending counts only unsaved rows and file assessments');
    return objects;
  };
  return f;
}

test('full-review coverage option preserves legacy save navigation and saved-result recovery', async t => {
  const f = await productionPendingNavigationFixture(t);
  const handle = await checkedVersionRun(f, async tools => {
    const objects = await f.preparePendingNavigation(tools);
    const save = taskId => tools.submit('submit_review', { taskId, verdict: 'UNVERIFIED',
      reason: 'Current production proof is not established.', citeIds: [] });
    const first = await save(objects[0].objectId);
    assert.equal(first.saved, true); assert.equal(first.pending, 2);
    assert(first.pendingNavigation, 'the full-review numeric pending contract retains bounded navigation');
    assert.deepEqual(first.pendingNavigation.pendingIds, [objects[1].objectId, 'file:spec.md']);
    assert.equal(first.pendingNavigation.pendingTotal, 2);
    assert.equal(first.pendingNavigation.navigationOnly, true);
    assert(Buffer.byteLength(JSON.stringify(first.pendingNavigation)) <= 2048);
    assert(Buffer.byteLength(JSON.stringify(first)) <= 8192);
    const recovered = await tools.submit('review_checklist', { limit: 20 });
    assert.equal(recovered.items.find(item => item.objectId === objects[0].objectId).savedResult.judgement, 'UNVERIFIED');
    assert.equal(recovered.pending, 2);
    const history = await tools.submit('review_history', { mode: 'state' });
    assert.equal(typeof history, 'object');
    const second = await save(objects[1].objectId);
    assert.equal(second.pending, 1); assert.deepEqual(second.pendingNavigation.pendingIds, ['file:spec.md']);
    const last = await save('file:spec.md');
    assert.equal(last.pending, 0); assert.deepEqual(last.pendingNavigation.pendingIds, []);
    const finish = await tools.submit('finish_stop_review', { summary: 'Saved rows remain unverified without production proof.' });
    if (!finish.complete) await tools.submit('finish_stop_review', { summary: 'No production proof was established.' });
  });
  assert(handle.result.metricObjectJudgements.every(row => row.judgement === 'UNVERIFIED'));
  await handle.close();
});

test('missing production coverage pending view uses exact string object IDs and source diagnostics', async t => {
  const f = await productionPendingNavigationFixture(t, { deviationOnly: true });
  const handle = await checkedVersionRun(f, async tools => {
    const objects = await f.preparePendingNavigation(tools);
    const page = await tools.submit('review_checklist', { view: 'pending', limit: 20 });
    const coverage = page.items.filter(item => item.type === 'PRODUCTION_COVERAGE');
    assert.equal(coverage.length, 2);
    assert(coverage.every(item => typeof item.id === 'string' && typeof item.objectId === 'string'),
      'Map entries are not valid navigation IDs');
    assert.deepEqual(coverage.map(item => item.objectId), objects.map(item => item.objectId));
    for (const item of coverage) {
      assert.deepEqual(item.proofOwners, ['SOURCE']);
      assert.equal(item.diagnostic.code, 'CURRENT_PRODUCTION_COVERAGE_REQUIRED');
    }
    assert.equal(page.navigationOnly, true); assert(Buffer.byteLength(JSON.stringify(page)) <= 8192);
    for (const taskId of objects.map(item => item.objectId))
      await tools.submit('submit_review', { taskId, verdict: 'UNVERIFIED', reason: 'Current production proof is unavailable.', citeIds: [] });
    const finish = await tools.submit('finish_stop_review', { summary: 'Missing production coverage remains unverified.' });
    if (!finish.complete) await tools.submit('finish_stop_review', { summary: 'Coverage remains unavailable.' });
  });
  assert(handle.result.metricObjectJudgements.every(row => row.judgement === 'UNVERIFIED'));
  await handle.close();
});
