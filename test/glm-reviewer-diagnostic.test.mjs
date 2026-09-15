import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeFixture, checkAssessment, requestAssessment } from '../scripts/diagnostics/glm-reviewer.mjs';

async function fixture(t, scenario) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'glm-fixture-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return makeFixture(root, scenario);
}
function valid(f) {
  return { summary: 'Checked synthetic documentation.', stopClassification: 'TASK_COMPLETE', findings: [],
    metricObjectJudgements: Object.values(f.population.metrics).flat().map(x => ({ objectId: x.objectId, judgement: 'PASS', reason: 'Documented.', evidence: ['proposal.md', 'design.md', 'tasks.md'] })) };
}
test('synthetic acceptance rejects missing metric evidence, unknown claims and false success', async t => {
  const f = await fixture(t, 'corrected'), assessment = valid(f);
  assert.equal(assessment.metricObjectJudgements.length, 12);
  assert.deepEqual(checkAssessment(f, assessment), []);
  const missing = structuredClone(assessment); missing.metricObjectJudgements.pop();
  assert.ok(checkAssessment(f, missing).some(x => x.includes('Missing object')));
  const duplicate = structuredClone(assessment); duplicate.metricObjectJudgements.push(duplicate.metricObjectJudgements[0]);
  assert.ok(checkAssessment(f, duplicate).some(x => x.includes('DUPLICATE_OBJECT')));
  const bad = await fixture(t, 'deviation');
  assert.ok(checkAssessment(bad, valid(bad)).some(x => x.includes('Missed blocking deviation')));
  const premature = { summary: 'Premature completion has three blockers', stopClassification: 'INTERMEDIATE',
    findings: bad.groundTruth.claims.map(x => ({ deviationKey: x.claimId, rootCauseId: 'REQUIREMENT_OMISSION', severity: 'error', reason: 'Missing from document', actualEvidence: ['design.md'], expectedConstraint: x.text, violatedGroundTruthIds: [x.claimId] })), metricObjectJudgements: [] };
  assert.deepEqual(checkAssessment(bad, premature), []);
  premature.metricObjectJudgements = valid(bad).metricObjectJudgements;
  assert.ok(checkAssessment(bad, premature).some(x => x.includes('Intermediate Stop')));
  const waiting = await fixture(t, 'waiting');
  assert.ok(checkAssessment(waiting, valid(waiting)).length >= 2);
  assert.deepEqual(checkAssessment(waiting, { summary: 'Awaiting input', stopClassification: 'WAITING_FOR_USER', findings: [], metricObjectJudgements: [] }), []);
});

test('SSE diagnostics preserve split Unicode and never pass exhausted or incomplete output', async t => {
  const previous = globalThis.fetch; t.after(() => { globalThis.fetch = previous; });
  const text = JSON.stringify({ summary: '已验证中文字符 🦀' });
  async function run(stopReason, output = text, thinking = 'synthetic') {
    const events = [
      { type: 'content_block_delta', delta: { thinking } },
      { type: 'content_block_delta', delta: { text: output } },
      ...(stopReason ? [{ type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 8192 } }] : []),
    ].map(x => `data: ${JSON.stringify(x)}\r\n\r\n`).join('');
    const bytes = new TextEncoder().encode(events);
    globalThis.fetch = async (url, options) => {
      assert.equal(options.redirect, 'error');
      return new Response(new ReadableStream({ start(controller) { for (const b of bytes) controller.enqueue(Uint8Array.of(b)); controller.close(); } }));
    };
    return requestAssessment({ url: 'https://example.invalid/v1/messages', key: 'fixture-secret', body: {}, timeoutMs: 1000 });
  }
  assert.equal((await run('end_turn')).assessment.summary, '已验证中文字符 🦀');
  assert.equal((await run('max_tokens', '')).failure, 'THINKING_EXHAUSTED_OUTPUT_BUDGET');
  assert.equal((await run('max_tokens')).failure, 'OUTPUT_TRUNCATED');
  assert.equal((await run(null)).failure, 'INCOMPLETE_STREAM');
});
