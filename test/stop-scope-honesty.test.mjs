import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { savedStopFeedbackNotice } from '../lib/openclaw/stop-feedback-notice.mjs';
import { documentCommandChanges, snapshotDocumentFiles } from '../lib/openclaw/tools.mjs';
import { handleRuntimeV2Event } from '../lib/runtime-v2/orchestrator.mjs';
import { compileRuntimeV2Config } from '../lib/runtime-v2/config.mjs';
import { loadConfig } from '../lib/runtime-corrector.mjs';
import { decisionGuard, ensureTask, taskDirectory, withTaskState, findTask } from '../lib/runtime-v2/task-store.mjs';
import { createStopCorrectionStore } from '../lib/runtime-v2/stop-correction-store.mjs';
import { selectStopPopulation } from '../lib/runtime-v2/review-routing.mjs';
import { captureTaskStart, changeOwner, nonArtifactChanges, taskStartManifestPath } from '../lib/runtime-v2/task-changes.mjs';
import { scriptedWorkspaceReview } from './helpers/scripted-workspace-review.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=rc@example.invalid', '-c', 'user.name=rc', '-c', 'commit.gpgsign=false',
  '-c', 'core.autocrlf=false', '-c', 'core.hooksPath=nonexistent', ...args], { cwd, encoding: 'utf8', windowsHide: true });
const WAITING = { stopClassification: 'WAITING_FOR_USER', requiredUserInput: 'Choose how to handle the missing JAVA_HOME.' };
const PLANNING_REPLY = 'Stage complete. The proposal and design are ready for review.';
const DOCUMENTS = { 'openspec/changes/demo/proposal.md': '# Proposal\n', 'openspec/changes/demo/design.md': '# Design\n',
  'openspec/changes/demo/.openspec.yaml': 'schema: spec-driven\n', 'openspec/changes/demo/specs/convert/spec.md': '# Convert\n' };

async function writeFiles(root, files) {
  for (const [file, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), text);
  }
}

// The project uses the shipped OpenSpec template. Host state and the
// transcript stay outside it, as they do for a real Gateway.
async function fixture(t, { repository = true, capture = true, deviationOnly = true, fileQualityReviewEnabled = false, metrics = ['M16'],
  classification, verdict = () => null, extraClaims = [], reply = 'Implementation complete.', reason } = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-stop-scope-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'project');
  await fs.mkdir(root);
  await fs.cp(new URL('../.runtime-corrector-default/', import.meta.url), path.join(root, '.runtime-corrector'), { recursive: true });
  await fs.writeFile(path.join(root, 'app.py'), 'def convert(value): return int(value)\n');
  if (repository) { git(root, 'init', '-q'); git(root, 'add', 'app.py'); git(root, 'commit', '-q', '-m', 'Start'); }
  const template = await loadConfig({ cwd: root });
  const transcript = path.join(base, 'host-transcript.jsonl');
  await fs.writeFile(transcript, [
    { type: 'user', uuid: 'user-1', message: { role: 'user', content: 'Implement both frozen conversion obligations.' } },
    { type: 'assistant', uuid: 'assistant-1', message: { id: 'assistant-1', role: 'assistant', content: reply } },
  ].map(value => JSON.stringify(value)).join('\n') + '\n');
  const task = await ensureTask({ projectRoot: root, sessionId: 'session' });
  const truth = { taskId: task.taskId, version: 1, digest: 'frozen', claims: ['A', 'B'].map(id => ({ claimId: id, revisionId: `${id}@1`,
    category: 'requirements', text: `Frozen original conversion obligation ${id}`, authority: 'USER_EXPLICIT', severity: 'HARD', status: 'ACTIVE',
    applicability: 'CURRENT_TASK', applicabilityKind: 'CURRENT_TASK', verificationTarget: 'IMPLEMENTATION' })).concat(extraClaims) };
  const truthPath = path.join(taskDirectory(root, task.taskId), 'ground-truth/current.json');
  await fs.mkdir(path.dirname(truthPath), { recursive: true });
  await fs.writeFile(truthPath, JSON.stringify(truth));
  await withTaskState({ projectRoot: root, taskId: task.taskId }, state => { state.groundTruth.version = 1; state.groundTruth.digest = 'frozen'; });
  if (capture) await captureTaskStart({ projectRoot: root, taskId: task.taskId });
  const runtimeV2 = compileRuntimeV2Config({ version: 2, artifacts: [], dynamicGroundTruth: { enabled: true, panel: { size: 0 } },
    implementationCorrection: { enabled: false, platform: null },
    stopCorrection: { enabled: true, deviationOnly, fileQualityReviewEnabled,
      metrics: Object.fromEntries(Array.from({ length: 16 }, (_, i) => `M${String(i + 1).padStart(2, '0')}`).map(id => [id, metrics.includes(id)])) } });
  const calls = [];
  const reviewerFactory = async input => {
    calls.push(input.role === 'ground-truth-extractor' ? 'baseline' : input.request.reviewScope.kind);
    if (input.role === 'ground-truth-extractor') return { result: { summary: 'Frozen requirements unchanged.', taskClassification: 'NO_CHANGE', operations: [] }, close: async () => {} };
    return scriptedWorkspaceReview(input, { file: path.join(root, 'app.py'), verdict, classification, reason });
  };
  reviewerFactory.supportsReviewCollection = true;
  const directory = path.join(base, 'host-state');
  const plan = { runtimeV2, artifacts: template.artifacts, workflowCorrelation: template.workflowCorrelation, output: template.output };
  const event = (hook, extras = {}, stopId, assessmentContext) => handleRuntimeV2Event({ projectRoot: root, plan, reviewerFactory, assessmentContext,
    stopHost: { directory, startProtocol: { version: 1 }, ...(stopId ? { stopId } : {}) },
    input: { session_id: 'session', cwd: root, transcript_path: transcript, hook_event_name: hook, last_assistant_message: reply, ...extras } });
  await event('SessionStart', { source: 'startup' });
  const ledger = () => createStopCorrectionStore({ directory }).inspect('session');
  const current = () => findTask({ projectRoot: root, sessionId: 'session' });
  const evaluation = async stop => JSON.parse(await fs.readFile(path.join(taskDirectory(root, task.taskId), 'evaluations', `${stop.evaluationId}.json`), 'utf8'));
  const journal = async () => (await fs.readFile(path.join(taskDirectory(root, task.taskId), 'journal/events.jsonl'), 'utf8'))
    .split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { base, root, task, calls, plan, stop: (stopId, assessmentContext) => event('Stop', {}, stopId, assessmentContext),
    event, ledger, current, evaluation, journal, transcript };
}

test('a deviation-only intermediate Stop reviews delivered work and finds no deviation only after a real scan', async t => {
  for (const { label, verdict, status, decision } of [
    { label: 'scan', verdict: () => null, status: 'NO_DEVIATION_FOUND', decision: 'allow' },
    { label: 'deviation', verdict: (item, index) => index === 0 ? 'DEVIATION' : null, status: 'DEVIATION', decision: 'block' },
  ]) await t.test(label, async subtest => {
    const f = await fixture(subtest, { classification: WAITING, verdict });
    await fs.writeFile(path.join(f.root, 'app.py'), 'def convert(value): return float(value)\n');
    const result = await f.stop();
    assert.equal(result.stop.status, status, result.stop.reasonCode);
    assert.equal(result.decision, decision);
    assert.deepEqual(f.calls.filter(call => call !== 'baseline'), ['workspace-stop']);
    assert.deepEqual(result.stop.coverage, { fullObjectCount: 2, selectedObjectCount: 2, fileTargetCount: 0, scanCompleted: true,
      classification: 'WAITING_FOR_USER', stage: null, scopeReasonCode: 'DELIVERED_WORK_SCOPE' });
    assert.equal(result.stop.review.collection.totalObjects, 2);
    assert.deepEqual((await f.current()).verification.coverage, result.stop.coverage);
    if (decision === 'block') {
      assert.match(result.stop.feedback, /\[runtime-corrector:stop-feedback\]/u);
      assert(result.stop.admission);
    } else assert.equal(result.stop.admission, null);
  });
});

test('a current mandatory item stays unverified at task completion without blocking a supported repair', async t => {
  for (const { name, verdict, status, count = 1, classification } of [
    { name: 'one unresolved at completion', verdict: (_item, index) => index === 0 ? 'UNVERIFIED' : null, status: 'UNVERIFIED' },
    { name: 'one unresolved while waiting', verdict: (_item, index) => index === 0 ? 'UNVERIFIED' : null, status: 'NO_DEVIATION_FOUND', classification: WAITING },
    { name: 'a confirmed deviation and one unresolved', verdict: (_item, index) => index === 0 ? 'UNVERIFIED' : 'DEVIATION', status: 'DEVIATION' },
    { name: 'both unresolved', verdict: () => 'UNVERIFIED', status: 'UNVERIFIED', count: 2 },
  ]) await t.test(name, async subtest => {
    const f = await fixture(subtest, { verdict, classification });
    await fs.writeFile(path.join(f.root, 'app.py'), 'def convert(value): return float(value)\n');
    const result = await f.stop();
    assert.equal(result.stop.status, status);
    assert.equal(result.stop.verificationUnavailable, false);
    assert.equal(result.stop.review.unverifiedItems.length, count);
    assert(result.stop.review.unverifiedItems.every(item => item.id && item.type === 'REQUIREMENT' && item.reason));
    if (status === 'DEVIATION') {
      assert(result.stop.admission);
      assert.equal(result.stop.review.metricObjectJudgements.length, 1);
      assert.doesNotMatch(result.stop.feedback, /UNVERIFIED/u);
    } else assert.equal(result.stop.admission, null);
  });
});

test('an inconclusive nonfinal Stop leaves the later completion Stop reviewable and repairable', async t => {
  // A hard document duty keeps the workflow's document stages eligible.
  const extraClaims = [{ claimId: 'C', revisionId: 'C@1', category: 'constraints', text: 'Frozen original proposal duty C',
    authority: 'USER_EXPLICIT', severity: 'HARD', status: 'ACTIVE', applicability: 'CURRENT_TASK', applicabilityKind: 'CURRENT_TASK',
    verificationTarget: 'ARTIFACT' }];
  for (const { label, first, coverage } of [
    { label: 'proposal stage', first: { stopClassification: 'STAGE_COMPLETE', stage: 'proposal' }, coverage: [2, 0, 'NO_APPLICABLE_STAGE_OBJECTS'] },
    { label: 'waiting for user', first: WAITING, coverage: [2, 2, 'DELIVERED_WORK_SCOPE'] },
  ]) await t.test(label, async subtest => {
    const frame = { ...first };
    let judge = () => 'UNVERIFIED';
    const f = await fixture(subtest, { classification: frame, verdict: (item, index) => judge(item, index), extraClaims });
    await fs.writeFile(path.join(f.root, 'app.py'), 'def convert(value): return float(value)\n');
    const early = await f.stop('early-stop');
    assert.equal(early.decision, 'allow');
    assert.equal(early.stop.status, 'UNVERIFIED');
    assert.deepEqual([early.stop.coverage.fullObjectCount, early.stop.coverage.selectedObjectCount, early.stop.coverage.scopeReasonCode], coverage,
      `${early.stop.reasonCode}: ${early.feedback}`);
    Object.assign(frame, { stopClassification: 'TASK_COMPLETE', stage: null, requiredUserInput: null });
    judge = (_item, index) => index === 0 ? 'DEVIATION' : null;
    await fs.writeFile(path.join(f.root, 'app.py'), 'def convert(value): return float(value) + 0\n');
    const final = await f.stop('final-stop');
    assert.equal(final.stop.status, 'DEVIATION', final.stop.reasonCode);
    assert.equal(final.decision, 'block');
    assert(final.stop.admission);
    const ledger = await f.ledger();
    assert.equal(ledger.stops['final-stop'].flowId, ledger.stops['early-stop'].flowId);
    assert.equal(ledger.flows[ledger.stops['early-stop'].flowId].closedAt, undefined);
  });
});

test('a deviation-only Stop with an empty selected scope is UNVERIFIED, persists its coverage and dispatches no repair', async t => {
  const f = await fixture(t, { metrics: ['M13'] });
  await fs.writeFile(path.join(f.root, 'app.py'), 'def convert(value): return float(value)\n');
  const result = await f.stop();
  assert.equal(result.stop.status, 'UNVERIFIED');
  assert.equal(result.stop.reasonCode, 'STOP_NO_REVIEW_SCOPE');
  assert.equal(result.decision, 'allow');
  assert.equal(result.stop.admission, null);
  assert.match(result.stop.feedback, /^\[runtime-corrector:status\] UNVERIFIED/u);
  assert.doesNotMatch(result.stop.feedback, /stop-feedback/u);
  const coverage = { fullObjectCount: 0, selectedObjectCount: 0, fileTargetCount: 0, scanCompleted: true,
    classification: 'TASK_COMPLETE', stage: null, scopeReasonCode: 'NO_APPLICABLE_METRIC_OBJECTS' };
  assert.deepEqual(result.stop.coverage, coverage);
  const evaluation = await f.evaluation(result.stop);
  assert.deepEqual(evaluation.coverage, coverage);
  assert.deepEqual(evaluation.outcome.coverage, coverage);
  const task = await f.current();
  assert.equal(task.verification.status, 'UNVERIFIED');
  assert.equal(task.verification.reasonCode, 'STOP_NO_REVIEW_SCOPE');
  assert.deepEqual(task.verification.coverage, coverage);
  const ledger = await f.ledger(), recorded = ledger.stops[result.stop.stopCorrection.stopId];
  assert.equal(recorded.reviewStatus, 'UNVERIFIED');
  assert.equal(recorded.progress.scopeReasonCode, 'NO_APPLICABLE_METRIC_OBJECTS');
  assert.equal(result.stop.correctionAttempt, 0);
});

test('an empty selected scope stays UNVERIFIED in both review modes with file-quality review enabled', async t => {
  for (const deviationOnly of [false, true]) await t.test(`deviationOnly=${deviationOnly}`, async subtest => {
    const f = await fixture(subtest, { deviationOnly, fileQualityReviewEnabled: true, metrics: ['M13'] });
    await fs.writeFile(path.join(f.root, 'app.py'), 'def convert(value): return float(value)\n');
    const result = await f.stop();
    assert.equal(result.stop.coverage.selectedObjectCount, 0);
    assert.equal(result.stop.coverage.fileTargetCount, 0);
    assert.equal(result.stop.status, 'UNVERIFIED');
    assert.equal(result.decision, 'allow');
    assert.equal(result.stop.admission, null);
  });
});

test('a Stop after document-only changes is skipped quietly without a reviewer or budget, and a later code edit gets a full Stop', async t => {
  const f = await fixture(t, { reply: PLANNING_REPLY });
  await writeFiles(f.root, DOCUMENTS);
  const skipped = await f.stop('docs-only');
  assert.equal(skipped.decision, 'allow');
  assert.equal(skipped.stop.status, 'SKIPPED');
  assert.equal(skipped.stop.reasonCode, 'STOP_DOCUMENT_ONLY_CHANGES');
  assert.deepEqual(f.calls, []);
  assert.match(skipped.feedback, /^\[runtime-corrector:status\] SKIPPED \(STOP_DOCUMENT_ONLY_CHANGES\)/u);
  assert.doesNotMatch(skipped.feedback, /stop-feedback/u);
  assert.equal(skipped.feedback.split('\n').length, 1);
  assert.deepEqual(skipped.stop.changes.map(change => [change.path, change.owner]), Object.keys(DOCUMENTS).sort()
    .map(file => [file, 'DOCUMENT_CORRECTION']));
  assert.deepEqual(Object.keys((await f.ledger()).stops ?? {}), []);
  const task = await f.current();
  assert.equal(task.verification.status, 'SKIPPED');
  assert.equal(task.stop.lastAssessmentId, skipped.stop.evaluationId);
  assert.deepEqual((await f.evaluation(skipped.stop)).changes, skipped.stop.changes);
  assert((await f.journal()).some(event => event.type === 'STOP_CORRECTION_SKIPPED' && event.evaluationId === skipped.stop.evaluationId));
  assert.deepEqual(await nonArtifactChanges({ projectRoot: f.root, taskId: f.task.taskId, plan: f.plan }), []);

  await fs.writeFile(path.join(f.root, 'app.py'), 'def convert(value): return float(value)\n');
  assert.deepEqual(await nonArtifactChanges({ projectRoot: f.root, taskId: f.task.taskId, plan: f.plan }), [{ path: 'app.py', status: 'MODIFIED' }]);
  const reviewed = await f.stop('after-code');
  assert.deepEqual(f.calls.filter(call => call !== 'baseline'), ['workspace-stop']);
  assert.equal(reviewed.stop.status, 'NO_DEVIATION_FOUND', reviewed.stop.reasonCode);
  assert.equal(reviewed.stop.coverage.selectedObjectCount, 2);
  assert.equal(reviewed.stop.correctionAttempt, 0);
});

test('an implementation completion claim after only OpenSpec edits still checks unchanged production', async t => {
  const obligation = 'Return zero if an input cannot be converted to an integer.';
  const extraClaims = [{ claimId: 'fallback', revisionId: 'fallback@1', category: 'requirements', text: obligation,
    authority: 'USER_EXPLICIT', severity: 'HARD', status: 'ACTIVE', applicability: 'CURRENT_TASK',
    applicabilityKind: 'CURRENT_TASK', verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION' }];
  const f = await fixture(t, { extraClaims, verdict: item => item.description === obligation ? 'DEVIATION' : null,
    reason: 'The unchanged implementation calls int directly, so invalid input raises ValueError instead of returning zero.' });
  await writeFiles(f.root, DOCUMENTS);
  assert.deepEqual(await nonArtifactChanges({ projectRoot: f.root, taskId: f.task.taskId, plan: f.plan }), []);
  const result = await f.stop('implementation-with-docs-only');
  assert.deepEqual(f.calls.filter(call => call !== 'baseline'), ['workspace-stop']);
  assert.equal(result.stop.status, 'DEVIATION', result.stop.reasonCode);
  assert.equal(result.decision, 'block');
  assert(result.stop.admission);
  assert.match(result.feedback, /invalid input raises ValueError/u);
});

test('planning replies that mention implementation retain the document fast path', async t => {
  for (const reply of ['Once implementation is complete, run the acceptance suite.',
    'I finished the implementation notes.', 'Stage complete. 代码实现完成后再运行测试。',
    'Stage complete. Implementation complete?']) await t.test(reply, async subtest => {
    const f = await fixture(subtest, { reply });
    await writeFiles(f.root, DOCUMENTS);
    const result = await f.stop('planning-docs');
    assert.equal(result.stop.reasonCode, 'STOP_DOCUMENT_ONLY_CHANGES');
    assert.deepEqual(f.calls, []);
  });
});

test('disabled document stages retain ownership so a Stop-only profile skips documents and still reviews later code', async t => {
  const f = await fixture(t, { reply: PLANNING_REPLY });
  const configFile = path.join(f.root, '.runtime-corrector/config.yaml');
  const configured = await fs.readFile(configFile, 'utf8');
  const disabled = configured.replace(/^enabledStages:\r?\n(?:  - [^\r\n]+\r?\n)+/mu, 'enabledStages: []\n');
  assert.notEqual(disabled, configured);
  await fs.writeFile(configFile, disabled);
  const plan = await loadConfig({ cwd: f.root });
  assert.equal(plan.artifacts.length, 0);
  assert(plan.configuredArtifacts.length >= 3);
  Object.assign(f.plan, { artifacts: plan.artifacts, configuredArtifacts: plan.configuredArtifacts,
    workflowCorrelation: plan.workflowCorrelation });
  await writeFiles(f.root, DOCUMENTS);

  const skipped = await f.stop('disabled-doc-stages');
  assert.equal(skipped.stop.reasonCode, 'STOP_DOCUMENT_ONLY_CHANGES');
  assert.deepEqual(f.calls, [], 'disabled document correction must not spend a model call through Stop');
  assert.deepEqual(Object.keys((await f.ledger()).stops ?? {}), []);
  assert.deepEqual(await nonArtifactChanges({ projectRoot: f.root, taskId: f.task.taskId, plan: f.plan }), []);

  await fs.writeFile(path.join(f.root, 'app.py'), 'def convert(value): return float(value)\n');
  const reviewed = await f.stop('code-after-disabled-doc-stages');
  assert.equal(reviewed.stop.status, 'NO_DEVIATION_FOUND', reviewed.stop.reasonCode);
  assert.deepEqual(f.calls.filter(call => call !== 'baseline'), ['workspace-stop']);
  assert.equal(reviewed.stop.coverage.selectedObjectCount, 2);
});

test('document-only Stop keeps unresolved execution visible until a verified recheck, without correction admission', async t => {
  const f = await fixture(t, { reply: PLANNING_REPLY });
  const spec = 'openspec/changes/demo/specs/convert/spec.md';
  await writeFiles(f.root, { [spec]: DOCUMENTS[spec] });
  const unresolved = await documentCommandChanges(null, f.plan, f.root);
  assert.equal(unresolved.status, 'UNVERIFIED');
  assert(unresolved.unverified.includes('DOCUMENT_PRE_SNAPSHOT_MISSING'));
  await withTaskState({ projectRoot: f.root, taskId: f.task.taskId }, state => {
    state.status = 'COMPLETED';
    state.verification = { status: 'PASS', assessmentId: 'prior-review', evaluationId: 'prior-evaluation' };
    state.documentCoverage = unresolved;
  });

  const assess = async runId => f.stop(runId, { kind: 'native-stop', mode: 'execute_and_correct',
    assessmentId: `${runId}:stop`, guard: decisionGuard(await f.current()) });
  const result = await assess('unverified-documents');
  const status = 'UNVERIFIED', reasonCode = 'DOCUMENT_EXECUTION_UNVERIFIED';
  assert.equal(result.decision, 'allow');
  assert.equal(result.stop.status, status);
  assert.equal(result.stop.reasonCode, reasonCode);
  assert.deepEqual(result.stop.unverifiedBasis, [reasonCode]);
  assert.equal(result.stop.verificationIncomplete, true);
  assert.equal(result.stop.coverage.scanCompleted, false);
  assert.equal(result.stop.admission, null);
  assert.equal(result.stop.correctionAttempt, 0);
  assert.match(result.feedback, /UNVERIFIED \(DOCUMENT_EXECUTION_UNVERIFIED\)/u);
  assert.equal((await f.evaluation(result.stop)).outcome.status, status);
  const published = await f.current();
  assert.equal(published.verification.status, status);
  assert.equal(published.verification.reasonCode, reasonCode);
  assert.equal(published.verification.assessmentId, 'unverified-documents:stop');
  assert.equal(published.verification.previousVerification.status, 'PASS');
  assert.equal(published.status, 'COMPLETED_WITH_ISSUES');
  assert.deepEqual(savedStopFeedbackNotice(published), { evaluationId: result.stop.evaluationId, feedback: result.feedback });

  const before = await snapshotDocumentFiles(f.plan, f.root);
  const verified = await documentCommandChanges(before, f.plan, f.root);
  assert.equal(verified.status, 'VERIFIED');
  assert(verified.currentFiles.some(file => file.file.endsWith('spec.md')));
  await withTaskState({ projectRoot: f.root, taskId: f.task.taskId }, state => { state.documentCoverage = verified; });
  const next = await assess('verified-documents');
  assert.equal(next.decision, 'allow');
  assert.equal(next.stop.status, 'SKIPPED');
  assert.equal(next.stop.reasonCode, 'STOP_DOCUMENT_ONLY_CHANGES');
  assert.equal((await f.current()).verification.status, 'SKIPPED');
  assert.equal(savedStopFeedbackNotice(await f.current()), null);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(Object.keys((await f.ledger()).stops ?? {}), []);
});

test('a business commit counts as a change while a committed workflow document does not', async t => {
  const f = await fixture(t, { reply: PLANNING_REPLY });
  await writeFiles(f.root, DOCUMENTS);
  git(f.root, 'add', 'openspec'); git(f.root, 'commit', '-q', '-m', 'Docs');
  const skipped = await f.stop('docs-committed');
  assert.equal(skipped.stop.status, 'SKIPPED');
  assert(skipped.stop.changes.every(change => change.status === 'COMMITTED'));
  await fs.writeFile(path.join(f.root, 'app.py'), 'def convert(value): return float(value)\n');
  git(f.root, 'add', 'app.py'); git(f.root, 'commit', '-q', '-m', 'Code');
  assert.equal(git(f.root, 'status', '--porcelain', '--', 'app.py'), '');
  assert.deepEqual(await nonArtifactChanges({ projectRoot: f.root, taskId: f.task.taskId, plan: f.plan }), [{ path: 'app.py', status: 'COMMITTED' }]);
  const reviewed = await f.stop('code-committed');
  assert.equal(reviewed.stop.status, 'NO_DEVIATION_FOUND', reviewed.stop.reasonCode);
  assert.deepEqual(f.calls.filter(call => call !== 'baseline'), ['workspace-stop']);
});

test('without a trustworthy task-start manifest a document-only Stop is still reviewed', async t => {
  const previous = process.env.GIT_CEILING_DIRECTORIES;
  t.after(() => { if (previous === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = previous; });
  for (const { label, repository, capture } of [
    { label: 'non-git project', repository: false, capture: true },
    { label: 'missing manifest', repository: true, capture: false },
  ]) await t.test(label, async subtest => {
    process.env.GIT_CEILING_DIRECTORIES = os.tmpdir();
    const f = await fixture(subtest, { repository, capture });
    const manifest = await fs.readFile(taskStartManifestPath(f.root, f.task.taskId), 'utf8').then(JSON.parse, () => null);
    if (repository) assert.equal(manifest, null);
    else assert.deepEqual([manifest.complete, manifest.reasonCode], [false, 'TASK_CHANGES_GIT_UNAVAILABLE']);
    await writeFiles(f.root, DOCUMENTS);
    assert.equal(await nonArtifactChanges({ projectRoot: f.root, taskId: f.task.taskId, plan: f.plan }), null);
    const result = await f.stop();
    assert.equal(result.stop.status, 'NO_DEVIATION_FOUND', result.stop.reasonCode);
    assert.deepEqual(f.calls.filter(call => call !== 'baseline'), ['workspace-stop']);
  });
});

test('ownership follows the shipped OpenSpec template and keeps RC-private paths out of task changes', async t => {
  const f = await fixture(t);
  for (const [file, owner] of [
    ['openspec/changes/demo/proposal.md', 'DOCUMENT_CORRECTION'], ['openspec/changes/demo/.openspec.yaml', 'DOCUMENT_CORRECTION'],
    ['openspec/changes/demo/specs/convert/spec.md', 'DOCUMENT_CORRECTION'], ['openspec/specs/convert/spec.md', 'STOP'],
    ['openspec/changes/proposal.md', 'STOP'], ['app.py', 'STOP'], ['.runtime-corrector/config.yaml', 'RUNTIME_CORRECTOR'],
    ['.runtime-correction/tasks/x/state.json', 'RUNTIME_CORRECTOR'],
  ]) assert.equal(changeOwner(file, f.plan), owner, file);
  await fs.writeFile(path.join(f.root, 'notes.txt'), 'untracked before the task\n');
  const second = await ensureTask({ projectRoot: f.root, sessionId: 'second' });
  assert.equal(await captureTaskStart({ projectRoot: f.root, taskId: second.taskId }), true);
  assert.equal(await captureTaskStart({ projectRoot: f.root, taskId: second.taskId }), false, 'the first task-start state is kept');
  await fs.writeFile(path.join(f.root, '.runtime-corrector/extra.md'), 'private\n');
  assert.deepEqual(await nonArtifactChanges({ projectRoot: f.root, taskId: second.taskId, plan: f.plan }), []);
  await fs.writeFile(path.join(f.root, 'notes.txt'), 'edited during the task\n');
  await fs.rm(path.join(f.root, 'app.py'));
  assert.deepEqual(await nonArtifactChanges({ projectRoot: f.root, taskId: second.taskId, plan: f.plan }),
    [{ path: 'app.py', status: 'DELETED' }, { path: 'notes.txt', status: 'UNTRACKED' }]);
});

test('the first pre-mutation hook event of a task captures its start state once', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-stop-scope-hook-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'project');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'app.py'), 'print(1)\n');
  git(root, 'init', '-q'); git(root, 'add', 'app.py'); git(root, 'commit', '-q', '-m', 'Start');
  const transcript = path.join(base, 'transcript.jsonl');
  await fs.writeFile(transcript, JSON.stringify({ type: 'user', uuid: 'user-1', message: { role: 'user', content: 'Edit app.py.' } }) + '\n');
  const runtimeV2 = compileRuntimeV2Config({ version: 2, artifacts: [], dynamicGroundTruth: { enabled: false },
    implementationCorrection: { enabled: false, platform: null }, stopCorrection: { enabled: true } });
  const write = id => handleRuntimeV2Event({ projectRoot: root, plan: { runtimeV2, artifacts: [] },
    reviewerFactory: async () => assert.fail('No reviewer is needed before the first edit'),
    input: { session_id: 'session', cwd: root, transcript_path: transcript, hook_event_name: 'PreToolUse', tool_name: 'Write',
      tool_input: { file_path: path.join(root, 'app.py'), content: 'print(2)\n' }, tool_use_id: id } });
  await write('tool-1');
  const task = await findTask({ projectRoot: root, sessionId: 'session' });
  const file = taskStartManifestPath(root, task.taskId), first = await fs.readFile(file, 'utf8');
  const manifest = JSON.parse(first);
  assert.equal(manifest.complete, true);
  assert.equal(manifest.head, git(root, 'rev-parse', 'HEAD').trim());
  assert.deepEqual(manifest.entries, {});
  await fs.writeFile(path.join(root, 'app.py'), 'print(2)\n');
  await write('tool-2');
  assert.equal(await fs.readFile(file, 'utf8'), first);
});

test('non-deviation-only Stop scope is unchanged', async t => {
  const population = { metrics: { M01: [{ objectId: 'M01:A' }], M16: [{ objectId: 'M16:A' }, { objectId: 'M16:B' }] } };
  for (const stopClassification of ['WAITING_FOR_USER', 'BLOCKED_EXTERNAL', 'INTERMEDIATE']) {
    const plain = selectStopPopulation(population, { stopClassification });
    assert.deepEqual([plain.scopeSelection.reasonCode, plain.scopeSelection.selectedObjectCount], ['FINDINGS_ONLY_SCOPE', 0]);
    const delivered = selectStopPopulation({ ...population, reviewPolicy: { metrics: {}, deviationOnly: true } }, { stopClassification });
    assert.deepEqual([delivered.scopeSelection.reasonCode, delivered.scopeSelection.selectedObjectCount], ['DELIVERED_WORK_SCOPE', 3]);
  }
  const undeclared = { stopClassification: 'STAGE_COMPLETE', stage: 'tasks' }, declarations = [{ stage: 'tasks', metrics: [] }];
  assert.equal(selectStopPopulation(population, undeclared, declarations).scopeSelection.reasonCode, 'STOP_STAGE_METRICS_UNDECLARED');
  assert.equal(selectStopPopulation({ ...population, reviewPolicy: { deviationOnly: true } }, undeclared, declarations).scopeSelection.reasonCode, 'DELIVERED_WORK_SCOPE');
  assert.throws(() => selectStopPopulation(population, { stopClassification: 'STAGE_COMPLETE', stage: 'unknown' }), { code: 'STOP_STAGE_SCOPE_INVALID' });

  await t.test('a deviation-only pre-implementation stage defers original production obligations', () => {
    const production = { objectId: 'M16:A', verificationTarget: 'IMPLEMENTATION' };
    const delivered = { reviewPolicy: { deviationOnly: true }, metrics: { M01: [{ objectId: 'M01:A', verificationTarget: 'ARTIFACT' }],
      M16: [production, { objectId: 'M16:R', verificationTarget: 'IMPLEMENTATION', programStanding: 'REGRESSION' }] } };
    const planningStages = ['proposal', 'specs', 'design', 'tasks'];
    const stages = [...planningStages, 'codeing'].map(stage => ({ stage, metrics: [] }));
    const scope = (value, stage) => selectStopPopulation(value, { stopClassification: 'STAGE_COMPLETE', stage }, stages);
    for (const stage of planningStages) {
      const selected = scope(delivered, stage);
      assert.deepEqual(Object.values(selected.metrics).flat().map(object => object.objectId), ['M01:A', 'M16:R']);
      assert.equal(selected.scopeSelection.reasonCode, 'DELIVERED_WORK_SCOPE');
      const empty = scope({ ...delivered, metrics: { M16: [production] } }, stage).scopeSelection;
      assert.deepEqual([empty.reasonCode, empty.fullObjectCount, empty.selectedObjectCount], ['NO_APPLICABLE_STAGE_OBJECTS', 1, 0]);
    }
    assert.equal(scope(delivered, 'codeing').scopeSelection.selectedObjectCount, 3);
    for (const stopClassification of ['INTERMEDIATE', 'WAITING_FOR_USER', 'BLOCKED_EXTERNAL'])
      assert.equal(selectStopPopulation(delivered, { stopClassification }).scopeSelection.selectedObjectCount, 3);
  });

  await t.test('intermediate Stop selects nothing', async subtest => {
    const f = await fixture(subtest, { deviationOnly: false, classification: WAITING, verdict: 'PASS' });
    await fs.writeFile(path.join(f.root, 'app.py'), 'def convert(value): return float(value)\n');
    const result = await f.stop();
    assert.equal(result.stop.status, 'UNVERIFIED');
    assert.equal(result.decision, 'allow');
    assert.notEqual(result.stop.reasonCode, 'STOP_NO_REVIEW_SCOPE');
    assert.deepEqual([result.stop.coverage.scopeReasonCode, result.stop.coverage.selectedObjectCount], ['FINDINGS_ONLY_SCOPE', 0]);
  });
  await t.test('an empty completed scope keeps its own reason', async subtest => {
    const f = await fixture(subtest, { deviationOnly: false, metrics: ['M13'], verdict: 'PASS' });
    await fs.writeFile(path.join(f.root, 'app.py'), 'def convert(value): return float(value)\n');
    const result = await f.stop();
    assert.equal(result.stop.status, 'UNVERIFIED');
    assert.notEqual(result.stop.reasonCode, 'STOP_NO_REVIEW_SCOPE');
    assert.equal(result.stop.coverage.scopeReasonCode, 'NO_APPLICABLE_METRIC_OBJECTS');
  });
});
