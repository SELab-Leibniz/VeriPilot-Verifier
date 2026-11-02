import test from 'node:test';
import assert from 'node:assert/strict';
import { unifiedSkillFeedbackReceipts } from '../scripts/helpers/skill-e2e-feedback.mjs';

test('unified native Skill feedback requires the same graph, a real Skill deviation and the actual owned admission', () => {
  const graph = { skillId: 'demo', digest: 'current-graph', constraints: [{ constraintId: 'rule-1' }] };
  const findings = [{ expectedConstraint: 'Original constraint/rule-1 requires verification.' }];
  const message = '[runtime-corrector:stop-feedback]\nM08:demo:rule-1 (demo@1): actual failed verification.\n[runtime-corrector:stop-reference]\n准入 actual-admission';
  const payload = { tools: [{ function: { name: 'exec' } }], messages: [{ role: 'user', content: message }] };
  const input = { payload, graph, findings, admissionIds: ['actual-admission'], request: 4 };
  assert.equal(unifiedSkillFeedbackReceipts(input)[0].objectId, 'M08:demo:rule-1');
  assert.equal(unifiedSkillFeedbackReceipts({ ...input,
    findings: [{ expectedConstraint: 'rule-1 (SKILL.md L6): verify the current delivery.' }] })[0].objectId, 'M08:demo:rule-1');
  for (const changed of [{ findings: [] }, { admissionIds: ['foreign'] }, { graph: { ...graph, skillId: 'other' } },
    { findings: [{ expectedConstraint: 'constraint/foreign' }] }, { findings: [{ expectedConstraint: 'rule-12 (SKILL.md L6): foreign node.' }] },
    { payload: { ...payload, messages: [{ role: 'assistant', content: message }] } },
    { payload: { ...payload, tools: [{ function: { name: 'rc_skill_care' } }] } },
    { payload: { ...payload, messages: [{ role: 'user', content: message.replace('[runtime-corrector:stop-feedback]', '') }] } }])
    assert.deepEqual(unifiedSkillFeedbackReceipts({ ...input, ...changed }), []);
});
