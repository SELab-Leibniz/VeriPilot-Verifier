import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { digest } from '../scripts/bench/arkts-dataset.mjs';
import { openSpecTaskTextSha256 } from '../scripts/bench/business-checkpoint.mjs';
import { pinOpenSpecApplyChecklist, settleOpenSpecApplyChecklist } from '../scripts/bench/openspec-apply-checklist.mjs';
import { compareOpenSpecApplyProgress, installOriginalBasisPolicy, loadOriginalBasisWorkflow, openSpecApplyRecoveryPrompt, openSpecBusinessInput, openSpecProposalRepair,
  openSpecProposalScope, readOpenSpecCheckpoint, settleOpenSpecProposal, validateOpenSpecArgs, workflowMessages } from '../scripts/bench/original-basis-workflow.mjs';
import { nativeTranscriptObservation } from '../lib/openclaw/native-transcript.mjs';
import { transcriptUserMessages } from '../lib/runtime-v2/original-requirements.mjs';
import { parseSimpleYaml } from '../lib/simple-yaml.mjs';

const publishedLauncher = `#!/usr/bin/env node

import { runCli } from '../dist/cli/index.js';

runCli();
`;

async function policyFixture(t) {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-benchmark-policy-'));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  return { artifact: fileURLToPath(new URL('..', import.meta.url)), projectRoot, outputRoot: projectRoot };
}

test('allows the standard read-only listings without expanding mutation scope', () => {
  for (const args of [['list', '--specs'], ['list', '--specs', '--json'], ['list', '--changes']])
    assert.equal(validateOpenSpecArgs(args, 'demo'), true);
  for (const args of [['list', '--specs', '--all'], ['new', 'change', 'other'], ['archive', 'demo']])
    assert.equal(validateOpenSpecArgs(args, 'demo'), false);
});

test('strict Proposal enrollment preserves the actual product policy and enables its original-source review', async t => {
  const overrides = { value: { artifactCorrection: {
    originalRequirementsEnabled: false,
    requireOpenSpecProposalCoverage: true,
  } } };
  const evidence = await installOriginalBasisPolicy({ ...await policyFixture(t), overrides });
  assert.deepEqual(evidence.runtimeV2.artifactCorrection, {
    originalRequirementsEnabled: true, groundTruthReviewEnabled: false, stageMetricsEnabled: false,
    requireOpenSpecProposalCoverage: true,
  });
});

test('Plan Readiness enrollment retains its strict original-source implications', async t => {
  for (const strict of [undefined, false, true]) await t.test(String(strict), async t => {
    const overrides = { value: { artifactCorrection: {
      originalRequirementsEnabled: false,
      ...(strict === undefined ? {} : { requireOpenSpecProposalCoverage: strict }),
      requireOpenSpecPlanReadiness: true,
    } } };
    const evidence = await installOriginalBasisPolicy({ ...await policyFixture(t), overrides,
      reviewerModelRef: 'custom/deepseek-v4-pro' });
    assert.deepEqual(evidence.runtimeV2.artifactCorrection, {
      originalRequirementsEnabled: true, groundTruthReviewEnabled: false, stageMetricsEnabled: false,
      requireOpenSpecProposalCoverage: true, requireOpenSpecPlanReadiness: true,
    });
    assert.equal(evidence.runtimeV2.stopCorrection.originalRequirementsBasis, true);
    assert.equal(evidence.runtimeV2.stopCorrection.deviationOnly, true);
    for (const role of ['artifactReviewer', 'stopReviewer'])
      assert.equal(evidence.runtimeV2.reviewers[role].model, 'custom/deepseek-v4-pro');
  });
});

test('explicitly disabled Plan Readiness leaves legacy compiled enrollment unchanged', async t => {
  const overrides = { value: { artifactCorrection: {
    requireOpenSpecProposalCoverage: false, requireOpenSpecPlanReadiness: false,
  } } };
  const evidence = await installOriginalBasisPolicy({ ...await policyFixture(t), overrides });
  assert.deepEqual(evidence.runtimeV2.artifactCorrection, {
    originalRequirementsEnabled: true, groundTruthReviewEnabled: false, stageMetricsEnabled: false,
  });
});

test('keeps published policy bytes when the benchmark reviewer model stays on the default', async t => {
  for (const [label, reviewerModelRef] of [['implicit', undefined], ['explicit', 'custom/deepseek-v4-flash']]) await t.test(label, async t => {
    const fixture = await policyFixture(t);
    const template = await fs.readFile(path.join(fixture.artifact, '.runtime-corrector-default', 'config.yaml'), 'utf8');
    const expected = template.replace(/^enabled: false$/mu, 'enabled: true')
      .replace(/(^sessionDefaults:\r?\n(?:  #[^\r\n]*\r?\n)*)  enabled: false$/mu, '$1  enabled: true');
    const evidence = await installOriginalBasisPolicy({ ...fixture, reviewerModelRef });
    const configured = await fs.readFile(path.join(fixture.projectRoot, '.runtime-corrector', 'config.yaml'), 'utf8');
    assert.equal(configured, expected);
    assert.equal(evidence.configuredSha256, digest(expected));
    assert.deepEqual(evidence.overrides, { enabled: true, 'sessionDefaults.enabled': true });
    assert.equal(evidence.runtimeV2.reviewers.artifactReviewer.model, 'custom/deepseek-v4-flash');
    assert.equal(evidence.runtimeV2.reviewers.stopReviewer.model, 'custom/deepseek-v4-flash');
  });
});

test('installs an explicit Pro default consumed by both production reviewer roles', async t => {
  const fixture = await policyFixture(t), reviewerModelRef = 'custom/deepseek-v4-pro';
  const overrides = { value: { reviewers: { defaults: { model: 'custom/another-model', effort: 'medium' } } } };
  const evidence = await installOriginalBasisPolicy({ ...fixture, reviewerModelRef, overrides });
  const configured = await fs.readFile(path.join(fixture.projectRoot, '.runtime-corrector', 'config.yaml'), 'utf8');
  assert.equal(await fs.readFile(path.join(fixture.outputRoot, 'project-config.yaml'), 'utf8'), configured);
  const { reviewers } = parseSimpleYaml(configured);
  assert.deepEqual(Object.keys(reviewers), ['defaults']);
  assert.equal(reviewers.defaults.model, reviewerModelRef);
  assert.equal(evidence.overrides['reviewers.defaults.model'], reviewerModelRef);
  for (const role of ['artifactReviewer', 'stopReviewer']) {
    const reviewer = evidence.runtimeV2.reviewers[role];
    assert.equal(reviewer.model, reviewerModelRef);
    assert.equal(reviewer.effort, 'medium');
    assert.notEqual(reviewer.session, 'independent');
  }
});

test('rejects per-role model overrides and independent providers for the benchmark evaluator', async t => {
  const reviewerModelRef = 'custom/deepseek-v4-pro';
  for (const role of ['artifactReviewer', 'stopReviewer']) await t.test(role, async t => {
    const overrides = { value: { reviewers: { [role]: { model: 'custom/deepseek-v4-flash' } } } };
    await assert.rejects(installOriginalBasisPolicy({ ...await policyFixture(t), reviewerModelRef, overrides }),
      new RegExp(`Benchmark ${role} must use the requested reviewer model`, 'u'));
  });
  await t.test('independent provider', async t => {
    const overrides = { value: { reviewers: { stopReviewer: { session: 'independent',
      provider: { baseUrl: 'https://fixture.invalid', apiKeyEnv: 'FIXTURE_UNUSED_API_KEY', model: 'other-model' } } } } };
    await assert.rejects(installOriginalBasisPolicy({ ...await policyFixture(t), reviewerModelRef, overrides }),
      /Benchmark stopReviewer must use the selected OpenClaw provider model/u);
  });
});

const repairChange = 'benchmark-change';
const repairRun = { runId: 'proposal-run', terminal: { source: 'agent.wait', runId: 'proposal-run', status: 'ok' } };
const strictArgs = ['validate', repairChange, '--type', 'change', '--strict', '--json'];

test('Proposal cannot hand an implementation patch or checked tasks to Apply', () => {
  const unchanged = { businessPatchSha256: digest('') };
  const implementation = { businessPatchSha256: digest('diff --git a/entry/src/main/ets/services/LetterMetrics.ets') };
  const scope = (done, patch) => openSpecProposalScope({ apply: { exitCode: 0, value: { changeName: repairChange,
    progress: { total: done.length, complete: done.filter(Boolean).length, remaining: done.filter(value => !value).length },
    tasks: done.map(value => ({ done: value })) } } }, repairChange, patch);
  assert.deepEqual(scope([false, false], unchanged), { status: 'PASS', businessChanged: false,
    businessPatchSha256: unchanged.businessPatchSha256, completedTasks: 0 });
  assert.equal(scope([false, false], implementation).status, 'VIOLATED');
  for (const done of [[true, false], [true, true]]) {
    assert.equal(scope(done, unchanged).status, 'VIOLATED');
    assert.equal(scope(done, implementation).status, 'VIOLATED');
  }
  assert.equal(scope([false, false], null).status, 'UNVERIFIED');
  assert.equal(scope([false, 'unverified'], unchanged).status, 'UNVERIFIED');
});
const strictIssue = { level: 'ERROR', path: 'diagonal-puzzle-generation/spec.md',
  message: 'ADDED "Difficulty grading for diagonal puzzles" must contain SHALL or MUST' };
const invalidStrictReport = { id: repairChange, type: 'change', valid: false, issues: [strictIssue] };

test('transport recovery preserves the verified Apply checklist and completed work', () => {
  const checkpoint = (done, changeName = repairChange) => {
    const complete = done.filter(Boolean).length, applyComplete = complete === done.length;
    return { changeName, planVerified: true, applyComplete, readyToApply: !applyComplete,
      apply: { exitCode: 0, value: { changeName, tasks: done.map((value, index) => ({ id: String(index + 1), description: `Task ${index + 1}`, done: value })),
        progress: { total: done.length, complete, remaining: done.length - complete } } } };
  };
  const partial = checkpoint([true, false]);
  assert.equal(compareOpenSpecApplyProgress(partial, checkpoint([true, true]), repairChange), true);
  assert.equal(compareOpenSpecApplyProgress(partial, checkpoint([false, true]), repairChange), false);
  assert.equal(compareOpenSpecApplyProgress(partial, checkpoint([true, true], 'other'), repairChange), null);
  const changed = checkpoint([true, true]);
  changed.apply.value.tasks[0].description = 'Changed obligation';
  assert.equal(compareOpenSpecApplyProgress(partial, changed, repairChange), false);
  for (const mutate of [
    value => { value.planVerified = false; },
    value => { value.applyComplete = false; value.readyToApply = true; },
    value => { delete value.apply.value.tasks[0].description; },
    value => { value.apply.value.tasks[0].id = value.apply.value.tasks[1].id; },
    value => { value.apply.value.progress.complete--; },
  ]) {
    const edited = checkpoint([true, true]);
    mutate(edited);
    assert.equal(compareOpenSpecApplyProgress(partial, edited, repairChange), null);
  }
  const prompt = openSpecApplyRecoveryPrompt(repairChange);
  assert.match(prompt, /instructions.*apply.*benchmark-change/u);
  assert.deepEqual(transcriptUserMessages({ entries: [{ type: 'user', message: { content: prompt } }] }), []);
});

async function proposalPlanCheckpoint({ valid = false, descriptions = ['First obligation', 'Second obligation'] } = {}) {
  const status = { changeName: repairChange, isComplete: true,
    artifacts: ['proposal', 'specs', 'design', 'tasks'].map(id => ({ id, status: 'done' })) };
  const apply = { changeName: repairChange, state: 'ready', progress: { total: 2, complete: 0, remaining: 2 },
    tasks: descriptions.map((description, index) => ({ id: String(index + 1), description, done: false })) };
  return readOpenSpecCheckpoint({}, repairChange, { invoke: async (_options, args) => {
    if (args[0] === 'status') return { stdout: JSON.stringify(status) };
    if (args[0] === 'instructions') return { stdout: JSON.stringify(apply) };
    assert.deepEqual(args, strictArgs);
    if (valid) return { stdout: JSON.stringify({ items: [{ ...invalidStrictReport, valid: true, issues: [] }] }) };
    throw Object.assign(new Error('strict validation failed'), { code: 1, stdout: JSON.stringify({ items: [invalidStrictReport] }) });
  } });
}

test('offers a planning-only retry for concrete strict errors from the original proposal change', async () => {
  const checkpoint = await proposalPlanCheckpoint();
  assert.equal(checkpoint.readyToApply, false);
  const feedback = openSpecProposalRepair(checkpoint, repairChange, repairRun);
  const lines = feedback.split('\n');
  assert.equal(lines[0], '[runtime-corrector:internal]');
  assert.deepEqual(JSON.parse(lines[3]), [{ path: strictIssue.path, message: strictIssue.message }]);
  assert(feedback.includes('quoted validator data'));
  assert(feedback.includes('Preserve the original request, scope, and task checklist. Keep all task boxes unchecked.'));
  assert(feedback.includes(JSON.stringify({ args: strictArgs })));
  assert(feedback.includes('End the proposal after validation.'));
  assert.equal(validateOpenSpecArgs(strictArgs, repairChange), true);
  for (const argv of [[...strictArgs, '--all'], [...strictArgs.slice(0, 3), 'spec', ...strictArgs.slice(4)],
    ['validate', 'other-change', ...strictArgs.slice(2)], ['validate', repairChange, '--json', '--strict', '--type', 'change']])
    assert.equal(validateOpenSpecArgs(argv, repairChange), false);
});

test('skips retry when the same-change, completed-run or untouched-plan proof is missing', async () => {
  const valid = await proposalPlanCheckpoint();
  assert.equal(openSpecProposalRepair(valid, 'other-change', repairRun), null);
  for (const run of [{}, { ...repairRun, runId: 'different-run' },
    { ...repairRun, terminal: { ...repairRun.terminal, status: 'error' } },
    { ...repairRun, terminal: { ...repairRun.terminal, source: 'session.ended' } }])
    assert.equal(openSpecProposalRepair(valid, repairChange, run), null);
  for (const mutate of [
    value => { value.status.value.changeName = 'other-change'; },
    value => { value.status.value.artifacts.pop(); },
    value => { value.apply.value.changeName = 'other-change'; },
    value => { value.apply.value.tasks.pop(); },
    value => { value.apply.value.tasks[0].done = true; },
    value => { value.apply.value.progress = { total: 2, complete: 1, remaining: 1 }; },
    value => { value.validation.exitCode = 0; },
    value => { value.validation.exitCode = null; },
    value => { value.validation.value = null; },
    value => { value.validation.value.items.push({ ...invalidStrictReport, id: 'other-change' }); },
    value => { value.validation.value.items[0].id = 'other-change'; },
    value => { value.validation.value.items[0].type = 'spec'; },
    value => { value.validation.value.items[0].valid = true; },
    value => { value.validation.value.items[0].issues[0].level = 'WARNING'; },
    value => { value.validation.value.items[0].issues[0].path = ''; },
  ]) {
    const checkpoint = structuredClone(valid);
    mutate(checkpoint);
    assert.equal(openSpecProposalRepair(checkpoint, repairChange, repairRun), null);
  }
});

test('bounds and serializes validator paths and messages as diagnostic data', async () => {
  const checkpoint = await proposalPlanCheckpoint();
  const issues = checkpoint.validation.value.items[0].issues;
  issues.push(...Array.from({ length: 8 }, () => ({ level: 'ERROR', path: 'file\n' + 'p'.repeat(1000),
    message: '"heading"\u2028request\n' + 'q'.repeat(1000) })));
  const feedback = openSpecProposalRepair(checkpoint, repairChange, repairRun);
  const lines = feedback.split('\n'), diagnostics = JSON.parse(lines[3]);
  assert.equal(lines.length, 6);
  assert.equal(diagnostics.length, 5);
  assert(diagnostics.every(issue => issue.path.length <= 160 && issue.message.length <= 320));
  assert.match(lines[3], /\\"heading\\" request/u);
});

test('OpenSpec repairs and recovery use native internal provenance while ordinary stage messages remain user input', async () => {
  const identity = { sessionKey: 'agent:main:workflow', sessionId: 'workflow-session', runId: 'business-run' };
  const request = { sessionKey: identity.sessionKey, sessionId: identity.sessionId, idempotencyKey: identity.runId,
    deliver: false, thinking: 'off', timeoutMs: 0 };
  const initial = { id: 'original', message: { role: 'user', content: 'Implement the original requirement.' } };
  assert.deepEqual(openSpecBusinessInput({ ...identity, message: initial.message.content },
    { validationRepair: false, transportRecovery: false }), { ...request, message: initial.message.content });
  const original = nativeTranscriptObservation([initial]);
  const repair = openSpecProposalRepair(await proposalPlanCheckpoint(), repairChange, repairRun);
  for (const [message, mode] of [[repair, { validationRepair: true }],
    [openSpecApplyRecoveryPrompt(repairChange), { transportRecovery: true }],
    ['[runtime-corrector:internal]\nRestore the approved checklist.', { checklistRepair: true }]]) {
    const input = openSpecBusinessInput({ ...identity, message }, mode);
    assert.deepEqual(input, { ...request, message, suppressCommandInterpretation: true,
      systemInputProvenance: { kind: 'internal_system', originSessionId: identity.sessionId } });
    const record = { id: 'follow-up', message: { role: 'user', content: input.message } };
    assert.notEqual(nativeTranscriptObservation([initial, record]).externalUsersDigest, original.externalUsersDigest);
    record.message.provenance = input.systemInputProvenance;
    const observed = nativeTranscriptObservation([initial, record]);
    assert.equal(observed.externalUsersDigest, original.externalUsersDigest);
    assert.equal(observed.lastExternalUser.uuid, initial.id);
  }
});

const proposalTurn = (runId, openSpec) => ({ runId, finalRunId: runId, settled: true, openSpec,
  terminal: { source: 'agent.wait', runId, status: 'ok' } });

test('a verified Apply rewrite admits one scoped continuation and rechecks the original checklist', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-checklist-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const projectRoot = await fs.realpath(temporary);
  const file = path.join(projectRoot, 'openspec', 'changes', repairChange, 'tasks.md');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const approved = Buffer.from('## Work\n- [ ] First obligation\n- [ ] Second obligation\n');
  await fs.writeFile(file, approved);
  const proposal = proposalTurn('proposal', await proposalPlanCheckpoint({ valid: true }));
  const sessionId = 'session';
  const rewrite = Buffer.from('## Work\n- [x] Replaced first\n- [ ] Replaced second\n');
  const rewrittenCheckpoint = await proposalPlanCheckpoint({ valid: true, descriptions: ['Replaced first', 'Replaced second'] });
  rewrittenCheckpoint.apply.value.tasks[0].done = true;
  rewrittenCheckpoint.apply.value.progress = { total: 2, complete: 1, remaining: 1 };
  const workflowFilesSha256 = digest('approved workflow');
  const captureFor = (runId, bytes) => ({ runId, sessionId, patchSha256: digest(runId),
    proposalRepairScope: { complete: true, changeName: repairChange, workflowFilesSha256,
      policy: { status: 'CAPTURED', sha256: digest('policy') }, tasksMdSha256: digest(bytes), taskTextSha256: openSpecTaskTextSha256(bytes) } });
  const approval = await pinOpenSpecApplyChecklist({ projectRoot, changeName: repairChange, proposal,
    proposalCheckpoint: captureFor('proposal', approved) });
  assert(approval);
  const restored = Buffer.from(approved.toString().replaceAll('[ ]', '[x]'));
  const completedCheckpoint = structuredClone(proposal.openSpec);
  completedCheckpoint.apply.value.tasks.forEach(task => { task.done = true; });
  completedCheckpoint.apply.value.progress = { total: 2, complete: 2, remaining: 0 };
  completedCheckpoint.readyToApply = false;
  completedCheckpoint.applyComplete = true;
  const initial = proposalTurn('apply', rewrittenCheckpoint);
  const healthy = proposalTurn('apply', completedCheckpoint);
  const repaired = proposalTurn('apply-repair', completedCheckpoint);
  const noRetry = { changeName: repairChange, approval, async capture() { assert.fail('Unexpected capture'); },
    async retry() { assert.fail('Unexpected continuation'); } };
  await fs.writeFile(file, restored);
  assert.deepEqual(await settleOpenSpecApplyChecklist(healthy, noRetry), { apply: healthy, applyChecklistCorrection: null });
  assert.deepEqual(await settleOpenSpecApplyChecklist(initial, { ...noRetry, approval: null }), { apply: initial, applyChecklistCorrection: null });
  assert.deepEqual(await settleOpenSpecApplyChecklist(initial, { ...noRetry, canRetry: () => false }),
    { apply: initial, applyChecklistCorrection: null });

  let retryCount = 0;
  const captures = [];
  const options = { ...noRetry, async capture(turn, reason) {
    captures.push(reason);
    return captureFor(turn.finalRunId, await fs.readFile(file));
  }, async retry(instruction) {
    retryCount++;
    assert.equal(JSON.parse(instruction.split('\n')[3]), approved.toString());
    assert.deepEqual(await fs.readFile(file), rewrite);
    await fs.writeFile(file, restored);
    return repaired;
  } };
  await fs.writeFile(file, rewrite);
  const foreign = await settleOpenSpecApplyChecklist(initial, { ...noRetry,
    async capture() { return { ...captureFor('apply', rewrite), sessionId: 'another-session' }; } });
  assert.equal(foreign.applyChecklistCorrection, null);
  const stale = await settleOpenSpecApplyChecklist(initial, { ...noRetry, async capture() {
    const receipt = captureFor('apply', rewrite);
    await fs.writeFile(file, restored);
    return receipt;
  } });
  assert.equal(stale.applyChecklistCorrection, null);
  await fs.writeFile(file, rewrite);
  const result = await settleOpenSpecApplyChecklist(initial, options);
  assert.equal(result.apply, repaired);
  assert.equal(result.applyChecklistCorrection.verified, true);
  assert.equal(result.applyChecklistCorrection.repairRunId, repaired.runId);
  assert.equal(result.applyChecklistCorrection.observedChecklistSha256, digest(rewrite));
  assert.deepEqual(captures, ['openspec_apply_checklist_before', 'openspec_apply_checklist_after']);
  assert.equal(retryCount, 1);
  await fs.writeFile(file, rewrite);
  const rescope = await settleOpenSpecApplyChecklist(initial, { ...options, async capture(turn, reason) {
    const receipt = await options.capture(turn, reason);
    if (turn === repaired) receipt.proposalRepairScope.workflowFilesSha256 = digest('changed workflow');
    return receipt;
  } });
  assert.equal(rescope.applyChecklistCorrection.verified, false);
  assert.equal(retryCount, 2);

  await t.test('restores an added verification note outside the unchanged CLI checklist', async () => {
    const withNote = Buffer.concat([restored, Buffer.from('\n- Verification results: a separate public check passed.\n')]);
    await fs.writeFile(file, withNote);
    const captured = captureFor(healthy.runId, withNote);
    assert.notEqual(captured.proposalRepairScope.taskTextSha256, approval.scope.taskTextSha256);
    for (const scope of [
      { ...captured.proposalRepairScope, complete: false },
      { ...captured.proposalRepairScope, workflowFilesSha256: digest('changed design') },
      { ...captured.proposalRepairScope, taskTextSha256: approval.scope.taskTextSha256 },
    ]) {
      const withheld = await settleOpenSpecApplyChecklist(healthy, { ...noRetry,
        async capture() { return { ...captured, proposalRepairScope: scope }; } });
      assert.equal(withheld.applyChecklistCorrection, null);
    }
    let withinDeadline = true;
    const expired = await settleOpenSpecApplyChecklist(healthy, { ...noRetry, canRetry: () => withinDeadline,
      async capture() { withinDeadline = false; return captured; } });
    assert.equal(expired.applyChecklistCorrection, null);
    let restorations = 0;
    const recovered = await settleOpenSpecApplyChecklist(healthy, { ...noRetry, async capture(turn) {
      return captureFor(turn.finalRunId, await fs.readFile(file));
    }, async retry(instruction) {
      restorations++;
      assert.equal(JSON.parse(instruction.split('\n')[3]), approved.toString());
      await fs.writeFile(file, restored);
      return repaired;
    } });
    assert.equal(restorations, 1);
    assert.equal(recovered.apply, repaired);
    assert.equal(recovered.applyChecklistCorrection.verified, true);
    assert.equal(recovered.applyChecklistCorrection.observedChecklistSha256, digest(withNote));
  });
});

const unchangedProposalCapture = {
  businessPatchSha256: digest(''),
  proposalRepairScope: { changeName: repairChange, complete: true, tasksMdSha256: digest('original checklist bytes'),
    fixedEntriesSha256: digest('other files'), draftInventorySha256: digest('draft paths and modes'),
    policy: { status: 'CAPTURED', sha256: digest('original policy') } },
};

test('settles one Proposal repair and admits Apply only after strict validation with preserved scope', async t => {
  for (const [name, valid, changes, expected] of [
    ['valid scoped repair', true, {}, { ready: true, checklist: true, business: true, scope: true }],
    ['repair still fails strict validation', false, {}, { ready: false, checklist: true, business: true, scope: true }],
    ['rewrite a checklist item without checking it', true, { descriptions: ['Other obligation', 'Second obligation'] },
      { ready: false, checklist: false, business: true, scope: false }],
    ['mutate checklist bytes without changing the parsed items', true, { checklistBytes: 'changed checklist bytes' },
      { ready: false, checklist: true, business: true, scope: false }],
    ['edit the business patch', true, { businessPatch: 'changed app file' },
      { ready: false, checklist: true, business: false, scope: false }],
  ]) await t.test(name, async () => {
    const initial = proposalTurn('proposal-run', await proposalPlanCheckpoint());
    const repaired = proposalTurn('repair-run', await proposalPlanCheckpoint({ valid, descriptions: changes.descriptions }));
    const phases = [];
    const result = await settleOpenSpecProposal(initial, { changeName: repairChange,
      async capture(turn, reason) {
        phases.push([turn.runId, reason]);
        const receipt = { ...structuredClone(unchangedProposalCapture), runId: turn.runId };
        if (turn === repaired && (changes.checklistBytes || changes.descriptions))
          receipt.proposalRepairScope.tasksMdSha256 = digest(changes.checklistBytes ?? 'rewritten task');
        if (turn === repaired && changes.businessPatch) {
          receipt.businessPatchSha256 = digest(changes.businessPatch);
          receipt.proposalRepairScope.fixedEntriesSha256 = digest(changes.businessPatch);
        }
        return receipt;
      },
      async retry(prompt) {
        assert.deepEqual(JSON.parse(prompt.split('\n')[3]), [{ path: strictIssue.path, message: strictIssue.message }]);
        phases.push(['retry']);
        return repaired;
      } });
    assert.deepEqual(phases, [[initial.runId, 'openspec_proposal_boundary'], ['retry'],
      [repaired.runId, 'openspec_validation_repair_after']]);
    assert.equal(result.proposal, repaired);
    assert.deepEqual({ ready: result.readyToApply, checklist: result.proposalRepair.checklistUnchanged,
      business: result.proposalRepair.businessUnchanged, scope: result.proposalRepair.scopeUnchanged }, expected);
  });
});

test('a violated Proposal scope prevents both validation repair and Apply', async () => {
  const initial = proposalTurn('proposal-run', await proposalPlanCheckpoint());
  const result = await settleOpenSpecProposal(initial, { changeName: repairChange,
    async capture() { return { ...unchangedProposalCapture, businessPatchSha256: digest('premature implementation') }; },
    async retry() { assert.fail('a Proposal that changed business files is ineligible for repair'); } });
  assert.equal(result.proposalScope.status, 'VIOLATED');
  assert.equal(result.proposalRepair, null);
  assert.equal(result.readyToApply, false);
});

test('resumes an authenticated Proposal interruption once within its original draft', async t => {
  for (const [name, { valid = false, changedFile, changePlan = false, foreignRun = false, budget = true, attempted, ready }] of [
    ['repairs concrete validation errors', { attempted: 1, ready: true }],
    ['validates an already complete plan in place', { valid: true, attempted: 1, ready: true }],
    ['rejects amendments to an already valid draft', { valid: true, changePlan: true, attempted: 1, ready: false }],
    ['rejects edits outside the change before retrying', { changedFile: '.opencode/config.json', attempted: 0, ready: false }],
    ['rejects a transport proof from another run', { foreignRun: true, attempted: 0, ready: false }],
    ['uses the remaining deadline', { budget: false, attempted: 0, ready: false }],
  ]) await t.test(name, async () => {
    const runId = 'interrupted-proposal';
    const initial = { ...proposalTurn(runId, null), terminal: { source: 'agent.wait', runId, status: 'error' } };
    const resumed = proposalTurn('resumed-proposal', await proposalPlanCheckpoint({ valid: true }));
    const draftFile = `openspec/changes/${repairChange}/proposal.md`;
    const interruption = { failure: { runId: foreignRun ? 'foreign' : runId }, checkpoint: await proposalPlanCheckpoint({ valid }) };
    let calls = 0;
    const result = await settleOpenSpecProposal(initial, { changeName: repairChange, interruption, canRetry: () => budget,
      async capture(turn) {
        const receipt = { ...structuredClone(unchangedProposalCapture), runId: turn.runId, paths: [draftFile],
          patchSha256: digest(turn === resumed && changePlan ? 'edited draft' : 'retained draft') };
        if (turn === initial && changedFile) receipt.paths.push(changedFile);
        receipt.proposalRepairScope.draftFiles = [{ path: draftFile }];
        return receipt;
      },
      async retry(prompt, options) {
        calls++;
        assert.deepEqual(options, { transportInterrupted: true });
        assert.match(prompt, /model connection failed/u);
        assert.match(prompt, /Leave implementation and archiving for their own stages/u);
        return resumed;
      } });
    assert.equal(calls, attempted);
    assert.equal(result.readyToApply, ready);
    assert.equal(result.proposalRepair?.transportVerified ?? false, ready);
    assert.equal(result.proposal, attempted ? resumed : initial);
  });
});

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-original-workflow-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const host = path.join(dir, 'host');
  const root = path.join(dir, 'workflow');
  const openspecCli = path.join(dir, 'public-cli', 'bin', 'openspec.js');
  const flow = { displayName: 'OpenSpec(solo)', sessionInit: 'openspec init  --tools opencode  --force', stages: [
    { id: 'proposal', prompt: 'Plan {changeName}.' }, { id: 'design', prompt: '' }, { id: 'tasks', prompt: '' },
    { id: 'codeing', prompt: 'Apply {changeName}.' }, { id: 'archive', prompt: 'Archive.' },
  ] };
  const save = async (file, value) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, value);
  };
  const workflow = JSON.stringify(flow);
  const cliManifest = path.join(dir, 'public-cli', 'package.json');
  const pkg = { name: '@fission-ai/openspec', version: '1.4.1', bin: { openspec: './bin/openspec.js' } };
  await Promise.all([
    save(path.join(host, 'package.json'), '{}'),
    save(path.join(host, 'node_modules', 'yaml', 'index.js'), 'exports.parse = JSON.parse;'),
    save(path.join(root, 'workflow.yaml'), workflow),
    save(openspecCli, publishedLauncher),
    save(cliManifest, JSON.stringify(pkg)),
  ]);
  return { root, host, flow, openspecCli, cliManifest, pkg, save,
    pinned: { cliVersion: '1.4.1', pluginVersion: '2026.7.9', files: { workflow: digest(workflow) } } };
}

test('published OpenSpec uses the pinned workflow prompts and records its own provenance', async t => {
  const { root, host, flow, pinned, openspecCli, cliManifest, pkg } = await fixture(t);
  const loaded = await loadOriginalBasisWorkflow(root, host, pinned, { openspecCli });
  assert.deepEqual(loaded.flow, flow);
  assert.equal(loaded.plugin, null);
  assert.equal(loaded.cli, await fs.realpath(openspecCli));
  assert.deepEqual(loaded.identity, { mode: 'official-openspec', cliVersion: '1.4.1', files: {
    workflow: pinned.files.workflow, cli: digest(publishedLauncher), cliManifest: digest(JSON.stringify(pkg)),
  } });
  const messages = workflowMessages(loaded, '/project', 'demo', 'Original request.');
  assert.match(messages.proposal, /Plan demo\. Original request\.$/u);
  assert.match(messages.codeing, /Apply demo\.$/u);

  await fs.writeFile(cliManifest, JSON.stringify({ ...pkg, version: '1.4.2' }));
  await assert.rejects(loadOriginalBasisWorkflow(root, host, pinned, { openspecCli }), { code: 'ERR_ASSERTION' });
  await fs.writeFile(openspecCli, publishedLauncher + '\n');
  await assert.rejects(loadOriginalBasisWorkflow(root, host, pinned, { openspecCli }), /CLI entry differs/u);
  await fs.appendFile(path.join(root, 'workflow.yaml'), '\n');
  await assert.rejects(loadOriginalBasisWorkflow(root, host, pinned, { openspecCli }), /workflow differs/u);
});

test('the MatrixAssistant path still requires and retains every original pin', async t => {
  const { root, host, pinned, save } = await fixture(t);
  const pluginRoot = path.join(root, 'sdd-workflow-tool');
  for (const [key, relative, bytes] of [
    ['archive', 'fission-ai-openspec-1.4.1.tgz', 'archive'], ['install', 'installPkg.js', 'installer'],
    ['cli', 'cli/bin/openspec.js', 'entry'], ['pluginEntry', 'sdd-workflow-tool/dist/index.js', 'plugin entry'],
    ['pluginManifest', 'sdd-workflow-tool/openclaw.plugin.json', JSON.stringify({ id: 'sdd-workflow-tool', version: '2026.7.9' })],
  ]) {
    await save(path.join(root, relative), bytes);
    pinned.files[key] = digest(bytes);
  }
  const loaded = await loadOriginalBasisWorkflow(root, host, pinned);
  assert.deepEqual(loaded.plugin, { id: 'sdd-workflow-tool', path: pluginRoot, config: { workflows: [] } });
  assert.deepEqual(loaded.identity, { mode: 'matrixassistant', cliVersion: '1.4.1', files: pinned.files });
  await fs.appendFile(path.join(pluginRoot, 'dist/index.js'), '\n');
  await assert.rejects(loadOriginalBasisWorkflow(root, host, pinned), { code: 'ERR_ASSERTION' });
});
