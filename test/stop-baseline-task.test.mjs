import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { createOpenClawReviewerFactory } from '../lib/openclaw/reviewer.mjs';
import { assertBaselineProposalJson, materializeBaselineProposal, validateBaselineProposalArguments,
  baselineProposalToolSchema } from '../lib/review-task/task-evidence.mjs';

test('owned corrections keep numeric array indices distinct from string object keys', () => {
  const parent = { report: { sources: [{ reason: 'Original reason', issues: ['old'] }] }, untouched: { '0': 'object key' } };
  const result = materializeBaselineProposal(parent, [{ op: 'set', path: ['report', 'sources', 0, 'issues'], value: [] }]);
  assert.deepEqual(result, { report: { sources: [{ reason: 'Original reason', issues: [] }] }, untouched: { '0': 'object key' } });
  assert.deepEqual(parent.report.sources[0].issues, ['old']);
  assert.throws(() => materializeBaselineProposal(parent, [{ op: 'set', path: ['report', 'sources', '0', 'issues'], value: [] }]), /coerce/u);
  assert.throws(() => materializeBaselineProposal(parent, [{ op: 'set', path: ['untouched', 0], value: 'changed' }]));
  assert.deepEqual(materializeBaselineProposal(parent, [{ op: 'set', path: ['untouched', '0'], value: 'changed' }]).untouched, { '0': 'changed' });
  const wire = baselineProposalToolSchema({ type: 'object', properties: {} });
  const correct = wire.anyOf.find(branch => branch.properties?.action?.enum?.includes('correct_and_submit'));
  assert.deepEqual(correct.properties.changes.items.anyOf[0].properties.path.items.type, ['string', 'integer']);
});

test('owned JSON rejects dangerous own keys and accessors before examining their values', () => {
  let reads = 0;
  const accessor = Object.defineProperty({}, 'value', { enumerable: true, get() { reads++; return 'unreachable'; } });
  assert.throws(() => assertBaselineProposalJson(accessor), /accessors/u);
  assert.equal(reads, 0);
  for (const value of [JSON.parse('{"safe":{"constructor":{}}}'), { value: undefined }, { value: Infinity }, [,'hole']])
    assert.throws(() => assertBaselineProposalJson(value));
  const parent = { report: { sources: [] } };
  assert.throws(() => materializeBaselineProposal(parent, [{ op: 'set', path: ['report'], value: {} },
    { op: 'set', path: ['report', 'sources'], value: [] }]), /Overlapping/u);
  assert.throws(() => materializeBaselineProposal(parent, [{ op: 'set', path: ['missing', 'issues'], value: [] }]), /intermediate/u);
  assert.throws(() => materializeBaselineProposal(parent, [{ op: 'remove', path: ['report', 'sources', 0] }]));
});

test('owned full validator rejects conversion without adopting returned or mutated values', () => {
  const args = { report: { count: '1' } }; let calls = 0;
  const capability = { identity: { identityScope: 'explicit-unit-double-not-host-qualification' }, validateToolArguments(_tool, call) {
    calls++; call.arguments.report.count = 1; return call.arguments;
  } };
  assert.throws(() => validateBaselineProposalArguments(capability, 'finish_baseline_audit', {}, args), /coercion/u);
  assert.equal(calls, 1); assert.deepEqual(args, { report: { count: '1' } });
  assert.throws(() => validateBaselineProposalArguments(null, 'finish_baseline_audit', {}, args), /unavailable/u);
});
import { registerTaskTools, TASK_TOOL_NAMES, BASELINE_TOOL_NAMES } from '../lib/openclaw/task-tools.mjs';
import { GROUND_TRUTH_REVIEW_SCHEMA } from '../lib/runtime-v2/reviewer.mjs';
import { ensureTask, taskDirectory, withTaskState, withTaskDecision, decisionGuard } from '../lib/runtime-v2/task-store.mjs';
import { loadCurrentGroundTruth, applyGroundTruthDelta as applyProductionGroundTruthDelta } from '../lib/runtime-v2/ground-truth-ledger.mjs';
import { runNativeCoverageFixture, auditBaselineFixture, scriptedSourceInventory } from './helpers/baseline-coverage-native.mjs';
import { atomicWriteJson, readJson, sha256 } from '../lib/runtime-v2/utils.mjs';
import { toolText } from '../lib/review-task/source-tools.mjs';
import { FileTransactionJournal } from '../lib/runtime-v2/transaction-journal.mjs';
import { refreshRuntimeRequirements } from '../lib/runtime-v2/orchestrator.mjs';
import { compileRuntimeV2Config } from '../lib/runtime-v2/config.mjs';
import { observeInternalTool } from '../lib/openclaw/internal-context.mjs';
import { REVIEWER_NATIVE_TOOL_DENY } from '../lib/reviewer-tools.mjs';
import { BASELINE_EXTRACTION_PROTOCOL, createBaselineWorker } from '../lib/review-task/baseline-task.mjs';
import { buildMetricPopulation } from '../lib/runtime-v2/metrics.mjs';
import { reviewProofOwners } from '../lib/runtime-v2/review-result-validation.mjs';
import { validateJsonSchema } from '../lib/json-schema-validator.mjs';
import { validateSourceBindings } from '../lib/openclaw/sources.mjs';
const auditFixtures = new Map();
async function applyGroundTruthDelta(options) {
  const commit = options.baselineCommit, fixture = commit && auditFixtures.get(commit.requestId ?? commit.id);
  if (fixture && !commit.coverageAudit && sha256(options.delta) === sha256(fixture.handle.result)) {
    await fixture.audit(); Object.assign(commit, fixture.handle.baselineTask);
  }
  return applyProductionGroundTruthDelta(options);
}

const operation = (ref = 'transcript:U1#L1-L1') => ({ operation: 'ADD', category: 'requirements',
  text: 'Preserve the requested feature.', authority: 'USER_EXPLICIT', severity: 'HARD',
  applicabilityKind: 'CURRENT_TASK', verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION',
  source: { ref, kind: 'USER_MESSAGE', subject: 'MAIN_TASK' } });

// Decoded original live004 response-3/6 save_baseline_batch arguments. Keep
// owner defaults unchanged in these red controls; repaired inputs are separate.
const closedOwnerBatches = {
  user: { batchId: 1, defaults: { applicabilityKind: 'CURRENT_TASK', authority: 'USER_EXPLICIT', category: 'requirements', severity: 'HARD', verificationTarget: 'IMPLEMENTATION' },
    operations: [
      { expectedFiles: ['app.mjs'], implementationRole: 'PRODUCTION', sourceFrom: { unitId: 'S0L1' }, text: 'Create app.mjs, a stateless numeric validation module.' },
      { implementationRole: 'PRODUCTION', sourceFrom: { unitId: 'S0L1' }, text: 'Create a short usage guide for the stateless numeric validation module (no exact output path specified).' },
      { category: 'workflowSteps', sourceFrom: { unitId: 'S0L1' }, text: 'Follow the selected delivery-verifier Skill in this workspace while delivering this task.', verificationTarget: 'PROCESS' },
    ] },
  material: { batchId: 1, defaults: { applicabilityKind: 'CURRENT_TASK', authority: 'MATERIAL_DERIVED', category: 'requirements', severity: 'HARD', verificationTarget: 'IMPLEMENTATION' },
    exclude: [
      { reason: 'Unadopted MATERIAL context: demo.py example explicitly labeled demonstration only, not a required business action.', units: ['S1L1', 'S1L2'] },
      { reason: 'Unadopted MATERIAL context: descriptive SKILL.md heading and overview/permission statements create no delivery duty.', units: ['S2L1', 'S2L3', 'S2L5'] },
    ], operations: [
      { expectedFiles: ['app.mjs'], implementationRole: 'PRODUCTION', sourceFrom: { unitId: 'S2L7' }, text: 'Per the selected delivery-verifier Skill: create app.mjs and a short usage guide.' },
      { applicability: 'when publishing', applicabilityKind: 'CONDITIONAL', category: 'workflowSteps', sourceFrom: { unitId: 'S2L9' }, text: 'Per the selected delivery-verifier Skill: cancel orphan tasks before publishing.', verificationTarget: 'PROCESS' },
    ] },
};

// Decoded live005 response-7 arguments: keep its actual CURRENT_TASK default
// intact in red controls. A separately constructed positive changes metadata.
const closedScopeBatch = { batchId: 1,
  defaults: { applicabilityKind: 'CURRENT_TASK', authority: 'MATERIAL_DERIVED', category: 'requirements', severity: 'HARD' },
  exclude: [
    { reason: 'Example file explicitly labeled demonstration only; not a required business action, unadopted material context.', units: ['S1L1', 'S1L2'] },
    { reason: 'Descriptive section label in the Skill document; not an obligation.', units: ['S2L1'] },
    { reason: "Descriptive statement about the skill's purpose; context, not an obligation.", units: ['S2L3'] },
    { reason: "Permission ('may inspect examples if useful'); optional allowance, not an obligation.", units: ['S2L5'] },
    { reason: 'Skill instruction duplicating the already-preserved USER_EXPLICIT obligations to create app.mjs and a short usage guide; adds no new claim.', units: ['S2L7'] },
  ], operations: [{ applicability: 'Applies when publishing: cancel orphan tasks before publishing.', category: 'constraints',
    sourceFrom: { unitId: 'S2L9' }, text: 'Cancel orphan tasks before publishing.', verificationTarget: 'PROCESS' }] };

for (const wireMode of ['draft', 'full']) test(`closed response7 sourceFrom cannot inherit applicabilityKind in ${wireMode}`, async t => {
  const f = await closedOwnerFixture(t, wireMode, 'material'), value = structuredClone(closedScopeBatch);
  if (wireMode === 'full') { delete value.exclude; value.operations[0].operation = 'ADD'; }
  const before = structuredClone(value);
  await assert.rejects(f.run(async ({ call, readAll }) => {
    await readAll();
    await assert.rejects(call('save_baseline_batch', value), error => {
      assert.match(error.message, /sourceFrom.*applicabilityKind/u);
      assert(error.baselineValidation.issues.some(issue => issue.pointer === '/defaults/applicabilityKind'));
      assert(error.baselineValidation.issues.some(issue => issue.pointer === '/operations/0/applicabilityKind'));
      return true;
    });
    assert.deepEqual(value, before);
    const state = JSON.parse(toolText(await call('review_history', { mode: 'state' }))).taskState;
    assert.equal(state.batches.length, 0); assert.equal(state.nextBatchId, 1); assert.equal(state.repairs, 1);
    throw Object.assign(new Error('Scope rejection inspected'), { code: 'CONTROLLED_SCOPE_CHECK_COMPLETE' });
  }), { code: 'CONTROLLED_SCOPE_CHECK_COMPLETE' });
  assert.equal((await loadCurrentGroundTruth(f.root, f.task.taskId)).version, 0);
});

async function scopeChoiceFixture(t, wireMode) {
  const f = await closedOwnerFixture(t, wireMode, 'user');
  f.input.evidence.snapshot.entries[0].message.content = 'Create the requested module. Cancel orphan tasks before publishing.';
  const value = { batchId: 1, defaults: { category: 'requirements', authority: 'USER_EXPLICIT', severity: 'HARD' }, operations: [
    { text: 'Create the requested module.', applicabilityKind: 'CURRENT_TASK', verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION', sourceFrom: { unitId: 'S0L1' } },
    { text: 'Cancel orphan tasks before publishing.', applicability: 'when publishing', applicabilityKind: 'CONDITIONAL', verificationTarget: 'PROCESS', sourceFrom: { unitId: 'S0L1' } },
  ] };
  if (wireMode === 'full') for (const item of value.operations) item.operation = 'ADD';
  return { ...f, value };
}

for (const wireMode of ['draft', 'full']) for (const invalid of ['missing-kind', 'inherited-kind', 'default-with-explicit', 'null-kind', 'invalid-kind']) {
  test(`sourceFrom applicability ${invalid} rejects before save and repairs without rereading in ${wireMode}`, async t => {
    const f = await scopeChoiceFixture(t, wireMode), invalidValue = structuredClone(f.value);
    if (invalid === 'missing-kind') delete invalidValue.operations[1].applicabilityKind;
    if (invalid === 'inherited-kind') { invalidValue.defaults.applicabilityKind = 'CURRENT_TASK'; delete invalidValue.operations[1].applicabilityKind; }
    if (invalid === 'default-with-explicit') invalidValue.defaults.applicabilityKind = 'CURRENT_TASK';
    if (invalid === 'null-kind') invalidValue.operations[1].applicabilityKind = null;
    if (invalid === 'invalid-kind') invalidValue.operations[1].applicabilityKind = 'WHEN_PUBLISHING';
    const before = structuredClone(invalidValue);
    const handle = await f.run(async ({ call, readAll, finish, params, ctx }) => {
      const saveTool = f.registry()(ctx()).find(tool => tool.name === 'save_baseline_batch');
      const shape = /sourceFrom operation required keys \(format only\): \{text, sourceFrom:\{unitId\}, applicabilityKind, verificationTarget\}/u;
      assert.match(saveTool.description, shape); assert.match(params.extraSystemPrompt, shape);
      assert.match(saveTool.description, /Choose applicabilityKind and verificationTarget on EACH raw operation/u);
      assert.match(saveTool.description, /IMPLEMENTATION also requires its own implementationRole; PROCESS\/ARTIFACT omit it/u);
      assert.match(saveTool.description, /Defaults omit all three fields/u);
      const operationSchema = saveTool.parameters.properties.operations.items;
      assert.equal(saveTool.parameters.anyOf.find(branch => branch.properties?.operations).additionalProperties, false);
      assert.deepEqual(operationSchema.properties.sourceFrom.required, ['unitId']);
      assert.deepEqual(operationSchema.properties.applicabilityKind.enum, GROUND_TRUTH_REVIEW_SCHEMA.properties.operations.items.properties.applicabilityKind.enum);
      if (wireMode === 'draft') assert(operationSchema.required.includes('applicabilityKind') && operationSchema.required.includes('verificationTarget'));
      await readAll();
      const first = JSON.parse(toolText(await call('review_history', { mode: 'state' }))).taskState;
      await assert.rejects(call('save_baseline_batch', invalidValue), /sourceFrom.*applicabilityKind/u);
      assert.deepEqual(invalidValue, before);
      const state = JSON.parse(toolText(await call('review_history', { mode: 'state' }))).taskState;
      assert.equal(state.repairs, 1); assert.equal(state.batches.length, 0); assert.equal(state.nextBatchId, 1);
      assert.equal(state.deadlineAt, first.deadlineAt);
      const saved = toolText(await call('save_baseline_batch', f.value));
      assert.equal(toolText(await call('save_baseline_batch', f.value)), saved);
      const repaired = JSON.parse(toolText(await call('review_history', { mode: 'state' }))).taskState;
      assert.equal(repaired.metrics.readBytes, first.metrics.readBytes, 'metadata repair preserves actual original read receipts');
      await finish([1]);
    });
    assert.deepEqual(handle.result.operations.map(item => item.applicabilityKind), ['CURRENT_TASK', 'CONDITIONAL']);
    assert.deepEqual(handle.result.operations.map(item => item.verificationTarget), ['IMPLEMENTATION', 'PROCESS']);
    assert(handle.result.operations.every(item => item.source.excerpt === f.input.evidence.snapshot.entries[0].message.content));
    await handle.close();
  });
}

test('explicit sourceFrom CURRENT_TASK can still be semantically wrong for a conditional original', async t => {
  const f = await scopeChoiceFixture(t, 'draft');
  f.value.operations[1].applicabilityKind = 'CURRENT_TASK';
  const before = structuredClone(f.value);
  const handle = await f.run(async ({ call, readAll, finish }) => { await readAll(); await call('save_baseline_batch', f.value); await finish([1]); });
  assert.deepEqual(f.value, before);
  assert.equal(handle.result.operations[1].applicabilityKind, 'CURRENT_TASK', 'the tool does not infer CONDITIONAL from publishing/before/when');
  assert.equal(handle.result.operations[1].applicability, 'when publishing');
  assert.equal(handle.result.operations[1].text, 'Cancel orphan tasks before publishing.');
  await handle.close();
});

test('legacy-only draft defaults still require applicabilityKind even when an override supplies it', async t => {
  const f = await closedOwnerFixture(t, 'draft', 'user');
  f.input.evidence.snapshot.entries[0].message.content = 'Create the requested module.';
  const value = { batchId: 1, defaults: { category: 'requirements', authority: 'USER_EXPLICIT', severity: 'HARD',
    verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION' }, keep: ['S0L1'],
    overrides: [{ unit: 'S0L1', metadata: { applicabilityKind: 'CURRENT_TASK' } }] };
  const handle = await f.run(async ({ call, readAll, finish }) => {
    await readAll(); await assert.rejects(call('save_baseline_batch', value), /defaults\/applicabilityKind|draft defaults require applicabilityKind/u);
    await call('save_baseline_batch', { ...value, defaults: { ...value.defaults, applicabilityKind: 'CURRENT_TASK' } }); await finish([1]);
  });
  assert.equal(handle.result.operations[0].applicabilityKind, 'CURRENT_TASK'); await handle.close();
});

test('draft sourceFrom can share a neutral-default batch with a fully specified legacy keep', async t => {
  const f = await closedOwnerFixture(t, 'draft', 'user');
  f.input.evidence.snapshot.entries[0].message.content = 'Create the requested module.\nCancel orphan tasks before publishing.';
  const value = { batchId: 1, defaults: { category: 'requirements', authority: 'USER_EXPLICIT', severity: 'HARD' },
    keep: ['S0L1'], overrides: [{ unit: 'S0L1', metadata: { verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION', applicabilityKind: 'CURRENT_TASK' } }],
    operations: [{ text: 'Cancel orphan tasks before publishing.', applicability: 'when publishing', applicabilityKind: 'CONDITIONAL', verificationTarget: 'PROCESS', sourceFrom: { unitId: 'S0L2' } }] };
  const handle = await f.run(async ({ call, readAll, finish }) => { await readAll(); await call('save_baseline_batch', value); await finish([1]); });
  assert.deepEqual(handle.result.operations.map(item => item.applicabilityKind), ['CURRENT_TASK', 'CONDITIONAL']);
  assert.deepEqual(handle.result.operations.map(item => item.verificationTarget), ['IMPLEMENTATION', 'PROCESS']);
  await handle.close();
});

test('sourceFrom scope revision uses the actual claim and preserves owner, qualifiers and historical receipt', async t => {
  const f = await closedOwnerFixture(t, 'full', 'user');
  f.input.evidence.snapshot.entries[0].message.content = 'Cancel orphan tasks before publishing.';
  const operation = { operation: 'ADD', category: 'requirements', authority: 'USER_EXPLICIT', severity: 'HARD',
    text: 'Cancel orphan tasks before publishing.', applicability: 'when publishing', applicabilityKind: 'CURRENT_TASK',
    verificationTarget: 'PROCESS', sourceFrom: { unitId: 'S0L1' } };
  const run = item => f.run(async ({ call, readAll, finish }) => { await readAll(); await call('save_baseline_batch', { batchId: 1, operations: [item] }); await finish([1]); });
  const publish = handle => applyGroundTruthDelta({ projectRoot: f.root, taskId: f.task.taskId, delta: handle.result,
    sourceCatalog: f.input.request.sourceCatalog, baselineCommit: { ...handle.baselineTask, id: handle.baselineTask.requestId, scope: 'stop', cursorDigest: 'same-original' } });
  const first = await run(operation); await publish(first); await first.close();
  const historyPath = path.join(taskDirectory(f.root, f.task.taskId), 'ground-truth/baseline-applied', `${sha256(first.baselineTask.requestId)}.json`);
  const history = await fs.readFile(historyPath), truth = await loadCurrentGroundTruth(f.root, f.task.taskId), old = truth.claims[0];
  f.input.evidence.groundTruth = truth;
  f.input.request.currentGroundTruth = { path: f.truthPath, version: truth.version, digest: truth.digest };
  const second = await run({ ...operation, operation: 'SUPERSEDE', claimId: old.claimId, applicabilityKind: 'CONDITIONAL' });
  await publish(second); await second.close();
  const current = await loadCurrentGroundTruth(f.root, f.task.taskId), revised = current.claims[0];
  assert.equal(revised.claimId, old.claimId); assert.equal(revised.applicabilityKind, 'CONDITIONAL');
  assert.equal(revised.revision, old.revision + 1); assert.equal(revised.supersedesRevisionId, old.revisionId);
  for (const key of ['text', 'applicability', 'verificationTarget', 'authority', 'source']) assert.deepEqual(revised[key], old[key]);
  assert.notEqual(sha256(revised), sha256(old)); assert.notEqual(current.digest, truth.digest);
  assert.deepEqual(await fs.readFile(historyPath), history);
});

async function closedOwnerFixture(t, wireMode, kind, extra = {}) {
  const f = await fixture(t, { wireMode, businessRoot: true, materialRelativePath: 'skills/delivery-verifier/examples/demo.py',
    materialText: '# Demonstration only; not a required business action.\nraise RuntimeError("example only")\n', ...extra });
  f.input.evidence.snapshot.entries[0].message.content = 'Create app.mjs and a short usage guide for a stateless numeric validation module. Follow the selected delivery-verifier Skill in this workspace.';
  if (kind === 'user') f.input.request.sourceCatalog.splice(1);
  else {
    const skill = path.join(f.root, 'skills/delivery-verifier/SKILL.md');
    await fs.writeFile(skill, '# Workflow\n\nThis skill helps maintain a numeric validator.\n\nYou may inspect examples if useful.\n\nCreate app.mjs and a short usage guide.\n\nCancel orphan tasks before publishing.\n');
    f.input.request.sourceCatalog.push({ ref: skill, kind: 'MATERIAL' });
  }
  return f;
}

for (const wireMode of ['draft', 'full']) for (const kind of ['user', 'material']) {
  test(`closed ${kind} sourceFrom owner defaults cannot substitute raw operation choices in ${wireMode}`, async t => {
    const f = await closedOwnerFixture(t, wireMode, kind), value = structuredClone(closedOwnerBatches[kind]);
    // Full mode additionally requires an explicit operation. All original
    // defaults/text/sourceFrom/semantic fields remain unchanged in both modes.
    if (wireMode === 'full') {
      for (const item of value.operations) item.operation = 'ADD';
      // Full has no draft exclude field. This wire adaptation changes none of
      // the actual original owner defaults/operations/sourceFrom decisions.
      delete value.exclude;
    }
    const before = structuredClone(value);
    await assert.rejects(f.run(async ({ call, readAll }) => {
      await readAll();
      await assert.rejects(call('save_baseline_batch', value), error => {
        assert.match(error.message, /sourceFrom.*owner|owner.*sourceFrom/u);
        assert(error.baselineValidation.issues.some(issue => issue.pointer === '/defaults/verificationTarget'));
        assert(error.baselineValidation.issues.some(issue => issue.pointer === '/operations/0/verificationTarget'));
        return true;
      });
      assert.deepEqual(value, before, 'the tool must not normalize owner fields');
      const state = JSON.parse(toolText(await call('review_history', { mode: 'state' }))).taskState;
      assert.equal(state.batches.length, 0); assert.equal(state.nextBatchId, 1); assert.equal(state.repairs, 1);
      // End this negative-only fixture without inventing a completed baseline.
      throw Object.assign(new Error('Owner rejection inspected'), { code: 'CONTROLLED_OWNER_CHECK_COMPLETE' });
    }), { code: 'CONTROLLED_OWNER_CHECK_COMPLETE' });
    assert.equal((await loadCurrentGroundTruth(f.root, f.task.taskId)).version, 0);
  });
}

function explicitOwnerBatch() {
  const value = structuredClone(closedOwnerBatches.user);
  delete value.defaults.verificationTarget;
  delete value.defaults.applicabilityKind;
  for (const item of value.operations) item.applicabilityKind = 'CURRENT_TASK';
  value.operations[0].verificationTarget = 'IMPLEMENTATION';
  value.operations[1].verificationTarget = 'ARTIFACT'; delete value.operations[1].implementationRole;
  return value;
}

for (const wireMode of ['draft', 'full']) for (const invalid of ['missing-target', 'missing-role', 'shared-target', 'shared-role', 'process-role', 'artifact-role']) {
  test(`sourceFrom raw owner ${invalid} rejects once without partial save or lost receipts in ${wireMode}`, async t => {
    const f = await closedOwnerFixture(t, wireMode, 'user'), valid = explicitOwnerBatch();
    if (wireMode === 'full') for (const item of valid.operations) item.operation = 'ADD';
    const value = structuredClone(valid);
    if (invalid === 'missing-target') delete value.operations[1].verificationTarget;
    if (invalid === 'missing-role') delete value.operations[0].implementationRole;
    if (invalid === 'shared-target') value.defaults.verificationTarget = 'IMPLEMENTATION';
    if (invalid === 'shared-role') { value.defaults.implementationRole = 'PRODUCTION'; delete value.operations[0].implementationRole; }
    if (invalid === 'process-role') value.operations[2].implementationRole = 'PRODUCTION';
    if (invalid === 'artifact-role') value.operations[1].implementationRole = 'PRODUCTION';
    const before = structuredClone(value);
    const handle = await f.run(async ({ call, readAll, finish }) => {
      await readAll();
      const stateBefore = JSON.parse(toolText(await call('review_history', { mode: 'state' }))).taskState;
      await assert.rejects(call('save_baseline_batch', value), /sourceFrom/u);
      assert.deepEqual(value, before);
      const state = JSON.parse(toolText(await call('review_history', { mode: 'state' }))).taskState;
      assert.equal(state.repairs, 1); assert.equal(state.batchCount, 0); assert.equal(state.nextBatchId, 1);
      assert.equal(state.deadlineAt, stateBefore.deadlineAt);
      const receipt = toolText(await call('save_baseline_batch', valid));
      assert.equal(toolText(await call('save_baseline_batch', valid)), receipt);
      await finish([1]);
    });
    assert.deepEqual(handle.result.operations.map(item => item.verificationTarget), ['IMPLEMENTATION', 'ARTIFACT', 'PROCESS']);
    assert.equal(handle.result.operations[1].expectedFiles, undefined, 'a document without a specified filename is still ARTIFACT');
    assert.equal(f.captures.length, 1); await handle.close();
  });
}

test('explicit sourceFrom owner selection does not pretend to validate its natural-language correctness', async t => {
  const f = await closedOwnerFixture(t, 'draft', 'user'), value = explicitOwnerBatch();
  value.operations[1].verificationTarget = 'IMPLEMENTATION'; value.operations[1].implementationRole = 'PRODUCTION';
  const before = structuredClone(value);
  const handle = await f.run(async ({ call, readAll, finish }) => {
    await readAll(); await call('save_baseline_batch', value); await finish([1]);
  });
  assert.deepEqual(value, before);
  assert.equal(handle.result.operations[1].verificationTarget, 'IMPLEMENTATION', 'explicitly wrong guide owner remains possible; no keyword or filename classifier changes it');
  assert.equal(handle.result.operations[1].implementationRole, 'PRODUCTION');
  assert.equal(handle.result.operations[1].expectedFiles, undefined);
  await handle.close();
});

for (const target of ['ARTIFACT', 'PROCESS']) test(`sourceFrom explicit owner permits a guarded IMPLEMENTATION to ${target} revision without stale role`, async t => {
  // This intentionally wrong first source-only judgement simulates historical
  // model error for a ledger-mechanics test. Its first PASS is a KNOWN SEMANTIC
  // ERROR, never evidence of semantic acceptance. The later audit is correct.
  const f = await closedOwnerFixture(t, 'full', 'user', { ownerTransitionTarget: target });
  const text = target === 'ARTIFACT' ? 'Write a short usage guide.' : 'Actually run the declared verification.';
  f.input.evidence.snapshot.entries[0].message.content = text;
  const initial = { ...operation(), text, sourceFrom: { unitId: 'S0L1' } }; delete initial.source;
  const run = value => f.run(async ({ call, readAll, finish }) => { await readAll(); await call('save_baseline_batch', value); await finish([1]); });
  const publish = handle => applyGroundTruthDelta({ projectRoot: f.root, taskId: f.task.taskId, delta: handle.result,
    sourceCatalog: f.input.request.sourceCatalog, baselineCommit: { ...handle.baselineTask, id: handle.baselineTask.requestId, scope: 'stop', cursorDigest: 'same-original' } });
  const first = await run({ batchId: 1, operations: [initial] }); await publish(first); await first.close();
  const historicalReceipt = path.join(taskDirectory(f.root, f.task.taskId), 'ground-truth/baseline-applied', `${sha256(first.baselineTask.requestId)}.json`);
  const historyBefore = await fs.readFile(historicalReceipt);
  const truth = await loadCurrentGroundTruth(f.root, f.task.taskId), old = truth.claims[0];
  assert.equal(old.verificationTarget, 'IMPLEMENTATION');
  f.input.evidence.groundTruth = truth;
  f.input.request.currentGroundTruth = { path: f.truthPath, version: truth.version, digest: truth.digest };
  const revision = { ...initial, operation: 'SUPERSEDE', claimId: old.claimId, verificationTarget: target }; delete revision.implementationRole;
  const second = await run({ batchId: 1, operations: [revision] }); await publish(second); await second.close();
  const revised = (await loadCurrentGroundTruth(f.root, f.task.taskId)).claims.find(claim => claim.claimId === old.claimId);
  assert.equal(revised.verificationTarget, target); assert.equal(revised.implementationRole, undefined);
  assert.equal(revised.revision, old.revision + 1);
  assert.equal(revised.supersedesRevisionId, old.revisionId);
  assert.deepEqual(revised.source, old.source); assert.equal(revised.text, old.text); assert.equal(revised.authority, old.authority);
  assert.deepEqual(await fs.readFile(historicalReceipt), historyBefore, 'actual prior accepted revision is not rewritten');
  const current = await loadCurrentGroundTruth(f.root, f.task.taskId);
  f.input.evidence.groundTruth = current;
  f.input.request.currentGroundTruth = { path: f.truthPath, version: current.version, digest: current.digest };
  await assert.rejects(f.run(async ({ call, readAll }) => {
    await readAll();
    await assert.rejects(call('save_baseline_batch', { batchId: 1, operations: [{ ...revision, verificationTarget: 'IMPLEMENTATION' }] }), /sourceFrom.*implementationRole/u);
    throw Object.assign(new Error('Missing new implementation role rejected'), { code: 'CONTROLLED_OWNER_CHECK_COMPLETE' });
  }), { code: 'CONTROLLED_OWNER_CHECK_COMPLETE' });
  assert.equal((await loadCurrentGroundTruth(f.root, f.task.taskId)).digest, current.digest);
});

for (const owner of [undefined, 'IMPLEMENTATION']) test(`legacy ${owner ?? 'unspecified'} owner revision preserves its existing implementation role`, async t => {
  const f = await fixture(t), initial = { ...operation(), implementationRole: 'TEST' };
  if (owner === undefined) delete initial.verificationTarget;
  const apply = operations => applyGroundTruthDelta({ projectRoot: f.root, taskId: f.task.taskId,
    delta: { operations }, sourceCatalog: f.input.request.sourceCatalog });
  await apply([initial]);
  const old = (await loadCurrentGroundTruth(f.root, f.task.taskId)).claims[0];
  const update = { ...initial, operation: 'SUPERSEDE', claimId: old.claimId };
  delete update.verificationTarget; delete update.implementationRole;
  await apply([update]);
  const current = (await loadCurrentGroundTruth(f.root, f.task.taskId)).claims[0];
  assert.equal(current.claimId, old.claimId); assert.equal(current.verificationTarget, owner);
  assert.equal(current.implementationRole, 'TEST'); assert.equal(current.revision, old.revision + 1);
  assert.equal(current.supersedesRevisionId, old.revisionId);
});

test('one draft synthesis batch separates mixed owners while the program binds one exact original source', async t => {
  const f = await fixture(t, { wireMode: 'draft' });
  const original = 'Create app.mjs and a short usage guide. Follow the selected Skill.';
  f.input.evidence.snapshot.entries[0].message.content = original;
  const value = { batchId: 1, defaults: { category: 'requirements', authority: 'USER_EXPLICIT', severity: 'HARD' },
    operations: [{ text: 'Create app.mjs.', applicabilityKind: 'CURRENT_TASK', verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION', expectedFiles: ['app.mjs'], sourceFrom: { unitId: 'S0L1' } },
      { text: 'Write a short usage guide.', applicabilityKind: 'CURRENT_TASK', verificationTarget: 'ARTIFACT', sourceFrom: { unitId: 'S0L1' } },
      { text: 'Follow the selected Skill.', applicabilityKind: 'CURRENT_TASK', verificationTarget: 'PROCESS', sourceFrom: { unitId: 'S0L1' } }],
    exclude: [{ units: ['S1L1'], reason: 'Unadopted material context.' }] };
  const handle = await f.run(async ({ call, readAll, finish }) => {
    await readAll();
    const receipt = JSON.parse(toolText(await call('save_baseline_batch', value)));
    assert.equal(receipt.operationCount, 3); assert.equal(receipt.pendingUnitCount, 0);
    assert.deepEqual(receipt.pendingUnits, []);
    await finish([1]);
  });
  assert.equal(f.captures.length, 1, 'No dedicated fullTextReason/native-session switch is needed');
  assert.deepEqual(handle.result.operations.map(op => op.verificationTarget), ['IMPLEMENTATION', 'ARTIFACT', 'PROCESS']);
  assert.deepEqual(handle.result.operations.map(op => op.source.excerpt), [original, original, original]);
  assert(handle.result.operations.every(op => op.source.ref === 'transcript:U1#L1-L1' && !Object.hasOwn(op, 'sourceFrom')));
  const batch = await readJson(path.join(path.dirname(handle.requestDirectory), 'candidates-0/batch-1.json'));
  assert.deepEqual(batch.decisions.find(row => row.units.includes('S0L1')).operationIndices, [0, 1, 2]);
  await handle.close();
});

test('sourceFrom cannot mix encodings, invent units, claim unread originals or change the actual proof owner', async t => {
  const f = await fixture(t, { wireMode: 'draft' });
  const value = { batchId: 1, operations: [{ ...operation(), sourceFrom: { unitId: 'S0L1' } }],
    exclude: [{ units: ['S1L1'], reason: 'Descriptive context.' }] };
  delete value.operations[0].source;
  const handle = await f.run(async ({ call, readAll, finish }) => {
    await assert.rejects(call('save_baseline_batch', value), /original-source binding|disclosed/u);
    await readAll();
    await assert.rejects(call('save_baseline_batch', { ...value, operations: [{ ...value.operations[0], sourceFrom: { unitId: 'S99L1' } }] }), /Unknown source unit/u);
    await assert.rejects(call('save_baseline_batch', { ...value, operations: [{ ...value.operations[0], source: operation().source }] }), /source/u);
    await assert.rejects(call('save_baseline_batch', { ...value, operations: [{ ...value.operations[0], verificationTarget: 'PROCESS' }] }), /omit implementationRole/u);
    const state = JSON.parse(toolText(await call('review_history', { mode: 'state' }))).taskState;
    assert.equal(state.batchCount, 0); assert.equal(state.repairs, 4); assert.equal(state.maxRepairs, 4);
    await call('save_baseline_batch', value); await finish([1]);
  });
  assert.equal(handle.result.operations[0].verificationTarget, 'IMPLEMENTATION'); await handle.close();
});

test('span batches copy exact originals, share explicit metadata and preserve ordinary ledger publication', async t => {
  const f = await fixture(t);
  const original = '创建订单时品种和数量必填，备注可空。\n数量必须为正整数，字段非法时拒绝创建且不得预留库存。';
  f.input.evidence.snapshot.entries[0].message.content = original;
  const handle = await f.run(async ({ call, readAll, finish, seen }) => {
    await readAll();
    assert.equal(JSON.parse(toolText(await call('review_history', { mode: 'state' }))).taskState.phase, 'EXTRACTING');
    const value = { batchId: 1, defaults: { operation: 'ADD', category: 'requirements', authority: 'USER_EXPLICIT', severity: 'HARD', applicabilityKind: 'CURRENT_TASK', verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION' },
      operations: [{ outcome: '订单创建与字段校验', textFrom: { sourceIndex: 0, start: 1, end: 2 }, text: original }],
      bindings: [{ operationIndex: 0, citeIds: [...seen].filter(([file]) => file.startsWith('source-0000')).flatMap(([, ids]) => ids) }] };
    const first = toolText(await call('save_baseline_batch', value));
    assert.equal(toolText(await call('save_baseline_batch', value)), first);
    await finish([1]);
  });
  assert.equal(handle.result.operations[0].text, original);
  assert.equal(handle.result.operations[0].source.ref, 'transcript:U1#L1-L2');
  await applyGroundTruthDelta({ projectRoot: f.root, taskId: f.task.taskId, delta: handle.result,
    sourceCatalog: f.input.request.sourceCatalog, baselineCommit: { ...handle.baselineTask, id: handle.baselineTask.requestId, scope: 'stop', cursorDigest: 'selected-source' } });
  assert.equal((await loadCurrentGroundTruth(f.root, f.task.taskId)).claims[0].text, original);
  await handle.close();
});

test('span shortcuts cannot bypass current reads, promote material authority, or override captured text', async t => {
  const f = await fixture(t);
  const handle = await f.run(async ({ call, readAll, finish }) => {
    const value = { batchId: 1, defaults: { operation: 'ADD', category: 'requirements', authority: 'USER_EXPLICIT', severity: 'HARD', applicabilityKind: 'CURRENT_TASK', verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION' },
      operations: [{ outcome: 'Preserve the requested feature', textFrom: { sourceIndex: 0, start: 1, end: 1 } }] };
    await assert.rejects(call('save_baseline_batch', value), { code: 'BASELINE_SOURCE_INVALID' });
    await readAll();
    await assert.rejects(call('save_baseline_batch', { ...value, operations: [{ ...value.operations[0], text: 'invented' }] }), { code: 'BASELINE_SOURCE_INVALID' });
    await assert.rejects(call('save_baseline_batch', { ...value, operations: [{ outcome: 'Material requirement', textFrom: { sourceIndex: 1, start: 1, end: 1 } }] }), /SOURCE_BINDING_INVALID|NON_USER_AUTHORITY/);
    await call('save_baseline_batch', value); await finish([1]);
  });
  assert.equal(handle.result.operations[0].text, 'Preserve the requested feature.'); await handle.close();
});

test('split sources capture exact original lines and retain the full-text fallback', async t => {
  const f = await fixture(t, { large: true });
  const handle = await f.run(async ({ call, readAll, finish, batch }) => {
    await readAll();
    await call('save_baseline_batch', { batchId: 1, defaults: { operation: 'ADD', category: 'requirements', authority: 'MATERIAL_DERIVED', severity: 'HARD', applicabilityKind: 'CURRENT_TASK', verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION' },
      operations: [{ outcome: 'Material requirement', textFrom: { sourceIndex: 1, start: 201, end: 202 } }] });
    await call('save_baseline_batch', { ...batch(), batchId: 2 }); await finish([1, 2]);
  });
  const expected = (await fs.readFile(f.material, 'utf8')).split('\n').slice(200, 202).join('\n');
  assert.equal(handle.result.operations.length, 2);
  assert.equal(handle.result.operations[0].text, expected);
  assert.equal(handle.result.operations[0].source.ref, `${f.material.replaceAll('\\', '/')}#L201-L202`);
  await handle.close();
});

test('UTF-8 split-line selections require every genuine part receipt and retain source authority', async t => {
  const selected = '条件：不得改写源文，例外须保留。'.repeat(400) + '\r';
  const materialText = '# Context\r\n' + 'x'.repeat(16280) + '\r\n' + selected + '\n尾行';
  const f = await fixture(t, { materialText });
  f.input.reviewer.formatRepairAttempts = 5;
  const handle = await f.run(async ({ call, readAll, finish, params }) => {
    const prompt = JSON.parse(params.prompt);
    assert(prompt.selectableSourceIndices.includes(1));
    const request = await call('source_read', { path: 'request-0000.txt' });
    assert.match(toolText(request), /"startLine":3,"endLine":4/u, 'part coordinates must reach the real required-read response');
    const value = { batchId: 1, defaults: { operation: 'ADD', category: 'requirements', authority: 'MATERIAL_DERIVED', severity: 'HARD', applicabilityKind: 'CURRENT_TASK', verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION' },
      operations: [{ outcome: '保留条件与例外', textFrom: { sourceIndex: 1, start: 3, end: 3 } }] };
    const files = prompt.requiredFiles.filter(file => file.startsWith('source-0001'));
    assert.equal(files.length, 3);
    await call('source_read', { path: files[0] });
    await assert.rejects(call('save_baseline_batch', value), /not fully disclosed/);
    await call('source_read', { path: files[1] }, { persist: false });
    await assert.rejects(call('save_baseline_batch', value), /not fully disclosed/);
    await readAll();
    await assert.rejects(call('save_baseline_batch', { ...value, operations: [{ outcome: '不完整原始行', textFrom: { file: files[1], start: 1, end: 1 } }] }), /partial original line/u);
    await assert.rejects(call('save_baseline_batch', { ...value, defaults: { ...value.defaults, authority: 'USER_EXPLICIT' } }), /SOURCE_BINDING_INVALID|NON_USER_AUTHORITY/);
    await assert.rejects(call('save_baseline_batch', { ...value, operations: [{ ...value.operations[0], text: '替换原文' }] }), /captured original/);
    await call('save_baseline_batch', value); await finish([1]);
  });
  assert.equal(handle.result.operations[0].text, selected);
  const request = await readJson(path.join(handle.requestDirectory, 'request.json'));
  const source = request.identity.sources.find(item => item.kind === 'MATERIAL');
  assert.equal(source.lineCount, 4);
  assert.deepEqual(source.parts.map(({ startLine, endLine }) => [startLine, endLine]), [[1, 2], [3, 2], [3, 4]]);
  await handle.close();
});

test('frozen part-local selectors capture canonical originals without rereads or authority promotion', async t => {
  const f = await fixture(t, { large: true });
  let expected;
  const handle = await f.run(async ({ call, readAll, finish, params }) => {
    await readAll();
    const request = JSON.parse(await fs.readFile(path.join(params.cwd, 'request-0000.txt'), 'utf8'));
    assert.equal(request.sourceNavigation.navigationOnly, true);
    const source = request.sourceNavigation.sources.find(item => item.sourceIndex === 1), part = source.parts[1];
    const start = part.startLine + 1;
    expected = (await fs.readFile(f.material, 'utf8')).split('\n').slice(start - 1, start + 1).join('\n');
    const value = { batchId: 1, defaults: { operation: 'ADD', category: 'requirements', authority: 'MATERIAL_DERIVED', severity: 'HARD', applicabilityKind: 'CURRENT_TASK', verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION' },
      operations: [{ outcome: '材料条件', textFrom: { file: part.file, start: 2, end: 3 } }] };
    await assert.rejects(call('save_baseline_batch', { ...value, operations: [{ outcome: '混合坐标', textFrom: { ...value.operations[0].textFrom, sourceIndex: 1 } }] }), /exactly one/);
    await assert.rejects(call('save_baseline_batch', { ...value, operations: [{ outcome: '未知来源', textFrom: { file: '../foreign.txt', start: 1, end: 1 } }] }), /current frozen original source/);
    await assert.rejects(call('save_baseline_batch', { ...value, defaults: { ...value.defaults, authority: 'USER_EXPLICIT' } }), /SOURCE_BINDING_INVALID|NON_USER_AUTHORITY/);
    assert.equal(part.startsMidLine, false, 'ordinary chunks begin at a complete original line');
    assert.equal(source.parts[0].endLine + 1, part.startLine);
    await call('save_baseline_batch', value); await finish([1]);
  });
  assert.equal(handle.result.operations[0].text, expected);
  assert.equal(handle.result.operations[0].source.kind, 'MATERIAL');
  assert.equal(handle.result.operations[0].source.excerpt, expected);
  await handle.close();
});

test('multipart inputs default to compact outcomes and reject redundant source fields', async t => {
  const f = await fixture(t, { large: true, wireMode: null });
  const handle = await f.run(async ({ call, readAll, finish, params }) => {
    assert.equal(JSON.parse(params.prompt).wireMode, 'compact');
    const numbered = await call('source_read', { path: 'source-0000-0000.txt' });
    assert.equal(numbered.details.page.numbered, true);
    assert.match(toolText(numbered), /\[1\] Preserve the requested feature\./u);
    const raw = await call('source_read', { path: 'source-0000-0000.txt', numbered: false });
    assert.equal(raw.details.page.numbered, undefined, 'explicit raw presentation overrides the role default');
    assert.doesNotMatch(toolText(raw), /\n\[1\] /u);
    const request = await call('source_read', { path: 'request-0000.txt' });
    assert.equal(request.details.page.numbered, undefined, 'JSON stays raw by default');
    await readAll();
    const value = { batchId: 1, defaults: { operation: 'ADD', category: 'requirements', authority: 'USER_EXPLICIT', severity: 'HARD', applicabilityKind: 'CURRENT_TASK', verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION' },
      outcomes: [{ name: '保留用户要求', file: 'source-0000-0000.txt', lines: [1, 1] }] };
    await assert.rejects(call('save_baseline_batch', { ...value, outcomes: [{ ...value.outcomes[0], source: { ref: 'transcript:U1' } }] }), { code: 'BASELINE_SCHEMA_INVALID' });
    await call('save_baseline_batch', value);
    await finish([1]);
  });
  assert.equal(handle.result.operations[0].text, 'Preserve the requested feature.');
  await handle.close();
});

test('draft workflow merges retain blank-separated title, context, outcome and exceptions in one original span', async t => {
  const f = await fixture(t, { wireMode: 'draft' });
  const original = 'Feature title\n\nCurrent detail.\n\nRequired outcome; exceptions preserved.';
  f.input.evidence.snapshot.entries[0].message.content = original;
  const handle = await f.run(async ({ call, readAll, finish }) => {
    await readAll();
    await call('save_baseline_batch', { batchId: 1, defaults: { category: 'requirements', authority: 'USER_EXPLICIT', severity: 'HARD',
      applicabilityKind: 'CURRENT_TASK', verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION' },
      merge: [{ name: 'Complete feature outcome', units: ['S0L1', 'S0L3', 'S0L5'] }],
      exclude: [{ units: ['S1L1'], reason: 'Unadopted material context, not a user requirement.' }] });
    await finish([1]);
  });
  assert.equal(handle.result.operations.length, 1);
  assert.equal(handle.result.operations[0].text, original);
  assert.equal(handle.result.operations[0].source.ref, 'transcript:U1#L1-L5');
  assert.equal(handle.result.operations[0].source.excerpt, original);
  await handle.close();
});

test('span supersession preserves exact claim identity and unrelated project obligations', async t => {
  const f = await fixture(t);
  f.input.evidence.snapshot.entries[0].message.content = '空闲10分钟释放提取agent。\n并发请求排队，项目之间隔离。';
  const defaults = { operation: 'ADD', category: 'requirements', authority: 'USER_EXPLICIT', severity: 'HARD', applicabilityKind: 'CURRENT_TASK', verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION' };
  let handle = await f.run(async ({ call, readAll, finish }) => {
    await readAll(); await call('save_baseline_batch', { batchId: 1, defaults,
      operations: [1, 2].map(line => ({ outcome: line === 1 ? '空闲释放' : '并发排队与隔离', textFrom: { sourceIndex: 0, start: line, end: line } })) }); await finish([1]);
  });
  const publish = current => applyGroundTruthDelta({ projectRoot: f.root, taskId: f.task.taskId, delta: current.result,
    sourceCatalog: f.input.request.sourceCatalog, baselineCommit: { ...current.baselineTask, id: current.baselineTask.requestId, scope: 'stop', cursorDigest: current.baselineTask.requestId } });
  const originalDuties = async current => {
    const audit = await readJson(current.baselineTask.coverageAudit.proof.pointer.path);
    const source = audit.inventory.record.inventory.sources.find(source => source.kind === 'USER_MESSAGE' && source.ref === 'transcript:U1');
    assert.equal(source.units.length, 1, 'The two original lines share one neutral audit block');
    return source.units.flatMap(unit => unit.obligations).map(({ statement, owner, condition }) => ({ statement, owner, condition }));
  };
  await publish(handle);
  assert.deepEqual(await originalDuties(handle), [
    { statement: '空闲10分钟释放提取agent。', owner: 'IMPLEMENTATION', condition: '提取agent空闲10分钟时释放。' },
    { statement: '并发请求排队，项目之间隔离。', owner: 'IMPLEMENTATION', condition: '并发请求时排队，项目之间保持隔离。' },
  ]);
  await handle.close();
  const first = await loadCurrentGroundTruth(f.root, f.task.taskId), changed = first.claims.find(claim => claim.text.includes('10分钟'));
  const unchanged = first.claims.find(claim => claim.text.includes('排队'));
  f.input.evidence.groundTruth = first;
  Object.assign(f.input.request.currentGroundTruth, { version: first.version, digest: first.digest });
  Object.assign(f.input.request, { hookEventId: 'correction-event', lastUserCursor: 'U2' });
  f.input.request.sourceCatalog.push({ ref: 'transcript:U2', kind: 'USER_MESSAGE', aliases: ['U2'] });
  f.input.evidence.snapshot.entries.push({ type: 'user', uuid: 'U2', message: { role: 'user', content: '空闲释放改为15分钟，其余要求保持不变。' } });
  handle = await f.run(async ({ call, readAll, finish }) => {
    await readAll(); await call('save_baseline_batch', { batchId: 1, defaults: { ...defaults, operation: 'SUPERSEDE' },
      operations: [{ outcome: '调整空闲释放时间', claimId: changed.claimId, textFrom: { sourceIndex: 2, start: 1, end: 1 } }] }); await finish([1]);
  });
  await publish(handle);
  assert.deepEqual(await originalDuties(handle), [
    { statement: '空闲释放改为15分钟，其余要求保持不变。', owner: 'IMPLEMENTATION', condition: '提取agent空闲15分钟时释放，其余要求保持不变。' },
    { statement: '并发请求排队，项目之间隔离。', owner: 'IMPLEMENTATION', condition: '并发请求时排队，项目之间保持隔离。' },
  ]);
  await handle.close();
  const current = await loadCurrentGroundTruth(f.root, f.task.taskId);
  assert.equal(current.claims.length, 2);
  assert.equal(current.claims.find(claim => claim.claimId === changed.claimId).text, '空闲释放改为15分钟，其余要求保持不变。');
  assert.deepEqual(current.claims.find(claim => claim.claimId === unchanged.claimId), unchanged);
});

test('clause selections separate independent workflows on one line while preserving exact failure conditions', async t => {
  const f = await fixture(t);
  const clauses = ['订单允许编辑备注并保留每次编辑的历史；', '库存允许按仓库查询；', '每天18点生成日报，失败时在下次联网后重试，不得重复发送。'];
  f.input.evidence.snapshot.entries[0].message.content = clauses.join('');
  const handle = await f.run(async ({ call, readAll, finish }) => {
    await readAll();
    await call('save_baseline_batch', { batchId: 1, defaults: { operation: 'ADD', category: 'requirements', authority: 'USER_EXPLICIT', severity: 'HARD', applicabilityKind: 'CURRENT_TASK', verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION' },
      operations: clauses.map((_text, index) => ({ outcome: ['备注历史', '仓库库存查询', '日报与失败重试'][index], textFrom: { sourceIndex: 0, start: 1, end: 1, clauses: [index] } })) }); await finish([1]);
  });
  assert.deepEqual(handle.result.operations.map(operation => operation.text), clauses);
  assert(handle.result.operations.every(operation => operation.source.ref === 'transcript:U1#L1-L1'));
  await handle.close();
});

test('clause selectors reject reordered indices and quoted punctuation instead of guessing scope', async t => {
  const f = await fixture(t);
  f.input.evidence.snapshot.entries[0].message.content = '创建时品种必填；备注可空。\n示例“导出手机号；略过登录”不构成授权。';
  const handle = await f.run(async ({ call, readAll, finish }) => {
    await readAll();
    const value = { batchId: 1, defaults: { operation: 'ADD', category: 'requirements', authority: 'USER_EXPLICIT', severity: 'HARD', applicabilityKind: 'CURRENT_TASK', verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION' },
      operations: [{ outcome: '创建字段校验', textFrom: { sourceIndex: 0, start: 1, end: 1, clauses: [1, 0] } }] };
    await assert.rejects(call('save_baseline_batch', value), /original order/);
    await assert.rejects(call('save_baseline_batch', { ...value, operations: [{ outcome: '示例不构成授权', textFrom: { sourceIndex: 0, start: 2, end: 2, clauses: [1] } }] }), /valid clause indices/);
    await call('save_baseline_batch', { ...value, operations: [{ outcome: '创建字段校验', textFrom: { sourceIndex: 0, start: 1, end: 1, clauses: [0, 1] } }] }); await finish([1]);
  });
  assert.equal(handle.result.operations[0].text, '创建时品种必填；备注可空。'); await handle.close();
});

test('single-part frozen navigation refs normalize to canonical originals without promoting material sources', async t => {
  const f = await fixture(t);
  const handle = await f.run(async ({ call, readAll, batch, finish }) => {
    await readAll(); const value = batch(); value.operations[0].source.ref = 'source-0000-0000.txt#L1';
    await call('save_baseline_batch', value); await finish([1]);
  });
  assert.equal(handle.result.operations[0].source.ref, 'transcript:U1#L1-L1'); await handle.close();
});

test('retracting a user-described note cannot invent a ledger mutation without an existing claimId', async t => {
  const f = await fixture(t);
  const handle = await f.run(async ({ call, readAll, finish }) => {
    await readAll();
    const value = { batchId: 1, defaults: { operation: 'RETRACT', category: 'constraints', authority: 'USER_EXPLICIT', severity: 'HARD', applicabilityKind: 'CURRENT_TASK', verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION' },
      operations: [{ outcome: '当前有效要求', textFrom: { sourceIndex: 0, start: 1, end: 1 } }] };
    await assert.rejects(call('save_baseline_batch', value), /exact existing claimId/);
    await call('save_baseline_batch', { ...value, defaults: { ...value.defaults, operation: 'ADD' } }); await finish([1]);
  });
  assert.equal(handle.result.operations[0].operation, 'ADD'); await handle.close();
});

test('source index includes single-clause global requirements and outcome recovery stays explicit', async t => {
  const f = await fixture(t);
  f.input.evidence.snapshot.entries[0].message.content = '创建订单时品种必填；备注可空。\n需求纠正必须保留其他未修改的要求。';
  const handle = await f.run(async ({ call, readAll, finish }) => {
    const prompt = await readAll(), index = prompt.sourceClauseCounts.sources.find(item => item.sourceIndex === 0);
    assert.deepEqual(index.clausesPerLine, { 1: 2, 2: 1 }); assert.equal(index.partial, false);
    await call('save_baseline_batch', { batchId: 1, defaults: { operation: 'ADD', category: 'requirements', authority: 'USER_EXPLICIT', severity: 'HARD', applicabilityKind: 'CURRENT_TASK', verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION' },
      operations: [{ outcome: '创建字段校验', textFrom: { sourceIndex: 0, start: 1, end: 1 } }, { outcome: '保留其他旧要求', textFrom: { sourceIndex: 0, start: 2, end: 2 } }] });
    const publicResult = await call('review_history', { mode: 'state' });
    assert(Buffer.byteLength(toolText(publicResult)) <= 8192);
    const state = JSON.parse(toolText(publicResult)).taskState;
    assert.equal(state.outcomeCount, 2); assert.deepEqual(state.outcomes.map(item => item.outcome), ['创建字段校验', '保留其他旧要求']);
    assert.equal(state.sourceCount, 2); assert.equal(state.sources.length, 2);
    assert(state.sources.every(source => source.sha256 && source.clauseCounts && source.partCount === 1));
    await finish([1]);
  });
  assert(handle.result.operations.some(operation => operation.text.includes('保留其他'))); await handle.close();
});

test('compact outcome groups expand to exact source operations without a second text generation', async t => {
  const f = await fixture(t, { wireMode: 'compact' });
  const handle = await f.run(async ({ call, readAll, finish, params }) => {
    assert.equal(JSON.parse(params.prompt).wireMode, 'compact'); await readAll();
    await call('save_baseline_batch', { batchId: 1, defaults: { sourceIndex: 0, operation: 'ADD', category: 'requirements', authority: 'USER_EXPLICIT', severity: 'HARD', applicabilityKind: 'CURRENT_TASK', verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION' },
      outcomes: [{ name: 'Preserve requested feature', lines: [1, 1] }] }); await finish([1]);
  });
  assert.equal(handle.result.operations[0].text, 'Preserve the requested feature.'); await handle.close();
});

test('draft decisions retain cohesive paragraphs, partition split clauses, and reject forgotten scope', async t => {
  const f = await fixture(t, { wireMode: 'draft' });
  const lines = ['备注可编辑并保留历史；库存可按仓库查询；日报18点发送，失败联网后重试且不得重复。', '压缩后检查所有未完成义务，旧笔记不能充当证据。'];
  f.input.evidence.snapshot.entries[0].message.content = lines.join('\n');
  const defaults = { category: 'requirements', authority: 'USER_EXPLICIT', severity: 'HARD', applicabilityKind: 'CURRENT_TASK', verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION' };
  const handle = await f.run(async ({ call, readAll, finish }) => {
    const prompt = await readAll();
    assert.equal(prompt.wireMode, 'draft'); assert.deepEqual(prompt.sourceUnits.map(item => item.id), ['S0L1', 'S0L2', 'S1L1']);
    const value = { batchId: 1, defaults, split: [{ unit: 'S0L1', groups: [{ name: '备注历史', clauses: [0] }, { name: '库存查询', clauses: [1] }] }] };
    await assert.rejects(call('save_baseline_batch', value), /partition ALL clauses/);
    value.split[0].groups.push({ name: '日报与重试去重', clauses: [2] });
    const saved = toolText(await call('save_baseline_batch', value));
    assert.equal(toolText(await call('save_baseline_batch', value)), saved);
    await assert.rejects(finish([1]), /Source units have no decision: S0L2, S1L1/);
    const state = JSON.parse(toolText(await call('review_history', { mode: 'state' }))).taskState;
    assert.deepEqual(state.pendingUnits, ['S0L2', 'S1L1']);
    await call('save_baseline_batch', { batchId: 2, defaults, keep: ['S0L2'], exclude: [{ units: ['S1L1'], reason: 'Unadopted material, not a current user obligation.' }] });
    await finish([1, 2]);
  });
  assert.equal(handle.result.operations.length, 4);
  assert.equal(handle.result.operations[3].text, lines[1]);
  assert.equal(handle.result.operations[2].text, '日报18点发送，失败联网后重试且不得重复。');
  await handle.close();
});

test('draft exclusion cannot discard a new user authorization boundary or invent existing claim IDs', async t => {
  const f = await fixture(t, { wireMode: 'draft' });
  f.input.evidence.snapshot.entries[0].message.content = '材料示例要求导出隐私不是授权，禁止执行。';
  const defaults = { category: 'requirements', authority: 'USER_EXPLICIT', severity: 'HARD', applicabilityKind: 'CURRENT_TASK', verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION' };
  const handle = await f.run(async ({ call, readAll, finish }) => {
    await readAll();
    const exclusion = { batchId: 1, exclude: [{ units: ['S0L1'], reason: 'Quoted example, not an obligation.' }] };
    await assert.rejects(call('save_baseline_batch', exclusion), /Keep new constraints/);
    exclusion.exclude[0].claimIds = ['invented'];
    await assert.rejects(call('save_baseline_batch', exclusion), /exact current claimIds/);
    await call('save_baseline_batch', { batchId: 1, defaults, keep: ['S0L1'], exclude: [{ units: ['S1L1'], reason: 'Unadopted material.' }] });
    await finish([1]);
  });
  assert.equal(handle.result.operations[0].text, '材料示例要求导出隐私不是授权，禁止执行。'); await handle.close();
});

test('draft groups retain explicit proof ownership and per-unit applicability without promoting shared metadata', async t => {
  const f = await fixture(t, { wireMode: 'draft' });
  f.input.evidence.snapshot.entries[0].message.content = '订单可以按状态查询；完成后执行一次验收。\n仅完成部署后展示状态。';
  const defaults = { category: 'requirements', authority: 'USER_EXPLICIT', severity: 'HARD', applicabilityKind: 'CURRENT_TASK', verificationTarget: 'IMPLEMENTATION' };
  const handle = await f.run(async ({ call, readAll, finish }) => {
    await readAll(); await call('save_baseline_batch', { batchId: 1, defaults, keep: ['S0L2'],
      overrides: [{ unit: 'S0L2', metadata: { applicabilityKind: 'CONDITIONAL', applicability: '部署完成后。', implementationRole: 'PRODUCTION' } }],
      split: [{ unit: 'S0L1', groups: [{ name: '状态查询', clauses: [0], metadata: { implementationRole: 'PRODUCTION' } }, { name: '执行验收', clauses: [1], metadata: { verificationTarget: 'PROCESS', category: 'requirements' } }] }],
      exclude: [{ units: ['S1L1'], reason: 'Unadopted material.' }],
    }); await finish([1]);
  });
  const query = handle.result.operations.find(item => item.text.includes('查询'));
  const execution = handle.result.operations.find(item => item.text.includes('执行'));
  const conditional = handle.result.operations.find(item => item.text.includes('部署'));
  assert.equal(query.verificationTarget, 'IMPLEMENTATION'); assert.equal(query.implementationRole, 'PRODUCTION');
  assert.equal(execution.verificationTarget, 'PROCESS'); assert.equal(conditional.applicabilityKind, 'CONDITIONAL');
  assert.equal(conditional.applicability, '部署完成后。'); await handle.close();
});

test('draft duplicate exclusion proves complete current-claim coverage without republishing old obligations', async t => {
  const f = await fixture(t, { wireMode: 'draft' });
  const defaults = { category: 'requirements', authority: 'USER_EXPLICIT', severity: 'HARD', applicabilityKind: 'CURRENT_TASK', verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION' };
  let handle = await f.run(async ({ call, readAll, finish }) => {
    await readAll(); await call('save_baseline_batch', { batchId: 1, defaults, keep: ['S0L1'], exclude: [{ units: ['S1L1'], reason: 'Unadopted material.' }] }); await finish([1]);
  });
  await applyGroundTruthDelta({ projectRoot: f.root, taskId: f.task.taskId, delta: handle.result, sourceCatalog: f.input.request.sourceCatalog });
  await handle.close();
  const current = await loadCurrentGroundTruth(f.root, f.task.taskId);
  f.input.evidence.groundTruth = current; Object.assign(f.input.request.currentGroundTruth, { version: current.version, digest: current.digest });
  handle = await f.run(async ({ call, readAll }) => {
    await readAll(); await call('save_baseline_batch', { batchId: 1, exclude: [
      { units: ['S0L1'], reason: 'Entire original already represented.', claimIds: [current.claims[0].claimId] },
      { units: ['S1L1'], reason: 'Unadopted material.' },
    ] });
    await call('finish_baseline', { batchIds: [1], taskClassification: 'NO_CHANGE', summary: 'All current obligations retained.' });
  });
  assert.equal(handle.result.operations.length, 0); await handle.close();
});

test('full-text fallback changes tools in the same session without resetting the original deadline', async t => {
  const f = await fixture(t, { wireMode: 'draft' }), runs = []; let beforeSwitch, firstChecked = false;
  const handle = await f.run(async ({ call, readAll, finish, batch, params }) => {
    runs.push(params);
    const exposed = f.registry()(params).find(tool => tool.name === 'save_baseline_batch').parameters;
    if (runs.length === 1) {
      assert(exposed.properties.keep); assert(exposed.properties.operations.items.properties.sourceFrom);
      assert.equal(exposed.properties.defaults.properties.operation, undefined, 'Draft remains ADD-only; revisions still require the full-mode switch');
      await readAll();
      beforeSwitch = JSON.parse(toolText(await call('review_history', { mode: 'state' }))).taskState;
      assert.equal(beforeSwitch.nextBatchId, 1);
      const switched = JSON.parse(toolText(await call('save_baseline_batch', { batchId: 1, fullTextReason: 'Need a synthesis across source contexts.' })));
      assert.equal(switched.saved, false); assert.equal(switched.batchIdConsumed, false); assert.equal(switched.nextBatchId, 1);
      assert.match(switched.effectiveMetadata, /operation\/category\/authority\/severity\/applicabilityKind\/verificationTarget/);
      assert.match(switched.encodings.synthesis, /OMIT textFrom; outcome is NOT required/u);
      assert.match(switched.encodings.synthesis, /bindings/u);
      firstChecked = true;
      return;
    }
    assert.equal(JSON.parse(params.prompt).wireMode, 'full');
    assert.equal(JSON.parse(params.prompt).nextBatchId, 1);
    const resumed = JSON.parse(toolText(await call('review_history', { mode: 'state' }))).taskState;
    assert.equal(resumed.nextBatchId, 1); assert.equal(resumed.batchCount, 0);
    assert.equal(resumed.deadlineAt, beforeSwitch.deadlineAt); assert.equal(resumed.repairs, beforeSwitch.repairs);
    assert.equal(resumed.metrics.readBytes, beforeSwitch.metrics.readBytes);
    assert(exposed.properties.operations); assert.equal(exposed.properties.keep, undefined);
    assert.deepEqual(validateJsonSchema(batch(), exposed), []);
    await call('save_baseline_batch', batch()); await finish([1]);
  });
  assert.equal(firstChecked, true, 'a mode switch must not swallow a failed script assertion');
  assert.equal(runs.length, 2); assert.equal(runs[0].sessionId, runs[1].sessionId);
  assert.notEqual(runs[0].runId, runs[1].runId); assert(runs[1].timeoutMs <= runs[0].timeoutMs);
  assert.equal(handle.result.operations.length, 1); await handle.close();
});

test('one unchanged mixed source clause supports separately scoped full-mode obligations through publication and metric projection', async t => {
  const original = 'Implement next(value) according to materials/contract.md, preserving every condition and explicit exclusion, AND actually run the provided verifier with node materials/verify.mjs in this project and establish exit code 0 before declaring completion.';
  const contract = 'Implement next(value) for integers 0 through 9. Return value + 1 without storing state. Input handling outside that range is out of scope.\nAll imports and processing stay local. Do not send data over a network.\n';
  const f = await fixture(t, { wireMode: 'draft', materialText: contract, materialRelativePath: 'materials/contract.md' });
  f.input.evidence.snapshot.entries[0].message.content = original;
  let runs = 0, acknowledgedReads;
  const handle = await f.run(async ({ params, readAll, call, finish, seen }) => {
    const prompt = JSON.parse(params.prompt), exposed = f.registry()(params).find(tool => tool.name === 'save_baseline_batch').parameters;
    if (++runs === 1) {
      assert.equal(prompt.wireMode, 'draft'); assert.equal(prompt.sourceUnits.find(unit => unit.id === 'S0L1').clauses, 1);
      await readAll(); acknowledgedReads = [...seen].map(([file, receipts]) => [file, [...receipts]]);
      await call('save_baseline_batch', { batchId: 1, fullTextReason: 'One original clause has two evidence owners; use accurate scoped obligations with the same original citation.' });
      return;
    }
    assert.equal(prompt.wireMode, 'full'); assert(exposed.properties.operations);
    assert.deepEqual([...seen], acknowledgedReads, 'The mode switch must retain current genuine original-read receipts');
    const source = { ref: 'transcript:U1#L1-L1', kind: 'USER_MESSAGE', subject: 'MAIN_TASK', excerpt: original };
    const citeIds = [...seen].filter(([file]) => file.startsWith('source-0000')).flatMap(([, ids]) => ids);
    const value = { batchId: 1, defaults: { operation: 'ADD', category: 'requirements', authority: 'USER_EXPLICIT', severity: 'HARD', applicabilityKind: 'CURRENT_TASK' },
      operations: [
        { text: 'Implement next(value) according to materials/contract.md, preserving every condition and explicit exclusion.', verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION', source },
        { text: 'Before declaring completion, actually run the provided verifier with node materials/verify.mjs in this project and establish exit code 0.', verificationTarget: 'PROCESS', source },
        { outcome: 'Function behavior and input scope', textFrom: { sourceIndex: 1, start: 1, end: 1 }, authority: 'MATERIAL_DERIVED', verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION' },
        { outcome: 'Local-only processing and no network', textFrom: { sourceIndex: 1, start: 2, end: 2 }, authority: 'MATERIAL_DERIVED', verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION', category: 'constraints' },
      ], bindings: [{ operationIndex: 0, citeIds }, { operationIndex: 1, citeIds }] };
    assert.deepEqual(validateJsonSchema(value, exposed), []);
    // Replay the real provider's first failed full-mode shape: accurate I/P
    // text/source, plus selection coordinates and no citation bindings. The
    // first feedback must send it to synthesis, not through outcome/coordinate
    // repairs that would widen the scoped obligation back to the whole line.
    const { operation: _defaultOperation, ...defaults } = value.defaults;
    const mixedEncoding = { batchId: 1, defaults, operations: value.operations.slice(0, 2).map(operation => ({ ...operation, operation: 'ADD',
      textFrom: { clauses: [0], end: 1, file: 'source-0000-0000.txt', sourceIndex: 0, start: 1 } })) };
    await assert.rejects(call('save_baseline_batch', mixedEncoding), error => {
      assert.equal(error.code, 'BASELINE_SOURCE_INVALID');
      assert.match(error.message, /mixes textFrom selection with synthesis source/u);
      assert.match(error.message, /KEEP text \+ source, REMOVE textFrom; outcome is NOT required/u);
      assert.match(error.message, /ADD one batch bindings entry per operation/u);
      return true;
    });
    const progress = JSON.parse(toolText(await call('review_history', { mode: 'state' }))).taskState;
    assert.equal(progress.repairs, 1); assert.equal(progress.batchCount, 0);
    await call('save_baseline_batch', value); await finish([1]);
  });
  assert.equal(runs, 2);
  const saved = await readJson(path.join(handle.requestDirectory, 'request.json'));
  assert.deepEqual(saved.identity.protocol, BASELINE_EXTRACTION_PROTOCOL);
  const legacyId = sha256({ protocol: 'stop-baseline-task-v1', taskId: f.task.taskId, request: f.input.request,
    baseline: [f.truth.version, f.truth.digest], sources: saved.identity.sources });
  assert.notEqual(saved.identity.requestId, legacyId, 'Old complete candidates and notes cannot retain the new prompt identity');
  const selectedUser = handle.result.operations.filter(op => op.authority === 'USER_EXPLICIT');
  assert.deepEqual(selectedUser.map(op => op.verificationTarget), ['IMPLEMENTATION', 'PROCESS']);
  assert(selectedUser.every(op => op.source.ref === 'transcript:U1#L1-L1' && op.source.excerpt === original));
  assert.equal(selectedUser[1].implementationRole, undefined);
  const applied = await applyGroundTruthDelta({ projectRoot: f.root, taskId: f.task.taskId, delta: handle.result,
    sourceCatalog: f.input.request.sourceCatalog, baselineCommit: { ...handle.baselineTask, id: handle.baselineTask.requestId, scope: 'stop', cursorDigest: 'unchanged-original' } });
  await handle.close();
  const claims = applied.current.claims.filter(claim => claim.authority === 'USER_EXPLICIT');
  assert.equal(claims.length, 2); assert.notEqual(claims[0].claimId, claims[1].claimId);
  assert(claims.every(claim => claim.source.excerpt === original));
  assert.deepEqual(applied.current.claims.filter(claim => claim.authority === 'MATERIAL_DERIVED').map(claim => claim.text).sort(), contract.trimEnd().split('\n').sort());
  const population = await buildMetricPopulation({ projectRoot: f.root, taskId: f.task.taskId, groundTruth: applied.current });
  for (const claim of claims) {
    const object = population.metrics.M12.find(object => object.sourceId === claim.claimId);
    assert(object); assert.deepEqual(reviewProofOwners(object), claim.verificationTarget === 'PROCESS' ? ['PROCESS'] : ['SOURCE']);
    assert.equal(population.metrics.M16.some(object => object.sourceId === claim.claimId), claim.verificationTarget === 'IMPLEMENTATION');
  }
  assert.equal(f.input.evidence.snapshot.entries[0].message.content, original);
});

test('same project refresh reuses the extractor but renews tools, reading proof and note validity', async t => {
  const f = await fixture(t); let oldTool, oldCite;
  const first = await f.run(async ({ call, readAll, finish, params }) => {
    await readAll();
    const state = JSON.parse(toolText(await call('review_history', { mode: 'state' })));
    oldCite = state.citations[0].citeId;
    oldTool = f.registry()({ sessionKey: params.sessionKey, sessionId: params.sessionId, runId: params.runId })[0];
    await call('baseline_notes', { action: 'put', key: 'scope', text: 'Remember the whole request.', sourceRefs: ['transcript:U1'] });
    await finish([]);
  });
  await first.close(); f.input.request.hookEventId = 'event-2';
  const second = await f.run(async ({ call, readAll, finish }) => {
    const state = JSON.parse(toolText(await call('review_history', { mode: 'state' })));
    assert.equal(state.citations.length, 0);
    assert(!state.citations.some(cite => cite.citeId === oldCite));
    const notes = JSON.parse(toolText(await call('baseline_notes', { action: 'list' })));
    assert.equal(notes.notes[0].stale, true);
    await assert.rejects(oldTool.execute('late', { path: 'request-0000.txt' }), /expired/);
    await assert.rejects(finish([]), { code: 'BASELINE_INCOMPLETE' });
    await readAll(); await finish([]);
  });
  assert.equal(first.sessionId, second.sessionId); assert.equal(second.extractorReused, true);
  assert.notEqual(f.captures[0].runId, f.captures[1].runId);
  assert.equal(f.captures[0].sessionFile, f.captures[1].sessionFile); await second.close();
});

test('a cancelled non-cooperative extractor cannot overlap the next project refresh', async t => {
  const f = await fixture(t), controller = new AbortController();
  let unblock, admitted;
  const pending = new Promise(resolve => { unblock = resolve; });
  const started = new Promise(resolve => { admitted = resolve; });
  f.input.abortSignal = controller.signal;
  const first = f.run(async () => { admitted(); await pending; });
  const rejected = assert.rejects(first, /cancel-extractor/);
  await started; controller.abort(new Error('cancel-extractor')); await rejected;
  f.input.abortSignal = new AbortController().signal;
  const second = f.run(async ({ readAll, finish }) => { await readAll(); await finish([]); });
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(f.captures.length, 1);
  unblock(); const handle = await second;
  assert.equal(f.captures.length, 2); assert.notEqual(f.captures[0].sessionId, f.captures[1].sessionId, 'a run cancelled before any assistant message retires its identity');
  await handle.close();
});

test('transient Windows replacement locks preserve durable history and candidates without losing completion', async t => {
  const f = await fixture(t), originalRename = fs.rename, blocked = new Set();
  t.mock.method(fs, 'rename', async (source, destination) => {
    const name = path.basename(destination);
    if (['history-index.json', 'batch-1.json'].includes(name) && !blocked.has(name)) {
      blocked.add(name); throw Object.assign(new Error('transient file reader'), { code: 'EPERM' });
    }
    return originalRename(source, destination);
  });
  const handle = await f.run(async ({ readAll, call, batch, finish }) => {
    await readAll(); await call('save_baseline_batch', batch()); await finish([1]);
  });
  assert.equal(handle.result.operations.length, 1); assert.equal(blocked.size, 2); await handle.close();
});

test('completed baseline publication uses the parent deadline after the extractor closes',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});
 const f=await fixture(t,{originalText:lifecycleOriginal}),started=Date.now();f.input.deadlineAt=started+60000;
 const state=await readJson(path.join(taskDirectory(f.root,f.task.taskId),'task.json'));
 let handle;
 const result=await withTaskDecision({projectRoot:f.root,taskId:f.task.taskId,context:{kind:'requirements',assessmentId:'long-parent',
  guard:decisionGuard(state),deadlineAt:started+60000,evidenceMatches:async()=>true}},async()=>{
  handle=await f.run(async({readAll,finish})=>{await readAll();await finish([]);});
  assert.equal(handle.baselineTask.extractionDeadlineAt,started+20000);
  assert.equal(handle.baselineTask.deadlineAt,started+60000);
  await applyGroundTruthDelta({projectRoot:f.root,taskId:f.task.taskId,delta:handle.result,sourceCatalog:f.input.request.sourceCatalog,
   baselineCommit:{...handle.baselineTask,id:handle.baselineTask.requestId,scope:'stop',cursorDigest:'long-parent'}});
  await handle.close();t.mock.timers.tick(21000);
  await handle.baselineTask.assertCurrent();
  return {baselineCommitted:true};
 });
 assert.equal(result.baselineCommitted,true);assert.equal(result.stale,undefined);
 assert.equal((await readJson(path.join(taskDirectory(f.root,f.task.taskId),'task.json'))).assessments['long-parent'].result.baselineCommitted,true);
 t.mock.timers.tick(39000);
 await assert.rejects(handle.baselineTask.assertCurrent(),error=>error.code==='REVIEWER_DEADLINE');
});

test('a completed baseline still rejects source changes after the extraction role deadline',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});
 const f=await fixture(t);f.input.deadlineAt=Date.now()+60000;
 const handle=await f.run(async({readAll,finish})=>{await readAll();await finish([]);});await handle.close();
 t.mock.timers.tick(21000);await fs.appendFile(f.material,'Changed original source.');
 await assert.rejects(handle.baselineTask.assertCurrent(),error=>error.code==='BASELINE_INPUT_CHANGED');
});

test('baseline publication failure keeps its typed cause and never commits a current cursor',async t=>{
 const f=await fixture(t,{originalText:lifecycleOriginal}),state=await readJson(path.join(taskDirectory(f.root,f.task.taskId),'task.json'));
 const result=await withTaskDecision({projectRoot:f.root,taskId:f.task.taskId,context:{kind:'requirements',assessmentId:'changed-before-head',
  guard:decisionGuard(state),evidenceMatches:async()=>true}},async()=>{
  const handle=await f.run(async({readAll,finish})=>{await readAll();await finish([]);});
  await applyGroundTruthDelta({projectRoot:f.root,taskId:f.task.taskId,delta:handle.result,sourceCatalog:f.input.request.sourceCatalog,
   baselineCommit:{...handle.baselineTask,id:handle.baselineTask.requestId,scope:'stop',cursorDigest:'must-not-publish'}});
  await handle.close();await fs.appendFile(f.material,'Changed before the head publication.');
  return {baselineCommitted:true};
 });
 assert.equal(result.stale,true);assert.equal(result.reason,'evidenceChanged');
 assert.equal(result.evidenceFailure.code,'BASELINE_INPUT_CHANGED');assert.match(result.evidenceFailure.reason,/Original source changed/);
 const current=await readJson(path.join(taskDirectory(f.root,f.task.taskId),'task.json'));
 assert.equal(current.assessments?.['changed-before-head'],undefined);
 assert.equal(current.groundTruth.sourceCursors?.stop,undefined);
 const records=(await fs.readFile(path.join(taskDirectory(f.root,f.task.taskId),'journal/events.jsonl'),'utf8')).trim().split(/\r?\n/u).map(JSON.parse);
 assert.equal(records.findLast(record=>record.type==='STALE_ASSESSMENT').evidenceFailure.code,'BASELINE_INPUT_CHANGED');
});

test('missing implementation metadata gives a recoverable diagnostic without choosing a role or saving a batch', async t => {
  const f = await fixture(t, { wireMode: 'draft' });
  const handle = await f.run(async ({ call, readAll, finish, params }) => {
    await readAll();
    const exposed = f.registry()(params).find(tool => tool.name === 'save_baseline_batch').parameters;
    const value = { batchId: 1, defaults: { category: 'requirements', authority: 'USER_EXPLICIT', severity: 'HARD',
      applicabilityKind: 'CURRENT_TASK', verificationTarget: 'IMPLEMENTATION' }, keep: ['S0L1'] };
    const before = JSON.parse(toolText(await call('review_history', { mode: 'state' }))).taskState;
    await assert.rejects(call('save_baseline_batch', value), error => {
      assert.equal(error.code, 'BASELINE_SCOPE_INVALID');
      assert.equal(error.baselineValidation.reason, 'PROOF_OWNER_REQUIRED');
      assert.equal(error.baselineValidation.unitId, 'S0L1');
      assert.deepEqual(error.baselineValidation.fields, ['implementationRole']);
      assert.match(error.message, /plain unsaved batchId only when no owned proposal exists/u);
      assert.match(error.message, /correct_and_submit/u);
      return true;
    });
    assert.equal(value.defaults.implementationRole, undefined, 'no role is assigned by the tool');
    assert(exposed.properties.defaults.properties.implementationRole.enum.includes('PRODUCTION'));
    const after = JSON.parse(toolText(await call('review_history', { mode: 'state' }))).taskState;
    assert.equal(after.lastValidationError.reason, 'PROOF_OWNER_REQUIRED');
    assert.deepEqual(after.pendingUnits, before.pendingUnits);
    assert.equal(after.batchCount, 0);
    assert.equal(after.repairs, before.repairs + 1);
    assert.equal(after.maxRepairs, before.maxRepairs);
    assert.equal(after.deadlineAt, before.deadlineAt);
    await call('save_baseline_batch', { ...value, defaults: { ...value.defaults, implementationRole: 'PRODUCTION' },
      exclude: [{ units: ['S1L1'], reason: 'Unadopted material.' }] });
    await finish([1]);
  });
  assert.equal(handle.result.operations[0].implementationRole, 'PRODUCTION');
  assert.equal(handle.result.operations[0].text, 'Preserve the requested feature.');
  assert.equal((await loadCurrentGroundTruth(f.root, f.task.taskId)).version, 0);
  await handle.close();
});

for (const encoding of ['synthesis', 'selection', 'compact']) test(`${encoding} cannot save an explicit IMPLEMENTATION claim without its chosen role`, async t => {
  const f = await fixture(t, { wireMode: 'full' });
  const defaults = { operation: 'ADD', category: 'requirements', authority: 'USER_EXPLICIT', severity: 'HARD',
    applicabilityKind: 'CURRENT_TASK', verificationTarget: 'IMPLEMENTATION' };
  let rejected = false;
  const handle = await f.run(async ({ call, readAll, finish, seen }) => {
    await readAll();
    const value = { batchId: 1, defaults, ...(encoding === 'compact'
      ? { outcomes: [{ name: 'Feature', sourceIndex: 0, lines: [1, 1] }] }
      : encoding === 'selection'
        ? { operations: [{ outcome: 'Feature', textFrom: { sourceIndex: 0, start: 1, end: 1 } }] }
        : { operations: [{ text: 'Preserve the requested feature.', source: { ref: 'transcript:U1#L1-L1', kind: 'USER_MESSAGE', subject: 'MAIN_TASK' } }],
          bindings: [{ operationIndex: 0, citeIds: [...seen].filter(([file]) => file.startsWith('source-0000')).flatMap(([, ids]) => ids) }] }) };
    const before = JSON.parse(toolText(await call('review_history', { mode: 'state' }))).taskState;
    await assert.rejects(call('save_baseline_batch', value), error => {
      assert.equal(error.code, 'BASELINE_SCOPE_INVALID');
      assert.equal(error.baselineValidation.reason, 'PROOF_OWNER_REQUIRED');
      assert.deepEqual(error.baselineValidation.fields, ['implementationRole']);
      assert.match(error.message, /plain unsaved batchId only when no owned proposal exists/u);
      assert.match(error.message, /correct_and_submit/u);
      rejected = true; return true;
    });
    const after = JSON.parse(toolText(await call('review_history', { mode: 'state' }))).taskState;
    assert.equal(after.batchCount, 0);
    assert.equal(after.repairs, before.repairs + 1);
    assert.equal(after.deadlineAt, before.deadlineAt);
    assert.equal(after.metrics.readBytes, before.metrics.readBytes);
    assert.equal(defaults.implementationRole, undefined, 'validation never chooses a role');
    await call('save_baseline_batch', { ...value, defaults: { ...defaults, implementationRole: 'PRODUCTION' } });
    await finish([1]);
  });
  assert.equal(rejected, true);
  assert.equal(handle.result.operations[0].implementationRole, 'PRODUCTION');
  assert.equal(handle.result.operations[0].text, 'Preserve the requested feature.');
  assert.equal((await loadCurrentGroundTruth(f.root, f.task.taskId)).version, 0);
  await handle.close();
});

test('semantic overlap with a real current claim cannot prove exact exclusion; full mode binds the retained original', async t => {
  const f = await fixture(t, { wireMode: 'draft' });
  const defaults = { category: 'requirements', authority: 'USER_EXPLICIT', severity: 'HARD',
    applicabilityKind: 'CURRENT_TASK', verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION' };
  let handle = await f.run(async ({ call, readAll, finish }) => {
    await readAll();
    await call('save_baseline_batch', { batchId: 1, defaults, keep: ['S0L1'], exclude: [{ units: ['S1L1'], reason: 'Unadopted material.' }] });
    await finish([1]);
  });
  await applyGroundTruthDelta({ projectRoot: f.root, taskId: f.task.taskId, delta: handle.result, sourceCatalog: f.input.request.sourceCatalog });
  await handle.close();
  const truth = await loadCurrentGroundTruth(f.root, f.task.taskId), claimId = truth.claims[0].claimId;
  f.input.evidence.groundTruth = truth;
  Object.assign(f.input.request.currentGroundTruth, { version: truth.version, digest: truth.digest });
  const original = 'Please preserve the requested feature.';
  f.input.evidence.snapshot.entries[0].message.content = original;
  let runs = 0, deadlineAt, readBytes;
  handle = await f.run(async ({ call, readAll, finish, seen }) => {
    if (++runs === 1) {
      seen.clear();
      await readAll();
      await assert.rejects(call('save_baseline_batch', { batchId: 1, exclude: [
        { units: ['S0L1'], reason: 'Same meaning as the current requirement.', claimIds: [claimId] },
      ] }), error => {
        assert.equal(error.code, 'BASELINE_SCOPE_INVALID');
        assert.equal(error.baselineValidation.reason, 'WHOLE_ORIGINAL_NOT_PRESENT');
        assert.match(error.message, /Semantic overlap is insufficient/);
        return true;
      });
      const state = JSON.parse(toolText(await call('review_history', { mode: 'state' }))).taskState;
      assert.equal(state.batchCount, 0);
      assert(state.pendingUnits.includes('S0L1'));
      deadlineAt = state.deadlineAt; readBytes = state.metrics.readBytes;
      await call('save_baseline_batch', { batchId: 1, fullTextReason: 'Reconcile the original with the actual current claim, retaining its requirement.' });
      return;
    }
    const state = JSON.parse(toolText(await call('review_history', { mode: 'state' }))).taskState;
    assert.equal(state.deadlineAt, deadlineAt);
    assert.equal(state.metrics.readBytes, readBytes, 'acknowledged sources need no reread');
    assert.equal(state.repairs, 1);
    await call('save_baseline_batch', { batchId: 1, defaults: { ...defaults, operation: 'SUPERSEDE' },
      operations: [{ claimId, text: original, source: { ref: 'transcript:U1#L1-L1', kind: 'USER_MESSAGE', subject: 'MAIN_TASK' } }],
      bindings: [{ operationIndex: 0, citeIds: [...seen].filter(([file]) => file.startsWith('source-0000')).flatMap(([, ids]) => ids) }] });
    await finish([1]);
  });
  assert.equal(runs, 2);
  assert.equal(handle.result.operations[0].operation, 'SUPERSEDE');
  assert.equal(handle.result.operations[0].claimId, claimId);
  assert.equal(handle.result.operations[0].text, original);
  assert.equal(handle.result.operations[0].source.excerpt, original);
  assert.equal((await loadCurrentGroundTruth(f.root, f.task.taskId)).version, truth.version, 'candidate cannot publish itself');
  await handle.close();
});

test('repair exhaustion preserves the last validation cause through the native boundary without extending the allowance', async t => {
  const f = await fixture(t, { wireMode: 'draft' });
  f.input.reviewer.formatRepairAttempts = 1;
  await assert.rejects(f.run(async ({ call, readAll }) => {
    await readAll();
    const value = { batchId: 1, defaults: { category: 'requirements', authority: 'USER_EXPLICIT', severity: 'HARD',
      applicabilityKind: 'CURRENT_TASK', verificationTarget: 'IMPLEMENTATION' }, keep: ['S0L1'] };
    await assert.rejects(call('save_baseline_batch', value), { code: 'BASELINE_SCOPE_INVALID' });
    await call('save_baseline_batch', value);
  }), error => {
    assert.equal(error.code, 'BASELINE_REPAIR_LIMIT');
    assert.equal(error.baselineValidation.code, 'BASELINE_SCOPE_INVALID');
    assert.equal(error.baselineValidation.reason, 'PROOF_OWNER_REQUIRED');
    assert.match(error.message, /Baseline validation repair allowance exhausted/);
    assert.match(error.message, /implementationRole/);
    assert.doesNotMatch(error.message, /Native task execution failed/);
    return true;
  });
  assert.equal(f.captures.length, 1, 'no new native attempt after repair exhaustion');
  const directories = await fs.readdir(path.join(taskDirectory(f.root, f.task.taskId), 'baseline-task-runs'));
  const checkpoint = await readJson(path.join(taskDirectory(f.root, f.task.taskId), 'baseline-task-runs', directories[0], 'review-checkpoint.json'));
  assert.equal(checkpoint.taskState.repairs, 1);
  assert.equal(checkpoint.taskState.maxRepairs, 1);
  assert.equal(checkpoint.taskState.validationFailures, 2);
  assert.equal(checkpoint.taskState.repairExhausted, true);
  assert.deepEqual(checkpoint.taskState.batches, []);
  assert.equal(checkpoint.taskState.lastValidationError.reason, 'PROOF_OWNER_REQUIRED');
});

test('baseline native transport preserves sanitized host failure cause and identity', async t => {
  const f = await fixture(t, { wireMode: 'draft' });
  await assert.rejects(f.run(async () => { throw Object.assign(new Error('api_key=private-host-error-detail; upstream failed'), { code: 'HOST_FIXTURE_FAILURE' }); }), error => {
    assert.equal(error.code, 'HOST_FIXTURE_FAILURE');
    assert.match(error.message, /upstream failed/u);
    assert.doesNotMatch(error.message, /private-host-error-detail/u);
    assert.equal(error.nativeFailure.stage, 'NATIVE_EXECUTION');
    assert.equal(error.nativeFailure.taskId, f.task.taskId);
    assert.equal(error.nativeFailure.runId, f.captures[0].runId);
    assert.equal(error.baselineValidation, undefined);
    return true;
  });
  assert.equal(f.captures.length, 1);
});

test('draft literal preview preserves boundaries but grants neither reads nor material authority', async t => {
  const f = await fixture(t, { wireMode: 'draft' });
  const original = 'Search results stay ordered. Sort equal scores by creation time; external services are outside scope.';
  f.input.evidence.snapshot.entries[0].message.content = original;
  const defaults = { category: 'requirements', authority: 'USER_EXPLICIT', severity: 'HARD',
    applicabilityKind: 'CURRENT_TASK', verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION' };
  const value = { batchId: 1, defaults, keep: ['S0L1'], exclude: [{ units: ['S1L1'], reason: 'Unadopted material.' }] };
  const handle = await f.run(async ({ call, readAll, finish, params }) => {
    const prompt = JSON.parse(params.prompt);
    assert.deepEqual(prompt.sourceUnitNavigation, { navigationOnly: true, complete: true });
    assert.deepEqual(prompt.sourceUnits[0].clauseMap, [
      { index: 0, text: 'Search results stay ordered. Sort equal scores by creation time;' },
      { index: 1, text: ' external services are outside scope.' },
    ]);
    assert.deepEqual(prompt.sourceUnits.map(unit => unit.kind), ['USER_MESSAGE', 'MATERIAL']);
    const state = () => call('review_history', { mode: 'state' }).then(result => JSON.parse(toolText(result)).taskState);
    assert.equal((await state()).metrics.readBytes, 0);
    await assert.rejects(finish([]), { code: 'BASELINE_INCOMPLETE' });
    await assert.rejects(call('save_baseline_batch', value), { code: 'BASELINE_SOURCE_INVALID' });
    await readAll();
    await assert.rejects(call('save_baseline_batch', { batchId: 1, defaults, keep: ['S0L1', 'S1L1'] }), /SOURCE_BINDING_INVALID|NON_USER_AUTHORITY/);
    assert.equal((await state()).batchCount, 0);
    await call('save_baseline_batch', value); await finish([1]);
  });
  const request = await readJson(path.join(handle.requestDirectory, 'request.json'));
  assert.match(request.identity.protocol.version, /^stop-baseline-task-v18-/);
  const { requestId, protocol, ...rest } = request.identity;
  assert.equal(requestId, sha256({ protocol, taskId: request.taskId, request: f.input.request,
    baseline: [f.truth.version, f.truth.digest], sources: rest.sources }));
  const priorRequestId = sha256({ protocol: { ...protocol, version: 'stop-baseline-task-v5-source-navigation-proof-owner' },
    taskId: request.taskId, request: f.input.request, baseline: [f.truth.version, f.truth.digest], sources: rest.sources });
  assert.notEqual(requestId, priorRequestId);
  assert.notEqual(requestId, sha256({ protocol: { ...protocol, version: 'stop-baseline-task-v7-accepted-source-retention' },
    taskId: request.taskId, request: f.input.request, baseline: [f.truth.version, f.truth.digest], sources: rest.sources }));
  assert.notEqual(requestId, sha256({ protocol: { ...protocol, version: 'stop-baseline-task-v8-explicit-synthesis-owner' },
    taskId: request.taskId, request: f.input.request, baseline: [f.truth.version, f.truth.digest], sources: rest.sources }));
  assert.notEqual(requestId, sha256({ protocol: { ...protocol, version: 'stop-baseline-task-v9-explicit-synthesis-applicability' },
    taskId: request.taskId, request: f.input.request, baseline: [f.truth.version, f.truth.digest], sources: rest.sources }));
  assert.notEqual(requestId, sha256({ protocol: { ...protocol, version: 'stop-baseline-task-v13-pre-ready-source-admission' },
    taskId: request.taskId, request: f.input.request, baseline: [f.truth.version, f.truth.digest], sources: rest.sources }));
  assert.notEqual(requestId, sha256({ protocol: { ...protocol, version: 'stop-baseline-task-v14-authority-pending-navigation' },
    taskId: request.taskId, request: f.input.request, baseline: [f.truth.version, f.truth.digest], sources: rest.sources }));
  assert.notEqual(requestId, sha256({ protocol: { ...protocol, version: 'stop-baseline-task-v15-bounded-public-state' },
    taskId: request.taskId, request: f.input.request, baseline: [f.truth.version, f.truth.digest], sources: rest.sources }));
  assert.equal(handle.result.operations[0].text, original, 'scope exclusion stays in the original runtime obligation');
  await handle.close();
});

test('mixed-source authority feedback names actual inherited defaults and preserves explicit overrides', async t => {
  const f = await fixture(t, { wireMode: 'draft' });
  const defaults = { category: 'requirements', authority: 'USER_EXPLICIT', severity: 'HARD',
    applicabilityKind: 'CURRENT_TASK', verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION' };
  const original = { batchId: 1, defaults, keep: ['S0L1', 'S1L1'] }, untouched = structuredClone(original);
  const handle = await f.run(async ({ call, readAll, finish }) => {
    await readAll();
    const state = async () => JSON.parse(toolText(await call('review_history', { mode: 'state' }))).taskState;
    const before = await state();
    await assert.rejects(call('save_baseline_batch', original), error => {
      assert.equal(error.code, 'SOURCE_BINDING_INVALID');
      assert.deepEqual(error.sourceBindingIssues.map(issue => issue.index), [1]);
      const facts = JSON.parse(error.message.split('\nSource authority navigation: ')[1]);
      assert.equal(facts.saved, false); assert.equal(facts.nextBatchId, 1); assert.equal(facts.generation, 0);
      assert.deepEqual(facts.issues, [{ operationIndex: 1, reason: 'NON_USER_AUTHORITY', ref: `${f.material.replaceAll('\\', '/')}#L1-L1`,
        sourceKind: 'MATERIAL', authority: 'USER_EXPLICIT', authorityOrigin: 'defaults', defaultAuthority: 'USER_EXPLICIT' }]);
      return true;
    });
    const rejected = await state();
    assert.equal(rejected.repairs, before.repairs + 1); assert.equal(rejected.batchCount, 0);
    assert.equal(rejected.nextBatchId, 1); assert.equal(rejected.metrics.readBytes, before.metrics.readBytes);
    assert.deepEqual(original, untouched);
    await call('save_baseline_batch', { ...original, overrides: [{ unit: 'S1L1', metadata: { authority: 'MATERIAL_DERIVED' } }] });
    await finish([1]);
  });
  assert.deepEqual(handle.result.operations.map(item => item.authority), ['USER_EXPLICIT', 'MATERIAL_DERIVED']);
  assert.deepEqual(handle.result.operations.map(item => item.text), ['Preserve the requested feature.', 'Original material condition.']);
  await handle.close();
});

test('source-authority feedback also covers the real post-binding validation callback', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-authority-callback-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'frozen'), outputDir = path.join(base, 'worker');
  await fs.mkdir(root); await fs.mkdir(outputDir); await fs.writeFile(path.join(root, 'source.txt'), 'Original material condition.');
  const catalog = [{ ref: 'transcript:U1', kind: 'USER_MESSAGE' }, { ref: 'requirements.md', kind: 'MATERIAL' }];
  let callbackCalls = 0, originalError;
  const raw = { ...operation('requirements.md'), text: 'Original material condition.', source: { ref: 'requirements.md', kind: 'MATERIAL' } };
  delete raw.authority;
  const value = { batchId: 1, defaults: { authority: 'USER_EXPLICIT' }, operations: [raw], bindings: [] }, untouched = structuredClone(value);
  const worker = await createBaselineWorker({ root, outputDir,
    identity: { requestId: 'authority-callback', taskId: 'callback', baselineVersion: 0, baselineDigest: 'empty', sourceCatalog: catalog, sources: [] },
    requiredFiles: ['source.txt'], schema: GROUND_TRUTH_REVIEW_SCHEMA, deadlineAt: Date.now() + 20000, active() {}, assertCurrent: async () => {},
    initialWireMode: 'full', bindOperations: operations => structuredClone(operations),
    validateOperations(operations) {
      callbackCalls++;
      try { validateSourceBindings(operations, catalog); } catch (error) { originalError = error; throw error; }
    },
    nativeRun: async params => {
      const tool = name => params.tools.find(item => item.name === name);
      assert.match(tool('save_baseline_batch').description, /Mixed-source authority defaults/);
      assert.match(tool('finish_baseline').description, /ordinary draft completion/);
      const read = await tool('source_read').execute('read-original', { path: 'source.txt' });
      params.observeReceipt({ isSynthetic: false, toolName: 'source_read', toolCallId: 'read-original',
        message: { role: 'toolResult', toolName: 'source_read', toolCallId: 'read-original', isError: false, content: read.content } });
      await assert.rejects(tool('save_baseline_batch').execute('bad-authority', value), error => {
        assert.equal(error, originalError); assert.equal(error.code, 'SOURCE_BINDING_INVALID');
        assert.equal(error.sourceBindingIssues[0].reason, 'NON_USER_AUTHORITY');
        const facts = JSON.parse(error.message.split('\nSource authority navigation: ')[1]);
        assert.equal(facts.issues[0].authorityOrigin, 'defaults'); assert.equal(facts.issues[0].sourceKind, 'MATERIAL');
        assert.equal(facts.issues[0].operationIndex, 0); assert.equal(facts.nextBatchId, 1); return true;
      });
      assert.equal(callbackCalls, 1); assert.deepEqual(value, untouched);
      const state = JSON.parse(toolText(await tool('review_history').execute('state', { mode: 'state' }))).taskState;
      assert.equal(state.repairs, 1); assert.equal(state.batchCount, 0); assert.equal(state.nextBatchId, 1);
      await tool('save_baseline_batch').execute('fixed-authority', { ...value, operations: [{ ...raw, authority: 'MATERIAL_DERIVED' }] });
      await tool('finish_baseline').execute('finish', { batchIds: [1], taskClassification: 'CONTINUATION', summary: 'Explicit source authority repair.' });
    } });
  await worker.execute(); assert.equal(callbackCalls, 2); assert.equal(worker.result.operations[0].authority, 'MATERIAL_DERIVED'); await worker.close();
});

test('pending navigation preserves delimiter lines, genuine ACK status and the original lost-save snapshot', async t => {
  let lost = true, originalReceipt;
  const f = await fixture(t, { wireMode: 'draft', materialText: '---\nname: navigation-fixture\ndescription: Metadata only.\n---\n\nPreserve material condition.',
    faults: { afterBatchPersist(batch) { if (lost) { lost = false; originalReceipt = JSON.parse(JSON.stringify(batch.receipt)); throw new Error('lost navigation acknowledgement'); } } } });
  const defaults = { category: 'requirements', authority: 'USER_EXPLICIT', severity: 'HARD',
    applicabilityKind: 'CURRENT_TASK', verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION' };
  const first = { batchId: 1, defaults, keep: ['S0L1', 'S1L6'],
    overrides: [{ unit: 'S1L6', metadata: { authority: 'MATERIAL_DERIVED' } }],
    exclude: [{ units: ['S1L1', 'S1L2', 'S1L3'], reason: 'Opening YAML delimiter and descriptive frontmatter metadata.' }] };
  const handle = await f.run(async ({ call, readAll, finish }) => {
    const state = async (offset = 0) => JSON.parse(toolText(await call('review_history', { mode: 'state', offset, limit: 3 }))).taskState;
    const unread = await state(), page = await state(3);
    const delimiter = page.pendingNavigation.items.find(item => item.unitId === 'S1L4');
    assert.equal(delimiter.text, '---'); assert.equal(delimiter.acknowledged, false);
    assert.deepEqual(delimiter.sourceRead, { tool: 'source_read', path: 'source-0001-0000.txt', offset: 4, limit: 1 });
    assert.equal(page.metrics.readBytes, 0); assert.equal(page.pendingCount, unread.pendingCount);
    assert.equal(page.pendingNavigation.navigationOnly, true);
    assert(Buffer.byteLength(JSON.stringify(page.pendingNavigation)) <= 4096);
    await readAll();
    await assert.rejects(call('save_baseline_batch', first), /lost navigation acknowledgement/);
    const saved = JSON.parse(toolText(await call('save_baseline_batch', first)));
    assert.deepEqual(saved, originalReceipt); assert.deepEqual(saved.pendingUnits, ['S1L4']);
    assert.equal(saved.pendingNavigation.asOfBatchId, 1); assert.equal(saved.pendingNavigation.nextBatchId, 2);
    assert.equal(saved.pendingNavigation.generation, 0);
    assert.deepEqual(saved.pendingNavigation.items.map(item => [item.unitId, item.text, item.originalLine, item.localLine, item.kind, item.acknowledged]),
      [['S1L4', '---', 4, 4, 'MATERIAL', true]]);
    await assert.rejects(finish([1]), error => error.code === 'BASELINE_INCOMPLETE' && error.message.includes('S1L4'));
    await call('save_baseline_batch', { batchId: 2, exclude: [{ units: ['S1L4'], reason: 'Closing YAML frontmatter delimiter; no business obligation.' }] });
    const current = await state(), replay = JSON.parse(toolText(await call('save_baseline_batch', first))), after = await state();
    assert.deepEqual(replay, originalReceipt); assert.equal(replay.pendingUnitCount, 1);
    assert.equal(current.pendingUnitCount, 0); assert.equal(current.nextBatchId, 3);
    assert.equal(after.pendingUnitCount, 0); assert.equal(after.metrics.readBytes, current.metrics.readBytes);
    assert.equal(after.pendingCount, 0);
    assert.equal(current.batches[0].receiptNavigationOmitted, true);
    assert.equal(Object.hasOwn(current.batches[0], 'pendingNavigation'), false);
    let recovered = '', offset = 0;
    do {
      const page = JSON.parse(toolText(await call('review_history', { mode: 'read', entryId: current.batches[0].recoverWith.entryId, offset, limit: 4000 })));
      recovered += page.text; offset = page.nextOffset;
    } while (offset !== null);
    assert.deepEqual(JSON.parse(recovered).candidateBatch.pendingNavigation, originalReceipt.pendingNavigation);
    assert.equal(Object.hasOwn(replay.preview.items[0], 'expectedFiles'), false);
    await finish([1, 2]);
  });
  assert.equal(handle.result.operations.length, 2);
  assert.equal(handle.result.operations[1].text, 'Preserve material condition.');
  await handle.close();
});

test('full batch feedback reports schema and owner errors together before binding, then repairs the same ID with genuine reads', async t => {
  const f = await fixture(t); f.input.reviewer.formatRepairAttempts = 3;
  const texts = ['The service exposes a status page.', 'Actually execute the supplied verifier before completion.', 'Deliver the requested usage document.'];
  f.input.evidence.snapshot.entries[0].message.content = texts.join('\n');
  const defaults = { operation: 'ADD', authority: 'USER_EXPLICIT', severity: 'HARD', applicabilityKind: 'CURRENT_TASK' };
  const sources = texts.map((_, index) => ({ ref: `transcript:U1#L${index + 1}-L${index + 1}`, kind: 'USER_MESSAGE', subject: 'MAIN_TASK' }));
  const bad = { batchId: 1, defaults, bindings: [], operations: [
    { text: texts[0], category: 42, verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION' },
    { text: texts[1], category: 'requirements', source: sources[1], verificationTarget: 'PROCESS', implementationRole: 'PRODUCTION' },
    { text: texts[2], category: 'requirements', source: sources[2], verificationTarget: 'ARTIFACT', implementationRole: 'PRODUCTION' },
  ] };
  const handle = await f.run(async ({ call, readAll, finish, seen, params }) => {
    assert.match(params.extraSystemPrompt, /Source kind records provenance independently of proof owner/);
    const state = () => call('review_history', { mode: 'state' }).then(result => JSON.parse(toolText(result)).taskState);
    const before = await state();
    await assert.rejects(call('save_baseline_batch', bad), error => {
      assert.equal(error.code, 'BASELINE_SCHEMA_INVALID');
      const pointers = error.baselineValidation.issues.map(issue => issue.pointer);
      for (const pointer of ['/operations/0/category', '/operations/0/source', '/operations/1/implementationRole', '/operations/2/implementationRole'])
        assert(pointers.includes(pointer), pointer);
      assert.equal(error.baselineValidation.truncated, false);
      assert(Buffer.byteLength(error.message) <= 3072); return true;
    });
    const after = await state();
    assert.equal(after.repairs, before.repairs + 1); assert.equal(after.maxRepairs, 3);
    assert.equal(after.deadlineAt, before.deadlineAt); assert.equal(after.nextBatchId, 1); assert.equal(after.batchCount, 0);
    assert.equal(after.metrics.readBytes, 0, 'metadata preview does not grant original reads');
    assert.equal(bad.operations[0].category, 42); assert.equal(bad.operations[1].implementationRole, 'PRODUCTION');
    const fixed = { batchId: 1, defaults: { ...defaults, category: 'requirements' }, bindings: [], operations: texts.map((text, index) => ({
      text, source: sources[index], verificationTarget: ['IMPLEMENTATION', 'PROCESS', 'ARTIFACT'][index], ...(index ? {} : { implementationRole: 'PRODUCTION' }),
    })) };
    await assert.rejects(call('save_baseline_batch', fixed), { code: 'BASELINE_SOURCE_INVALID' });
    assert.equal((await state()).batchCount, 0);
    await readAll();
    const citeIds = [...seen].filter(([file]) => file.startsWith('source-0000')).flatMap(([, ids]) => ids);
    await call('save_baseline_batch', { ...fixed, bindings: texts.map((_, operationIndex) => ({ operationIndex, citeIds })) });
    assert.equal((await state()).nextBatchId, 2); await finish([1]);
  });
  assert.deepEqual(handle.result.operations.map(op => op.verificationTarget), ['IMPLEMENTATION', 'PROCESS', 'ARTIFACT']);
  assert.equal((await loadCurrentGroundTruth(f.root, f.task.taskId)).version, 0); await handle.close();
});

test('bounded full-batch feedback explicitly reports truncation and preserves same-ID recovery', async t => {
  const f = await fixture(t); f.input.reviewer.formatRepairAttempts = 3;
  let originalFeedback;
  const handle = await f.run(async ({ call, readAll, finish, batch }) => {
    const value = { batchId: 1, defaults: { operation: 'ADD', authority: 'USER_EXPLICIT', severity: 'HARD', applicabilityKind: 'CURRENT_TASK', verificationTarget: 'IMPLEMENTATION' },
      operations: Array.from({ length: 70 }, (_, index) => ({ text: `Uncommitted invalid operation ${index}.` })) };
    await assert.rejects(call('save_baseline_batch', value), error => {
      assert.equal(error.code, 'BASELINE_SCHEMA_INVALID');
      assert.equal(error.baselineValidation.issueCount, 210); assert.equal(error.baselineValidation.truncated, true);
      assert(error.baselineValidation.issues.length < 210); assert.match(error.message, /truncated=true/);
      originalFeedback = error.message;
      assert(Buffer.byteLength(error.message) > error.message.length, 'feedback includes real multi-byte schema messages');
      assert(Buffer.byteLength(error.message) <= 3072); return true;
    });
    const publicResult = await call('review_history', { mode: 'state' });
    assert(Buffer.byteLength(toolText(publicResult)) <= 8192);
    const state = JSON.parse(toolText(publicResult)).taskState;
    assert.equal(state.nextBatchId, 1); assert.equal(state.batchCount, 0); assert.equal(state.repairs, 1); assert.equal(state.maxRepairs, 3);
    let recovered = '', offset = 0;
    do {
      const page = JSON.parse(toolText(await call('review_history', { mode: 'read', entryId: state.lastValidationError.recoverWith.entryId, offset, limit: 4000 })));
      recovered += page.text; offset = page.nextOffset;
    } while (offset !== null);
    const validation = JSON.parse(recovered).validation;
    assert.equal(validation.feedback, originalFeedback); assert.equal(validation.issueCount, 210);
    await readAll(); await call('save_baseline_batch', batch()); await finish([1]);
  });
  assert.equal(handle.result.operations.length, 1); await handle.close();
});

test('batch metadata preflight never invokes binding or writes a candidate until a fully valid submission', async t => {
  const scratch = path.resolve('.runtime-correction/stop-baseline-tests'); await fs.mkdir(scratch, { recursive: true });
  const base = await fs.mkdtemp(path.join(scratch, 'preflight-')); t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'frozen'), outputDir = path.join(base, 'worker');
  await fs.mkdir(root); await fs.mkdir(outputDir); await fs.writeFile(path.join(root, 'source.txt'), 'The requested runtime feature.');
  let bindings = 0, writes = 0, worker;
  worker = await createBaselineWorker({ root, outputDir,
    identity: { requestId: 'preflight-test', taskId: 'preflight', baselineVersion: 0, baselineDigest: 'empty', sourceCatalog: [], sources: [] },
    requiredFiles: ['source.txt'], schema: GROUND_TRUTH_REVIEW_SCHEMA, deadlineAt: Date.now() + 20000, active() {}, assertCurrent: async () => {},
    initialWireMode: 'full', bindOperations(operations, selected, registry) {
      bindings++; assert(selected.every(binding => binding.citeIds.every(id => registry.has(id)))); return operations;
    }, faults: { afterBatchPersist() { writes++; } },
    nativeRun: async params => {
      const tool = name => params.tools.find(tool => tool.name === name);
      const invalid = { batchId: 1, defaults: { operation: 'ADD', category: 'requirements', authority: 'USER_EXPLICIT', severity: 'HARD', applicabilityKind: 'CURRENT_TASK' },
        operations: [{ text: 'The requested runtime feature.', verificationTarget: 'IMPLEMENTATION', source: { ref: 'user', kind: 'USER_MESSAGE' } }], bindings: [] };
      await assert.rejects(tool('save_baseline_batch').execute('invalid', invalid), error => {
        assert.equal(error.baselineValidation.reason, 'PROOF_OWNER_REQUIRED');
        assert.deepEqual(error.baselineValidation.fields, ['implementationRole']); return true;
      });
      assert.equal(bindings, 0); assert.equal(writes, 0);
      await assert.rejects(fs.access(path.join(outputDir, 'candidates-0/batch-1.json')), { code: 'ENOENT' });
      const read = await tool('source_read').execute('genuine', { path: 'source.txt' });
      params.observeReceipt({ isSynthetic: false, toolName: 'source_read', toolCallId: 'genuine',
        message: { role: 'toolResult', toolName: 'source_read', toolCallId: 'genuine', isError: false, content: read.content } });
      await tool('save_baseline_batch').execute('valid', { ...invalid, operations: [{ ...invalid.operations[0], implementationRole: 'PRODUCTION' }],
        bindings: [{ operationIndex: 0, citeIds: [read.details.citation.citeId] }] });
      assert.equal(bindings, 1); assert.equal(writes, 1);
      await tool('finish_baseline').execute('finish', { batchIds: [1], taskClassification: 'CONTINUATION', summary: 'Validated candidate only.' });
    } });
  await worker.execute(); assert.equal(worker.result.operations.length, 1); await worker.close();
});

test('full-batch repair exhaustion retains the typed owner cause and bounded feedback without a new attempt', async t => {
  const f = await fixture(t); f.input.reviewer.formatRepairAttempts = 0;
  await assert.rejects(f.run(async ({ call, batch }) => {
    const value = batch(); delete value.operations[0].implementationRole;
    await call('save_baseline_batch', value);
  }), error => {
    assert.equal(error.code, 'BASELINE_REPAIR_LIMIT');
    assert.equal(error.baselineValidation.reason, 'PROOF_OWNER_REQUIRED');
    assert.deepEqual(error.baselineValidation.fields, ['implementationRole']);
    assert.match(error.message, /Reported 1\/1; truncated=false/);
    assert(Buffer.byteLength(error.message) <= 4096); return true;
  });
  assert.equal(f.captures.length, 1);
  const directory = path.join(taskDirectory(f.root, f.task.taskId), 'baseline-task-runs');
  const run = (await fs.readdir(directory))[0];
  const checkpoint = await readJson(path.join(directory, run, 'review-checkpoint.json'));
  assert.equal(checkpoint.taskState.repairs, 0); assert.equal(checkpoint.taskState.maxRepairs, 0);
  assert.equal(checkpoint.taskState.validationFailures, 1); assert.equal(checkpoint.taskState.repairExhausted, true);
  assert.deepEqual(checkpoint.taskState.batches, []);
  await assert.rejects(fs.access(path.join(directory, run, 'candidates-0/finish.json')), { code: 'ENOENT' });
  assert.equal((await loadCurrentGroundTruth(f.root, f.task.taskId)).version, f.truth.version);
});

test('concurrent rejected multi-operation save and legal retry serialize without a partial candidate', async t => {
  let persisted = 0;
  const f = await fixture(t, { faults: { afterBatchPersist() { persisted++; } } });
  f.input.evidence.snapshot.entries[0].message.content = 'The service exposes a status page.\nActually execute the supplied verifier before completion.';
  const handle = await f.run(async ({ call, readAll, finish, seen, params }) => {
    await readAll();
    const citeIds = [...seen].filter(([file]) => file.startsWith('source-0000')).flatMap(([, ids]) => ids);
    const value = { batchId: 1, defaults: { operation: 'ADD', category: 'requirements', authority: 'USER_EXPLICIT', severity: 'HARD', applicabilityKind: 'CURRENT_TASK' },
      operations: [
        { text: 'The service exposes a status page.', verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION', source: { ref: 'transcript:U1#L1-L1', kind: 'USER_MESSAGE' } },
        { text: 'Actually execute the supplied verifier before completion.', verificationTarget: 'PROCESS', implementationRole: 'PRODUCTION', source: { ref: 'transcript:U1#L2-L2', kind: 'USER_MESSAGE' } },
      ], bindings: [0, 1].map(operationIndex => ({ operationIndex, citeIds })) };
    const { implementationRole: _role, ...processDuty } = value.operations[1];
    const before = JSON.parse(toolText(await call('review_history', { mode: 'state' }))).taskState;
    const result = await Promise.allSettled([
      call('save_baseline_batch', value), call('save_baseline_batch', { ...value, operations: [value.operations[0], processDuty] }),
    ]);
    assert.equal(result[0].status, 'rejected'); assert.equal(result[0].reason.baselineValidation.reason, 'NON_IMPLEMENTATION_ROLE');
    assert.equal(result[1].status, 'fulfilled'); assert.equal(JSON.parse(toolText(result[1].value)).saved, true);
    assert.equal(persisted, 1);
    const saved = await readJson(path.join(params.cwd, '../candidates-0/batch-1.json'));
    assert.equal(saved.operations.length, 2); assert.equal(saved.operations[1].implementationRole, undefined);
    const after = JSON.parse(toolText(await call('review_history', { mode: 'state' }))).taskState;
    assert.equal(after.batchCount, 1); assert.equal(after.nextBatchId, 2); assert.equal(after.repairs, before.repairs + 1);
    assert.equal(after.maxRepairs, before.maxRepairs); assert.equal(after.deadlineAt, before.deadlineAt);
    await finish([1]);
  });
  assert.equal(handle.result.operations[1].verificationTarget, 'PROCESS'); await handle.close();
});

test('draft cannot save a new claim without an explicit target and can repair the same unsaved batch', async t => {
  const f = await fixture(t, { wireMode: 'draft' });
  const handle = await f.run(async ({ call, readAll, finish }) => {
    await readAll();
    const value = { batchId: 1, defaults: { category: 'requirements', authority: 'USER_EXPLICIT', severity: 'HARD', applicabilityKind: 'CURRENT_TASK' },
      keep: ['S0L1'], exclude: [{ units: ['S1L1'], reason: 'Unadopted material.' }] };
    const state = () => call('review_history', { mode: 'state' }).then(result => JSON.parse(toolText(result)).taskState);
    const before = await state();
    await assert.rejects(call('save_baseline_batch', value), error => {
      assert.equal(error.code, 'BASELINE_SCOPE_INVALID'); assert.equal(error.baselineValidation.reason, 'PROOF_OWNER_REQUIRED');
      assert.match(error.message, /verificationTarget/); return true;
    });
    const after = await state();
    assert.equal(after.batchCount, 0); assert.deepEqual(after.pendingUnits, before.pendingUnits);
    assert.equal(after.repairs, before.repairs + 1); assert.equal(after.deadlineAt, before.deadlineAt);
    assert.equal(after.maxRepairs, before.maxRepairs); assert.equal(after.metrics.readBytes, before.metrics.readBytes);
    assert.equal(value.defaults.verificationTarget, undefined);
    await call('save_baseline_batch', { ...value, defaults: { ...value.defaults, verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION' } });
    await finish([1]);
  });
  assert.equal(handle.result.operations[0].verificationTarget, 'IMPLEMENTATION'); await handle.close();
});

for (const encoding of ['synthesis', 'selection', 'compact']) for (const invalid of ['missing-target', 'PROCESS', 'ARTIFACT'])
test(`${encoding} rejects ${invalid} metadata in a later operation without saving a half batch`, async t => {
  const f = await fixture(t, { wireMode: encoding === 'compact' ? 'compact' : 'full' });
  const target = invalid === 'ARTIFACT' ? 'ARTIFACT' : 'PROCESS';
  const second = target === 'ARTIFACT' ? 'Deliver the requested usage document.' : 'Actually run the supplied verifier before completion.';
  f.input.evidence.snapshot.entries[0].message.content = 'The service exposes a status page.\n' + second;
  const defaults = { operation: 'ADD', category: 'requirements', authority: 'USER_EXPLICIT', severity: 'HARD', applicabilityKind: 'CURRENT_TASK',
    ...(invalid === 'missing-target' ? {} : { verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION' }) };
  const firstMeta = invalid === 'missing-target' ? { verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION' } : {};
  const secondMeta = invalid === 'missing-target' ? {} : { verificationTarget: target };
  const handle = await f.run(async ({ call, readAll, finish, seen, params }) => {
    await readAll();
    const make = (shared, metadata) => ({ batchId: 1, defaults: shared, ...(encoding === 'compact'
      ? { outcomes: metadata.map((meta, index) => ({ name: index ? 'Task duty' : 'Runtime feature', sourceIndex: 0, lines: [index + 1, index + 1], metadata: meta })) }
      : { operations: metadata.map((meta, index) => ({ ...meta, ...(encoding === 'selection'
        ? { outcome: index ? 'Task duty' : 'Runtime feature', textFrom: { sourceIndex: 0, start: index + 1, end: index + 1 } }
        : { text: index ? second : 'The service exposes a status page.', source: { ref: `transcript:U1#L${index + 1}-L${index + 1}`, kind: 'USER_MESSAGE', subject: 'MAIN_TASK' } }) })),
        ...(encoding === 'synthesis' ? { bindings: metadata.map((_, operationIndex) => ({ operationIndex,
          citeIds: [...seen].filter(([file]) => file.startsWith('source-0000')).flatMap(([, ids]) => ids) })) } : {}) }) });
    const value = make(defaults, [firstMeta, secondMeta]);
    const state = () => call('review_history', { mode: 'state' }).then(result => JSON.parse(toolText(result)).taskState);
    const before = await state();
    await assert.rejects(call('save_baseline_batch', value), error => {
      assert.equal(error.code, 'BASELINE_SCOPE_INVALID');
      assert.equal(error.baselineValidation.reason, invalid === 'missing-target' ? 'PROOF_OWNER_REQUIRED' : 'NON_IMPLEMENTATION_ROLE');
      assert.deepEqual(error.baselineValidation.fields, [invalid === 'missing-target' ? 'verificationTarget' : 'implementationRole']);
      if (invalid !== 'missing-target') {
        assert.match(error.message, /Remove implementationRole from shared defaults/);
        assert.match(error.message, /operation, per-unit override or split-group metadata, or use separate batches/);
        assert.match(error.message, /do not change the actual verificationTarget/);
      }
      return true;
    });
    const after = await state();
    assert.equal(after.batchCount, 0); assert.equal(after.repairs, before.repairs + 1);
    assert.equal(after.deadlineAt, before.deadlineAt); assert.equal(after.maxRepairs, before.maxRepairs);
    assert.equal(after.metrics.readBytes, before.metrics.readBytes);
    const candidate = path.join(params.cwd, '../candidates-0/batch-1.json');
    await assert.rejects(fs.access(candidate), { code: 'ENOENT' });
    assert.equal(defaults.implementationRole, invalid === 'missing-target' ? undefined : 'PRODUCTION', 'tool never silently cleans defaults');
    const { implementationRole: _role, ...neutral } = defaults;
    await call('save_baseline_batch', make(neutral, [
      { verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION' }, { verificationTarget: target },
    ]));
    await finish([1]);
  });
  assert.deepEqual(handle.result.operations.map(op => op.verificationTarget), ['IMPLEMENTATION', target]);
  assert.equal(handle.result.operations[1].implementationRole, undefined);
  assert.equal((await loadCurrentGroundTruth(f.root, f.task.taskId)).version, 0);
  await handle.close();
});

for (const target of ['PROCESS', 'ARTIFACT']) test(`draft ${target} role leakage gives a viable same-batch repair`, async t => {
  const f = await fixture(t, { wireMode: 'draft' });
  const duty = target === 'PROCESS' ? ' actually execute the supplied verifier.' : ' deliver the requested usage document.';
  f.input.evidence.snapshot.entries[0].message.content = 'The service exposes a status page;' + duty;
  const defaults = { category: 'requirements', authority: 'USER_EXPLICIT', severity: 'HARD', applicabilityKind: 'CURRENT_TASK',
    verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION' };
  const handle = await f.run(async ({ call, readAll, finish }) => {
    await readAll();
    const value = { batchId: 1, defaults, split: [{ unit: 'S0L1', groups: [
      { name: 'Runtime feature', clauses: [0] }, { name: 'Task duty', clauses: [1], metadata: { verificationTarget: target } },
    ] }], exclude: [{ units: ['S1L1'], reason: 'Unadopted material.' }] };
    const state = () => call('review_history', { mode: 'state' }).then(result => JSON.parse(toolText(result)).taskState);
    const before = await state();
    await assert.rejects(call('save_baseline_batch', value), error => {
      assert.equal(error.baselineValidation.reason, 'NON_IMPLEMENTATION_ROLE');
      assert.match(error.message, /Remove implementationRole from shared defaults/); return true;
    });
    const after = await state();
    assert.equal(after.batchCount, 0); assert.deepEqual(after.pendingUnits, before.pendingUnits);
    assert.equal(after.repairs, before.repairs + 1); assert.equal(after.maxRepairs, before.maxRepairs);
    assert.equal(after.deadlineAt, before.deadlineAt); assert.equal(after.metrics.readBytes, before.metrics.readBytes);
    const { implementationRole, ...neutral } = defaults;
    await call('save_baseline_batch', { ...value, defaults: neutral, split: [{ unit: 'S0L1', groups: [
      { name: 'Runtime feature', clauses: [0], metadata: { implementationRole } }, value.split[0].groups[1],
    ] }] }); await finish([1]);
  });
  assert.equal(handle.result.operations[0].implementationRole, 'PRODUCTION');
  assert.equal(handle.result.operations[1].verificationTarget, target);
  assert.equal(handle.result.operations[1].implementationRole, undefined); await handle.close();
});

const lifecycleOriginal = 'This lifecycle fixture describes an unchanged environment; it requests no new task action.';
function stopFixtureOriginalDuties({ source, unit, fullText, originals }, { declaredMaterial, auditOrdinal, ownerTransitionTarget } = {}) {
  const duty = (statement, owner, condition = 'During this task.') => ({ statement, owner, condition });
  if (ownerTransitionTarget && source.kind === 'USER_MESSAGE') return [{ ...duty(unit.text,
    auditOrdinal === 1 ? 'IMPLEMENTATION' : ownerTransitionTarget), reason: auditOrdinal === 1
      ? 'KNOWN_SEMANTIC_ERROR: deliberately wrong source-only model judgement, frozen before candidate disclosure, solely to test historical owner revision mechanics. This PASS is not semantic correctness evidence.'
      : 'Correct independent source interpretation for the later structural owner revision.' }];
  if (fullText === lifecycleOriginal || fullText === 'Original material condition.' || fullText === declaredMaterial
    && (declaredMaterial.startsWith('0: Original condition ') || declaredMaterial.startsWith('# Demonstration only; not a required business action.'))) return [];
  if (fullText === 'Preserve the requested feature.' || fullText === 'Please preserve the requested feature.') return [duty(unit.text, 'IMPLEMENTATION')];
  if (fullText === 'Cancel orphan tasks before publishing.') return [duty(unit.text, 'PROCESS', 'Before publishing.')];
  if (fullText === '创建订单时品种和数量必填，备注可空。\n数量必须为正整数，字段非法时拒绝创建且不得预留库存。')
    return [duty(unit.text, 'IMPLEMENTATION')];
  if (fullText === '空闲10分钟释放提取agent。\n并发请求排队，项目之间隔离。') {
    assert.equal(unit.text, fullText, 'Release and queue/isolation obligations share one neutral block');
    const corrected = originals.some(original => original.fullText === '空闲释放改为15分钟，其余要求保持不变。');
    return [duty(corrected ? '空闲释放改为15分钟，其余要求保持不变。' : '空闲10分钟释放提取agent。', 'IMPLEMENTATION',
      corrected ? '提取agent空闲15分钟时释放，其余要求保持不变。' : '提取agent空闲10分钟时释放。'),
      duty('并发请求排队，项目之间隔离。', 'IMPLEMENTATION', '并发请求时排队，项目之间保持隔离。')];
  }
  if (fullText === '空闲释放改为15分钟，其余要求保持不变。') return [duty(unit.text, 'IMPLEMENTATION')];
  const mixed = 'Implement next(value) according to materials/contract.md, preserving every condition and explicit exclusion, AND actually run the provided verifier with node materials/verify.mjs in this project and establish exit code 0 before declaring completion.';
  if (fullText === mixed) return [
    duty('Implement next(value) according to materials/contract.md, preserving every condition and explicit exclusion.', 'IMPLEMENTATION'),
    duty('Before declaring completion, actually run the provided verifier with node materials/verify.mjs in this project and establish exit code 0.', 'PROCESS', 'Before declaring completion, run the supplied verifier in this project and establish exit code 0.')];
  if (fullText === 'Implement next(value) for integers 0 through 9. Return value + 1 without storing state. Input handling outside that range is out of scope.\nAll imports and processing stay local. Do not send data over a network.\n')
    return [duty('Implement next(value) for integers 0 through 9. Return value + 1 without storing state. Input handling outside that range is out of scope.', 'IMPLEMENTATION'),
      duty('All imports and processing stay local. Do not send data over a network.', 'IMPLEMENTATION')];
  throw new Error(`Missing authored source-only expectation for ${source.kind}:${source.ref}; never infer it from candidate ownership`);
}

async function fixture(t, { large = false, materialText, materialRelativePath = 'requirements.md', faults, wireMode = 'full', businessRoot = false, originalText, ownerTransitionTarget, inventoryInterpretation, coverageReport } = {}) {
  const scratch = businessRoot ? path.join(os.tmpdir(), 'rc-owner-business-tests') : path.resolve('.runtime-correction/stop-baseline-tests'); await fs.mkdir(scratch, { recursive: true });
  const root = await fs.realpath(await fs.mkdtemp(path.join(scratch, 'run-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const task = await ensureTask({ projectRoot: root, sessionId: 'baseline-test' });
  await withTaskState({ projectRoot: root, taskId: task.taskId }, state => { state.control ??= {}; });
  const truth = await loadCurrentGroundTruth(root, task.taskId);
  const truthPath = path.join(taskDirectory(root, task.taskId), 'ground-truth/current.json');
  await atomicWriteJson(truthPath, truth);
  const material = path.join(root, materialRelativePath); await fs.mkdir(path.dirname(material), { recursive: true });
  const regression = JSON.parse(await fs.readFile('test/fixtures/stop-baseline-budget.json', 'utf8'));
  const text = materialText ?? (large ? Array.from({ length: Math.ceil(regression.observedCumulativeBytes / 64) + 100 }, (_, i) => `${i}: Original condition ${'x'.repeat(68)}`).join('\n') : 'Original material condition.');
  await fs.writeFile(material, text);
  let registry; const hooks = new Map();
  const api = { rootDir: path.resolve('.'), config: { agents: { defaults: { model: { primary: 'fixture/model' }, compaction: { mode: 'safeguard' } } },
    models: { providers: { fixture: { models: [{ id: 'model', contextWindow: 200000, maxTokens: 65536 }] } } } },
    runtime: { version: '2026.7.1-2', agent: {} }, logger: { warn() {}, info() {} },
    registerTool(factory, metadata) { registry = factory; assert(metadata.names.includes('finish_baseline')); },
    on(name, callback) { hooks.set(name, callback); },
  };
  registerTaskTools(api);
  const input = { projectRoot: root, taskId: task.taskId, parentSessionId: 'baseline-test', role: 'ground-truth-extractor',
    reviewer: { timeoutMs: 20000, formatRepairAttempts: 4 }, schema: GROUND_TRUTH_REVIEW_SCHEMA,
    request: { taskId: task.taskId, hookEventId: 'event-1', lastUserCursor: 'U1', hook: { hook_event_name: 'Stop' },
      currentGroundTruth: { path: truthPath, version: truth.version, digest: truth.digest },
      sourceCatalog: [{ ref: 'transcript:U1', kind: 'USER_MESSAGE', aliases: ['U1'] }, { ref: material.replaceAll('\\', '/'), kind: 'MATERIAL', projectRelativePath: materialRelativePath, aliases: [materialRelativePath] }],
      reviewScope: { kind: 'baseline', boundedBasis: true }, instructions: ['Preserve source authority.'] },
    evidence: { groundTruth: truth, snapshot: { entries: [{ type: 'user', uuid: 'U1', message: { role: 'user', content: originalText ?? 'Preserve the requested feature.' } }] } } };
  let params, tools, callId = 0, auditOrdinal = 0;
  const captures = [], seen = new Map();
  const ctx = () => ({ sessionId: params.sessionId, sessionKey: params.sessionKey });
  async function call(name, args, { persist = true, synthetic = false, notify = true } = {}) {
    const id = `call-${++callId}`; params.onAssistantMessageStart();
    await fs.appendFile(params.sessionFile, JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: args }] } }) + '\n');
    const result = await tools.find(tool => tool.name === name).execute(id, args);
    const message = { role: 'toolResult', toolName: name, toolCallId: id, content: result.content, details: result.details, isError: Boolean(result.isError) };
    if (persist) {
      hooks.get('tool_result_persist')({ toolName: name, toolCallId: id, isSynthetic: synthetic, message }, ctx());
      await fs.appendFile(params.sessionFile, JSON.stringify({ type: 'message', message }) + '\n');
    }
    if (notify) params.onAgentToolResult({ toolName: name, result, isError: false });
    return result;
  }
  async function readAll({ numberedSources = false } = {}) {
    const prompt = JSON.parse(params.prompt);
    for (const file of prompt.requiredFiles) {
      let offset = 1;
      do {
        const result = await call('source_read', { path: file, offset, ...(numberedSources && file.startsWith('source-') ? { numbered: true } : {}) });
        seen.set(file, [...(seen.get(file) ?? []), result.details.citation.citeId]);
        offset = result.details.page.nextOffset;
      } while (offset);
    }
    return prompt;
  }
  const batch = () => ({ batchId: 1, operations: [operation()], bindings: [{ operationIndex: 0,
    citeIds: [...seen].filter(([file]) => file.startsWith('source-0000')).flatMap(([, ids]) => ids) }] });
  const finish = ids => call('finish_baseline', { batchIds: ids, taskClassification: ids.length ? 'CONTINUATION' : 'NO_CHANGE', summary: 'Completed extraction.' });
  const makeFactory = script => {
    const factory = createOpenClawReviewerFactory(api, { stopReviewEngine: 'task', baselineFaults: faults, baselineWireMode: wireMode,
      runEmbeddedAgent: async value => {
        if (value.toolsAllow?.includes('source_read') && !value.toolsAllow.includes('finish_baseline')) {
          const ordinal = ++auditOrdinal; // Preauthored scenario order, never candidate-derived.
          return runNativeCoverageFixture({ params: value, registry, hooks,
            ...(coverageReport ? { report: coverageReport } : {}),
            inventory: context => scriptedSourceInventory(context, inventoryInterpretation ?? (original => stopFixtureOriginalDuties(original,
              { declaredMaterial: text, auditOrdinal: ordinal, ownerTransitionTarget }))) });
        }
        params = value; captures.push(value); tools = registry(ctx());
        await fs.access(value.sessionFile).catch(() => fs.writeFile(value.sessionFile, JSON.stringify({ type: 'session', version: 3, id: value.sessionId }) + '\n'));
        assert.equal(value.config.agents.defaults.models['fixture/model'].params.maxTokens, 32768);
        assert.deepEqual(value.toolsAllow, BASELINE_TOOL_NAMES); assert.equal(value.config.agents.defaults.compaction.mode, 'safeguard');
        assert(REVIEWER_NATIVE_TOOL_DENY.every(name => value.config.tools.deny.includes(name)));
        assert.equal(value.config.tools.codeMode.enabled, false);
        for (const name of ['write', 'edit', 'exec', 'code_execution', 'mcp__files__write_file'])
          assert.equal((await observeInternalTool(name, {})).block, true, `baseline must block ${name}`);
        assert.equal(await observeInternalTool('source_read', {}), undefined);
        assert.equal(registry({ sessionKey: 'agent:main:business', sessionId: 'business' }), null);
        try { await script({ call, readAll, batch, finish, params: value, hooks, ctx, seen }); }
        catch (error) { if (error.code === 'ERR_ASSERTION') t.diagnostic(error.stack); throw error; }
        return { payloads: [], meta: {} };
      } });
    return factory;
  };
  const audit = handle => auditBaselineFixture({ handle, factory: makeFactory(() => assert.fail('Audit must not run the extraction script')),
    input, current: input.evidence.groundTruth });
  let stage = 0;
  const run = async script => {
    input.request.hookEventId = `event-${++stage}`;
    const handle = await makeFactory(script)(input);
    auditFixtures.set(handle.baselineTask.requestId, { handle, audit: () => audit(handle) });
    t.after(() => auditFixtures.delete(handle.baselineTask.requestId));
    return handle;
  };
  return { root, task, truth, truthPath, material, input, api, run, audit, makeFactory, captures, hooks, registry: () => registry };
}

async function consumedUserFixture(t, wireMode) {
  const f = await fixture(t, { wireMode, businessRoot: true });
  await applyGroundTruthDelta({ projectRoot: f.root, taskId: f.task.taskId, sourceCatalog: f.input.request.sourceCatalog,
    delta: { summary: 'Actual initial USER admission.', taskClassification: 'NEW_TASK', operations: [operation()] } });
  const truth = await loadCurrentGroundTruth(f.root, f.task.taskId);
  f.input.evidence.groundTruth = truth;
  f.input.request.currentGroundTruth = { path: f.truthPath, version: truth.version, digest: truth.digest };
  return f;
}

async function checkedCriticalRun(f, script) {
  let scriptFailure;
  try {
    const handle = await f.run(async (...args) => { try { await script(...args); } catch (error) { scriptFailure = error; throw error; } });
    if (scriptFailure) { await handle.close(); throw scriptFailure; }
    return handle;
  } catch (error) { throw scriptFailure ?? error; }
}

test('full-mode nonempty completion treats unselected source locations as navigation while still requiring complete original reads', async t => {
  const f = await fixture(t, { wireMode: 'full', originalText: 'Preserve the requested feature.\n# Background heading\nInformative example only.' });
  const handle = await checkedCriticalRun(f, async ({ call, readAll, batch, finish, params }) => {
    assert.match(params.extraSystemPrompt, /including NONEMPTY deltas/);
    await assert.rejects(finish([]));
    await readAll();
    const receipt = JSON.parse(toolText(await call('save_baseline_batch', batch())));
    assert.equal(receipt.decisionCoverageRequired, false); assert(receipt.pendingUnitCount > 0);
    assert.equal(receipt.pendingNavigation.decisionCoverageRequired, false);
    assert.match(receipt.pendingNavigation.instruction, /NOT missing duties or a completion gate/);
    const state = JSON.parse(toolText(await call('review_history', { mode: 'state' }))).taskState;
    assert.equal(state.decisionCoverageRequired, false); assert.equal(state.pendingCount, 0);
    await finish([1]);
  });
  assert.equal(handle.result.operations.length, 1); assert.equal(handle.result.operations[0].text, operation().text);
  await handle.close();
});

test('ordinary draft pending guidance permits explicit revision without changing its reads or allowance', async t => {
  const f = await fixture(t, { wireMode: 'draft' }); let revised = false, prior;
  const defaults = { category: 'requirements', authority: 'USER_EXPLICIT', severity: 'HARD',
    applicabilityKind: 'CURRENT_TASK', verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION' };
  const handle = await f.run(async ({ call, readAll, finish }) => {
    const state = async () => JSON.parse(toolText(await call('review_history', { mode: 'state' }))).taskState;
    if (!revised) {
      await readAll(); await call('save_baseline_batch', { batchId: 1, defaults, keep: ['S0L1'] });
      prior = await state(); assert.equal(prior.pendingUnitCount, 1);
      assert.equal(prior.pendingNavigation.nextBatchId, 2);
      assert.match(prior.pendingNavigation.instruction, /Ordinary draft completion/);
      const ack = JSON.parse(toolText(await call('finish_baseline', { batchIds: [1], taskClassification: 'CONTINUATION',
        summary: 'Explicit candidate reconsideration with pending material.', reviseCandidate: { generation: 0, reason: 'Recompare the candidate with complete originals.' } })));
      assert.equal(ack.complete, false); assert.equal(ack.toGeneration, 1);
      const current = await state(); assert.equal(current.generation, 1); assert.equal(current.nextBatchId, 1);
      assert.equal(current.pendingUnitCount, 2); assert.equal(current.pendingCount, 0);
      assert.equal(current.repairs, prior.repairs + 1); assert.equal(current.deadlineAt, prior.deadlineAt);
      assert.equal(current.metrics.readBytes, prior.metrics.readBytes); revised = true; return;
    }
    await call('save_baseline_batch', { batchId: 1, defaults, keep: ['S0L1'],
      exclude: [{ units: ['S1L1'], reason: 'Unadopted material context.' }] });
    await finish([1]);
  });
  assert.equal(f.captures.length, 2); assert.equal(handle.result.operations.length, 1); await handle.close();
});

test('critical-path candidate preview and explicit revision preserve source reads and charge one repair across lost ACK', async t => {
  let lost = true, control, firstState, originalValue, preview;
  const f = await fixture(t, { wireMode: 'draft', businessRoot: true, faults: { afterRevisionPersist() {
    if (lost) { lost = false; throw new Error('lost revision acknowledgement'); }
  } } });
  f.input.request.sourceCatalog.splice(1);
  const original = 'Implement app.mjs and complete docs/guide.md according to the complete original contract in requirements/original-contract.md.';
  f.input.evidence.snapshot.entries[0].message.content = original;
  // Exact malformed USER operation from normal response3, isolated to its
  // original source unit. The correct scripted output below is mechanism only.
  originalValue = { batchId: 1, defaults: { authority: 'USER_EXPLICIT', category: 'requirements', severity: 'HARD' }, operations: [{
    applicabilityKind: 'CURRENT_TASK', expectedFiles: ['app.mjs', 'docs/guide.md'], implementationRole: 'PRODUCTION',
    sourceFrom: { unitId: 'S0L1' }, text: original, verificationTarget: 'IMPLEMENTATION' }] };
  const untouched = structuredClone(originalValue);
  const handle = await checkedCriticalRun(f, async ({ readAll, call, finish, seen }) => {
    if (!control) {
      await readAll(); const receipt = JSON.parse(toolText(await call('save_baseline_batch', originalValue)));
      preview = receipt.preview; assert.ok(preview, 'durable effective candidate preview is missing');
      assert.equal(preview.items[0].text, original); assert.equal(preview.items[0].verificationTarget, 'IMPLEMENTATION');
      assert.equal(preview.navigationOnly, true); assert(Buffer.byteLength(JSON.stringify(preview)) <= 4096);
      const history = JSON.parse(toolText(await call('review_history', { mode: 'read', entryId: preview.historyEntryId })));
      assert(history); firstState = JSON.parse(toolText(await call('review_history', { mode: 'state' }))).taskState;
      control = { batchIds: [1], taskClassification: 'CONTINUATION', summary: 'Candidate scope needs explicit revision.', reviseCandidate: { generation: 0, reason: 'One original clause contains implementation and guide owners.' } };
      await assert.rejects(call('finish_baseline', control), /lost revision acknowledgement/);
      const ack = JSON.parse(toolText(await call('finish_baseline', control)));
      assert.equal(ack.complete, false); assert.equal(ack.fromGeneration, 0); assert.equal(ack.toGeneration, 1);
      const current = JSON.parse(toolText(await call('review_history', { mode: 'state' }))).taskState;
      assert.equal(current.generation, 1); assert.equal(current.repairs, 1); assert.equal(current.batchCount, 0);
      assert.equal(current.deadlineAt, firstState.deadlineAt); assert.equal(current.pendingCount, 0); return;
    }
    assert(seen.size > 0);
    const corrected = { ...originalValue, operations: [
      { ...originalValue.operations[0], text: 'Implement app.mjs according to the complete original contract in requirements/original-contract.md.', expectedFiles: ['app.mjs'] },
      { text: 'Complete docs/guide.md according to the complete original contract in requirements/original-contract.md.', applicabilityKind: 'CURRENT_TASK', verificationTarget: 'ARTIFACT', expectedFiles: ['docs/guide.md'], sourceFrom: { unitId: 'S0L1' } },
    ] };
    await call('save_baseline_batch', corrected);
    const stateBeforeReplay = JSON.parse(toolText(await call('review_history', { mode: 'state' }))).taskState;
    await call('finish_baseline', control);
    const stateAfterReplay = JSON.parse(toolText(await call('review_history', { mode: 'state' }))).taskState;
    for (const key of ['generation', 'repairs', 'deadlineAt', 'batchCount', 'nextBatchId', 'pendingCount']) assert.deepEqual(stateAfterReplay[key], stateBeforeReplay[key]);
    await finish([1]);
  });
  assert.deepEqual(originalValue, untouched); assert.equal(f.captures.length, 2);
  assert.equal(f.captures[0].sessionId, f.captures[1].sessionId);
  assert.equal(handle.result.operations.length, 2);
  assert.deepEqual(handle.result.operations.map(op => op.verificationTarget), ['IMPLEMENTATION', 'ARTIFACT']);
  await handle.close();
});

test('critical-path preview is byte-bounded and recovers complete UTF8 candidates through existing history', async t => {
  const f = await fixture(t), text = '完整原文义务。'.repeat(350);
  f.input.evidence.snapshot.entries[0].message.content = text;
  const handle = await checkedCriticalRun(f, async ({ readAll, call, batch, finish }) => {
    await readAll(); const value = batch(); value.operations[0].text = text;
    const saved = JSON.parse(toolText(await call('save_baseline_batch', value)));
    assert.equal(saved.preview.truncated, true); assert(Buffer.byteLength(JSON.stringify(saved.preview)) <= 4096);
    const navigation = JSON.parse(toolText(await call('review_history', { mode: 'state' }))).taskState.pendingNavigation;
    const originalUnit = navigation.items.find(item => item.unitId === 'S0L1');
    assert.equal(originalUnit.acknowledged, true); assert.equal(Object.hasOwn(originalUnit, 'text'), false);
    assert(originalUnit.textOmitted); assert.equal(originalUnit.sourceRead.path, 'source-0000-0000.txt');
    assert(Buffer.byteLength(JSON.stringify(navigation)) <= 4096);
    let offset = 0, full = '';
    do {
      const page = JSON.parse(toolText(await call('review_history', { mode: 'read', entryId: saved.preview.historyEntryId, offset, limit: 2048 })));
      full += page.text; offset = page.nextOffset;
    } while (offset !== null);
    assert.equal(JSON.parse(full).operations[0].text, text); await finish([1]);
  });
  assert.equal(f.captures.length, 1, 'ordinary candidates do not require another model invocation'); await handle.close();
});

for (const mode of ['batch-tamper', 'control-tamper', 'changed-control', 'baseline-change', 'completed']) {
  test(`critical-path candidate revision rejects ${mode} and exact replay never reloads old batches`, async t => {
    const f = await fixture(t); let control, receipt;
    const handle = await checkedCriticalRun(f, async ({ readAll, call, batch, finish, params }) => {
      if (!control) {
        await readAll(); await call('save_baseline_batch', batch());
        control = { batchIds: [1], taskClassification: 'CONTINUATION', summary: 'Explicit candidate control.', reviseCandidate: { generation: 0, reason: 'Reconsider candidate scope.' } };
        receipt = toolText(await call('finish_baseline', control)); return;
      }
      await call('save_baseline_batch', batch());
      const state = async () => JSON.parse(toolText(await call('review_history', { mode: 'state' }))).taskState;
      const before = await state();
      if (mode === 'batch-tamper' || mode === 'control-tamper') {
        const file = path.resolve(params.cwd, `../candidates-0/${mode === 'batch-tamper' ? 'batch-1.json' : 'revision.json'}`), bytes = await fs.readFile(file);
        const changed = JSON.parse(bytes);
        if (mode === 'batch-tamper') changed.operations[0].text = 'Tampered historical candidate.';
        else changed.receipt.toGeneration = 900;
        await fs.writeFile(file, JSON.stringify(changed));
        await assert.rejects(call('finish_baseline', control), { code: mode === 'batch-tamper' ? 'BASELINE_CANDIDATE_INVALID' : 'BASELINE_REVISION_CONFLICT' });
        await fs.writeFile(file, bytes);
      } else if (mode === 'changed-control') {
        await assert.rejects(call('finish_baseline', { ...control, summary: 'Different control input.' }), { code: 'BASELINE_REVISION_CONFLICT' });
      } else if (mode === 'baseline-change') {
        const bytes = await fs.readFile(f.truthPath); await atomicWriteJson(f.truthPath, { ...f.truth, version: 9 });
        await assert.rejects(call('finish_baseline', control), { code: 'BASELINE_INPUT_CHANGED' }); await fs.writeFile(f.truthPath, bytes);
      }
      assert.equal(toolText(await call('finish_baseline', control)), receipt);
      const after = await state();
      for (const key of ['generation', 'batches', 'batchCount', 'nextBatchId', 'deadlineAt', 'pendingCount', 'maxTurns', 'maxTokens']) assert.deepEqual(after[key], before[key]);
      await finish([1]);
      if (mode === 'completed') await assert.rejects(call('finish_baseline', control));
    });
    assert.equal(handle.result.operations.length, 1); await handle.close();
  });
}

test('critical-path candidate revision cannot reset its allowance or drop undecided original units', async t => {
  const exhausted = await fixture(t); exhausted.input.reviewer.formatRepairAttempts = 0; let oldDirectory;
  await assert.rejects(checkedCriticalRun(exhausted, async ({ readAll, call, batch, params }) => {
    await readAll(); await call('save_baseline_batch', batch()); oldDirectory = path.resolve(params.cwd, '../candidates-0');
    await call('finish_baseline', { batchIds: [1], taskClassification: 'CONTINUATION', summary: 'No allowance.', reviseCandidate: { generation: 0, reason: 'Explicit revision.' } });
  }), { code: 'BASELINE_REPAIR_LIMIT' });
  await assert.rejects(fs.access(path.join(oldDirectory, 'revision.json')), { code: 'ENOENT' });
  const f = await fixture(t, { wireMode: 'draft' }); let revised = false;
  const value = { batchId: 1, defaults: { category: 'requirements', severity: 'HARD', authority: 'USER_EXPLICIT' }, operations: [{
    text: 'Preserve the requested feature.', sourceFrom: { unitId: 'S0L1' }, applicabilityKind: 'CURRENT_TASK', verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION' }] };
  const handle = await checkedCriticalRun(f, async ({ readAll, call, finish }) => {
    if (!revised) {
      await readAll(); await call('save_baseline_batch', value);
      await call('finish_baseline', { batchIds: [1], taskClassification: 'CONTINUATION', summary: 'Keep every source.', reviseCandidate: { generation: 0, reason: 'Explicit revision.' } });
      revised = true; return;
    }
    await call('save_baseline_batch', value);
    await assert.rejects(finish([1]), { code: 'BASELINE_INCOMPLETE' });
    await call('save_baseline_batch', { batchId: 2, defaults: { ...value.defaults, applicabilityKind: 'CURRENT_TASK' }, exclude: [{ units: ['S1L1'], reason: 'Original material condition is descriptive context; no mandatory action is adopted.' }] });
    await finish([1, 2]);
  });
  assert.equal(handle.result.operations.length, 1); await handle.close();
});

test('critical-path a prior revision control becomes stale after a second explicit revision', async t => {
  const f = await fixture(t); let first;
  const handle = await checkedCriticalRun(f, async ({ readAll, call, batch, finish, params }) => {
    const generation = JSON.parse(params.prompt).generation;
    if (generation === 0) await readAll();
    await call('save_baseline_batch', batch());
    if (generation < 2) {
      const control = { batchIds: [1], taskClassification: 'CONTINUATION', summary: `Generation ${generation} control.`, reviseCandidate: { generation, reason: 'Explicit bounded revision.' } };
      if (generation === 0) first = control;
      await call('finish_baseline', control); return;
    }
    await assert.rejects(call('finish_baseline', first), { code: 'BASELINE_REVISION_CONFLICT' });
    const state = JSON.parse(toolText(await call('review_history', { mode: 'state' }))).taskState;
    assert.equal(state.generation, 2); assert.equal(state.batchCount, 1); await finish([1]);
  });
  assert.equal(f.captures.length, 3); await handle.close();
});

for (const wireMode of ['draft', 'full']) test(`classification-only finish repair preserves the saved batch and current reads in ${wireMode}`, async t => {
  const f = await consumedUserFixture(t, wireMode);
  const value = { batchId: 1, defaults: { category: 'constraints', authority: 'MATERIAL_DERIVED', severity: 'HARD' }, operations: [{ operation: 'ADD', category: 'constraints', text: 'Original material condition.',
    authority: 'MATERIAL_DERIVED', severity: 'HARD', verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION',
    applicabilityKind: 'CURRENT_TASK', sourceFrom: { unitId: 'S1L1' } }],
    ...(wireMode === 'draft' ? { overrides: [{ unit: 'S0L1', metadata: { category: 'requirements', authority: 'USER_EXPLICIT', severity: 'HARD',
      applicabilityKind: 'CURRENT_TASK', verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION' } }] } : {}) };
  const handle = await f.run(async ({ call, readAll, params }) => {
    await readAll(); await call('save_baseline_batch', value);
    const state = async () => JSON.parse(toolText(await call('review_history', { mode: 'state' }))).taskState;
    const before = await state(), candidate = path.resolve(params.cwd, '../candidates-0/batch-1.json'), bytes = await fs.readFile(candidate);
    await assert.rejects(call('finish_baseline', { batchIds: [1], summary: 'Same saved original obligations.', taskClassification: 'NEW_TASK' }), { code: 'BASELINE_CLASSIFICATION_INVALID' });
    await assert.rejects(fs.access(path.resolve(params.cwd, '../candidates-0/finish.json')), { code: 'ENOENT' });
    const after = await state();
    for (const key of ['generation', 'deadlineAt', 'maxRepairs', 'batches', 'nextBatchId']) assert.deepEqual(after[key], before[key]);
    assert.equal(after.repairs, before.repairs + 1); assert.equal(after.metrics.readBytes, before.metrics.readBytes);
    assert.deepEqual(await fs.readFile(candidate), bytes);
    await call('finish_baseline', { batchIds: [1], summary: 'Same saved original obligations.', taskClassification: 'CONTINUATION' });
  });
  assert.equal(handle.result.taskClassification, 'CONTINUATION'); assert.equal(f.captures.length, 1); await handle.close();
});

test('classification finish exhaustion cannot issue a durable finish or consume the current baseline', async t => {
  const f = await consumedUserFixture(t, 'full'), before = await fs.readFile(f.truthPath);
  f.input.reviewer.formatRepairAttempts = 0;
  await assert.rejects(f.run(async ({ call, readAll }) => {
    await readAll(); await call('finish_baseline', { batchIds: [], summary: 'No new USER exists.', taskClassification: 'NEW_TASK' });
  }), error => {
    assert.equal(error.code, 'BASELINE_REPAIR_LIMIT'); assert.match(error.message, /taskClassification.*NEW_TASK/);
    assert.equal(error.baselineValidation.code, 'BASELINE_CLASSIFICATION_INVALID'); return true;
  });
  assert.equal(f.captures.length, 1); assert.deepEqual(await fs.readFile(f.truthPath), before);
  const directory = path.join(taskDirectory(f.root, f.task.taskId), 'baseline-task-runs');
  const [run] = await fs.readdir(directory);
  await assert.rejects(fs.access(path.join(directory, run, 'candidates-0/finish.json')), { code: 'ENOENT' });
  const checkpoint = await readJson(path.join(directory, run, 'review-checkpoint.json'));
  assert.equal(checkpoint.taskState.repairs, 0); assert.equal(checkpoint.taskState.generation, 0);
  assert.equal(checkpoint.taskState.maxRepairs, 0); assert.equal(checkpoint.taskState.validationFailures, 1);
  assert.equal(checkpoint.taskState.repairExhausted, true);
});

test('Stop baseline reads beyond the old byte ceiling and returns source-bound operations, not verdicts', async t => {
  const f = await fixture(t, { large: true });
  f.input.reviewer.maxOutputTokens = 65536;
  const handle = await f.run(async ({ readAll, call, batch, finish }) => {
    await readAll(); await call('save_baseline_batch', batch()); await finish([1]);
  });
  assert.equal(handle.result.operations[0].source.ref, 'transcript:U1#L1-L1');
  assert.equal(handle.result.operations[0].source.excerpt, 'Preserve the requested feature.');
  assert.equal('verdict' in handle.result, false);
  assert.equal((await loadCurrentGroundTruth(f.root, f.task.taskId)).version, 0, 'candidate does not write ledger');
  const checkpoint = await readJson(path.join(handle.artifacts, 'review-checkpoint.json'));
  assert(checkpoint.taskState.metrics.readBytes > 131072);
  assert.equal(checkpoint.taskState.pending.length, 0);
  await handle.close();
});

test('an explicit required-tool deny fails before the native model starts and names its policy',async t=>{
 const f=await fixture(t);
 f.api.config.tools={deny:[BASELINE_TOOL_NAMES.at(-1)]};
 let calls=0;
 await assert.rejects(f.makeFactory(async()=>{calls++;assert.fail('Denied protocol must never call the native model');})(f.input),error=>{
  assert.equal(error.code,'RC_REQUIRED_TOOLS_DENIED');assert.match(error.message,/tools\.deny/);
  assert(error.message.includes(BASELINE_TOOL_NAMES.at(-1)));return true;
 });
 assert.equal(calls,0);assert.equal(f.captures.length,0);
 assert.deepEqual(f.api.config.tools.deny,[BASELINE_TOOL_NAMES.at(-1)]);
});

test('compact removes visible tool results; history/checkpoint restore receipts and pending sources without granting evidence', async t => {
  const f = await fixture(t, { large: true });
  const handle = await f.run(async ({ readAll, call, batch, finish, hooks, ctx, params, seen }) => {
    const initial = JSON.parse(params.prompt);
    for (const file of initial.requiredFiles.filter(file => !file.startsWith('source-0001'))) {
      const read = await call('source_read', { path: file }); seen.set(file, [read.details.citation.citeId]);
    }
    await call('save_baseline_batch', batch());
    await hooks.get('before_compaction')({}, ctx());
    const recovery = JSON.parse(toolText(await call('review_history', { mode: 'state' })));
    const checkpoint = JSON.parse(await fs.readFile(recovery.checkpointPath));
    assert.equal(checkpoint.taskState.batches.length, 1); assert(checkpoint.taskState.pending.length > 0);
    // Simulate a model-visible compacted context: all old source results/IDs
    // are removed; only this untrusted summary and the recovery tool remain.
    const visible = ['Summary: a batch may have been saved; consult review_history.']; seen.clear();
    await hooks.get('after_compaction')({}, ctx());
    let offset = 0, recovered = [], pending = [];
    do {
      const history = JSON.parse(toolText(await call('review_history', { mode: 'state', offset, limit: 10 })));
      visible.push(history); recovered.push(...history.citations); pending.push(...history.taskState.pending);
      offset = history.nextOffset ?? history.taskState.nextStateOffset;
      assert(history.taskState.pendingCount > 0); assert.equal(history.taskState.batchCount, 1);
    } while (offset !== null);
    const ids = recovered.filter(ref => ref.path.startsWith('source-0000')).map(ref => ref.citeId);
    assert(ids.length > 0);
    const saved = JSON.parse(toolText(await call('review_history', { mode: 'search', query: 'candidateBatch' })));
    assert(saved.matches.length > 0);
    const observation = JSON.parse(toolText(await call('review_history', { mode: 'read', entryId: saved.matches[0].entryId })));
    assert.match(observation.text, /Preserve the requested feature/);
    // Only the structured pending ranges remain available to the model.
    for (const item of pending) for (const range of item.ranges) {
      let start = range.start;
      do { const read = await call('source_read', { path: item.file, offset: start, limit: range.end - start + 1 });
        start = read.details.page.nextOffset;
      } while (start && start <= range.end);
    }
    await finish([1]);
  });
  await handle.close();
});

test('missing or synthetic read receipts cannot establish even NO_CHANGE', async t => {
  for (const synthetic of [false, true]) await t.test(String(synthetic), async t => {
    const f = await fixture(t);
    const controller = new AbortController(); f.input.abortSignal = controller.signal;
    await assert.rejects(f.run(async ({ call, finish, params }) => {
      for (const file of JSON.parse(params.prompt).requiredFiles) await call('source_read', { path: file }, { persist: synthetic, synthetic });
      await assert.rejects(finish([]), { code: 'BASELINE_INCOMPLETE' });
      controller.abort(new Error('test cancellation')); throw controller.signal.reason;
    }), /test cancellation/);
    assert.equal((await loadCurrentGroundTruth(f.root, f.task.taskId)).version, 0);
  });
});

test('durable batches recover lost acknowledgements; conflicts and omitted batches are rejected', async t => {
  let lost = true;
  const f = await fixture(t, { faults: { afterBatchPersist() { if (lost) { lost = false; throw new Error('lost acknowledgement'); } } } });
  const handle = await f.run(async ({ call, readAll, batch, finish }) => {
    await readAll(); const value = batch();
    await assert.rejects(call('save_baseline_batch', value), /lost acknowledgement/);
    const stored = JSON.parse(toolText(await call('save_baseline_batch', value)));
    assert.equal(stored.batchId, 1);
    await assert.rejects(call('save_baseline_batch', { ...value, operations: [{ ...value.operations[0], text: 'Conflicting claim' }] }), { code: 'BASELINE_BATCH_CONFLICT' });
    await assert.rejects(finish([]), { code: 'BASELINE_INCOMPLETE' }); await finish([1]);
  });
  assert.equal(handle.result.operations.length, 1); await handle.close();
});

test('source authority and baseline version fences survive task transport', async t => {
  const f = await fixture(t), controller = new AbortController(); f.input.abortSignal = controller.signal;
  await assert.rejects(f.run(async ({ readAll, call, batch, finish }) => {
    await readAll(); const value = batch(); value.operations[0].source.ref = f.material; value.operations[0].source.kind = 'MATERIAL';
    await assert.rejects(call('save_baseline_batch', value), error => {
      assert.equal(error.code, 'SOURCE_BINDING_INVALID');
      const facts = JSON.parse(error.message.split('\nSource authority navigation: ')[1]);
      assert.equal(facts.issues[0].operationIndex, 0); assert.equal(facts.issues[0].sourceKind, 'MATERIAL');
      assert.equal(facts.issues[0].authorityOrigin, 'operation');
      assert.equal(facts.issues[0].authority, 'USER_EXPLICIT'); return true;
    });
    await call('save_baseline_batch', batch());
    await atomicWriteJson(f.truthPath, { ...f.truth, version: 1, digest: 'changed' });
    await assert.rejects(finish([1]), { code: 'BASELINE_INPUT_CHANGED' });
    controller.abort(new Error('version fence')); throw controller.signal.reason;
  }), /version fence/);
});

test('domain repair uses a new candidate generation, preserving read proof and original deadline', async t => {
  const f = await fixture(t);
  const handle = await f.run(async ({ readAll, call, batch, finish, params, seen }) => {
    if (!seen.size) await readAll();
    await call('save_baseline_batch', batch()); await finish([1]);
  });
  const old = handle.result;
  await handle.followUp({ prompt: 'Repair rejected delta without changing source authority.', nextSchema: GROUND_TRUTH_REVIEW_SCHEMA });
  assert.deepEqual(handle.result, old); assert.equal(f.captures.length, 2);
  assert.equal(f.captures[0].sessionId, f.captures[1].sessionId);
  assert(f.captures[1].timeoutMs <= f.captures[0].timeoutMs);
  const checkpoint = await readJson(path.join(handle.artifacts, 'review-checkpoint.json'));
  assert.equal(checkpoint.taskState.generation, 1); assert.equal(checkpoint.taskState.repairs, 1);
  await handle.close();
});

test('formal delta, commit receipt and source cursor publish once, including a lost application reply', async t => {
  const f = await fixture(t);
  const handle = await f.run(async ({ readAll, call, batch, finish }) => { await readAll(); await call('save_baseline_batch', batch()); await finish([1]); });
  const options = { projectRoot: f.root, taskId: f.task.taskId, delta: handle.result, sourceCatalog: f.input.request.sourceCatalog,
    baselineCommit: { ...handle.baselineTask, id: handle.baselineTask.requestId, scope: 'stop', cursorDigest: 'cursor-1' } };
  const first = await applyGroundTruthDelta(options);
  assert.equal(first.current.version, 1);
  const duplicate = await applyGroundTruthDelta(options); assert.equal(duplicate.duplicate, true);
  assert.equal((await loadCurrentGroundTruth(f.root, f.task.taskId)).claims.length, 1);
  const state = await readJson(path.join(taskDirectory(f.root, f.task.taskId), 'task.json'));
  assert.equal(state.groundTruth.sourceCursors.stop, 'cursor-1');
  await assert.rejects(applyGroundTruthDelta({ ...options, delta: { ...handle.result, operations: [] } }), { code: 'BASELINE_COMMIT_CONFLICT' });
  await handle.close();
});

test('unrelated native extraction retains its existing read-only transport', async t => {
  const f = await fixture(t); let calls = 0;
  const factory = createOpenClawReviewerFactory(f.api, { runEmbeddedAgent: async params => {
    calls++; assert.deepEqual(params.toolsAllow, ['read']);
    return { payloads: [{ text: JSON.stringify({ summary: 'None', taskClassification: 'NO_CHANGE', operations: [] }) }], meta: {} };
  } });
  const input = structuredClone(f.input); delete input.request.reviewScope;
  const handle = await factory(input); assert.equal(calls, 1); assert.equal(handle.baselineTask, undefined); await handle.close();
  assert(TASK_TOOL_NAMES.includes('submit_review')); assert(!TASK_TOOL_NAMES.includes('finish_baseline'));
});

test('lost completion acknowledgement returns the same durable receipt and rejects conflicting completion', async t => {
  let lost = true;
  const f = await fixture(t, { faults: { afterFinishPersist() { if (lost) { lost = false; throw new Error('lost finish reply'); } } } });
  const handle = await f.run(async ({ readAll, call, batch, finish }) => {
    await readAll(); await call('save_baseline_batch', batch());
    await assert.rejects(finish([1]), /lost finish reply/);
    const first = toolText(await call('finish_baseline', { batchIds: [1], taskClassification: 'CONTINUATION', summary: 'Completed extraction.' }, { notify: false }));
    assert.equal(toolText(await call('finish_baseline', { batchIds: [1], taskClassification: 'CONTINUATION', summary: 'Completed extraction.' }, { notify: false })), first);
    await assert.rejects(call('finish_baseline', { batchIds: [1], taskClassification: 'CORRECTION', summary: 'Different finish' }), { code: 'BASELINE_FINISH_CONFLICT' });
    await finish([1]);
  });
  assert.equal(handle.result.operations.length, 1); await handle.close();
});

test('a lost finish replay rejects old policy and rechecks source admission before any ready receipt', async t => {
  let lost = true;
  const f = await fixture(t, { faults: { afterFinishPersist() { if (lost) { lost = false; throw new Error('lost finish reply'); } } } });
  f.input.reviewer.formatRepairAttempts = 3;
  const handle = await f.run(async ({ readAll, call, batch, finish, params }) => {
    await readAll(); await call('save_baseline_batch', batch());
    await assert.rejects(finish([1]), /lost finish reply/);
    const file = path.resolve(params.cwd, '../candidates-0/finish.json'), saved = await readJson(file);
    const legacy = structuredClone(saved); delete legacy.admissionPolicy;
    await atomicWriteJson(file, legacy);
    await assert.rejects(finish([1]), { code: 'BASELINE_FINISH_CONFLICT' });
    const changed = structuredClone(saved); changed.delta.operations[0].source.ref = 'assistant:untrusted';
    changed.digest = sha256(changed.delta); changed.receipt.deltaDigest = changed.digest;
    await atomicWriteJson(file, changed);
    await assert.rejects(finish([1]), error => error.code === 'BASELINE_ADMISSION_INVALID'
      && error.baselineValidation.reason === 'SOURCE_REJECTED');
    const state = JSON.parse(toolText(await call('review_history', { mode: 'state' }))).taskState;
    assert.notEqual(state.phase, 'CANDIDATE_COMPLETE'); assert.equal(state.repairs, 3);
    assert.equal(state.externalRepairs, 0); assert.equal(state.maxRepairs, 3);
    await atomicWriteJson(file, saved);
    const result = JSON.parse(toolText(await finish([1])));
    assert.equal(result.complete, true); assert.equal(result.deltaDigest, saved.digest);
  });
  assert.equal(f.captures.length, 1); assert.equal(handle.result.operations.length, 1); await handle.close();
});

test('virtual time crosses the original deadline after compact without a real wait or a completed baseline', async t => {
  const f = await fixture(t); let now = Date.now(); t.mock.method(Date, 'now', () => now);
  f.input.deadlineAt = now + 2000;
  await assert.rejects(f.run(async ({ readAll, call, batch, finish, hooks, ctx }) => {
    await readAll(); await call('save_baseline_batch', batch());
    await hooks.get('before_compaction')({}, ctx()); now += 1500;
    await hooks.get('after_compaction')({}, ctx());
    const state = JSON.parse(toolText(await call('review_history', { mode: 'state' })));
    assert.equal(state.taskState.deadlineAt, f.input.deadlineAt);
    now += 501; await finish([1]);
  }), { code: 'REVIEWER_DEADLINE' });
  assert.equal((await loadCurrentGroundTruth(f.root, f.task.taskId)).version, 0);
});

test('cancellation after candidate finish persisted cannot produce a usable complete handle', async t => {
  const controller = new AbortController();
  const f = await fixture(t, { faults: { afterFinishPersist() { controller.abort(new Error('cancel at candidate persistence')); } } });
  f.input.abortSignal = controller.signal;
  await assert.rejects(f.run(async ({ readAll, call, batch, finish }) => { await readAll(); await call('save_baseline_batch', batch()); await finish([1]); }), /cancel at candidate persistence/);
  assert.equal((await loadCurrentGroundTruth(f.root, f.task.taskId)).version, 0);
  assert.equal(f.registry()(f.captures[0]), null);
});

test('cancellation after transaction log write but before head publication applies neither delta nor cursor', async t => {
  const f = await fixture(t), controller = new AbortController(); f.input.abortSignal = controller.signal;
  const handle = await f.run(async ({ readAll, call, batch, finish }) => { await readAll(); await call('save_baseline_batch', batch()); await finish([1]); });
  const publish = FileTransactionJournal.prototype.publish;
  t.mock.method(FileTransactionJournal.prototype, 'publish', async function (...args) {
    const fault = this.fault;
    if (String(args[3]?.operationId).startsWith('baseline:')) this.fault = async point => {
      await fault.call(this, point);
      if (point === 'commit-written') controller.abort(new Error('cancel at head fence'));
    };
    try { return await publish.apply(this, args); } finally { this.fault = fault; }
  });
  await assert.rejects(applyGroundTruthDelta({ projectRoot: f.root, taskId: f.task.taskId, delta: handle.result,
    sourceCatalog: f.input.request.sourceCatalog, baselineCommit: { ...handle.baselineTask,
      id: handle.baselineTask.requestId, scope: 'stop', cursorDigest: 'must-not-advance' } }), /cancel at head fence/);
  assert.equal((await loadCurrentGroundTruth(f.root, f.task.taskId)).version, 0);
  const state = await readJson(path.join(taskDirectory(f.root, f.task.taskId), 'task.json'));
  assert.equal(state.groundTruth.sourceCursors.stop, undefined); await handle.close();
});

test('a complete empty delta and frozen authority filtering still use existing ledger semantics', async t => {
  const f = await fixture(t);
  const handle = await f.run(async ({ readAll, finish, call }) => {
    await readAll();
    const state = JSON.parse(toolText(await call('review_history', { mode: 'state' }))).taskState;
    assert.equal(state.wireMode, 'full'); assert(state.pendingUnitCount > 0);
    assert.equal(state.pendingNavigation.wireMode, 'full');
    assert.match(state.pendingNavigation.instruction, /Full-mode empty NO_CHANGE/);
    await finish([]);
  });
  assert.equal(handle.result.taskClassification, 'NO_CHANGE'); assert.deepEqual(handle.result.operations, []);
  await handle.close();
  await atomicWriteJson(f.truthPath, { ...f.truth, frozenAtVersion: 0 });
  const dropped = await applyGroundTruthDelta({ projectRoot: f.root, taskId: f.task.taskId,
    sourceCatalog: f.input.request.sourceCatalog, delta: { operations: [{ ...operation('requirements.md'), authority: 'MATERIAL_DERIVED', source: { ref: 'requirements.md', kind: 'MATERIAL' } }] } });
  assert.equal(dropped.changed, false); assert.equal(dropped.droppedPostFreeze.length, 1);
});

test('real MA hook runner accepts the isolated baseline tool protocol, synchronous receipts and compact checkpoints without a model',
  { skip: !process.env.RC_OPENCLAW_HOST_ROOT }, async t => {
    const host = process.env.RC_OPENCLAW_HOST_ROOT;
    const { i: initialize, t: current, a: reset } = await import(pathToFileURL(path.join(host, 'dist/hook-runner-global-BmIrGlLG.js')));
    const source = await fs.readFile(path.join(host, 'dist/attempt.model-diagnostic-events-CfZQM0hs.js'), 'utf8');
    assert.match(source, /runToolResultPersist\(\{\s*toolName: meta.toolName,\s*toolCallId: meta.toolCallId,\s*message,\s*isSynthetic: meta.isSynthetic/u);
    assert.match(source, /sessionKey: opts\?\.sessionKey/u, 'the actual persistence transport includes the private binding key');
    const f = await fixture(t); const pluginId = `baseline-contract-${crypto.randomUUID()}`;
    reset(); t.after(reset);
    initialize({ hooks: [], plugins: [{ id: pluginId, status: 'loaded' }], typedHooks: [...f.hooks].map(([hookName, handler]) => ({ pluginId, hookName, handler, timeoutMs: 30000 })) });
    const runner = current();
    f.hooks.set('tool_result_persist', (event, ctx) => {
      const result = runner.runToolResultPersist(event, ctx);
      assert.equal(result instanceof Promise, false); assert.equal(result.message, event.message);
      return result;
    });
    f.hooks.set('before_compaction', (event, ctx) => runner.runBeforeCompaction(event, ctx));
    f.hooks.set('after_compaction', (event, ctx) => runner.runAfterCompaction(event, ctx));
    const handle = await f.run(async ({ readAll, call, batch, finish, hooks, ctx }) => {
      await readAll(); await call('save_baseline_batch', batch());
      await hooks.get('before_compaction')({ messageCount: 10 }, ctx());
      await hooks.get('after_compaction')({ messageCount: 1, compactedCount: 9 }, ctx());
      const state = JSON.parse(toolText(await call('review_history', { mode: 'state' })));
      assert.equal(state.taskState.batchCount, 1); assert.equal(state.taskState.pendingCount, 0);
      await finish([1]);
    });
    assert.equal(handle.result.operations.length, 1); await handle.close();
    assert.equal(f.registry()(f.captures[0]), null, 'closed private sessions cannot retain tools');
  });

test('existing requirements orchestrator repairs a rejected claimId, commits once and advances its source cursor', async t => {
  const f = await fixture(t); let attempts = 0;
  const transcript = path.join(f.root, 'transcript.jsonl');
  await fs.writeFile(transcript, JSON.stringify({ type: 'user', uuid: 'U1', message: { role: 'user', content: 'Preserve the requested feature.' } }) + '\n');
  const factory = f.makeFactory(async ({ readAll, call, batch, finish, seen }) => {
    if (!seen.size) await readAll();
    const value = batch();
    if (++attempts === 1) value.operations[0] = { ...value.operations[0], operation: 'SUPERSEDE', claimId: 'unknown-original-claim' };
    await call('save_baseline_batch', value); await finish([1]);
  });
  const runtimeV2 = compileRuntimeV2Config({ version: 2, dynamicGroundTruth: { enabled: true, materialRoots: [f.material] },
    reviewers: { defaults: { model: 'fixture/model', timeoutMs: 20000, formatRepairAttempts: 3 } },
    skillCorrection: { enabled: false }, stopCorrection: { enabled: true } }, { policyRoot: path.join(f.root, '.runtime-corrector') });
  const state = await readJson(path.join(taskDirectory(f.root, f.task.taskId), 'task.json'));
  const result = await refreshRuntimeRequirements({ projectRoot: f.root,
    input: { cwd: f.root, session_id: 'baseline-test', hook_event_name: 'Stop', hook_event_id: 'integration-event', transcript_path: transcript },
    plan: { runtimeV2 }, reviewerFactory: factory,
    assessmentContext: { assessmentId: 'baseline-integration', guard: decisionGuard(state), deadlineAt: Date.now() + 20000 } });
  assert.equal(attempts, 2); assert.equal(result.baselineCommitted, true); assert.equal(result.requirementVersion, 1);
  const current = await loadCurrentGroundTruth(f.root, f.task.taskId);
  assert.equal(current.claims.length, 1);
  const saved = await readJson(path.join(taskDirectory(f.root, f.task.taskId), 'task.json'));
  assert.equal(typeof saved.groundTruth.sourceCursors['shared-original-basis'], 'string');
  assert.equal(saved.groundTruth.sharedBasis.baselineVersion, current.version);
  assert.equal(saved.groundTruth.sharedBasis.baselineDigest, current.digest);
  assert.equal(saved.groundTruth.sharedBasis.proof.generation, 1, 'repaired accepted delta owns the reusable proof');
  assert.equal(saved.groundTruth.version, current.version);
});

const criticalPathMaterialBatch = {
  "batchId": 1,
  "defaults": {
    "authority": "MATERIAL_DERIVED",
    "category": "requirements",
    "severity": "HARD"
  },
  "exclude": [
    {
      "reason": "Unadopted demonstration/example material context, not a required business action.",
      "units": [
        "S1L1",
        "S1L2"
      ]
    },
    {
      "reason": "Descriptive heading and permission statements in Skill material; no imperative obligation adopted.",
      "units": [
        "S2L1",
        "S2L3",
        "S2L5"
      ]
    }
  ],
  "operations": [
    {
      "applicabilityKind": "CURRENT_TASK",
      "expectedFiles": [
        "app.mjs"
      ],
      "implementationRole": "PRODUCTION",
      "sourceFrom": {
        "unitId": "S2L7"
      },
      "text": "Per the selected delivery-verifier Skill, create app.mjs and a short usage guide.",
      "verificationTarget": "IMPLEMENTATION"
    },
    {
      "applicability": "before publishing",
      "applicabilityKind": "CONDITIONAL",
      "sourceFrom": {
        "unitId": "S2L9"
      },
      "text": "Cancel orphan tasks before publishing.",
      "verificationTarget": "PROCESS"
    }
  ]
};

// These expectations belong only to the two complete critical-path originals
// below. Phase one receives no batch, candidate, ledger or previous graph.
function criticalPathOriginalDuties({ source, unit, fullText }) {
  const duty = (statement, owner, condition) => ({ statement, owner, condition });
  if (source.kind === 'USER_MESSAGE' && fullText === 'Create app.mjs and a short usage guide for a stateless numeric validation module. Follow the selected delivery-verifier Skill in this workspace.') {
    assert.equal(unit.text, fullText, 'This controlled original is one complete immutable unit');
    return [
      duty('Create app.mjs, a stateless numeric validation module.', 'IMPLEMENTATION', 'Deliver the requested stateless numeric validation module.'),
      duty('Create a short usage guide for a stateless numeric validation module.', 'ARTIFACT', 'Deliver the requested module usage guide.'),
      duty('Follow the selected delivery-verifier Skill in this workspace.', 'PROCESS', 'Follow the selected Skill while delivering this task in this workspace.'),
    ];
  }
  if (source.kind === 'USER_MESSAGE' && fullText === 'Implement app.mjs and complete docs/guide.md according to the complete original contract in requirements/original-contract.md. Read and follow the matching delivery-verifier Skill at skills/delivery-verifier/SKILL.md. After your final code or guide edit, actually run its supplied public verifier and establish exit code 0 before declaring completion. Repeat verification after any later correction. Preserve the contract and explicit exclusions. Edit only app.mjs and docs/guide.md; the supplied contract, Skill and verifier are read-only.') {
    assert.equal(unit.text, fullText, 'This controlled original is one complete immutable unit');
    return [
      duty('Implement app.mjs according to the complete original contract in requirements/original-contract.md.', 'IMPLEMENTATION', 'Implement the code according to the complete original contract and its explicit exclusions.'),
      duty('Complete docs/guide.md according to the complete original contract in requirements/original-contract.md.', 'ARTIFACT', 'Complete the guide according to the complete original contract and its explicit exclusions.'),
      duty('Read and follow the matching delivery-verifier Skill at skills/delivery-verifier/SKILL.md.', 'PROCESS', 'Read the matching original Skill and follow it while delivering this task.'),
      duty("After the final code or guide edit, actually run the delivery-verifier's supplied public verifier and establish its actual exit code 0 before declaring completion.", 'PROCESS', 'After the final code or guide edit, actually run the supplied verifier and establish exit code 0 before declaring completion.'),
      duty('Repeat verification after any later correction to app.mjs or docs/guide.md: run the verifier again after that change; an earlier success does not satisfy the new verification duty.', 'PROCESS', 'After any later correction, run verification again after that change; prior success cannot satisfy the new verification duty.'),
      duty('Preserve the contract and its explicit exclusions; edit only app.mjs and docs/guide.md; the supplied contract, Skill and verifier are read-only.', 'PROCESS', 'Throughout the task, preserve the contract and exclusions, edit only the two deliverables, and keep supplied inputs read-only.'),
    ];
  }
  if (source.kind === 'MATERIAL' && fullText === '# Demonstration only; not a required business action.\nraise RuntimeError("example only")\n') return [];
  if (source.kind === 'MATERIAL' && fullText === '# Workflow\n\nThis skill helps maintain a numeric validator.\n\nYou may inspect examples if useful.\n\nCreate app.mjs and a short usage guide.\n\nCancel orphan tasks before publishing.\n') {
    assert.equal(unit.text, fullText, 'All independently authored Skill duties share one neutral compound block');
    return [
      duty('Per the selected delivery-verifier Skill, create app.mjs.', 'IMPLEMENTATION', 'Deliver the application module required by the selected Skill.'),
      duty('Per the selected delivery-verifier Skill, create a short usage guide.', 'ARTIFACT', 'Deliver the short usage guide required by the selected Skill.'),
      duty('Cancel orphan tasks before publishing.', 'PROCESS', 'Cancel orphan tasks before publishing.'),
    ];
  }
  throw new Error(`Missing critical-path original-only expectation for ${source.kind}:${source.ref}`);
}

// Phase two only: the controlled model must find each independently declared
// complete duty in exactly one actual ACTIVE target. Never match every claim
// of a source to every unit, or use an owner-only fallback for different duties.
function criticalPathCoverageReport({ view, inventory, identityDigest }) {
  const active = view.effectiveLedger.claims.filter(claim => claim.status === 'ACTIVE');
  return { identityDigest, inventoryDigest: sha256(inventory), verdict: 'PASS', sources: inventory.sources.map(source => {
    const hasDuties = source.units.some(unit => unit.obligations.length);
    return { kind: source.kind, ref: source.ref, unitIds: source.units.map(unit => unit.unitId),
      disposition: hasDuties ? 'COVERED' : 'CONTEXT', reason: 'Explicit controlled interpretation of the complete current original.', issues: [],
      mappings: source.units.flatMap(unit => {
        const range = { rangeMode: 'UNIT', unitId: unit.unitId, citeIds: unit.citeIds, supportMode: 'DIRECT', dependencyUnitIds: [] };
        if (!unit.obligations.length) return [{ ...range, claimIds: [], obligationIds: [], owner: 'CONTEXT', condition: '',
          reason: 'This exact original unit was independently declared descriptive, permissive or demonstration-only context.' }];
        return unit.obligations.map(expected => {
          const targets = active.filter(claim => claim.text === expected.statement && claim.verificationTarget === expected.owner);
          assert.equal(targets.length, 1, `The committed duty needs one actual faithful target: ${expected.obligationId}`);
          return { ...range, claimIds: [targets[0].claimId], obligationIds: [expected.obligationId], owner: expected.owner,
            condition: targets[0].applicability ?? '',
            reason: `Controlled full-text agreement with the independently committed duty and natural condition: ${expected.condition}` };
        });
      }) };
  }) };
}

test('critical-path MATERIAL revision replays original live006 arguments and publishes guarded ledger and certificate',
  { skip: !process.env.RC_OPENCLAW_HOST_ROOT && 'Requires RC_OPENCLAW_HOST_ROOT for the installed host argument validator.' }, async t => {
  const f = await closedOwnerFixture(t, 'draft', 'material', {
    inventoryInterpretation: criticalPathOriginalDuties, coverageReport: criticalPathCoverageReport });
  const transcript = path.join(f.root, 'original-user.jsonl');
  await fs.writeFile(transcript, JSON.stringify(f.input.evidence.snapshot.entries[0]) + '\n');
  const skillPath = f.input.request.sourceCatalog[2].ref;
  let stage = 'initial', invocations = 0, candidateReceipt, userIds, lastWorkspace;
  const original = structuredClone(criticalPathMaterialBatch);
  const factory = f.makeFactory(async ({ readAll, call: rawCall, finish: rawFinish, seen, params }) => {
    lastWorkspace = params.cwd;
    const finish = async (...args) => { try { return await rawFinish(...args); } catch (error) {
      t.diagnostic(JSON.stringify({ finishError: error.message, code: error.code })); throw error;
    } };
    const call = async (...args) => { try { return await rawCall(...args); } catch (error) {
      t.diagnostic(JSON.stringify({ tool: args[0], code: error.code, message: error.message })); throw error;
    } };
    invocations++;
    if (stage === 'initial') {
      await readAll();
      await call('save_baseline_batch', { batchId: 1, defaults: { authority: 'USER_EXPLICIT', category: 'requirements', severity: 'HARD' }, operations: [
        { text: 'Create app.mjs, a stateless numeric validation module.', applicabilityKind: 'CURRENT_TASK', verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION', expectedFiles: ['app.mjs'], sourceFrom: { unitId: 'S0L1' } },
        { text: 'Create a short usage guide for a stateless numeric validation module.', applicabilityKind: 'CURRENT_TASK', verificationTarget: 'ARTIFACT', sourceFrom: { unitId: 'S0L1' } },
        { text: 'Follow the selected delivery-verifier Skill in this workspace.', applicabilityKind: 'CURRENT_TASK', verificationTarget: 'PROCESS', sourceFrom: { unitId: 'S0L1' } },
      ] });
      await finish([1]); return;
    }
    if (stage === 'material') {
      await readAll();
      await call('save_baseline_batch', criticalPathMaterialBatch);
      assert.deepEqual(criticalPathMaterialBatch, original);
      const control = { batchIds: [1], taskClassification: 'CONTINUATION', summary: 'Explicitly revise the unpublished mixed material candidate.',
        reviseCandidate: { generation: 0, reason: 'The original selected material requires both implementation and a guide.' } };
      try { candidateReceipt = JSON.parse(toolText(await call('finish_baseline', control))); }
      catch (error) { assert.fail(`MATERIAL candidate revision control is unavailable: ${error.code}: ${error.message}`); }
      assert.equal(candidateReceipt.complete, false); stage = 'revised'; return;
    }
    assert.equal(stage, 'revised'); assert(seen.size > 0);
    const corrected = structuredClone(criticalPathMaterialBatch);
    corrected.operations.splice(0, 1,
      { ...corrected.operations[0], text: 'Per the selected delivery-verifier Skill, create app.mjs.' },
      { text: 'Per the selected delivery-verifier Skill, create a short usage guide.', applicabilityKind: 'CURRENT_TASK', verificationTarget: 'ARTIFACT', sourceFrom: { unitId: 'S2L7' } });
    await call('save_baseline_batch', corrected); await finish([1]);
  });
  const refresh = async roots => {
    const runtimeV2 = compileRuntimeV2Config({ version: 2, dynamicGroundTruth: { enabled: true, materialRoots: roots },
      reviewers: { defaults: { model: 'fixture/model', timeoutMs: 20000, formatRepairAttempts: 4 } }, skillCorrection: { enabled: false }, stopCorrection: { enabled: true } },
      { policyRoot: path.join(f.root, '.runtime-corrector') });
    const task = await readJson(path.join(taskDirectory(f.root, f.task.taskId), 'task.json'));
    try { return await refreshRuntimeRequirements({ projectRoot: f.root,
      input: { cwd: f.root, session_id: 'baseline-test', hook_event_name: 'Stop', hook_event_id: `revision-${stage}`, transcript_path: transcript },
      plan: { runtimeV2 }, reviewerFactory: factory,
      assessmentContext: { assessmentId: `material-revision-${stage}`, guard: decisionGuard(task), deadlineAt: Date.now() + 20000 } }); }
    catch (error) {
      const checkpoint = lastWorkspace ? await readJson(path.resolve(lastWorkspace, '../review-checkpoint.json')).catch(checkpointError => {
        t.diagnostic(JSON.stringify({ checkpointError: checkpointError.message })); return null;
      }) : null;
      t.diagnostic(JSON.stringify({ stage, invocations, lastWorkspace: lastWorkspace ?? null, code: error.code, error: error.message,
        lastValidationError: checkpoint?.taskState?.lastValidationError, pendingUnits: checkpoint?.taskState?.pendingUnits })); throw error;
    }
  };
  // The policy stays identical; only actual new source files appear. Changing
  // materialRoots would correctly invalidate the initial USER certificate.
  const materialBytes = await fs.readFile(f.material), skillBytes = await fs.readFile(skillPath);
  await fs.rm(f.material); await fs.rm(skillPath);
  assert.equal((await refresh([f.material, skillPath])).baselineCommitted, true);
  const initialTruth = await loadCurrentGroundTruth(f.root, f.task.taskId); userIds = initialTruth.claims.map(c => c.claimId);
  await fs.writeFile(f.material, materialBytes); await fs.writeFile(skillPath, skillBytes);
  stage = 'material';
  const result = await refresh([f.material, skillPath]);
  assert.equal(result.baselineCommitted, true); assert.equal(invocations, 3);
  const current = await loadCurrentGroundTruth(f.root, f.task.taskId);
  const materials = current.claims.filter(c => c.source.kind === 'MATERIAL');
  assert.deepEqual(materials.map(c => c.verificationTarget).sort(), ['ARTIFACT', 'IMPLEMENTATION', 'PROCESS']);
  assert.deepEqual(current.claims.filter(c => c.source.kind === 'USER_MESSAGE').map(c => c.claimId), userIds);
  const task = await readJson(path.join(taskDirectory(f.root, f.task.taskId), 'task.json'));
  assert.equal(task.groundTruth.sharedBasis.baselineDigest, current.digest);
  assert.equal(task.groundTruth.sharedBasis.proof.generation, 1);
  assert(task.groundTruth.sharedBasis.acceptedSourceCertificate);
  assert.equal(typeof task.groundTruth.sourceCursors['shared-original-basis'], 'string');
  assert.deepEqual(criticalPathMaterialBatch, original);
});

const criticalPathNormalUserBatch = {
  "batchId": 1,
  "defaults": {
    "authority": "USER_EXPLICIT",
    "category": "requirements",
    "severity": "HARD"
  },
  "operations": [
    {
      "applicabilityKind": "CURRENT_TASK",
      "expectedFiles": [
        "app.mjs",
        "docs/guide.md"
      ],
      "implementationRole": "PRODUCTION",
      "sourceFrom": {
        "unitId": "S0L1"
      },
      "text": "Implement app.mjs and complete docs/guide.md according to the complete original contract in requirements/original-contract.md.",
      "verificationTarget": "IMPLEMENTATION"
    },
    {
      "applicabilityKind": "CURRENT_TASK",
      "sourceFrom": {
        "unitId": "S0L1"
      },
      "text": "Read and follow the matching delivery-verifier Skill at skills/delivery-verifier/SKILL.md.",
      "verificationTarget": "PROCESS"
    },
    {
      "applicabilityKind": "CURRENT_TASK",
      "sourceFrom": {
        "unitId": "S0L1"
      },
      "text": "After the final code or guide edit, actually run the delivery-verifier's supplied public verifier and establish its actual exit code 0 before declaring completion.",
      "verificationTarget": "PROCESS"
    },
    {
      "applicability": "If a later correction changes app.mjs or docs/guide.md",
      "applicabilityKind": "CONDITIONAL",
      "sourceFrom": {
        "unitId": "S0L1"
      },
      "text": "Repeat verification after any later correction to app.mjs or docs/guide.md: run the verifier again after that change; an earlier success does not satisfy the new verification duty.",
      "verificationTarget": "PROCESS"
    },
    {
      "applicabilityKind": "CURRENT_TASK",
      "category": "constraints",
      "sourceFrom": {
        "unitId": "S0L1"
      },
      "text": "Preserve the contract and its explicit exclusions; edit only app.mjs and docs/guide.md; the supplied contract, Skill and verifier are read-only.",
      "verificationTarget": "PROCESS"
    }
  ]
};

test('critical-path USER formal revision preserves the complete normal original duties and publishes current owner certificate', async t => {
  const f = await fixture(t, { wireMode: 'draft', businessRoot: true,
    inventoryInterpretation: criticalPathOriginalDuties, coverageReport: criticalPathCoverageReport });
  const original = 'Implement app.mjs and complete docs/guide.md according to the complete original contract in requirements/original-contract.md. Read and follow the matching delivery-verifier Skill at skills/delivery-verifier/SKILL.md. After your final code or guide edit, actually run its supplied public verifier and establish exit code 0 before declaring completion. Repeat verification after any later correction. Preserve the contract and explicit exclusions. Edit only app.mjs and docs/guide.md; the supplied contract, Skill and verifier are read-only.';
  const transcript = path.join(f.root, 'normal-user.jsonl');
  await fs.writeFile(transcript, JSON.stringify({ type: 'user', uuid: 'U1', message: { role: 'user', content: original } }) + '\n');
  const unchanged = structuredClone(criticalPathNormalUserBatch); let revised = false, invocations = 0, scriptFailure;
  const factory = f.makeFactory(async ({ readAll, call, finish }) => {
    try {
      invocations++;
      if (!revised) {
        await readAll(); await call('save_baseline_batch', criticalPathNormalUserBatch);
        const control = { batchIds: [1], taskClassification: 'CONTINUATION', summary: 'Explicitly revise initial USER candidate.', reviseCandidate: { generation: 0, reason: 'The umbrella contains both code and guide delivery owners.' } };
        const receipt = JSON.parse(toolText(await call('finish_baseline', control)));
        assert.equal(receipt.complete, false); revised = true; return;
      }
      const corrected = structuredClone(criticalPathNormalUserBatch);
      corrected.operations.splice(0, 1,
        { ...corrected.operations[0], text: 'Implement app.mjs according to the complete original contract in requirements/original-contract.md.', expectedFiles: ['app.mjs'] },
        { text: 'Complete docs/guide.md according to the complete original contract in requirements/original-contract.md.', expectedFiles: ['docs/guide.md'], applicabilityKind: 'CURRENT_TASK', verificationTarget: 'ARTIFACT', sourceFrom: { unitId: 'S0L1' } });
      await call('save_baseline_batch', corrected); await finish([1]);
    } catch (error) { scriptFailure = error; t.diagnostic(JSON.stringify({ code: error.code, message: error.message })); throw error; }
  });
  const runtimeV2 = compileRuntimeV2Config({ version: 2, dynamicGroundTruth: { enabled: true, materialRoots: [] },
    reviewers: { defaults: { model: 'fixture/model', timeoutMs: 20000, formatRepairAttempts: 4 } }, skillCorrection: { enabled: false }, stopCorrection: { enabled: true } },
    { policyRoot: path.join(f.root, '.runtime-corrector') });
  const state = await readJson(path.join(taskDirectory(f.root, f.task.taskId), 'task.json'));
  const result = await refreshRuntimeRequirements({ projectRoot: f.root,
    input: { cwd: f.root, session_id: 'baseline-test', hook_event_name: 'Stop', hook_event_id: 'normal-user-revision', transcript_path: transcript },
    plan: { runtimeV2 }, reviewerFactory: factory,
    assessmentContext: { assessmentId: 'normal-user-revision', guard: decisionGuard(state), deadlineAt: Date.now() + 20000 } });
  if (scriptFailure) throw scriptFailure;
  assert.equal(result.baselineCommitted, true); assert.equal(invocations, 2);
  assert.deepEqual(criticalPathNormalUserBatch, unchanged);
  const truth = await loadCurrentGroundTruth(f.root, f.task.taskId), task = await readJson(path.join(taskDirectory(f.root, f.task.taskId), 'task.json'));
  assert.equal(truth.claims.length, 6); assert(truth.claims.every(c => c.source.kind === 'USER_MESSAGE'));
  const preservedTexts = unchanged.operations.slice(1).map(op => op.text).sort();
  assert.deepEqual(truth.claims.filter(c => preservedTexts.includes(c.text)).map(c => c.text).sort(), preservedTexts);
  assert.deepEqual(truth.claims.filter(c => ['IMPLEMENTATION', 'ARTIFACT'].includes(c.verificationTarget)).map(c => c.verificationTarget).sort(), ['ARTIFACT', 'IMPLEMENTATION']);
  assert.equal(task.groundTruth.sharedBasis.proof.generation, 1);
  assert.equal(task.groundTruth.sharedBasis.baselineDigest, truth.digest); assert(task.groundTruth.sharedBasis.acceptedSourceCertificate);
});
