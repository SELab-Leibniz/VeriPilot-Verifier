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

test('an exact interrupted stage cannot reopen its journal with zero budget counters', async t => {
  const f = await sharedBasisFixture(t);
  f.state.coverageMutation = async ({ params }) => { await fs.writeFile(params.sessionFile, 'incomplete native tail'); };
  const options = { projectRoot: f.root, input: { cwd: f.root, session_id: 'basis-session', transcript_path: f.transcript,
    hook_event_name: 'Stop', hook_event_id: 'same-interrupted-stage' }, plan: f.plan, reviewerFactory: f.factory };
  await assert.rejects(refreshRuntimeRequirements(options));
  const calls = f.state.baselinePrompts.length, audits = f.audits().length;
  f.state.coverageMutation = null;
  await assert.rejects(refreshRuntimeRequirements(options));
  assert.equal(f.state.baselinePrompts.length, calls);
  assert.equal(f.audits().length, audits);
  assert.equal((await f.truth()).version, 0);
});

test('legal ADD dedup retains every operation target in the shared planner and actual apply result', async t => {
  const root = await scratch(t), task = await ensureTask({ projectRoot: root, sessionId: 'dedup' });
  const first = await applyGroundTruthDelta({ projectRoot: root, taskId: task.taskId, delta: { operations: [operation()] } });
  const delta = { operations: [operation(), operation()] }, plan = planGroundTruthDelta({ current: first.current, delta });
  assert.equal(plan.accepted.length, 0); assert.equal(plan.operationDispositions.length, 2);
  for (const row of plan.operationDispositions) {
    assert.equal(row.disposition, 'DEDUPLICATED');
    assert.equal(row.target.claimId, first.current.claims[0].claimId);
    assert.equal(row.target.revisionId, first.current.claims[0].revisionId);
    assert.equal(row.target.digest, sha256(first.current.claims[0]));
    assert.deepEqual(row.effectiveTarget, row.target);
  }
  const actual = await applyGroundTruthDelta({ projectRoot: root, taskId: task.taskId, delta });
  assert.deepEqual(actual.operationDispositions, plan.operationDispositions);
  const altered = structuredClone(plan); altered.operationDispositions[0].target.digest = 'wrong';
  assert.notEqual(groundTruthPlanDigest(altered), plan.digest);
});

for (const fault of ['zero-write', 'short-write', 'fsync']) test(`journal ${fault} poisons future acceptance and preserves failed bytes`, async t => {
  const root = await scratch(t), journal = new ObservationJournal(root), before = journal.verify();
  if (fault === 'fsync') t.mock.method(fsSync, 'fsyncSync', () => { throw new Error('Controlled fsync failure'); });
  else {
    const write = fsSync.writeSync;
    t.mock.method(fsSync, 'writeSync', (fd, buffer, offset, length) => fault === 'zero-write' ? 0 : write(fd, buffer, offset, length - 1));
  }
  assert.throws(() => journal.append({ content: '中文\r\n' }), { code: 'JOURNAL_UNCERTAIN' });
  assert.equal(journal.getEntries().length, 0);
  t.mock.restoreAll();
  assert.throws(() => journal.append({ content: 'Cannot recover with zero counters' }), { code: 'JOURNAL_UNCERTAIN' });
  assert.throws(() => journal.verify(), { code: 'JOURNAL_UNCERTAIN' });
  assert((await fs.stat(before.path)).size >= before.bytes);
});

test('journal accounts for exact UTF8 byte lengths and refuses uncertain restoration', async t => {
  const root = await scratch(t), journal = new ObservationJournal(root);
  journal.append({ text: '中文\r\n😀' });
  const proof = journal.verify();
  assert.equal(proof.bytes, (await fs.readFile(journal.file)).length);
  const before = await fs.readFile(journal.file);
  assert.throws(() => new ObservationJournal(root), { code: 'JOURNAL_UNCERTAIN' });
  assert.deepEqual(await fs.readFile(journal.file), before);
});

test('extractor and checker debit one original turn pool and cannot mint a third turn', async t => {
  const root = await scratch(t), frozen = path.join(root, 'frozen'); await fs.mkdir(frozen);
  await fs.writeFile(path.join(frozen, 'source.txt'), 'Original.');
  const worker = await createBaselineWorker({ root: frozen, outputDir: root,
    identity: { requestId: 'shared-budget', taskId: 'budget-task', protocol: BASELINE_EXTRACTION_PROTOCOL, sources: [], sourceCatalog: [] },
    requiredFiles: ['source.txt'], schema: GROUND_TRUTH_REVIEW_SCHEMA, active() {}, assertCurrent() {},
    maxTurns: 2, maxRepairs: 3, deadlineAt: Date.now() + 10000, nativeRun: async () => {} });
  worker.budget.consumeTurn('extractor', { runId: 'actor', sessionId: 'actor' });
  worker.budget.beginAudit({ runId: 'checker', sessionId: 'checker' }, 'candidate');
  worker.budget.consumeTurn('checker', { runId: 'checker', sessionId: 'checker' });
  assert.equal(worker.budget.snapshot().turns, 2);
  assert.deepEqual(worker.budget.snapshot().consumers, { extractor: 1, checker: 1 });
  assert.throws(() => worker.budget.consumeTurn('extractor'), { code: 'TURN_LIMIT' });
  assert.throws(() => worker.budget.snapshot(), { code: 'TURN_LIMIT' });
  await worker.close();
});

test('configured 2000-step pool passes the old 200-step boundary and stops both consumers at the configured cap', async t => {
  const root = await scratch(t), frozen = path.join(root, 'frozen'); await fs.mkdir(frozen);
  await fs.writeFile(path.join(frozen, 'source.txt'), 'Original.');
  const worker = await createBaselineWorker({ root: frozen, outputDir: root,
    identity: { requestId: 'large-shared-budget', taskId: 'budget-task', protocol: BASELINE_EXTRACTION_PROTOCOL, sources: [], sourceCatalog: [] },
    requiredFiles: ['source.txt'], schema: GROUND_TRUTH_REVIEW_SCHEMA, active() {}, assertCurrent() {},
    maxTurns: 2000, maxRepairs: 2000, maxAuditCalls: 2000, maxExternalRepairs: 2000,
    deadlineAt: Date.now() + 86400000, nativeRun: async () => {} });
  worker.budget.beginAudit({ runId: 'checker', sessionId: 'checker' }, 'candidate');
  for (let i = 0; i < 2000; i++) worker.budget.consumeTurn(i % 2 ? 'checker' : 'extractor',
    i % 2 ? { runId: 'checker', sessionId: 'checker' } : { runId: 'actor', sessionId: 'actor' });
  assert.equal(worker.budget.snapshot().turns, 2000);
  assert.deepEqual(worker.budget.snapshot().consumers, { extractor: 1000, checker: 1000 });
  assert.throws(() => worker.budget.consumeTurn('checker', { runId: 'checker', sessionId: 'checker' }), { code: 'TURN_LIMIT' });
  assert.throws(() => worker.budget.consumeTurn('extractor'), { code: 'TURN_LIMIT' });
  await worker.close();
});
