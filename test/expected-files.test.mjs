import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { stopProtocolFixture } from './helpers/stop-protocol.mjs';
import { applyGroundTruthDelta, loadCurrentGroundTruth } from '../lib/runtime-v2/ground-truth-ledger.mjs';
import { buildMetricPopulation } from '../lib/runtime-v2/metrics.mjs';
import { normalizeExpectedFiles, resolveExpectedFilePath, observeExpectedFile, expectedFilesCurrent } from '../lib/runtime-v2/expected-files.mjs';
import { GROUND_TRUTH_REVIEW_SCHEMA } from '../lib/runtime-v2/reviewer.mjs';
import { draftBaselineSchema, compactBaselineSchema, expandDraftBatch } from '../lib/review-task/baseline-selection.mjs';
import { validateJsonSchema } from '../lib/json-schema-validator.mjs';
import { validateStructuredReviewEvidence } from '../lib/runtime-v2/review-evidence-validation.mjs';
import { validateReviewJudgement } from '../lib/runtime-v2/review-result-validation.mjs';
import { sha256 } from '../lib/runtime-v2/utils.mjs';

async function fixture(t, { kind = 'CURRENT_TASK', severity = 'HARD', status = 'ACTIVE', metric = 'M12', target = 'ARTIFACT', expected = ['docs/report.md'], requirementText } = {}) {
  const f = await stopProtocolFixture(t, 'findings');
  f.input.request.reviewScope = { kind: 'workspace-stop' };
  delete f.input.request.fixedStopClassification;
  const claim = { ...f.input.evidence.groundTruth.claims[0], text: requirementText ?? `Deliver ${expected.join(' and ')}.`, expectedFiles: expected,
    applicabilityKind: kind, severity, status, verificationTarget: target };
  const truth = { ...f.input.evidence.groundTruth, claims: [claim], digest: sha256([claim]) };
  f.input.evidence.groundTruth = truth;
  await fs.writeFile(f.input.request.groundTruthPath, JSON.stringify(truth));
  const population = await buildMetricPopulation({ projectRoot: f.root, taskId: f.task.taskId, groundTruth: truth });
  f.input.request.population = { ...population, metrics: { [metric]: population.metrics[metric] } };
  const start = async (readAll, submit, classification = 'TASK_COMPLETE') => {
    await readAll(); return submit('review_checklist', { stopClassification: classification,
      ...(classification === 'STAGE_COMPLETE' ? { stage: 'design' } : {}) });
  };
  const finish = async submit => submit('finish_stop_review', { summary: 'Checked the explicit output contract.' });
  const run = async (...args) => {
    const handle = await f.run(...args);
    assert(handle.collection?.complete !== false || handle.collection.reasonCode === 'STOP_MOST_REQUIREMENTS_UNVERIFIED', JSON.stringify(handle.collection));
    return handle;
  };
  return { ...f, truth, start, finish, runRaw: f.run, run };
}

test('expected paths survive full/draft/compact extraction metadata, ledger revisions and metric projection', async t => {
  const f = await fixture(t);
  const metadata = { category: 'requirements', authority: 'USER_EXPLICIT', severity: 'HARD', applicabilityKind: 'CURRENT_TASK', verificationTarget: 'ARTIFACT' };
  const batch = { batchId: 1, defaults: metadata, keep: ['S0L1'], overrides: [{ unit: 'S0L1', metadata: { expectedFiles: ['docs/new.md'] } }] };
  assert.deepEqual(validateJsonSchema(batch, draftBaselineSchema(GROUND_TRUTH_REVIEW_SCHEMA)), []);
  assert.deepEqual(expandDraftBatch(batch, [{ id: 'S0L1', sourceIndex: 0, line: 1, clauses: 1 }]).operations[0].expectedFiles, ['docs/new.md']);
  const compact = { batchId: 1, defaults: { ...metadata, operation: 'ADD' }, outcomes: [{ name: 'output', lines: [1, 1], metadata: { expectedFiles: ['docs/new.md'] } }] };
  assert.deepEqual(validateJsonSchema(compact, compactBaselineSchema(GROUND_TRUTH_REVIEW_SCHEMA)), []);
  const operation = { ...metadata, operation: 'SUPERSEDE', claimId: 'R1', text: 'Deliver docs/new.md.', expectedFiles: ['docs/new.md'], source: { ref: 'user' } };
  assert.deepEqual(validateJsonSchema({ summary: 'New output', taskClassification: 'CORRECTION', operations: [operation] }, GROUND_TRUTH_REVIEW_SCHEMA), []);
  await applyGroundTruthDelta({ projectRoot: f.root, taskId: f.task.taskId, delta: { operations: [operation] } });
  const saved = await loadCurrentGroundTruth(f.root, f.task.taskId);
  assert.deepEqual(saved.claims[0].expectedFiles, ['docs/new.md']);
  const population = await buildMetricPopulation({ projectRoot: f.root, taskId: f.task.taskId, groundTruth: saved });
  assert.deepEqual(population.metrics.M12[0].expectedFiles, ['docs/new.md']);
  assert.notEqual(population.digest, f.input.request.population.digest);
  await applyGroundTruthDelta({ projectRoot: f.root, taskId: f.task.taskId, delta: { operations: [{ ...operation, text: 'Deliver an inline explanation.', expectedFiles: [] }] } });
  assert.deepEqual((await loadCurrentGroundTruth(f.root, f.task.taskId)).claims[0].expectedFiles, []);
});

test('output declarations require named exact paths rather than invented names, globs or directories', () => {
  assert.deepEqual(normalizeExpectedFiles(['docs\\report.md'], 'Deliver docs/report.md.'), ['docs/report.md']);
  for (const files of [['invented.md'], ['docs/*.md'], ['docs/'], ['<report>.md'], [''], [null], ['.'], ['https://example.com/report.md'], ['~/report.md'], ['C:report.md']])
    assert.throws(() => normalizeExpectedFiles(files, 'Deliver docs/report.md.'));
});

test('a directory and filename bind to the named output directory', () => {
  assert.equal(resolveExpectedFilePath('notes.md', 'Create directory `deliveries/revision-7`. Deliver notes.md.').path,
    'deliveries/revision-7/notes.md');
  assert.equal(resolveExpectedFilePath('notes.md', '输出目录为 `交付/本轮`，生成 notes.md。').path, '交付/本轮/notes.md');
  assert.equal(resolveExpectedFilePath('notes.md', 'Write notes.md under deliveries/revision-7/.').path,
    'deliveries/revision-7/notes.md');
  const separatelyNamed = 'Create openspec/changes/benchmark-change/ and write proposal.md and design.md.';
  assert.throws(() => normalizeExpectedFiles(['openspec/changes/benchmark-change/proposal.md'], separatelyNamed),
    /submit the literal filename "proposal\.md"/u);
  assert.deepEqual(normalizeExpectedFiles(['proposal.md', 'design.md'], separatelyNamed), ['proposal.md', 'design.md']);
  assert.equal(resolveExpectedFilePath('proposal.md', separatelyNamed).path, 'openspec/changes/benchmark-change/proposal.md');
});

test('a filename without a unique original location stays unverified', () => {
  assert.equal(resolveExpectedFilePath('notes.md', 'Deliver notes.md.').status, 'UNVERIFIED');
  assert.equal(resolveExpectedFilePath('notes.md', 'Use directory `out/one` or directory `out/two`; deliver notes.md.').status, 'UNVERIFIED');
});

test('a complete relative or absolute path is not rebound to another directory', () => {
  for (const file of ['docs/notes.md', './notes.md', 'C:/delivery/notes.md'])
    assert.equal(resolveExpectedFilePath(file, 'There is also directory `different/output`.').path, file);
});

test('original directory context outside the selected filename lines prevents a false missing-file verdict', async t => {
  const f = await stopProtocolFixture(t, 'findings');
  f.input.request.reviewScope = { kind: 'workspace-stop' };
  delete f.input.request.fixedStopClassification;
  const original = 'Deliver notes.md and steps.md.\nThese are the required files.\nCreate directory `deliveries/revision-7/` for this delivery.\n';
  f.input.evidence.originalRequirements = { digest: sha256(original), userMessages: [{ ref: 'transcript:request', sha256: sha256(original), text: original }],
    projectFiles: [], materials: [], referencedFiles: [] };
  await fs.mkdir(path.join(f.root, 'deliveries/revision-7'), { recursive: true });
  for (const file of ['notes.md', 'steps.md']) await fs.writeFile(path.join(f.root, 'deliveries/revision-7', file), 'Delivered.');
  const handle = await f.run(async ({ brief, readAll, read, submit }) => {
    await readAll();
    const originalPath = brief.task.basisFiles.find(file => path.basename(file).startsWith('user-original-'));
    const citeId = (await read(originalPath)).details.citation.citeId;
    const artifact = { metricId: 'M12', text: 'Deliver notes.md and steps.md.', verificationTarget: 'ARTIFACT',
      expectedFiles: ['notes.md', 'steps.md'], citeId, lineStart: 1, lineEnd: 2 };
    const unrelated = { ...artifact, text: 'Create the delivery directory.', expectedFiles: ['steps.md'] };
    await assert.rejects(submit('set_original_checklist', { items: [artifact, unrelated] }), {
      code: 'GROUND_TRUTH_EXPECTED_FILES_INVALID',
      message: /Checklist item 2 \(M12\): .*steps\.md.*preserve the other items/u,
    });
    await submit('set_original_checklist', { items: [artifact] });
    const page = await submit('review_checklist', { stopClassification: 'TASK_COMPLETE', completionClaim: true });
    assert.equal(page.items[0].savedResult, null);
    assert.deepEqual(page.expectedFileChecks.map(check => check.path), ['notes.md', 'steps.md'].map(file => path.join(f.root, 'deliveries/revision-7', file)));
    assert(page.expectedFileChecks.every(check => check.status === 'FILE'));
    await submit('submit_review', { taskId: page.items[0].taskId, verdict: 'UNVERIFIED', reason: 'File content is outside this existence check.', citeIds: [] });
    await submit('finish_stop_review', { summary: 'The scoped files exist.' });
  });
  assert(!handle.result.metricObjectJudgements.some(row => row.judgement === 'DEVIATION'));
  assert.equal(handle.collection.reasonCode, 'STOP_MOST_REQUIREMENTS_UNVERIFIED');
});

test('a filename alone produces UNVERIFIED even if the same basename exists in the repository root', async t => {
  const f = await fixture(t, { expected: ['notes.md'] });
  await fs.writeFile(path.join(f.root, 'notes.md'), 'Existence does not establish its requested location.');
  const handle = await f.runRaw(async ({ readAll, submit }) => {
    const page = await f.start(readAll, submit);
    assert.equal(page.items[0].savedResult.judgement, 'UNVERIFIED');
    assert.deepEqual(page.expectedFileChecks, []);
    await f.finish(submit);
  });
  assert.equal(handle.result.metricObjectJudgements[0].judgement, 'UNVERIFIED');
  assert.equal(handle.collection.reasonCode, 'STOP_MOST_REQUIREMENTS_UNVERIFIED');
  assert(handle.result.unverifiedItems.some(item => item.type === 'OUTPUT_PATH'));
});

test('an explicitly rooted filename still proves absence without changing the root-path contract', async t => {
  const f = await fixture(t, { expected: ['./notes.md'] });
  const handle = await f.run(async ({ readAll, submit }) => {
    const page = await f.start(readAll, submit);
    assert.equal(page.items[0].savedResult.judgement, 'DEVIATION');
    assert.equal(page.expectedFileChecks[0].path, path.join(f.root, 'notes.md'));
    assert.equal(page.expectedFileChecks[0].status, 'MISSING');
    await f.finish(submit);
  });
  assert.equal(handle.result.metricObjectJudgements[0].judgement, 'DEVIATION');
});

test('an input directory never supplies an otherwise unspecified output location', async t => {
  for (const requirementText of ['Read inputs under `inputs/`. Deliver notes.md.', 'Read inputs under `inputs/` before writing notes.md.']) {
    const f = await fixture(t, { expected: ['notes.md'], requirementText });
    await fs.writeFile(path.join(f.root, 'notes.md'), 'An unrelated input directory does not locate this output.');
    const handle = await f.runRaw(async ({ readAll, submit }) => {
      const page = await f.start(readAll, submit);
      assert.equal(page.items[0].savedResult.judgement, 'UNVERIFIED');
      assert.deepEqual(page.expectedFileChecks, []);
      await f.finish(submit);
    });
    assert.equal(handle.result.metricObjectJudgements[0].judgement, 'UNVERIFIED');
    assert.equal(handle.collection.reasonCode, 'STOP_MOST_REQUIREMENTS_UNVERIFIED');
    assert(handle.result.unverifiedItems.some(item => item.type === 'OUTPUT_PATH'));
  }
});

test('a missing scoped output keeps its real directory in the trusted absence receipt', async t => {
  const f = await fixture(t, { expected: ['notes.md'], requirementText: 'Deliver notes.md in directory `deliveries/revision-7`.' });
  await fs.writeFile(path.join(f.root, 'notes.md'), 'This is the wrong location.');
  const handle = await f.run(async ({ readAll, submit }) => {
    const page = await f.start(readAll, submit);
    assert.equal(page.items[0].savedResult.judgement, 'DEVIATION');
    assert.equal(page.expectedFileChecks[0].path, path.join(f.root, 'deliveries/revision-7/notes.md'));
    await f.finish(submit);
  });
  assert.equal(handle.result.metricObjectJudgements[0].judgement, 'DEVIATION');
  assert.deepEqual(validateStructuredReviewEvidence(handle.result, f.input.request.population.metrics.M12, handle.sourceCitations, f.root), []);
});

test('a completely absent output gets a trusted deviation without any delivery source read; it cannot be overwritten with PASS', async t => {
  const f = await fixture(t);
  const handle = await f.run(async ({ readAll, submit }) => {
    const checklist = await f.start(readAll, submit);
    assert.equal(checklist.items[0].savedResult.judgement, 'DEVIATION');
    assert.equal(checklist.pending, 0);
    assert.equal(checklist.expectedFileChecks[0].status, 'MISSING');
    await assert.rejects(submit('submit_review', { taskId: 'M12:R1', verdict: 'PASS', reason: 'A completion claim.', citeIds: [] }), /already has/);
    await f.finish(submit);
  });
  assert.equal(handle.result.metricObjectJudgements[0].judgement, 'DEVIATION');
  assert.match(handle.result.metricObjectJudgements[0].reason, /docs\/report.md/);
  assert.equal(handle.sourceCitations[0].readProof.protocol, 'expected-file-v1');
  assert.deepEqual(validateStructuredReviewEvidence(handle.result, f.input.request.population.metrics.M12, handle.sourceCitations, f.root), []);
  assert.equal(await expectedFilesCurrent(handle.reviewEvidence.expectedFiles), true);
});

test('M16 alone can prove a missing explicitly required production file', async t => {
  const f = await fixture(t, { metric: 'M16', target: 'IMPLEMENTATION', expected: ['src/app.py'] });
  const handle = await f.run(async ({ readAll, submit }) => { await f.start(readAll, submit); await f.finish(submit); });
  assert.equal(handle.result.metricObjectJudgements[0].objectId, 'M16:R1');
  assert.equal(handle.result.metricObjectJudgements[0].judgement, 'DEVIATION');
});

test('existence is no automatic PASS; a directory is not a delivered file', async t => {
  for (const directory of [false, true]) {
    const f = await fixture(t);
    await fs.mkdir(path.join(f.root, 'docs'), { recursive: true });
    if (directory) await fs.mkdir(path.join(f.root, 'docs/report.md'));
    else await fs.writeFile(path.join(f.root, 'docs/report.md'), 'Placeholder, not an acceptance result.');
    const handle = await f.run(async ({ readAll, submit }) => {
      const page = await f.start(readAll, submit);
      assert.equal(page.expectedFileChecks[0].status, directory ? 'NOT_FILE' : 'FILE');
      if (!directory) {
        assert.equal(page.items[0].savedResult, null);
        await submit('submit_review', { taskId: 'M12:R1', verdict: 'UNVERIFIED', reason: 'Content still needs review.', citeIds: [] });
      }
      await f.finish(submit);
    });
    assert.equal(handle.result.metricObjectJudgements[0].judgement, directory ? 'DEVIATION' : 'UNVERIFIED');
  }
});

test('conditional/future/unknown/soft obligations and unfinished stages do not acquire automatic missing-output deviations', async t => {
  for (const options of [{ kind: 'CONDITIONAL' }, { kind: 'FUTURE' }, { kind: 'UNKNOWN' }, { severity: 'SOFT' }, { status: 'RETRACTED' }, { classification: 'INTERMEDIATE' }, { classification: 'STAGE_COMPLETE' }]) {
    const f = await fixture(t, options);
    const handle = await f.run(async ({ readAll, submit }) => {
      const page = await f.start(readAll, submit, options.classification);
      assert.deepEqual(page.expectedFileChecks, []);
      for (const item of page.items) await submit('submit_review', { taskId: item.taskId, verdict: 'UNVERIFIED', reason: 'No automatic scope assumption.', citeIds: [] });
      await f.finish(submit);
    });
    assert(!handle.result.metricObjectJudgements.some(row => row.judgement === 'DEVIATION'));
  }
});

test('disabled delivery metrics retain no implicit existence duty', async t => {
  const f = await fixture(t);
  f.input.request.population.metrics = { M12: [], M16: [] };
  const handle = await f.run(async ({ readAll, submit }) => {
    const page = await f.start(readAll, submit);
    assert.deepEqual(page.expectedFileChecks, []);
    await f.finish(submit);
  });
  assert.deepEqual(handle.result.metricObjectJudgements, []);
});

test('creating a checked missing file invalidates the old verdict before settlement and later feedback', async t => {
  const f = await fixture(t);
  let checked;
  await assert.rejects(f.run(async ({ readAll, submit }) => {
    const page = await f.start(readAll, submit); checked = page.expectedFileChecks;
    await fs.mkdir(path.join(f.root, 'docs'));
    await fs.writeFile(path.join(f.root, 'docs/report.md'), 'Now delivered.');
    await f.finish(submit);
  }), { code: 'STOP_TASK_INPUT_CHANGED' });
  assert.equal(await expectedFilesCurrent(checked), false);
});

test('permission errors remain unavailable and cannot produce a missing-file verdict', async t => {
  const f = await fixture(t), stat = fs.stat;
  t.mock.method(fs, 'stat', async (file, ...args) => {
    if (String(file).endsWith('report.md')) throw Object.assign(new Error('Denied'), { code: 'EACCES' });
    return stat(file, ...args);
  });
  const observed = await observeExpectedFile(f.root, 'docs/report.md');
  assert.equal(observed.status, 'UNAVAILABLE');
  const handle = await f.run(async ({ readAll, submit }) => {
    const page = await f.start(readAll, submit);
    assert.equal(page.items[0].savedResult, null);
    await submit('submit_review', { taskId: 'M12:R1', verdict: 'UNVERIFIED', reason: 'No filesystem access.', citeIds: [], finish: true });
  });
  assert.equal(handle.result.metricObjectJudgements[0].judgement, 'UNVERIFIED');
});

test('a negative receipt cannot prove PASS, a different obligation, an undeclared output, or conditional applicability', async t => {
  const f = await fixture(t);
  const handle = await f.run(async ({ readAll, submit }) => { await f.start(readAll, submit); await f.finish(submit); });
  const object = f.input.request.population.metrics.M12[0], citations = handle.sourceCitations;
  for (const change of [{ sourceId: 'other' }, { sourceRevisionId: 'R1@2' }, { expectedFiles: ['other.md'] }, { applicabilityKind: 'CONDITIONAL' }, { hard: false }])
    assert.throws(() => validateReviewJudgement({ row: { judgement: 'DEVIATION' }, object: { ...object, ...change }, citations }),
      change.applicabilityKind === 'CONDITIONAL' ? /REVIEW_CONDITION_ASSESSMENT_REQUIRED/ : /actually read/);
  assert.throws(() => validateReviewJudgement({ row: { judgement: 'DEVIATION', conditionAssessment: { activation: 'ACTIVE', evidenceKind: 'TARGET_FACTS', reason: 'A missing-output receipt is not an activation witness.' } },
    object: { ...object, applicabilityKind: 'CONDITIONAL' }, citations }), /REVIEW_CONDITION_EVIDENCE_UNAVAILABLE/);
  assert.throws(() => validateReviewJudgement({ row: { judgement: 'PASS' }, object, citations }), /actually read/);
});
