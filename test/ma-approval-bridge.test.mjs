import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { registerMaApprovals } from '../lib/openclaw/ma-approval-bridge.mjs';
import { runInternalExecution } from '../lib/openclaw/internal-context.mjs';

const host = process.env.RC_OPENCLAW_HOST_ROOT;
const run = promisify(execFile);
test('real MA audit plugin: normal allow/reject, unattended, and unaffected business approvals', { skip: !host }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-ma-approval-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { stdout } = await run(process.execPath, [fileURLToPath(new URL('./helpers/ma-approval-child.mjs', import.meta.url)), host], {
    env: { ...process.env, APPDATA: root, AUTH_LOGS: path.join(root, 'audit'), NODE_TEST_CONTEXT: '' },
    timeout: 20000, maxBuffer: 1024 * 1024, windowsHide: true,
  });
  const result = JSON.parse(stdout.split(/\r?\n/u).find(line => line.startsWith('RC_APPROVAL_RESULT ')).slice(19));
  assert.deepEqual(result, { normal: 'allowed', unattended: 'allowed', rejected: true, businessSession: 'agent:main:business',
    backendConfirmations: 4, hostAuditMode: 'active' });
});

test('mode changes require a live business identity and authenticated operator write scope', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-ma-control-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const methods = new Map(), services = [], commands = [], bridge = registerMaApprovals({
    config: {}, pluginConfig: {}, runtime: { version: '2026.7.1-2', state: { resolveStateDir: () => root },
      agent: { session: { resolveStorePath: () => root, getSessionEntry: async () => ({ sessionId: 'parent' }) } } },
    registerService: value => services.push(value), registerCommand: value => commands.push(value),
    registerGatewayMethod: (key, handler) => methods.set(key, handler),
  }, {}, { loadAdapter: async () => null });
  await services[0].start();
  const params = { agentId: 'main', sessionKey: 'agent:main:user', sessionId: 'parent', mode: 'unattended' };
  async function invoke(client, changed = {}) {
    let response;
    await methods.get('runtime-corrector.approvals.set')({ params: { ...params, ...changed }, client,
      respond: (...args) => { response = args; } });
    return response;
  }
  const readOnly = { connect: { role: 'operator', scopes: ['operator.read'] } };
  assert.equal((await invoke(readOnly))[0], false);
  const writer = { connect: { role: 'operator', scopes: ['operator.write'] } };
  assert.equal((await invoke({ ...writer, internal: { agentRuntimeIdentity: {} } }))[0], false);
  assert.equal((await invoke(writer, { sessionKey: 'agent:main:runtime-corrector:child' }))[0], false);
  assert.equal((await runInternalExecution('child', () => invoke(writer)))[0], false);
  assert.equal((await invoke(writer))[0], false, 'unsupported hosts must not report unattended mode as enabled');
  assert.equal(bridge.status(params.sessionKey).mode, 'normal');
  assert.equal(commands[0].name, 'rc-mode');
});

test('MA relay is not installed midway through a live audit connection', { skip: !host }, async () => {
  const { startApprovalRelay } = await import('../lib/openclaw/ma-approval-bridge.mjs');
  const { createApprovalRouter } = await import('../lib/openclaw/approval-router.mjs');
  const { WebSocket, WebSocketServer } = createRequire(path.join(host, 'package.json'))('ws');
  await assert.rejects(startApprovalRelay({ router: createApprovalRouter(), adapter: { WebSocket, WebSocketServer,
    audit: { audit_getStatus: () => ({ connected: true }) } } }), /MA_APPROVAL_RESTART_REQUIRED/);
});

test('authenticated choices persist across service restarts and concurrent session choices do not overwrite each other', { skip: !host }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-ma-modes-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { WebSocket, WebSocketServer } = createRequire(path.join(host, 'package.json'))('ws');
  const backend = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => backend.once('listening', resolve));
  t.after(() => new Promise(resolve => backend.close(resolve)));
  const endpoint = `ws://127.0.0.1:${backend.address().port}/audit`, config = { mode: 'active', externalAuditEndpoint: endpoint };
  const audit = { audit_getStatus: () => ({ connected: false }), audit_getConfig: () => ({ ...config }),
    audit_updateConfig: value => Object.assign(config, value) };
  const methods = new Map(), api = { config: {}, pluginConfig: {}, runtime: { state: { resolveStateDir: () => root },
    agent: { session: { resolveStorePath: () => root, getSessionEntry: async ({ sessionKey }) => ({ sessionId: sessionKey.split(':').at(-1) }) } } },
    registerGatewayMethod: (key, handler) => methods.set(key, handler) };
  const bridge = registerMaApprovals(api, {}, { loadAdapter: async () => ({ audit, WebSocket, WebSocketServer }) });
  t.after(() => bridge.close()); await bridge.start();
  assert.equal(bridge.status('agent:main:a').available, true);
  const set = async key => {
    let result;
    await methods.get('runtime-corrector.approvals.set')({ params: { agentId: 'main', sessionKey: `agent:main:${key}`, sessionId: key, mode: 'unattended' },
      client: { connect: { role: 'operator', scopes: ['operator.write'] } }, respond: (...args) => { result = args; } });
    assert.equal(result[0], true, JSON.stringify(result));
  };
  await Promise.all([set('a'), set('b')]);
  const stored = JSON.parse(await fs.readFile(path.join(root, 'runtime-corrector/approval-modes.json'), 'utf8'));
  assert.deepEqual(stored.sessions, { 'agent:main:a': 'unattended', 'agent:main:b': 'unattended' });
  await bridge.close(); assert.equal(config.externalAuditEndpoint, endpoint); assert.equal(config.mode, 'active');
  await bridge.start(); assert.equal(bridge.status('agent:main:a').mode, 'unattended');
  assert.equal(bridge.status('agent:main:other').mode, 'normal');
});
