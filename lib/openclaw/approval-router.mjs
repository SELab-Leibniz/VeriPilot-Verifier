import { randomUUID } from 'node:crypto';

export const APPROVAL_MODES = Object.freeze(['normal', 'unattended']);
export function approvalMode(value) {
  if (!APPROVAL_MODES.includes(value)) throw new Error('审批模式必须为 normal 或 unattended。');
  return value;
}
const privateKey = (key, agent, id) => key === `agent:${agent}:runtime-corrector:${id}`;
const businessKey = key => typeof key === 'string' && /^agent:[\w-]+:.+/u.test(key)
  && !/:runtime-corrector:|:rc-worker:/u.test(key);

// Routes decisions, never executes tools or changes the host's audit mode.
// Only program-bound, currently live private runs may use an unattended grant.
export function createApprovalRouter({ defaultMode = 'normal', modes = new Map(),
  confirmationTimeoutMs = 300000, record = () => {}, now = Date.now } = {}) {
  approvalMode(defaultMode);
  const runs = new Map(), pending = new Map(), history = [];
  const modeFor = key => modes.get(key) ?? defaultMode;
  const note = (owner, row) => {
    const value = { ...row, parentSessionKey: owner.parentSessionKey, sessionKey: owner.sessionKey,
      runId: owner.runId, taskId: owner.taskId, at: now(), navigationOnly: true };
    history.push(value); if (history.length > 200) history.shift();
    Promise.resolve().then(() => record(owner, value)).catch(() => {});
  };
  function finish(id, action, status, source) {
    const item = pending.get(id);
    if (!item) return;
    pending.delete(id); clearTimeout(item.timer);
    note(item.owner, { id, status, source, tool: item.request.tool });
    item.send({ id: item.request.id, action, source: `runtime-corrector:${source}` });
  }
  const active = owner => !owner.signal?.aborted && now() < owner.deadlineAt;
  return {
    modeFor,
    setMode(key, value) {
      if (!businessKey(key)) throw new Error('只能设置用户会话的审批模式。');
      modes.set(key, approvalMode(value));
    },
    bind(owner) {
      if (!privateKey(owner.sessionKey, owner.agentId, owner.sessionId) || !businessKey(owner.parentSessionKey)
        || !owner.parentSessionKey.startsWith(`agent:${owner.agentId}:`) || !owner.runId
        || !Number.isFinite(owner.deadlineAt) || !Array.isArray(owner.toolNames))
        throw new Error('RC_APPROVAL_OWNER_INVALID');
      if (runs.has(owner.sessionKey)) throw new Error('RC_APPROVAL_OWNER_CONFLICT');
      const bound = { ...owner, toolNames: new Set(owner.toolNames) };
      if (!active(bound)) throw new Error('RC_APPROVAL_OWNER_EXPIRED');
      runs.set(bound.sessionKey, bound);
      const close = () => {
        if (runs.get(bound.sessionKey) !== bound) return;
        runs.delete(bound.sessionKey); bound.signal?.removeEventListener('abort', close);
        for (const [id, item] of pending) if (item.owner === bound) finish(id, 'reject', 'CANCELLED', 'cancelled');
      };
      bound.signal?.addEventListener('abort', close, { once: true });
      return close;
    },
    request(request, { send, forward, connection }) {
      const owner = runs.get(request.sessionKey);
      if (!owner || request.runId !== owner.runId || request.type !== 'confirm') {
        // Expired/unowned private identities must not accidentally enter a new
        // run's grant or generate an invisible approval after cancellation.
        if (request.type === 'confirm' && /:runtime-corrector:/u.test(request.sessionKey ?? '')) {
          send({ id: request.id, action: 'reject', source: 'runtime-corrector:unbound' }); return;
        }
        try { forward(request); }
        catch { send({ id: request.id, action: 'reject', source: 'runtime-corrector:transport-error' }); }
        return;
      }
      if (!active(owner)) { send({ id: request.id, action: 'reject' }); return; }
      if (modeFor(owner.parentSessionKey) === 'unattended') {
        // Host blacklists have already run before a confirmation reaches us.
        // Grant only this invocation's program-supplied RC protocol; native or
        // unknown tools retain a denial, never a blanket process-wide grant.
        const allowed = owner.toolNames.has(request.tool);
        note(owner, { status: allowed ? 'AUTO_ALLOWED' : 'DENIED', source: 'unattended', tool: request.tool });
        send({ id: request.id, action: allowed ? 'allow' : 'reject', source: 'runtime-corrector:unattended' }); return;
      }
      if (pending.size >= 200) { send({ id: request.id, action: 'reject' }); return; }
      const id = `rc-confirm-${randomUUID()}`, expiresAt = Math.min(owner.deadlineAt, now() + confirmationTimeoutMs);
      const item = { owner, request, connection, send, expiresAt };
      item.timer = setTimeout(() => finish(id, 'reject', 'EXPIRED', 'expired'), Math.max(0, expiresAt - now()));
      pending.set(id, item);
      note(owner, { id, status: 'WAITING_FOR_USER', source: 'normal', tool: request.tool, expiresAt });
      try {
        // Only the UI destination changes. The original host promise, private
        // execution identity and original request ID remain owned by MA.
        forward({ ...request, id, sessionKey: owner.parentSessionKey,
          reason: `RC 后台检查需要确认：${request.reason ?? ''}` });
      } catch { finish(id, 'reject', 'UNAVAILABLE', 'transport-error'); }
    },
    response(response, connection) {
      const id = response.id ?? response.requestId, item = pending.get(id);
      if (!item) return !String(id ?? '').startsWith('rc-confirm-');
      if (item.connection !== connection) return false;
      if (!active(item.owner) || now() >= item.expiresAt) finish(id, 'reject', 'EXPIRED', 'expired');
      else finish(id, response.action === 'allow' ? 'allow' : 'reject',
        response.action === 'allow' ? 'USER_ALLOWED' : 'USER_REJECTED', 'user');
      return false;
    },
    disconnected(connection) {
      for (const [id, item] of pending) if (item.connection === connection) finish(id, 'reject', 'UNAVAILABLE', 'transport-error');
    },
    status(parentSessionKey) {
      return { mode: modeFor(parentSessionKey), pending: [...pending].filter(([, item]) => item.owner.parentSessionKey === parentSessionKey)
        .map(([id, item]) => ({ id, tool: item.request.tool, expiresAt: item.expiresAt, status: 'WAITING_FOR_USER' })),
      recent: history.filter(row => row.parentSessionKey === parentSessionKey).slice(-20) };
    },
    close() {
      for (const id of pending.keys()) finish(id, 'reject', 'CANCELLED', 'cancelled');
      runs.clear();
    },
  };
}
