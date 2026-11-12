// Mechanism fixture: the script consumes real tools and original-byte receipts.
// Its chosen verdict is a transport witness, never a model accuracy claim.
import { randomUUID } from 'node:crypto';
import { runWorkspaceStopReview } from '../../lib/runtime-v2/stop-workspace-review.mjs';

export async function scriptedWorkspaceReview(input, { file, verdict = 'PASS', classification: selectedClassification,
  beforeScope, failAt = -1, finding, failFindings = false, script,
  reason = 'The scripted original-byte witness exercises production receipt and quota handling.' }) {
  const signal = input.abortSignal ?? new AbortController().signal;
  const deadlineAt = Math.min(input.deadlineAt ?? Infinity, Date.now() + (input.reviewer.timeoutMs ?? 20000));
  const session = { signal, deadlineAt, sessionId: randomUUID(), active() { signal.throwIfAborted(); },
    async run(worker) {
      const tools = new Map(worker.tools.map(tool => [tool.name, tool]));
      const call = async (name, args) => {
        worker.onAssistantMessageStart();
        const id = randomUUID(), result = await tools.get(name).execute(id, args);
        if (name === 'source_read') worker.observeReceipt({ toolName: name, toolCallId: id, isSynthetic: false,
          message: { role: 'toolResult', toolName: name, toolCallId: id, isError: false, content: result.content } });
        return result;
      };
      const read = async path => {
        let offset = 1, citeId;
        do {
          const result = await call('source_read', { path, offset });
          offset = result.details.page.nextOffset; citeId = result.details.citation.citeId;
        } while (offset !== null);
        return citeId;
      };
      const { task } = JSON.parse(worker.prompt);
      if (script) return script({ worker, task, call, read });
      for (const path of task.basisFiles) await read(path);
      const classification = task.fixedStopClassification ?? selectedClassification ?? { stopClassification: 'TASK_COMPLETE', stage: null };
      await beforeScope?.();
      await call('review_checklist', { stopClassification: classification.stopClassification,
        ...(classification.stage ? { stage: classification.stage } : {}),
        completionClaim: ['TASK_COMPLETE', 'STAGE_COMPLETE'].includes(classification.stopClassification),
        requiredUserInput: classification.requiredUserInput ?? null, externalBlocker: classification.externalBlocker ?? null });
      if (worker.isComplete()) return;
      if (finding) {
        const citeId = await read(file);
        await call('submit_finding', { ...finding, citeIds: [citeId] });
      }
      if (failFindings) throw Object.assign(new Error('The scripted context overflow preserves already saved findings.'), { code: 'CONTEXT_OVERFLOW' });
      let offset = 0;
      do {
        const response = await call('review_checklist', { offset, limit: 20 });
        const page = JSON.parse(response.content[0].text);
        for (const item of page.items) {
          if (item.savedResult) continue;
          if (offset + page.items.indexOf(item) === failAt) throw Object.assign(new Error('The scripted context overflow preserves already saved items.'), { code: 'CONTEXT_OVERFLOW' });
          const citeId = await read(file);
          const judgement = typeof verdict === 'function' ? verdict(item, offset + page.items.indexOf(item)) : verdict;
          if (judgement === null) continue;
          await call('submit_review', { taskId: item.taskId, verdict: judgement,
            reason, citeIds: [citeId],
            ...(item.metricId === 'M16' && judgement === 'PASS' ? { productionTrace: {
              version: 1, entryPoint: 'Scripted transport fixture entry', actualInput: 'Assigned fixture input',
              producerToConsumer: 'This scripted transport witness supplies no semantic oracle.', stateful: false,
              statelessReason: 'This controlled transport fixture has no persisted business state.', stateTargets: [], targetRelations: [],
            } } : {}) });
        }
        offset = page.nextOffset;
      } while (offset !== null);
      await call('finish_stop_review', { summary: 'The original checklist receipts are saved.' });
    } };
  return runWorkspaceStopReview(input, { session });
}
