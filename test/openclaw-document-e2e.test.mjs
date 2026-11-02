import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openclawDocumentOptions, collectAutomaticDocumentEvidence, documentHookPolicy, loadDocumentBenchmark } from '../scripts/evaluate-openclaw-document-e2e.mjs';
import { loadConfig } from '../lib/runtime-corrector.mjs';
import { fileURLToPath } from 'node:url';

test('OpenClaw document Hook, review and business budgets remain separately configurable', () => {
  const options = openclawDocumentOptions({ reviewTimeoutMs: 900000, hookTimeoutMs: 1200000,
    businessTimeoutMs: 1800000, totalTimeoutMs: 3600000 });
  assert.deepEqual(options, { reviewTimeoutMs: 900000, baselineTimeoutMs: 1200000, hookTimeoutMs: 1200000, businessTimeoutMs: 1800000, totalTimeoutMs: 3600000 });
  assert.throws(() => openclawDocumentOptions({ hookTimeoutMs: 1000 }), /whole seconds/);
  assert.throws(() => openclawDocumentOptions({ reviewTimeoutMs: 1200001 }), /whole seconds/);
  assert.throws(() => openclawDocumentOptions({ totalTimeoutMs: 3600001 }), /totalTimeoutMs/);
  assert.throws(() => openclawDocumentOptions({ timeout: 1200000 }), /Unknown/);
});

test('dynamic baseline is wired to document review without enabling implementation, Skill or Stop', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openclaw-document-policy-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.runtime-corrector'));
  const options = openclawDocumentOptions({ baselineTimeoutMs: 1800000, reviewTimeoutMs: 900000 });
  await fs.writeFile(path.join(root, '.runtime-corrector/config.yaml'), documentHookPolicy('fixture-model', options, true));
  await fs.writeFile(path.join(root, '.runtime-corrector/document-review.md'), 'Preserve all original requirements.');
  const plan = await loadConfig({ cwd: root });
  assert.equal(plan.runtimeV2.dynamicGroundTruth.enabled, true);
  assert.equal(plan.runtimeV2.artifactCorrection.groundTruthReviewEnabled, true);
  assert.equal(plan.runtimeV2.artifactCorrection.stageMetricsEnabled, false);
  assert.equal(plan.runtimeV2.skillCorrection.enabled, false);
  assert.equal(plan.runtimeV2.implementationCorrection.enabled, false);
  assert.equal(plan.runtimeV2.stopCorrection.enabled, false);
  assert.equal(plan.runtimeV2.reviewers.groundTruthExtractor.timeoutMs, 1800000);
  assert.equal(plan.runtimeV2.reviewers.artifactReviewer.timeoutMs, 900000);
});

test('real benchmark source is pinned and candidate faults leave the complete original available', async t => {
  const source = fileURLToPath(new URL('../examples/document-e2e/terminal-bench-batching/', import.meta.url));
  const loaded = await loadDocumentBenchmark(source);
  assert.equal(loaded.specification.originalLines, 78);
  assert.equal(loaded.specification.originalBytes, 4365);
  assert.equal(loaded.specification.sourceCommit, '7131e4375048a0e408a8fb404b5f499d726b695b');
  assert.deepEqual(loaded.specification.faults.map(item => item.line), [31, 32, 62, 69]);
  let restored = loaded.draft;
  for (const fault of loaded.specification.faults) restored = restored.replace(fault.draft, fault.original);
  assert.equal(restored, loaded.requirements, 'Only the four declared candidate deviations are allowed');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'benchmark-source-pin-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.cp(source, root, { recursive: true });
  await fs.appendFile(path.join(root, 'requirements.md'), '\nChanged original');
  await assert.rejects(loadDocumentBenchmark(root), /original source identity changed/);
});

test('static document evidence binds production rounds to the actual native session and feedback tool result', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openclaw-document-evidence-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const scope = path.join(root, '.runtime-correction/openclaw/session-artifacts/real-scope');
  const result = (roundId, parentSessionId, status) => ({ status, metadata: { roundId, semanticReview: { parentSessionId } } });
  for (const [name, body] of [
    ['runs/design/target/001/result.json', result('001', 'current-session', 'failed')],
    ['runs/design/target/002/result.json', result('002', 'current-session', 'passed')],
    ['runs/design/target/003/result.json', result('003', 'other-session', 'passed')],
    ['latest/design/target/result.json', result('002', 'current-session', 'passed')],
  ]) {
    const file = path.join(scope, name); await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(body));
  }
  const messages = ['001', '002'].map((round, index) => ({ role: 'toolResult', toolCallId: `call-${index}`,
    toolName: index ? 'edit' : 'write', content: [{ type: 'text', text: `[runtime-corrector:feedback] Round outputs (${round})` }] }));
  messages.push({ role: 'toolResult', toolCallId: 'failed-tool', isError: true,
    content: [{ type: 'text', text: '[runtime-corrector:feedback] rejected' }] });
  const evidence = await collectAutomaticDocumentEvidence(root, { messages }, 'current-session');
  assert.equal(evidence.reviews.length, 2); assert.equal(evidence.receipts.length, 2);
  assert.deepEqual(evidence.reviews.map(item => item.toolCallId), ['call-0', 'call-1']);
  assert.deepEqual(evidence.reviews.map(item => item.result.status), ['failed', 'passed']);
  assert(evidence.reviews.every(item => item.scopeTaskId === 'real-scope'));
  const missing = await collectAutomaticDocumentEvidence(root, { messages: [] }, 'current-session');
  assert(missing.reviews.every(item => item.toolCallId === undefined), 'Persisting a result cannot invent feedback delivery');
});
