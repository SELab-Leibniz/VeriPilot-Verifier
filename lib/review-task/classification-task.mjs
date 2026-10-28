import { runProtocolTask, taskError } from './protocol-task.mjs';
import { validateStopClassification } from '../runtime-v2/stop-classification.mjs';

export const STOP_CLASSIFICATIONS = Object.freeze(['INTERMEDIATE', 'WAITING_FOR_USER', 'BLOCKED_EXTERNAL', 'STAGE_COMPLETE', 'TASK_COMPLETE']);
export const CLASSIFICATION_TASK_PROMPT = 'Classify only the current stopping situation. A completion claim selects review scope, never acceptance PASS. '
  + 'Use STAGE_COMPLETE only with a stage from the frozen workflow. Missing execution proof does not by itself turn a completion claim into INTERMEDIATE. '
  + 'Judge completion of the requested scope, not whether the conversation could continue. A delivered result followed by optional improvements, suggested questions or offers of more work is TASK_COMPLETE, not WAITING_FOR_USER. WAITING_FOR_USER requires an unresolved user decision necessary to fulfill the current request. BLOCKED_EXTERNAL requires a concrete external blocker. Code implementation and executed tests are not a proposal/design/tasks document stage just because those stages are configured. '
  + 'When classificationContract=2, submit completionClaim, requiredUserInput and externalBlocker. completionClaim describes the original assistant completion claim, not a verified business verdict. '
  + 'Call submit_classification; never submit findings, metric judgements or a full JSON report.';
export function runClassificationTask(options) {
  return runProtocolTask({ ...options, definition: {
    prompt: CLASSIFICATION_TASK_PROMPT,
    tools: ({ task }) => [{ name: 'submit_classification', description: 'Commit the Stop classification after complete required original reads.',
      parameters: { type: 'object', additionalProperties: false, required: ['stopClassification', 'summary'], properties: {
        stopClassification: { type: 'string', enum: STOP_CLASSIFICATIONS }, stage: { type: ['string', 'null'], maxLength: 256 },
        summary: { type: 'string', minLength: 1, maxLength: 768 },
        completionClaim: { type: 'boolean' }, requiredUserInput: { type: ['string', 'null'], maxLength: 768 },
        externalBlocker: { type: ['string', 'null'], maxLength: 768 },
      } },
      async submit(value, ctx) {
        ctx.requireBasis();
        if (!value.summary.trim() || value.summary.length > 768) throw taskError('STOP_CLASSIFICATION_INVALID', 'Classification summary must be nonempty and at most 768 characters');
        const result = { ...value, stage: value.stage ?? null };
        validateStopClassification(value, { contract: task.classificationContract, allowedStages: task.allowedStages });
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
