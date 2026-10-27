import { runProtocolTask, taskError } from './protocol-task.mjs';

export function runFindingsTask({ findingSchema, acceptBatch, commitBatch = async () => {}, ...options }) {
  return runProtocolTask({ ...options, definition: {
    prompt: 'Inspect only currently provable deviations of the assigned frozen obligations and their original conditions. '
      + 'Use submit_findings for stable consecutive batchIds, then finish_findings. Each finding selects real source_read citeIds. '
      + 'No findings means no demonstrated deviation in this scope, never a completed business task or metric PASS. Do not invent metric objects.',
    tools: ({ task }) => [{ name: 'submit_findings', description: 'Save an independently validated findings batch with stable identity.',
      parameters: { type: 'object', additionalProperties: false, required: ['batchId', 'findings'], properties: {
        batchId: { type: 'integer', minimum: 1 }, findings: { type: 'array', minItems: 1, items: findingSchema },
      } },
      async submit(value, ctx) {
        ctx.requireBasis();
        const digest = ctx.digest(value), previous = ctx.state.batches.get(value.batchId);
        if (previous) {
          if (previous.digest !== digest) throw taskError('TASK_SUBMISSION_CONFLICT', 'Conflicting findings batch');
          return previous.receipt;
        }
        if (ctx.state.complete || value.batchId !== ctx.state.batches.size + 1)
          throw taskError('TASK_SUBMISSION_INVALID', 'Use consecutive batchIds before finish_findings');
        const accepted = await acceptBatch(value.findings, ctx);
        const receipt = { saved: true, taskId: task.id, batchId: value.batchId, digest };
        await ctx.persist(`batch-${value.batchId}.json`, { digest, ...accepted, receipt });
        await commitBatch(accepted, receipt); await ctx.check();
        ctx.state.batches.set(value.batchId, { digest, receipt, ...accepted }); ctx.state.receipts.push(receipt);
        ctx.state.result = { findings: [...ctx.state.batches.values()].flatMap(batch => batch.findings),
          citations: [...ctx.state.batches.values()].flatMap(batch => batch.citations) };
        return receipt;
      },
    }, { name: 'finish_findings', description: 'Complete the limited findings check, including a proved empty result; never a metric PASS.',
      parameters: { type: 'object', additionalProperties: false, required: ['batchIds', 'summary'], properties: {
        batchIds: { type: 'array', uniqueItems: true, items: { type: 'integer', minimum: 1 } }, summary: { type: 'string', minLength: 1 },
      } },
      async submit(value, ctx) {
        ctx.requireBasis();
        if (value.batchIds.length !== ctx.state.batches.size || value.batchIds.some((id, index) => id !== index + 1))
          throw taskError('TASK_SUBMISSION_INVALID', 'Completion must list every committed batch in order');
        const digest = ctx.digest(value);
        if (ctx.state.complete && ctx.state.finishDigest !== digest) throw taskError('TASK_SUBMISSION_CONFLICT', 'Conflicting finish request');
        const result = { ...(ctx.state.result ?? { findings: [], citations: [] }), summary: value.summary };
        const receipt = { complete: true, taskId: task.id, digest, batchIds: value.batchIds };
        await ctx.persist('findings.json', { result, receipt });
        ctx.state.result = result; ctx.state.complete = true; ctx.state.finishDigest = digest;
        return receipt;
      },
    }],
  } });
}
