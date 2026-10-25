// Scripted host contract, not a real host or model.
import { randomUUID } from 'node:crypto';
export function nativeTools(worker) {
  const tools = new Map(worker.tools.map(tool => [tool.name, tool]));
  return {
    turn: () => worker.onAssistantMessageStart(),
    async call(name, args, { deliver = true, isError = false, transform = value => value } = {}) {
      const result = await tools.get(name).execute(randomUUID(), args);
      if (deliver) worker.observeResult({ toolName: name, result: transform(result), isError });
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
