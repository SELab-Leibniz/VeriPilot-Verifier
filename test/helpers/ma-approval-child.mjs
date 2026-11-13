// Runs the installed, unmodified MA audit plugin in a separate test process.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createApprovalRouter } from '../../lib/openclaw/approval-router.mjs';
import { startApprovalRelay, loadMaApprovalAdapter } from '../../lib/openclaw/ma-approval-bridge.mjs';
import { createNativeTaskSession } from '../../lib/openclaw/task-session.mjs';

const host = process.argv[2], require = createRequire(path.join(host, 'package.json'));
const { WebSocket, WebSocketServer } = require('ws');
const audit = require(path.resolve(host, '../claw-plugin/matrixassistant-audit/dist/index.js'));
const backend = new WebSocketServer({ host: '127.0.0.1', port: 0 }), confirmations = [];
await new Promise(resolve => backend.once('listening', resolve));
let rejectNext = false;
backend.on('connection', socket => socket.on('message', bytes => {
  const request = JSON.parse(bytes.toString());
  if (request.type === 'confirm') {
    confirmations.push(request);
    socket.send(JSON.stringify({ id: request.id, action: rejectNext ? 'reject' : 'allow' }));
  }
}));
audit.initialize({ config: { mode: 'active', externalAuditEndpoint: `ws://127.0.0.1:${backend.address().port}/audit` } });
const previousEntry = process.argv[1]; let adapter;
try {
  process.argv[1] = path.join(host, 'openclaw.mjs');
  adapter = await loadMaApprovalAdapter({ config: { plugins: { entries: { 'matrixassistant-audit': { enabled: true } } } }, runtime: {} });
  assert.equal(adapter.audit, audit, 'startup must use the exact loaded audit module, not a detached copy');
} finally { process.argv[1] = previousEntry; }
const router = createApprovalRouter(), controller = new AbortController();
router.bind({ agentId: 'main', sessionId: 'private', sessionKey: 'agent:main:runtime-corrector:private', runId: 'private-run',
  parentSessionKey: 'agent:main:user', deadlineAt: Date.now() + 15000, signal: controller.signal, toolNames: ['source_read'] });
const relay = await startApprovalRelay({ router, adapter });
try {
  const event = { toolName: 'source_read', params: { path: 'docs/testing/DEVICE_TEST_FRAMEWORK.md', limit: 60 } };
  const context = { sessionKey: 'agent:main:runtime-corrector:private', runId: 'private-run', sessionId: 'private' };
  const first = await audit.before_tool_call(event, context);
  assert.equal(first, undefined); assert.equal(confirmations.length, 1);
  assert.equal(confirmations[0].sessionKey, 'agent:main:user');
  assert.match(confirmations[0].id, /^rc-confirm-/u);
  router.setMode('agent:main:user', 'unattended');
  await new Promise(resolve => setTimeout(resolve, 2));
  const second = await audit.before_tool_call(event, context);
  assert.equal(second, undefined); assert.equal(confirmations.length, 1);
  assert.equal(router.status('agent:main:user').recent.at(-1).status, 'AUTO_ALLOWED');
  router.setMode('agent:main:user', 'normal'); rejectNext = true;
  const third = await audit.before_tool_call(event, context);
  assert.equal(third.block, true); assert.equal(confirmations.length, 2);
  rejectNext = false;
  await audit.before_tool_call(event, { sessionKey: 'agent:main:business', sessionId: 'business', runId: 'business-run' });
  assert.equal(confirmations.at(-1).sessionKey, 'agent:main:business');
  assert.equal(audit.audit_getConfig().mode, 'active');
  let completed = false, executions = 0;
  const worker = { cwd: process.env.APPDATA, outputDir: process.env.APPDATA, prompt: 'isolated approval fixture', systemPrompt: '',
    tools: [{ name: 'source_read', async execute() { executions++; completed = true; return { content: [] }; } }],
    active() {}, isComplete: () => completed, onAssistantMessageStart() {} };
  const session = await createNativeTaskSession({ projectRoot: process.env.APPDATA, taskId: 'approval-native-task',
    role: 'requirement-frame', reviewer: { timeoutMs: 10000 } }, {
    api: { runtime: { version: '2026.7.1-2', agent: {} } }, selection: { config: {}, provider: 'fixture', model: 'fixture' },
    options: { approvalBridge: { bind: owner => router.bind(owner) }, parentSessionKey: 'agent:main:native-parent' },
    nativeRunner: async params => {
      const decision = await audit.before_tool_call(event, { sessionId: params.sessionId, sessionKey: params.sessionKey, runId: params.runId });
      if (decision?.block) throw new Error('Unexpected native task approval rejection');
      await worker.tools[0].execute(); return { payloads: [], meta: {} };
    },
  });
  try { await session.run(worker); await session.awaitOwnedSettlement(); }
  finally { await session.close(); }
  assert.equal(executions, 1); assert.equal(confirmations.at(-1).sessionKey, 'agent:main:native-parent');
  console.log('RC_APPROVAL_RESULT ' + JSON.stringify({ normal: 'allowed', unattended: 'allowed', rejected: third.block,
    businessSession: confirmations[2].sessionKey, backendConfirmations: confirmations.length, hostAuditMode: audit.audit_getConfig().mode }));
} finally {
  controller.abort(); audit.shutdown(); await relay.close();
  for (const client of backend.clients) client.terminate();
  await new Promise(resolve => backend.close(resolve));
}
