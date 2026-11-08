import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { simplifySchedule } from '../scripts/simplify-experiment-schedule.mjs';
import { countProfileCredentialMatches, installSimplifyProfileBoundary, supportsSimplifyModel } from '../scripts/helpers/simplify-native-evaluation.mjs';

test('the DeepSeek route is explicit and the first eight scheduled slots retain their order', () => {
  assert.equal(supportsSimplifyModel('host-profile', 'deepseek-v4-flash', 'fixture.json'), true);
  assert.equal(supportsSimplifyModel('host-profile', 'deepseek-v4-flash'), false);
  assert.equal(supportsSimplifyModel('coding-plan', 'deepseek-v4-flash'), false);
  assert.equal(supportsSimplifyModel('coding-plan', 'glm-5.3-flash'), true);
  assert.equal(supportsSimplifyModel('anthropic-environment', 'glm-5.3-flash'), true);
  assert.deepEqual(simplifySchedule('1').slice(0, 8).map(({ sample, arm, repeat }) => [sample, arm, repeat]),
    ['internal-correct', 'six-functions'].flatMap(sample => ['A', 'B1', 'B2', 'B12'].map(arm => [sample, arm, 1])));
});

test('profile wire admission limits dispatches and stops SDK retries after a 429', async t => {
  const hostRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-simplify-wire-'));
  t.after(() => fs.rm(hostRoot, { recursive: true, force: true }));
  const undici = path.join(hostRoot, 'node_modules/undici');
  await fs.mkdir(undici, { recursive: true });
  await fs.writeFile(path.join(undici, 'index.js'), 'exports.fetch = globalThis.fetch;');
  const credential = () => 'test-only-credential-never-dispatched';
  const provider = { baseUrl: 'https://example.invalid/v1', model: 'deepseek-v4-flash' };
  const send = () => fetch(`${provider.baseUrl}/chat/completions`, { method: 'POST',
    headers: { authorization: `Bearer ${credential()}` }, body: JSON.stringify({ model: provider.model }) });
  const previous = globalThis.fetch;
  let status = 200, dispatches = 0;
  globalThis.fetch = async () => { dispatches++; return new Response(null, { status }); };
  try {
    const bounded = installSimplifyProfileBoundary({ hostRoot, provider, credential, maxRequests: 2 });
    try {
      await send(); await send();
      await assert.rejects(send, /PROFILE_REQUEST_LIMIT/u);
      assert.equal(dispatches, 2);
    } finally { bounded.close(); }
    status = 429;
    const limited = installSimplifyProfileBoundary({ hostRoot, provider, credential });
    try {
      await assert.rejects(send, /PROFILE_RATE_LIMIT/u);
      await assert.rejects(send, /PROFILE_RATE_LIMIT/u);
      assert.deepEqual(limited.snapshot(), { requests: 1, failure: 'PROFILE_RATE_LIMIT' });
      assert.equal(dispatches, 3);
    } finally { limited.close(); }
    status = 200;
    const dual = installSimplifyProfileBoundary({ hostRoot, provider, credential, reviewerModel: 'deepseek-v4.1-flash' });
    try {
      const sendModel = model => fetch(`${provider.baseUrl}/chat/completions`, { method: 'POST',
        headers: { authorization: `Bearer ${credential()}` }, body: JSON.stringify({ model }) });
      await send(); await sendModel('deepseek-v4.1-flash');
      assert.equal(dual.snapshot().requests, 2);
      await assert.rejects(() => sendModel(undefined), /PROFILE_MODEL_BOUNDARY/u);
    } finally { dual.close(); }
    await fs.writeFile(path.join(hostRoot, 'test-encoded'), Buffer.from(credential(), 'utf16le'));
    assert.equal(await countProfileCredentialMatches(hostRoot, credential), 1);
  } finally { globalThis.fetch = previous; }
});
