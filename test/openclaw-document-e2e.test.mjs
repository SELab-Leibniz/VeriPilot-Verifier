import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { openclawDocumentOptions, collectAutomaticDocumentEvidence, documentHookPolicy, loadDocumentBenchmark, assessDocumentCopy, documentMutations, locateDocumentFaults } from '../scripts/evaluate-openclaw-document-e2e.mjs';
import { ensureTask, taskDirectory } from '../lib/runtime-v2/task-store.mjs';
import { loadConfig, checkArtifact, finalizeArtifactCheck } from '../lib/runtime-corrector.mjs';
import { fileURLToPath } from 'node:url';

test('OpenClaw document Hook, review and business budgets remain separately configurable', () => {
  const options = openclawDocumentOptions({ reviewTimeoutMs: 900000, hookTimeoutMs: 1200000,
    businessTimeoutMs: 1800000, totalTimeoutMs: 3600000 });
  assert.deepEqual(options, { reviewTimeoutMs: 900000, baselineTimeoutMs: 1200000, hookTimeoutMs: 1200000, businessTimeoutMs: 1800000, totalTimeoutMs: 3600000, baselineFormatRepairAttempts: 12 });
  assert.throws(() => openclawDocumentOptions({ hookTimeoutMs: 1000 }), /whole seconds/);
  assert.throws(() => openclawDocumentOptions({ reviewTimeoutMs: 1200001 }), /whole seconds/);
  assert.throws(() => openclawDocumentOptions({ totalTimeoutMs: 3600001 }), /totalTimeoutMs/);
  assert.throws(() => openclawDocumentOptions({ timeout: 1200000 }), /Unknown/);
  assert.equal(openclawDocumentOptions({ baselineFormatRepairAttempts: 8 }).baselineFormatRepairAttempts, 8);
  for (const baselineFormatRepairAttempts of [-1, 21, 1.5, '12'])
    assert.throws(() => openclawDocumentOptions({ baselineFormatRepairAttempts }), /baselineFormatRepairAttempts/);
});

test('document copy allows only line-end padding outside literal fences and keeps actual byte identities', () => {
  const original = '# Scope\n- Keep exact wording.\n  - Preserve indentation.\n';
  const padded = '# Scope \n- Keep exact wording.\t\n  - Preserve indentation. \n';
  const result = assessDocumentCopy(original, padded);
  assert.equal(result.equivalent, true); assert.equal(result.exact, false);
  assert.notEqual(result.expectedSha256, result.actualSha256);
  const explicitDeclaration = 'Source authority: requirements.md\n' + original;
  assert.equal(assessDocumentCopy(explicitDeclaration, explicitDeclaration).equivalent, true);
  for (const changed of [original.replace('exact', 'different'), original.replace('  -', ' -'),
    original.replace('Keep exact', 'Keep  exact'), original.slice(0, -1),
    'Source authority: requirements.md\n' + original])
    assert.equal(assessDocumentCopy(original, changed).equivalent, false);
  for (const marker of ['```', '~~~']) {
    const literal = '# Scope\n' + marker + 'text\nkeep literal  \n' + marker + '\n';
    assert.equal(assessDocumentCopy(literal, literal.replace('keep literal  ', 'keep literal ')).equivalent, false);
    assert.equal(assessDocumentCopy(literal, literal.replace('# Scope\n', '# Scope \n')).equivalent, true);
  }
});

test('native patch repairs count only after successful tool receipts and only for the target document', () => {
  const root = path.resolve('/tmp/doc-target');
  const calls = [
    { id: 'write', name: 'write', arguments: { path: 'design.md', content: 'draft' } },
    { id: 'patch', name: 'apply_patch', arguments: { input: '*** Begin Patch\n*** Update File: design.md\n@@\n-old\n+new\n*** End Patch\n' } },
    { id: 'failed', name: 'edit', arguments: { path: 'design.md' } },
    { id: 'other', name: 'write', arguments: { path: 'other.md' } },
    { id: 'empty', name: 'apply_patch', arguments: { input: '*** Begin Patch\n*** End Patch\n' } },
    { id: 'unacknowledged', name: 'edit', arguments: { path: 'design.md' } },
  ].map(call => ({ type: 'toolCall', ...call }));
  const snapshot = { messages: [{ role: 'assistant', content: calls }, ...calls.filter(call => call.id !== 'unacknowledged')
    .map(call => ({ role: 'toolResult', toolCallId: call.id, isError: call.id === 'failed', content: [] }))] };
  assert.deepEqual(documentMutations(snapshot, root).map(call => call.id), ['write', 'patch']);
});

test('controlled fault locations follow the actual copied candidate without moving a reviewer finding', () => {
  const faults = [{ line: 2, draft: 'Wrong requirement. ' }, { line: 4, draft: 'Another deviation.' }];
  assert.deepEqual(locateDocumentFaults(faults, '# Draft\nWrong requirement.\n\nAnother deviation.\n'),
    [{ sourceLine: 2, actualLine: 2 }, { sourceLine: 4, actualLine: 4 }]);
  assert.deepEqual(locateDocumentFaults(faults, '# Draft\nWrong requirement.\n\n\nAnother deviation.\n'),
    [{ sourceLine: 2, actualLine: 2 }, { sourceLine: 4, actualLine: 5 }]);
  assert.throws(() => locateDocumentFaults(faults, 'The seed was repaired before the first review.'), /pre-repaired or omitted/u);
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

test('copy-contract baseline retains complete declared source enforcement without re-extracting the issue body', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'document-contract-basis-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.runtime-corrector'));
  await fs.writeFile(path.join(root, '.runtime-corrector/config.yaml'), documentHookPolicy('fixture', openclawDocumentOptions(), true));
  await fs.writeFile(path.join(root, '.runtime-corrector/document-review.md'), 'Preserve the complete original.');
  await fs.writeFile(path.join(root, 'requirements.md'), '# Scope\nKeep data local.\n');
  await fs.writeFile(path.join(root, 'design.md'), '# Scope\nUpload data remotely.\n');
  const config = await loadConfig({ cwd: root });
  assert.deepEqual(config.runtimeV2.dynamicGroundTruth.materialRoots, []);
  assert.equal(config.runtimeV2.artifactCorrection.groundTruthReviewEnabled, true);
  const prepared = await checkArtifact({ cwd: root, filePath: 'design.md', deferPersistence: true });
  const checked = await finalizeArtifactCheck(prepared, { status: 'completed', findings: [], diffs: [], edits: [], summary: 'Injected PASS cannot replace the complete original.' });
  assert.equal(checked.result.status, 'failed');
  assert(checked.result.diagnostics.some(item => item.ruleId === 'DOCUMENT-COPY-MISMATCH' && item.line === 2));
  await fs.unlink(path.join(root, 'requirements.md'));
  assert.equal((await checkArtifact({ cwd: root, filePath: 'design.md', deferPersistence: true })).result.status, 'pending');
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

test('scoped proposal rounds survive without artifact files and bind feedback to native tool results', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openclaw-scoped-document-evidence-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sessionId = 'proposal-session';
  const taskId = 'proposal-scope';
  await ensureTask({ projectRoot: root, sessionId, explicitTaskId: taskId });
  const first = { status: 'failed', metadata: { roundId: '001', semanticReview: { parentSessionId: sessionId } } };
  const second = { status: 'passed', metadata: { roundId: '002', semanticReview: { parentSessionId: sessionId } } };
  const journalFile = path.join(taskDirectory(root, taskId), 'journal/events.jsonl');
  await fs.mkdir(path.dirname(journalFile), { recursive: true });
  const rows = [
    { type: 'OPENCLAW_ARTIFACT_REVIEW', toolCallId: 'draft-write', result: first, feedback: 'Correct the requirement.' },
    { type: 'OPENCLAW_ARTIFACT_REVIEW', toolCallId: 'proposal-edit', result: second, feedback: 'The revision passes.' },
    { type: 'OPENCLAW_ARTIFACT_REVIEW', toolCallId: 'another-session', result: {
      ...first, metadata: { roundId: '003', semanticReview: { parentSessionId: 'another-session' } },
    }, feedback: 'Correct the requirement.' },
  ];
  await fs.appendFile(journalFile, rows.map(row => JSON.stringify(row)).join('\n') + '\n{"type":');
  const resultFile = path.join(root, '.runtime-correction/openclaw/session-artifacts', taskId, 'runs/proposal/002/result.json');
  await fs.mkdir(path.dirname(resultFile), { recursive: true });
  await fs.writeFile(resultFile, JSON.stringify(second));

  const nativeResult = (toolCallId, text) => ({ message: {
    role: 'toolResult', toolCallId, content: [{ type: 'text', text: `[runtime-corrector:feedback]\n${text}` }],
  } });
  const evidence = await collectAutomaticDocumentEvidence(root, { messages: [
    nativeResult('copied-feedback', 'Correct the requirement.'),
    nativeResult('draft-write', 'Correct the requirement.'),
    nativeResult('proposal-edit', 'The revision passes.'),
  ] }, sessionId);
  assert.deepEqual(evidence.reviews, [
    { file: journalFile, result: first, scopeTaskId: taskId, toolCallId: 'draft-write' },
    { file: resultFile, result: second, scopeTaskId: taskId, toolCallId: 'proposal-edit' },
  ]);
  const unrelated = await collectAutomaticDocumentEvidence(root, { messages: [
    nativeResult('different-call', 'Correct the requirement.'),
    nativeResult('proposal-edit', 'Unrelated feedback.'),
  ] }, sessionId);
  assert(unrelated.reviews.every(item => item.toolCallId === undefined));
});

test('all benchmark document samples preserve their original sources and only the declared candidate changes', async () => {
  const root = fileURLToPath(new URL('../examples/document-e2e/', import.meta.url));
  const directories = (await fs.readdir(root, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && /^(terminal-bench-|swe-bench-)/u.test(entry.name));
  assert(directories.length >= 12, 'Include the six original and six new large document tasks');
  const identities = new Set();
  for (const entry of directories) {
    const item = await loadDocumentBenchmark(path.join(root, entry.name));
    assert(!identities.has(item.specification.name), 'Benchmark task identity must be unique');
    identities.add(item.specification.name);
    assert.equal(item.specification.originalBytes, Buffer.byteLength(item.requirements));
    assert.equal(item.specification.faults.length, 4);
    let repaired = item.draft;
    for (const fault of item.specification.faults) {
      assert.equal(item.draft.slice(0, item.draft.indexOf(fault.draft)).split('\n').length, fault.line);
      repaired = repaired.replace(fault.draft, fault.original);
    }
    assert.equal(repaired, item.requirements, entry.name + ': undeclared changes to the full original requirement');
    if (entry.name.startsWith('swe-bench-')) {
      const raw = await fs.readFile(path.join(root, entry.name, item.specification.sourceRawFile));
      assert.equal(createHash('sha256').update(raw).digest('hex'), item.specification.sourceRawSha256);
      assert.equal(raw.length, item.specification.sourceRawBytes);
      assert.equal(raw.toString('utf8').replace(/\r\n/gu, '\n'), item.requirements,
        'Only CRLF-to-LF import is allowed; retain the entire source issue');
      assert.equal(item.specification.originalLines, item.requirements.split('\n').length);
      assert(item.specification.originalBytes > 7000);
      assert.equal(item.specification.sourceCommit, 'c104f840cc67f8b6eec6f759ebc8b2693d585d4a');
    }
  }
});
