import { TASK_TOOL_NAMES, BASELINE_TOOL_NAMES } from './tool-contracts.mjs';
import { isInternalExecution } from './internal-context.mjs';
import { buildSemanticGraph, SEMANTIC_GRAPH_TOOL } from '../semantic-graph.mjs';
import { validateJsonSchema } from '../json-schema-validator.mjs';
export { TASK_TOOL_NAMES, BASELINE_TOOL_NAMES } from './tool-contracts.mjs';

// Shared across native registry reloads, but scoped to an unguessable reviewer
// session and removed on close. No business session receives these tools.
const key = Symbol.for('runtime-corrector.openclaw.task-tools.v1');
const bindings = globalThis[key] ??= new Map();
export function bindTaskTools({ sessionId, sessionKey, runId, agentId, signal, tools, active, checkpoint, observeReceipt, nativeOwner }) {
  if (bindings.has(sessionKey)) throw new Error('Review session is already bound');
  const binding = { sessionId, sessionKey, runId, agentId, signal, tools, active, checkpoint, observeReceipt, nativeOwner };
  bindings.set(sessionKey, binding);
  try { nativeOwner?.bindToolBinding(binding, () => bindings.get(sessionKey) === binding); }
  catch (error) { bindings.delete(sessionKey); throw error; }
  return () => {
    if (bindings.get(sessionKey) === binding) {
      bindings.delete(sessionKey); nativeOwner?.unbindToolBinding(binding);
    }
  };
}
function lookup(ctx) {
  const binding = ctx.sessionKey ? bindings.get(ctx.sessionKey) : [...bindings.values()].find(item => item.sessionId === ctx.sessionId);
  if (!binding || ctx.sessionId && ctx.sessionId !== binding.sessionId || ctx.runId && binding.runId && ctx.runId !== binding.runId) return null;
  return binding;
}
function workspaceGraph(ctx, resolveScope) {
  if (!resolveScope || !ctx.workspaceDir || !ctx.sessionKey || isInternalExecution()
    || /^agent:[^:]+:runtime-corrector:/u.test(ctx.sessionKey)) return null;
  return [{ ...SEMANTIC_GRAPH_TOOL, executionMode: 'sequential',
    description: `${SEMANTIC_GRAPH_TOOL.description} Before a source edit, check the existing callers and tests that must keep working. Use the host read tool to confirm the relevant lines.`,
    async execute(_id, args, signal) {
      if (validateJsonSchema(args, SEMANTIC_GRAPH_TOOL.parameters).length) throw new Error('Invalid semantic_graph query');
      ctx.assertInvocationCurrent?.();
      signal?.throwIfAborted();
      const scope = await resolveScope({}, ctx);
      if (!scope.enabled || !scope.projectRoot || scope.plan?.runtimeV2?.shadowMode) throw new Error('RC_PROJECT_NOT_ENABLED');
      const graph = await buildSemanticGraph(scope.projectRoot, { signal });
      const current = await resolveScope({}, ctx);
      ctx.assertInvocationCurrent?.();
      signal?.throwIfAborted();
      if (!current.enabled || current.plan?.runtimeV2?.shadowMode || current.fingerprint !== scope.fingerprint)
        throw new Error('RC_PROJECT_SCOPE_CHANGED');
      return { content: [{ type: 'text', text: JSON.stringify(graph.query(args)) }] };
    },
  }];
}

export function registerTaskTools(api, { resolveGraphScope } = {}) {
  api.registerTool(ctx => {
    if (ctx.sandboxed) return null;
    const binding = lookup(ctx);
    if (!binding) return workspaceGraph(ctx, resolveGraphScope);
    return binding.tools.map(tool => ({ ...tool, async execute(...args) {
      if (lookup(ctx) !== binding) throw new Error('Review tool binding expired');
      binding.active(); ctx.assertInvocationCurrent?.();
      if (binding.signal) args[2] = args[2] ? AbortSignal.any([binding.signal, args[2]]) : binding.signal;
      const result = await tool.execute(...args);
      if (lookup(ctx) !== binding) throw new Error('Review tool binding expired');
      if (binding.nativeOwner) binding.active();
      return result;
    } }));
  }, { names: [...new Set([...TASK_TOOL_NAMES, ...BASELINE_TOOL_NAMES])] });
  // This host hook is synchronous. Never return a Promise or rewrite the
  // message: inspect the completed result in its exact owning session only.
  api.on?.('tool_result_persist', (event, ctx) => {
    if (!['source_read', 'save_baseline_batch', 'commit_baseline_inventory', 'finish_baseline_audit'].includes(event.toolName) || event.isSynthetic !== false) return;
    const binding = lookup(ctx ?? {});
    if (!binding) return;
    if (binding.nativeOwner && (ctx?.sessionKey !== binding.sessionKey || ctx?.agentId && binding.agentId && ctx.agentId !== binding.agentId
      || ctx?.toolName && ctx.toolName !== event.toolName || ctx?.toolCallId && ctx.toolCallId !== event.toolCallId)) return;
    binding.observeReceipt?.(event, { binding, sessionKey: ctx?.sessionKey, agentId: ctx?.agentId,
      toolName: ctx?.toolName, toolCallId: ctx?.toolCallId });
  });
  for (const phase of ['before_compaction', 'after_compaction']) api.on?.(phase, async (_event, ctx) => {
    const binding = lookup(ctx ?? {});
    if (binding) { binding.active(); await binding.checkpoint(phase); }
  }, { timeoutMs: 30000 });
}
