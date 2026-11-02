import test from 'node:test';
import assert from 'node:assert/strict';
import * as sourceContract from '../lib/runtime-v2/skill-source.mjs';
import * as runtime from '../lib/runtime-v2/orchestrator.mjs';
import { sha256 } from '../lib/runtime-v2/utils.mjs';
import { interpretSkillUnit, skillGraphCandidate } from './helpers/skill-source-interpretation.mjs';

const original = text => ({ root: '/original/skill', digest: sha256(text), truncated: false,
  files: [{ path: 'SKILL.md', sha256: sha256(text), content: text }] });
function bind(text, interpretation) {
  const source = original(text);
  return sourceContract.bindSkillGraph(skillGraphCandidate(source, unit => interpretSkillUnit(unit, interpretation)), source);
}

test('an imperative beginning with Cancel is not advisory because it begins with Can', () => {
  assert.equal(bind('Cancel orphan tasks before publishing.').constraints[0].modality, 'MUST');
});

test('a permission followed by an independent Create duty does not soften that duty', () => {
  assert.equal(bind('You may inspect examples. Create app.mjs.', { normativity: 'MIXED', current: ['Create app.mjs.'] }).constraints[0].modality, 'MUST');
});

test('a descriptive source unit does not create a new hard obligation', () => {
  const graph = bind('This skill helps build validator libraries.', { normativity: 'DESCRIPTION' });
  assert.equal(graph.constraints.some(c => ['MUST', 'PROHIBITED'].includes(c.modality)), false);
});

test('an actual source-bound external condition cannot bypass assessment through CURRENT_TASK', () => {
  const graph = bind('If a later correction changes app.mjs, run the verifier again before completion.', {
    scope: 'EXTERNAL_TRIGGER', external: [{ condition: 'If a later correction changes app.mjs,', duty: 'run the verifier again before completion.' }] });
  assert.equal(sourceContract.skillConditionalTargets(graph).length, 1);
  assert.throws(() => runtime.validateSkillConditionalReview({ graph,
    review: { summary: 'Completed without observing any condition.', completionStatus: 'COMPLETED', findings: [] } }),
  /REVIEW_CONDITION_ASSESSMENT_REQUIRED|SKILL_SOURCE_INTERPRETATION_REQUIRED/);
});

test('binding locates originals and refuses absent or uncertain semantic interpretations instead of classifying language', () => {
  const source = original('Cancel orphan tasks before publishing.');
  const unit = sourceContract.skillSourceUnits(source).units[0];
  assert.equal(Object.hasOwn(unit, 'modality'), false);
  assert.throws(() => sourceContract.bindSkillGraph({ constraints: [{ constraintId: 'C0', sourceUnitIds: [unit.id] }], taskOverlays: [] }, source), /INTERPRETATION_REQUIRED/);
  assert.throws(() => bind(unit.text, { normativity: 'UNCERTAIN' }), /INTERPRETATION_UNRESOLVED/);
});

test('UTF16 span ownership rejects gaps, overlaps, split emoji, unknown fields and duplicate parent IDs', () => {
  const source = original('创建 😀 app.mjs。可选地查看示例。\n\nRun verification.'), candidate = skillGraphCandidate(source);
  const bad = mutate => { const value = structuredClone(candidate); mutate(value); assert.throws(() => sourceContract.bindSkillGraph(value, source), /SKILL_GRAPH_SOURCE/); };
  bad(c => { c.constraints[0].interpretation.currentDutySpans[0].end--; });
  bad(c => { c.constraints[0].interpretation.contextSpans = [{ start: 0, end: 1 }]; });
  bad(c => { c.constraints[0].interpretation.currentDutySpans[0].end = 4; c.constraints[0].interpretation.contextSpans = [{ start: 4, end: sourceContract.skillSourceUnits(source).units[0].text.length }]; });
  bad(c => { c.constraints[0].interpretation.currentDutySpans[0].end = 999; });
  bad(c => { c.constraints[0].interpretation.scopeOverride = 'CURRENT_TASK'; });
  bad(c => { c.constraints[1].constraintId = c.constraints[0].constraintId; });
  bad(c => { c.constraints.reverse(); });
  assert.equal(sourceContract.bindSkillGraph(candidate, source).constraints[0].sourceText, sourceContract.skillSourceUnits(source).units[0].text);
});
