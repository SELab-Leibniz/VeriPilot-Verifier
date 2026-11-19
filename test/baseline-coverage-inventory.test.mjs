import test from 'node:test';
import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { sharedBasisFixture as createSharedBasisFixture, operation, user } from './helpers/runtime-v2-shared-basis-fixture.mjs';
import { scriptedCoverageReport, scriptedSourceInventory } from './helpers/baseline-coverage-native.mjs';
import { verifyBaselineCoverageProof, coverageIdentity, validateBaselineAuditReport, validateBaselineSourceInventory, baselineAuditSourceUnits, decodeBaselineAuditView, BASELINE_COVERAGE_INSTRUCTIONS, BASELINE_AUDIT_VIEW_PROTOCOL } from '../lib/runtime-v2/baseline-coverage-audit.mjs';
import { registerCitation } from '../lib/review-task/evidence-utils.mjs';
import { sourcePage } from '../lib/review-task/source-tools.mjs';
import { planGroundTruthDelta, groundTruthPlanDigest, applyGroundTruthDelta, freezeGroundTruth } from '../lib/runtime-v2/ground-truth-ledger.mjs';
import { ObservationJournal } from '../lib/review-task/observation-journal.mjs';
import { createBaselineWorker, BASELINE_EXTRACTION_PROTOCOL } from '../lib/review-task/baseline-task.mjs';
import { sourceUnits } from '../lib/review-task/baseline-selection.mjs';
import { withTaskState, ensureTask } from '../lib/runtime-v2/task-store.mjs';
import { sha256 } from '../lib/runtime-v2/utils.mjs';
import { refreshRuntimeRequirements } from '../lib/runtime-v2/orchestrator.mjs';
import { GROUND_TRUTH_REVIEW_SCHEMA } from '../lib/runtime-v2/reviewer.mjs';
import { STOP_TASK_LIMITS } from '../lib/review-task/stop-policy.mjs';
import { listNativeRuns } from '../lib/openclaw/native-runs.mjs';
import { coveredImplementationClaims } from '../lib/runtime-v2/baseline-coverage-audit.mjs';
import { TASK_SCOPE_INSTRUCTIONS } from '../lib/runtime-v2/ground-truth-provenance.mjs';

import { sharedBasisFixture, scratch, refreshCapturingAuditFailure, twoClaimFixture, missingReadReport, nativeAuditAttempt } from './helpers/baseline-coverage-fixture.mjs';

for (const nativeIsError of [true, false]) test(`a failed audit page read remains an owned negative transaction with native isError=${nativeIsError}`, async t => {
  const f = await sharedBasisFixture(t);
  f.state.coverageAfterInventory = async ({ params, tools }) => {
    const result = await nativeAuditAttempt(params, tools, 'source_read', { path: 'candidate-0.txt', offset: 2 }, 'invalid-candidate-page');
    assert.equal(result.isError, true); assert.equal(result.details?.citation, undefined);
    const feedback = JSON.parse(result.content[0].text);
    assert.equal(feedback.code, 'SOURCE_READ_RANGE_INVALID');
    if (!nativeIsError) {
      const rows = (await fs.readFile(params.sessionFile, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
      rows.find(row => row.message?.toolCallId === 'invalid-candidate-page').message.isError = false;
      await fs.writeFile(params.sessionFile, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    }
  };
  await f.refresh();
  const proof = (await f.task()).groundTruth.sharedBasis.coverageAudit;
  const bundle = await verifyBaselineCoverageProof(proof.pointer, { truth: await f.truth() });
  const denied = bundle.disclosures.find(row => row.toolCallId === 'invalid-candidate-page');
  assert.equal(denied.phase, 'DENIED'); assert.equal(denied.isError, true);
  assert(bundle.citations.some(row => row.path === 'candidate-0.txt' && row.start === 1));
  assert(!bundle.citations.some(row => row.path === 'candidate-0.txt' && row.start === 2));
});

test('a native success flag cannot hide candidate content behind an owned denial', async t => {
  const f = await sharedBasisFixture(t);
  f.state.coverageBeforeInventory = async ({ params, tools }) => {
    await nativeAuditAttempt(params, tools, 'source_read', { path: 'candidate-0.txt' }, 'tampered-early-read');
    const rows = (await fs.readFile(params.sessionFile, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
    const message = rows.find(row => row.message?.toolCallId === 'tampered-early-read').message;
    message.isError = false; message.content = [{ type: 'text', text: '{"accepted":true,"text":"unexpected candidate content"}' }];
    await fs.writeFile(params.sessionFile, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  };
  await assert.rejects(f.refresh()); assert.equal((await f.truth()).version, 0);
});

for (const missing of ['native-append', 'genuine-persist-hook']) test(`inventory generic callback cannot unlock phase two without ${missing}`, async t => {
  const f = await sharedBasisFixture(t); let observed = false;
  if (missing === 'native-append') f.state.coveragePersistInventory = false;
  else f.state.coverageObserveInventory = false;
  f.state.coverageOnInventory = ({ params, request, inventoryResult }) => {
    const receipt = JSON.parse(inventoryResult.content[0].text);
    assert.equal(receipt.accepted, true); assert.equal(receipt.complete, false);
    assert.equal(receipt.phase, 'INVENTORY_SEALED'); assert.equal(receipt.nextAction.navigationOnly, true);
    assert.equal(receipt.nextAction.tool, 'source_read'); assert.equal(receipt.nextAction.path, request.phaseTwoManifest);
    assert.equal(receipt.nextAction.offset, 1);
    assert.match(receipt.nextAction.instruction, /next assistant response of this SAME invocation/);
    assert.match(receipt.nextAction.instruction, /genuinely persisted and appended/);
    assert.match(receipt.nextAction.instruction, /Do not await a new user\/host message/);
    assert.equal(params.abortSignal.aborted, false, 'Inventory never completes or aborts the SDK'); observed = true;
  };
  await assert.rejects(f.refresh()); assert.equal(observed, true);
  assert.equal(f.audits().length, 1); assert.equal((await f.truth()).version, 0);
  assert.equal((await f.task()).groundTruth.sharedBasis, undefined);
});

test('source-only paths and every search tool deny candidate/control access without leaking and bounded continuation succeeds', async t => {
  const f = await sharedBasisFixture(t), attempts = [];
  f.state.coverageBeforeInventory = async ({ params, tools, request }) => {
    assert(request.requiredFiles.every(file => file.startsWith('original-source-') || file.startsWith('unit-catalog-')));
    assert(!Object.hasOwn(request, 'candidateViewProtocol'));
    const rows = [['source_read', { path: 'candidate-0.txt' }], ['source_read', { path: request.phaseTwoManifest }],
      ['source_read', { path: 'original-request-0000.txt' }], ['source_read', { path: 'original-baseline-0.txt' }],
      ['source_read', { path: './' + request.requiredFiles[0] }], ['source_read', { path: '../coverage-source/' + request.requiredFiles[0] }],
      ['source_read', { path: path.join(path.dirname(params.sessionFile), 'coverage-source', request.requiredFiles[0]) }],
      ['source_grep', { pattern: '.', path: '.' }], ['source_find', { pattern: '*' }], ['source_ls', { path: '.' }]];
    for (const [index, [name, args]] of rows.entries()) {
      const result = await nativeAuditAttempt(params, tools, name, args, `early-denied-${index}`);
      assert.equal(result.isError, true); assert.equal(result.details?.citation, undefined);
      const text = result.content.map(block => block.text).join('');
      assert.doesNotMatch(text, /Preserve the requested feature\.|requirements-[a-f0-9]{16}/u);
      attempts.push(result);
    }
  };
  await f.refresh(); assert.equal(attempts.length, 10);
  const bundle = await verifyBaselineCoverageProof((await f.task()).groundTruth.sharedBasis.coverageAudit.pointer);
  assert(bundle.journalEntries.some(entry => entry.message?.role === 'historical_observation'
    && entry.message.content.includes('before a later assistant response')));
  assert.equal(bundle.budget.auditCalls, 1); assert.equal(bundle.budget.externalRepairs, 0);
});

test('same-assistant-batch inventory plus candidate read stays denied even after inventory append; exact replay keeps first commitment', async t => {
  const f = await sharedBasisFixture(t); let originalId, sameArgs, originalNextAction, sameId = 'same-batch-candidate';
  f.state.coverageRepeatInventoryIdentity = true;
  f.state.coverageOnInventory = async ({ params, tools, request, inventoryId, inventoryResult }) => {
    originalId = inventoryId; sameArgs = { path: 'candidate-0.txt' };
    originalNextAction = JSON.parse(inventoryResult.content[0].text).nextAction;
    assert.equal(originalNextAction.path, request.phaseTwoManifest);
    const rows = (await fs.readFile(params.sessionFile, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
    const call = rows.find(row => row.message?.role === 'assistant' && row.message.content.some(block => block.id === inventoryId));
    call.message.content.push({ type: 'toolCall', id: sameId, name: 'source_read', arguments: sameArgs });
    await fs.writeFile(params.sessionFile, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    assert.equal(JSON.parse(inventoryResult.content[0].text).complete, false);
    assert.equal((await tools.find(tool => tool.name === 'source_read').execute(sameId, sameArgs)).isError, true);
    assert.equal(params.abortSignal.aborted, false, 'Genuine hook is pre-append, not final completion');
  };
  f.state.coverageAfterInventory = async ({ params, tools, inventoryArgs, inventoryResult }) => {
    const denied = await tools.find(tool => tool.name === 'source_read').execute(sameId, sameArgs);
    assert.equal(denied.isError, true, 'Even an appended inventory ACK cannot make its earlier assistant batch causal');
    await fs.appendFile(params.sessionFile, JSON.stringify({ type: 'message', message: { role: 'toolResult', toolCallId: sameId,
      toolName: 'source_read', content: denied.content, isError: true } }) + '\n');
    const replay = await nativeAuditAttempt(params, tools, 'commit_baseline_inventory', inventoryArgs, 'late-exact-replay');
    assert.deepEqual(replay.content, inventoryResult.content); assert.equal(replay.isError, false);
    const foreign = await nativeAuditAttempt(params, tools, 'commit_baseline_inventory',
      { ...inventoryArgs, identityDigest: 'different-identity' }, 'late-foreign-identity');
    assert.equal(foreign.isError, true);
    assert.match(foreign.content[0].text, /Repeated source inventory identity differs/u);
    const amended = structuredClone(inventoryArgs); amended.inventory.sources[0].units[0].reason += ' changed after source-only commitment';
    assert.equal((await nativeAuditAttempt(params, tools, 'commit_baseline_inventory', amended, 'late-amendment')).isError, true);
    assert.equal(params.abortSignal.aborted, false);
  };
  await f.refresh();
  const bundle = await verifyBaselineCoverageProof((await f.task()).groundTruth.sharedBasis.coverageAudit.pointer);
  assert.equal(bundle.inventory.record.toolCallId, originalId); assert.equal(bundle.inventory.nativeToolCallId, originalId);
  assert.equal(bundle.inventory.record.repeatedIdentity, true);
  assert.equal(bundle.inventory.record.receipt.complete, false); assert.equal(bundle.finish.record.receipt.complete, true);
  assert.deepEqual(bundle.inventory.record.receipt.nextAction, originalNextAction);
  assert.equal(bundle.budget.auditCalls, 1);
  assert.equal(bundle.report.inventoryDigest, sha256(bundle.inventory.record.inventory));
  const messages = bundle.nativeTranscript.split('\n').filter(Boolean).map(line => JSON.parse(line).message).filter(Boolean);
  assert(messages.findIndex(message => message.toolCallId === 'late-exact-replay') > bundle.inventory.position.result);
});

test('proof replay rejects inventory tampering and successful pre-commit disclosures even with a late identical inventory replay', async t => {
  const f = await sharedBasisFixture(t); await f.refresh();
  const pointer = (await f.task()).groundTruth.sharedBasis.coverageAudit.pointer;
  const original = await verifyBaselineCoverageProof(pointer);
  for (const mutate of [bundle => { bundle.inventory.record.inventory.sources[0].units[0].reason += ' forged'; },
    bundle => { bundle.inventory.position.result++; }, bundle => { bundle.report.inventoryDigest = 'foreign'; },
    bundle => {
      const rows = bundle.nativeTranscript.split('\n').filter(Boolean).map(JSON.parse), id = 'forged-success-before-commit';
      const inventoryIndex = rows.findIndex(row => row.message?.role === 'assistant' && row.message.content.some(block => block.name === 'commit_baseline_inventory'));
      rows.splice(inventoryIndex, 0,
        { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id, name: 'source_grep', arguments: { pattern: '.', path: '.' } }] } },
        { type: 'message', message: { role: 'toolResult', toolCallId: id, toolName: 'source_grep', content: [{ type: 'text', text: 'Actual successful candidate content leak' }], isError: false } });
      bundle.inventory.position.call += 2; bundle.inventory.position.result += 2;
      bundle.disclosures.push({ toolCallId: id, name: 'source_grep', args: { pattern: '.', path: '.' },
        phase: 'CANDIDATE', callIndex: inventoryIndex - 1, isError: false });
      rows.push({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'late-inventory-forgery',
        name: 'commit_baseline_inventory', arguments: { inventory: bundle.inventory.record.inventory } }] } },
        { type: 'message', message: { role: 'toolResult', toolCallId: 'late-inventory-forgery', toolName: 'commit_baseline_inventory',
          content: [{ type: 'text', text: JSON.stringify(bundle.inventory.record.receipt) }], isError: false } });
      bundle.nativeTranscript = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
    }]) {
    const bundle = structuredClone(original); mutate(bundle);
    const bytes = Buffer.from(JSON.stringify(bundle)), file = path.join(path.dirname(pointer.path), `${sha256(bundle)}.json`);
    await fs.writeFile(file, bytes, { flag: 'wx' });
    await assert.rejects(verifyBaselineCoverageProof({ path: file, digest: sha256(bundle), bytesDigest: sha256(bytes) }), { code: 'BASELINE_COVERAGE_UNVERIFIED' });
  }
  await verifyBaselineCoverageProof(pointer);
});
