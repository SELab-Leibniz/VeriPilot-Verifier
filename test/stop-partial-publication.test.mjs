import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runProtocolTask } from '../lib/review-task/protocol-task.mjs';

for (const failure of ['CONTEXT_OVERFLOW', 'REVIEWER_DEADLINE', 'ERR_INTERNAL']) {
  test('Stop publishes acknowledged partial work on ' + failure, async () => {
    const parent = path.resolve('.runtime-correction/stop-partial-publication-tests');
    await fs.mkdir(parent, { recursive: true });
    const root = await fs.mkdtemp(path.join(parent, 'run-'));
    const deadlineAt = Date.now() + 250;
    const partial = { confirmed: ['saved-deviation'], missing: ['proof'], unreviewed: ['remaining-scope'] };
    const task = runProtocolTask({
      task: { id: 'cutoff-control', scope: 'workspace-stop', basisFiles: [] },
      root, workspaceRoot: root, outputDir: root, deadlineAt, assertCurrent: async () => {},
      nativeRun: async ({ tools }) => {
        await tools.find(tool => tool.name === 'save_control').execute('control-save', {});
        if (failure === 'REVIEWER_DEADLINE') return new Promise(() => {});
        throw Object.assign(new Error('Interrupted simulated native operation'), { code: failure });
      },
      definition: {
        retainInterruptedResult: true,
        prompt: 'Save one controlled result.',
        tools: () => [{
          name: 'save_control', parameters: { type: 'object', properties: {}, additionalProperties: false },
          async submit(_value, ctx) {
            await ctx.persist('control.json', partial);
            ctx.state.result = partial;
            return { saved: true };
          },
        }],
      },
    });
    await assert.rejects(task, error => {
      assert.equal(error.code, failure);
      assert.equal(error.protocolResult.completed, false);
      assert.deepEqual(error.protocolResult.result, partial);
      return true;
    });
    const archived = JSON.parse(await fs.readFile(path.join(root, 'result.json'), 'utf8'));
    assert.deepEqual(archived.result, partial);
  });
}
