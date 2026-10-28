import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Record/compare endpoint identity without printing a URL that might contain
// embedded authentication. Provider keys remain outside saved configurations.
export const providerBaseFingerprint = baseUrl => createHash('sha256').update(JSON.stringify(baseUrl ?? null)).digest('hex');

export async function assertNativeProviderIdentity(runDirectory, expected) {
  const config = JSON.parse(await fs.readFile(path.join(runDirectory, 'native-host/config.json'), 'utf8'));
  const actual = providerBaseFingerprint(config.models?.providers?.anthropic?.baseUrl);
  if (actual !== expected) throw new Error('Native provider endpoint differs; refuse baseline reuse or paired grading');
  return actual;
}
