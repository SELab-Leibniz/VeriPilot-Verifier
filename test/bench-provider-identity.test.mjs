import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { providerBaseFingerprint, assertNativeProviderIdentity } from '../scripts/bench/provider-identity.mjs';

test('native baseline reuse requires the same recorded endpoint without exposing credentials', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-provider-identity-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'native-host'));
  const endpoint = 'https://example.invalid/v1?token=fixture-secret';
  await fs.writeFile(path.join(root, 'native-host/config.json'), JSON.stringify({ models: { providers: { anthropic: { baseUrl: endpoint } } } }));
  const expected = providerBaseFingerprint(endpoint);
  assert.match(expected, /^[a-f0-9]{64}$/u);
  assert.equal(await assertNativeProviderIdentity(root, expected), expected);
  await assert.rejects(assertNativeProviderIdentity(root, providerBaseFingerprint('https://other.invalid/v1')), error => {
    assert.match(error.message, /endpoint differs/);
    assert.doesNotMatch(error.message, /fixture-secret|example\.invalid|other\.invalid/u);
    return true;
  });
});

test('SDK-default endpoint identity is distinct from an explicit configured endpoint', () => {
  assert.equal(providerBaseFingerprint(undefined), providerBaseFingerprint(null));
  assert.notEqual(providerBaseFingerprint(null), providerBaseFingerprint('https://example.invalid'));
});
