import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { stopProtocolFixture } from './helpers/stop-protocol.mjs';
import { resolveStopReviewPolicy } from '../lib/runtime-v2/metric-policy.mjs';
import { loadStopOriginalRequirements } from '../lib/runtime-v2/production-stop.mjs';
import { createOriginalSourceAnchor } from '../lib/runtime-v2/original-source-anchor.mjs';
import { sha256 } from '../lib/runtime-v2/utils.mjs';
import { stopReviewDenominator, summarizeStopReviewCoverage, describeStopReviewDenominator } from '../lib/runtime-v2/stop-review-coverage.mjs';
import { renderStopDetails } from '../lib/runtime-v2/stop-feedback.mjs';
import { renderReport, renderSummary } from '../lib/openclaw/report.mjs';
import { createPostRunDispatcher } from '../lib/openclaw/post-run-dispatch.mjs';
import { registerPostRunControls } from '../lib/openclaw/post-run-controls.mjs';

const requirements = ['Return the supplied number plus one from raise.', 'Return the supplied number times two from scale.'];

async function originalReview(t, { sealed = false, omitSecondProof = false } = {}) {
  const f = await stopProtocolFixture(t, 'findings');
  f.input.request.reviewScope = { kind: 'workspace-stop' };
  f.input.request.classificationContract = 2;
  f.input.request.fixedStopClassification = { stopClassification: 'TASK_COMPLETE', stage: null };
  f.input.request.population.reviewPolicy = resolveStopReviewPolicy({ deviationOnly: true });
  f.input.evidence.snapshot.entries[0].message.content = requirements.join(' ');
  const original = await loadStopOriginalRequirements({ projectRoot: f.root, snapshot: f.input.evidence.snapshot });
  f.input.evidence.originalRequirements = original;
  const app = path.join(f.root, 'values.mjs');
  await fs.writeFile(app, 'export const raise = value => value + 1;\nexport const scale = value => value * 2;\n');
  const [message] = original.userMessages;
  const anchor = createOriginalSourceAnchor({ ref: message.ref, sha256: message.sha256,
    bytes: Buffer.from(message.text), start: 1, end: 1 });
  if (sealed) {
    const atoms = requirements.map(requirement => ({ id: sha256([anchor.anchorId, requirement]), source: anchor, requirement }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const file = 'openspec/changes/value-tools/specs/operations/spec.md', body = requirements.join('\n') + '\n';
    await fs.mkdir(path.dirname(path.join(f.root, file)), { recursive: true });
    await fs.writeFile(path.join(f.root, file), body);
    f.input.request.approvedProposalInventory = { inventorySha256: sha256(atoms), requiredAtoms: atoms };
    f.input.evidence.approvedPlanCoverage = { changeName: 'value-tools', proposalRunId: 'proposal', applyRunId: 'apply',
      approvedRevision: sha256(body), taskId: f.input.taskId, sessionId: 'protocol-host',
      rows: requirements.map((requirement, index) => ({ source: anchor, requirement, disposition: 'COVERED',
        reason: 'The approved plan names this operation.', targets: [{ path: file, sha256: sha256(body), start: index + 1, end: index + 1 }] })) };
  }
  let selected;
  const handle = await f.run(async ({ brief, readAll, read, submit }) => {
    await readAll();
    const originalFile = brief.task.basisFiles.find(file => path.basename(file).startsWith('user-original-'));
    const citeId = (await read(originalFile)).details.citation.citeId;
    const page = await submit('set_original_checklist', { items: [{ metricId: 'M16', verificationTarget: 'IMPLEMENTATION',
      implementationRole: 'PRODUCTION', text: requirements[0], citeId, lineStart: 1, lineEnd: 1 }],
      scope: { stopClassification: 'TASK_COMPLETE', completionClaim: true, limit: 20 } });
    selected = page.items;
    const productionCoverage = [];
    if (sealed) {
      const current = (await read(app)).details.citation.citeId;
      for (const [index, description] of requirements.entries()) {
        if (omitSecondProof && index === 1) continue;
        const item = selected.find(item => item.description === description);
        const range = { citeId: current, start: index + 1, end: index + 1 };
        productionCoverage.push({ objectId: item.objectId, reason: description, citeIds: [current],
          flow: { entry: range, consumer: range } });
      }
    }
    let finished = await submit('finish_stop_review', { summary: 'The selected scope has been reviewed.',
      ...(sealed ? { productionCoverage } : {}) });
    if (!finished.complete) finished = await submit('finish_stop_review', { summary: 'Retain the actual unresolved evidence.' });
    assert.equal(finished.complete, true);
  });
  return { f, handle, selected };
}

test('a valid one-item checklist omitting another original obligation discloses its reviewer-selected denominator', async t => {
  const { f, handle, selected } = await originalReview(t);
  t.after(() => handle.close());
  assert.equal(handle.reviewCompleted, true, JSON.stringify(handle.collection));
  assert.equal(selected.length, 1);
  assert.equal(selected[0].description, requirements[0]);
  assert(handle.result.reviewCoverage, JSON.stringify({ result: handle.result, collection: handle.collection, reviewCompleted: handle.reviewCompleted }));
  assert.equal(handle.result.reviewCoverage.total, 1);
  assert.deepEqual(handle.result.reviewCoverage.denominator, { kind: 'REVIEWER_SELECTED_CHECKLIST', requirementCount: 1,
    originalRequirementCompleteness: 'NOT_PROVEN_BY_DENOMINATOR' });
  assert.equal(handle.result.findings.length, 0);
  assert.equal(handle.result.unverifiedItems.length, 0, 'Provenance alone adds no hold or invented obligation.');
  assert.equal(f.calls.length, 1, 'No new model round is introduced.');
  for (const locale of ['en', 'zh']) {
    const text = renderStopDetails({ review: handle.result, locale });
    assert(text.includes(describeStopReviewDenominator(handle.result.reviewCoverage.denominator, locale)));
    assert.match(text, locale === 'en' ? /completion refers to that checklist/u : /完成仅指这份清单/u);
  }
  const summary = { status: 'NO_DEVIATION_FOUND', reviewCoverage: summarizeStopReviewCoverage(handle.result.reviewCoverage) };
  const manager = createPostRunDispatcher({ directoryFor: () => path.join(f.root, 'host-status'),
    validate: async () => true, waitTerminal: async () => ({ status: 'ok' }), sendUser: async () => {},
    review: async () => ({ reviewStatus: summary.status, reviewSummary: summary }) });
  t.after(() => manager.dispose());
  const identity = { agentId: 'main', sessionId: 'protocol-host', sessionKey: 'agent:main:scope',
    projectRoot: f.root, scopeFingerprint: 'current-scope' };
  await manager.started(identity, 'scope-run');
  await manager.candidate(identity, { runId: 'scope-run', text: 'Completed current scope.', reviewBudgetMs: 10000 });
  await manager.drain();
  const methods = new Map();
  registerPostRunControls({ config: {}, logger: { warn() {} }, registerGatewayMethod: (name, method) => methods.set(name, method),
    registerHttpRoute() {} }, { postRuns: manager, postRunReady: Promise.resolve(), validatePostSession: async () => true });
  let response;
  const record = manager.snapshot(identity);
  await methods.get('runtime-corrector.dispatch.get')({ params: { ...identity, id: record.id },
    client: { connect: { role: 'operator', scopes: ['operator.read'] } }, respond: (ok, value) => { response = { ok, value }; } });
  assert.equal(response.ok, true);
  assert.deepEqual(response.value.reviewSummary.reviewCoverage, summary.reviewCoverage);
  assert.equal(f.calls.length, 1, 'Status disclosure starts no additional review.');
});

for (const omitSecondProof of [false, true]) test(`sealed required atoms remain in the denominator with missing proof=${omitSecondProof}`, async t => {
  const { f, handle, selected } = await originalReview(t, { sealed: true, omitSecondProof });
  t.after(() => handle.close());
  assert.equal(handle.reviewCompleted, true, JSON.stringify(handle.collection));
  assert.deepEqual(selected.map(item => item.description).sort(), [...requirements].sort());
  const coverage = handle.result.reviewCoverage;
  assert.equal(coverage.total, 2);
  assert.equal(coverage.unverified, omitSecondProof ? 1 : 0);
  assert.deepEqual(coverage.denominator, { kind: 'APPROVED_REQUIRED_INVENTORY', requirementCount: 2,
    inventorySha256: f.input.request.approvedProposalInventory.inventorySha256, requiredAtomCount: 2,
    originalRequirementCompleteness: 'NOT_PROVEN_BY_DENOMINATOR' });
  const summary = summarizeStopReviewCoverage(coverage);
  assert.equal(summary.unverified, coverage.unverified);
  assert.match(summary.description, /does not establish.*every original requirement/u);
  assert(!Object.hasOwn(summary, 'items'), 'The status projection retains no full source rows.');
  const supplied = { ...coverage, denominator: { ...coverage.denominator,
    originalRequirementCompleteness: 'PROVEN', rawSource: 'must not be copied to status' } };
  const projected = summarizeStopReviewCoverage(supplied);
  assert.equal(projected.denominator.originalRequirementCompleteness, 'NOT_PROVEN_BY_DENOMINATOR');
  assert(!Object.hasOwn(projected.denominator, 'rawSource'));
  const before = structuredClone(coverage);
  summary.denominator.requirementCount = 999;
  assert.deepEqual(coverage, before);
  assert.equal(f.calls.length, 1);
});

test('ordinary non-original reviews identify a task-baseline denominator without changing their verdict', async t => {
  const f = await stopProtocolFixture(t, 'findings');
  f.input.request.reviewScope = { kind: 'workspace-stop' };
  f.input.request.fixedStopClassification = { stopClassification: 'TASK_COMPLETE', stage: null };
  const handle = await f.run(async ({ readAll, read, submit }) => {
    await readAll();
    await submit('review_scope', { stopClassification: 'TASK_COMPLETE', summary: 'Review the current baseline.' });
    const citeId = (await read(f.file)).details.citation.citeId;
    await submit('submit_review', { taskId: 'M01:R1', verdict: 'PASS', reason: 'The selected artifact matches.', citeIds: [citeId] });
    await submit('finish_stop_review', { summary: 'The baseline scope is complete.' });
  });
  t.after(() => handle.close());
  assert.equal(handle.result.metricObjectJudgements[0].judgement, 'PASS');
  assert.deepEqual(handle.result.reviewCoverage.denominator, { kind: 'TASK_BASELINE', requirementCount: 1,
    originalRequirementCompleteness: 'NOT_PROVEN_BY_DENOMINATOR' });
});

test('a partial or malformed inventory cannot label an unrelated checklist as its bound required set', () => {
  for (const requiredAtoms of [[{ id: 'required', objectId: 'missing' }], [null],
    [{ id: 'duplicate', objectId: 'selected' }, { id: 'duplicate', objectId: 'selected' }]]) {
    const denominator = stopReviewDenominator({ requirements: [{ objectId: 'selected' }], originalRequirements: true,
      approvedProposalInventory: { inventorySha256: 'a'.repeat(64), requiredAtoms } });
    assert.equal(denominator.kind, 'REVIEWER_SELECTED_CHECKLIST');
    assert(!Object.hasOwn(denominator, 'inventorySha256'));
  }
});

test('human reports qualify successful recorded scopes and disclose missing legacy provenance', () => {
  const report = { taskId: 'scope-display', verification: 'PASS', phase: 'COMPLETED', requirementVersion: 1,
    budget: { correctionsUsed: 0, infrastructureConsecutiveFailures: 0 }, files: [], findings: [],
    reviewCoverage: { total: 1, unverified: 0 } };
  for (const text of [renderReport(report), renderSummary(report)]) {
    assert.match(text, /本轮已记录清单验收通过/u);
    assert.match(text, /审查分母来源未记录/u);
    assert.doesNotMatch(text, /成果符合当前任务要求|当前任务要求验收通过/u);
  }
});
