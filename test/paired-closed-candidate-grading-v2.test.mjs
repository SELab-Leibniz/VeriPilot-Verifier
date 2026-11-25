import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { digest } from '../scripts/bench/arkts-dataset.mjs';
const entry = process.env.RC_PRIVATE_CAMPAIGN_ENTRY
  ? pathToFileURL(process.env.RC_PRIVATE_CAMPAIGN_ENTRY).href
  : new URL('../scripts/run-arkts-paired-campaign.mjs', import.meta.url).href;
const { runTrial, closedFrozenGradingV2: protocol, fullOpenSpecWorkflowV2, pairedLintToolFiles, capturePairedLintTools, recheckPairedLintTools, pairedCampaignComparison, createPairedPlan, verifyPairedPlan,
  executePairedCampaign, pairedTrialSchedule } = await import(entry);
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const hash = n => String(n).repeat(64);
const absentLintTools = { kind: 'PUBLIC_LINT_TOOL_FILES_V2', requestedRoot: '/literal/public-tools', canonicalRoot: null,
  files: Object.fromEntries(Object.entries(pairedLintToolFiles).map(([key, relative]) => [key, { relative, availability: 'MISSING', reason: 'ENOENT' }])), identityComplete: true };

async function trialFixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'closed-candidate-v2-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const trial = { id: 'synthetic-task', repetition: 1, arm: options.arm ?? 'off' };
  const publicBytes = Buffer.from('literal public fixture');
  await fs.mkdir(path.join(root, 'public'));
  await fs.writeFile(path.join(root, 'public', `${trial.id}.json`), publicBytes);
  const workflow = { id: 'synthetic-fixed-workflow', sha256: hash(4) };
  const patch = Buffer.from('literal frozen patch\n');
  const preparedHead = 'a'.repeat(40), preparedTree = 'b'.repeat(40);
  const frozen = { commit: 'c'.repeat(40), commitSha256: hash(1), sessionSha256: hash(2),
    patchSha256: digest(patch), workspacePatchSha256: hash(3), preparedHead, mutationPaths: ['source.txt'] };
  const manifest = { preparedHead, preparedTree, packageSha256: hash(5), sourceCommit: 'd'.repeat(40),
    reviewerModelRef: trial.arm === 'on' ? 'custom/pro-reviewer' : null,
    ...(options.result?.workflowProtocol ? { workflowProtocol: options.result.workflowProtocol } : {}),
    ...(options.lint ? { lintRequirement: { configSha256: hash(6) } } : {}) };
  const result = { state: 'finished', reason: 'APPLY_INCOMPLETE', businessNatural: false,
    frameworkError: false, turns: [{ settled: true }], nativeStopSettled: trial.arm === 'on' ? true : null,
    instance: { id: trial.id, datasetDigest: hash(7) }, preparedTree, rcEnabled: trial.arm === 'on',
    publicInputSha256: digest(publicBytes), providerIdentity: { endpointSha256: hash(8), modelRef: 'custom/fixture-model',
      ...(trial.arm === 'on' ? { reviewerModelRef: 'custom/pro-reviewer' } : {}) },
    gateway: { hostVersion: '2026.7.1-2' }, frozen, ...options.result,
    ...(options.lint ? { requiredChecks: { lint: { status: 'FAIL', success: false } } } : {}) };
  if (Object.hasOwn(options, 'manifestProtocol')) manifest.workflowProtocol = options.manifestProtocol;
  let businessCalls = 0, gradeCalls = 0;
  const args = { trial, input: { task: { base_commit: 'e'.repeat(40) }, datasetDigest: hash(7), publicBytes }, output: root,
    common: { model: 'fixture-model' }, workflowIdentity: workflow, modelProfile: { endpointSha256: hash(8) },
    release: { 'package-sha256': hash(5), 'source-commit': 'd'.repeat(40) }, reviewerOptions: { 'reviewer-model': 'pro-reviewer' },
    calibration: { sha256: hash(9), root: '/literal-private-calibration' }, calibrationOptions: {},
    toolchainSha256: hash(0), gradingExchange: '/literal-private-worker', gradeTotals: { f2p: 1, p2p: 1 },
    businessWallMs: 1000, campaignDeadline: Date.now() + 30_000, signal: new AbortController().signal,
    gradingProtocol: options.legacy ? undefined : protocol, workflowProtocol: options.fullWorkflow ? fullOpenSpecWorkflowV2 : undefined, lintToolIdentity: options.lintToolIdentity ?? absentLintTools };
  const deps = {
    async command(name, flags) {
      assert.equal(name, 'run-release-e2e.mjs'); businessCalls++;
      assert.equal(flags.includes('--complete-openspec-workflow'), options.fullWorkflow === true);
      const out = flags.find(value => value.startsWith('--output=')).slice('--output='.length);
      await fs.mkdir(path.join(out, 'freeze'), { recursive: true });
      await fs.writeFile(path.join(out, 'result.json'), json(result));
      await fs.writeFile(path.join(out, 'manifest.json'), json(manifest));
      await fs.writeFile(path.join(out, 'workflow-messages.json'), json({ workflow, workflowProtocol: Object.hasOwn(options, 'messageProtocol') ? options.messageProtocol : options.fullWorkflow ? fullOpenSpecWorkflowV2 : undefined }));
      await fs.writeFile(path.join(out, 'freeze', 'candidate.patch'), patch);
      await fs.writeFile(path.join(out, 'freeze', 'freeze.json'), json(options.freeze ?? frozen));
      return { exitCode: 0, interrupted: false, outputComplete: true, reason: 'closed', durationMs: 1, ...options.execution };
    },
    async submitGrade(_exchange, mode, transfer) {
      assert.equal(mode, 'grade'); gradeCalls++;
      return { input: transfer, execution: { exitCode: 0, interrupted: false, outputComplete: true, reason: 'closed' },
        score: { f2p: { passed: 1, total: 1 }, p2p: { passed: 1, total: 1 }, resolved: true },
        gradeSha256: hash(1), coverageSha256: hash(2) };
    },
    async readCorrection() { if (options.methodFailure) throw Error('literal method fixture failure'); return { status: 'RECORDED' }; },
  };
  return { args, deps, root, result, manifest, frozen, calls: () => ({ businessCalls, gradeCalls }) };
}

test('incomplete Apply with a valid closed frozen candidate receives an independent quality grade', async t => {
  const f = await trialFixture(t);
  const row = await runTrial(f.args, f.deps);
  assert.equal(row.businessCompleted, false);
  assert.equal(row.workflowOutcome.completed, false);
  assert.equal(row.workflowOutcome.archive.status, 'NOT_REQUESTED');
  assert.equal(row.gradingEligibility.status, 'ELIGIBLE');
  assert.equal(row.score.resolved, true);
  assert.deepEqual(f.calls(), { businessCalls: 1, gradeCalls: 1 });
});

test('legacy default retains the workflow-completion selector and does not retag its result', async t => {
  const f = await trialFixture(t, { legacy: true });
  const row = await runTrial(f.args, f.deps);
  assert.equal(row.score, null); assert.equal(row.gradingEligibility, undefined);
  assert.deepEqual(f.calls(), { businessCalls: 1, gradeCalls: 0 });
});

test('failed required lint does not remove valid frozen delivery quality', async t => {
  const f = await trialFixture(t, { lint: true });
  const row = await runTrial(f.args, f.deps);
  assert.equal(row.requiredChecks.lint, 'FAIL');
  assert.equal(row.score.resolved, true); assert.equal(f.calls().gradeCalls, 1);
  assert.deepEqual(row.comparisonIdentity.lintRequirement, f.manifest.lintRequirement);
  assert.deepEqual(row.comparisonIdentity.lintTools, absentLintTools);
  assert.equal(row.comparisonIdentity.comparable, true);
});

test('failed Archive remains a workflow result alongside the independent grade', async t => {
  const f = await trialFixture(t, { fullWorkflow: true, result: { workflowProtocol: { version: 2, id: 'openspec-full-lifecycle-v2' },
    implementationNatural: true, businessNaturalLegacy: true,
    openSpec: { archive: { complete: false, status: 'FAILED', reason: 'POSTCONDITION_UNMET' } } } });
  const row = await runTrial(f.args, f.deps);
  assert.equal(row.workflowOutcome.implementationCompleted, true);
  assert.equal(row.workflowOutcome.archive.complete, false);
  assert.equal(row.workflowOutcome.archive.reason, 'POSTCONDITION_UNMET');
  assert.equal(row.businessCompleted, false); assert.equal(row.score.resolved, true);
});

test('unsettled turns, native Stop and nonterminal commands cannot be graded', async t => {
  for (const options of [
    { result: { turns: [{ settled: false }] } },
    { arm: 'on', result: { nativeStopSettled: false } },
    { execution: { interrupted: true, reason: 'deadline' } },
    { execution: { outputComplete: false } },
    { result: { frozen: null } },
  ]) {
    const f = await trialFixture(t, options); const row = await runTrial(f.args, f.deps);
    assert.equal(row.score, null); assert.equal(row.gradingEligibility.status, 'INELIGIBLE');
    assert.equal(f.calls().gradeCalls, 0);
  }
});

test('identity or frozen-manifest mismatch cannot dispatch the grader', async t => {
  for (const options of [
    { result: { instance: { id: 'foreign', datasetDigest: hash(7) } } },
    { result: { rcEnabled: true } },
    { result: { publicInputSha256: hash(9) } },
    { freeze: { patchSha256: hash(9) } },
  ]) {
    const f = await trialFixture(t, options);
    await assert.rejects(runTrial(f.args, f.deps)); assert.equal(f.calls().gradeCalls, 0);
  }
});

test('a complete nonzero business-command exit can retain valid quality without rewriting completion', async t => {
  const f = await trialFixture(t, { execution: { exitCode: 1 } });
  const row = await runTrial(f.args, f.deps);
  assert.equal(row.execution.exitCode, 1); assert.equal(row.businessCompleted, false);
  assert.equal(row.score.resolved, true); assert.equal(f.calls().gradeCalls, 1);
});

test('missing correction-method evidence remains separate from code grading', async t => {
  const f = await trialFixture(t, { arm: 'on', methodFailure: true });
  const row = await runTrial(f.args, f.deps);
  assert.equal(row.correctionEvidenceUnavailable.status, 'UNAVAILABLE');
  assert.equal(row.score.resolved, true); assert.equal(f.calls().gradeCalls, 1);
});

async function planFixture(t, v2, repetitions = 1) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grading-v2-plan-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataset = path.join(root, 'dataset'); await fs.mkdir(dataset);
  const task = { instance_id: 'security_tool_1', repo: 'synthetic/fixture', base_commit: 'a'.repeat(40),
    problem_statement: 'Literal public fixture.', hints_text: '', patch: 'gold fixture', patch_sha256: digest('gold fixture'),
    test_patch: 'test fixture', test_patch_sha256: digest('test fixture'), FAIL_TO_PASS: ['entry::Fixture::required'], PASS_TO_PASS: ['entry::Fixture::regression'] };
  await fs.writeFile(path.join(dataset, task.instance_id + '.json'), JSON.stringify(task));
  const output = path.join(root, 'plan');
  const plan = await createPairedPlan(output, dataset, repetitions, undefined,
    { selectedCases: [task.instance_id], ...(v2 ? { gradingProtocol: protocol.id } : {}) });
  return { root, dataset, output, plan };
}

test('v2 is explicit in a new frozen plan and absent legacy plans remain unchanged', async t => {
  const old = await planFixture(t, false), fresh = await planFixture(t, true);
  assert.equal(old.plan.gradingProtocol, undefined);
  assert.deepEqual(fresh.plan.gradingProtocol, protocol);
  assert.deepEqual((await verifyPairedPlan(old.output, old.dataset)).plan, old.plan);
  assert.deepEqual((await verifyPairedPlan(fresh.output, fresh.dataset)).plan, fresh.plan);
  const changed = { ...fresh.plan, gradingProtocol: { ...protocol, lintPassRequired: true } };
  await fs.writeFile(path.join(fresh.output, 'plan.json'), json(changed));
  await assert.rejects(verifyPairedPlan(fresh.output, fresh.dataset), /Unknown or changed/);
});

test('every planned slot is visible and mismatched v2 execution identity is rejected before dispatch', async t => {
  const f = await planFixture(t, true);
  const identity = { planSha256: hash(3), gradingEvidenceVersion: 2, gradingProtocol: protocol,
    gradingProtocolSha256: digest(json(protocol)) };
  const report = await executePairedCampaign({ output: f.output, plan: f.plan, identity,
    deadline: 0, signal: new AbortController().signal, now: () => 1, recheck: async () => {},
    dispatch: async () => assert.fail('No pair window, no dispatch') });
  assert.equal(report.slotOutcomes.length, 2);
  assert(report.slotOutcomes.every(row => row.status === 'UNSTARTED'));
  assert.equal(report.legacy39CreditInherited, false);
  await assert.rejects(executePairedCampaign({ output: f.output, plan: f.plan,
    identity: { ...identity, gradingEvidenceVersion: 1 }, deadline: 0, resume: true,
    signal: new AbortController().signal, recheck: async () => {}, dispatch: async () => {} }), /own frozen execution identity/);
  await assert.rejects(executePairedCampaign({ output: f.output, plan: f.plan,
    identity: { ...identity, gradingProtocolSha256: hash(8) }, deadline: 0, resume: true,
    signal: new AbortController().signal, recheck: async () => {}, dispatch: async () => {} }), /protocol pin changed/);
});


test('v2 resumes settled graded incomplete workflows without converting them into completed work', async t => {
  const f = await planFixture(t, true, 2);
  const identity = { planSha256: hash(3), gradingEvidenceVersion: 2, gradingProtocol: protocol,
    gradingProtocolSha256: digest(json(protocol)) };
  const invoke = resume => executePairedCampaign({ output: f.output, plan: f.plan, identity,
    deadline: 10 ** 12, now: () => 1, maxPairs: 1, resume,
    signal: new AbortController().signal, recheck: async () => {}, dispatch: async slot => ({
      ...slot, business: 'finished', businessCompleted: false,
      execution: { exitCode: 0, interrupted: false, outputComplete: true },
      gradingEligibility: { protocolId: protocol.id, status: 'ELIGIBLE' },
      comparisonIdentity: { fixedPreTreatmentFixture: true, gradingProtocolSha256: digest(json(protocol)) },
      score: { resolved: true, f2p: { passed: 1, total: 1 }, p2p: { passed: 1, total: 1 } },
    }) });
  const first = await invoke(false); assert.equal(first.status, 'PAIR_LIMIT_REACHED');
  assert.equal(first.slotOutcomes.filter(row => row.status === 'GRADED').length, 2);
  assert.equal(first.slotOutcomes.filter(row => row.status === 'UNSTARTED').length, 2);
  const second = await invoke(true); assert.equal(second.status, 'COMPLETE');
  assert.equal(second.slotOutcomes.length, 4); assert(second.slotOutcomes.every(row => row.status === 'GRADED'));
  assert(second.observations.every(row => row.businessCompleted === false));
  assert.deepEqual(second.observations.slice(0, 2), first.observations);
  assert.equal(second.comparison.matchedScoredPairs, 2); assert.equal(second.legacy39CreditInherited, false);
});


test('Archive workflow opt-in is frozen independently of grading and cannot be inferred or changed at resume', async t => {
  const f = await planFixture(t, true);
  assert.equal(f.plan.workflowProtocol, undefined, 'Grading v2 alone must not enable Archive');
  const output = path.join(f.root, 'full-workflow-plan');
  const plan = await createPairedPlan(output, f.dataset, 1, undefined, {
    selectedCases: ['security_tool_1'], gradingProtocol: protocol.id, completeOpenSpecWorkflow: true,
  });
  assert.deepEqual(plan.workflowProtocol, fullOpenSpecWorkflowV2);
  assert.deepEqual((await verifyPairedPlan(output, f.dataset)).plan, plan);
  const identity = { planSha256: hash(3), gradingEvidenceVersion: 2, gradingProtocol: protocol,
    gradingProtocolSha256: digest(json(protocol)) };
  await assert.rejects(executePairedCampaign({ output, plan, identity, deadline: 0,
    signal: new AbortController().signal, recheck: async () => {}, dispatch: async () => {} }), /workflow differs from the frozen plan/);
  const unexpected = await trialFixture(t, { result: { workflowProtocol: fullOpenSpecWorkflowV2 } });
  await assert.rejects(runTrial(unexpected.args, unexpected.deps), /workflow protocol differs/);
  assert.equal(unexpected.calls().gradeCalls, 0);
});


test('foreign grading protocol rows cannot enter v2 quality observations or resume history', async t => {
  for (const badId of [true, false]) {
    const f = await planFixture(t, true);
    const identity = { planSha256: hash(3), gradingEvidenceVersion: 2, gradingProtocol: protocol,
      gradingProtocolSha256: digest(json(protocol)) };
    await assert.rejects(executePairedCampaign({ output: f.output, plan: f.plan, identity,
      deadline: 10 ** 12, now: () => 1, signal: new AbortController().signal, recheck: async () => {},
      dispatch: async slot => ({ ...slot, business: 'finished', businessCompleted: false,
        execution: { exitCode: 0, interrupted: false, outputComplete: true },
        gradingEligibility: { protocolId: badId ? 'foreign-protocol' : protocol.id, status: 'ELIGIBLE' },
        comparisonIdentity: { gradingProtocolSha256: badId ? digest(json(protocol)) : hash(8) },
        score: { resolved: true, f2p: { passed: 1, total: 1 }, p2p: { passed: 1, total: 1 } },
      }) }), /grading protocol/);
    const saved = JSON.parse(await fs.readFile(path.join(f.output, 'summary.json'), 'utf8'));
    assert.equal(saved.comparison.matchedScoredPairs, 0);
    assert(saved.observations.every(row => row.score === null));
    assert.equal(saved.slotOutcomes[0].status, 'ATTEMPTED_UNGRADED');
    assert.equal(saved.slotOutcomes[1].status, 'UNSTARTED');
  }
});


test('legacy grading with an explicitly frozen full workflow validates every workflow marker', async t => {
  for (const mismatch of [
    { result: { businessNatural: true } },
    { result: { businessNatural: true, workflowProtocol: fullOpenSpecWorkflowV2 }, manifestProtocol: undefined },
    { result: { businessNatural: true, workflowProtocol: fullOpenSpecWorkflowV2 }, messageProtocol: undefined },
  ]) {
    const f = await trialFixture(t, { legacy: true, fullWorkflow: true, ...mismatch });
    await assert.rejects(runTrial(f.args, f.deps), /workflow (?:protocol|manifest|messages)/);
    assert.equal(f.calls().gradeCalls, 0);
  }
  const valid = await trialFixture(t, { legacy: true, fullWorkflow: true,
    result: { businessNatural: true, workflowProtocol: fullOpenSpecWorkflowV2 } });
  const row = await runTrial(valid.args, valid.deps);
  assert.equal(valid.calls().gradeCalls, 1); assert.equal(row.score.resolved, true);
  assert.deepEqual(row.comparisonIdentity.workflowProtocol, fullOpenSpecWorkflowV2);
  assert.equal(row.comparisonIdentity.gradingProtocolSha256, undefined);
});


test('public lint file identity is captured without running tools and detects drift independently of lint outcome', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'public-lint-pin-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const relative of Object.values(pairedLintToolFiles)) {
    const file = path.join(root, 'codelinter', relative);
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, 'literal public vendor bytes:' + relative);
  }
  const original = await capturePairedLintTools(root);
  assert.equal(original.identityComplete, true);
  assert(Object.values(original.files).every(row => row.availability === 'PRESENT' && /^[a-f0-9]{64}$/.test(row.sha256)));
  await recheckPairedLintTools(root, original);
  await fs.appendFile(path.join(root, 'codelinter', pairedLintToolFiles.hpauditorBinarySha256), 'changed');
  await assert.rejects(recheckPairedLintTools(root, original), /changed after campaign preflight/);
  const changed = await capturePairedLintTools(root);
  assert.notEqual(changed.files.hpauditorBinarySha256.sha256, original.files.hpauditorBinarySha256.sha256);
});

test('stable missing lint files remain explicit without blocking individual code grades', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'missing-lint-pin-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const missing = await capturePairedLintTools(root);
  assert.equal(missing.identityComplete, true);
  assert(Object.values(missing.files).every(row => row.availability === 'MISSING'));
  await recheckPairedLintTools(root, missing);
  const f = await trialFixture(t, { lint: true, lintToolIdentity: missing });
  const row = await runTrial(f.args, f.deps); assert.equal(row.score.resolved, true);
  assert.equal(row.comparisonIdentity.comparable, true);
});

test('unavailable public lint identities keep individual grades and protocol pins but cannot produce matched quality credit', async t => {
  let reads = 0;
  const unavailable = await capturePairedLintTools('/literal/unavailable-public-tools', {
    async realpath() { throw Object.assign(new Error('fixture'), { code: 'EACCES' }); },
    async readFile() { reads++; assert.fail('Unavailable source must not be read'); },
  });
  assert.equal(reads, 0); assert.equal(unavailable.identityComplete, false);
  assert(Object.values(unavailable.files).every(row => row.availability === 'UNAVAILABLE'));
  const f = await trialFixture(t, { lint: true, lintToolIdentity: unavailable });
  const row = await runTrial(f.args, f.deps);
  assert.equal(row.score.resolved, true); assert.equal(f.calls().gradeCalls, 1);
  assert.equal(row.comparisonIdentity.comparable, false);
  assert.equal(row.comparisonIdentity.nonComparableReason, 'PUBLIC_LINT_TOOL_IDENTITY_UNAVAILABLE');
  assert.equal(row.comparisonIdentity.gradingProtocolSha256, digest(json(protocol)));
  const schedule = pairedTrialSchedule(['synthetic-task'], 1);
  const result = pairedCampaignComparison(schedule, schedule.map(slot => ({ ...row, ...slot })));
  assert.equal(result.matchedScoredPairs, 0);
  assert.equal(result.scoredIdentityMismatches, 1);
});


test('requested full workflow with incomplete legacy business still checks frozen markers and exposes unobserved active scope', async t => {
  const closed = await trialFixture(t, { legacy: true, fullWorkflow: true });
  await assert.rejects(runTrial(closed.args, closed.deps), /workflow protocol differs/);
  assert.equal(closed.calls().gradeCalls, 0);
  const active = await trialFixture(t, { legacy: true, fullWorkflow: true,
    result: { frozen: null, turns: [{ settled: false }] } });
  const row = await runTrial(active.args, active.deps);
  assert.equal(row.score, null); assert.equal(active.calls().gradeCalls, 0);
  assert.equal(row.workflowOutcome.protocol, null);
  assert.equal(row.workflowOutcome.requestedProtocol, fullOpenSpecWorkflowV2.id);
  assert.equal(row.workflowOutcome.protocolMarkerStatus, 'MISSING');
  assert.equal(row.workflowOutcome.archive.status, 'NOT_OBSERVED');
});
