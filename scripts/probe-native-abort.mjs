// Real installed Gateway/transport; local hanging provider, no external model.
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createNativeGatewayEvaluation } from './helpers/native-gateway-evaluation.mjs';
const arg = name => process.argv.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1);
const outputRoot = path.resolve(arg('--output') ?? '.runtime-correction/system-optimization/abort-authorization-probe-001');
await fs.mkdir(outputRoot);
let requests = 0, gateway;
const provider = http.createServer((_req, _res) => { requests++; });
for (let port = 61000; ; port++) {
  try { await new Promise((resolve, reject) => { provider.once('error', reject); provider.listen(port, '127.0.0.1', resolve); }); break; }
  catch (error) { if (error.code !== 'EADDRINUSE' || port >= 61016) throw error; }
}
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${provider.address().port}/v1`;
process.env.ANTHROPIC_AUTH_TOKEN = 'transport-only';
process.env.ANTHROPIC_API_KEY = 'transport-only';
process.env.RC_EVAL_NATIVE_MODEL = 'transport-only-abort-probe';
try {
  gateway = await createNativeGatewayEvaluation({ hostRoot: arg('--host-root'), sourceRoot: process.cwd(),
    projectRoot: path.join(outputRoot, 'project'), outputRoot, prebuiltPluginRoot: arg('--artifact'), businessToolNames: [] });
  const key = `agent:main:abort-probe-${randomUUID()}`;
  const created = await gateway.request('sessions.create', { key, agentId: 'main', label: 'isolated model-free abort authorization' });
  assert(created.ok);
  const runId = randomUUID(), sessionKey = created.key;
  await gateway.request('chat.send', { sessionKey, message: 'Wait for this transport probe.', idempotencyKey: runId, deliver: false, timeoutMs: 60000 });
  const deadline = Date.now() + 20000;
  while (!requests && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert(requests > 0, 'actual host must reach local hanging provider before abort');
  const aborted = await gateway.request('chat.abort', { sessionKey, runId, preserveSideRuns: true });
  assert.equal(aborted.ok, true); assert.equal(aborted.aborted, true);
  await new Promise(resolve => setTimeout(resolve, 500));
  const session = await gateway.runtime.subagent.getSession({ sessionKey });
  const terminal = (session.messages ?? []).map(row => row.message ?? row).at(-1);
  assert.equal(terminal?.stopReason, 'aborted');
  const result = { kind: 'native-isolated-abort-authorization', passed: true, aborted, terminalStopReason: terminal.stopReason,
    localProviderRequests: requests, externalModelRequests: 0 };
  await fs.writeFile(path.join(outputRoot, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { await gateway?.close(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); }
// Installed host singletons retain observers after shutdown in this process.
process.exit(0);
