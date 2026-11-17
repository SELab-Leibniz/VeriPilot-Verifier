import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectEnvironment } from '../lib/doctor.mjs';

async function input() {
  return { paths: { hostState: await fs.mkdtemp(path.join(os.tmpdir(), 'rc-doctor-')) },
    fingerprint: { nodeVersion: process.version, gitVersion: 'git version test', hostVersion: '2026.7.1-2', pluginSha256: 'sha' },
    models: { agentId: 'main', business: 'p/m', reviewer: 'p/m' }, harmony: {}, environment: {},
    source: { models: { providers: { p: { baseUrl: 'https://example.invalid/v1?token=private-query', apiKey: 'private-api-key' } } } } };
}
test('doctor defaults to no network/model requests and omits credential values', async () => {
  const data = await input(); let calls = 0;
  const report = await inspectEnvironment(data, { request: async () => { calls++; throw new Error(); } });
  assert.equal(calls, 0); assert.equal(report.ok, true);
  assert.equal(JSON.stringify(report).includes('private-api-key'), false);
});
test('network check sends no credentials/query and accepts HTTP 401 as reachable only', async () => {
  const report = await inspectEnvironment(await input(), { network: true, request: async (url, options) => {
    assert.equal(url.search, ''); assert.equal(options.method, 'HEAD'); assert.equal(options.headers, undefined);
    return { status: 401 };
  } });
  assert.equal(report.ok, true); assert.match(report.checks.find(c => c.name === 'Network p').detail, /reachability only/);
});
test('DNS failure is a failed connection check, never a successful model test', async () => {
  const report = await inspectEnvironment(await input(), { network: true, request: async () => { throw Object.assign(new Error('private request body'), { cause: { code: 'ENOTFOUND' } }); } });
  assert.equal(report.ok, false);
  assert.match(report.checks.find(c => c.name === 'Network p').detail, /ENOTFOUND/);
  assert.equal(JSON.stringify(report).includes('private request body'), false);
});
