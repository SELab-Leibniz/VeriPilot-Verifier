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

test('current structured Skill findings bind ACTIVE assessments to the original source-bound graph', () => {
  const graph={skillId:'demo',digest:'graph',constraints:[{constraintId:'rule-1',sourceBinding:'source-sha',sourceUnitIds:['rule-1']}]};
  const findings=[{expectedConstraint:'Verify after repairing the delivery.',reason:'The failed execution was followed by a false completion.',
    actualEvidence:['actual exit 3'],conditionAssessments:[{objectId:'rule-1',conditionAssessment:{activation:'ACTIVE'}}]}];
  const payload={tools:[{function:{name:'exec'}}],messages:[{role:'user',content:
    '[runtime-corrector:stop-feedback]\nM08:demo:rule-1 (demo@1): failed verification.\n[runtime-corrector:stop-reference]\n准入 used-admission'}]};
  const input={payload,graph,findings,admissionIds:['used-admission'],request:37};
  assert.equal(unifiedSkillFeedbackReceipts(input)[0].admissionId,'used-admission');
  const reject=mutate=>{const copy=structuredClone(input);mutate(copy);assert.deepEqual(unifiedSkillFeedbackReceipts(copy),[]);};
  for(const mutate of [
    x=>x.findings[0].conditionAssessments[0].objectId='foreign',
    x=>x.findings[0].conditionAssessments[0].conditionAssessment.activation='INACTIVE',
    x=>x.findings[0].conditionAssessments=[],
    x=>x.findings[0].actualEvidence=[],
    x=>x.findings[0].actualEvidence='unstructured claim',
    x=>x.findings[0].reason='',
    x=>x.findings[0].expectedConstraint='',
    x=>x.graph.constraints[0].sourceBinding=null,
    x=>x.graph.constraints[0].sourceUnitIds=['foreign'],
    x=>x.admissionIds=['unrelated']
  ])reject(mutate);
});
