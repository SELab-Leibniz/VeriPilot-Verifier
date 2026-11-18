// Evaluator-only dataset access. Agent-facing data is an explicit allowlist;
// gold patches, hidden tests and changed-path metadata never enter that view.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const publicFields = ['instance_id', 'repo', 'base_commit', 'problem_statement', 'hints_text'];
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export async function loadArktsTask(directory, id) {
  if (!/^[a-z0-9_-]+$/u.test(id)) throw new Error('Invalid instance ID');
  const bytes = await fs.readFile(path.join(directory, `${id}.json`));
  const task = JSON.parse(bytes);
  if (task.instance_id !== id || !/^[\w.-]+\/[\w.-]+$/u.test(task.repo)
    || !/^[a-f0-9]{40}$/u.test(task.base_commit)) throw new Error('Invalid task identity');
  for (const name of ['patch', 'test_patch']) if (digest(task[name]) !== task[`${name}_sha256`]) throw new Error(`${id}: ${name} hash mismatch`);
  for (const name of ['FAIL_TO_PASS', 'PASS_TO_PASS']) {
    if (!Array.isArray(task[name]) || task[name].some(value => typeof value !== 'string' || value.split('::').length < 3)
      || new Set(task[name]).size !== task[name].length) throw new Error(`${id}: invalid test IDs`);
  }
  if (task.FAIL_TO_PASS.some(id => task.PASS_TO_PASS.includes(id))) throw new Error(`${id}: overlapping test populations`);
  return { task, datasetDigest: digest(bytes) };
}
export function arktsAgentInput(task) {
  return Object.fromEntries(publicFields.map(key => [key, task[key] ?? '']));
}

export function assertArktsCalibrationBasis(record, task, datasetDigest) {
  if (!record || record.instanceId !== task.instance_id || record.baseCommit !== task.base_commit
    || record.environment?.datasetDigest !== datasetDigest || record.environment?.testPatchSha256 !== task.test_patch_sha256) {
    throw new Error(`Calibration identity mismatch: ${task.instance_id}`);
  }
}

// The solve process only receives the projected public task, never the evaluator's task file.
export function validateArktsAgentInput(input, id) {
  if (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).length !== publicFields.length
    || !publicFields.every(key => Object.hasOwn(input, key) && typeof input[key] === 'string')
    || !/^[a-z0-9_-]+$/u.test(id) || input.instance_id !== id || !/^[\w.-]+\/[\w.-]+$/u.test(input.repo)
    || input.repo.split('/').some(part => part === '.' || part === '..')
    || !/^[a-f0-9]{40}$/u.test(input.base_commit) || !input.problem_statement.trim())
    throw new Error('Invalid public ArkTS task projection.');
  return input;
}
