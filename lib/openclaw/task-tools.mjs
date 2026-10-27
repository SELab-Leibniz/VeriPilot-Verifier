import { TASK_TOOL_NAMES, BASELINE_TOOL_NAMES } from './tool-contracts.mjs';
export { TASK_TOOL_NAMES, BASELINE_TOOL_NAMES } from './tool-contracts.mjs';

// Shared across native registry reloads, but scoped to an unguessable reviewer
// session and removed on close. No business session receives these tools.
const key = Symbol.for('runtime-corrector.openclaw.task-tools.v1');
const bindings = globalThis[key] ??= new Map();
export function bindTaskTools({ sessionId, sessionKey, runId, signal, tools, active, checkpoint, observeReceipt }) {
  if (bindings.has(sessionKey)) throw new Error('Review session is already bound');
  const binding = { sessionId, sessionKey, runId, signal, tools, active, checkpoint, observeReceipt };
  bindings.set(sessionKey, binding);
  return () => { if (bindings.get(sessionKey) === binding) bindings.delete(sessionKey); };
}
function lookup(ctx) {
  const binding = ctx.sessionKey ? bindings.get(ctx.sessionKey) : [...bindings.values()].find(item => item.sessionId === ctx.sessionId);
  if (!binding || ctx.sessionId && ctx.sessionId !== binding.sessionId || ctx.runId && binding.runId && ctx.runId !== binding.runId) return null;
  return binding;
}
export function registerTaskTools(api) {
  api.registerTool(ctx => {
    const binding = lookup(ctx);
    if (!binding || ctx.sandboxed) return null;
    return binding.tools.map(tool => ({ ...tool, async execute(...args) {
      if (lookup(ctx) !== binding) throw new Error('Review tool binding expired');
      binding.active(); ctx.assertInvocationCurrent?.();
      if (binding.signal) args[2] = args[2] ? AbortSignal.any([binding.signal, args[2]]) : binding.signal;
      const result = await tool.execute(...args);
      if (lookup(ctx) !== binding) throw new Error('Review tool binding expired');
      return result;
    } }));
  }, { names: [...new Set([...TASK_TOOL_NAMES, ...BASELINE_TOOL_NAMES])] });
  // This host hook is synchronous. Never return a Promise or rewrite the
  // message: inspect the completed result in its exact owning session only.
  api.on?.('tool_result_persist', (event, ctx) => {
    if (event.toolName !== 'source_read' || event.isSynthetic !== false) return;
    lookup(ctx ?? {})?.observeReceipt?.(event);
  });
  for (const phase of ['before_compaction', 'after_compaction']) api.on?.(phase, async (_event, ctx) => {
    const binding = lookup(ctx ?? {});
    if (binding) { binding.active(); await binding.checkpoint(phase); }
  }, { timeoutMs: 30000 });
}
