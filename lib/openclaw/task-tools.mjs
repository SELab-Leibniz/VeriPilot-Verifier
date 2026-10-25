// Shared across native registry reloads, but scoped to an unguessable reviewer
// session and removed on close. No business session receives these tools.
const key = Symbol.for('runtime-corrector.openclaw.task-tools.v1');
const bindings = globalThis[key] ??= new Map();
export const TASK_TOOL_NAMES = ['source_read', 'source_grep', 'source_find', 'source_ls', 'review_history', 'submit_review'];
export function bindTaskTools({ sessionId, sessionKey, tools, active, checkpoint }) {
  if (bindings.has(sessionKey)) throw new Error('Review session is already bound');
  const binding = { sessionId, sessionKey, tools, active, checkpoint };
  bindings.set(sessionKey, binding);
  return () => { if (bindings.get(sessionKey) === binding) bindings.delete(sessionKey); };
}
function lookup(ctx) {
  const binding = ctx.sessionKey ? bindings.get(ctx.sessionKey) : [...bindings.values()].find(item => item.sessionId === ctx.sessionId);
  if (!binding || ctx.sessionId && ctx.sessionId !== binding.sessionId) return null;
  return binding;
}
export function registerTaskTools(api) {
  api.registerTool(ctx => {
    const binding = lookup(ctx);
    if (!binding || ctx.sandboxed) return null;
    return binding.tools.map(tool => ({ ...tool, async execute(...args) {
      if (lookup(ctx) !== binding) throw new Error('Review tool binding expired');
      binding.active(); ctx.assertInvocationCurrent?.();
      return tool.execute(...args);
    } }));
  }, { names: TASK_TOOL_NAMES });
  for (const phase of ['before_compaction', 'after_compaction']) api.on?.(phase, async (_event, ctx) => {
    const binding = lookup(ctx ?? {});
    if (binding) { binding.active(); await binding.checkpoint(phase); }
  }, { timeoutMs: 30000 });
}
