import fs from 'node:fs/promises';
import { optionalJson, hash } from './files.mjs';

// Optional build receipt: older packages remain usable, while a present receipt
// must describe these exact archive bytes rather than another 1.11.0 build.
export async function readPluginSource(archive, archiveSha256) {
  const source = await optionalJson(archive + '.source.json');
  if (!source) return null;
  if (source.schemaVersion !== 'rc-experiment.plugin-source.v1'
    || !/^[0-9a-f]{40}$/.test(source.sourceCommit ?? '')
    || !/^[0-9a-f]{64}$/.test(source.archiveSha256 ?? '')) throw new Error('Invalid RC plugin source receipt');
  const actual = archiveSha256 ?? hash(await fs.readFile(archive));
  if (source.archiveSha256 !== actual) throw new Error('RC plugin source receipt hash mismatch; use the matching archive and receipt');
  return Object.fromEntries(['schemaVersion', 'sourceBranch', 'sourceCommit', 'archiveSha256', 'packageVersion', 'entries', 'builtAt']
    .filter(key => source[key] !== undefined).map(key => [key, source[key]]));
}
