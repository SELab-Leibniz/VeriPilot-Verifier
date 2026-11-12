import test from 'node:test';
import assert from 'node:assert/strict';
import { proveCommandUnavailable } from '../lib/runtime-v2/environment-execution.mjs';
import { summarizeStopUnverified } from '../lib/runtime-v2/stop-unverified.mjs';
import { stopReviewCoverage } from '../lib/runtime-v2/stop-review-coverage.mjs';
import { nativeToolPolicyDigest, observeNativeToolPolicy } from '../lib/openclaw/native-transcript.mjs';

const tool = { name: 'read', schemaHash: '134f19bcabe3e29d63c5cebb38f1d2556759fd08adad6bc90a4b4d3cd1fb8441' };
const object = { objectId: 'M11:command', verificationTarget: 'PROCESS', originalSource: { kind: 'PROJECT_FILE', ref: 'AGENTS.md', start: 1, end: 1, sha256: 'source' } };
const command = 'python scripts/check.py';
const policy = { source: 'HOST_EFFECTIVE_TOOL_CATALOG', hostVersion: '2026.7.1-2', current: true,
  sessionId: 'business', policyDigest: 'policy', catalogDigest: 'catalog', tools: [tool] };
const args = { object, row: { judgement: 'UNVERIFIED' }, command, originalText: `Run ${command}.`, policy };

test('only a verified current nonexecuting host catalog excuses the exact original process command', () => {
  const proof = proveCommandUnavailable(args); assert.equal(proof.kind, 'ENVIRONMENT_UNEXECUTABLE');
  const row = { objectId: object.objectId, judgement: 'UNVERIFIED', reason: 'No execution proof.', environmentUnexecutable: proof };
  assert.equal(summarizeStopUnverified({ requirements: [object], judgements: [row] }).items.length, 0);
  const coverage = stopReviewCoverage({ requirements: [object], judgements: [row] });
  assert.equal(coverage.items[0].disposition, 'ENVIRONMENT_UNEXECUTABLE'); assert.equal(coverage.unverified, 0);
  for (const changed of [{ policy: null }, { policy: { ...policy, source: 'BUSINESS_CLAIM' } },
    { policy: { ...policy, current: false } }, { policy: { ...policy, tools: [] } },
    { policy: { ...policy, hostVersion: 'unknown' } }, { command: 'python other.py' },
    { object: { ...object, verificationTarget: 'IMPLEMENTATION' } }, { row: { judgement: 'DEVIATION' } },
    { policy: { ...policy, tools: [{ ...tool, schemaHash: 'changed' }] } },
    ...['exec', 'shell', 'bench_check', 'openspec_cli', 'unknown_plugin', 'delegate'].map(name => ({ policy: { ...policy, tools: [tool, { name }] } }))])
    assert.equal(proveCommandUnavailable({ ...args, ...changed }), null);
});

test('host session replacement and effective policy changes invalidate capability proof', async () => {
  const state = { sessionId: 'business', sessionKey: 'agent:main:business', agentId: 'main' };
  const config = { tools: {}, agents: { list: [{ id: 'main', tools: { allow: ['read'] } }] } };
  const entry = { sessionId: state.sessionId, systemPromptReport: { source: 'run', sessionId: state.sessionId, sessionKey: state.sessionKey, tools: { entries: [tool] } } };
  const api = { config, runtime: { version: '2026.7.1-2', agent: { session: { resolveStorePath: () => 'store', getSessionEntry: async () => entry } } } };
  state.businessToolPolicyDigest = nativeToolPolicyDigest(api, state);
  assert.equal((await observeNativeToolPolicy(api, state)).current, true);
  config.agents.list[0].tools.allow.push('exec');
  assert.equal((await observeNativeToolPolicy(api, state)).current, false);
  entry.sessionId = 'replacement'; assert.equal(await observeNativeToolPolicy(api, state), null);
});
