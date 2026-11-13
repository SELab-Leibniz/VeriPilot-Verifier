import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApprovalRouter, approvalMode } from './approval-router.mjs';
import { authenticatedActor } from './interaction-store.mjs';
import { sessionIdentity, currentSession } from './project-compat.mjs';
import { isInternalExecution, isManagedExecution } from './internal-context.mjs';
import { atomicWriteJson, appendJsonLine } from '../runtime-v2/utils.mjs';

// MA's supported audit transport/configuration exports are used unchanged.
// No hook is replaced, and the process-wide monitor switch is never touched.
export async function loadMaApprovalAdapter(api) {
  const config = api.runtime.config?.current?.() ?? api.config ?? {};
  if (!config.plugins?.entries?.['matrixassistant-audit']?.enabled) return null;
  const hostRoot = path.dirname(await fs.realpath(process.argv[1]));
  const manifest = JSON.parse(await fs.readFile(path.join(hostRoot, 'package.json'), 'utf8'));
  if (manifest.name !== 'openclaw') throw new Error('MA_APPROVAL_HOST_UNVERIFIED');
  const hostRequire = createRequire(path.join(hostRoot, 'package.json'));
  const candidates = [...(config.plugins?.load?.paths ?? []), path.join(hostRoot, '../claw-plugin/matrixassistant-audit')];
  let audit;
  for (const candidate of candidates) {
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(candidate, 'package.json'), 'utf8'));
      if (pkg.name !== '@openclaw/matrixassistant-audit') continue;
      audit = hostRequire(path.join(candidate, pkg.main ?? 'dist/index.js')); break;
    } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
  }
  for (const name of ['audit_getConfig', 'audit_updateConfig', 'audit_getStatus'])
    if (typeof audit?.[name] !== 'function') throw new Error('MA_APPROVAL_API_UNAVAILABLE');
  const { WebSocket, WebSocketServer } = hostRequire('ws');
  return { audit, WebSocket, WebSocketServer };
}

export async function startApprovalRelay({ router, adapter, onError = () => {} }) {
  const { audit, WebSocket, WebSocketServer } = adapter;
  if (audit.audit_getStatus().connected) throw new Error('MA_APPROVAL_RESTART_REQUIRED');
  const original = audit.audit_getConfig(), endpoint = new URL(original.externalAuditEndpoint);
  if (!['ws:', 'wss:'].includes(endpoint.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
    || endpoint.username || endpoint.password) throw new Error('MA_APPROVAL_ENDPOINT_UNVERIFIED');
  const originalEnv = process.env.MATRIX_AUDIT_ENDPOINT;
  const relayPath = `/rc-approvals/${randomUUID()}`, sockets = new Set();
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, path: relayPath, maxPayload: 1048576 });
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  server.on('error', onError);
  server.on('connection', upstream => {
    sockets.add(upstream);
    const downstream = new WebSocket(endpoint.href, { maxPayload: 1048576, handshakeTimeout: 10000 }), connection = {};
    let failed = false;
    const queued = [], outstanding = new Map();
    const send = value => {
      try { if (upstream.readyState === WebSocket.OPEN) upstream.send(JSON.stringify(value)); } catch {}
    };
    const forward = value => {
      if (failed) throw new Error('MA_APPROVAL_TRANSPORT_UNAVAILABLE');
      if (value.type === 'confirm') outstanding.set(value.id, value);
      if (downstream.readyState === WebSocket.OPEN) downstream.send(JSON.stringify(value));
      else if (queued.length < 200) queued.push(value);
      else throw new Error('MA_APPROVAL_TRANSPORT_BUSY');
    };
    const fail = () => {
      if (failed) return;
      failed = true; router.disconnected(connection);
      // A server-error response can fail open in MA. An unavailable relay
      // therefore always returns a rejection, never action=error or allow.
      for (const value of outstanding.values()) if (!String(value.id).startsWith('rc-confirm-')) send({ id: value.id, action: 'reject' });
      outstanding.clear(); queued.length = 0;
      // Drain rejection frames before reconnecting; no cached, dead transport
      // may leave future approvals waiting forever after the service recovers.
      if (upstream.readyState === WebSocket.OPEN) upstream.close(1011);
    };
    downstream.on('open', () => { for (const value of queued.splice(0)) downstream.send(JSON.stringify(value)); });
    downstream.on('message', bytes => {
      try {
        const value = JSON.parse(bytes.toString()); outstanding.delete(value.id ?? value.requestId);
        if (router.response(value, connection)) send(value);
      } catch { fail(); }
    });
    downstream.on('error', fail); downstream.on('close', fail);
    upstream.on('message', bytes => {
      try { router.request(JSON.parse(bytes.toString()), { send, forward, connection }); }
      catch { fail(); }
    });
    upstream.on('close', () => { fail(); downstream.terminate(); sockets.delete(upstream); });
    upstream.on('error', fail);
  });
  const url = `ws://127.0.0.1:${server.address().port}${relayPath}`;
  // Registries can reinitialize the audit plugin during an embedded run.
  // Its existing environment/configuration mechanism keeps every instance on
  // the same relay; business requests are forwarded without changing policy.
  process.env.MATRIX_AUDIT_ENDPOINT = url;
  audit.audit_updateConfig({ externalAuditEndpoint: url });
  return {
    url,
    async close() {
      router.close();
      if (audit.audit_getConfig().externalAuditEndpoint === url)
        audit.audit_updateConfig({ externalAuditEndpoint: original.externalAuditEndpoint });
      if (process.env.MATRIX_AUDIT_ENDPOINT === url) {
        if (originalEnv === undefined) delete process.env.MATRIX_AUDIT_ENDPOINT;
        else process.env.MATRIX_AUDIT_ENDPOINT = originalEnv;
      }
      for (const socket of sockets) socket.close(1001);
      await new Promise(resolve => {
        const timeout = setTimeout(() => { for (const socket of sockets) socket.terminate(); }, 250);
        server.close(() => { clearTimeout(timeout); resolve(); });
      });
    },
  };
}

export function registerMaApprovals(api, sharedState = {}, { loadAdapter = loadMaApprovalAdapter } = {}) {
  if (sharedState.approvals) return sharedState.approvals;
  const settings = api.pluginConfig?.approvals ?? {};
  const defaultMode = approvalMode(settings.mode ?? 'normal');
  const confirmationTimeoutMs = settings.confirmationTimeoutMs ?? 300000;
  if (!Number.isSafeInteger(confirmationTimeoutMs) || confirmationTimeoutMs < 1000 || confirmationTimeoutMs > 86400000)
    throw new Error('Invalid approvals.confirmationTimeoutMs');
  const modes = new Map();
  let relay, status = 'NOT_STARTED', store, start, save = Promise.resolve();
  const router = createApprovalRouter({ modes, defaultMode, confirmationTimeoutMs,
    record: (owner, row) => owner.projectRoot ? appendJsonLine(path.join(owner.projectRoot,
      '.runtime-correction/openclaw/approvals/events.jsonl'), row) : undefined });
  const bridge = {
    bind(owner) {
      if (!relay) {
        if (router.modeFor(owner.parentSessionKey) === 'unattended') throw new Error(`RC_APPROVAL_UNAVAILABLE: ${status}`);
        return () => {};
      }
      return router.bind(owner);
    },
    status(key) { return { ...router.status(key), available: Boolean(relay), reason: status }; },
    async start() {
      return start ??= (async () => {
        try {
          const adapter = await loadAdapter(api);
          if (!adapter) { status = 'HOST_NOT_MA'; return; }
          const stateDir = api.runtime.state?.resolveStateDir?.();
          if (!stateDir || !path.isAbsolute(stateDir)) throw new Error('RC_APPROVAL_STATE_UNAVAILABLE');
          store = path.join(stateDir, 'runtime-corrector', 'approval-modes.json');
          try {
            const stored = JSON.parse(await fs.readFile(store, 'utf8'));
            for (const [key, value] of Object.entries(stored.sessions ?? {})) router.setMode(key, value);
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
          relay = await startApprovalRelay({ router, adapter, onError: error => api.logger?.warn?.(`RC approval relay: ${error.code ?? error.name}`) });
          status = 'READY';
        } catch (error) { status = error.code ?? error.message; api.logger?.warn?.(`RC approval bridge unavailable: ${status}`); }
      })();
    },
    async setMode(key, mode) {
      if (!relay || !store) throw new Error(`RC_APPROVAL_UNAVAILABLE: ${status}`);
      approvalMode(mode);
      // Validate the target before persisting; update active grants only after
      // the authenticated choice has been durably written.
      const validator = createApprovalRouter(); validator.setMode(key, mode); validator.close();
      const operation = save.catch(() => {}).then(async () => {
        if (!relay) throw new Error('RC_APPROVAL_UNAVAILABLE: STOPPED');
        const next = Object.fromEntries(modes); next[key] = mode;
        await atomicWriteJson(store, { version: 1, sessions: next });
        router.setMode(key, mode); return bridge.status(key);
      });
      save = operation; return operation;
    },
    async close() { await save.catch(() => {}); await relay?.close(); relay = undefined; start = undefined; status = 'STOPPED'; },
  };
  sharedState.approvals = bridge;
  api.registerService?.({ apiVersion: 2, id: 'runtime-corrector-approvals', start: bridge.start, stop: bridge.close });
  const authorize = async (ctx, write) => {
    const scopes = ctx.gatewayClientScopes ?? [];
    if (isInternalExecution() || isManagedExecution() || ctx.isAuthorizedSender !== true
      || !(scopes.includes('operator.admin') || scopes.includes(write ? 'operator.write' : 'operator.read')
        || !ctx.gatewayClientScopes && ctx.senderIsOwner === true)) throw new Error('需要已认证的用户权限。');
    const identity = sessionIdentity({}, ctx);
    if (/:runtime-corrector:|:rc-worker:/u.test(identity.sessionKey)) throw new Error('不能设置后台会话的权限。');
    await currentSession(api, identity); return identity;
  };
  api.registerCommand?.({ name: 'rc-mode', description: 'RC 普通模式或无人值守模式', acceptsArgs: true,
    requireAuth: true, requiredScopes: ['operator.read'], async handler(ctx) {
      try {
        const mode = ctx.args?.trim() || 'status', identity = await authorize(ctx, mode !== 'status');
        const result = mode === 'status' ? bridge.status(identity.sessionKey) : await bridge.setMode(identity.sessionKey, mode);
        return { text: `RC：${result.mode === 'normal' ? '普通模式' : '无人值守模式'}${result.available ? '' : `（审批连接不可用：${result.reason}）`}` };
      } catch (error) { return { text: error.message }; }
    } });
  for (const action of ['get', 'set']) api.registerGatewayMethod?.(`runtime-corrector.approvals.${action}`, async ({ params, client, respond }) => {
    try {
      const write = action === 'set'; authenticatedActor(client, write);
      if (!params || Object.keys(params).some(key => !['agentId', 'sessionKey', 'sessionId', ...(write ? ['mode'] : [])].includes(key))) throw new Error('Invalid approval parameters.');
      const identity = await authorize({ ...params, isAuthorizedSender: true, gatewayClientScopes: client.connect.scopes }, write);
      const value = write ? await bridge.setMode(identity.sessionKey, params.mode) : bridge.status(identity.sessionKey);
      respond(true, value);
    } catch (error) { respond(false, undefined, { code: 'INVALID_REQUEST', message: String(error.message).slice(0, 600) }); }
  }, { scope: action === 'set' ? 'operator.write' : 'operator.read' });
  return bridge;
}
