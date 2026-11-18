import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readArktsCorrectionEvidence, readArktsVerifiedRepairStarts } from '../scripts/bench/arkts-correction-evidence.mjs';
import { digest } from '../scripts/bench/arkts-dataset.mjs';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-arkts-correction-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (relative, value) => {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value));
    return file;
  };
  const preparedHead = '3'.repeat(40);
  const projectRoot = path.join(root, 'business-project');
  const sessionId = 'original-session', sessionKey = 'agent:main:arkts-fixture';
  const publicInputSha256 = digest('public task');
  const originalRun = 'original-coding', repairRun = 'rc-stop-repair';
  const stopId = 'native-occurrence:check-2', deviation = 'off-track-evaluation';
  const firstNative = { runId: originalRun, occurrenceId: stopId, evaluationId: deviation, status: 'SETTLED', reviewStatus: 'DEVIATION' };
  const finalNative = { runId: repairRun, occurrenceId: 'native-occurrence:check-3', evaluationId: 'final-evaluation',
    status: 'SETTLED', reviewStatus: 'NO_DEVIATION_FOUND' };
  const transcript = `${JSON.stringify({ type: 'session', id: sessionId })}\n`;
  const patch = value => `diff --git a/entry/src/app.ets b/entry/src/app.ets\n--- a/entry/src/app.ets\n+++ b/entry/src/app.ets\n@@ -1 +1 @@\n-start\n+${value}\n`;
  const delta = 'diff --git a/openspec/changes/a/specs/b/spec.md b/openspec/changes/a/specs/b/spec.md\nnew file mode 100644\n--- /dev/null\n+++ b/openspec/changes/a/specs/b/spec.md\n@@ -0,0 +1 @@\n+delta spec\n';
  const beforeBusiness = patch('incorrect'), before = beforeBusiness + delta, after = patch('correct');
  const freeze = { preparedHead, patchSha256: digest(after), workspacePatchSha256: digest(after + delta), sessionSha256: digest(transcript) };
  const terminal = runId => ({ runId, requestedRunId: runId, source: 'agent.wait', status: 'ok' });
  const result = { state: 'finished', rcEnabled: true, businessNatural: true, frameworkError: false, nativeStopSettled: true,
    sessionId, sessionKey, projectRoot, publicInputSha256, frozen: freeze, nativeStopVerification: finalNative,
    nativeStopRecords: [firstNative, finalNative], stopReviews: [{ evaluationId: deviation, status: 'DEVIATION', startedAt: 5000 }],
    openSpec: { proposal: { readyToApply: true }, codeing: { applyComplete: true } },
    turns: [{ stage: 'proposal' }, { stage: 'codeing', runId: originalRun, finalRunId: repairRun, startedAt: 3000, settled: true,
      originalTerminal: terminal(originalRun), terminal: terminal(repairRun) }] };
  const admission = { id: 'repair', flowId: 'coding-flow', stopId, accounting: 'USED', startStatus: 'STARTED', deliveryStatus: 'DELIVERED',
    executionId: repairRun, startedAt: 6000, endedAt: 7000,
    hostRequest: { runId: repairRun, sessionKey, projectRoot, assessmentId: deviation } };
  const ledger = { schemaVersion: 'runtime-corrector.stop-correction-session.v1', sessionId,
    stops: { [stopId]: { scope: projectRoot, flowId: 'coding-flow', reviewStatus: 'DEVIATION', admissionId: 'repair' } },
    admissions: { repair: admission }, events: [{ type: 'CONTINUATION_STARTED', admissionId: 'repair', executionId: repairRun, valid: true, startedAt: 6000 }] };
  const checkpoint = { runId: originalRun, sessionId, preparedHead, stopReason: 'before_agent_finalize', event: 'agent_end', success: true,
    paths: ['entry/src/app.ets', 'openspec/changes/a/specs/b/spec.md'], patchSha256: digest(before),
    businessPatchSha256: digest(beforeBusiness),
    capturedAt: new Date(4000).toISOString(), completedAt: new Date(4500).toISOString() };
  const checkpointPath = 'checkpoints/original/checkpoint.json';
  const candidatePath = 'checkpoints/original/candidate.patch';
  const businessPath = 'checkpoints/original/business-candidate.patch';
  const ledgerPath = `native-host/state/runtime-corrector-stop-sessions/sessions/${digest(sessionId)}.json`;
  await Promise.all([
    write('manifest.json', { rcEnabled: true, projectRoot, publicInputSha256, preparedHead }), write('result.json', result),
    write('freeze/freeze.json', freeze), write('freeze/candidate.patch', after), write('freeze/workspace.patch', after + delta),
    write('freeze/session.jsonl', transcript), write(ledgerPath, ledger), write(checkpointPath, checkpoint), write(candidatePath, before),
    write(businessPath, beforeBusiness),
    write('checkpoints/irrelevant/checkpoint.json', { ...checkpoint, runId: 'proposal', capturedAt: new Date(1000).toISOString() }),
  ]);
  return { root, write, result, ledger, admission, checkpoint, checkpointPath, candidatePath, businessPath, ledgerPath, before, beforeBusiness, after, delta };
}

async function continuationFixture(data, overrides = {}, directory = 'continuation') {
  const patch = data.after.replace('+correct\n', '+immediately after repair\n');
  const observed = patch + data.delta;
  const root = `checkpoints/${directory}`;
  const receipt = { ...data.checkpoint, runId: data.admission.executionId, patchSha256: digest(observed), businessPatchSha256: digest(patch),
    capturedAt: new Date(6600).toISOString(), completedAt: new Date(6800).toISOString(), ...overrides };
  const [receiptFile, observedFile, file] = await Promise.all([
    data.write(`${root}/checkpoint.json`, receipt), data.write(`${root}/candidate.patch`, observed),
    data.write(`${root}/business-candidate.patch`, patch),
  ]);
  return { receipt, receiptFile, observedFile, file, patch, observed };
}

async function unfinishedRepairFixture(t) {
  const data = await fixture(t);
  const { root, result, ledger, admission } = data;
  delete result.frozen;
  delete result.nativeStopVerification;
  delete admission.endedAt;
  const [native] = result.nativeStopRecords;
  result.nativeStopRecords = [native];
  native.settledAt = 5650;
  Object.assign(result, { state: 'timed-out', businessNatural: false, nativeStopSettled: false,
    turns: [{ stage: 'codeing', runId: native.runId, settled: false }] });
  Object.assign(admission, { createdAt: 5630, deadlineAt: 7100, observedAt: 6010, lateConfirmation: false });
  Object.assign(admission.hostRequest, { source: { runId: native.runId }, createdAt: 5640, gate: { at: 5900 } });
  Object.assign(ledger.stops[admission.stopId], { id: admission.stopId });
  const start = ledger.events[0];
  Object.assign(start, { observedAt: 6011, lateConfirmation: false });
  ledger.events.unshift({ type: 'STOP_REVIEW_SETTLED', stopId: admission.stopId, status: 'DEVIATION', observedAt: 5620 });
  await Promise.all(['freeze', 'checkpoints'].map(file => fs.rm(path.join(root, file), { recursive: true })));
  return { ...data, native, start };
}

const persistRepairStart = ({ write, result, ledgerPath, ledger }) => Promise.all([
  write('result.json', result), write(ledgerPath, ledger),
]);

test('verifies a native correction start without a terminal, freeze, or completed repair', async t => {
  const data = await unfinishedRepairFixture(t);
  await persistRepairStart(data);
  const { root, native, admission } = data;
  const expectedResultSha256 = digest(await fs.readFile(path.join(root, 'result.json')));
  const starts = [{ runId: admission.executionId, sourceRunId: native.runId, occurrenceId: native.occurrenceId,
    evaluationId: native.evaluationId, startedAt: 6000 }];
  assert.deepEqual(await readArktsVerifiedRepairStarts(root, { expectedResultSha256 }), starts);
  assert.deepEqual(await readArktsVerifiedRepairStarts(root, { expectedResultSha256: digest('unrelated result') }), []);
  assert.deepEqual(await readArktsCorrectionEvidence(root, { includeIncompleteWorkflow: true }),
    { status: 'inconclusive', reason: 'PAIRED_BUSINESS_INCOMPLETE' });

  // Cleanup can invalidate the live Stop without undoing its historical start.
  Object.assign(data.ledger.stops[admission.stopId], { reviewStatus: 'UNVERIFIED', invalidatedReview: { status: 'DEVIATION', at: 7000 } });
  await persistRepairStart(data);
  assert.deepEqual(await readArktsVerifiedRepairStarts(root), starts);
});

test('keeps uncorroborated starts out of positive repair evidence', async t => {
  for (const [name, mutate] of [
    ['invalid event', ({ start }) => { start.valid = false; }],
    ['late event', ({ start }) => { start.lateConfirmation = true; }],
    ['late admission', ({ admission }) => { admission.lateConfirmation = true; }],
    ['queued delivery', ({ admission }) => { admission.deliveryStatus = 'QUEUED'; }],
    ['foreign event', ({ start }) => { start.executionId = 'foreign'; }],
    ['foreign session', ({ admission }) => { admission.hostRequest.sessionKey = 'foreign'; }],
    ['foreign project', ({ admission }) => { admission.hostRequest.projectRoot = 'foreign'; }],
    ['foreign source', ({ admission }) => { admission.hostRequest.source.runId = 'foreign'; }],
    ['foreign assessment', ({ admission }) => { admission.hostRequest.assessmentId = 'foreign'; }],
    ['foreign ledger', ({ ledger }) => { ledger.sessionId = 'foreign'; }],
    ['duplicate start', ({ ledger, start }) => { ledger.events.push({ ...start }); }],
    ['duplicate native receipt', ({ result, native }) => { result.nativeStopRecords.push({ ...native }); }],
    ['early model start', ({ admission }) => { admission.hostRequest.gate.at = 6001; }],
    ['missing review settlement', ({ ledger }) => { ledger.events.shift(); }],
    ['unsettled native review', ({ native }) => { native.status = 'RUNNING'; }],
  ]) await t.test(name, async t => {
    const data = await unfinishedRepairFixture(t);
    mutate(data);
    await persistRepairStart(data);
    assert.deepEqual(await readArktsVerifiedRepairStarts(data.root), []);
  });
});

test('selects the original coding checkpoint and sealed final candidate using the native correction lineage', async t => {
  const data = await fixture(t);
  const { root, before, beforeBusiness, after } = data;
  const immediate = await continuationFixture(data);
  const result = await readArktsCorrectionEvidence(root);
  assert.equal(result.status, 'eligible', result.reason);
  assert.equal(result.before.runId, 'original-coding');
  assert.equal(result.after.runId, 'rc-stop-repair');
  assert.equal(result.after.evaluationId, 'final-evaluation');
  assert.deepEqual(result.corrections.map(row => [row.sourceRunId, row.runId, row.evaluationId]),
    [['original-coding', 'rc-stop-repair', 'off-track-evaluation']]);
  assert.equal(result.before.sha256, digest(beforeBusiness));
  assert.equal(result.before.observedSha256, digest(before));
  assert.equal(result.after.sha256, digest(after));
  assert.equal(await fs.readFile(result.before.file, 'utf8'), beforeBusiness);
  assert.equal(await fs.readFile(result.before.observedFile, 'utf8'), before);
  assert.equal(await fs.readFile(result.after.file, 'utf8'), after);
  assert.deepEqual(result.corrections[0].finalizedCheckpoint, {
    status: 'captured', file: immediate.file, sha256: digest(immediate.patch), runId: result.after.runId,
    capturedAt: immediate.receipt.capturedAt, completedAt: immediate.receipt.completedAt,
    observedFile: immediate.observedFile, observedSha256: digest(immediate.observed),
  });
  assert.notEqual(result.corrections[0].finalizedCheckpoint.sha256, result.after.sha256);
});

test('selects the single coding turn after a proposal validation retry', async t => {
  const { root, write, result } = await fixture(t);
  result.turns.splice(1, 0, { stage: 'proposal', validationRepair: true });
  await write('result.json', result);
  assert.equal((await readArktsCorrectionEvidence(root)).before.runId, 'original-coding');
  result.turns.push({ ...result.turns.at(-1) });
  await write('result.json', result);
  assert.equal((await readArktsCorrectionEvidence(root)).reason, 'CODING_TERMINALS_UNVERIFIED');
});

test('an updated business receipt cannot supply the lineage for a sealed observation', async t => {
  const { root, write, result } = await fixture(t);
  const expectedResultSha256 = digest(await fs.readFile(path.join(root, 'result.json')));
  assert.equal((await readArktsCorrectionEvidence(root, { expectedResultSha256 })).status, 'eligible');
  await write('result.json', { ...result, diagnostics: 'different receipt bytes' });
  assert.deepEqual(await readArktsCorrectionEvidence(root, { expectedResultSha256 }),
    { status: 'inconclusive', reason: 'BUSINESS_RECEIPT_CHANGED' });
});

test('attributes only Stop-launched repairs after a verified Apply transport recovery', async t => {
  const { root, write, result } = await fixture(t);
  const resumed = result.turns.at(-1);
  resumed.transportRecovery = true;
  const interrupted = { stage: 'codeing', settled: true, runId: 'interrupted', finalRunId: 'interrupted', finishedAt: 2500,
    terminal: { runId: 'interrupted', requestedRunId: 'interrupted', source: 'agent.wait', status: 'error' } };
  result.turns.splice(-1, 0, interrupted);
  const source = { sourceRunId: 'interrupted', checkpointSha256: digest('workspace'), promptSha256: digest('recovery prompt') };
  result.openSpec.applyTransportRecovery = { ...source, retryRunId: resumed.runId, verified: true };
  await write('openspec-apply-transport-recovery.json', source);
  await write('result.json', result);
  const evidence = await readArktsCorrectionEvidence(root);
  assert.equal(evidence.status, 'eligible', evidence.reason);
  assert.deepEqual(evidence.corrections.map(row => [row.sourceRunId, row.runId]), [[resumed.runId, resumed.finalRunId]]);
  await write('openspec-apply-transport-recovery.json', { ...source, sourceRunId: 'foreign' });
  assert.equal((await readArktsCorrectionEvidence(root)).reason, 'CODING_TERMINALS_UNVERIFIED');
});

test('retains diagnostic repair evidence for a settled workflow-incomplete result', async t => {
  const { root, write, result, beforeBusiness } = await fixture(t);
  result.businessNatural = false;
  result.openSpec.codeing.applyComplete = false;
  result.reason = 'OPENSPEC_APPLY_INCOMPLETE';
  await write('result.json', result);
  assert.equal((await readArktsCorrectionEvidence(root)).reason, 'PAIRED_BUSINESS_INCOMPLETE');
  const options = { includeIncompleteWorkflow: true };
  const evidence = await readArktsCorrectionEvidence(root, options);
  assert.equal(evidence.status, 'diagnostic', evidence.reason);
  assert.equal(evidence.workflowReason, result.reason);
  assert.equal(evidence.before.sha256, digest(beforeBusiness));
  assert.equal(evidence.corrections.length, 1);
  assert.deepEqual(evidence.corrections[0].finalizedCheckpoint, { status: 'inconclusive', reason: 'CONTINUATION_CHECKPOINT_MISSING' });
  await write('result.json', { ...result, nativeStopSettled: false });
  assert.equal((await readArktsCorrectionEvidence(root, options)).reason, 'PAIRED_BUSINESS_INCOMPLETE');
});

function closeAfterCorrection({ result, ledger, admission }) {
  const [initial, final] = result.nativeStopRecords;
  const initialStop = ledger.stops[initial.occurrenceId];
  const currentDeviations = [{ objectId: 'M12:completion-claim', receiptId: 'saved-deviation' }];
  result.businessNatural = false;
  result.openSpec.codeing.applyComplete = false;
  result.reason = 'OPENSPEC_APPLY_INCOMPLETE';
  result.stopReviews[0].runId = initial.runId;
  initial.settledAt = 5600;
  final.settledAt = 7600;
  Object.assign(initialStop, { reviewStatus: 'UNVERIFIED', reviewScopeId: 'same-scope', scopeEndedByStopId: final.occurrenceId,
    invalidatedReview: { status: 'DEVIATION', currentDeviations, at: 8100 } });
  ledger.stops[final.occurrenceId] = { scope: initialStop.scope, flowId: admission.flowId,
    reviewScopeId: 'same-scope', reviewStatus: final.reviewStatus };
  Object.assign(admission, { invalidationReason: 'RC_NATIVE_CANCELLED', invalidatedAt: 8000 });
  ledger.flows = { [admission.flowId]: { closedAt: 8200, closeReason: 'RC_NATIVE_CANCELLED' } };
  ledger.events = [
    { type: 'STOP_REVIEW_SETTLED', stopId: initial.occurrenceId, status: 'DEVIATION', observedAt: 5500 },
    { ...ledger.events[0], observedAt: 6010, lateConfirmation: false },
    { type: 'STOP_REVIEW_SETTLED', stopId: final.occurrenceId, status: final.reviewStatus, observedAt: 7500 },
    { type: 'STOP_RELEASED', stopId: initial.occurrenceId, reasonCode: 'RC_NATIVE_CANCELLED', accounting: 'USED', observedAt: 8300 },
  ];
}

test('verifies a completed repair even when native cleanup invalidates the original Stop', async t => {
  const data = await fixture(t);
  closeAfterCorrection(data);
  await data.write('result.json', data.result);
  await data.write(data.ledgerPath, data.ledger);
  const evidence = await readArktsCorrectionEvidence(data.root, { includeIncompleteWorkflow: true });
  assert.equal(evidence.status, 'diagnostic', evidence.reason);
  assert.equal(evidence.workflowReason, 'OPENSPEC_APPLY_INCOMPLETE');
  assert.equal(evidence.corrections.length, 1);
  assert.equal(evidence.corrections[0].evaluationId, 'off-track-evaluation');
  assert.equal(evidence.after.runId, 'rc-stop-repair');
  assert.equal(evidence.after.reviewStatus, 'NO_DEVIATION_FOUND');
  assert.equal((await readArktsCorrectionEvidence(data.root)).reason, 'PAIRED_BUSINESS_INCOMPLETE');
});

test('rejects invalidated Stops without historical deviation, same-scope settlement and ordered closure', async t => {
  for (const [name, change] of [
    ['no historical deviation', ({ ledger, admission }) => { delete ledger.stops[admission.stopId].invalidatedReview; }],
    ['foreign immutable review', ({ result }) => { result.stopReviews[0].runId = 'foreign-run'; }],
    ['late start', ({ ledger }) => { ledger.events[1].lateConfirmation = true; }],
    ['missing closure', ({ ledger }) => { ledger.events.pop(); }],
    ['closure before follow-up', ({ ledger }) => { ledger.events.splice(2, 0, ledger.events.pop()); }],
    ['backdated closure', ({ ledger }) => { ledger.events.at(-1).observedAt = 6000; }],
    ['different follow-up scope', ({ ledger, result }) => { ledger.stops[result.nativeStopVerification.occurrenceId].reviewScopeId = 'foreign-scope'; }],
    ['missing linked native occurrence', ({ ledger, admission }) => { ledger.stops[admission.stopId].scopeEndedByStopId = 'foreign-occurrence'; }],
  ]) await t.test(name, async t => {
    const data = await fixture(t);
    closeAfterCorrection(data);
    change(data);
    await data.write('result.json', data.result);
    await data.write(data.ledgerPath, data.ledger);
    const evidence = await readArktsCorrectionEvidence(data.root, { includeIncompleteWorkflow: true });
    assert.deepEqual(evidence, { status: 'inconclusive', reason: 'CORRECTION_LINEAGE_UNVERIFIED' });
  });
});

test('requires a matching business projection when OpenSpec files changed', async t => {
  const { root, write, checkpoint, checkpointPath, businessPath, candidatePath, beforeBusiness } = await fixture(t);
  await write(businessPath, 'changed projection');
  assert.equal((await readArktsCorrectionEvidence(root)).reason, 'PRE_STOP_BUSINESS_PATCH_UNVERIFIED');
  delete checkpoint.businessPatchSha256;
  await write(checkpointPath, checkpoint);
  assert.equal((await readArktsCorrectionEvidence(root)).reason, 'PRE_STOP_BUSINESS_PATCH_REQUIRED');
  checkpoint.paths = ['entry/src/app.ets'];
  checkpoint.patchSha256 = digest(beforeBusiness);
  await write(checkpointPath, checkpoint);
  await write(candidatePath, beforeBusiness);
  const legacy = await readArktsCorrectionEvidence(root);
  assert.equal(legacy.status, 'eligible', legacy.reason);
  assert.equal(legacy.before.file, path.join(root, candidatePath));
});

test('rejects reserved, foreign and unobserved followups', async t => {
  for (const change of [
    ({ admission }) => { admission.accounting = 'RESERVED'; },
    ({ admission }) => { admission.hostRequest.sessionKey = 'foreign-session'; },
    ({ ledger }) => { ledger.events[0].valid = false; },
  ]) {
    const data = await fixture(t);
    change(data);
    await data.write(data.ledgerPath, data.ledger);
    assert.deepEqual(await readArktsCorrectionEvidence(data.root), { status: 'inconclusive', reason: 'CORRECTION_LINEAGE_UNVERIFIED' });
  }
});

test('requires a linked admission for each corrective run and preserves an inconclusive final review', async t => {
  const data = await fixture(t);
  const { root, write, result, ledger, admission, ledgerPath } = data;
  const secondRun = 'rc-stop-repair-2', secondStop = 'native-occurrence:check-3';
  const secondReview = { ...result.nativeStopVerification, occurrenceId: secondStop, reviewStatus: 'DEVIATION' };
  const finalReview = { ...secondReview, occurrenceId: 'native-occurrence:check-4', runId: secondRun,
    reviewStatus: 'UNVERIFIED', evaluationId: 'second-final-evaluation' };
  result.nativeStopRecords = [result.nativeStopRecords[0], secondReview, finalReview];
  result.nativeStopVerification = finalReview;
  result.turns[1].finalRunId = secondRun;
  result.turns[1].terminal = { ...result.turns[1].terminal, runId: secondRun, requestedRunId: secondRun };
  await write('result.json', result);
  assert.equal((await readArktsCorrectionEvidence(root)).reason, 'CORRECTION_LINEAGE_UNVERIFIED');
  ledger.stops[secondStop] = { ...ledger.stops[admission.stopId], admissionId: 'repair-2' };
  ledger.admissions['repair-2'] = { ...admission, id: 'repair-2', stopId: secondStop, executionId: secondRun, startedAt: 8000, endedAt: 9000,
    hostRequest: { ...admission.hostRequest, runId: secondRun, assessmentId: secondReview.evaluationId } };
  ledger.events.push({ ...ledger.events[0], admissionId: 'repair-2', executionId: secondRun, startedAt: 8000 });
  await write(ledgerPath, ledger);
  const first = await continuationFixture(data);
  const second = await continuationFixture(data, { runId: secondRun,
    capturedAt: new Date(8500).toISOString(), completedAt: new Date(8800).toISOString() }, 'second-continuation');
  const evidence = await readArktsCorrectionEvidence(root);
  assert.equal(evidence.status, 'eligible', evidence.reason);
  assert.deepEqual(evidence.corrections.map(row => row.runId), ['rc-stop-repair', secondRun]);
  assert.deepEqual(evidence.corrections.map(row => [row.finalizedCheckpoint.status, row.finalizedCheckpoint.file]),
    [['captured', first.file], ['captured', second.file]]);
  assert.equal(evidence.after.reviewStatus, 'UNVERIFIED');
});

test('an unbound continuation checkpoint does not replace a verified terminal delivery', async t => {
  for (const [name, overrides, reason] of [
    ['different run', { runId: 'foreign' }, 'CHECKPOINT_MISSING'],
    ['different session', { sessionId: 'foreign' }, 'CHECKPOINT_MISSING'],
    ['different base', { preparedHead: '4'.repeat(40) }, 'CHECKPOINT_MISSING'],
    ['no successful agent end', { success: false }, 'CHECKPOINT_MISSING'],
    ['before admission', { capturedAt: new Date(5900).toISOString() }, 'TIME_UNVERIFIED'],
    ['after end', { completedAt: new Date(7100).toISOString() }, 'TIME_UNVERIFIED'],
    ['changed observed patch', { patchSha256: digest('changed') }, 'PATCH_UNVERIFIED'],
    ['changed projected patch', { businessPatchSha256: digest('changed') }, 'BUSINESS_PATCH_UNVERIFIED'],
  ]) await t.test(name, async t => {
    const data = await fixture(t);
    await continuationFixture(data, overrides);
    const evidence = await readArktsCorrectionEvidence(data.root);
    assert.equal(evidence.status, 'eligible', evidence.reason);
    assert.deepEqual(evidence.corrections[0].finalizedCheckpoint, { status: 'inconclusive', reason: `CONTINUATION_${reason}` });
    assert.equal(evidence.after.sha256, digest(data.after));
  });
});

test('unsealed directories are ignored and ambiguous continuation receipts stay inconclusive', async t => {
  const data = await fixture(t);
  await data.write('checkpoints/unsealed/business-candidate.patch', 'not committed by the observer');
  await continuationFixture(data);
  const first = await readArktsCorrectionEvidence(data.root);
  assert.equal(first.corrections[0].finalizedCheckpoint.status, 'captured');
  await continuationFixture(data, {}, 'duplicate-continuation');
  const repeated = await readArktsCorrectionEvidence(data.root);
  assert.deepEqual(repeated.corrections[0].finalizedCheckpoint, { status: 'inconclusive', reason: 'CONTINUATION_CHECKPOINT_AMBIGUOUS' });
  assert.equal(repeated.after.sha256, first.after.sha256);
});

test('rejects a checkpoint with changed bytes, ambiguous ownership, or capture after Stop', async t => {
  const { root, write, checkpoint, checkpointPath, candidatePath, before } = await fixture(t);
  await write(candidatePath, 'changed checkpoint');
  assert.equal((await readArktsCorrectionEvidence(root)).reason, 'PRE_STOP_PATCH_UNVERIFIED');
  await write(candidatePath, before);
  await write(checkpointPath, { ...checkpoint, capturedAt: new Date(5500).toISOString() });
  assert.equal((await readArktsCorrectionEvidence(root)).reason, 'PRE_STOP_TIME_UNVERIFIED');
  await write(checkpointPath, checkpoint);
  await write('checkpoints/duplicate/checkpoint.json', checkpoint);
  assert.equal((await readArktsCorrectionEvidence(root)).reason, 'PRE_STOP_CHECKPOINT_AMBIGUOUS');
});

test('does not infer a correction from a terminal alone or a mutated final patch', async t => {
  const { root, write, result } = await fixture(t);
  result.nativeStopVerification = { ...result.nativeStopVerification, runId: 'foreign-final-run' };
  await write('result.json', result);
  assert.equal((await readArktsCorrectionEvidence(root)).reason, 'FINAL_STOP_UNVERIFIED');
  result.nativeStopVerification = result.nativeStopRecords[1];
  await write('result.json', result);
  await write('freeze/candidate.patch', 'changed final candidate');
  assert.equal((await readArktsCorrectionEvidence(root)).reason, 'FREEZE_BYTES_MISMATCH');
});
