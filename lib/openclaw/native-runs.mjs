import { promises as fs } from 'node:fs';
import path from 'node:path';
import { privateJson } from './controller-store.mjs';
import { readJson, sha256 } from '../runtime-v2/utils.mjs';
const directory = (root, taskId) => path.join(root, '.runtime-correction', 'openclaw', 'native-runs', sha256(taskId));
export const recordNativeRun = (root, record) => privateJson(path.join(directory(root, record.taskId), `${record.runId}.json`), record);
export async function listNativeRuns(root, taskId) {
  const dir = directory(root, taskId);
  let files;
  try { files = await fs.readdir(dir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const records = await Promise.all(files.filter(file => file.endsWith('.json')).map(file => readJson(path.join(dir, file))));
  return records.filter(Boolean);
}
export const unsettledNativeRuns = async (root, taskId) => (await listNativeRuns(root, taskId)).filter(record => record.status !== 'SETTLED');
