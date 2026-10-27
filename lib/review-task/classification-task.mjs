import { runProtocolTask, taskError } from './protocol-task.mjs';

export const STOP_CLASSIFICATIONS = Object.freeze(['INTERMEDIATE', 'WAITING_FOR_USER', 'BLOCKED_EXTERNAL', 'STAGE_COMPLETE', 'TASK_COMPLETE']);
export const CLASSIFICATION_TASK_PROMPT = 'Classify only the current stopping situation. A completion claim selects review scope, never acceptance PASS. '
  + 'Use STAGE_COMPLETE only with a stage from the frozen workflow. Missing execution proof does not by itself turn a completion claim into INTERMEDIATE. '
  + 'Call submit_classification; never submit findings, metric judgements or a full JSON report.';
export function runClassificationTask(options) {
  return runProtocolTask({ ...options, definition: {
    prompt: CLASSIFICATION_TASK_PROMPT,
    tools: ({ task }) => [{ name: 'submit_classification', description: 'Commit the Stop classification after complete required original reads.',
      parameters: { type: 'object', additionalProperties: false, required: ['stopClassification', 'summary'], properties: {
        stopClassification: { type: 'string', enum: STOP_CLASSIFICATIONS }, stage: { type: ['string', 'null'], maxLength: 256 },
        summary: { type: 'string', minLength: 1, maxLength: 768 },
      } },
      async submit(value, ctx) {
        ctx.requireBasis();
        if (!value.summary.trim() || value.summary.length > 768) throw taskError('STOP_CLASSIFICATION_INVALID', 'Classification summary must be nonempty and at most 768 characters');
        const result = { ...value, stage: value.stage ?? null };
        if (value.stopClassification === 'STAGE_COMPLETE') {
          if (!value.stage?.trim() || !task.allowedStages?.includes(value.stage))
            throw taskError('STOP_CLASSIFICATION_INVALID', 'Stage must match the frozen workflow scope');
        } else if (result.stage !== null) throw taskError('STOP_CLASSIFICATION_INVALID', 'Only STAGE_COMPLETE owns a stage');
        const digest = ctx.digest(result);
        if (ctx.state.complete) {
          if (ctx.state.receipts[0].digest !== digest) throw taskError('TASK_SUBMISSION_CONFLICT', 'Classification already committed');
          return ctx.state.receipts[0];
        }
        const receipt = { saved: true, taskId: task.id, workerType: 'classification', digest };
        await ctx.persist('classification.json', { result, receipt });
        ctx.state.result = result; ctx.state.receipts.push(receipt); ctx.state.complete = true;
        return receipt;
      },
    }],
  } });
}
