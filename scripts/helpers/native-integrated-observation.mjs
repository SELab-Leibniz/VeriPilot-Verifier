// Read-only association of actual host before-tool calls and middleware
// results. A missing middleware context never authorizes a guessed owner.
export function createIntegratedBusinessObserver({ business, append }) {
  const bindings = new Map();
  let observedBindings = 0, capacityExceeded = false;
  const fields = ['sessionId', 'sessionKey', 'runId'];
  const suppliedMatches = (identity, values) => values.every(value => fields.every(field =>
    value?.[field] === undefined || value[field] === identity[field]));
  return {
    async before(event, ctx = {}, decision) {
      // Keep minimal identities for every real before call, including private
      // and blocked calls. Otherwise a bare private result can borrow a
      // business call's ID. Private params/content never enter this registry.
      let call;
      if (event.toolCallId) {
        let calls = bindings.get(event.toolCallId);
        if (!calls) {
          if (observedBindings >= 1024) capacityExceeded = true;
          else bindings.set(event.toolCallId, calls = new Map());
        }
        if (calls) {
          const identity = Object.fromEntries(fields.map(field => [field, ctx[field]]));
          const identityKey = JSON.stringify(identity);
          call = calls.get(identityKey);
          if (call) call.conflict = true;
          else if (observedBindings >= 1024) capacityExceeded = true;
          else {
            observedBindings++;
            calls.set(identityKey, call = { ...identity, toolName: event.toolName, business: false,
              incomplete: fields.some(field => typeof ctx[field] !== 'string' || !ctx[field]) || !suppliedMatches(ctx, [event]),
              blocked: decision?.block === true });
          }
        }
      }
      const selected = await business();
      if (!selected || ctx.sessionId !== selected.sessionId || ctx.sessionKey !== selected.sessionKey) return;
      await append({ phase: 'before', at: Date.now(), ...Object.fromEntries(fields.map(field => [field, ctx[field]])), event, decision });
      if (call) call.business = true;
    },
    async result(event, ctx = {}) {
      const calls = [...bindings.get(event.toolCallId)?.values() ?? []];
      const bare = !fields.some(field => ctx[field] !== undefined || event[field] !== undefined);
      if (capacityExceeded || calls.some(call => call.incomplete) || bare && calls.length > 1) {
        await append({ phase: 'unavailable', at: Date.now(), toolCallId: event.toolCallId,
          reason: capacityExceeded ? 'observation-binding-cap' : 'ambiguous-tool-call' });
        return;
      }
      const candidates = calls
        .filter(binding => suppliedMatches(binding, [ctx, event])
          && (!event.toolName || binding.toolName === event.toolName));
      if (candidates.length !== 1 || candidates[0].conflict) {
        await append({ phase: 'unavailable', at: Date.now(), toolCallId: event.toolCallId,
          reason: candidates.length > 1 || candidates[0]?.conflict ? 'ambiguous-tool-call' : 'no-matching-tool-call' });
        return;
      }
      const candidate = candidates[0];
      if (!candidate.business) return; // No private result/payload is copied.
      if (candidate.blocked) {
        await append({ phase: 'unavailable', at: Date.now(), toolCallId: event.toolCallId, reason: 'blocked-tool-call' }); return;
      }
      const identity = Object.fromEntries(fields.map(field => [field, candidate[field]]));
      await append({ phase: 'result', at: Date.now(), ...identity, event });
      // Return no result or patch. Retain the association so a reused bare ID
      // remains ambiguous rather than silently becoming the newest owner.
    },
  };
}
