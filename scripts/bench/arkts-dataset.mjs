// Evaluator-only dataset access. Agent-facing data is an explicit allowlist;
// gold patches, hidden tests and changed-path metadata never enter that view.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
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
  return Object.fromEntries(['instance_id', 'repo', 'base_commit', 'problem_statement', 'hints_text'].map(key => [key, task[key] ?? '']));
}
