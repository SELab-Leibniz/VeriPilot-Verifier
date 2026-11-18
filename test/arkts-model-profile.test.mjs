import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inspectArktsModelProfile } from '../scripts/bench/arkts-model-profile.mjs';

const model = 'deepseek-v4-flash';
const reviewerModel = 'review-flash';
const profile = { api: 'openai-completions', baseUrl: 'https://model.example.net/v1', models: [{ id: model }, { id: reviewerModel }] };
const authStoreSchema = `CREATE TABLE auth_profile_store (
  store_key TEXT NOT NULL PRIMARY KEY,
  store_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)`;
const addPrimary = database => database.prepare('INSERT INTO auth_profile_store VALUES (?, ?, ?)')
  .run('primary', '{"version":1,"profiles":{}}', 1);

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-arkts-profile-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = path.join(root, 'agents/main/agent/openclaw-agent.sqlite');
  const profilePath = path.join(root, 'openclaw.json');
  const inspect = () => inspectArktsModelProfile({ profilePath, model, reviewerModel });
  const write = custom => fs.writeFile(profilePath, JSON.stringify({ models: { providers: { custom } } }));
  return { profilePath, inspect, write, store };
}

test('profile preflight distinguishes missing, malformed, and unsupported routes', async t => {
  const { profilePath, inspect, write } = await fixture(t);
  const missing = { state: 'PROFILE_MISSING', modelRef: `custom/${model}`, authStorePresent: false };
  assert.deepEqual(await inspectArktsModelProfile({ model }), missing);
  assert.deepEqual(await inspect(), missing);
  await fs.writeFile(profilePath, '{incomplete');
  assert.deepEqual(await inspect(), { ...missing, state: 'PROFILE_INVALID' });
  for (const provider of [
    { ...profile, api: 'anthropic-messages' }, { ...profile, baseUrl: 'http://model.example.net/v1' },
    { ...profile, baseUrl: 'https://user:password@model.example.net/v1' }, { ...profile, baseUrl: 'https://model.example.net/v1?key=redacted' },
    { ...profile, models: [{ id: model }] }, { ...profile, models: [{ id: reviewerModel }] },
  ]) {
    await write(provider);
    assert.deepEqual(await inspect(), { ...missing, state: 'PROFILE_INVALID' });
  }
});

test('profile preflight rejects malformed auth databases and missing resolver rows', async t => {
  const { inspect, write, store } = await fixture(t);
  await write(profile);
  const expected = { state: 'AUTH_STORE_MISSING', modelRef: `custom/${model}`, authStorePresent: false, api: profile.api,
    endpointSha256: createHash('sha256').update(profile.baseUrl).digest('hex') };
  const invalid = { ...expected, state: 'AUTH_STORE_INVALID', authStorePresent: true };
  assert.deepEqual(await inspect(), expected);
  await fs.mkdir(store, { recursive: true });
  assert.deepEqual(await inspect(), expected);
  await fs.rmdir(store);
  await fs.writeFile(store, 'This is not a SQLite database');
  assert.deepEqual(await inspect(), invalid);
  await fs.rm(store);

  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(store);
  try {
    database.exec(`CREATE VIEW auth_profile_store AS SELECT 'primary' AS store_key, '{}' AS store_json`);
    assert.deepEqual(await inspect(), invalid);
    database.exec(`DROP VIEW auth_profile_store;
      CREATE TABLE auth_profile_store (store_key TEXT NOT NULL PRIMARY KEY);
      INSERT INTO auth_profile_store VALUES ('primary')`);
    assert.deepEqual(await inspect(), invalid);
    database.exec(`DROP TABLE auth_profile_store; ${authStoreSchema}`);
    database.prepare('INSERT INTO auth_profile_store VALUES (?, ?, ?)').run('secondary', '{}', 1);
    assert.deepEqual(await inspect(), invalid);
    addPrimary(database);
    assert.deepEqual(await inspect(), { ...expected, state: 'PROFILE_CONFIGURED', authStorePresent: true });
    database.exec('BEGIN EXCLUSIVE');
    assert.deepEqual(await inspect(), invalid);
    database.exec('ROLLBACK');
    assert.deepEqual(await inspect(), { ...expected, state: 'PROFILE_CONFIGURED', authStorePresent: true });
  } finally {
    database.close();
  }

  const baseUrl = 'https://benchmark.invalid./v1';
  await write({ ...profile, baseUrl });
  await fs.writeFile(store, 'An offline fixture does not open an auth database');
  assert.deepEqual(await inspect(), { ...expected, state: 'OFFLINE_FIXTURE', authStorePresent: true,
    endpointSha256: createHash('sha256').update(baseUrl).digest('hex') });
});

test('profile preflight accepts the pinned SQLite layout with the primary row in an active WAL', async t => {
  const { inspect, write, store } = await fixture(t);
  await write(profile);
  await fs.mkdir(path.dirname(store), { recursive: true });
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(store);
  try {
    database.exec(`PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; ${authStoreSchema}`);
    addPrimary(database);
    const mainBefore = await fs.readFile(store), walBefore = await fs.readFile(`${store}-wal`);
    assert(walBefore.length > 0);
    assert.deepEqual(await inspect(), { state: 'PROFILE_CONFIGURED', modelRef: `custom/${model}`, authStorePresent: true,
      api: profile.api, endpointSha256: createHash('sha256').update(profile.baseUrl).digest('hex') });
    assert.deepEqual(await fs.readFile(store), mainBefore);
    assert.deepEqual(await fs.readFile(`${store}-wal`), walBefore);
  } finally {
    database.close();
  }
});
