// The semantic document harness: fictional case, independent final check,
// finding attribution, compaction-context analysis and generated policies.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRuntimePlan } from '../lib/runtime-plan.mjs';
import { checkSemanticDocument, documentSections, hostCompactionSettings, inspectNativeTranscript, loadSemanticDocumentCase,
  matchSemanticFindings, semanticDocumentPolicy } from '../scripts/evaluate-openclaw-semantic-document-e2e.mjs';
import { openclawDocumentOptions } from '../scripts/evaluate-openclaw-document-e2e.mjs';

const caseDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../examples/document-e2e/semantic-ledgerlite-export');

async function temporary(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-semantic-document-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function repaired(draft) {
  return draft
    .replace('Amount converted to floating-point dollars, for example `12.5`', 'Amount in integer cents (never floating point), for example `1250`')
    .replace('The personal `note` field is included by default as the last column; pass `--exclude-notes` to leave it out.',
      'The personal `note` field is not included by default; pass `--include-notes` to add it as the last column.')
    .replace('Rows are sorted by amount, largest first.', 'Rows are sorted by transaction date ascending, then by transaction id ascending; amounts do not affect ordering.')
    .replace('If the output file already exists, it is overwritten without asking.', 'If the output file already exists, the command refuses to write it and exits with code 2 unless `--force` is given.')
    .replace('On startup the command checks https://updates.ledgerlite.invalid for a newer version and sends an anonymous usage count.',
      'It runs fully offline: no network access, no telemetry and no update checks.');
}

test('the semantic case starts with every controlled deviation and accepts a compliant repair', async () => {
  const { specification, draft, requirementsMessage } = await loadSemanticDocumentCase(caseDirectory);
  assert.equal(specification.faults.length, 5);
  assert(requirementsMessage.includes('Never convert amounts to floating point'));
  const initial = checkSemanticDocument(specification, draft);
  assert.equal(initial.satisfied, false);
  assert.deepEqual(initial.faults.filter(item => item.satisfied), []);
  assert(initial.keep.every(item => item.satisfied));
  const fixed = checkSemanticDocument(specification, repaired(draft));
  assert.equal(fixed.satisfied, true, JSON.stringify(fixed));
  const partial = checkSemanticDocument(specification, repaired(draft).replace('`--force`', 'a flag'));
  assert.deepEqual(partial.faults.filter(item => !item.satisfied).map(item => item.id), ['F4']);
  const lost = checkSemanticDocument(specification, repaired(draft).replace('in UTC', 'in local time'));
  assert.equal(lost.satisfied, false);
  assert.deepEqual(lost.keep.filter(item => !item.satisfied).map(item => item.requirement), [3]);
});

test('findings count for the deviation whose section they point into', async () => {
  const { specification, draft } = await loadSemanticDocumentCase(caseDirectory);
  const sections = documentSections(draft);
  assert.equal(sections.find(item => item.title === 'Ordering').startLine, 25);
  const shifted = `\n\n${draft}`;
  const result = matchSemanticFindings(specification, shifted, [
    { path: 'design.md', severity: 'error', line: 20, message: 'floating point' },
    { path: 'design.md', severity: 'error', line: 29, message: 'ordering' },
    { path: 'design.md', severity: 'warning', line: 37, message: 'telemetry' },
    { path: 'design.md', severity: 'info', line: 33, message: 'ignored' },
    { path: 'design.md', severity: 'error', line: 3, message: 'title wording' },
    { path: 'draft.md', severity: 'error', line: 25, message: 'other file' },
  ]);
  assert.deepEqual(result.detected, ['F1', 'F3', 'F5']);
  assert.deepEqual(result.missed, ['F2', 'F4']);
  assert.deepEqual(result.extra.map(item => item.line), [3]);
});

test('compaction analysis reports whether the first turn is still in the business context', () => {
  const marker = 'Never convert amounts to floating point';
  const lines = records => records.map(item => JSON.stringify(item)).join('\n');
  const header = { type: 'session', id: 'fictional-session' };
  const user = { type: 'message', id: 'u1', parentId: null, message: { role: 'user', content: [{ type: 'text', text: `2. ${marker}.` }] } };
  const reply = { type: 'message', id: 'a1', parentId: 'u1', message: { role: 'assistant', content: [{ type: 'text', text: 'Noted' }] } };
  const before = inspectNativeTranscript(lines([header, user, reply]), marker);
  assert.equal(before.requirementMessageInBusinessContext, true);
  const summary = { type: 'compaction', id: 'c1', parentId: 'a1', firstKeptEntryId: 'a1', summary: 'User wants CSV and integer cents.' };
  const summarized = inspectNativeTranscript(lines([header, user, reply, summary]), marker);
  assert.equal(summarized.requirementMessageInFile, true);
  assert.equal(summarized.requirementMessageInBusinessContext, false);
  assert.equal(summarized.summaryProbes[2], true);
  assert.equal(summarized.summaryProbes[5], false);
  const truncated = inspectNativeTranscript(lines([header, { ...reply, parentId: null }]), marker);
  assert.equal(truncated.requirementMessageInFile, false);
  assert.equal(truncated.requirementMessageInBusinessContext, false);
  assert.equal(truncated.compactionRecord, false);
});

test('host compaction copies only the profile summary style and minimizes the preserved window', async t => {
  const root = await temporary(t);
  const file = path.join(root, 'openclaw.json');
  await fs.writeFile(file, JSON.stringify({ agents: { defaults: { compaction: { mode: 'safeguard', customInstructions: 'Keep ids.',
    keepRecentTokens: 20000, recentTurnsPreserve: 3, model: 'other/model', memoryFlush: { enabled: true } } } } }));
  assert.deepEqual(await hostCompactionSettings(file), { mode: 'safeguard', customInstructions: 'Keep ids.', keepRecentTokens: 1, recentTurnsPreserve: 0 });
});

test('both generated semantic policies load and select their review basis', async t => {
  for (const mode of ['original', 'ledger']) {
    const root = await temporary(t);
    await fs.mkdir(path.join(root, '.runtime-corrector'));
    await fs.writeFile(path.join(root, '.runtime-corrector/document-review.md'), 'Review.\n');
    await fs.writeFile(path.join(root, '.runtime-corrector/config.yaml'), semanticDocumentPolicy('fixture', openclawDocumentOptions(), mode, 'openai'));
    const plan = await loadRuntimePlan({ cwd: root });
    assert.equal(plan.runtimeV2.artifactCorrection.originalRequirementsEnabled, mode === 'original');
    assert.equal(plan.runtimeV2.artifactCorrection.groundTruthReviewEnabled, mode === 'ledger');
    assert.equal(plan.runtimeV2.dynamicGroundTruth.enabled, mode === 'ledger');
  }
});
