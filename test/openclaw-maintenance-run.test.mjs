import test from 'node:test';
import assert from 'node:assert/strict';
import { isHostMaintenanceRun } from '../lib/openclaw/internal-context.mjs';
test('a trusted memory trigger scopes later hooks to the exact internal run', () => {
  const runs = new Map(), memory = { agentId: 'main', sessionId: 'session', sessionKey: 'key', runId: 'memory', trigger: 'memory' };
  assert.equal(isHostMaintenanceRun({}, memory, runs), true);
  assert.equal(isHostMaintenanceRun({}, { ...memory, trigger: undefined }, runs), true);
  assert.equal(isHostMaintenanceRun({}, { ...memory, trigger: undefined, runId: 'business' }, runs), false);
  assert.equal(isHostMaintenanceRun({}, { runId: 'memory', sessionKey: 'key' }, runs), true);
});
test('shared IDs, conflicting identities and untrusted event triggers do not mute other business', () => {
  const runs = new Map();
  isHostMaintenanceRun({}, { agentId: 'main', sessionId: 'a', sessionKey: 'key-a', runId: 'memory', trigger: 'memory' }, runs);
  for (const ctx of [{ sessionId: 'b', sessionKey: 'key-a', runId: 'memory' },
    { agentId: 'other', sessionId: 'a', runId: 'memory' }, { sessionId: 'a', runId: 'business' }])
    assert.equal(isHostMaintenanceRun({ trigger: 'memory' }, ctx, runs), false);
});
test('unidentified memory events never taint a whole process or session', () => {
  const runs = new Map();
  assert.equal(isHostMaintenanceRun({}, { trigger: 'memory' }, runs), true);
  assert.equal(runs.size, 0);
  assert.equal(isHostMaintenanceRun({}, { sessionId: 'host', runId: 'business' }, runs), false);
});
