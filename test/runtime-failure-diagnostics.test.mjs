import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runtimeFailureDiagnostics } from './helpers/runtime-failure-diagnostics.mjs';

test('fixture failure diagnostics retain enums, counts, receipt rejection and original deadline evidence without raw content', async () => {
  const secret = 'PRIVATE_PROMPT_SOURCE_AND_ERROR_TEXT';
  const value = await runtimeFailureDiagnostics({ now: 2000,
    task: { status: 'ACTIVE', groundTruth: { version: 2, onboardingPending: ['hidden'] },
      watchers: { secret: { status: 'UNVERIFIED_RECOVERY', pendingSelection: { text: secret }, sourceInterpretationChecked: false } } },
    events: [{ type: 'REVIEWER_FAILED', role: 'ground-truth-extractor', reason: secret,
      timeoutMs: 20000, deadlineAt: 1500, recordedAt: new Date(1600).toISOString(), prompt: secret }],
    calls: [{ role: 'ground-truth-extractor', request: { prompt: secret } }, { warning: secret }],
    launches: [{ timeoutMs: 19000, originalBudgetRemainingMs: 19950, startedAt: 1000, originalDeadlineAt: 20950, prompt: secret }],
    submissions: [{ attempt: 1, params: { prompt: secret }, value: { text: secret }, result: { isError: true,
      content: [{ type: 'text', text: JSON.stringify({ accepted: false, complete: false,
        code: 'BASELINE_COVERAGE_UNVERIFIED', message: secret, pending: [secret] }) }] } }],
    post: { phase: 'IDLE', reviewStatus: 'UNVERIFIED', candidate: { text: secret } } });
  assert.equal(value.tasks[0].watchers[0].status, 'UNVERIFIED_RECOVERY');
  assert.equal(value.events[0].deadlineExpiredAtEvent, true);
  assert.equal(value.events[0].timeoutMs, 20000);
  assert.deepEqual(value.events[0].reasonMarkers, [], 'arbitrary reason prose is not emitted or inferred as a failure code');
  assert.deepEqual(value.launches, [{ timeoutMs: 19000, originalBudgetRemainingMs: 19950,
    elapsedAtDiagnosticMs: 1000, originalBudgetAtDiagnostic: { remainingMs: 18950, expired: false } }]);
  assert(!JSON.stringify(value.launches).includes('20950'), 'raw timestamps are not printed');
  assert.deepEqual(value.submissions, [{ attempt: 1, isError: true, accepted: false, complete: false,
    code: 'BASELINE_COVERAGE_UNVERIFIED', pending: 1, receiptParsed: true }]);
  assert.equal(value.calls.warnings, 1);
  assert(!JSON.stringify(value).includes(secret));
});

test('fixture failure diagnostics bound task and journal reads and tolerate partial JSON', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-failure-diagnostics-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, '.runtime-correction/tasks/fixture');
  await fs.mkdir(path.join(directory, 'journal'), { recursive: true });
  await fs.writeFile(path.join(directory, 'task.json'), 'x'.repeat(1024 * 1024 + 1));
  await fs.writeFile(path.join(directory, 'journal/events.jsonl'), 'x'.repeat(70000) + '\n'
    + JSON.stringify({ type: 'REVIEWER_FAILED', reason: 'REVIEWER_DEADLINE', timeoutMs: 15000 }) + '\n{"partial":');
  const result = await runtimeFailureDiagnostics({ root });
  assert.deepEqual(result.tasks, [{ unavailable: 'SIZE_LIMIT' }]);
  assert.equal(result.events.length, 1);
  assert.deepEqual(result.events[0].reasonMarkers, ['REVIEWER_DEADLINE']);
  assert.equal(result.events[0].timeoutMs, 15000);
  assert(JSON.stringify(result).length < 4096);
});

test('fixture diagnostics distinguish a rejected finish from no submitted finish', async () => {
  const none = await runtimeFailureDiagnostics();
  const rejected = await runtimeFailureDiagnostics({ submissions: [{ result: { isError: true, content: [] } }] });
  assert.equal(none.submissions.length, 0);
  assert.equal(rejected.submissions.length, 1);
  assert.equal(rejected.submissions[0].isError, true);
  assert.equal(rejected.submissions[0].receiptParsed, false);
});
