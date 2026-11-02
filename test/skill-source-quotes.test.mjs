import test from 'node:test';
import assert from 'node:assert/strict';
import * as skill from '../lib/runtime-v2/skill-source.mjs';
import { sha256 } from '../lib/runtime-v2/utils.mjs';
import { validateSkillConditionalReview } from '../lib/runtime-v2/orchestrator.mjs';

const text = 'Create app.mjs. You may inspect examples if useful. If a later correction changes app.mjs, run verification again before completion.';
const source = body => ({ root: '/original/skill', digest: sha256(body), truncated: false,
  files: [{ path: 'SKILL.md', content: body, sha256: sha256(body) }] });
const interpretation = () => ({ normativity: 'MIXED', scope: 'COMPOUND', reason: 'Controlled explicit semantic proposal.',
  currentDuties: [{ quote: 'Create app.mjs.' }], externalConditions: [{ condition: { quote: 'If a later correction changes app.mjs,' },
    duty: { quote: 'run verification again before completion.' }, verificationTarget: 'PROCESS' }],
  remainderDisposition: 'CONTEXT_ONLY', remainderReason: 'Optional permission and whitespace only; this is a fallible semantic assertion.' });
function candidate(original, value) {
  return { constraints: [{ constraintId: 'C0', sourceUnitIds: [skill.skillSourceUnits(original).units[0].id], interpretation: value }], taskOverlays: [] };
}

test('exact quotes determine canonical UTF16 spans and context complement without dropping the r in run', () => {
  const original = source(text), graph = skill.bindSkillGraphFromQuotes(candidate(original, interpretation()), original);
  const node = graph.constraints[0], value = node.sourceInterpretation;
  assert.deepEqual(value.currentDutySpans, [{ start: 0, end: 15 }]);
  assert.deepEqual(value.externalConditions[0].duty, { start: 91, end: 132 });
  assert.deepEqual(value.contextSpans, [{ start: 15, end: 52 }, { start: 90, end: 91 }]);
  assert.equal(node.sourceText, text); assert.equal(node.modality, 'MUST');
  assert.equal(node.applicabilityKind, 'CURRENT_TASK');
  assert.equal(skill.skillConditionalTargets(graph).length, 1);
  const raw = { ...value, externalConditions: value.externalConditions.map(({ condition, duty, verificationTarget }) => ({ condition, duty, verificationTarget })) };
  assert.deepEqual(skill.bindSkillGraph(candidate(original, raw), original), graph, 'canonical store/reviewer representation rebinds through the same strict binder');
});

test('quote input rejects numeric context, overlap, missing semantics, ambiguity and unknown source units', () => {
  const original = source(text);
  for (const mutate of [v => { v.currentDuties[0].quote = text; }, v => { v.contextSpans = []; },
    v => { delete v.remainderDisposition; }, v => { delete v.scope; }, v => { v.currentDuties[0].quote = 'create app.mjs.'; },
    v => { v.externalConditions[0].duty.quote = ''; }]) {
    const value = interpretation(); mutate(value);
    assert.throws(() => skill.bindSkillGraphFromQuotes(candidate(original, value), original), /SKILL_GRAPH_SOURCE/u);
  }
  const ambiguous = source('Run. Run.'), value = { ...interpretation(), normativity: 'MANDATORY', scope: 'CURRENT_TASK',
    currentDuties: [{ quote: 'Run.' }], externalConditions: [] };
  assert.throws(() => skill.bindSkillGraphFromQuotes(candidate(ambiguous, value), ambiguous), /unique|ambiguous/iu);
  const bad = candidate(original, interpretation()); bad.constraints[0].sourceUnitIds = ['unknown'];
  assert.throws(() => skill.bindSkillGraphFromQuotes(bad, original), /SKILL_GRAPH_SOURCE/u);
});

test('quotes retain emoji, tail obligations and explicit uncertainty without automatic normative defaults', () => {
  const body = '说明 😀。创建 app.mjs。可以查看示例。完成前运行验证。', original = source(body);
  const value = { normativity: 'MIXED', scope: 'CURRENT_TASK', reason: 'Two independent mandatory actions and optional context.',
    currentDuties: [{ quote: '创建 app.mjs。' }, { quote: '完成前运行验证。' }], externalConditions: [],
    remainderDisposition: 'CONTEXT_ONLY', remainderReason: 'Description with emoji and optional examples.' };
  const graph = skill.bindSkillGraphFromQuotes(candidate(original, value), original), i = graph.constraints[0].sourceInterpretation;
  assert.equal(i.currentDutySpans[0].start, body.indexOf('创建'));
  assert.equal(i.currentDutySpans[1].end, body.length);
  assert.equal(i.contextSpans[0].end, body.indexOf('创建'));
  assert.throws(() => skill.bindSkillGraphFromQuotes(candidate(original, { ...value, remainderDisposition: 'UNCERTAIN' }), original), /UNRESOLVED/u);
  assert.throws(() => skill.bindSkillGraphFromQuotes(candidate(original, { ...value, currentDuties: [{ quote: '\ud83d' }] }), original), /SKILL_GRAPH_SOURCE/u);
});

test('computed context is no semantic proof and cannot skip complete original interpretation review', () => {
  const original = source(text), graph = skill.bindSkillGraphFromQuotes(candidate(original, interpretation()), original);
  assert.throws(() => validateSkillConditionalReview({ graph,
    review: { summary: 'No explicit original interpretation review.', completionStatus: 'COMPLETED', findings: [] } }), /INTERPRETATION_REQUIRED/u);
});

test('a heading owns selectable original normativity once while its body exceptions remain in the same scope', () => {
  const original = source('# Never publish credentials\n\nThis section explains the delivery rule.\n\nUnless the user explicitly requests a redacted demonstration, preserve the original restriction.\n\n## Examples\n\nYou may inspect a redacted example.\n');
  const units = skill.skillSourceUnits(original).units, heading = units.find(unit => unit.kind === 'HEADING_SCOPE' && unit.start === 1);
  assert(heading, 'A real heading duty must have a selectable owner, not only repeated context');
  assert(heading.text.includes('Unless the user explicitly requests'));
  const proposal = { constraints: units.map((unit, index) => ({ constraintId: `H${index}`, sourceUnitIds: [unit.id],
    interpretation: unit.id === heading.id ? {
      normativity: 'PROHIBITED', scope: 'INTERNAL_BRANCH', reason: 'The prohibition retains its complete original exception, not an unconditional stronger rule.',
      currentDuties: [{ quote: 'Never publish credentials' }], externalConditions: [],
      remainderDisposition: 'CONTEXT_ONLY', remainderReason: 'All section text remains qualification/context for this heading; body units own their independent content.'
    } : { normativity: 'DESCRIPTION', scope: 'CURRENT_TASK', reason: 'Controlled non-duty context classification.',
      currentDuties: [], externalConditions: [], remainderDisposition: 'CONTEXT_ONLY', remainderReason: 'Complete original retained.' } })), taskOverlays: [] };
  const graph = skill.bindSkillGraphFromQuotes(proposal, original), bound = graph.constraints.find(node => node.modality === 'PROHIBITED');
  assert.equal(graph.constraints.filter(node => node.modality === 'PROHIBITED').length, 1);
  assert.match(bound.condition, /Unless the user explicitly requests/);
  assert.match(bound.sourceRef, /^SKILL\.md#L1-L/u);
  const bodyIndex = units.findIndex(unit => unit.kind !== 'HEADING_SCOPE' && unit.text.startsWith('This section'));
  const bad = structuredClone(proposal); bad.constraints[bodyIndex].interpretation = proposal.constraints[0].interpretation;
  assert.throws(() => skill.bindSkillGraphFromQuotes(bad, original), /unique exact/u, 'Repeated heading context is not another owner');
  const wrongOwner = structuredClone(proposal);
  wrongOwner.constraints[0].interpretation.currentDuties = [{ quote: 'You may inspect a redacted example.' }];
  assert.throws(() => skill.bindSkillGraphFromQuotes(wrongOwner, original), /heading|owner/iu, 'Heading scope cannot create independent duties from its body context');
});
