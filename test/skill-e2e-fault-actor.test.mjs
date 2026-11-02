import test from 'node:test';
import assert from 'node:assert/strict';
import { skillFaultActorContext } from '../scripts/helpers/skill-e2e-fault-actor.mjs';

test('controlled fault guidance is confined to the genuine original business attempt and never reaches a reviewer or correction run', () => {
  const business = { sessionId: 'business', sessionKey: 'agent:main:business', originalRunId: 'first' };
  const context = { sessionId: business.sessionId, sessionKey: business.sessionKey, runId: business.originalRunId };
  const fixture = { controlledFault: true };
  assert.match(skillFaultActorContext({ fixture, business }, context).appendSystemContext, /not a change to the user's requirements/);
  for (const ctx of [{ ...context, runId: 'correction' }, { ...context, sessionId: 'private-reviewer' },
    { ...context, sessionKey: 'agent:main:other' }, { ...context, runId: undefined }])
    assert.equal(skillFaultActorContext({ fixture, business }, ctx), undefined);
  assert.equal(skillFaultActorContext({ fixture: {}, business }, context), undefined);
});
