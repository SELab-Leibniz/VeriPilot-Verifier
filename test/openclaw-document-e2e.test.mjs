import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openclawDocumentOptions, collectAutomaticDocumentEvidence } from '../scripts/evaluate-openclaw-document-e2e.mjs';

test('OpenClaw document Hook, review and business budgets remain separately configurable', () => {
  const options = openclawDocumentOptions({ reviewTimeoutMs: 900000, hookTimeoutMs: 1200000,
    businessTimeoutMs: 1800000, totalTimeoutMs: 3600000 });
  assert.deepEqual(options, { reviewTimeoutMs: 900000, hookTimeoutMs: 1200000, businessTimeoutMs: 1800000, totalTimeoutMs: 3600000 });
  assert.throws(() => openclawDocumentOptions({ hookTimeoutMs: 1000 }), /whole seconds/);
  assert.throws(() => openclawDocumentOptions({ reviewTimeoutMs: 1200001 }), /whole seconds/);
  assert.throws(() => openclawDocumentOptions({ totalTimeoutMs: 3600001 }), /totalTimeoutMs/);
  assert.throws(() => openclawDocumentOptions({ timeout: 1200000 }), /Unknown/);
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
