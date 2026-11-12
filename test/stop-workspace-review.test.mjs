import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { stopProtocolFixture } from './helpers/stop-protocol.mjs';
import { scriptedWorkspaceReview } from './helpers/scripted-workspace-review.mjs';
import { loadReviewCheckpoint } from '../lib/review-task/history-memory.mjs';
import { atomicWriteJson, sha256 } from '../lib/runtime-v2/utils.mjs';
import { scanSkillDirectory, bindSkillGraph } from '../lib/runtime-v2/skill-source.mjs';
import * as openclawHost from '../lib/hosts/openclaw.mjs';
import { skillGraphCandidate } from './helpers/skill-source-interpretation.mjs';
import { persistSkillGroundTruth } from '../lib/runtime-v2/ground-truth-ledger.mjs';
import { buildMetricPopulation } from '../lib/runtime-v2/metrics.mjs';
import { resolveStopReviewPolicy } from '../lib/runtime-v2/metric-policy.mjs';
import { prepareMixedSkillEvaluation, MIXED_SKILL_EXPECTED } from '../scripts/helpers/mixed-skill-evaluation.mjs';
import { createProductionTraceSchema, validateProductionTrace } from '../lib/review-task/production-trace.mjs';
import { taskDirectory } from '../lib/runtime-v2/task-store.mjs';
import { captureTaskStart } from '../lib/runtime-v2/task-changes.mjs';
import { compileRuntimeV2Config } from '../lib/runtime-v2/config.mjs';
import { handleRuntimeV2Event } from '../lib/runtime-v2/orchestrator.mjs';
import { frameReproduction } from '../lib/runtime-v2/requirement-frame.mjs';
import { createStopStartProtocol } from '../lib/openclaw/stop-start-protocol.mjs';
import { loadPublicToolArgumentsValidator } from '../lib/openclaw/compat-2026.7.1-2.mjs';

async function fixture(t) {
  const f = await stopProtocolFixture(t, 'findings');
  f.input.request.reviewScope = { kind: 'workspace-stop' };
  delete f.input.request.fixedStopClassification;
  f.input.evidence.snapshot.entries.push({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'edit-1', name: 'Edit', input: { file_path: f.file, old_string: 'before', new_string: 'after' } }] } });
  const scope = submit => submit('review_scope', { stopClassification: 'TASK_COMPLETE', summary: 'The original response claims completion.' });
  const result = (submit, citeIds = [], verdict = 'PASS') => submit('submit_review', { taskId: 'M01:R1', verdict, reason: 'Checked the current original delivery.', citeIds });
  return { ...f, scope, result };
}

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
    const checklist = await submit('review_checklist', { limit: 20 });
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
    const checklist = await submit('review_checklist', {}), plan = checklist.processReadPlan;
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

test('critical-path Stop plan truncation preserves inventory recovery and never certifies unread history', async t => {
  const f = await fixture(t); let failure;
  while (f.input.evidence.snapshot.entries.length < 80) f.input.evidence.snapshot.entries.push({ type: 'assistant', message: { content: 'Captured process original.' } });
  const handle = await f.run(async ({ readAll, submit }) => {
    try {
      await readAll(); await f.scope(submit);
      const checklist = await submit('review_checklist', {}), plan = checklist.processReadPlan;
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
    await readAll(); const checklist = await submit('review_checklist', { stopClassification: 'TASK_COMPLETE', limit: 20 });
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
        assert.equal(page.nextOffset, 20);
        const next = await submit('review_checklist', { offset: page.nextOffset, limit: 20 });
        assert.equal(next.nextOffset, null); assert.deepEqual(next.items.map(item => item.taskId), ids.slice(20));
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
    const checklist = await submit('review_checklist', {});
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
    await readAll(); const checklist = await submit('review_checklist', { stopClassification: 'TASK_COMPLETE' });
    assert.equal(checklist.total, 2);
    assert.notEqual(checklist.processNavigationOmitted, true);
    assert.equal(checklist.processEvidence.executionResultFileCount, 1);
    const sample = checklist.processEvidence.executionSamples[0];
    assert(!checklist.processFiles.includes(sample.resultFile), 'The execution lies beyond the first navigation page.');
    assert.equal(sample.invocationFileCount, 1); assert.equal(sample.invocationFiles.length, 1);
    const save = citeIds => submit('submit_review', { taskId: 'M12:R1', verdict: 'PASS', reason: 'The matching original invocation and successful result were read.', citeIds, finish: true });

    const result = await read(sample.resultFile);

    await read(sample.invocationFiles[0]);
    await submit('submit_review', { taskId: 'M16:R1', verdict: 'UNVERIFIED', reason: 'Current implementation has not been reviewed yet.', citeIds: [] });
    await save([result.details.citation.citeId]);
  });
  assert.equal(f.calls.length, 1);
  assert.equal(handle.result.metricObjectJudgements.find(row => row.objectId === 'M12:R1').judgement, 'PASS');
  assert.equal(handle.result.metricObjectJudgements.find(row => row.objectId === 'M16:R1').judgement, 'UNVERIFIED');
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
    const checklist = await submit('review_checklist', {});

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
    const checklist = await submit('review_checklist', {}), disclosed = new Set();
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
    await readAll(); const checklist = await submit('review_checklist', { stopClassification: 'TASK_COMPLETE' });
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
const frameInstructions = `Requirement frame (basis part requirement-frame): guidance items G* and behavior scenarios S* that the program prepared from the task-start code before this candidate existed, after checking that their evidence exists and their quotes come from the user messages. They are advisory: the original user messages remain the only authority, and the frame never adds obligations.
Before finishing, give every frame item exactly one entry in finish_stop_review.frameDispositions:
- CHECKED: you traced it and it holds. A textual reason is enough; no citation is required.
- DEVIATION: it does not hold, and you saved a proved deviation for the corresponding original requirement (checklist object or submit_finding). Give that objectId.
- UNVERIFIED: you could not establish it within budget, or it does not follow from the original messages. Give a short reason.
A frame item alone is never a deviation; a DEVIATION disposition needs a proved deviation saved through the normal tools. Check scenarios of kind requirement first, then guidance whose contractCell is transport_integration, branch_matrix, error_result or values_defaults.`;
const reproductionText = `For each deviation above:
1. First reproduce it with a minimal public check (an existing test, a command, or a throwaway script in the system temp directory that you delete afterwards) and confirm that it fails.
2. After the fix, rerun the same check and confirm that it passes; also run one nearby existing-behavior check to confirm that nothing else broke.
3. If you cannot reproduce it, explain why and do not change unrelated code just to pass the review.`;
const chineseReproduction = `处理上面每个偏差时：
1. 先用一个最小的公开检查复现它（现有测试、命令，或放在系统临时目录、用完即删的临时脚本），确认它确实失败。
2. 修改后再运行同一个检查，确认通过；再运行一个相邻的已有行为检查，确认原有行为没有被破坏。
3. 如果无法复现，说明原因，不要为了通过评审而改动无关代码。`;

async function frameStopCase(t, { enabled = true, review = true, stored = 'matching', deviation = false, locale = 'en', openClaw = true } = {}) {
  const f = await stopProtocolFixture(t, 'findings');
  const projectRoot = f.root, sessionId = 'protocol-host', directory = path.join(projectRoot, '.runtime-correction', 'host');
  const source = path.join(projectRoot, 'app.mjs'), transcript = path.join(projectRoot, 'session.jsonl');
  await fs.writeFile(source, `export const transform = input => ${deviation ? 'input' : 'input + 1'};\n`);
  const entries = [
    { type: 'user', uuid: 'user-original', message: { role: 'user', content: 'Implement transform.\nReturn the input plus one.' } },
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
    const file = path.join(projectRoot, '.runtime-correction', 'requirement-frame', sha256(sessionId).slice(0, 24), 'frame.json');
    await atomicWriteJson(file, { schemaVersion: 1, status: 'ready', reason: null, sessionId,
      startHead: stored === 'mismatch' ? 'another-head' : startHead, ...frameBasis });
  }
  const runtimeV2 = compileRuntimeV2Config({ version: 2, locale, dynamicGroundTruth: { enabled: false },
    requirementFrame: { enabled, inject: false, review },
    stopCorrection: { enabled: true, originalRequirementsBasis: true, deviationOnly: true, waitMode: 'until_pass',
      metrics: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`M${String(i + 1).padStart(2, '0')}`, i === 15])) } });
  return { projectRoot, sessionId, directory, source, runtimeV2, startHead,
    async run(script) {
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
        projectRoot, plan: { runtimeV2, artifacts: [] }, reviewerFactory,
        stopHost: { directory, startProtocol: { version: 1 }, stopId: 'frame-stop', openClaw },
        input: { hook_event_name, session_id: sessionId, cwd: projectRoot, transcript_path: transcript,
          last_assistant_message: 'Task complete.', ...fields },
      });
      await event('SessionStart', { source: 'startup' });
      const outcome = await event('Stop');
      if (scriptError) throw scriptError;
      assert(handle?.result, JSON.stringify(outcome.stop));
      return { stop: outcome.stop, handle };
    },
  };
}

const submitFrameTool = async (call, name, args) => JSON.parse((await call(name, args)).content[0].text);
const frameFinishArgs = frameDispositions => ({
  summary: 'Finished checking the original requirements.',
  ...(frameDispositions === undefined ? {} : { frameDispositions }),
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
    assert(tools.worker.systemPrompt.endsWith(frameInstructions));
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
