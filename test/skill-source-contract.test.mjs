import test from 'node:test';
import assert from 'node:assert/strict';
import * as skill from '../lib/runtime-v2/skill-source.mjs';
import { sha256 } from '../lib/runtime-v2/utils.mjs';
import { interpretSkillUnit, skillGraphCandidate } from './helpers/skill-source-interpretation.mjs';
const source = text => ({ root: '/original/skill', digest: sha256(text), truncated: false,
  files: [{ path: 'SKILL.md', sha256: sha256(text), content: text }] });

test('source-bound Skill graph cannot turn conjunction or navigation edges into strict precedence', () => {
  const original = source('# Delivery\n\nRead A and implement B.\n');
  assert.equal(typeof skill.skillSourceUnits, 'function');
  const units = skill.skillSourceUnits(original).units;
  const unit = units.find(u => u.kind !== 'HEADING_SCOPE' && u.text.includes('Read A'));
  const candidate = skillGraphCandidate(original), index = candidate.constraints.findIndex(c => c.sourceUnitIds[0] === unit.id);
  candidate.constraints[index].constraintId = 'read';
  const bound = skill.bindSkillGraph(candidate, original);
  assert.match(bound.constraints[index].statement, /Read A and implement B\./);
  assert.doesNotMatch(bound.constraints[index].statement, /before/iu);
  assert.deepEqual(bound.constraints[index].dependsOn, []);
  for (const injected of [{ statement: 'Read A before implementing B.' }, { dependsOn: ['implement'] }, { condition: 'Before implementing B' }, { modality: 'MUST' }])
    assert.throws(() => skill.bindSkillGraph({ ...candidate, constraints: candidate.constraints.map((c, i) => i === index ? { ...c, ...injected } : c) }, original), /SKILL_GRAPH_SOURCE/);
});

test('explicit original order, advisory force, compound duties and complete UTF8/fenced context remain bound', () => {
  const text = '# Optional advice\n\nYou SHOULD read notes.\n\n# Required delivery\n\nBefore modifying B, read A. If a later correction changes B, verify again.\n\n```text\n' + '完整条件。'.repeat(5000) + '\n```\n';
  const original = source(text); assert.equal(typeof skill.skillSourceUnits, 'function');
  const units = skill.skillSourceUnits(original).units, bodies = units.filter(u => u.kind !== 'HEADING_SCOPE'), advice = bodies.find(u => u.text.includes('SHOULD')),
    required = bodies.find(u => u.text.includes('Before modifying')), fenced = bodies.find(u => u.text.includes('```text'));
  const graph = skill.bindSkillGraph(skillGraphCandidate(original, unit => unit.id === advice.id
    ? interpretSkillUnit(unit, { normativity: 'ADVISORY' })
    : interpretSkillUnit(unit, { scope: 'COMPOUND', current: ['Before modifying B, read A.'], external: [
      { condition: 'If a later correction changes B,', duty: 'verify again.' } ] })), original);
  const rows = graph.constraints.filter(c => c.sourceInterpretation.sourceOwnership.kind === 'BODY');
  assert.equal(rows[0].modality, 'SHOULD');
  assert.match(rows[1].statement, /Before modifying B, read A/);
  assert.match(rows[1].statement, /If a later correction/);
  assert.equal(rows[1].applicabilityKind, 'CURRENT_TASK');
  assert.match(rows[1].statement, new RegExp('完整条件。'.repeat(5)));
  assert(rows[1].statement.includes('```')); assert(rows[1].statement.length > 20000);
  assert.throws(() => skill.bindSkillGraph({ constraints: [{ constraintId: 'bad', sourceUnitIds: ['invented'] }], taskOverlays: [] }, original), /SKILL_GRAPH_SOURCE/);
  assert.throws(() => skill.bindSkillGraph({ constraints: [{ constraintId: 'bad', sourceUnitIds: [fenced.id, advice.id] }], taskOverlays: [] }, original), /SKILL_GRAPH_SOURCE/);
  assert.throws(() => skill.skillSourceUnits({ ...original, truncated: true }), /SKILL_GRAPH_SOURCE/);
});

test('an optional sibling cannot soften delivery, and captured examples stay context rather than MUST steps', () => {
  const original = source('# Delivery\n\nDeliver app.mjs. You may inspect examples if useful.\n');
  original.files.push({ path: 'examples/demo.py', content: "raise RuntimeError('demonstration only')\n", sha256: sha256("raise RuntimeError('demonstration only')\n") });
  const units = skill.skillSourceUnits(original).units;
  assert.equal(units.length, 2); assert.equal(units.filter(u => u.kind === 'HEADING_SCOPE').length, 1); assert.equal(units[0].file, 'SKILL.md');
  const graph = skill.bindSkillGraph(skillGraphCandidate(original, unit => interpretSkillUnit(unit, { normativity: 'MIXED', current: ['Deliver app.mjs.'] })), original);
  assert.equal(graph.constraints.filter(c => c.modality === 'MUST').length, 1); assert.match(graph.constraints.find(c => c.modality === 'MUST').statement, /Deliver app.mjs/);
  assert(!graph.constraints.some(c => c.statement.includes('raise RuntimeError')));
});

test('an internal invalid-input branch remains a current implementation duty with its original condition', () => {
  const original = source('# Validator implementation\n\nIf the supplied input is invalid, return the declared error.\n');
  const units = skill.skillSourceUnits(original).units;
  const graph = skill.bindSkillGraph(skillGraphCandidate(original, unit => interpretSkillUnit(unit, { scope: 'INTERNAL_BRANCH' })), original);
  const body = graph.constraints.find(c => c.sourceInterpretation.sourceOwnership.kind === 'BODY');
  assert.equal(body.applicabilityKind, 'CURRENT_TASK');
  assert.match(body.condition, /If the supplied input is invalid/);
});

test('a heading with an unmerged fenced block remains an original unit, including optional examples', () => {
  for (const [heading, normativity] of [['Verify delivery before completion', 'MANDATORY'], ['Optional example', 'DESCRIPTION']]) {
    const text = `# ${heading}\n\n\`\`\`bash\nnode verify.mjs\n\`\`\`\n`, original = source(text);
    const units = skill.skillSourceUnits(original).units;
    assert.equal(units.length, 2); const body = units.find(u => u.kind !== 'HEADING_SCOPE'); assert.equal(body.headings[0].text, `# ${heading}`);
    assert.equal(body.text, '```bash\nnode verify.mjs\n```'); assert.equal(Object.hasOwn(body, 'modality'), false);
    assert.throws(() => skill.bindSkillGraph({ constraints: [], taskOverlays: [] }, original), /no graph owner/);
    const graph = skill.bindSkillGraph(skillGraphCandidate(original, unit => interpretSkillUnit(unit, { normativity: 'DESCRIPTION' }),
      unit => interpretSkillUnit(unit, { normativity, ...(normativity === 'MANDATORY' ? { current: [`# ${heading}`] } : {}) })), original);
    assert.equal(graph.constraints[0].modality, normativity === 'MANDATORY' ? 'MUST' : 'MAY');
    assert.match(graph.constraints[0].statement, new RegExp(heading));
  }
});

test('unowned normative or descriptive headings are retained without assigning normative force by Markdown shape', () => {
  for (const [heading, normativity] of [['Never modify public API signatures', 'PROHIBITED'], ['Optional example', 'DESCRIPTION'], ['Ordinary explanation', 'DESCRIPTION']]) {
    const original = source(`## ${heading}\n`), units = skill.skillSourceUnits(original).units;
    assert.equal(units.length, 1); assert.equal(units[0].text, `## ${heading}`);
    assert.equal(Object.hasOwn(units[0], 'modality'), false);
    const graph = skill.bindSkillGraph(skillGraphCandidate(original, unit => interpretSkillUnit(unit, { normativity }),
      unit => interpretSkillUnit(unit, { normativity })), original);
    assert.equal(graph.constraints[0].modality, normativity === 'PROHIBITED' ? 'PROHIBITED' : 'MAY');
  }
  const original = source('# Parent\n\n## Never modify public API signatures\n\n## Optional example\n'), units = skill.skillSourceUnits(original).units;
  assert.deepEqual(units.map(u => u.start), [1, 3, 5]);
  assert.equal(units[1].headings[0].text, '# Parent');
  assert.throws(() => skill.bindSkillGraph({ constraints: [], taskOverlays: [] }, original), /no graph owner/);
});
