import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

async function hasReadableAuthStore(file) {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const database = new DatabaseSync(file, { readOnly: true });
    try {
      const table = database.prepare("PRAGMA main.table_list('auth_profile_store')").get();
      if (table?.type !== 'table') return false;
      const columns = database.prepare("SELECT name FROM pragma_table_info('auth_profile_store', 'main')").all();
      if (!['store_key', 'store_json'].every(name => columns.some(column => column.name === name))) return false;
      // The live resolver reads the payload. Preflight only checks row existence.
      return Boolean(database.prepare("SELECT 1 FROM main.auth_profile_store WHERE store_key = 'primary' LIMIT 1").get());
    } finally {
      database.close();
    }
  } catch {
    return false;
  }
}

export async function inspectArktsModelProfile({ profilePath, model, reviewerModel }) {
  const modelRef = `custom/${model}`;
  const result = { state: 'PROFILE_MISSING', modelRef, authStorePresent: false };
  if (!profilePath) return result;

  let config;
  try {
    config = JSON.parse(await fs.readFile(profilePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return result;
    return { ...result, state: 'PROFILE_INVALID' };
  }

  const authStore = path.join(path.dirname(profilePath), 'agents/main/agent/openclaw-agent.sqlite');
  result.authStorePresent = await fs.stat(authStore).then(stat => stat.isFile(), () => false);
  const invalid = { ...result, state: 'PROFILE_INVALID' };
  const provider = config?.models?.providers?.custom;
  const available = Array.isArray(provider?.models) ? provider.models : [];
  const required = reviewerModel ? [model, reviewerModel] : [model];
  if (provider?.api !== 'openai-completions' || typeof provider.baseUrl !== 'string'
    || !required.every(id => typeof id === 'string' && /^[\w.:-]+$/u.test(id) && available.some(item => item?.id === id))) return invalid;

  let endpoint;
  try { endpoint = new URL(provider.baseUrl); } catch { return invalid; }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return invalid;
  const hostname = endpoint.hostname.replace(/\.$/u, '');
  const identity = { ...result, api: provider.api, endpointSha256: createHash('sha256').update(provider.baseUrl).digest('hex') };
  if (hostname === 'invalid' || hostname.endsWith('.invalid')) return { ...identity, state: 'OFFLINE_FIXTURE' };
  if (!result.authStorePresent) return { ...identity, state: 'AUTH_STORE_MISSING' };
  return { ...identity, state: await hasReadableAuthStore(authStore) ? 'PROFILE_CONFIGURED' : 'AUTH_STORE_INVALID' };
}
