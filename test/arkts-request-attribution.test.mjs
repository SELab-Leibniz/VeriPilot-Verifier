import assert from 'node:assert/strict';
import test from 'node:test';
import { digest } from '../scripts/bench/arkts-dataset.mjs';
import { openSpecTaskTextSha256 } from '../scripts/bench/business-checkpoint.mjs';
import { attributeArktsProviderRequests } from '../scripts/bench/arkts-request-attribution.mjs';

function call(id, runId, sessionId, sessionKey) {
  const owner = { callId: id, runId, sessionId, sessionKey, traceparentSha256: digest(id) };
  return [{ ...owner, type: 'model.call.started', ts: 1000, seq: 1 },
    { ...owner, type: 'model.call.completed', ts: 2000, seq: 2 }];
}

function wire(id, callId, options = {}) {
  const base = { id, phase: options.phase ?? 'business-codeing', startedAt: new Date(1100).toISOString(),
    traceparentSha256: digest(callId) };
  return [{ ...base, event: 'request' },
    { ...base, event: options.event ?? 'response_end', durationMs: 100 }];
}

function fixture(providerRequests, modelCalls = [], privateRuns = []) {
  return { modelRequests: providerRequests, requestTimingCount: providerRequests, sessionId: 'main', sessionKey: 'key-main',
    turns: [{ runId: 'apply-original', finalRunId: 'apply-repair' }, { runId: 'proposal' }],
    gateway: { modelCalls }, privateRuns };
}

test('attributes physical requests to verified owners across phases and counts a shared-call wire attempt', () => {
  const result = fixture(5, [
    ...call('business', 'proposal', 'main', 'key-main'),
    ...call('workflow', 'apply-repair', 'main', 'key-main'),
    ...call('document', 'review-doc', 'docs', 'key-docs'),
    ...call('stop', 'review-stop', 'stop', 'key-stop'),
  ], [
    { runId: 'review-doc', sessionId: 'docs', status: 'SETTLED', role: 'artifact-reviewer' },
    { runId: 'review-stop', sessionId: 'stop', status: 'SETTLED', role: 'stop-reviewer' },
  ]);
  const timings = [
    ...wire(1, 'business', { phase: 'business-proposal-transport-recovery', event: 'request_error' }),
    ...wire(2, 'business', { phase: 'business-proposal-transport-recovery' }),
    ...wire(3, 'document', { phase: 'business-proposal-validation-repair' }),
    ...wire(4, 'stop', { phase: 'business-apply-transport-recovery' }),
    ...wire(5, 'workflow', { phase: 'business-apply-checklist-repair' }),
  ];
  timings[2].startedAt = timings[3].startedAt = new Date(1300).toISOString();
  const report = attributeArktsProviderRequests(result, timings);
  assert.equal(report.status, 'COMPLETE');
  assert.equal(report.attributedRequests, 5);
  assert.equal(report.logicalCallsWithAttributedRequests, 4);
  assert.equal(report.additionalWireAttempts, 1);
  assert.deepEqual(report.byStage.proposal, { business: 2, document: 1, stop: 0, unknown: 0 });
  assert.deepEqual(report.byStage.apply, { business: 1, document: 0, stop: 1, unknown: 0 });
});

test('keeps missing or unreadable timing unknown and conserves sealed counts', () => {
  const earlier = attributeArktsProviderRequests(fixture(2), [wire(1, 'missing')[0], wire(2, 'missing')[0]]);
  assert.equal(earlier.observedTimingRequests, 2);
  assert.equal(earlier.byStage.apply.unknown, 2);
  assert.equal(earlier.status, 'UNAVAILABLE');
  const absent = attributeArktsProviderRequests(fixture(2));
  assert.equal(absent.observedTimingRequests, null);
  assert.equal(absent.unknownRequests, 2);
  assert.equal(absent.missingTimingRequests, 2);
  assert.equal(attributeArktsProviderRequests(fixture(0)).status, 'COMPLETE');
  assert.equal(attributeArktsProviderRequests(null).providerRequests, null);
  for (const timings of [[...wire(1, 'missing'), ...wire(1, 'missing')], [...wire(1, 'missing'), ...wire(2, 'missing'), ...wire(3, 'missing')]]) {
    const invalid = attributeArktsProviderRequests(fixture(2), timings);
    assert.equal(invalid.status, 'UNAVAILABLE');
    assert.equal(invalid.byStage, null);
    assert.equal(invalid.unknownRequests, 2);
  }
});

test('reports partial ownership for ambiguous, foreign, unfinished or conflicting activity', async t => {
  for (const [name, mutate] of [
    ['missing trace', (_result, rows) => { delete rows[2].traceparentSha256; }],
    ['duplicate trace start', result => result.gateway.modelCalls.push({ ...result.gateway.modelCalls[2], callId: 'second-call' })],
    ['mismatched closing session', result => { result.gateway.modelCalls[3].sessionId = 'foreign'; }],
    ['late wire finish', (_result, rows) => { rows[3].durationMs = 5000; }],
    ['observation stopped', (_result, rows) => { rows[3].event = 'observation_end'; }],
    ['owned session with an unknown run', result => { result.gateway.modelCalls[2].runId = result.gateway.modelCalls[3].runId = 'compaction'; }],
    ['business and reviewer ownership conflict', result =>
      result.privateRuns.push({ runId: 'apply-original', sessionId: 'main', status: 'SETTLED', role: 'artifact-reviewer' })],
  ]) await t.test(name, () => {
    const result = fixture(3, [
      ...call('known', 'apply-repair', 'main', 'key-main'),
      ...call('uncertain', 'apply-original', 'main', 'key-main'),
    ]);
    const timings = [...wire(1, 'known'), ...wire(2, 'uncertain')];
    mutate(result, timings);
    const report = attributeArktsProviderRequests(result, timings);
    assert.equal(report.status, 'PARTIAL');
    assert.equal(report.attributedRequests, 1);
    assert.equal(report.unknownRequests, 2);
    assert.equal(report.missingTimingRequests, 1);
    assert.deepEqual(report.byStage.apply, { business: 1, document: 0, stop: 0, unknown: 1 });
  });
});

function checklistRun({ complete = false, checklistChange = 'task' } = {}) {
  const changeName = 'benchmark-change';
  const report = (description, done) => {
    const tasks = [{ id: '1', description, done: done[0] }, { id: '2', description: 'Run verification', done: done[1] }];
    const completed = done.filter(Boolean).length;
    return { changeName, planVerified: true, readyToApply: completed < 2, applyComplete: completed === 2,
      apply: { exitCode: 0, value: { changeName, tasks, progress: { total: 2, complete: completed, remaining: 2 - completed } } } };
  };
  const approved = report('Make requested change', [false, false]);
  const rewritten = report(checklistChange === 'task' ? 'Silently remove obligation' : 'Make requested change', [true, true]);
  const restored = report('Make requested change', [true, complete]);
  const turn = (stage, runId, startedAt, finishedAt, openSpec) => ({ stage, runId, finalRunId: runId, startedAt, finishedAt, settled: true,
    terminal: { source: 'agent.wait', runId, status: 'ok' }, openSpec });
  const proposal = turn('proposal', 'proposal', 100, 300, approved);
  const before = turn('codeing', 'apply-original', 400, 750, rewritten);
  const repair = { ...turn('codeing', 'apply-repair', 900, 2200, restored), checklistRepair: true };
  const manifest = { changeName, preparedHead: 'a'.repeat(40), deadline: 2500 };
  const checklist = openSpec => '## Work\n' + openSpec.apply.value.tasks.map(task => `- [${task.done ? 'x' : ' '}] ${task.description}\n`).join('');
  const rewrittenMarkdown = checklist(rewritten) + (checklistChange === 'note' ? '\n- Verification results: public checks passed.\n' : '');
  const checkpoint = (turn, stopReason, capturedAt, markdown) => ({ runId: turn.finalRunId, sessionId: 'main', stopReason,
    success: true, preparedHead: manifest.preparedHead, capturedAt: new Date(capturedAt).toISOString(), patchSha256: digest(stopReason),
    proposalRepairScope: { changeName, complete: true, tasksMdSha256: digest(markdown), taskTextSha256: openSpecTaskTextSha256(Buffer.from(markdown)),
      workflowFilesSha256: digest('same approved workflow'), policy: { status: 'CAPTURED', sha256: digest('same policy') } } });
  const checkpoints = [checkpoint(proposal, 'openspec_proposal_transport_after', 325, checklist(approved)),
    checkpoint(before, 'openspec_apply_checklist_before', 800, rewrittenMarkdown),
    checkpoint(repair, 'openspec_apply_checklist_after', 2250, checklist(restored))];
  const receipt = { reason: 'OPENSPEC_APPLY_CHECKLIST_CHANGED', changeName, sessionId: 'main',
    proposalRunId: proposal.finalRunId, beforeRunId: before.finalRunId, repairRunId: repair.runId,
    approvedChecklistSha256: checkpoints[0].proposalRepairScope.tasksMdSha256,
    observedChecklistSha256: checkpoints[1].proposalRepairScope.tasksMdSha256,
    beforeCheckpointSha256: checkpoints[1].patchSha256, afterCheckpointSha256: checkpoints[2].patchSha256,
    instructionSha256: digest('Restore approved checklist'), verified: true };
  const result = { ...fixture(4, [
    ...call('own-repair', repair.runId, 'main', 'key-main'),
    ...call('unrelated-business', before.runId, 'main', 'key-main'),
    ...call('stop', 'private-stop', 'stop', 'key-stop'),
  ], [{ runId: 'private-stop', sessionId: 'stop', status: 'SETTLED', role: 'stop-reviewer' }]),
    rcEnabled: true, nativeStopSettled: true, turns: [proposal, before, repair],
    openSpec: { proposal: approved, codeing: restored, applyChecklistPreserved: true, applyChecklistCorrection: receipt } };
  result.gateway.modelStarts = [{ runId: repair.runId, sessionId: 'main', sessionKey: 'key-main', seq: 1, ts: 1000 }];
  const timing = { phase: 'business-apply-checklist-repair' };
  const timings = [...wire(1, 'own-repair', timing), ...wire(2, 'unrelated-business', timing), ...wire(3, 'stop', timing)];
  return { result, timings, evidence: { manifest, checkpoints }, receipt };
}

test('reports a verified checklist restoration with one unchecked item and physical requests in that phase', () => {
  const { result, timings, evidence, receipt } = checklistRun();
  const report = attributeArktsProviderRequests(result, timings, evidence);
  assert.deepEqual(report.checklistRecovery, {
    request: 'RECORDED', dispatch: 'FORMED', start: 'OBSERVED', restoration: 'VERIFIED', applyCompletion: 'INCOMPLETE',
    sourceRunId: receipt.beforeRunId, repairRunId: receipt.repairRunId, instructionSha256: receipt.instructionSha256,
    requests: { business: 1, document: 0, stop: 1, unknown: 1, observed: 3, timingComplete: false },
  });
  assert.deepEqual(report.byStage.apply, { business: 2, document: 0, stop: 1, unknown: 0 });
  assert.equal(report.unknownRequests, 1);
  assert.equal(Object.hasOwn(report, 'score'), false);
  const full = checklistRun({ complete: true });
  assert.equal(attributeArktsProviderRequests(full.result, null, full.evidence).checklistRecovery.applyCompletion, 'COMPLETE');
});

test('keeps request, formed dispatch, start and workflow verification independently grounded', async t => {
  for (const [name, mutate, expected] of [
    ['receipt absent', ({ result }) => { delete result.openSpec.applyChecklistCorrection; }, ['UNVERIFIED', 'UNOBSERVED', 'UNOBSERVED']],
    ['duplicate before checkpoint', ({ evidence }) => { evidence.checkpoints.push(evidence.checkpoints[1]); }, ['UNVERIFIED', 'UNOBSERVED', 'UNOBSERVED']],
    ['wrong receipt session', ({ receipt }) => { receipt.sessionId = 'foreign'; }, ['UNVERIFIED', 'UNOBSERVED', 'UNOBSERVED']],
    ['stale changed checklist bytes', ({ evidence }) => { evidence.checkpoints[1].proposalRepairScope.tasksMdSha256 = digest('changed'); },
      ['UNVERIFIED', 'UNOBSERVED', 'UNOBSERVED']],
    ['unverified initial CLI result', ({ result }) => { result.turns[1].openSpec.planVerified = false; }, ['UNVERIFIED', 'UNOBSERVED', 'UNOBSERVED']],
    ['request recorded without a formed dispatch', ({ receipt, result }) => {
      Object.assign(receipt, { repairRunId: null, afterCheckpointSha256: null, verified: false });
      result.turns.pop();
    }, ['RECORDED', 'UNOBSERVED', 'UNOBSERVED']],
    ['foreign model start', ({ result }) => { result.gateway.modelStarts[0].sessionKey = 'foreign'; }, ['RECORDED', 'FORMED', 'UNOBSERVED']],
    ['start after the turn', ({ result }) => { result.gateway.modelStarts[0].ts = 2300; }, ['RECORDED', 'FORMED', 'UNOBSERVED']],
    ['changed workflow in after checkpoint', ({ evidence }) => { evidence.checkpoints[2].proposalRepairScope.workflowFilesSha256 = digest('different'); }, ['RECORDED', 'FORMED', 'OBSERVED']],
    ['missing verified proof', ({ receipt }) => { receipt.verified = false; }, ['RECORDED', 'FORMED', 'OBSERVED']],
    ['last Stop not settled', ({ result }) => { result.nativeStopSettled = false; }, ['RECORDED', 'FORMED', 'OBSERVED']],
  ]) await t.test(name, () => {
    const sample = checklistRun();
    mutate(sample);
    const { request, dispatch, start, restoration, applyCompletion } =
      attributeArktsProviderRequests(sample.result, sample.timings, sample.evidence).checklistRecovery;
    assert.deepEqual([request, dispatch, start], expected);
    assert.equal(restoration, 'UNVERIFIED');
    assert.equal(applyCompletion, 'UNVERIFIED');
  });
  assert.equal(Object.hasOwn(attributeArktsProviderRequests(fixture(0), []), 'checklistRecovery'), false);
});

test('attributes restored notes-only drift and withholds checkbox-only changes', () => {
  const notes = checklistRun({ complete: true, checklistChange: 'note' });
  const credited = attributeArktsProviderRequests(notes.result, notes.timings, notes.evidence).checklistRecovery;
  assert.deepEqual([credited.request, credited.start, credited.restoration, credited.applyCompletion],
    ['RECORDED', 'OBSERVED', 'VERIFIED', 'COMPLETE']);
  assert.equal(credited.requests.business, 1);

  const markers = checklistRun({ complete: true, checklistChange: 'markers' });
  assert.notEqual(markers.receipt.approvedChecklistSha256, markers.receipt.observedChecklistSha256);
  const withheld = attributeArktsProviderRequests(markers.result, markers.timings, markers.evidence).checklistRecovery;
  assert.deepEqual([withheld.request, withheld.dispatch, withheld.start, withheld.restoration],
    ['UNVERIFIED', 'UNOBSERVED', 'UNOBSERVED', 'UNVERIFIED']);
  assert.deepEqual(withheld.requests, { business: 0, document: 0, stop: 0, unknown: 3, observed: 3, timingComplete: false });
});
