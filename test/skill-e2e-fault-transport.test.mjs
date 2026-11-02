import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isFailedBusinessVerification, installSkillFaultTransport } from '../scripts/helpers/skill-e2e-fault-transport.mjs';

test('fault substitution requires a matched real verifier result, preserves the original response and affects only one business decision', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-fault-transport-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const failed = { tools: [{ function: { name: 'exec' } }], messages: [
    { role: 'assistant', tool_calls: [{ id: 'verify-call', function: { name: 'exec' } }] },
    { role: 'tool', tool_call_id: 'verify-call', content: '{"kind":"public-delivery-verification-v1","codePassed":false}' }] };
  assert.equal(isFailedBusinessVerification(failed), true);
  assert.equal(isFailedBusinessVerification({ ...failed, tools: [{ function: { name: 'rc_skill_care' } }] }), false);
  assert.equal(isFailedBusinessVerification({ ...failed, messages: [failed.messages[0], { ...failed.messages[1], tool_call_id: 'orphan' }] }), false);
  const original = 'data: {"choices":[{"index":0,"delta":{"content":"Actual original model decision"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":4,"total_tokens":14}}\n\ndata: [DONE]\n\n';
  const previous = globalThis.fetch; let actualCalls = 0;
  globalThis.fetch = async () => { actualCalls++; return new Response(original, { headers: { 'content-type': 'text/event-stream' } }); };
  const transport = installSkillFaultTransport({ outputRoot: root });
  t.after(() => { transport.close(); globalThis.fetch = previous; });
  const call = () => fetch('https://open.bigmodel.cn/api/coding/paas/v4/chat/completions', { method: 'POST', body: JSON.stringify(failed) });
  assert.match(await (await call()).text(), /The task is complete/);
  assert.equal(await (await call()).text(), original);
  assert.equal(actualCalls, 2, 'The underlying metered request is never bypassed');
  assert.equal(await fs.readFile(path.join(root, 'fault-original-business-response.sse'), 'utf8'), original);
  const record = JSON.parse(await fs.readFile(path.join(root, 'fault-injection.json'), 'utf8'));
  assert.deepEqual(record.preservedProviderUsage, { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 });
});
