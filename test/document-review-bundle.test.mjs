import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { documentReviewBundleKey, groupDocumentReviews, documentReviewBundleCurrent } from '../lib/openclaw/document-review-bundle.mjs';
import { sha256 } from '../lib/runtime-v2/utils.mjs';

function preparation(triggerFile) {
  return { prepared: { matched: true, result: { status: 'passed', diagnostics: [], metadata: {
    triggerFile, artifactFiles: ['notes/a.md', 'notes/b.md'], bundleComplete: true,
    inputs: ['notes/a.md', 'notes/b.md'].map(file => ({ path: file, role: file === triggerFile ? 'target' : 'context',
      bytes: 7, sha256: sha256(file) })), policyDigest: sha256('current policy'), policyFiles: [],
  } }, reviewContext: { enabled: true, nodeReviewEnabled: true, runtimeV2Enabled: false, workflow: null,
    reviewer: { path: 'review.md', criteria: 'Retain each requirement.' },
    artifact: { nodeId: 'plan', stage: 'proposal', artifactType: 'plan', snapshotHash: sha256(triggerFile),
      metricCheckpoint: false, metrics: [] } },
  finalizeContext: { cwd: '/bound-project', triggerFile: `/bound-project/${triggerFile}`, editableArtifactFiles: null,
    output: { mode: 'centralized' }, locale: 'en', outputKey: 'plan' } },
  outcome: { taskId: 'task', originalRequirements: { digest: sha256('original'), userMessages: [] } },
  proposalBinding: { requiredProposalReview: { requiredAtoms: ['canonical-atom'] }, requiredPlanReadiness: { changeName: 'same-change' },
    planRevision: sha256('current plan') }, owner: { runId: 'run', taskId: 'task', sessionId: 'session', enabledRevision: 1 } };
}

test('only the proven uncorrelated trigger-role representation is normalized', () => {
  const first = preparation('notes/a.md'), second = preparation('notes/b.md');
  assert.equal(groupDocumentReviews([first, second], { enabled: true }).length, 1);
  assert.equal(groupDocumentReviews([first, second]).length, 2, 'The caller must explicitly admit one completed tool result.');
  second.prepared.result.metadata.inputs[0].role = 'ground-truth';
  assert.equal(documentReviewBundleKey(second), null);
});

for (const [name, mutate] of [
  ['node', entry => { entry.prepared.reviewContext.artifact.nodeId = 'another-node'; }],
  ['stage', entry => { entry.prepared.reviewContext.artifact.stage = 'implementation'; }],
  ['policy bytes', entry => { entry.prepared.result.metadata.policyDigest = sha256('different policy'); }],
  ['reviewer criteria', entry => { entry.prepared.reviewContext.reviewer.criteria = 'Different obligations.'; }],
  ['current bytes', entry => { entry.prepared.result.metadata.inputs[0].sha256 = sha256('different body'); }],
  ['deterministic sibling diagnostic', entry => { entry.prepared.result.diagnostics.push({ ruleId: 'MISSING-LOCAL-BASIS',
    severity: 'error', path: 'notes/b.md', message: 'The declared basis is missing.' }); entry.prepared.result.status = 'failed'; }],
  ['original requirement basis', entry => { entry.outcome.originalRequirements.digest = sha256('different original'); }],
  ['canonical atom inventory', entry => { entry.proposalBinding.requiredProposalReview.requiredAtoms.push('another-atom'); }],
  ['readiness policy', entry => { entry.proposalBinding.requiredPlanReadiness = null; }],
  ['current plan revision', entry => { entry.proposalBinding.planRevision = sha256('different plan'); }],
  ['owner run', entry => { entry.owner.runId = 'another-run'; }],
  ['enabled revision', entry => { entry.owner.enabledRevision++; }],
]) test(`${name} differences prevent sharing a semantic worker`, () => {
  const first = preparation('notes/a.md'), second = preparation('notes/b.md');
  mutate(second);
  assert.equal(groupDocumentReviews([first, second], { enabled: true }).length, 2);
});

test('workflow instance and target/edit permissions remain exact rather than being unioned', () => {
  const first = preparation('notes/a.md'), second = preparation('notes/b.md');
  for (const entry of [first, second]) {
    entry.prepared.reviewContext.workflow = { nodeId: 'plan', instance: { change: 'first' },
      targetFiles: ['notes/a.md', 'notes/b.md'], editableArtifactFiles: ['notes/a.md'] };
    entry.prepared.finalizeContext.editableArtifactFiles = ['notes/a.md'];
    entry.prepared.result.metadata.inputs.forEach(file => { file.role = 'target'; });
    entry.prepared.reviewContext.artifact.snapshotHash = sha256('same workflow inputs');
  }
  assert.equal(groupDocumentReviews([first, second], { enabled: true }).length, 1);
  second.prepared.reviewContext.workflow.instance.change = 'second';
  assert.equal(groupDocumentReviews([first, second], { enabled: true }).length, 2);
  second.prepared.reviewContext.workflow.instance.change = 'first';
  second.prepared.reviewContext.workflow.targetFiles = ['notes/b.md'];
  assert.equal(groupDocumentReviews([first, second], { enabled: true }).length, 2);
  second.prepared.reviewContext.workflow.targetFiles = ['notes/a.md', 'notes/b.md'];
  second.prepared.reviewContext.workflow.editableArtifactFiles = ['notes/b.md'];
  assert.equal(groupDocumentReviews([first, second], { enabled: true }).length, 2);
});

for (const [name, mutate] of [
  ['incomplete bundle', entry => { entry.prepared.result.metadata.bundleComplete = false; }],
  ['missing declared member', entry => { entry.prepared.result.metadata.artifactFiles.pop(); }],
  ['duplicate input', entry => { entry.prepared.result.metadata.inputs.push(entry.prepared.result.metadata.inputs[0]); }],
  ['unknown file identity', entry => { delete entry.prepared.result.metadata.inputs[0].sha256; }],
  ['runtime Ground Truth context', entry => { entry.outcome.artifactReviewContext = {}; }],
  ['retained reviewer handle', entry => { entry.outcome.reviewerHandle = {}; }],
  ['runtime review enabled', entry => { entry.prepared.reviewContext.runtimeV2Enabled = true; }],
  ['metric checkpoint', entry => { entry.prepared.reviewContext.artifact.metricCheckpoint = true; }],
  ['Ground Truth refresh', entry => { entry.outcome.groundTruthChanged = true; }],
]) test(`${name} cannot qualify for bundle sharing`, () => {
  const entry = preparation('notes/a.md');
  mutate(entry);
  assert.equal(documentReviewBundleKey(entry), null);
});

test('the immutable scheduling key does not absorb later semantic findings or output mutations', () => {
  const entry = preparation('notes/a.md');
  const groups = groupDocumentReviews([entry, preparation('notes/b.md')], { enabled: true });
  const key = groups[0].key;
  entry.prepared.result.status = 'failed';
  entry.prepared.result.diagnostics.push({ ruleId: 'AGENT-BLOCKED', severity: 'error' });
  entry.prepared.finalizeContext.output.directory = 'session-local-output';
  assert.equal(groups[0].key, key);
  assert.equal(documentReviewBundleKey(preparation('notes/a.md')), key);
});

test('currentness requires actual current policy/source bytes and rejects replaced links', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-bundle-current-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'plugin'));
  await fs.writeFile(path.join(root, 'a.md'), 'current');
  await fs.writeFile(path.join(root, 'plugin/policy.md'), 'policy');
  const prepared = { result: { metadata: { inputs: [{ path: 'a.md', sha256: sha256('current') }],
    policyFiles: [{ path: 'plugin:policy.md', sha256: sha256('policy') }] } } };
  const context = { projectRoot: root, pluginRoot: path.join(root, 'plugin') };
  assert.equal(await documentReviewBundleCurrent(prepared, context), true);
  await fs.writeFile(path.join(root, 'a.md'), 'stale');
  assert.equal(await documentReviewBundleCurrent(prepared, context), false);
  await fs.writeFile(path.join(root, 'a.md'), 'current');
  await fs.writeFile(path.join(root, 'plugin/policy.md'), 'new policy');
  assert.equal(await documentReviewBundleCurrent(prepared, context), false);
  await fs.writeFile(path.join(root, 'plugin/policy.md'), 'policy');
  await fs.rename(path.join(root, 'a.md'), path.join(root, 'b.md'));
  try { await fs.symlink(path.join(root, 'b.md'), path.join(root, 'a.md')); }
  catch (error) { if (process.platform !== 'win32' || error.code !== 'EPERM') throw error; return; }
  assert.equal(await documentReviewBundleCurrent(prepared, context), false);
});
