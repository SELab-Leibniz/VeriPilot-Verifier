// Frozen, known-answer development fixture; never imported by a plugin.
import fs from 'node:fs/promises';
import path from 'node:path';
import { scanSkillDirectory } from '../../lib/runtime-v2/skill-source.mjs';
import { persistSkillGroundTruth } from '../../lib/runtime-v2/ground-truth-ledger.mjs';

export const MIXED_SKILL_ID = 'numeric-conditional-check';
export const MIXED_SKILL_EXPECTED = Object.freeze({
  [`M08:${MIXED_SKILL_ID}:array-check`]: 'NOT_APPLICABLE',
  'M12:R1': 'PASS',
  'M12:R2': 'UNVERIFIED',
  'M16:R1': 'PASS',
});

export async function prepareMixedSkillEvaluation({ projectRoot, taskId, skillRoots = [path.join(projectRoot, 'skills')] }) {
  const root = path.join(skillRoots[0], MIXED_SKILL_ID);
  await fs.mkdir(path.join(root, 'references'), { recursive: true });
  await fs.writeFile(path.join(root, 'SKILL.md'), '# Numeric conditional check\n' +
    'Preserve the complete applicability condition in references/conditions.md.\n' +
    'Before completing an array-processing task, actually execute node --test.\n');
  await fs.writeFile(path.join(root, 'references/conditions.md'),
    'The Skill array-check step applies only when the original task accepts or produces arrays. ' +
    'For a task that accepts and returns numbers only, this Skill step is not applicable. ' +
    'This exception does not waive a separate explicit user request to run tests.\n');
  const source = await scanSkillDirectory(root);
  const saved = await persistSkillGroundTruth({ projectRoot, taskId, skillId: MIXED_SKILL_ID, skillDigest: source.digest,
    constraints: [
      { constraintId: 'array-check', statement: 'Before completing an array-processing task, actually execute node --test.',
        modality: 'MUST', kind: 'STEP', condition: 'Only if the original task accepts or produces arrays.', applicabilityKind: 'CONDITIONAL',
        sourceRef: 'SKILL.md#L3', dependsOn: ['scope-condition'] },
      { constraintId: 'scope-condition', statement: 'An array-only Skill step does not apply to a numeric-only task and does not waive an independent user execution request.',
        modality: 'MAY', kind: 'CONDITION', sourceRef: 'references/conditions.md#L1' },
    ], taskOverlays: [] });
  return saved.document;
}
