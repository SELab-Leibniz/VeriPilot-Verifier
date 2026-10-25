// Scripted host contract, not a real host or model.
import { randomUUID } from 'node:crypto';
export function nativeTools(worker) {
  const tools = new Map(worker.tools.map(tool => [tool.name, tool]));
  return {
    turn: () => worker.onAssistantMessageStart(),
    async call(name, args, { deliver = true, receipt = true, isError = false, isSynthetic = false, transform = value => value, observerTransform = value => value, receiptCallId } = {}) {
      const toolCallId = randomUUID(), result = await tools.get(name).execute(toolCallId, args);
      const finalResult = transform(result);
      if (deliver) {
        worker.observeResult({ toolName: name, result: observerTransform(finalResult), isError });
        if (receipt) worker.observeReceipt({ toolName: name, toolCallId: receiptCallId ?? toolCallId, isSynthetic,
          message: { role: 'toolResult', toolCallId, toolName: name, content: finalResult.content, isError: isError || finalResult.isError === true } });
      }
      return result;
    },
    async read(file, args = {}, options) {
      this.turn(); const result = await this.call('source_read', { path: file, ...args }, options);
      return result.details?.citation?.citeId;
    },
    async submit(taskId, verdict, citeIds, extra = {}) {
      this.turn(); return this.call('submit_review', { taskId, verdict, reason: 'The frozen source supports the assigned decision.', citeIds, ...extra });
    },
  };
}
