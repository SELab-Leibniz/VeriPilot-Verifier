import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { stopProtocolFixture } from './helpers/stop-protocol.mjs';
import { eligibleStopStages } from '../lib/runtime-v2/review-routing.mjs';
import { loadPublicToolArgumentsValidator } from '../lib/openclaw/compat-2026.7.1-2.mjs';

test('production classification rejects completion disguised as waiting and accepts only unresolved prerequisites', async t => {
  const f = await stopProtocolFixture(t); f.input.request.classificationContract = 2;
  await f.run(async ({ readAll, submit }) => {
    await readAll();
    await assert.rejects(submit('submit_classification', { stopClassification: 'WAITING_FOR_USER', summary: 'Delivered, optional improvements offered.', completionClaim: true, requiredUserInput: null }), /Waiting requires/);
    await assert.rejects(submit('submit_classification', { stopClassification: 'WAITING_FOR_USER', summary: 'Pause.', completionClaim: false, requiredUserInput: '' }), /Waiting requires/);
    await assert.rejects(submit('submit_classification', { stopClassification: 'BLOCKED_EXTERNAL', summary: 'Pause.', completionClaim: false }), /concrete blocker/);
    await assert.rejects(submit('submit_classification', { stopClassification: 'TASK_COMPLETE', summary: 'Done.', completionClaim: true, requiredUserInput: 'Choose required output format.' }), /unresolved prerequisites/);
    await submit('submit_classification', { stopClassification: 'TASK_COMPLETE', summary: 'Delivered requested work; improvements are optional.', completionClaim: true, requiredUserInput: null, externalBlocker: null });
  });
});

test('source-only tasks cannot select configured document stages; an explicit empty stage list never expands to defaults', async t => {
  assert.deepEqual(eligibleStopStages({ claims: [{ status: 'ACTIVE', severity: 'HARD', verificationTarget: 'IMPLEMENTATION' }] }, ['proposal', 'design', 'tasks', 'implementation']), ['implementation']);
  assert.deepEqual(eligibleStopStages({ claims: [{ status: 'ACTIVE', severity: 'HARD', verificationTarget: 'ARTIFACT' }] }, ['design']), ['design']);
  const f = await stopProtocolFixture(t); f.input.request.workflowStages = [];
  await f.run(async ({ readAll, submit }) => {
    await readAll(); await assert.rejects(submit('submit_classification', { stopClassification: 'STAGE_COMPLETE', stage: 'tasks', summary: 'Code finished.' }), /frozen workflow/);
    await submit('submit_classification', { stopClassification: 'TASK_COMPLETE', summary: 'Requested code finished.' });
  });
});

for (const [stopClassification, fields] of [
  ['WAITING_FOR_USER', { requiredUserInput: 'The user must choose the required output format.', externalBlocker: null }],
  ['BLOCKED_EXTERNAL', { requiredUserInput: null, externalBlocker: 'The requested external service is unavailable.' }],
  ['INTERMEDIATE', { requiredUserInput: null, externalBlocker: null }],
]) test(`production classification preserves a genuine ${stopClassification} scope`, async t => {
  const f = await stopProtocolFixture(t); f.input.request.classificationContract = 2;
  const result = await f.run(async ({ readAll, submit }) => {
    await readAll(); await submit('submit_classification', { stopClassification, completionClaim: false,
      summary: 'Requested work remains under the stated stopping condition.', ...fields });
  });
  assert.equal(result.result.stopClassification, stopClassification);
  assert.deepEqual(result.result.metricObjectJudgements, []);
});

for (const kind of ['classification', 'findings']) test(`${kind} forwards effort off to OpenClaw and still requires evidence receipts`, async t => {
  const f = await stopProtocolFixture(t, kind);
  f.api.config.agents.defaults.model.primary = 'custom/deepseek-v4-flash';
  f.input.reviewer.effort = 'off';
  const before = structuredClone(f.api.config);
  const handle = await f.run(async ({ params, readAll, submit }) => {
    assert.equal(params.thinkLevel, 'off');
    assert.equal(params.provider, 'custom'); assert.equal(params.model, 'deepseek-v4-flash');
    assert.equal(params.config.agents.defaults.models['custom/deepseek-v4-flash'].params.maxTokens, 32768);
    assert.doesNotMatch(params.extraSystemPrompt, /Reasoning Effort:/u);
    await assert.rejects(kind === 'classification'
      ? submit('submit_classification', { stopClassification: 'TASK_COMPLETE', summary: 'Completed.' })
      : submit('finish_findings', { batchIds: [], summary: 'No demonstrated deviation.' }), /not fully read/);
    await readAll();
    if (kind === 'classification') await submit('submit_classification', { stopClassification: 'TASK_COMPLETE', summary: 'Completed.' });
    else await submit('finish_findings', { batchIds: [], summary: 'No demonstrated deviation.' });
  });
  assert.deepEqual(f.api.config, before);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(handle.result.metricObjectJudgements, []);
  await handle.close();
});

for (const classification of ['INTERMEDIATE', 'WAITING_FOR_USER', 'BLOCKED_EXTERNAL', 'STAGE_COMPLETE', 'TASK_COMPLETE']) {
  test(`classification tool commits ${classification} without a final JSON report`, async t => {
    const f = await stopProtocolFixture(t);
    const handle = await f.run(async ({ params, readAll, submit }) => {
      assert.equal(params.config.agents.defaults.models['offline/model'].params.maxTokens, 32768);
      assert(params.toolsAllow.includes('submit_classification')); assert(!params.toolsAllow.includes('submit_review'));
      await readAll(); await submit('submit_classification', { stopClassification: classification,
        ...(classification === 'STAGE_COMPLETE' ? { stage: 'design' } : {}), summary: 'The original response selects this scope.' });
    });
    assert.equal(handle.result.stopClassification, classification);
    assert.deepEqual(handle.result.metricObjectJudgements, []); assert.deepEqual(handle.result.findings, []);
    assert.equal(f.calls.length, 1);
  });
}

test('unread, truncated, unknown stage and business verdict submissions are rejected and repaired in the same worker', async t => {
  const f = await stopProtocolFixture(t);
  const value = { stopClassification: 'STAGE_COMPLETE', stage: 'design', summary: 'Design complete.' };
  const handle = await f.run(async ({ brief, read, readAll, submit, params, hooks }) => {
    await assert.rejects(submit('submit_classification', value), /not fully read/);
    await read(brief.task.basisFiles[0], { alter: true });
    await assert.rejects(submit('submit_classification', value), /not fully read/);
    await readAll();
    await hooks.get('before_compaction')({}, params); await hooks.get('after_compaction')({}, params);
    await assert.rejects(submit('submit_classification', { ...value, stage: 'foreign-stage' }), /frozen workflow/);
    await assert.rejects(submit('submit_classification', { ...value, verdict: 'PASS' }), /verdict/);
    await submit('submit_classification', value);
  });
  assert.equal(handle.result.stage, 'design'); assert.equal(f.calls.length, 1);
});

test('missing submissions get one same-session continuation and never consume final text as classification', async t => {
  const f = await stopProtocolFixture(t);
  await assert.rejects(f.run(async () => {}), error => error.code === 'TASK_NO_VALID_SUBMISSION');
  assert.equal(f.calls.length, 2); assert.equal(f.calls[0].sessionId, f.calls[1].sessionId);
  assert.notEqual(f.calls[0].runId, f.calls[1].runId);
  assert(f.calls[1].timeoutMs < f.calls[0].timeoutMs);
});

test('classification accepts a submission at round 200 and stops at round 201', async t => {
  for (const limit of [200, 201]) await t.test(String(limit), async t => {
    const f = await stopProtocolFixture(t);
    const work = f.run(async ({ readAll, advance, turns, params, submit }) => {
      await readAll();
      while (turns() < limit - (limit === 200 ? 1 : 0)) advance();
      if (limit === 200) await submit('submit_classification', { stopClassification: 'TASK_COMPLETE', summary: 'Completed scope.' });
      else assert.equal(params.abortSignal.aborted, true);
    });
    if (limit === 200) {
      const handle = await work, saved = JSON.parse(await fs.readFile(path.join(handle.artifacts, 'result.json'), 'utf8'));
      assert.equal(saved.turns, 200); assert.equal(saved.limits.maxTurns, 200);
    } else await assert.rejects(work, error => error.code === 'TURN_LIMIT');
    assert.equal(f.calls.length, 1);
  });
});

test('default, task and legacy native settings use the same classification protocol', async t => {
  for (const engine of [undefined, 'task', 'native']) {
    const f = await stopProtocolFixture(t);
    const handle = await f.run(async ({ readAll, submit }) => {
      await readAll(); await submit('submit_classification', { stopClassification: 'INTERMEDIATE', summary: 'Work continues.' });
    }, engine ? { stopReviewEngine: engine } : {});
    assert.equal(handle.result.stopClassification, 'INTERMEDIATE');
  }
});

test('classification cancellation prevents a late submission and continuation', async t => {
  const f = await stopProtocolFixture(t), controller = new AbortController(); f.input.abortSignal = controller.signal;
  await assert.rejects(f.run(async ({ readAll, submit }) => {
    await readAll(); controller.abort(new Error('Cancelled by caller'));
    await submit('submit_classification', { stopClassification: 'TASK_COMPLETE', summary: 'Late classification.' });
  }));
  assert.equal(f.calls.length, 1);
});

test('classification keeps the original absolute deadline across tool work', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = await stopProtocolFixture(t); f.input.deadlineAt = Date.now() + 1000;
  await assert.rejects(f.run(async ({ readAll, submit }) => {
    await readAll(); t.mock.timers.tick(1001);
    await submit('submit_classification', { stopClassification: 'TASK_COMPLETE', summary: 'Expired classification.' });
  }), { code: 'REVIEWER_DEADLINE' });
  assert.equal(f.calls.length, 1);
});

test('public SDK preserves nullable scope text without bypassing prerequisite or evidence checks', {
  skip: !process.env.RC_OPENCLAW_HOST_ROOT && 'requires the installed public OpenClaw SDK',
}, async t => {
  const sdk = await loadPublicToolArgumentsValidator();
  for (const kind of ['classification', 'workspace']) await t.test(kind, async t => {
    const f = await stopProtocolFixture(t, kind === 'workspace' ? 'findings' : 'classification');
    f.input.request.classificationContract = 2;
    if (kind === 'workspace') {
      f.input.request.reviewScope = { kind: 'workspace-stop' };
      delete f.input.request.fixedStopClassification;
    }
    const handle = await f.run(async ({ tools, readAll, read, submit }) => {
      const names = kind === 'workspace' ? ['review_scope', 'review_checklist'] : ['submit_classification'];
      const complete = { stopClassification: 'TASK_COMPLETE', summary: 'The requested scope is delivered.',
        completionClaim: true, requiredUserInput: null, externalBlocker: null };
      for (const name of names) {
        const tool = tools.get(name), check = args => sdk.validateToolArguments(tool, { name, arguments: args });
        const fields = kind === 'workspace'
          ? [['requiredUserInput', 768], ['externalBlocker', 768]]
          : [['requiredUserInput', 768], ['externalBlocker', 768], ['stage', 256]];
        for (const [field, max] of fields) {
          for (const value of [null, '', 'A bounded explanation.', 'x'.repeat(max)]) {
            const before = { ...complete, [field]: value }, actual = check(before);
            assert.deepEqual(actual[field], value, `${name}.${field} preserves null, empty and bounded text`);
            assert.deepEqual(before[field], value, 'frontend does not mutate the original tool call');
          }
          for (const value of ['x'.repeat(max + 1), {}, []])
            assert.throws(() => check({ ...complete, [field]: value }), /Validation failed for tool/);
          for (const value of [7, false])
            assert.equal(check({ ...complete, [field]: value })[field], String(value), 'stock scalar coercion is retained');
        }
      }
      const scopeTool = tools.get(names[0]);
      const accepted = sdk.validateToolArguments(scopeTool, { name: scopeTool.name, arguments: complete });
      await assert.rejects(submit(names[0], accepted), /not fully read/, 'schema validity cannot replace required read receipts');
      await readAll();
      const waiting = { ...complete, stopClassification: 'WAITING_FOR_USER', completionClaim: false };
      await assert.rejects(submit(names[0], sdk.validateToolArguments(scopeTool, { name: scopeTool.name, arguments: waiting })),
        /Waiting requires/, 'null is not an unresolved necessary prerequisite');
      await submit(names[0], accepted);
      if (kind === 'workspace') {
        const checklistTool = tools.get('review_checklist');
        await submit('review_checklist', sdk.validateToolArguments(checklistTool, { name: checklistTool.name, arguments: complete }));
        const current = await read(f.file);
        await submit('submit_review', { taskId: 'M01:R1', verdict: 'PASS', reason: 'Checked the current synthetic document.',
          citeIds: [current.details.citation.citeId] });
        await submit('finish_stop_review', { summary: 'The current synthetic scope review is complete.' });
      }
    });
    assert.equal(handle.result.stopClassification, 'TASK_COMPLETE');
    assert.equal(f.calls.length, 1, 'schema compatibility adds no worker or continuation');
    await handle.close();
  });
});
